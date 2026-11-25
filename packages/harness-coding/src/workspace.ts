import { realpath, stat } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FactoryError } from '@mf/core';

export class PathEscapeError extends FactoryError {
  constructor(message: string) {
    super(message, 'PATH_OUTSIDE_WORKSPACE', 403);
    this.name = 'PathEscapeError';
  }
}

/**
 * Confines filesystem access to a single root.
 *
 * The naive check `resolvedPath.startsWith(root)` is WRONG in three ways:
 *  1. `/root-evil` starts with `/root` — a sibling directory escapes.
 *  2. A symlink inside the root can point outside it.
 *  3. `..` segments resolve before the check but the target may not exist yet
 *     (writes), so `realpath` alone cannot be used.
 *
 * So: resolve lexically against the root, verify the RELATIVE path does not
 * climb out, and additionally verify the real path of the deepest existing
 * ancestor still lives inside the root (defeating symlink escapes).
 */
export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<Workspace> {
    const abs = resolve(root);
    if (!existsSync(abs)) {
      throw new FactoryError(`Workspace root does not exist: ${abs}`, 'WORKSPACE_MISSING', 500);
    }
    const info = await stat(abs);
    if (!info.isDirectory()) {
      throw new FactoryError(`Workspace root is not a directory: ${abs}`, 'WORKSPACE_NOT_DIR', 500);
    }
    return new Workspace(await realpath(abs));
  }

  static createSync(root: string): Workspace {
    const abs = resolve(root);
    if (!existsSync(abs)) {
      throw new FactoryError(`Workspace root does not exist: ${abs}`, 'WORKSPACE_MISSING', 500);
    }
    return new Workspace(realpathSync(abs));
  }

  /**
   * Resolves a caller-supplied path to an absolute path inside the workspace.
   * Throws PathEscapeError if it would land outside.
   */
  async resolveSafe(input: string): Promise<string> {
    if (typeof input !== 'string' || input.length === 0) {
      throw new PathEscapeError('Path must be a non-empty string');
    }
    // Reject NUL immediately: some Node FS APIs truncate at NUL.
    if (input.includes('\0')) {
      throw new PathEscapeError('Path contains a NUL byte');
    }
    // Absolute inputs are allowed only if they are already inside the root;
    // this keeps the API usable with paths returned by fs.list.
    const lexical = isAbsolute(input) ? resolve(input) : resolve(this.root, input);

    const rel = relative(this.root, lexical);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new PathEscapeError(`Path escapes the workspace: ${input}`);
    }

    // Symlink check: walk up to the deepest existing ancestor and realpath it.
    let probe = lexical;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (existsSync(probe)) {
        const real = await realpath(probe);
        const realRel = relative(this.root, real);
        if (realRel.startsWith('..') || isAbsolute(realRel)) {
          throw new PathEscapeError(
            `Path resolves outside the workspace via a symlink: ${input}`,
          );
        }
        break;
      }
      const parent = resolve(probe, '..');
      if (parent === probe) break; // reached the filesystem root
      probe = parent;
    }
    return lexical;
  }

  /** Workspace-relative display path (always with forward slashes). */
  display(p: string): string {
    const rel = relative(this.root, p);
    return rel.split(sep).join('/') || '.';
  }

  child(...parts: string[]): string {
    return join(this.root, ...parts);
  }
}
