import { z } from 'zod';

/**
 * A factory is CONFIGURATION, not a copy of the engine.
 * This schema is what `factory.config.ts` files are validated against, which is
 * what keeps `factories/*` thin (Compounding Engineering without drift).
 */
export const FactoryConfigSchema = z.object({
  /**
   * Lowercase identifier, used as the directory name and as the DB scoping key.
   *
   * A leading underscore is allowed because reserved factories are named that
   * way by convention — the architecture specifies `factories/_meta` for the
   * MetaFactory. Everything after it is a normal slug.
   */
  name: z.string().min(1).regex(/^[a-z0-9_][a-z0-9_-]*$/, 'lowercase letters, digits, - and _ only'),
  title: z.string().min(1),
  description: z.string().default(''),
  port: z.number().int().min(1024).max(65535),
  /** Port for the isolated PageStage origin. Must differ from `port`. */
  pageStagePort: z.number().int().min(1024).max(65535).optional(),
  budgetUsd: z.number().positive().default(5),
  tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).default('S'),
  harnesses: z.array(z.string()).default(['notes']),
  /** Absolute or factory-relative workspace root for fs/shell tools. */
  workspaceRoot: z.string().default('.'),
  agents: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(['lead', 'specialist']),
        name: z.string(),
        tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).optional(),
        prompt: z.string().default(''),
      }),
    )
    .default([{ id: 'lead', role: 'lead', name: 'Lead', prompt: '' }]),
});
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

export function defineFactory(config: FactoryConfig): FactoryConfig {
  const parsed = FactoryConfigSchema.parse(config);
  if (parsed.pageStagePort !== undefined && parsed.pageStagePort === parsed.port) {
    throw new Error(
      `Factory '${parsed.name}': pageStagePort must differ from port (both ${parsed.port}). ` +
        `The PageStage isolation depends on being a separate origin.`,
    );
  }
  return parsed;
}
