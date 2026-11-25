import { integer, real, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema: the TYPED source of truth for the factory database.
 *
 * Why this exists alongside the hand-written DDL in `schema.ts`:
 * the DDL is what actually creates and migrates the database (it carries the
 * CHECK constraints and pragmas SQLite needs); this file is what gives TypeScript
 * real types for every row, so a column rename cannot silently break a query.
 *
 * A test asserts the two stay in sync column-for-column, so they cannot drift.
 *
 * Money columns are REAL because SQLite has no decimal type; every read path
 * goes through the helpers in `budget/money.ts` to absorb float error.
 */

export const schemaMeta = sqliteTable('schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const budgetPools = sqliteTable(
  'budget_pools',
  {
    id: text('id').primaryKey(),
    parentPoolId: text('parent_pool_id'),
    ownerKind: text('owner_kind', { enum: ['factory', 'run', 'subagent', 'job'] }).notNull(),
    ownerId: text('owner_id').notNull(),
    amountUsd: real('amount_usd').notNull(),
    usedUsd: real('used_usd').notNull().default(0),
    releasedUsd: real('released_usd').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_budget_pools_owner').on(t.ownerKind, t.ownerId)],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    factoryId: text('factory_id').notNull(),
    agentId: text('agent_id'),
    goal: text('goal').notNull(),
    status: text('status').notNull(),
    tier: text('tier').notNull(),
    poolId: text('pool_id'),
    turn: integer('turn').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    endedAt: integer('ended_at'),
    errorJson: text('error_json'),
  },
  (t) => [index('idx_runs_status').on(t.status, t.createdAt)],
);

/** Append-only. `seq` is per-run and gap-free. */
export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    actorJson: text('actor_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('uq_run_events_seq').on(t.runId, t.seq)],
);

export const approvalGates = sqliteTable(
  'approval_gates',
  {
    id: text('id').primaryKey(),
    runId: text('run_id'),
    factoryId: text('factory_id').notNull(),
    commandName: text('command_name').notNull(),
    validatedInputJson: text('validated_input_json').notNull(),
    requestedByJson: text('requested_by_json').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    toolCallId: text('tool_call_id'),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
    resolvedByJson: text('resolved_by_json'),
    reason: text('reason'),
  },
  (t) => [uniqueIndex('uq_gate_idempotency').on(t.factoryId, t.idempotencyKey)],
);

export const tokenLedger = sqliteTable(
  'token_ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id'),
    agentId: text('agent_id'),
    subagentId: text('subagent_id'),
    poolId: text('pool_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    tier: text('tier').notNull(),
    unitPriceInUsd: real('unit_price_in_usd').notNull(),
    unitPriceOutUsd: real('unit_price_out_usd').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    isEstimated: integer('is_estimated', { mode: 'boolean' }).notNull().default(false),
    aborted: integer('aborted', { mode: 'boolean' }).notNull().default(false),
    category: text('category').notNull(),
    turn: integer('turn'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_ledger_pool').on(t.poolId)],
);

export const toolSummaries = sqliteTable('tool_summaries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  batchStart: integer('batch_start').notNull(),
  batchEnd: integer('batch_end').notNull(),
  summary: text('summary').notNull(),
  toolNames: text('tool_names').notNull(),
  model: text('model').notNull(),
  costUsd: real('cost_usd').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  factoryId: text('factory_id').notNull(),
  role: text('role').notNull(),
  name: text('name').notNull(),
  contextConfigJson: text('context_config_json').notNull(),
  modelConfigJson: text('model_config_json').notNull(),
  promptJson: text('prompt_json').notNull(),
  toolsJson: text('tools_json').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const pages = sqliteTable(
  'pages',
  {
    id: text('id').primaryKey(),
    factoryId: text('factory_id').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    html: text('html').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('uq_pages_slug').on(t.factoryId, t.slug)],
);

export const triggersAndJobs = sqliteTable(
  'triggers_and_jobs',
  {
    id: text('id').primaryKey(),
    factoryId: text('factory_id').notNull(),
    kind: text('kind', { enum: ['cron', 'webhook', 'file_watcher', 'log_event'] }).notNull(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    configJson: text('config_json').notNull(),
    secret: text('secret'),
    lastFireAt: integer('last_fire_at'),
    nextFireAt: integer('next_fire_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_triggers_factory').on(t.factoryId, t.kind)],
);

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  factoryId: text('factory_id').notNull(),
  triggerId: text('trigger_id'),
  name: text('name').notNull(),
  modulePath: text('module_path').notNull(),
  lastRunAt: integer('last_run_at'),
  lastStatus: text('last_status'),
  createdAt: integer('created_at').notNull(),
});

/** Every classifier decision INCLUDING discards: the audit trail. */
export const classifierLogs = sqliteTable(
  'classifier_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    factoryId: text('factory_id').notNull(),
    jobId: text('job_id'),
    triggerId: text('trigger_id'),
    model: text('model').notNull(),
    inputDigest: text('input_digest').notNull(),
    decision: text('decision', { enum: ['wake', 'discard', 'error'] }).notNull(),
    reason: text('reason'),
    outputJson: text('output_json'),
    costUsd: real('cost_usd').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_classifier_logs_factory').on(t.factoryId, t.createdAt)],
);

export const chatRooms = sqliteTable(
  'chat_rooms',
  {
    id: text('id').primaryKey(),
    factoryId: text('factory_id').notNull(),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('uq_chat_rooms_name').on(t.factoryId, t.name)],
);

export const roomMessages = sqliteTable(
  'room_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    roomId: text('room_id').notNull(),
    author: text('author').notNull(),
    authorKind: text('author_kind').notNull(),
    mentions: text('mentions').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_room_messages_room').on(t.roomId, t.id)],
);

export const mailbox = sqliteTable(
  'mailbox',
  {
    id: text('id').primaryKey(),
    fromFactory: text('from_factory').notNull(),
    toFactory: text('to_factory').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status', { enum: ['unread', 'read'] }).notNull(),
    replyTo: text('reply_to'),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
  },
  (t) => [index('idx_mailbox_to').on(t.toFactory, t.status, t.createdAt)],
);

export const factorySettings = sqliteTable(
  'factory_settings',
  {
    factoryId: text('factory_id').notNull(),
    key: text('key').notNull(),
    valueJson: text('value_json').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('uq_factory_settings').on(t.factoryId, t.key)],
);

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    factoryId: text('factory_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    commandName: text('command_name').notNull(),
    resultJson: text('result_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('uq_idempotency').on(t.factoryId, t.idempotencyKey)],
);

/** The full set, used by the schema-parity test. */
export const ALL_TABLES = {
  schemaMeta,
  budgetPools,
  runs,
  runEvents,
  approvalGates,
  tokenLedger,
  toolSummaries,
  agents,
  pages,
  triggersAndJobs,
  jobs,
  classifierLogs,
  chatRooms,
  roomMessages,
  mailbox,
  factorySettings,
  idempotencyKeys,
} as const;
