/**
 * Read models for the Phase 2-5 UI surfaces.
 * Kept out of core so core stays free of harness-specific knowledge.
 */
import type { Db, ReadModelExtension } from '@mf/core';
import { PageStore } from '@mf/harness-pages';
import { SettingsStore } from '@mf/harness-settings';
import { TeamStore } from '@mf/harness-teams';
import { MailboxStore } from '@mf/harness-mailbox';
import type { ProactiveHarness } from '@mf/harness-proactive';

export function phase2ReadModels(args: {
  db: Db;
  factoryId: string;
  pageStageUrl: string;
  proactive?: ProactiveHarness | null;
}): ReadModelExtension[] {
  const pages = new PageStore({ db: args.db, factoryId: args.factoryId });
  const settings = new SettingsStore(args.db, args.factoryId);
  const teams = new TeamStore(args.db, args.factoryId);
  const mailbox = new MailboxStore(args.db, args.factoryId);

  const models: ReadModelExtension[] = [
    {
      path: '/api/pages',
      handler: () => ({ pages: pages.list(), pageStageUrl: args.pageStageUrl }),
    },
    {
      path: '/api/settings',
      handler: () => settings.snapshot(),
    },
    {
      path: '/api/tool-summaries',
      handler: ({ query }) => {
        const runId = query('runId');
        if (!runId) return { summaries: [] };
        const rows = args.db
          .prepare(`SELECT * FROM tool_summaries WHERE run_id = ? ORDER BY batch_end ASC`)
          .all(runId) as Array<{
          batch_start: number;
          batch_end: number;
          summary: string;
          tool_names: string;
          model: string;
          cost_usd: number;
        }>;
        return {
          summaries: rows.map((r) => ({
            batchStart: r.batch_start,
            batchEnd: r.batch_end,
            summary: r.summary,
            toolNames: JSON.parse(r.tool_names) as string[],
            model: r.model,
            costUsd: r.cost_usd,
          })),
        };
      },
    },
    {
      path: '/api/traces',
      handler: ({ query }) => {
        const runId = query('runId');
        if (!runId) return { traces: [] };
        const rows = args.db
          .prepare(`SELECT seq, type, payload_json, created_at FROM run_events WHERE run_id = ? ORDER BY seq ASC`)
          .all(runId) as Array<{ seq: number; type: string; payload_json: string; created_at: number }>;
        return {
          traces: rows.map((r) => ({
            seq: r.seq,
            type: r.type,
            at: r.created_at,
            payload: JSON.parse(r.payload_json) as unknown,
          })),
        };
      },
    },

    // ------------------------------------------------- Phase 3: Cron & Jobs
    {
      path: '/api/triggers',
      handler: () => ({
        triggers: args.proactive ? args.proactive.listTriggers() : [],
        jobs: args.proactive ? args.proactive.jobs().map((j) => ({ id: j.id, name: j.name, modulePath: j.modulePath })) : [],
      }),
    },
    {
      path: '/api/classifier-logs',
      handler: ({ query }) => ({
        logs: args.proactive ? args.proactive.listClassifierLogs(Number(query('limit') ?? 100)) : [],
      }),
    },

    // ---------------------------------------------------- Phase 4: Teams & mail
    {
      path: '/api/agents',
      handler: () => ({
        agents: teams.list().map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          topic: a.coreFour.prompt.topic,
          persona: a.coreFour.prompt.persona,
          tier: a.coreFour.model.tier,
        })),
        rooms: teams.rooms(),
      }),
    },
    {
      path: '/api/mailbox',
      handler: () => ({
        mail: mailbox.list({ limit: 50 }),
        sent: mailbox.listSent(20),
        unread: mailbox.unreadCount(),
      }),
    },

    // ------------------------------------------------- Phase 3: subagents
    {
      path: '/api/subagents',
      handler: ({ query }) => {
        const rows = args.db
          .prepare(
            `SELECT id, parent_run_id, goal, tier, status, max_cost_usd, max_duration_ms, started_at, ended_at, output, end_reason
               FROM subagents ORDER BY started_at DESC LIMIT ?`,
          )
          .all(Number(query('limit') ?? 50)) as Array<Record<string, unknown>>;
        return {
          subagents: rows.map((r) => ({
            id: r['id'],
            parentRunId: r['parent_run_id'],
            goal: r['goal'],
            tier: r['tier'],
            status: r['status'],
            maxCostUsd: r['max_cost_usd'],
            maxDurationMs: r['max_duration_ms'],
            startedAt: r['started_at'],
            endedAt: r['ended_at'],
            output: r['output'],
            endReason: r['end_reason'],
          })),
        };
      },
    },
  ];
  return models;
}
