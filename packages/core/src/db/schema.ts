/**
 * SQLite schema for the factory state database.
 *
 * Design notes that matter:
 * - `run_events` is append-only and ordered by `seq` per run. The UNIQUE(run_id, seq)
 *   constraint is what makes "append + status update in one transaction" observable.
 * - Money is stored as REAL micro-USD-free decimals in `*_usd` columns. We store
 *   both the raw REAL and never round on write; all arithmetic goes through
 *   `budget/money.ts` to avoid float drift in comparisons.
 * - `approval_gates.validated_input_json` holds the POST-Zod input. On approval the
 *   server executes exactly that, which is what makes the gate "exact".
 */
import type BetterSqlite3 from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

export const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- budget
CREATE TABLE IF NOT EXISTS budget_pools (
  id             TEXT PRIMARY KEY,
  parent_pool_id TEXT REFERENCES budget_pools(id) ON DELETE SET NULL,
  owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('factory','run','subagent','job')),
  owner_id       TEXT NOT NULL,
  amount_usd     REAL NOT NULL CHECK (amount_usd >= 0),
  used_usd       REAL NOT NULL DEFAULT 0 CHECK (used_usd >= 0),
  released_usd   REAL NOT NULL DEFAULT 0 CHECK (released_usd >= 0),
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_budget_pools_parent ON budget_pools(parent_pool_id);
CREATE INDEX IF NOT EXISTS idx_budget_pools_owner  ON budget_pools(owner_kind, owner_id);

-- ------------------------------------------------------------------- runs
CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  factory_id     TEXT NOT NULL,
  agent_id       TEXT,
  goal           TEXT NOT NULL,
  status         TEXT NOT NULL,
  tier           TEXT NOT NULL,
  pool_id        TEXT REFERENCES budget_pools(id) ON DELETE SET NULL,
  turn           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  error_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_factory ON runs(factory_id, created_at DESC);

-- Append-only event log. seq is per-run and gap-free.
CREATE TABLE IF NOT EXISTS run_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);

-- --------------------------------------------------------- approval gates
CREATE TABLE IF NOT EXISTS approval_gates (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT REFERENCES runs(id) ON DELETE CASCADE,
  factory_id           TEXT NOT NULL,
  command_name         TEXT NOT NULL,
  validated_input_json TEXT NOT NULL,
  requested_by_json    TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  tool_call_id         TEXT,
  status               TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  created_at           INTEGER NOT NULL,
  resolved_at          INTEGER,
  resolved_by_json     TEXT,
  reason               TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_gate_idempotency
  ON approval_gates(factory_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_gates_status ON approval_gates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gates_run ON approval_gates(run_id);

-- ----------------------------------------------------------- token ledger
CREATE TABLE IF NOT EXISTS token_ledger (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT REFERENCES runs(id) ON DELETE SET NULL,
  agent_id           TEXT,
  subagent_id        TEXT,
  pool_id            TEXT REFERENCES budget_pools(id) ON DELETE SET NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  tier               TEXT NOT NULL,
  unit_price_in_usd  REAL NOT NULL,
  unit_price_out_usd REAL NOT NULL,
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  is_estimated       INTEGER NOT NULL DEFAULT 0,
  aborted            INTEGER NOT NULL DEFAULT 0,
  category           TEXT NOT NULL,
  turn               INTEGER,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_run  ON token_ledger(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_pool ON token_ledger(pool_id);

-- --------------------------------------------------------- tool summaries
CREATE TABLE IF NOT EXISTS tool_summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  batch_start  INTEGER NOT NULL,
  batch_end    INTEGER NOT NULL,
  summary      TEXT NOT NULL,
  tool_names   TEXT NOT NULL,
  model        TEXT NOT NULL,
  cost_usd     REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_summaries_run ON tool_summaries(run_id, batch_end);

-- ----------------------------------------------------------------- agents
CREATE TABLE IF NOT EXISTS agents (
  id                 TEXT PRIMARY KEY,
  factory_id         TEXT NOT NULL,
  role               TEXT NOT NULL,
  name               TEXT NOT NULL,
  -- Core Four
  context_config_json TEXT NOT NULL,
  model_config_json   TEXT NOT NULL,
  prompt_json         TEXT NOT NULL,
  tools_json          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_factory ON agents(factory_id);

-- ------------------------------------------------------------------ pages
CREATE TABLE IF NOT EXISTS pages (
  id           TEXT PRIMARY KEY,
  factory_id   TEXT NOT NULL,
  slug         TEXT NOT NULL,
  title        TEXT NOT NULL,
  html         TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (factory_id, slug)
);

-- ------------------------------------------------ triggers, jobs, classifier
CREATE TABLE IF NOT EXISTS triggers_and_jobs (
  id           TEXT PRIMARY KEY,
  factory_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('cron','webhook','file_watcher','log_event')),
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  config_json  TEXT NOT NULL,
  secret       TEXT,
  last_fire_at INTEGER,
  next_fire_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_triggers_factory ON triggers_and_jobs(factory_id, kind);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  factory_id    TEXT NOT NULL,
  trigger_id    TEXT REFERENCES triggers_and_jobs(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  module_path   TEXT NOT NULL,
  last_run_at   INTEGER,
  last_status   TEXT,
  created_at    INTEGER NOT NULL
);

-- Every classifier decision, INCLUDING discards. This is the audit trail that
-- lets a human sample what the cheap model threw away.
CREATE TABLE IF NOT EXISTS classifier_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  factory_id    TEXT NOT NULL,
  job_id        TEXT,
  trigger_id    TEXT,
  model         TEXT NOT NULL,
  input_digest  TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('wake','discard','error')),
  reason        TEXT,
  output_json   TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_classifier_logs_factory ON classifier_logs(factory_id, created_at DESC);

-- ---------------------------------------------------------- chat + mailbox
CREATE TABLE IF NOT EXISTS chat_rooms (
  id         TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (factory_id, name)
);

CREATE TABLE IF NOT EXISTS room_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  mentions   TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, id);

CREATE TABLE IF NOT EXISTS mailbox (
  id           TEXT PRIMARY KEY,
  from_factory TEXT NOT NULL,
  to_factory   TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('unread','read')),
  reply_to     TEXT REFERENCES mailbox(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  read_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox(to_factory, status, created_at DESC);

-- ------------------------------------------------ settings / core four / ui
CREATE TABLE IF NOT EXISTS factory_settings (
  factory_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (factory_id, key)
);

-- ---------------------------------------------------- durability bookkeeping
-- Idempotency keys for agent-initiated mutations, so a retried tool call after a
-- crash does not double-apply.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  factory_id      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_name    TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (factory_id, idempotency_key)
);
`;

export function applySchema(db: BetterSqlite3.Database): void {
  db.exec(DDL);
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}
