# Session Handoff — Sketch

Everything needed to resume. Rewritten at the Phase 5 gate; the previous version described
Phase 3 and had gone four phases stale.

## Where to start reading

1. This file.
2. `.kiro/specs/sketch-engineering-os/tasks.md` — the plan and current checkbox state.
3. `.kiro/specs/sketch-engineering-os/requirements.md` and `design.md` — 28 requirements, the
   resolved-conflicts table, and the canonical contracts.
4. `tasks-executed.md` at the repo root — the project's living log (Rule 9 makes it the single
   source of truth for what is built). It now carries per-phase gate results and a decision log
   through Phase 5.
5. `NEED-TO-DO.md` — the working plan on top of the spec. Where it and the spec disagree, the spec
   wins and `NEED-TO-DO.md` is what gets fixed.

---

## IMMEDIATE NEXT ACTION

**Phase 8 is gated and committed. The working tree is clean. Start task 9.1 (versioned memory).**

**60 of 96 tasks complete.** Phases 1, 1.5, 2, 3, 4, 5, 6, 7 and 8 are done and gated.

Cold install (`node_modules`, `packages/core/dist` and both workspace `node_modules` deleted, then
`npm install && npm run build && npm run typecheck && npm test`): install 0, build 0, typecheck 0,
test 0 — **core 875 tests / 45 files, desktop 438 tests / 44 files**, offline, no API key, and
identical with `SKETCH_FAKE_PROVIDER=1` and unset.

The Phase 8 gate proof is `packages/core/test/phase8-gate.test.ts`: an overrun stops
deterministically, a cache hit avoids the second call, and the dashboard equals the log — the
last of those with `toBe`, not `toBeCloseTo`, because both sides are the same function over the
same bytes. Four guards were mutation-verified.

**The bug that gate found**, same green-for-the-wrong-reason shape as Phase 7's two: the pre-call
budget projection compared a ~1 500-token prompt estimate against calls that really cost 250 000
each, so a 600 000-token ceiling was overshot to 750 000 *while the guard reported success*. The
projection now uses the largest call observed in the run. The residual limitation is real and
documented rather than hidden: no pre-flight check can bound the FIRST call, so the guaranteed
bound is the ceiling plus one call.

**Two Phase 8 gaps worth knowing.** The budget is **opt-in** — a run with no `budget` is unbounded
and the desktop does not set one yet. And the prices are a table transcribed on `cost.PRICED_AT`;
what is proved is the arithmetic and that the date travels with every figure, not that any number
is currently right.

**Run `build` BEFORE `typecheck` on a cold tree.** The desktop typecheck resolves `@sketch/core`
through its emitted `.d.ts`, so with `packages/core/dist` deleted it fails with ~43 phantom errors
that have nothing to do with the code. Correct cold order: `install → build → typecheck → test`.

**Run the test suites per workspace** (`npm test -w @sketch/core`, `npm test -w @sketch/desktop`),
not `npx vitest run --root packages/<x>` from the repo root. Several guard tests read source files
relative to the process cwd, so the `--root` form reports ~58 phantom failures that vanish when run
in-workspace. This cost time in this session; it is not a regression.

The Phase 7 gate proof is `packages/core/test/phase7-gate.test.ts`. It proves the three ways this
product can lie about having finished — the model asserting success, the *suite* asserting success
while the app crashes on boot, and the run never finishing at all — against real `node` processes, a
real HTTP server that answers once and then dies, and a real MCP child that handshakes and then goes
silent. The first two share one policy on purpose, because testing them apart misses the bug that
actually shipped in 7.2. Five guards were mutation-verified; see the Phase 7 gate result in
`tasks-executed.md` for failing-test counts.

**Two bugs that gate found**, both worth knowing about because both were "green for the wrong
reason": `McpHost`'s timeouts were dropped when a `launchOverride` was supplied (a hang cost 20 s
instead of 500 ms while the hang assertion passed), and the MCP latch's `tool_denied` was logged
under the host's run id rather than the loop's, making it invisible to `forRun(runId)`.

**The tool layer now exists** (7.3), so the Phase 6 caveat is retired: the capability gate has real
descriptors behind it. What is still *not* proved is anything about the catalogued servers — they are
launch descriptions for third-party packages this project has **not audited**, pinned by version
only. The hang proof uses a server written here to hang.

The Phase 6 gate proof is `packages/core/test/phase6-gate.test.ts`, which runs install → enforce →
train as ONE chain over the shipped registry (the joins are where the failures live). Four guards
were mutation-verified: the digest check, the capability authorisation, the trainer's strict `>`,
and the optimizer's frontmatter strip.

The Phase 5 gate proof is two files:
`packages/core/test/phase5-gate.test.ts` (the fifty-file fixture, the smaller/more-relevant
measurement, the held-out eval comparison, generator determinism) and
`packages/desktop/src/phase5-gate.test.tsx` (a second fifty-file fixture driven through the real
`METHODS` table into real SVG, `<rect>` boxes counted against the generator's own node counts).
Seven guards were mutation-verified at this gate — see the Phase 5 gate result in
`tasks-executed.md` for the failing-test counts.

---

## Git state

```
c58dcf9  sketch: phase 8 task 8.5 - Phase 8 gate, plus a real overshoot the gate found   <- HEAD
3decd9c  sketch: phase 8 task 8.4 - Cost Dashboard, and three fake cost numbers deleted
3ab3a59  sketch: phase 8 tasks 8.2 and 8.3 - cost guard checked before the call, router, response cache
f89bc67  sketch: phase 8 task 8.1 - usage accounting, one price table, nine duplicates deleted
94aa773  sketch: phase 7 complete - gate green cold, tasks ticked, gate result and eight decisions logged
17c99ad  sketch: phase 7 task 7.5 - Phase 7 gate, plus two real bugs it found
a36fc39  sketch: phase 7 task 7.4 - Test Results panel, MCP Tools panel, and the hardcoded badge deleted
1105826  sketch: phase 7 task 7.3 - curated MCP tool layer, hang latch, and the run seam
3140073  sketch: phase 6 complete - gate green cold, gate result and eight decisions logged
d759311  sketch: phase 4 complete - self-hosted fonts remove Google egress, README zero-dollar recipe, gate green cold
```

The working tree is clean at HEAD. **Commit at every green point** — git was initialised 16 tasks
late in this project, and in that gap a cancelled sub-agent silently deleted the `sanitizePayload()`
call from `JsonlEventStore.emit`, writing API keys to disk unredacted for an unknown number of
commits. Only a cold rebuild caught it. Uncommitted work is unprotected work.

**One task per commit**, not one phase. The worst incident in this project was invisible precisely
because there was nothing to bisect.

---

## Phase status

| Phase | State |
|---|---|
| 1 — Engine baseline (1.1–1.15) | **DONE**, gate green cold |
| 1.5 — Tauri hardening (1.16, 1.17) | **DONE** — pulled forward from task 4.3 by user decision. Task 4.3 is marked SUPERSEDED in tasks.md |
| 2 — Transports + capture-as-eval (2.1–2.4) | **DONE**, then audited; four defects found and fixed |
| 3 — Code surface (3.1–3.7) | **DONE**, gate green cold |
| 4 — Settings, secrets, zero telemetry (4.1–4.5) | **DONE**, gate green cold. 4.3 superseded |
| 5 — Intelligent context + architecture generator (5.1–5.6) | **DONE**, gate green cold |
| 6 — Skills registry, capability scopes, real optimizer (6.1–6.7) | **DONE**, gate green cold |
| 7–12 | Not started |

Task counts: 96 total, **48 complete**.

---

## What is real vs. seam (do not overstate this to the user)

**Real:** the dependency-free core engine; event-sourced JSONL log with write-path redaction; the
seven-action agent loop with the plan gate enforced *in the engine*; shell-less verify runner; eval
harness; SkillOpt trainer with a strict `>` validation gate; stdio JSON-line CLI; `StdioSketchClient`
and `HttpSketchClient` with a Vite dev bridge; capture-as-eval that re-scores 1.0; Monaco editor with
one authoritative file cache; real Explorer, Terminal, Search, Git panel and per-hunk Diff Review;
Tauri hardening; provider settings with a key-free `providers.json` and a real connection test; OS
credential storage in Rust with a presence-only read surface; vendored fonts and a zero-egress guard;
persisted incremental repo graph; hybrid lexical+vector retrieval with RRF and rerank; offline-first
embeddings; budgeted context assembly that degrades detail before coverage; the seven-view
architecture generator and the Live Architecture panel.

**Seam / stub / absent, with the phase that makes each real:**
- `proposeEdit` in the trainer has only the offline scripted stub → **6.6**
- No tool layer at all; `tool` actions emit `tool_denied` → **7.3**
- `ask` terminates the run (no interactive channel); there is no `cancel` verb on the CLI wire
- **Retrieval is opt-in on the wire.** `run` assembles context only when given
  `contextBudgetTokens`, and the desktop does not pass it, so a default desktop run still sends no
  repository context. That is deliberate until the Phase 8 cost guard exists → **8.x**
- Ghost completions are real but **off by default** with no provider behind the client seam
- `SkillsMarketplace` (`MOCK_SKILLS`) → **6.4**
- `TaskLog` (`MOCK_TASKS`), `AgentTeamPanel` (fixture, and unreachable — no ActivityBar item
  dispatches `agents`) → **10.4**
- Cost dashboard absent; `StatusBar` hardcodes `$1.4025` → **8.4**
- **Requirement 17.4 is half-wired.** A key can be stored and its presence reported, and the engine
  can resolve a key from an injected `SecretStore` at call time — but there is deliberately **no read
  command**, so a stored key cannot reach a model call today. Only a just-typed key does. Closing it
  needs a spec decision about where the key crosses (Rust → sidecar stdin, or the sidecar reading the
  OS store itself)
- `src/memory/` and the legacy `verifier/` + `orchestrator/` state machine are pre-existing code
  **not wired into the new loop** → **9, 10**
- The eval harness has **no per-case context seam**: `runEvalSet` takes one `deps` for all cases, so
  the Phase 5 gate calls `runEval` per case instead

**Nothing has ever run against a real provider.** Every adapter is exercised only against
`FakeChatAdapter`, synthetic responses, and loopback stubs.

---

## Architecture decisions that must not be silently reversed

- `packages/core` has **zero runtime dependencies**. `test/deps.test.ts` enforces it and also
  enforces a `.js` extension on every relative import (NodeNext). It scans source for
  `from '<specifier>'` **literally**, which is why the stopword list in `hybrid-search.ts` is one
  space-separated string rather than an array of quoted words — a list containing `'from', 'into'`
  reads as a bare import and fails the build. Move the data, never the guard.
- The **event log is the single source of truth**. No subsystem gets a private log.
- The **plan gate lives in the engine**: `edit` asks `PlanWriter.hasPlan(runId)` — the filesystem,
  not an in-memory flag — inside `runTask`. The UI mirror is defence in depth only.
- **Strict `>` in the trainer.** A tie keeps the incumbent. No epsilon, no `>=`, no force-accept.
- **`AppState.files[path].content` is authoritative**; the Monaco model is a projection. Exactly two
  functions cross that boundary.
- **Unsupplied plan documents are omitted, not stubbed**, so `hasPlan` never sniffs file bodies.
- **`verify-pass` fails when nothing was verified.**
- Containment lives in **one** place: `src-tauri/src/command_policy.rs`, with `resolve_within` as the
  single primitive.
- **Core cannot persist a secret.** No persisting `SecretStore` implementation exists in core, and
  `MemorySecretStore` has no `node:fs` import. Real storage is Rust-side, with no file fallback.
- **The budget is enforced at one point, before the context text is joined.** Assembling first and
  discovering the overrun afterwards means the request already went out.
- **Retrieved context is separate from `projectContext`.** `AGENTS.md` is a standing instruction the
  user wrote; retrieved text is a retriever's guess for one query, and it is labelled as evidence to
  check rather than as instruction.
- **`termsMatched` is the first lexical sort key.** Coverage of the question beats repetition of one
  word, and without it a sentence-shaped prompt cannot find anything.
- **A view with no evidence gets a reason, not a diagram.** The API view is never inferred from
  import edges; the database view needs a schema file, not a string containing `CREATE TABLE`.
- **No HTML is built from diagram, terminal, search, git or model output.** Every panel renders those
  as text nodes; the CSP still carries `script-src 'unsafe-inline'`, so an injection is an execution.
- Two deliberate duplications, both documented in-code and **neither with an owning phase**:
  `providers/`'s legacy `ProviderAdapter` alongside the canonical `ChatAdapter`, and `verifier/`
  (legacy, `shell: true`) alongside `verify/` (new, `shell: false`). Propose a convergence task
  before touching either.

---

## Spec gaps found and recorded, not absorbed

- No `ask` EventKind — the loop records a question as `think` with an `action: "ask"` discriminator.
- No `skill_trained` EventKind — the trainer uses `think` with `component: "skillopt"`.
- No indexing / retrieval / embedding EventKinds — `repo-graph`, `hybrid-search`, `assembly`,
  `agent-loop`, `embedder` and `architecture` all reuse `context_loaded` / `context_assembled` /
  `diagram_updated` with a `component` discriminator in the payload.
- No CLI cancellation verb — `runTask` accepts an `AbortSignal` the wire cannot reach.

Do not add an EventKind without a spec update; use an existing kind with a payload discriminator and
report the gap.

---

## Open risks

1. **Retrieval reaches no shipped surface yet.** The engine can be handed context and the RPC can
   assemble it, but nothing in the desktop asks for it. Until Phase 8's guard, turning it on by
   default would spend the user's money on a default they never chose.
2. **The token estimate is `chars/4`**, stated as such in the payload. It is not a tokenizer count,
   and a provider's real count will differ. Anything that bills off this number is wrong.
3. **The hashing embedder is not semantic search** and says so. Retrieval quality currently rests on
   the lexical channel; a weak vector channel plus a strong lexical one is the honest shape of it.
4. **CSP is permissive**: `script-src 'unsafe-inline'`, `connect-src http: https:`. The egress guard
   fails the build if source starts using that latitude, but the policy itself would not stop it.
5. **Sidecar is 91 MB** (gitignored, rebuilt by `npm run build:sidecar`); `prd.md` targets a <100 MB
   installer.
6. **`cli.test.ts` uses `describe.skip`** when `dist/cli.js` is absent, so 20 tests vanish silently
   if someone tests without building.
7. **`os_credentials.rs` unit tests are unverified on this machine** — the module cannot be compiled
   standalone. Only source-level guards cover it.
8. **26.3 asks for signed releases** and nothing in this repository signs anything.
9. Two competing verify directories and two provider surfaces (see above).

---

## Environment quirks that cost time

- **Cold order is `install → build → typecheck → test`.** Typecheck before build fails on missing
  `@sketch/core` types.
- **`cargo test` cannot link here** — missing GNU `dlltool`. Run Rust tests with
  `rustc --test src/command_policy.rs -o <tmp>/policy` and execute. **Do not claim `cargo test`
  passes.**
- **The symlink containment test skips on Windows** without Developer Mode or elevation. It prints
  `SKIPPED …`. A skip is not a pass.
- **PowerShell:** `&&` is not a separator, use `;`. `` `n `` inside single quotes is a literal, not a
  newline — it corrupted `package.json` during a mutation run this session. Interleaved
  `Write-Output` piped through `Select-String` gets swallowed; run each check as its own invocation
  and read each exit code.
- **Sub-agent dispatch fails on large prompts.** Keep briefs compact, and after any failed dispatch
  run `git status` — partial work has landed before.
- **Task-tool quirks:** task IDs must be numeric dotted (`1.16`, not `1.5h`), and a child of an
  already-completed parent cannot be marked `in_progress`.
- Tests must pass with `SKETCH_FAKE_PROVIDER` **both set and unset**.

---

## Verification ritual before declaring anything done

```
npm run build        # must exit 0 — FIRST, the desktop typecheck needs core's .d.ts
npm run typecheck    # must exit 0
npm test             # must exit 0, offline, with no API key
```

Plus, for a phase gate: delete `node_modules` and `packages/core/dist`, then
`npm install && npm run build && npm run typecheck && npm test` from cold. The Phase 1 gate found a
real security regression that a warm tree hid.

**Green output alone is not evidence.** Break each guard, watch it fail, restore it, watch it pass,
and record both. Run the `sanitizePayload` mutation at **every** gate — that is the regression that
actually happened.
