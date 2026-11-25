# Sovereign Meta Software Factory

A local-first, modular meta-software factory: you build *factories* (thin
configurations), each running durable agents under explicit budgets, capabilities
and human approval gates. Built to move the engineer from prompting in a terminal
to supervising specialised factories that run continuously.

**Status:** five implementation phases are complete. The workspace builds
successfully; see [Verification](#verification) for reproducible results.

---

## Quick start

```bash
pnpm install
pnpm -r --workspace-concurrency=1 run build

# real model (Mistral). Key is read from the environment, never written to disk.
export MISTRAL_API_KEY=...        # PowerShell: $env:MISTRAL_API_KEY='...'
pnpm --filter @mf/app dev         # or: node apps/web/dist/main.js .
```

It prints `http://127.0.0.1:4960/#token=<hex>`. Open it. The token lives only in
that process's memory; the UI reads it from the fragment and wipes the URL.

Useful switches:

| Variable | Effect |
|---|---|
| `MF_FACTORY` | which factory to boot (default `sandbox`) |
| `MF_FAKE=1` | deterministic fake provider: no network, no spend |
| `MF_SHELL=1` | enable `shell.exec` (still human-gated) |
| `MF_TOOL_SUMMARY_EVERY` | summarize tool calls every N (default 3, `0` disables) |
| `MF_CHEAP_MODEL` | route tiers C/D to a cheaper model (currently unset; see DECISIONS D-001) |

---

## What exists

### Core (`packages/core`)
| Piece | Responsibility |
|---|---|
| `CommandBus` | Every mutation. Commands declare `allowedActors`, `idempotent`, `requiresGate`. Actor is never read from the payload. |
| `BudgetEnforcer` | `carveOut` / `releaseRemainder` in `BEGIN IMMEDIATE`; `deriveMaxOutputTokens`; `chargeWithinPool`. |
| `TokenLedger` | Append-only spend with a price snapshot per call. The single source of truth for availability. |
| `LedgerQueries` | Drizzle-backed reads for the UI; a test asserts it equals the raw-SQL view to the nanodollar. |
| `drizzle-schema.ts` | Typed table definitions; a parity test compares them column-for-column with the live SQLite schema. |
| `DurableRunner` | Event log + status in one transaction; `recoverRun`; crash-safe tool replay. |
| `LlmRouter` | Tier → real provider/model, with prices. |
| `FakeLLMProvider` | Deterministic scripts: `text`, `tool_call`, `stream_then_abort`, `crash_process`. |
| Server security | Anti-DNS-rebinding `Host` guard, Origin-checked mutations, ephemeral bearer token. |
| `channels/types.ts` | `ChannelAdapter` contract + `validateGateReply` (one-time tokens). |

### Harnesses
| Package | Tools | Notable safety property |
|---|---|---|
| `harness-notes` | `notes.*` | `notes.delete` is idempotent but gated. |
| `harness-coding` | `fs.*`, `shell.exec` | Path traversal blocked (incl. sibling-prefix and symlink escapes); `HUMAN_TOKEN` never reaches the child env. |
| `harness-pages` | `pages.*` | PageStage on its own origin, `connect-src 'none'`, 3-message postMessage whitelist. |
| `harness-settings` | `factory.settings/ui/themes` | The Core Four (context, model, prompt, tools) is always reachable. |
| `harness-subagents` | `subagent.run/read/stop/list` | Atomic budget carve-out; a pool can never go negative. |
| `harness-proactive` | `proactive.*` | No delta ⇒ **$0** and no model call; every discard logged. |
| `harness-teams` | `team.*` | Social contract is code (`shouldSpeak`), not a paragraph. |
| `harness-mailbox` | `mailbox.*` | `fromFactory` from the actor; reading others' mail is 404. |
| `harness-metafactory` | `factory.spinUp`, `module.promote` | Promotion is human-gated and versioned. |
| `harness-skills-bridge` | MCP tools, `SKILL.md` | External tools gated by default; skill bodies are instructions, never executed. |

### Factories
- `factories/sandbox` — reference factory, all harnesses.
- `factories/_meta` — the MetaFactory that manages the others.

---

## How the guarantees are enforced

**Actor identity.** `dispatch(name, input, actor)` — the actor is a separate
argument. HTTP sets `{kind:'human'}` after authenticating; the runner sets
`{kind:'agent',...}` in-process. A body field named `actor` is stripped.

**ApprovalGate.** A gated command called by a non-human never executes: the
validated input is persisted and the run moves to `paused_gate`. On approval the
stored JSON is executed exactly.

**Crash recovery.** A `tool_call_started` with no `tool_result` is resolved
deterministically: idempotent → re-executed; non-idempotent →
`unknown_after_crash`, never re-run. Tested across two real processes.

**Budget.** The ledger is the only book of account. Before each call the runner
reserves conservatively (input estimate × 1.5); if the pool cannot afford it the
run is killed with a precise reason instead of overdrawing.

---

## Testing

```bash
pnpm test                              # 368 passed, 3 skipped (371 total)
# Live-provider tests (requires a provider key):
MISTRAL_API_KEY=... pnpm test
```

The E2E drives a **running server** over real HTTP (38 checks, all five phases):

```bash
node --import tsx/esm apps/web/scripts/e2e-smoke.ts http://127.0.0.1:4960 <token>
```

Notable tests: cross-process crash recovery, gate pause/approve/resume,
path-traversal attacks, PageStage CSP, concurrent budget overdraw, `$0` on no
delta, MCP round-trip against a real stdio server.

**Do not switch vitest back to `pool: 'forks'`** — see `DECISIONS.md` D-005.

---

## Verification

Verified locally on November 25, 2026:

- `pnpm build` — passed for all 14 workspace packages.
- `pnpm test` — 368 passed, 3 skipped (371 total across 25 test files).
- Live-provider tests were skipped because no provider key was supplied.
- `pnpm typecheck` — fails because the root script invokes `tsc -b` without a
  root `tsconfig.json`; package builds pass.

Re-run these commands in your environment; results can vary with runtime and
dependency versions.

## Security reports

Do not put API keys, bearer URLs, real user data, or private factory state in
issues or discussions. Report security concerns privately to the maintainer.

## License

No license has been selected. Unless one is added, standard copyright applies
and reuse rights are not granted by this repository.

## Repository layout

```
packages/core                 engine: bus, runner, budget, llm, server, channels
packages/harness-*            capabilities as versioned packages
apps/web                      server + Mission Control UI (3 columns)
factories/                    thin configs: factory.config.ts + state.db + workspace
channels/                     reserved for future ChannelAdapter implementations
DECISIONS.md                  autonomous decisions, with reasoning
```




