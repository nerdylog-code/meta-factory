import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * SKILL.md loader, compatible with Hermes/OpenBot skill folders.
 *
 * A skill directory looks like:
 *   skills/<name>/SKILL.md      <- YAML frontmatter + markdown body
 *   skills/<name>/scripts/*     <- optional helper scripts
 *
 * The body is INSTRUCTIONS for the model, injected on demand; it is never
 * executed. Only `name`, `description` and optional allowlists are read from
 * the frontmatter, and a malformed frontmatter rejects the skill rather than
 * producing a half-loaded one.
 */

export interface SkillMeta {
  name: string;
  description: string;
  /** Optional: tools this skill's instructions rely on. */
  tools?: string[];
  /** Directory the skill lives in. */
  dir: string;
  /** Path to SKILL.md. */
  path: string;
}

export interface Skill extends SkillMeta {
  /** Markdown body after the frontmatter. */
  body: string;
}

export class SkillParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'SkillParseError';
  }
}

/**
 * Parses `---` delimited frontmatter without a YAML dependency.
 *
 * Supports the subset skills actually use: `key: value` and `key: [a, b]`.
 * Anything more exotic is rejected rather than silently misread — a skill with
 * a half-understood frontmatter is worse than one that fails loudly.
 */
export function parseFrontmatter(raw: string, path: string): { meta: Record<string, string | string[]>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) {
    throw new SkillParseError('SKILL.md must start with a --- frontmatter block', path);
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) {
    throw new SkillParseError('SKILL.md frontmatter is not closed with ---', path);
  }
  const frontmatter = normalized.slice(3, end).trim();
  const body = normalized.slice(end + 4).replace(/^\r?\n/, '');

  const meta: Record<string, string | string[]> = {};
  for (const line of frontmatter.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) {
      throw new SkillParseError(`Malformed frontmatter line: '${trimmed}'`, path);
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, '');
      meta[key] = value;
    }
  }
  return { meta, body };
}

export function loadSkill(dir: string): Skill {
  const path = join(dir, 'SKILL.md');
  if (!existsSync(path)) throw new SkillParseError('No SKILL.md in directory', path);
  const { meta, body } = parseFrontmatter(readFileSync(path, 'utf8'), path);

  const name = typeof meta['name'] === 'string' ? meta['name'].trim() : '';
  const description = typeof meta['description'] === 'string' ? meta['description'].trim() : '';
  if (!name) throw new SkillParseError('SKILL.md frontmatter is missing `name`', path);
  if (!description) throw new SkillParseError('SKILL.md frontmatter is missing `description`', path);
  if (!body.trim()) throw new SkillParseError('SKILL.md has no body', path);

  return {
    name,
    description,
    ...(Array.isArray(meta['tools']) ? { tools: meta['tools'] } : {}),
    dir,
    path,
    body: body.trim(),
  };
}

export interface SkillRegistryOptions {
  /** Skill roots. The Hermes layout uses a FLAT directory: roots are scanned
   * one level deep, not recursively. */
  roots: string[];
}

/**
 * Discovers skills across one or more roots.
 *
 * Supports both layouts seen in practice:
 *  - flat:     <root>/<skill>/SKILL.md
 *  - nested:   <root>/<category>/<skill>/SKILL.md  (one extra level)
 * Deeper nesting is ignored: the DSH skill discovery model is one level.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  private readonly errors: Array<{ path: string; error: string }> = [];

  constructor(private readonly opts: SkillRegistryOptions) {}

  /** Scans all roots. Invalid skills are recorded, never silently dropped. */
  scan(): { loaded: number; errors: Array<{ path: string; error: string }> } {
    this.skills.clear();
    this.errors.length = 0;
    let loaded = 0;

    for (const root of this.opts.roots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = resolve(root, entry.name);
        if (existsSync(join(dir, 'SKILL.md'))) {
          this.tryLoad(dir) && loaded++;
          continue;
        }
        // one extra level: <category>/<skill>/SKILL.md
        for (const nested of readdirSync(dir, { withFileTypes: true })) {
          if (!nested.isDirectory()) continue;
          const nestedDir = join(dir, nested.name);
          if (existsSync(join(nestedDir, 'SKILL.md'))) {
            this.tryLoad(nestedDir) && loaded++;
          }
        }
      }
    }
    return { loaded, errors: [...this.errors] };
  }

  private tryLoad(dir: string): boolean {
    try {
      const skill = loadSkill(dir);
      // A duplicate name is an error, not "last one wins": two skills with the
      // same name make `use <name>` ambiguous.
      const existing = this.skills.get(skill.name);
      if (existing) {
        this.errors.push({
          path: skill.path,
          error: `Duplicate skill name '${skill.name}' (already loaded from ${existing.path})`,
        });
        return false;
      }
      this.skills.set(skill.name, skill);
      return true;
    } catch (err) {
      this.errors.push({ path: dir, error: (err as Error).message });
      return false;
    }
  }

  /** Metadata only: what the model is told exists. */
  list(): SkillMeta[] {
    return [...this.skills.values()]
      .map(({ body: _body, ...meta }) => meta)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | null {
    return this.skills.get(name) ?? null;
  }

  /**
   * Renders the on-demand instructions for specific skills.
   *
   * Unknown names are reported rather than ignored: a model that asked for a
   * skill it did not get should know that.
   */
  render(names: string[]): { text: string; missing: string[] } {
    const parts: string[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const skill = this.skills.get(name);
      if (!skill) {
        missing.push(name);
        continue;
      }
      parts.push(`### Skill: ${skill.name}\n${skill.body}`);
    }
    return { text: parts.join('\n\n'), missing };
  }

  get errorsSinceScan(): Array<{ path: string; error: string }> {
    return [...this.errors];
  }
}



