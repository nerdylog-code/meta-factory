# Decision Log

Autonomous decisions taken while the owner was away. Each entry: what, why, and
whether it is reversible.

---

## D-001 - Model routing: deepseek everywhere, cheap model as a flag
**Date:** 2026-11-24
**Decision:** `deepseek-v4-1-flash-1017` serves every tier (S+ â€¦ D).
**Owner's instruction:** "o Ãºnico modelo que vai rodar Ã© o deepseek v4.1 flash
mesmo, coloca flag como futura atualizaÃ§Ã£o."
**Implementation:** `MF_CHEAP_MODEL` env var. When set, it overrides the model
for tiers C and D only (`resolveTierModel` in `apps/web/src/factory-builder.ts`).
Default: unset â†’ deepseek everywhere.
**Known cost:** the proactive classifier and tool-summary use Tier C/D. They
exist to *avoid* waking the expensive agent on noise. On deepseek each discard
costs roughly 3500x what a 3B model would. Correctness unaffected; cost per
triggered job rises.
**Reversible:** yes, one env var.

## D-002 - Tests run against core SOURCE, not dist
**Date:** 2026-11-24
**Decision:** `vitest.config.ts` aliases `@mf/core` and `@mf/harness-notes` to
`src/index.ts`.
**Why:** a cross-process crash test needed compiled JS and was deleting
`packages/core/dist`, which other suites imported. Tests must not depend on a
build artifact, nor race each other over shared output.
**Consequence:** the crash test builds into `packages/core/.test-build-crash/<pid>/`
(gitignored) instead.

## D-003 - `startExisting` instead of `startRun` after `createRun`
**Date:** 2026-11-24
**Decision:** HTTP run creation calls `createRun()` then `startExisting(id, â€¦)`.
**Why:** `startRun()` creates its own run. Calling it after `createRun()` left a
duplicate run and split the event log across two ids â€” caught by the E2E smoke
test, not by unit tests.
**Guard:** regression test in `packages/core/test/runner.test.ts`
("startExisting does NOT create a second run for the same request").

## D-004 - Provider selection belongs to the runner, not the app
**Date:** 2026-11-24
**Decision:** `RunnerDeps.providerFor(tier)` resolves provider+price; the route
layer no longer sets a run's provider.
**Why:** the runner ignored the run's tier, so an `S` run executed on whatever
provider was injected at boot. That is a silent model downgrade â€” exactly the
"mock silencioso" the spec forbids.
**Guard:** test "resolves the provider from the run tier when providerFor is
supplied".

## D-005 - better-sqlite3 upgraded to 13.2.0; vitest pool is `threads`
**Date:** 2026-11-24
**Symptom:** intermittent process death, both in tests ("Worker exited
unexpectedly", a whole file reporting zero tests) and in the live server (~20% of
runs), always with a native stack ending in `Statement::scalar deleting
destructor` and the assertion `(env) != nullptr` in
`RemoveEnvironmentCleanupHook` / `DisposeIsolate`.
**Investigation:** ruled out my own code — the same code ran clean standalone and
in-process; 200 concurrent overlapping SQLite writes did not crash; the crash
survived both a `dist` build and the `tsx` loader.
**Root cause:** `better-sqlite3@11.10.0` predates Node 24 support.
**Fix:** upgrade to `better-sqlite3@13.2.0`.
**Measured after:** server loop 8/8 alive (was 8/10); full real-model E2E 6/6 PASS
(was failing within ~2 s). Vitest pool also moved `forks` ? `threads`, which
removes the test-side manifestation (`forks` disposes the child isolate with
native handles alive).
**Do not downgrade.** If the symptom returns, check the native module's Node
version support first — this class of failure is a process kill, so it cannot be
caught with `try/catch`.

## D-006 - Factory names may start with `_`
**Date:** 2026-11-24
**Decision:** the name regex became `^[a-z0-9_][a-z0-9_-]*$`.
**Why:** the architecture specifies `factories/_meta` for the MetaFactory, and the
schema rejected its own spec. Reserved factories are conventionally prefixed with
an underscore.

## D-007 - Factory `harnesses` list is validated against a known set
**Date:** 2026-11-24
**Decision:** booting a factory that names an unimplemented harness throws.
**Why:** during wiring, `subagents` was silently ignored and the factory came up
looking healthy without that capability. A silently missing capability is
indistinguishable from a broken one.

## D-008 - Runner refuses to write after shutdown begins
**Date:** 2026-11-24
**Decision:** `beginShutdown()` + `drain()`; the loop stops at a turn boundary and
`appendEvents` returns early.
**Why:** a proactive wake-run can still be mid-flight when the server stops, and a
statement finalized during teardown is a native assertion. Shutdown never closes
the database while a run is executing — it exits and lets the OS reclaim it, which
is safe because the event log is durable.

## D-009 - The proactive classifier gets its own fake provider
**Date:** 2026-11-24
**Decision:** in `MF_FAKE=1` mode the classifier uses a separate `FakeLLMProvider`.
**Why:** sharing one scripted provider between the run loop and the classifier made
each consume the other's steps; the classifier then read empty output and reported
`unparseable`, which looks like a classifier bug but is a wiring bug.

## D-010 - Tool-summary and classifier run on the primary model
**Date:** 2026-11-24
**Owner's instruction:** "o único modelo que vai rodar é o deepseek v4.1 flash
mesmo, coloca flag como futura atualização."
**Consequence:** per-discard cost for the proactive filter is far higher than with
a 3B model. The architecture is unaffected; only the cost per triggered job rises.
`MF_CHEAP_MODEL` is the one-switch path back.


## D-011 - Drizzle adopted incrementally: typed schema + read paths
**Date:** 2026-11-24
**Problem:** the stack specifies Drizzle ORM; the implementation used hand-written
SQL throughout (88 `prepare()` sites) with `drizzle-orm` declared but never
imported. A declared dependency that is not used is a lie in the manifest.
**Decision (not a rewrite):**
  1. `db/drizzle-schema.ts` declares every table as the TYPED source of truth.
  2. The hand-written DDL in `schema.ts` still CREATES the database, because it
     carries CHECK constraints and pragmas that matter.
  3. A parity test (`drizzle-schema.test.ts`) reads the live SQLite schema and
     compares it column-for-column with Drizzle, so the two cannot drift.
  4. Reads of the token ledger moved to Drizzle (`budget/ledger-queries.ts`), and
     `/api/tokenomics` now uses it. Writes stay raw SQL because they run inside
     transactions shared with the runner.
**Why reads first:** they return the same result regardless of driver, so the
change is verifiable, and a test asserts the Drizzle view equals the raw-SQL view
to the nanodollar. The remaining write sites are a known, documented backlog, not
a hidden divergence.

## D-012 - Page CSP: `frame-ancestors` names the shell instead of `'none'`
**Date:** 2026-11-25
**Problem:** the shell frames its own PageStage, but the page CSP said
`frame-ancestors 'none'`. The iframe rendered as a broken-page icon while every
header assertion still passed, because they only looked for `connect-src 'none'`.
**Decision:** `buildPageCsp(shellOrigin)` emits `frame-ancestors <shellOrigin>`.
Naming one origin is stricter than `*` and sufficient: nobody else may frame a
page. `PAGE_CSP` (no known origin) still denies framing.
**Guard:** tests assert the shell origin is present, `'none'` is not, and `*`
never appears.

## D-013 - Approval must resume the run, not just close the gate
**Date:** 2026-11-25
**Problem:** found by clicking Approve in the live UI. The gate card disappeared
while the run stayed `paused_gate` forever: `approveGate` executed the stored
command and logged `gate_resolved`, but never continued the loop.
**Decision:** `DurableRunner.resumeIfPaused(runId, promptProvider)` resumes only
when no other gate is pending, and `POST /api/gates/:id/approve` calls it and
reports `resumed` in the response.
**Why separate from `approveGate`:** approval is a durable decision that must be
recorded even when resuming is impossible (no provider, run already finished,
shutdown in progress).
**Guard:** `apps/web/test/gate-resume.test.ts` asserts the run leaves
`paused_gate`, a second turn is recorded, rejection does NOT resume, and a run is
never `paused_gate` with zero pending gates.

## D-014 - Mission Control UI rewritten to the Liquid Software brief
**Date:** 2026-11-25
**Scope:** `apps/web/public/index.html` only; backend, security and test gates
unchanged except for additive settings surface (D-015).
**What changed:** single 44px top bar (status pill, model badge, inline
telemetry); 3-column shell with collapsible panes; EMPTY FACTORY state with 3
prompt cards; conversational Chat panel (goal card, `✦` tool-summary lines,
collapsible thinking, markdown, inline approval gate) instead of a raw event
dump; Settings modal with a grouped sidebar and hotkey letters; custom segmented
pills and toggles (no native `select`/`checkbox`).
**Invariants preserved and re-asserted:** token from `#` only, wiped with
`replaceState`, never in web storage/cookie/query; SSE via `fetch` + bearer (no
`EventSource`); PageStage framed from the isolated origin with origin-checked
`postMessage`; markdown escaped before structure.
**Regression caught by the tests:** the rewrite dropped the PageStage
`postMessage` handler entirely (the page shim still called `parent.postMessage`,
so every page action would have been silently ignored). Restored with origin
check, exact-shape validation and value re-validation.

## D-015 - New persisted settings: agent, subagents, summary
**Date:** 2026-11-25
**Why:** the redesign exposes Agent settings, Subagent defaults and Tool Summary
controls. Rather than render dead UI, these became real persisted settings with
commands `factory.agent`, `factory.subagents`, `factory.summary`, surfaced in
`/api/settings`. `UI_SETTINGS_SCHEMA` gained pane visibility, `whileBusy` and
`enterToSend`.
**Note:** subagent defaults are DEFAULTS, not grants; the harness still enforces
its own caps and every spawn still carves out atomically.

## D-016 - Real run cancellation: POST /api/runs/:id/stop
**Date:** 2026-11-25
**Problem:** the Stop button only showed a toast. The runner accepted an
externally-supplied AbortSignal, but owned no per-run controller, so nothing
could cancel a run already in flight.
**Decision:** `DurableRunner` now keeps an `AbortController` per executing run
(composed with any caller signal) and exposes `stopRun(id)`. The route is a
normal protected mutation (Host + Origin + bearer), answers `202` when it
cancelled, `409` when the run is not executing, and `404` when unknown.
**Partial usage:** the abort flows into the provider; whatever tokens the call
reported are written by the normal ledger path with `aborted: true`, so a
stopped run is never billed as zero.
**Why 409 rather than 202 always:** a button that reports success when nothing
happened is worse than one that says "nothing to stop".
**Guard:** `apps/web/test/stop-run.test.ts` drives a provider that hangs until
aborted and asserts the run leaves `running`, ends `cancelled`, records the
partial token counts, and that auth/Origin checks still apply.

## D-017 - CSS lives in CSS: a `//` comment silenced the collapse rule
**Date:** 2026-11-25
**Problem:** tool-call rows stayed expanded after being "fixed" twice. The rule
`.sumline .detail { display: none }` was preceded by a JavaScript-style `//`
comment inside the `<style>` block; that is invalid CSS and the declaration was
discarded, so `display` stayed `inline`.
**Decision:** CSS uses block comments only, and a test now enforces it: no `//`
lines, no `${` template syntax, and balanced braces inside every stylesheet.
**Lesson:** a structural assertion on the presence of a CSS rule proves nothing
about whether the browser applied it. The verification that mattered was reading
`getComputedStyle` in the live page.
