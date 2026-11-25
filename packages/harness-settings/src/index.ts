import { z } from 'zod';
import type { CommandDefinition, Db, HarnessModule } from '@mf/core';

/**
 * Core Four — the four things that define an agent. Everything else is
 * derived. Exposing them as first-class settings (not buried YAML) is the
 * "Soberania Total" principle: the human always knows and can change what the
 * agent sees, thinks with, is told, and can do.
 */
export const CoreFourSchema = z.object({
  context: z.object({
    /** How many past messages are kept verbatim. */
    windowMessages: z.number().int().min(2).max(500).default(20),
    /** Hard ceiling for auto-compaction. */
    compactionRatio: z.number().min(0.2).max(0.95).default(0.75),
    includeEventLog: z.boolean().default(true),
  }).prefault({}),
  model: z.object({
    tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).default('S'),
    thinking: z.enum(['off', 'low', 'medium', 'high']).default('off'),
    temperature: z.number().min(0).max(2).default(0.2),
    maxOutputTokens: z.number().int().min(64).max(200_000).default(4096),
  }).prefault({}),
  prompt: z.object({
    persona: z.string().max(8000).default(''),
    /** Extra instructions appended after harness sections. */
    extraInstructions: z.string().max(8000).default(''),
  }).prefault({}),
  tools: z.object({
    /** Tool names disabled for this factory, even if the harness offers them. */
    disabled: z.array(z.string()).default([]),
    /** Tool summary batching for this factory; 0 disables. */
    summarizeEvery: z.number().int().min(0).max(50).default(3),
  }).prefault({}),
});
export type CoreFour = z.infer<typeof CoreFourSchema>;

export const UI_SETTINGS_SCHEMA = z.object({
  theme: z.string().default('midnight'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  showThinking: z.boolean().default(true),
  showToolSummaries: z.boolean().default(true),
  showTraces: z.boolean().default(true),
  showTokenomics: z.boolean().default(true),
  leftPaneWidth: z.number().int().min(160).max(600).default(240),
  rightPaneWidth: z.number().int().min(280).max(800).default(380),
  /** Which panes are visible. Purely presentational, persisted per factory. */
  showLeftPane: z.boolean().default(true),
  showCenterPane: z.boolean().default(true),
  showRightPane: z.boolean().default(true),
  /** Sending while the agent is busy: queue the message or interrupt it. */
  whileBusy: z.enum(['queue', 'steer']).default('queue'),
  /** Enter alone sends (Shift+Enter for a newline) versus Ctrl+Enter only. */
  enterToSend: z.boolean().default(false),
});
export type UiSettings = z.infer<typeof UI_SETTINGS_SCHEMA>;

/**
 * The agent the human is talking to, as shown in the right panel header.
 *
 * This is identity and behaviour, not capability: `maxTurns` bounds the loop and
 * `name` is a label. Tool and model authority stay in the Core Four.
 */
export const AGENT_SETTINGS_SCHEMA = z.object({
  name: z.string().min(1).max(60).default('Sandbox Agent'),
  maxTurns: z.number().int().min(1).max(50).default(6),
});
export type AgentSettings = z.infer<typeof AGENT_SETTINGS_SCHEMA>;

/**
 * Defaults applied when an agent starts a subagent: tier, thinking and the
 * budget envelope. These are DEFAULTS, not grants — the harness still enforces
 * its own caps and every spawn still carves out atomically.
 */
export const SUBAGENT_SETTINGS_SCHEMA = z.object({
  tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).default('B'),
  thinking: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  budgetUsd: z.number().positive().max(100).default(0.25),
  minutes: z.number().int().min(1).max(120).default(10),
  maxConcurrent: z.number().int().min(1).max(16).default(4),
});
export type SubagentSettings = z.infer<typeof SUBAGENT_SETTINGS_SCHEMA>;

/**
 * Tool-summary presentation and economics.
 *
 * `every` maps to the runner's summarizer batching (0 disables). `lines` and
 * `tier` shape how the one-line summaries read and which model pays for them.
 */
export const SUMMARY_SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  every: z.number().int().min(0).max(50).default(3),
  lines: z.number().int().min(1).max(5).default(1),
  tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).default('D'),
  thinking: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  prompt: z.string().max(4000).default(''),
});
export type SummarySettings = z.infer<typeof SUMMARY_SETTINGS_SCHEMA>;

/** The built-in summary prompt, shown in the editor when none was customised. */
export const DEFAULT_SUMMARY_PROMPT_FOR_UI = [
  'You compress agent tool activity into ONE short line for a human supervisor.',
  'Rules:',
  '- At most 140 characters.',
  '- Plain past tense, no markdown, no bullet points, no preamble.',
  "- Say what happened, not that something happened: 'Read config.yaml, wrote index.ts, ran tests (2 failed)'.",
  '- If a tool failed, say so plainly.',
].join('\n');

export const THEMES = {
  midnight: {
    label: 'Midnight',
    bg: '#0b0b0d',
    panel: '#111115',
    panel2: '#17171d',
    hover: '#1f1f27',
    border: 'rgba(255, 255, 255, 0.08)',
    borderStrong: 'rgba(255, 255, 255, 0.14)',
    text: '#ececef',
    muted: '#9a9aa6',
    faint: '#636370',
    accent: '#e06c88',
    accentSoft: 'rgba(224, 108, 136, 0.14)',
    accentAmber: '#d98a4e',
    ok: '#4ade80',
    warn: '#f59e0b',
    bad: '#f87171',
  },
  paper: {
    label: 'Paper',
    bg: '#f7f5f0',
    panel: '#ffffff',
    panel2: '#efeee9',
    hover: '#e6e4dd',
    border: 'rgba(0, 0, 0, 0.09)',
    borderStrong: 'rgba(0, 0, 0, 0.16)',
    text: '#1c1a17',
    muted: '#57534d',
    faint: '#8a857e',
    accent: '#c8455f',
    accentSoft: 'rgba(200, 69, 95, 0.12)',
    accentAmber: '#9a6700',
    ok: '#1a7f37',
    warn: '#9a6700',
    bad: '#cf222e',
  },
  terminal: {
    label: 'Terminal',
    bg: '#050805',
    panel: '#0a120a',
    panel2: '#0e1a0e',
    hover: '#162716',
    border: 'rgba(90, 255, 120, 0.12)',
    borderStrong: 'rgba(90, 255, 120, 0.24)',
    text: '#c6f6c6',
    muted: '#7fae7f',
    faint: '#528052',
    accent: '#33ff66',
    accentSoft: 'rgba(51, 255, 102, 0.14)',
    accentAmber: '#ffcc33',
    ok: '#33ff66',
    warn: '#ffcc33',
    bad: '#ff5555',
  },
} as const;
export type ThemeName = keyof typeof THEMES;

export const DEFAULT_CORE_FOUR: CoreFour = CoreFourSchema.parse({});

/** Key/value store backing factory settings. */
export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly factoryId: string,
  ) {}

  private get<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
    const row = this.db
      .prepare(`SELECT value_json FROM factory_settings WHERE factory_id = ? AND key = ?`)
      .get(this.factoryId, key) as { value_json: string } | undefined;
    if (!row) return fallback;
    // Two independent failure modes, both survivable:
    //  - unparseable JSON (torn write, hand-edited db)
    //  - parseable JSON that no longer matches the schema (old version)
    let raw: unknown;
    try {
      raw = JSON.parse(row.value_json);
    } catch {
      console.warn(`[settings] unparseable '${key}' for factory '${this.factoryId}'; using defaults`);
      return fallback;
    }
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : fallback;
  }

  private set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO factory_settings (factory_id, key, value_json, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(factory_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(this.factoryId, key, JSON.stringify(value), Date.now());
  }

  coreFour(): CoreFour {
    return this.get('coreFour', CoreFourSchema, DEFAULT_CORE_FOUR);
  }

  setCoreFour(patch: unknown): CoreFour {
    const next = CoreFourSchema.parse(deepMerge(this.coreFour(), patch));
    this.set('coreFour', next);
    return next;
  }

  ui(): UiSettings {
    return this.get('ui', UI_SETTINGS_SCHEMA, UI_SETTINGS_SCHEMA.parse({}));
  }

  setUi(patch: unknown): UiSettings {
    const next = UI_SETTINGS_SCHEMA.parse(deepMerge(this.ui(), patch));
    this.set('ui', next);
    return next;
  }

  agent(): AgentSettings {
    return this.get('agent', AGENT_SETTINGS_SCHEMA, AGENT_SETTINGS_SCHEMA.parse({}));
  }

  setAgent(patch: unknown): AgentSettings {
    const next = AGENT_SETTINGS_SCHEMA.parse(deepMerge(this.agent(), patch));
    this.set('agent', next);
    return next;
  }

  subagents(): SubagentSettings {
    return this.get('subagents', SUBAGENT_SETTINGS_SCHEMA, SUBAGENT_SETTINGS_SCHEMA.parse({}));
  }

  setSubagents(patch: unknown): SubagentSettings {
    const next = SUBAGENT_SETTINGS_SCHEMA.parse(deepMerge(this.subagents(), patch));
    this.set('subagents', next);
    return next;
  }

  summary(): SummarySettings {
    const stored = this.get('summary', SUMMARY_SETTINGS_SCHEMA, SUMMARY_SETTINGS_SCHEMA.parse({}));
    // An empty stored prompt means "use the built-in one"; show it so the editor
    // is not blank for a user who never customised it.
    return stored.prompt ? stored : { ...stored, prompt: DEFAULT_SUMMARY_PROMPT_FOR_UI };
  }

  setSummary(patch: unknown): SummarySettings {
    const next = SUMMARY_SETTINGS_SCHEMA.parse(deepMerge(this.summary(), patch));
    this.set('summary', next);
    return next;
  }

  theme(): ThemeName {
    const row = this.db
      .prepare(`SELECT value_json FROM factory_settings WHERE factory_id = ? AND key = 'theme'`)
      .get(this.factoryId) as { value_json: string } | undefined;
    if (!row) return 'midnight';
    const name = JSON.parse(row.value_json) as string;
    return name in THEMES ? (name as ThemeName) : 'midnight';
  }

  setTheme(name: string): ThemeName {
    if (!(name in THEMES)) {
      throw new Error(`Unknown theme '${name}'. Known: ${Object.keys(THEMES).join(', ')}`);
    }
    this.set('theme', name);
    return name as ThemeName;
  }

  /** Everything the Settings panel needs in one call. */
  snapshot() {
    return {
      coreFour: this.coreFour(),
      ui: this.ui(),
      agent: this.agent(),
      subagents: this.subagents(),
      summary: this.summary(),
      theme: this.theme(),
      themes: Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label, tokens: t })),
    };
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined || patch === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

const CoreFourPatch = CoreFourSchema.partial().partial();
const UiPatch = UI_SETTINGS_SCHEMA.partial();

export interface SettingsHarnessOptions {
  db: Db;
  factoryId: string;
}

/**
 * Commands that let the AGENT reconfigure its own environment in real time —
 * under the same capability rules as everything else.
 *
 * `factory.settings` is lead-only and ungated (it is reversible and only
 * affects this factory). Theme and UI changes are human-or-specialist but the
 * agent cannot silently repaint the human's screen: `factory.ui` accepts only
 * layout flags, and the agent's prompt tells it to ask first.
 */
export function createSettingsHarness(opts: SettingsHarnessOptions): HarnessModule & { store: SettingsStore } {
  const store = new SettingsStore(opts.db, opts.factoryId);

  const settings: CommandDefinition<z.ZodObject<{ patch: z.ZodOptional<typeof CoreFourPatch> }>> = {
    name: 'factory.settings',
    description:
      'Read or update this factory\'s Core Four (context, model, prompt, tools). Omit patch to read.',
    inputSchema: z.object({ patch: CoreFourPatch.optional() }),
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute(input) {
      if (!input.patch) return { coreFour: store.coreFour() };
      return { coreFour: store.setCoreFour(input.patch) };
    },
  };

  const ui: CommandDefinition<z.ZodObject<{ patch: z.ZodOptional<typeof UiPatch> }>> = {
    name: 'factory.ui',
    description: 'Read or update UI layout settings (pane widths, density, which panels are visible).',
    inputSchema: z.object({ patch: UiPatch.optional() }),
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute(input) {
      if (!input.patch) return { ui: store.ui() };
      return { ui: store.setUi(input.patch) };
    },
  };

  const agentSettings: CommandDefinition<z.ZodObject<{ patch: z.ZodOptional<z.ZodObject<Record<string, z.ZodType>>> }>> = {
    name: 'factory.agent',
    description: 'Read or update the agent identity shown in the panel (name, max turns).',
    inputSchema: z.object({ patch: AGENT_SETTINGS_SCHEMA.partial().optional() }),
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute(input) {
      if (!input.patch) return { agent: store.agent() };
      return { agent: store.setAgent(input.patch) };
    },
  };

  const subagentSettings: CommandDefinition<z.ZodObject<{ patch: z.ZodOptional<z.ZodObject<Record<string, z.ZodType>>> }>> = {
    name: 'factory.subagents',
    description: 'Read or update subagent defaults (tier, thinking, budget, duration, concurrency).',
    inputSchema: z.object({ patch: SUBAGENT_SETTINGS_SCHEMA.partial().optional() }),
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute(input) {
      if (!input.patch) return { subagents: store.subagents() };
      return { subagents: store.setSubagents(input.patch) };
    },
  };

  const summarySettings: CommandDefinition<z.ZodObject<{ patch: z.ZodOptional<z.ZodObject<Record<string, z.ZodType>>> }>> = {
    name: 'factory.summary',
    description: 'Read or update tool-summary settings (enabled, batching, lines, tier, prompt).',
    inputSchema: z.object({ patch: SUMMARY_SETTINGS_SCHEMA.partial().optional() }),
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute(input) {
      if (!input.patch) return { summary: store.summary() };
      return { summary: store.setSummary(input.patch) };
    },
  };

  const themes: CommandDefinition<z.ZodObject<{ name: z.ZodOptional<z.ZodEnum<Record<string, string>>>; list: z.ZodOptional<z.ZodBoolean> }>> = {
    name: 'factory.themes',
    description: 'List available themes, or set the active theme by name.',
    inputSchema: z.object({
      name: z
        .enum(Object.keys(THEMES) as [string, ...string[]])
        .optional(),
      list: z.boolean().optional(),
    }),
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute(input) {
      if (input.name) return { theme: store.setTheme(input.name) };
      return {
        theme: store.theme(),
        themes: Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label })),
      };
    },
  };

  return {
    id: 'settings',
    name: 'Settings',
    store,
    commands: [settings, ui, themes, agentSettings, subagentSettings, summarySettings],
    renderPromptSection(ctx) {
      if (!ctx.toolNames.includes('factory.settings')) return '';
      return [
        '## Settings',
        `Before changing a setting, read the current Core Four with factory.settings (no patch).`,
        'Change only what the task requires. Model and tier changes cost real money; say what you changed and why.',
        'Do not repaint the human\'s UI unprompted.',
      ].join('\n');
    },
  };
}



