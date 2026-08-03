# Tasks Executed

This file is the living log of all work completed on Sketch. Every task — whether done by a human or an AI agent — is recorded here. It gives any agent or developer instant context on what has been built, what decisions were made, and what is left.

---

## How to Use This File

- **AI agents**: Read this before starting any task. Do not repeat completed work.
- **Developers**: Update this after every meaningful change.
- **Format**: Add new entries at the top of the relevant milestone section.

---

## Status Legend

| Symbol | Meaning |
|---|---|
| ✅ | Done and verified |
| 🔄 | In progress |
| ⏳ | Planned, not started |
| ❌ | Cancelled |
| 🔁 | Needs rework |

A symbol may be qualified in words where the plain symbol would overstate — for example
"✅ built, insecure" or "🔁 partially built, fixtures". A row that says "seam" means the
interface exists and no real implementation does.

### Ledger time and counting conventions

- **Milestones 1–5 are immutable pre-spec snapshots.** They record what was true when the repository
  was first inventoried; their old paths, fixtures, and deferred items are historical evidence, not
  current status. The numbered Phase 1–13 sections below supersede them.
- **Phase gate sections are immutable checkpoint evidence.** A seam or test count in “Real vs seam
  after Phase N” describes that gate, even when a later phase implemented the seam.
- **Current progress counts actionable leaves only.** `tasks.md` has 96 checkbox rows: 83 leaves and
  13 phase-summary rows. Superseded leaf 4.3 is excluded, leaving 82 actionable leaves. After task
  13.5, 78 are complete and four—12.1 through 12.4—remain evidence-gated. The normalized raw row
  state is 90 complete, 4 evidence-gated, 1 superseded, and 1 open Phase 12 summary.
- Historical `/96` counters below are retained as legacy checkpoint text; they were manually
  maintained and are not the current counting convention.

---

## Milestone 0 — Project Foundation

| # | Task | Status | Notes |
|---|---|---|---|
| 0.1 | Write `what-we-are-building.md` | ✅ | Vision, target users, success criteria |
| 0.2 | Write `what-not-we-are-building.md` | ✅ | Scope boundaries, anti-features |
| 0.3 | Write `architecture.md` | ✅ | Full system architecture, data flow, tech stack |
| 0.4 | Write `prd.md` | ✅ | Product requirements, features, milestones |
| 0.5 | Write `trd.md` | ✅ | Technical requirements, interfaces, schemas |
| 0.6 | Write `tasks-executed.md` | ✅ | This file |
| 0.7 | Write and reconcile `rules.md` | ✅ | `rules.md` exists at the repo root. Task 13.1 reconciled Rules 4 and 6: `single` remains default; roles/consensus are permitted only through eval-gated `swarm`, which stays off without measured pass@k lift; credentials persist only in the OS store through a host outside core, with key transit limited to purpose-bound credential/invocation channels and no log/event/return exposure. |

---

## Milestone 1 — Provider Adapter Layer (historical pre-spec snapshot)

| # | Task | Status | Notes |
|---|---|---|---|
| 1.1 | Define `ProviderAdapter` interface | ✅ | `engine/src/providers/types.ts` |
| 1.2 | Implement OpenAI adapter | ✅ | `openai.ts` (complete + stream + cost) |
| 1.3 | Implement Anthropic adapter | ✅ | `anthropic.ts` (model IDs configurable) |
| 1.4 | Implement Google Gemini adapter | ✅ | `gemini.ts` |
| 1.5 | Implement Groq adapter | ✅ | `openai-compatible.ts` |
| 1.6 | Implement OpenRouter adapter | ✅ | `openai-compatible.ts` |
| 1.7 | Implement Ollama adapter | ✅ | `openai-compatible.ts`, no key needed |
| 1.8 | Implement generic OpenAI-compatible adapter | ✅ | Grok, Kimi, LM Studio, Custom |
| 1.9 | Credential storage via keytar | 🔁 | `credentials.ts` is a **seam only**. keytar was never installed and has been dropped (see Decision Log). `KeychainCredentialStore` takes an injected `KeytarLike` that nothing supplies; `MemoryCredentialStore` never persists. Real OS-keychain storage is spec task 4.2, on the Rust side |
| 1.10 | Provider settings UI | ⏳ | Deferred — spec task 4.1. `ModelSelector.tsx` renders a hardcoded `PROVIDERS` fixture and `state.providers` is never rendered |

**Tests**: 34 passing in `tests/providers.test.ts`. Typecheck clean.

**Path note**: every `engine/src/…` path in Milestones 1–5 is now `packages/core/src/…` — the
directory was relocated in Phase 1 (spec task 1.1).

---

## Milestone 2 — Context Engine (historical pre-spec snapshot)

| # | Task | Status | Notes |
|---|---|---|---|
| 2.1 | File tree walker (respects .gitignore) | ✅ | `walker.ts`, skips build dirs, 1MB cap |
| 2.2 | Dependency graph builder | ✅ | `dependency-graph.ts`, JS/TS + Python |
| 2.3 | File chunker (~512 tokens per chunk) | ✅ | `chunker.ts`, overlapping chunks |
| 2.4 | Embedding pipeline | ✅ | `embedder.ts`, provider + hash fallback |
| 2.5 | Vector store | ✅ | `vector-store.ts` (in-memory). sqlite-vec deferred behind same interface |
| 2.6 | Semantic search query pipeline | ✅ | `context-engine.ts` retrieve() |
| 2.7 | Incremental re-indexing on file change | ✅ | `reindexFile()` hash-based skip |
| 2.8 | Context window trimming | ✅ | char-budget trimming in retrieve() |

**Tests**: 26 passing in `tests/context.test.ts`. Typecheck clean.

**Note**: sqlite-vec persistence (2.5) deferred — in-memory store implements the
full `VectorStore` interface, so a persistent backend drops in without touching
callers. Revisit when repo scale demands cross-session persistence.

---

## Milestone 3 — Verify Loop (historical pre-spec snapshot)

| # | Task | Status | Notes |
|---|---|---|---|
| 3.1 | Project type detector | ✅ | `detector.ts` — node/python/rust/go from config files |
| 3.2 | Lint runner | ✅ | Via `Verifier` CHECK_ORDER, eslint/ruff detected |
| 3.3 | Type-check runner | ✅ | tsc/mypy via detected checks |
| 3.4 | Test runner | ✅ | npm test / pytest / cargo test / go test |
| 3.5 | Build runner | ✅ | npm build / cargo build / go build |
| 3.6 | Failure diagnosis prompt | ✅ | `Fixer` interface, AgentRunner reads error output |
| 3.7 | Retry loop with max attempts | ✅ | `verify-loop.ts`, default max: 3, injectable |
| 3.8 | Escalate to user on max retries | ✅ | Returns `exhausted` status → orchestrator yields `needs_human` |

**Tests**: 12 passing in `tests/verifier.test.ts`. Typecheck clean.

**Superseded for the new loop.** This is the legacy `verifier/` aggregate and it still uses
`shell: true`. The Phase 1 agent loop calls the new shell-less `verify/runner.ts` instead. Both
directories are live — `verifier/` for the legacy orchestrator, `verify/` for the loop — and they
converge when the legacy orchestrator retires. The nine-stage verification contract is spec
task 7.1.

**Architecture**: `Verifier` runs checks in order (lint→typecheck→test→build) with fail-fast.
`VerifyLoop` wraps Verifier with a Fixer + retry loop. DI everywhere: CommandRunner injectable,
DetectedProject injectable (for testing without real filesystem).

---

## Milestone 4 — Desktop App Shell (historical 2026-07-26 snapshot)

**This table is intentionally not current.** It records the baseline that Phases 1.5, 2, 3, 4, 6,
8, and 10 subsequently replaced; use those phase sections for current behavior.

**These rows were wrong until 2026-07-26.** They claimed nothing had been started while a
substantial Tauri + React application already existed on disk. Corrected below against the
code in `packages/desktop/`. "Fixtures" means the panel renders hardcoded arrays, not engine
data.

| # | Task | Status | Notes |
|---|---|---|---|
| 4.1 | Tauri 2 project scaffold | ✅ built, insecure | `src-tauri/` with `Cargo.toml`, `tauri.conf.json`, `main.rs`. **No `capabilities/` file exists**, so the fs and shell plugins are unusable from the webview; `fs.scope` is `["**"]`, `csp` is `null`, `decorations: false` with dead window controls, and `run_command` is an unrestricted `sh -c` / `cmd /C` passthrough. Hardening is spec task 4.3 |
| 4.2 | React + TypeScript frontend setup | ✅ built | React 19 + Vite 6, `tsc -b && vite build`, CSS modules. Vitest + jsdom wired; 24 desktop tests pass |
| 4.3 | Monaco Editor integration | ⏳ not started | Monaco is **not installed** (absent from `packages/desktop/package.json`). `EditorArea.tsx` is a static shell: a local `hasFileOpen` boolean, one hardcoded `App.tsx` tab, and fake syntax markup. Spec task 3.1 |
| 4.4 | File explorer panel | 🔁 partially built, fixtures | `FileExplorer.tsx` renders `MOCK_TREE`; file clicks do not open anything. Real `read_dir` wiring is spec task 3.4 |
| 4.5 | Chat panel | ✅ built on the seam | `AgentChat.tsx` sends through `useSketchClient().run(...)` and renders the engine's real `finalText`; failures name the transport. The live transport is `MockSketchClient` (see Phase 1) |
| 4.6 | Integrated terminal panel | 🔁 partially built, static | `panels/ide/Terminal.tsx` is static markup — no input, no execution, no output state. Spec task 3.4 |
| 4.7 | Git status + diff panel | 🔁 partially built, fixtures | `GitPanel.tsx` renders `MOCK_STAGED` / `MOCK_CHANGES` / `MOCK_UNTRACKED`; stage, unstage, and commit buttons are dead; no diff pane. Rust `git_status` and `git_diff` commands exist but nothing calls them. `StatusBar` hardcodes branch `main`. Spec task 3.3 |
| 4.8 | Cost dashboard panel | ⏳ not started | No cost panel exists. `StatusBar` hardcodes `$1.4025`; `state.totalCost` is never rendered. Spec task 8.4 |
| 4.9 | Task log panel | 🔁 partially built, fixtures | `TaskLog.tsx` renders `MOCK_TASKS` and its filter is non-functional. Spec task 10.4 |
| 4.10 | IPC bridge (frontend ↔ engine) | 🔁 partially built, dead | `src/ipc/bridge.ts` exists and is **imported by nothing**. It names 13 Tauri commands; `main.rs` registers 7. The six it calls that do not exist in Rust: `list_providers`, `set_api_key`, `remove_api_key`, `run_task`, `approve_plan`, `cancel_task`. The live frontend↔engine path is the `SketchClient` seam added in Phase 1, currently backed by the mock. Real transports are spec tasks 2.1 / 2.2; the missing Rust commands are 4.2 |

**Panels present beyond this milestone's list**: `AgentTimeline` and `AgentConsole` (real
`SketchEvent` rendering, Phase 1); `SkillsMarketplace` (`MOCK_SKILLS`); `SearchPanel`
(function-local `mockResults`); `AgentTeamPanel` (function-local `agents` fixture, and
**unreachable** — no ActivityBar button dispatches `agents`); `ModelSelector` (hardcoded
`PROVIDERS`). The `run` and `mcp` ActivityBar buttons open nothing, and the MCP badge is the
hardcoded `{ connected: 5, total: 8 }` in `AppState`.

---

## Milestone 5 — Orchestrator + Memory (historical pre-spec snapshot)

**This table is intentionally not current.** Phases 5, 7, 9, and 10 delivered context, tools,
versioned memory, and strategies after this inventory. Current limitations remain: automatic
live-run memory ingestion is absent, and the legacy orchestrator/verifier still coexists with the
canonical loop/verify path.

| # | Task | Status | Notes |
|---|---|---|---|
| 5.1 | Orchestrator state machine | ✅ | `orchestrator.ts` — plan→approve→execute→verify→fix→done/needs_human |
| 5.2 | Planner (task → steps) | ✅ | `planner.ts` — system prompt, JSON plan, single-step fallback |
| 5.3 | Agent runner (step → file diffs) | ✅ | `agent-runner.ts` — returns full file contents per edit |
| 5.4 | In-memory project memory | ✅ | `project-memory.ts` — decisions, standards, bugs, test records, conversations, digest() |
| 5.5 | Memory read at session start | ✅ | `digest()` feeds into planner context |
| 5.6 | Memory write after task complete | ✅ | Test records + conversation logged on completion |
| 5.7 | MCP tool integration (v1 set) | ⏳ | Deferred — filesystem/terminal/git/browser |

**Tests**: 23 passing in `tests/orchestrator.test.ts`, 2 passing in `tests/e2e.test.ts`. Typecheck clean.

**Architecture**: Full DI — Planner, AgentRunner, VerifyLoop, ContextProvider, ProjectMemory,
FileWriter all injectable. `DiskFileWriter` enforces `isWithin()` path guard. `extractJson()`
recovers JSON from fenced blocks, prose wrapping, and nested braces. `topoSort()` handles
dependency ordering with cycle detection. End-to-end test proves the complete pipeline composes
with real file I/O to a temp directory.

**Note**: SQLite-backed ProjectMemory (5.4) deferred — in-memory implementation covers the
full interface. MCP integration (5.7) deferred to a later milestone.

**Not wired into the Phase 1 loop.** This orchestrator state machine, `src/context/`, and
`src/memory/` are pre-existing code that the new `loop/agent.ts` does not call. The loop reuses
exactly two files from this tree — `orchestrator/file-writer.ts` and `orchestrator/json.ts`.
Re-integration is spec phases 5 (context), 9 (memory), and 10 (multi-agent).

---

## Phase 1 — Engine baseline (spec: `.kiro/specs/sketch-engineering-os`)

Spec tasks 1.1–1.15. Gate: `npm install && npm run build && npm test` at the repository root,
offline, no API key set.

| # | Task | Status | Notes |
|---|---|---|---|
| 1.1 | npm workspace root, both packages relocated | ✅ | `engine/` → `packages/core` (`@sketch/core`, `exports`/`types`/`bin`), `desktop/` → `packages/desktop`. Root `package.json` fans out `build`, `test`, `typecheck`, `lint`. `LICENSE` (Apache-2.0) and root `.gitignore` added |
| 1.2 | NodeNext + zero-dependency rule locked | ✅ | `test/deps.test.ts` asserts `packages/core/package.json` has no non-empty `dependencies` and that no file under `src/` imports a non-relative, non-`node:` specifier. Proven to fail when broken |
| 1.3 | Canonical contracts in `src/types.ts` | ✅ | Reproduced verbatim from the design. Legacy `VerifyResult` → `VerifySummary`, legacy orchestrator `RunResult` → `OrchestratorRunResult` |
| 1.4 | Dependency-free adapters + registry | ✅ | `openaiCompatible.ts` and `anthropicMessages.ts` over raw `fetch`; shared `redact()` on every thrown provider error; 11-entry `PROVIDER_CATALOG` with a `serverless` flag; module-global registry singleton deleted |
| 1.5 | `FakeChatAdapter` + offline switch | ✅ | `SKETCH_FAKE_PROVIDER=1` makes every resolution return the fake, whatever the config says. No `fetch` in the file |
| 1.6 | Skill and project-context loader | ✅ | Hand-rolled frontmatter parser, `SKILL.md`, `skill.json` folder layout, `AGENTS.md` / `CLAUDE.md`. Malformed frontmatter yields a diagnostic and skips the skill |
| 1.7 | Event store | ✅ | `JsonlEventStore` (append-only: only `mkdir` + `appendFile`, one file per UTC day, persisted `seq`) and `MemoryEventStore`. Sanitation is on the write path so no call site can leak a key |
| 1.8 | Verify runner | ✅ | `spawn` with `shell: false`, per-command timeout with a hard kill, byte-capped capture, always settles. Emits `verify_started` / `verify_result` |
| 1.9 | Plan artifact writer | ✅ | `.sketch/plan/<runId>/`, twelve canonical documents with an alias table, `hasPlan(runId)` as the gate predicate, runId allow-list against traversal |
| 1.10 | Agent loop | ✅ | `runTask(task, deps)`, seven actions, event-before-action, plan gate enforced in the engine, exactly one terminal `run_completed` / `run_failed` |
| 1.11 | Eval harness | ✅ | `runEval`, `runEvalSet`, `meanScore`; checks `verify-pass`, `contains`, `not-contains`; a throwing case scores 0 and the set continues |
| 1.12 | SkillOpt trainer + strict gate | ✅ | Train/validation split, accept only on strictly greater validation mean, no epsilon. `proposeEdit` is an **injected seam** with an offline scripted stub — the real optimizer is spec task 6.6 |
| 1.13 | stdio JSON-line CLI | ✅ | `ping`, `run`, `eval`, `parse-skill`, `capture-eval`. Protocol frames on stdout only, diagnostics on stderr, run progress streamed as `kind:"event"` frames correlated by `runId` |
| 1.14 | Desktop shell on the mock client | ✅ | `SketchClient` interface + `MockSketchClient` + one factory; `AgentTimeline` renders real `SketchEvent`s, `AgentConsole` pairs `llm_request`/`llm_response`. Dead `Sidebar.tsx`, `RightPanel.tsx`, `ChatPanel.tsx`, `AgentInput.tsx` deleted |
| 1.15 | Phase 1 gate | ✅ | See below |

**Gate result**: cold `npm install && npm run build && npm test` from a clean state exits 0.
**391 tests pass: 367 core across 19 files, 24 desktop across 6 files.** Verified both with
`SKETCH_FAKE_PROVIDER` unset and with it set to `1`, offline, with no API key in the
environment. Five guard mutations were each proven to fail the suite when broken: the
zero-dependency rule, the plan gate, the strict trainer gate, stdout purity, and secret
redaction.

**Defect found and fixed by the gate**: `JsonlEventStore.emit` had lost its
`sanitizePayload(...)` call — an unreverted leftover from one of the guard mutations — so event
payloads were reaching disk **unredacted**. The in-memory store still sanitized, so every
store-level unit test that used `MemoryEventStore` stayed green. Only the cold-state build and
full-suite run surfaced it. Sanitation is restored on the JSONL write path.

**Seams, not implementations** (Phase 1 shipped these deliberately unfinished):

- `MockSketchClient` is the only live client. `StdioSketchClient` and `HttpSketchClient` throw
  not-implemented from the factory (spec tasks 2.1, 2.2)
- `capture-eval` is registered on the CLI and answers `not_implemented` (spec task 2.3)
- `proposeEdit` has only the offline scripted stub (spec task 6.6)
- there is no tool layer at all; every `tool` action emits `tool_denied` (spec task 7.3)
- `ask` **terminates the run** not-ok, because there is no interactive channel
- `SecretStore` is an interface in core with no persisting implementation (spec task 4.2)
- `src/context/`, `src/memory/`, and the legacy `verifier/` + `orchestrator/` state machine are
  pre-existing code **not wired into the new loop** (spec phases 5, 9, 10). The new loop reuses
  only two files from that tree: `orchestrator/file-writer.ts` and `orchestrator/json.ts`

**Spec gaps found, recorded rather than absorbed**:

- **No `ask` EventKind.** The contract's `EventKind` union has no `ask`, so the loop records a
  question as `think` with an `action: "ask"` discriminator in the payload
- **No `skill_trained` EventKind.** The trainer emits `think` with `component: "skillopt"` for
  the same reason
- **No CLI cancellation verb.** The protocol has no `cancel` method, so a long run started over
  stdio can only be stopped by killing the process. `runTask` already accepts an `AbortSignal`;
  the wire has no way to trigger it

**Outstanding**: `README.md` does not exist. It carries the $0 stack recipe and belongs to spec
task 4.5.

---

## Phase 1.5 — Tauri security hardening (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 1.16 | Harden Tauri security surface | ✅ | `src-tauri/capabilities/default.json` created with scoped `core`/`fs`/`dialog`/`shell` permissions; non-null CSP added to `tauri.conf.json`; `run_command` in Rust hardened with path/command validation; `open_project_dialog` implemented via `tauri-plugin-dialog`; `TitleBar.tsx` window controls wired to minimize/maximize/close |
| 1.17 | Phase 1.5 gate | ✅ | Scoped permissions, non-null CSP, input validation, dialog plugin, and window controls verified by `security.test.ts` |

---

## Phase 2 — Real bridge and save-as-eval (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 2.1 | Bundle and register Tauri sidecar | ✅ | `StdioSketchClient` implemented in `packages/desktop/src/lib/stdioClient.ts` |
| 2.2 | Build Vite dev bridge | ✅ | `sketchBridgePlugin()` in `vite.config.ts` handling `POST /__sketch` and `GET /__sketch/events` (SSE); `HttpSketchClient` implemented in `httpClient.ts`; `factory.ts` updated |
| 2.3 | Implement capture-as-eval | ✅ | `captureRunAsEval` in `packages/core/src/evals/capture.ts` with secret key redaction; `capture-eval` method wired in RPC methods; "Save as Eval" button added to `AgentTimeline` |
| 2.4 | Phase 2 gate | ✅ | `bridge.test.ts` & `capture.test.ts` verify stdio, http, auto transport selection, eval capture re-scoring to 1.0, and secret key redaction |

---

## Phase 3 — Code surface (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 3.1 | Monaco with a single file-state owner | ✅ | `AppState.files[path].content` is authoritative; the Monaco model is a projection. Exactly two functions cross the boundary — `ModelRegistry.sync()` (the only `setValue` in shipped code) and one `onDidChangeContent`. `EditorArea`'s local `hasFileOpen` and fake gutter/syntax markup deleted |
| 3.2 | Diff review with per-hunk accept and reject | ✅ | Parser and subset applier in core (`packages/core/src/diff/hunks.ts`, 34 tests) — CRLF preserved, no-trailing-newline preserved, out-of-order and stale hunks refused by typed diagnostic. `DiffReview.tsx` collects verdicts and applies the accepted subset in one `applyHunks` call; reject-all never reaches the file layer at all |
| 3.3 | Real Git panel | ✅ | `packages/core/src/tools/git.ts` through the shell-less `runCommand`; porcelain parsing for renames, quoted and non-ASCII paths, detached HEAD and no upstream; real stage/unstage/commit; `git_status`/`git_diff` in Rust routed through `command_policy` with `--` terminating option parsing |
| 3.4 | Real Explorer, Terminal, Search, Debugger entry | ✅ | `MOCK_TREE` and `mockResults` gone; lazy `read_dir` expansion; terminal input through the existing scoped `run_command` with a visible argv confirmation and a ring-buffered output; search through the shell-less spawn with the query as an argv element; an honest "not built yet" Debugger panel |
| 3.5 | Optional debounced ghost completions | ✅ | Off by default (`DEFAULT_GHOST_COMPLETIONS_ENABLED = false`); bursts coalesced; in-flight request aborted and a late response discarded by request id; ghost text never enters `AppState.files` |
| 3.6 | Plan gate mirrored in the UI | ✅ | `DiffReview` disables accept and apply until `plan_written` is observed **for the selected `runId`**, states that reason on screen, and says the engine will verify the on-disk plan independently |
| 3.7 | Phase 3 gate | ✅ | Cold install (`node_modules` + `packages/core/dist` deleted): `npm install` 0, `npm run build` 0, `npm test` 0 — **core 441 tests / 22 files, desktop 287 tests / 31 files**, offline, no API key, suite run with `SKETCH_FAKE_PROVIDER=1` and unset. `packages/desktop/src/phase3-gate.test.tsx` walks one real chain: Explorer click → real disk read → Monaco/AppState → Ctrl+S write → real core `runTask` in review mode → real `edit_proposed` patch → hunk accept → real bytes on disk → real `git status`; the same test asserts both plan gates. Mutation-verified fail-then-pass: engine gate deleted (2 core loop tests + the gate test fail), UI mirror deleted (4 `DiffReview` tests + gate + guard test fail), applier pointed at new-side offsets (7 diff tests fail), `sanitizePayload` removed from the JSONL write path (3 store tests fail), a runtime dependency added to `packages/core` (`deps.test.ts` fails) |

**Real vs seam after Phase 3 (Code surface).** Real: Monaco with one file-state owner; core hunk parser and subset applier; the diff review surface driven only by real `edit_proposed` events; the Git panel and `tools/git.ts` against real repositories; Explorer, Terminal and Search on real data through the scoped commands; the engine plan gate reading the filesystem; the UI mirror of it. Seam or absent: the tool layer (`tool` actions still emit `tool_denied`, task 7.3); `proposeEdit` in the trainer (still the offline stub, task 6.6); `ask` terminates the run and there is no CLI cancellation verb; ghost completions have no provider behind them beyond the client seam; Monaco itself is doubled in tests because it cannot run in jsdom, so the *editor widget* is exercised through `ModelRegistry` rather than a real canvas. **Nothing in this project has ever run against a real model provider** — every run in this phase, including the gate, is `FakeChatAdapter`.

---

## Phase 4 — Settings, secrets, provable zero egress (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 4.1 | Provider Settings surface | ✅ | Full matrix from the registry (`providerMatrix()` returns `PROVIDER_CATALOG` itself, not a copy), custom endpoint with scheme/credential/query validation and the resolved URL shown before saving, per-provider connection test with five distinct failure codes. `~/.sketch/providers.json` persisted key-free and atomically (temp file + rename, so a failed write leaves the previous file byte-identical). `ModelSelector`'s hardcoded `PROVIDERS` fixture deleted; `state.providers` is now rendered |
| 4.2 | SecretStore seam and OS credential storage | ✅ | `SecretStore` stays in core with **no implementation that persists** — `MemorySecretStore` (no `node:fs` import, asserted) and `unavailableSecretStore` (every method throws, naming the missing host). Real storage in Rust: `secret_store.rs` (validation, error shape) + `os_credentials.rs` (Windows `CredWriteW`, macOS `SecKeychainAddGenericPassword`, Linux `secret-tool` with the secret on stdin, never in argv). `list_providers` / `set_api_key` / `remove_api_key` registered and granted in `capabilities/default.json`; keytar-shaped `KeychainCredentialStore` deleted |
| 4.3 | — | SUPERSEDED | Done early as Phase 1.5 (1.16/1.17). Row kept so `4.3` still resolves |
| 4.4 | Prove zero data collection and secret redaction | ✅ | `PRIVACY.md` names every outbound path, including the ones that were inconvenient. `privacy.test.ts` scans every `src` root in every package plus all three manifests and the lockfile, with a scanner that strips comments, decodes `\uXXXX`, rejoins split literals and splits camelCase — and which is itself under test against eight evasions and six innocent samples. A thrown provider error, and the connection-test verdict, are asserted key-free for an unshaped key (the only thing that can redact it is the configured-secrets list). Two live wire bugs found and fixed in passing: `is_dir` and `exit_code` crossed the IPC boundary in snake_case while `bridge.ts` read camelCase |
| 4.5 | Phase 4 gate — v1 complete | ✅ | See below |

### Phase 4 gate result

**Undeclared egress removed first.** `packages/desktop/index.html` still carried two
`<link rel="preconnect">` hints and a Google Fonts stylesheet, fetched on window load before any
user action, and PRIVACY.md §3 named it as a defect. A gate that claims no unexpected network
egress cannot ship over it. Inter and JetBrains Mono are now **vendored** as latin-subset variable
woff2 files (48 KB + 40 KB) under `packages/desktop/src/assets/fonts/` with their SIL Open Font
License texts beside them, declared in `src/styles/fonts.css`, which `global.css` imports. All
three tags are deleted. The production bundle emits both files under `/assets/` and the built CSS
references them from the app's own origin. PRIVACY.md §3 now describes what is true.

**Cold verification** (`node_modules`, both package `node_modules`, and `packages/core/dist`
deleted, then `npm install && npm run build && npm test`): install 0, build 0, test 0.
**Core 482 tests / 26 files, desktop 350 tests / 36 files** — 832 total. Typecheck 0. Offline, with
no API key in the environment, and identical with `SKETCH_FAKE_PROVIDER=1` and unset. Rust: 18
`command_policy` tests and 9 `secret_store` tests pass via `rustc --test` into
`src-tauri/target/rusttest/` (`cargo test` still cannot link here — missing GNU `dlltool` — and is
not claimed). `os_credentials.rs` cannot be compiled standalone (it imports a sibling module and,
on Windows, `windows-sys`), so its unit tests are **unverified on this machine**; its behaviour is
covered only by the source-level guards in `security.test.ts`.

**The four gate claims.**

1. *Keys live only in the OS credential store.* Core cannot persist a secret: no persisting
   implementation exists, and `MemorySecretStore` has no filesystem import. Rust has no file
   fallback (`fs::write`, `fs::read_to_string`, `File::create` all absent from both credential
   files), holds no key in application state, and exposes **no command that returns a key value** —
   not truncated, not a prefix, not a last-four. Asserted by `security.test.ts` and
   `secrets.store.test.ts`.
2. *`providers.json` is key-free.* Proved on the **bytes**, three times over — see the decision row
   on the layered guard — including through the RPC method the UI actually calls.
3. *The vocabulary scan is clean.* 26 core files / 36 desktop files green, with the scan covering
   `packages/core/src`, `packages/desktop/src`, `packages/desktop/src-tauri/src`, all three
   manifests and `package-lock.json`.
4. *A connection test against `http://localhost:11434/v1` succeeds with no internet.*
   `packages/core/test/phase4-gate.test.ts` runs the chain: configure a local provider from an
   object that carries a key → save → the bytes on disk carry no key and match no secret pattern →
   load back with no diagnostic → resolve the key from an injected store at call time → connection
   test against that literal URL returns `ok`. **Ollama is not installed on this machine, so the
   test stood up its own stub on 127.0.0.1:11434 answering `GET /v1/models` in Ollama's
   OpenAI-compatible shape.** It prints which of the two ran on every execution, and it defers to a
   real server if one already owns the port. The failure half of Requirement 17.7 is proved against
   a genuinely closed port: code `unreachable`, with the host named in the message.

**Mutation evidence** (each broken, watched fail, restored, watched pass):

| Mutation | Result |
|---|---|
| Re-add `<link rel="preconnect" href="https://fonts.googleapis.com">` to `index.html` | 3 of 10 `privacy.egress.test.ts` tests fail; restored → 10 pass |
| Leak `apiKey` through `sanitizeEntry`'s whitelist **and** remove `assertKeyFree` from the serializer | 3 `providerSettings.test.ts` tests fail — and the **bytes stayed clean**, because `serializeProviderSettings` re-projects five named fields. A third layer nobody had documented |
| Additionally leak `apiKey` through that projection | 6 tests fail across `providerSettings.test.ts` (5) and `phase4-gate.test.ts` (1), including the RPC-level save; restored → 25 pass |
| Add `POSTHOG_KEY` to `packages/core/src/index.ts` | `privacy.test.ts` fails with `packages/core/src/index.ts: posthog`; restored → 8 pass |
| Remove `sanitizePayload` from `JsonlEventStore.emit` | 3 `store.test.ts` tests fail on the on-disk bytes; restored → 24 pass. *(This is the regression that actually happened. Run it every gate.)* |

**Real vs seam after Phase 4 — read this before describing the feature to anyone.**

Real: the settings surface over the real registry; the key-free file with three independent guards;
the connection test, including against a local endpoint with no internet; OS credential storage on
all three platforms with a presence-only read surface; the vocabulary and key-leak guards; the
no-external-subresource guard; self-hosted fonts.

**Requirement 17.4 is HALF-WIRED, and the gate does not claim otherwise.** A key can be *stored*
(`set_api_key`) and its *presence* reported (`list_providers`), and the engine can resolve a key
from an injected `SecretStore` at invocation time (`resolveProviderConfig`, proved in the gate
test). But there is **no read command**, deliberately, so nothing in the desktop app can fetch a
stored key back into the window — which means **a stored key cannot reach a model call today**. The
only key that reaches a provider is one the user has just typed into the settings surface, for that
one request. Closing this needs a decision about *where* the key crosses: the honest options are a
Rust-side command that hands the key straight to the sidecar's stdin (never to the webview), or the
engine reading the OS store through the sidecar process rather than the window. Neither is specified
by Requirement 17.4 and neither should be improvised in a gate.

Also still open: `README.md` and `CONTRIBUTING.md` now exist (Requirement 26.3), but 26.3 also asks
for **signed releases**. The 12.3 path now assembles and GitHub-OIDC-attests release bytes, but no
real tag release has run and no native OS signing identity exists. The CSP remains permissive
(`script-src 'unsafe-inline'`, `connect-src http: https:`); the new egress guard fails the build if
a source file starts to use that latitude, but the policy itself would not stop it. And **nothing in
this project has ever run against a real hosted provider** — every run in this phase, including the
gate, is `FakeChatAdapter` or a loopback stub.

---

## Phase 5 — Intelligent context and the architecture generator (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 5.1 | Persist the repository graph | ✅ | `buildRepoGraph` → `.sketch/index/graph.json`, incremental by content hash, deletions removed from the graph, deterministic serialization (every array sorted, so the bytes are a pure function of the graph). `RepoGraphStats` counts `added` / `changed` / `reused` / `chunked` / `parsed` / `contentReads` at the call sites, so "incremental" is measured rather than asserted. `walkProject` gained the `.gitignore` coverage it never had |
| 5.2 | Hybrid search with reranking | ✅ | Lexical channel (ripgrep when present, a scanner over the graph's file list when not, both scoring through one counting function), vector channel, fused by RRF with `k = 60`, then a capped multiplicative rerank. `DEFAULT_SEARCH_CONFIG` is hybrid and `isVectorOnly` exists so a guard can assert the default never resolves to vector-only (18.2). Degradation is always reported, never silent |
| 5.3 | Embeddings offline | ✅ | `OfflineFirstEmbedder` defaults to the local hashing path with no network; provider embeddings are a documented, content-hash-cached fallback under `.sketch/index/embeddings/`. A degrade latches and is logged. `LOCAL_EMBEDDER_LIMITATIONS` says out loud that a hashing vectoriser is not semantic search — which is why 5.2's lexical channel carries retrieval quality |
| 5.4 | Context assembly under a token budget | ✅ | `assembleContext` combines memory, skills, top-k chunks and one-hop `imports` neighbours, degrading each item down a rung ladder (full body → signature + doc → signature → path) at ONE enforcement point, before the text is joined. `expandWithDependencies`' result is consumed rather than discarded (18.8). `context_assembled` carries the selected paths and the estimate, and says the estimate is `chars/4` rather than presenting it as a token count |
| 5.5 | Architecture generator | ✅ | Seven views derived from the persisted graph as Mermaid text, deterministic for a fixed graph, no network. A view with no evidence returns `available: false`, an empty diagram and a **reason** — the API view is not inferred from import edges and the database view needs a schema file, not a string containing `CREATE TABLE`. One `diagram_updated` per generation. Rendered by a Live Architecture panel whose diagrams are SVG **elements** with labels as text nodes: no mermaid dependency, no `innerHTML`, because every label is repository content |
| 5.6 | Phase 5 gate | ✅ | See below |

### Phase 5 gate result

**Two wiring gaps had to be closed before the gate could measure anything honestly.**

*The context layer fed nothing.* `assembleContext` had no caller: Phase 5 would have shipped a
retriever no run used. `RunTaskDeps.retrievedContext` is now a documented seam — a string, already
inside its budget — rendered as its own system message under `RETRIEVED_CONTEXT_HEADING` with a
caveat that it is evidence, not instruction, and kept separate from `AGENTS.md` on purpose. The
`run` RPC method assembles it when given `contextBudgetTokens`, and **not by default**: retrieval
adds tokens to every request, tokens are money, and the budget guard that would bound the spend is
Phase 8. No graph on disk means no retrieval, logged rather than silent.

*The lexical channel could not read a sentence.* It searched for the **whole query** as one fixed
string, and `assembleContext` is called with `task.prompt`. "Where is the payments retry budget
set?" appears verbatim in no source file, so the channel returned zero hits and hybrid retrieval
silently collapsed onto the weak hashing vector channel — Requirement 18.2's failure mode, reached
without anyone disabling a channel. Fixed with `queryTerms` (identifier-shaped runs, stopwords out,
capped at eight) searched one term at a time, ranked by **term coverage first**; plus per-term smart
case, because a prose term is lower-case and the constant it is hunting is spelled
`RETRY_BUDGET_MS`. A single-identifier query tokenises to itself, so that path is byte-for-byte what
it was.

**The fixture.** Ten domains × five files = fifty, generated by code so the whole thing is auditable
on one screen. Five domains carry a configuration fact that appears **nowhere else** (asserted, per
fact, against every file). `auth` sorts first of the ten, so the budget-truncated baseline reaches
it and answers its question correctly — that case is deliberately in the held-out split, because a
baseline that scored zero would prove only that the fixture was built to embarrass it.

**The baseline is the real thing:** concatenate every indexed file in graph order, with filename
headers, and stop at the same token budget. Nothing is shuffled to make it lose.

**"Held-out" means not tuned on.** There is no training in this phase, so it cannot mean anything
else. Two knobs existed — budget (1 500 tokens) and topK (6) — and both were chosen looking at the
two dev cases (`catalog`, `payments`) only. The requirement's assertion is made on the other three
(`auth`, `inventory`, `shipping`). The dev numbers are printed too, because hiding them would be the
easy way to cheat this.

**Measured, printed on every run:**

| Claim | Number |
|---|---|
| Whole repository | 7 226 tokens across 50 files |
| Targeted context | 832–1 492 tokens per query, always ≤ the 1 500 budget |
| Answering file present | targeted **5/5**, baseline **1/5** |
| Mean in-domain precision | targeted **0.668**, baseline **0.100** |
| Held-out eval score | targeted **1.000**, baseline **0.333** (`auth=1 inventory=0 shipping=0`) |
| Dev eval score | targeted **1.000**, baseline **0.000** |
| Views drawn, UI gate | **7/7** — system 10n/1e, api 30n/20e, database 2n/1e, component 49n/50e, dependency 49n/50e, folder-tree 62n/61e, call-graph 59n/40e |

**What the eval half does and does not prove.** `ContextFaithfulAdapter` is **not a model**. It
answers from the text it was handed and refuses when the fact is not there — a measuring instrument
for exactly one question: did the right evidence reach the prompt. It says nothing about whether a
real model reasons better on a smaller context, and a test asserts the instrument really does refuse
when handed an empty context and when handed another domain's files. **Nothing in this project has
ever run against a real provider.**

**The UI half.** `packages/desktop/src/phase5-gate.test.tsx` drives a second fifty-file fixture
through the real `METHODS` table in process → real graph → real generator → the real local parser
and layout → SVG in the document, and counts `<rect>` boxes against the node count the generator
reported. That fixture carries route registrations, a `.sql` schema and one cross-module import
precisely so no view has to be excused: all seven are available and all seven are drawn. It differs
from the core fixture on purpose (the core one measures retrieval and keeps one vocabulary per
domain); both file counts are asserted so neither copy drifts silently.

**Cold verification** (`node_modules` and `packages/core/dist` deleted, then
`npm install && npm run build && npm run typecheck && npm test`): install 0, build 0, typecheck 0,
test 0. **Core 631 tests / 33 files, desktop 379 tests / 39 files** — 1 010 total. Offline, no API
key, identical with `SKETCH_FAKE_PROVIDER=1` and unset. Note the **order**: on a cold tree the
desktop typecheck needs `@sketch/core`'s emitted `.d.ts`, so `build` must precede `typecheck` or it
fails with 43 phantom errors. The handoff's ritual is written `install && build && test`; typecheck
belongs after build, and this gate is where that bit.

**Mutation evidence** (each broken, watched fail, restored, watched pass):

| Mutation | Result |
|---|---|
| `DEFAULT_SEARCH_CONFIG.lexical = false` (ship vector-only) | 8 tests fail across `hybrid-search.test.ts` (6) and `phase5-gate.test.ts` (2), including the relevance measurement and the 18.6 log assertion |
| `queryTerms` returns `[query]` (no tokenisation) | 8 tests fail, including "finds the definition that a whole-sentence literal search cannot" and the gate's smaller-and-more-relevant test |
| Discard `oneHopNeighbours`' result (the 18.8 regression, restored) | 4 tests fail across `assembly.test.ts` (3) and the gate's 18.8 test |
| Drop the `retrievedContext` system message in the loop | 4 tests fail: 2 loop tests, and both halves of the gate that depend on the model seeing the context — the held-out score test among them |
| Remove `sanitizePayload` from `JsonlEventStore.emit` | 4 `store.test.ts` tests fail on the on-disk bytes. *(The regression that actually happened. Run it every gate.)* |
| Add `left-pad` to `packages/core/dependencies` | `deps.test.ts` fails naming the package |
| Draw a diagram for a view the generator called unavailable | 2 `LiveArchitecture.test.tsx` tests fail. Note: the **new** UI gate does not catch this, because its fixture makes all seven views available — the older panel test is what holds that line |

**Real vs seam after Phase 5.**

Real: the persisted incremental graph; hybrid retrieval that works on prose as well as identifiers;
offline embeddings with an honest description of their weakness; budgeted assembly that degrades
detail before coverage; the seven-view generator and its refusals; the Live Architecture panel; and
now a run path that can be handed retrieved context.

Seam or absent, unchanged by this phase: retrieval is **opt-in on the wire**, so a default desktop
run still sends no repository context — the desktop does not pass `contextBudgetTokens` yet, and
until the Phase 8 cost guard exists it should not. `src/memory/` is still unwired (Phase 9), so the
`memory` input to assembly is only ever what a caller passes. The eval harness has no per-case
context seam — the gate calls `runEval` once per case with its own deps, which is why it does not
use `runEvalSet`. And the legacy `verifier/` (`shell: true`) and legacy `ProviderAdapter` surfaces
are still there, still with no owning phase.

---

## Phase 6 — Skills registry and trainer (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 6.1 | Signed curated registry | ✅ | `registry/hash.ts` hashes the WHOLE skill directory — sorted relative paths, `sha256` per file's **bytes**, digest over `<path>\0<file-digest>\n` — with the algorithm written out so a third party can reproduce it, and a test that recomputes it by hand from `node:crypto`. Symlinks are not followed (a skill's digest must not cover bytes outside it). `registry.json` is validated field by field and **throws** rather than loading half of itself. `installSkill` verifies before it writes, has no `force`, and refuses naming the file that differs |
| 6.2 | Seed the registry | ✅ | Seven skills across all six packs Requirement 11.3 names, **written for this project rather than vendored** — the reasoning is in the decision log. Prose only: no seeded skill ships an executable, which is what makes the set installable before the tool layer exists. Pinned by `npm run pin:registry`, and `registry.seed.test.ts` fails when the pin goes stale rather than letting a user meet it as a tamper refusal |
| 6.3 | Enforce capability scopes | ✅ | Ten-capability vocabulary that **fails closed** on an unknown token, naming the typo. `ToolDispatcher.call` is the one authorisation point; both it and the prompt's tool list go through one private `#authorised`, and a test asserts there is exactly one grant consultation in the package. Wired into `runTask` via `deps.tools`: with it absent, the old refusal is unchanged. A denial is a RESULT, not a throw. Adversarial suite: a skill declaring nothing attempts six escalations, all denied, one `tool_denied` each, and it survives all six |
| 6.4 | The real Skills surface | ✅ | `MOCK_SKILLS` deleted, plus the two never-read fixtures in `AppState` (15 + 8 invented skills) and the `Skill` interface with four fields the engine's `Skill` does not have. Skill state now has one home: the engine. The install dialog shows the **content hash it will verify** and **every capability it will grant** in plain words before the user confirms, with the four that reach past the project called out separately. 14 tests against the real `METHODS` table and a real pinned registry |
| 6.5 | Open the marketplace behind the gate | ✅ | The shipped registry is `curated`, asserted. The gate an `open` registry must pass is built and tested: an entry needs an `approved` `ReviewRecord`, and a review that names a digest is **invalidated when the content changes after it** — approving bytes is the only approval that means anything. `reviewRefusalFor` is exported so a surface cannot invent a second policy |
| 6.6 | Real optimizer into `proposeEdit` | ✅ | `providerProposeEdit` rewrites the BODY and nothing else: the candidate is `{ ...incumbent, body }` and a proposed body's own frontmatter is stripped, so training cannot widen a grant. Strict parsing (no fenced block → no proposal). Bounded by a `TrainingBudget` checked **before** each request. Requirement 9.7 is satisfied *for training* only — the loop-wide guard is 8.2 and this says so |
| 6.7 | Phase 6 gate | ✅ | See below |

### Phase 6 gate result

**One chain, not three tests.** `packages/core/test/phase6-gate.test.ts` runs:
the shipped registry → recompute and verify the pinned digest → install into a real project →
load the installed skill back off disk → resolve **its** grant → a real `runTask` in which two
ungranted tool calls are denied and one granted call runs → train that same skill through the
strict gate → assert the winner's grant is still the installed one.

The joins are where the interesting failures live. A skill can install and be granted the wrong
thing; a grant can be right in the manifest and never reach the dispatcher; a trained skill can
quietly acquire capabilities its installed version never had. Each is invisible if the three
claims are tested apart.

**Measured, printed on every run:**

```
pinned commit-context v1.0.0: sha256:95bfb1c3aec9… over 1 file(s)
installed into <project>/.sketch/skills/commit-context, granted fs:read:project, git:read
run r0msap14rj-…: 2 denied (net:http, fs:write:home), 1 permitted (git:read), run ok
trained commit-context: held-out 0.000 → 1.000, grant unchanged (git:read, fs:read:project)
```

**Cold verification** (`node_modules` and `packages/core/dist` deleted, then
`npm install && npm run build && npm run typecheck && npm test`): install 0, build 0, typecheck 0,
test 0. **Core 711 tests / 38 files, desktop 393 tests / 40 files** — 1 104 total. Offline, no API
key, identical with `SKETCH_FAKE_PROVIDER=1` and unset.

**A shipped-app defect the sidecar guard caught mid-task.** `skills-catalog` first located the
seeded registry with `resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')`. That resolves
under vitest and from `dist/`, and points at nothing in the bundled sidecar — one file copied next
to the app binary, with no package layout to be relative to. `cli.test.ts`'s hazard guard failed
the build. There is now **no path-relative default**: the location comes from `params.registryDir`
or `SKETCH_REGISTRY_DIR`, and with neither the catalog reports that no registry is configured and
names the parameter. Pointing the app at the shipped copy belongs to packaging (12.1).

**Mutation evidence** (each broken, watched fail, restored, watched pass):

| Mutation | Result |
|---|---|
| Skip the digest check in `installSkill` (`if (false)`) | 3 tests fail: the gate's tamper test and both `registry.test.ts` refusal tests |
| `ToolDispatcher`'s authorisation returns `true` unconditionally | 10 tests fail across `capabilities.test.ts` (9, including all six adversarial escalations) and the gate chain |
| Trainer's `>` → `>=` | 5 tests fail: the gate's tie test and 4 in `trainer.test.ts`, including the empty-validation-split cases |
| Stop stripping frontmatter from a proposed body | 1 test fails: "CANNOT widen the skill's capabilities" — the smuggled `capabilities: net:http` survives into the artifact |

**Real vs seam after Phase 6.**

Real: the content-pinned registry and its refusal; seven seeded skills across six packs; the
capability vocabulary and the single enforcement point, wired into the loop; the Skills surface
over real data with the grant and the hash shown before consent; the review gate for an open
registry; the provider-backed optimizer behind the strict `>` gate; a reader for the captured
evals, which is the other half of the compounding loop.

**Not real, and this matters for how 6.3 is described.** There are **no tools yet**. 6.3 built the
enforcement POINT; 7.3 populates it. So the adversarial suite proves the gate denies an ungranted
call — it does not prove a hostile skill cannot reach the network, because nothing in this build can
reach the network on a skill's behalf at all. Saying otherwise would overstate it by a whole phase.

Also still open: the registry is a **content pin, not an author signature** — it proves what you install
matches the manifest, not who wrote the manifest. The 12.3 release path now provides repository/workflow
build provenance for assembled release bytes, but no real tag release has run and native OS signing is
still absent. Release provenance does not replace the registry's hash, capability, or digest-review gates.
The desktop does not yet point at the shipped registry (12.1). `skill-train` can reach a provider
and is the one documented exception to "nothing calls a provider", though every test of it runs on
the fake. And **nothing in this project has ever run against a real provider.**

---

## Phase 7 — Verification contract, live feedback, curated MCP (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 7.1 | The nine-stage verify policy | ✅ | `VERIFY_STAGES` fixed in contract order. `skipped` and `not-run` are deliberately different words — nothing ran either way, but one means "you configured nothing" and the other means "an earlier stage failed and we stopped". Fail-fast by default with `continueOnFailure` opt-in. A malformed `verify.yaml` does **not** fall back to detection: a project whose tests silently stopped running is the failure this prevents. Auto-detection only adds a stage the project already declared. `splitArgv` handles quotes and is deliberately **not** a shell — no expansion, no globbing, no pipes; `verify.json` is the escape hatch for exact argv. Wired via `deps.verifyPolicy`, not flattened into `task.verify`, because `runCommands` has no fail-fast |
| 7.2 | Live environment feedback | ✅ | Five verdicts, because `failed-to-start` and `runtime-error` point at completely different bugs. Output captured **before** the kill; the process **group** killed; the **port trap closed before spawn** — an already-occupied port would make the probe pass having tested nothing. Pattern-matched verdicts set `heuristic: true`. Probes are loopback-only. Folded into the `integration` stage via `policy.live` rather than added as a tenth stage: Requirement 4.3 fixes the nine, and a tenth would have meant editing the contract or hiding a check outside the `ok` rule |
| 7.3 | Curated isolated MCP registry | ✅ | Hand-rolled JSON-RPC 2.0 over stdio, no SDK, no dependency. 15 pinned catalog entries covering the 14 servers Requirement 22.2 names plus `git`; **no `@latest`**, asserted by test. `McpServer` spawns with `shell: false` and an argv. **The latch**: a hang times out, marks the server unavailable for the rest of the run, and kills the process group, so a second call is instant. Tool output is framed as untrusted DATA by `framePayload`, and the system prompt now states unconditionally that a tool result is never an instruction. Wired into `run` via `params.mcpServers`; a server whose capability the run's grant does not cover is **not started at all**, which is stronger than starting it and refusing its calls |
| 7.4 | Test Results panel, and the MCP badge deleted | ✅ | New `verify` RPC method: resolving the contract is free and is the default, `run: true` is a deliberate act — executing nine stages because a panel mounted would run the whole build and test suite as a side effect of navigation. The panel lists all nine stages configured or not, keeps `skipped` and `not-run` distinct in words as well as colour, and expands failures to real stderr with real exit codes. Deleted `AppState.mcpToolsStatus` (`{ connected: 5, total: 8 }`), the ActivityBar badge reading it, and the chat tooltip naming four servers this product does not have. Replaced by an `McpTools` panel reporting **`configured`, never `connected`** |
| 7.5 | Phase 7 gate | ✅ | See below |

### Phase 7 gate result

**The three ways this product can lie about having finished**, and each lies differently:

* **The model asserts success.** A loop that takes `done` at its word reports green while the
  suite is red.
* **The suite asserts success.** Nine passing stages describe a program that compiles and
  satisfies its unit tests, and a program can do both and crash on boot. This is the gap the
  whole of 7.2 exists to close.
* **The run never finishes.** A hang is not a wrong answer, it is worse than either.

`packages/core/test/phase7-gate.test.ts` proves all three against real processes: real `node`
commands with real exit codes, a real HTTP server on a real port that answers once and then dies,
and a real MCP child process that handshakes, advertises a tool, and never answers. The only
substituted collaborator is the model.

The first two run against a single policy carrying **both** a failing stage and a live check,
because testing them apart misses the case that actually shipped in 7.2 — the loop not passing
`root`, which made a live-only policy skip itself and report ok. There is also a **control**: the
same policy passes when the app stays up, without which the crash test proves only that something
failed.

**Two real bugs the gate found:**

1. `McpHost`'s `requestTimeoutMs` and `handshakeTimeoutMs` were spread only into the
   catalog-derived spec, so supplying a `launchOverride` silently dropped them and every request
   fell back to the 20-second default. A hang that should have cost 500 ms cost 20 s — **the
   assertion that a hang cannot wedge a run was passing for the wrong reason.** The deadlines are
   now host-wide defaults that an override may override but cannot erase.
2. The MCP client's latch `tool_denied` was emitted under the **host's** run id, not the loop's.
   `runTask` mints its own run id internally, so the event was present in the log and invisible to
   `forRun(runId)` — which is the only way a surface reads a run. `context.runId` is now threaded
   through the descriptor into `callTool`, the same per-call shape `ToolDispatcher.call` already
   uses for exactly this reason.

**Cold verification** (`node_modules`, `packages/core/dist` and both workspace `node_modules`
deleted, then `npm install && npm run build && npm run typecheck && npm test`): install 0, build 0,
typecheck 0, test 0. **Core 820 tests / 42 files, desktop 419 tests / 42 files** — 1 239 total.
Offline, no API key, identical with `SKETCH_FAKE_PROVIDER=1` and unset.

**Mutation evidence** (each broken, watched fail, restored, watched pass):

| Mutation | Result |
|---|---|
| `McpServer`'s timeout handler stops latching (`#writeOff` → a no-op stub) | 2 tests fail in `mcp.test.ts`: the hanging-server latch test and the status test (30 passed) |
| `verifyOk()` returns `true` whenever a policy is present | 2 gate tests fail: the red-suite claim and the crashing-app claim (5 passed) |
| `root` dropped from the loop's `runVerifyPolicy` call — the exact bug 7.2 found | 2 gate tests fail: the crashing-app claim and its control (5 passed) |
| `TestResults` resolves with `run: true` on mount | 2 tests fail in `TestResults.test.tsx` (10 passed) |
| `mcp-catalog` reports a `connected: 5` count | 1 test fails in `mcp.test.ts`: "configured, never connected" (37 passed) |

**A guard refined rather than weakened, twice.**

`cli.test.ts`'s sidecar hazard guard flagged `verify/policy.ts` for reading the *user's*
`package.json` during stack detection — a legitimate read that looked like the path-relative
resolution the guard exists to catch. Fixed with a `PROJECT_MANIFEST_READERS` allowlist plus a
`readsOnlyProjectManifests` structural check, and a self-test asserting all four cases, including
that an **undeclared** project-shaped read still fails and a declared **module-relative** read
still fails.

The new fixture guard in `McpTools.test.tsx` failed on this task's own comments — the ones
recording what was deleted and why. Same shape as the `['from', 'into']` stopword array that
`deps.test.ts` read as an import: the *prose* tripped it, not the code. The rule was never "this
string appears nowhere in the file", it is "this fixture is not part of what ships", so comments
are stripped and the code is scanned. `stripComments` has its own self-test proving it still
catches a real occurrence in a property position, in a string literal, and in JSX — a stripper that
removed too much would make every guard below it pass silently.

**Real vs seam after Phase 7.**

Real: the nine-stage contract with file precedence, per-stack detection and honest skipping; live
application feedback with five distinguishable verdicts; the MCP transport, catalog, host and hang
latch; the tool layer behind the single authorisation point; the Test Results and MCP Tools panels
over real engine data.

**Not real.** The curated MCP servers are **launch descriptions for third-party packages this
project has not audited.** What is pinned is the version, so what runs is reproducible and
reviewable — the content hashing `registry/` applies to skills cannot be applied here without
vendoring the servers, and that is an open gap, not a solved problem. The gate proves a server
which hangs cannot hurt a run using a server written here to hang; it proves nothing about the
catalogued ones. Auto-detection is a heuristic, and a project configuring nothing passes trivially
— which is why `verifiedAnything` exists and the gate asserts it is `false` for an empty contract.
And **nothing in this project has ever run against a real provider.**

---

## Phase 8 — Cost accounting, budget, routing, cache (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 8.1 | Usage accounting | ✅ | `cost/pricing.ts` is the ONE price table and carries `PRICED_AT`, so no surface can show money without the date it was true. **An unknown model costs `null`, never zero** — reporting unknown as `$0.00` is how a user finds out what a run cost from an invoice. Local runtimes get a real, *marked* zero, distinguishable from an absent one by construction. `cost/ledger.ts` is a **pure function of the event log**: no counter, no cached subtotal, nothing the loop keeps. Deleted three private `COSTS` tables and six `estimateCost` stubs that returned `0` — for Groq, OpenRouter, Grok, Kimi and a custom endpoint that read as FREE for a paid run. Added `ChatAdapter.model` and put `adapter` + `model` on both `llm_` events, because one provider serves models whose prices differ 16× |
| 8.2 | Cost guard and router | ✅ | Checked **before** the request, between the iteration increment and the call, against `ledgerFor(this run's events)` — so the number that stops a run is the number the dashboard shows. `onBreach` is **required with no default**: a user who cannot predict what happens when the money runs out does not have a budget. A `downgrade` with no cheaper adapter **stops** and records that it could not downgrade, rather than reporting one it did not perform. Router policies `never` / `after-plan` / `always`, declared by the caller because the loop cannot tell a hard turn from an easy one; `after-plan` switches when the plan actually lands, not on an iteration count |
| 8.3 | Response cache | ✅ | Keyed on provider, model, **sorted-key** options and role-tagged messages — `{a,b}` and `{b,a}` are the same request, `temperature: 0` and `1` are not. Sharded under `.sketch/cache/responses/<ab>/`. **Stores the response text and only the HASH of the request messages**: a prompt holds source and sometimes a pasted secret, and a cache is a place people forget exists. Atomic pid-suffixed writes, every field re-verified on read, expiry is a miss not an error, a failure is never cached, `clearResponseCache` is one call. Implemented as an adapter **decorator**, so the eval harness and trainer get it without the loop learning about caching |
| 8.4 | Cost Dashboard | ✅ | New `cost` RPC reads the JSONL log and calls `ledgerFor`. **No running total anywhere** — not in the method, the seam, the panel, or `AppState`. Deleted the `$1.4025` in `StatusBar`, the `$1.4025` in `TaskLog`, and `AppState.totalCost` (`12.45`). Neither figure is replaced with a live number: a second figure in the status bar would be a second source, so it is a *button*. Also removed three neighbouring `StatusBar` fixtures — a hardcoded provider name, `14.2k tokens`, and `0 errors / 2 warnings` with no diagnostics pipeline behind it. The panel shows unknown as unknown, a local-only run as a real `$0.00` *and says why*, the pricing date with a staleness warning, and links every row to its `eventId` |
| 8.5 | Phase 8 gate | ✅ | See below |

### Phase 8 gate result

**One chain over one project**, because each claim can hold alone and still be useless: a
budget can stop correctly while the number it stopped on differs from the dashboard's; a
cache can avoid a call and not say so; a dashboard can sum correctly over an in-memory log
and disagree with the JSONL bytes the app reads.

```
stopped after 2 call(s), 500000 of 600000 tokens, $2.0000
dashboard $2.0000 === log $2.0000
cache: 1 hit, 0 extra calls, $2.5000 avoided
```

**Reconciliation is `toBe`, not `toBeCloseTo`.** Both sides are the same function over the
same bytes, so a tolerance would hide a bug rather than allow for one. Requirement 20.8
says "reconcile exactly", and this is what exactly means — the total, the token counts, the
call count, the entry count, the summary sentence, and the per-run subtotal all match.

**The bug the gate found, and it was green-for-the-wrong-reason again.** The pre-flight
projection compared a ~1 500-token prompt estimate against calls that really cost 250 000
tokens each, so a 600 000-token ceiling was overshot to **750 000 while the guard reported
success**. `checkBudget` now projects the next call using the **largest call observed in
this run**, falling back to the prompt estimate only before anything has been observed.
Largest rather than mean, because a ceiling that holds on average is not a ceiling. The
ceiling now holds outright.

**The residual limitation is stated, not glossed.** No pre-flight check can guarantee a
ceiling is never crossed, because the first call's real cost is unknowable before making
it. So the guaranteed bound is *the ceiling plus one call*, `describeBudget` says so in
words, and the gate asserts both the honest bound and the tighter one that now holds.

**Section 3 asserts what the guard CANNOT do.** A currency-only budget provably fails to
bound an unpriced model — the spend it can see is zero — and a token budget on the same
model provably succeeds. That is why both ceilings exist, and it is asserted rather than
left as a footnote.

**Cold verification** (`node_modules`, `packages/core/dist` and both workspace
`node_modules` deleted, then `npm install && npm run build && npm run typecheck && npm
test`): install 0, build 0, typecheck 0, test 0. **Core 875 tests / 45 files, desktop 438
tests / 44 files** — 1 313 total. Offline, no API key, identical with
`SKETCH_FAKE_PROVIDER=1` and unset.

**Mutation evidence** (each broken, watched fail, restored, watched pass):

| Mutation | Result |
|---|---|
| Budget check moved after the call (`false &&`) | 6 tests fail in `budget.test.ts`, including all four guard tests and both downgrade tests (21 passed) |
| Options dropped from the response-cache key | 1 test fails: "treats a different OPTION as a different request" (26 passed) |
| `cost` RPC adds `0.01` to the total | 1 gate test fails: the reconciliation equality (4 passed) |
| Every cache hit re-calls the adapter (`false &&`) | 4 tests fail across the gate and `budget.test.ts` (28 passed) |

**A guard mechanism extracted rather than duplicated.** The fixture guards for `$1.4025`
and `14.2k tokens` failed on this task's own comments — the second time that has happened,
after task 7.4's `mcpToolsStatus`. The comment stripper now lives once in
`packages/desktop/src/testing/source.ts` with its own self-test, instead of a second copy
in a second test file: a copied guard mechanism drifts, and the drift is **silent**,
because a stripper that removed too much would make every assertion built on it pass for
no reason. One `GitPanel` test also had to change — its "the rest of the bar is there"
probe was itself the deleted `Anthropic` fixture. The guarantee it tests is unchanged and
it now additionally asserts that no provider is claimed when none is configured.

**Real vs seam after Phase 8.**

Real: the price table with its date and staleness flag; the ledger as a pure function of
the log; the pre-call budget guard with a learned projection; the two deterministic breach
outcomes; the model router with three declared policies; the content-addressed response
cache on disk; the `cost` RPC and the dashboard that reconciles with it exactly.

**Not real.** The prices are a table transcribed from vendor pages on `PRICED_AT` and they
*will* go stale — what is proved is the arithmetic over the table and that the date travels
with every figure, not that any number is currently correct. The budget is **opt-in**: a
run with no `budget` is unbounded, and that is not pretended to be a safe default — the
desktop does not yet set one, which is a gap. OpenRouter returns a real per-request cost in
its own response body that this build ignores in favour of the static table. And **nothing
in this project has ever spent real money, because nothing has ever run against a real
provider.**

---

## Phase 9 — Versioned memory with hygiene (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 9.1 | Versioned memory store | ✅ | Nine kinds, closed union, fails closed on a typo. Every row carries `validFrom`/`validTo`. **Superseding APPENDS a close op** rather than editing the add, so the log is append-only by construction — asserted at the source level (no `writeFile`, no `truncate`, no `rename`) and on the bytes (the original add still reads `"validTo":null` after a supersede). One `applyOps` fold is shared by the JSONL and in-memory stores, so the test double Requirement 21.7 asks for exercises the real supersede semantics rather than a simplified copy. `legacyProjectMemory` bridges the original `ProjectMemory` surface onto it, so the legacy orchestrator's four members keep working and gain versioning underneath without learning about it |
| 9.2 | Hygiene | ✅ | `remember` supersedes a same-key predecessor with a **recorded reason** and emits `memory_superseded`; a default reason is supplied because 21.3 wants one and empty is not a reason. Expiry takes per-kind ages with **no defaults** — a default would silently delete a project's architecture notes after a number this code chose. `source: 'user'` is never auto-expired or auto-superseded. `lintMemory` **reports and changes nothing**, asserted by comparing the store byte-for-byte before and after; findings carry `certain` / `likely` / `possible` rather than a verdict |
| 9.3 | Reranked retrieval | ✅ | Reuses the Phase 5 primitives instead of adding a second retriever: `queryTerms`, `countMatches`, `smartCase`, and the RRF arithmetic. Extracted `fuseRankedIds` so the fusion has **one** implementation over ids, rather than forcing memory rows through `RankedItem`'s `path` / `chunkIndex` / line fields and inventing file coordinates for something that was never in a file. Retracted entries are **excluded by default** (21.6) and labelled `RETRACTED` when history is asked for. Recency is a bounded prior capped *below* the rerank boost, not a sort. `memory_retrieved` carries ids and scores, never the remembered text |
| 9.4 | Memory panel | ✅ | Four RPC methods; reading is free, writing and retracting are user actions, and `memory-supersede` **requires a reason on the wire** — an optional one would let the panel close an entry silently. The panel shows retracted rows greyed and labelled rather than hiding them: retrieval keeps withdrawn facts out of a prompt, but "why does the agent think we use REST" is answered by seeing the closed row and its reason. The control says **Retract, not Delete**, and the dialog says the row is kept with its window closed so the correction is auditable. Lint findings render with their confidence and nothing is applied |
| 9.5 | Phase 9 gate | ✅ | See below |

### Phase 9 gate result

**The requirement is unusually specific** — "insert a decision, insert a contradicting
decision, and prove a related query returns the newer while the older is marked
superseded" — so the gate runs exactly that, as one chain over a real append-only log:

```
march: "Sessions are stored in Redis, because we…" valid from 2026-03-01
june:  "Sessions are stored in Postgres, because…" superseded the march decision
log: 2 add(s) + 1 close(s), first add still open on disk
query "where do we keep sessions for auth" → 1 hit (Postgres), 1 retracted excluded
events: 1 memory_superseded (run-june), 1 memory_retrieved, no text on either
digest: contains Postgres, excludes the Redis decision
history: 2 hits, the older rendered as RETRACTED with its reason
rpc: memory-list shows 2 (1 current); memory-search returns the newer only
```

**The query is deliberately RELATED, not the entry's own words.** "Where do we keep
sessions for auth" shares vocabulary with both decisions without quoting either, so what
is proved is retrieval rather than string matching.

**The join that matters most is the digest.** A store can supersede perfectly and still
leak the retracted fact into the prompt, at which point the model is told both things and
the user cannot see why the output is confused. The gate asserts the digest contains the
newer decision and not the older, and the mutation table below shows that assertion is
load-bearing.

**The opposite requirement also holds, and both are needed.** Hidden from the prompt,
VISIBLE to the user: `includeSuperseded` returns both and renders the older as `RETRACTED`
with its reason, and `memory-list` offers both rows to the panel. Memory a user cannot
audit is memory they cannot trust.

**Section 3 asserts the LIMIT as well as the capability.** Superseding is automatic on
kind AND key, because that is an explicit statement of identity by whoever wrote the rows.
It is deliberately **not** automatic from prose: two contradicting decisions with no shared
key both stay live, and the lint pass raises a question with a confidence. That is a design
choice, not an unfinished feature — deciding by keyword overlap which of two decisions is
wrong would eventually discard the correct one, and a memory store that silently deletes
true things cannot be debugged from outside.

**Cold verification** (`node_modules`, `packages/core/dist` and both workspace
`node_modules` deleted, then `npm install && npm run build && npm run typecheck && npm
test`): install 0, build 0, typecheck 0, test 0. **Core 927 tests / 47 files, desktop 453
tests / 45 files** — 1 380 total. Offline, no API key, identical with
`SKETCH_FAKE_PROVIDER=1` and unset.

**One flake observed and named rather than papered over.** `verify-live.test.ts`'s "starts,
answers its probe, survives the settle window" failed once on the cold run and passed on
every re-run, including the second cold pass. It stands up a real HTTP server on a real
port, so it is timing-sensitive under parallel load; it is not related to Phase 9 and it is
not a pass being claimed for a failure. If it recurs, the fix is a longer readiness window,
not a weaker assertion.

**Mutation evidence** (each broken, watched fail, restored, watched pass):

| Mutation | Result |
|---|---|
| `supersede` rewrites the add op instead of appending a close | 3 tests fail in `memory.test.ts`, including both append-only assertions and the on-disk round-trip (44 passed) |
| Retrieval stops excluding retracted entries | 1 test fails: "EXCLUDES a retracted entry by default" (46 passed) |
| `remember` never supersedes a same-key predecessor | 7 tests fail across `phase9-gate.test.ts` (3) and `memory.test.ts` (4), including the legacy bridge's `setStandard` (45 passed) |
| `memoryDigest` reads all entries rather than current ones | 2 tests fail: the gate's digest assertion and the digest unit test — the retracted decision reaches the prompt (50 passed) |

**Two real bugs found while writing the tests.** `recencyBoost` handed an infinitely OLD
entry the MAXIMUM recency boost, because one guard caught both non-finite signs — written
for future-dated entries, it also matched `+Infinity`. And the literal `'import'` as a
`MemorySource` value read to the zero-dependency guard as the `import` keyword followed by
a quote; the value is now spelled `imported`. That is the **third** occurrence of that
shape, after `deps.test.ts`'s stopword array and task 7.4's fixture guard, and each time
the data moved rather than the guard being widened.

**Real vs seam after Phase 9.**

Real: the versioned store on disk with append-only superseding; the nine kinds; hygiene
with recorded reasons, per-kind expiry and the reporting lint pass; retrieval over the
shared Phase 5 primitives with a bounded recency prior; the four RPC methods; the Memory
panel including retraction with a required reason.

**Not real.** Memory does **not reach a live agent run by default**. `memoryDigest` fills
the `assembleContext({ memory })` seam that has existed since Phase 5, and the `run` RPC
does not pass it — the same shape as retrieval being opt-in behind `contextBudgetTokens`.
Turning it on is a one-line change and a deliberate decision about tokens, not an
oversight. Nothing writes memory during a run either: the loop records no decisions, so the
store fills only from the panel or the legacy orchestrator. Contradiction detection from
prose is reporting only, by design. There are **no embeddings for memory rows**, so
retrieval is text and metadata, and `channels` says so. And **nothing in this project has
ever run against a real provider.**

---

## Phase 10 — Eval-gated multi-agent (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 10.1 | Dispatcher, single stays the default | ✅ | `single`, `plan-then-code`, `swarm`, and `DEFAULT_STRATEGY` is `single`. The `run` RPC with no `strategy` still calls `runTask` directly — byte for byte the pre-Phase-10 path, no dispatcher event, no extra cost — so a caller that never heard of strategies pays nothing for their existence. `strategy_selected` is emitted with `component: 'dispatcher'` and **never** the cost router's `policy` key, under its OWN dispatch slice rather than a sub-run's, because `budget.test.ts` finds the router's two emitters with a bare `.find(kind === 'strategy_selected')`. Which strategy succeeded is recorded on a `phase: 'outcome'` event, since `EventKind` is a closed spec-level contract and inventing a kind would be a spec change. Escalation is off unless asked for and `ESCALATABLE_REASONS` is the load-bearing list: `verify_failed`, `max_iterations`, `consensus_failed`, `merge_conflict`, `plan_missing`, `no_verifiable_role` may escalate; `budget`, `aborted`, `provider_error`, `internal_error`, `awaiting_human_input` may not |
| 10.2 | Thirteen roles as constrained sub-runs | ✅ | `RoleDefinition.signal` is a **required** field, so Requirement 24.6 is enforced by the type system. It is a union of three kinds because thirteen unique verify stages over a nine-stage contract is arithmetically impossible: `verify-stage` for roles that write or measure code, `plan-artifact` for the CEO and Planner, `citations` for the findings roles. Three narrowings per sub-run, all structural: the prompt is `rolePrompt(role, …)`, the policy is narrowed to the one stage that grades it (Backend does not pay for Frontend's build), and the grant is `roleCapabilities` — the role's list **intersected** with the run's, never unioned. `reviewEdits` is forced on for every role including the editing ones, so "this role does not write files" is true rather than instructed |
| 10.3 | Deterministic merge and consensus | ✅ | Union of the non-conflicting edits; **two proposals for one path is a conflict, full stop** — whether from two roles or one role twice — and it produces a follow-up task with the paths, the reason and the sub-run ids on it. File granularity is not a shortcut: the action protocol emits whole-file replacements (`unifiedDiff` deliberately makes one hunk so a reviewer cannot accept a grouping the model never proposed), so anything finer would be the guess 24.7 forbids. Staleness is free and not reimplemented — the proposal's diff is replayed through `applyHunks` against the file as it is NOW, and a `context-mismatch` is a refusal with a diagnostic. `consensus` returns **null** outside `swarm` rather than a permissive verdict, and it **gates the merge**: a blocking role's objection arrives before the bytes do |
| 10.4 | AI Team and Tasks panels | ✅ | Three disagreeing role lists deleted: this panel's four function-local fixtures with a hardcoded `1 working`, `AppState.agentTeam`'s twelve entries (a second status vocabulary, `a5` asserted `busy`, Deployment missing, read by nothing), and `AppState.tasks` / `TaskEntry` (a fourth vocabulary, never populated, never read). The `agents` panel is **reachable at last** — it has been in the `ideActivePanel` union and handled in `SidePanel` since the first commit, but no ActivityBar button dispatched it, which is how four fixtures survived in a panel nobody could open. `TaskLog`'s filter now really filters: it was declared, bound to state, and never applied. Rows are `projectRuns(events)`, a projection of the log, so task state has one home for the same reason cost does |
| 10.5 | Phase 10 gate | ✅ | See below |

### Phase 10 gate result

**The gate's job is not "does the swarm run".** A swarm that runs is easy. The failure this
phase exists to prevent is a swarm that runs, reports success, and proved nothing — which is
indistinguishable from a working one unless you look at the verification. So §2, §3 and §5
each drive one of the three ways that happens.

```
[§1] default=single; explicit single → 1 sub-run, ladder recorded under gate-single
[§2] with only unit+build configured: 8 of 13 roles verifiable, 5 skipped —
     Architect, Database, Performance, Deployment, Documentation
[§3] merged 1 file(s); 1 conflict(s) → 1 follow-up task(s);
     shared.ts still reads "export const v = 1"
[§4] swarm: 4 sub-runs, 4 roles verified, 2 files merged, 12 model calls
[§5] single pass@2=0.500, pass@1=0.500, distribution=[2, 0], 4 attempts
[§5] verdict: OFF — swarm stays off: pass@2 did not rise (0.500 to 0.500);
     a tie retains the cheaper default
[§7] 3 concurrent runs, 26 events, 3 disjoint complete slices
[§8] single-agent remains the default. swarm is OFF.
```

**§2 proves the hazard is real before proving it is closed.** It runs a real `runTask` with
no verification configured, asserts `ok: true` and `verify: []` — Requirement 5.8 working
exactly as specified — and then shows the grader refusing that same run. That is why a role
cannot be graded by `run.ok`, and why there are **two** independent refusals: `partitionRoles`
before a token is spent, and `gradeRole` again afterwards. The swarm asked for one role whose
stage the project does not configure and made **zero model calls**.

**§3 asserts the bytes, not the report.** Two roles proposed `shared.ts` from the same base
and a third file was uncontested. After the merge, `own.ts` holds the new value and
`shared.ts` holds **neither 2 nor 3 — the original 1**, with a follow-up task carrying both
sub-run ids. A merge that "resolved" this would compile and mean what neither role proposed.

**§5 is the measurement, and it says no.** pass@k over the same two internal-suite cases,
`k = 2`, once under each strategy, both reports fed to `shouldDefaultToSwarm`. The verdict is
**OFF**. That is the honest state of this repository and it is asserted rather than a lift
being claimed. §6 then proves the gate is not merely stuck shut: given a genuinely better
report it opens and names what the improvement cost, and it stays shut on a tie, on a
regression, on a bigger `k` dressed as lift, and on two reports that scored different cases.

**Both pass@k numbers are always reported.** `passAtK` alone is a purchase rather than a
result — `k = 10` makes almost anything look capable if you will pay ten times — so
`passAt1` and the per-case `distribution` are populated on every report and there is no
option to emit only the flattering one (Requirement 25.3).

**§7 tests ground nothing had tested.** `runTask` has no module-level mutable state, but
before Phase 10 nothing proved two runs sharing one `EventStore` could be read apart
afterwards, and a swarm is N runs. Three concurrent runs, three disjoint complete slices, 26
events, no fourth slice.

**Cold verification**: `npm run build` 0, `npm run typecheck` 0, both suites 0. **Core 1 012
tests / 49 files, desktop 478 tests / 47 files** — 1 490 total. Offline, no API key,
identical with `SKETCH_FAKE_PROVIDER=1` and unset.

**Mutation evidence** (each broken, watched fail, restored, watched pass):

| Mutation | Result |
|---|---|
| `gradeRole` stops refusing a `verify-stage` role with zero verify results | 1 test fails in `strategy.test.ts`: "FAILS a verify-stage role that verified nothing, even when the run reported ok" (67 passed) |
| The merge treats two proposals for one path as mergeable | 2 tests fail: the conflict case and the same-role-twice case (66 passed) |
| `liftOver` uses `>=` instead of strict `>` | 1 test fails: "is strict: a tie retains the cheaper default" (67 passed) |
| The dispatcher runs the requested roles instead of the verifiable ones | 1 test fails in `phase10-gate.test.ts` §2 — the skipped role really ran (16 passed) |
| Consensus stops gating the merge | 1 test fails in `phase10-gate.test.ts` §4 — the Security objection arrived after the bytes (16 passed) |
| `TaskLog`'s filter is applied with a constant instead of the state | 1 test fails: "renders a row per streamed run and filters for real" (11 passed) |
| `AgentTeamPanel` stops discriminating `component: 'dispatcher'` | 1 test fails after being strengthened — see below (12 passed) |

**A weak test caught during the mutation pass, and strengthened rather than accepted.** The
router-discrimination test originally asserted only that the string `after-plan` was absent
from the panel — and `after-plan` lives in the router's `policy` key, which the panel never
renders. So it **passed with the guard deleted**. It now counts the rendered lines (three
dispatcher events in, three lines out) and asserts none rendered as the fallback phase. This
is the case the "green output is not evidence" rule exists for: the mutation pass is what
found it, not the original green run.

**A real defect the gate found.** `attemptSwarm`'s `no_verifiable_role` early return dropped
the skipped-roles follow-up, so a swarm that skipped **every** role left nothing behind at
all — the one case where the follow-up task is the entire output. Fixed and asserted.

**A design flaw corrected before it shipped.** The first draft of `roles.ts` claimed every
role had a pairwise-unique verification signal and bought that claim by grading the Planner
with `typecheck` and the Research role with `lint` — stages that never look at a document.
Thirteen roles over nine stages cannot be pairwise-unique, so the claim was arithmetically
impossible as well as dishonest. `RoleSignal` is now a union of three kinds and each role is
graded by something that actually sees its output; a test asserts the uniqueness claim is
**gone**, and that Backend and Testing correctly share `unit`.

**Fourth occurrence of the dependency-guard shape.** A `strategy-catalog` note read "…comes
from " immediately before a quoted string, which `test/deps.test.ts` parses as a bare import.
The wording moved. The guard did not.

**Real vs seam after Phase 10.**

Real: the dispatcher and its ladder; the thirteen roles with a required signal each and the
per-role policy, prompt and capability narrowing; grading by verify stage, plan artifact or
resolved citations; the deterministic merge with staleness detection and conflict-to-task;
consensus with two blocking roles; pass@k with the distribution and the strict lift gate; the
`strategy` and `escalate` parameters across all three transports; the AI Team and Tasks
panels over real events.

**Not real.** `swarm` is **off by default and there is no measured lift saying otherwise** —
that is the whole point of 24.8 and it is the state this repository is in. A `citations`
signal proves a finding is anchored in this repository, **not that it is correct**; nothing
mechanical can prove the latter and a model grading a model is not a verification signal.
The merge is file-granular because the protocol gives whole-file replacements. Role sub-runs
get **no tools** unless the caller supplies a `toolsForRole` factory, because resolving a
grant is the caller's knowledge, not the dispatcher's. The roles do not read or write memory
— the Phase 9 digest still fills a seam the `run` RPC does not pass. And **nothing in this
project has ever run against a real provider.**

---

## Phase 11 — Honest benchmarks (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 11.1 | Internal eval suite | ✅ | Two ordered repair cases with non-empty verification commands, mandatory `verify-pass`, real `build` and `unit` stages, and SHA-256 pins covering every regular fixture file. Every case/attempt receives a fresh copied workspace; symlinks and special entries are refused. The invalid legacy captures with `verify: []` remain untouched and excluded. |
| 11.2 | Measurable outcomes | ✅ | Reports task completion, canonical-stage build success and test pass rates, time, calls/tokens, manual edits and cost. Manual edits and unpriced cost are explicit `null` when unobserved/unknown—never fabricated as zero. Completion comes only from `EvalResult.passed`. |
| 11.3 | Fixed-budget pass@k | ✅ | One aggregate budget fixes `k`, calls, tokens, attempt timeout and suite timeout. Reports pass@1, pass@k and every `0..k` distribution bucket; exhausted, skipped, timed-out and errored attempts remain in the artifact. |
| 11.4 | Same-model lift framing | ✅ | Versioned `naive@1` and `sketch@1` harnesses compare only identical suite digest, ordered cases, provider, model, `k` and every budget field. Lift is strict `>`; ties retain the incumbent. The mechanism supports repeated same-model pairs across several models. **No real-provider/public matrix was run**; the committed result is synthetic offline CI evidence only. |
| 11.5 | Bench script and CI gate | ✅ | `npm run bench` writes an atomic validated artifact; `bench:check` rejects internal lift regression after build/typecheck/core/desktop tests. CI uploads `.sketch/bench/*.json`. |
| 11.6 | Benchmarks panel | ✅ | Reachable read-only panel over the latest validated artifact. It has honest no-folder/no-engine/no-report/invalid-report states, renders all required metrics and identities, and never runs a model, eval, build or test on mount. |

### Phase 11 gate result

`packages/core/test/phase11-gate.test.ts` proves the pinned verifiable suite, fresh workspaces, eval/verification join, required nullable metrics, fixed-budget distribution, strict same-model comparison, full-budget comparability, validated artifacts, read-only RPC, CI ordering and panel behavior.

**Cold verification** (root and workspace `node_modules` plus `packages/core/dist` removed): `npm install` 0, `npm run build` 0, `npm run typecheck` 0, core **1,028 tests / 51 files**, desktop **481 tests / 48 files**, and `npm run bench:check` 0. The suites are identical with `SKETCH_FAKE_PROVIDER=1` and unset; known provider-key variables were absent. The install succeeded, but cache/network conditions were not instrumented, so this is **not claimed as proof of an offline install**. `npm install` reported five dependency-audit findings (3 moderate, 1 high, 1 critical); Phase 11 did not run an automatic breaking audit fix.

The deterministic gate result is `offline-scripted-v1 + Sketch` versus the same synthetic model plus `naive`: pass@2 lift **1.000**, candidate distribution `{0:0, 1:0, 2:2}`. Cost remains unknown (`null`) and manual edits remain unobserved (`null`). **Nothing ran against a real provider.** This result guards the harness in CI; it is not public evidence about any provider model and must not be placed in a several-model public matrix.

**Mutation evidence** (each broken, watched fail, restored, watched pass):

| Mutation | Result |
|---|---|
| Strict lift `>` changed to `>=` | 2 tests failed; restored targeted core tests passed |
| Full fixed-budget comparability guard disabled | 2 tests failed; restored targeted core tests passed |
| Mandatory `verify-pass` suite guard disabled | 1 test failed; restored targeted core tests passed |
| Automated manual edits changed from `null` to `0` | 2 tests failed; restored targeted core tests passed |
| Benchmarks panel called `eval([])` on mount | 1 desktop test failed; restored panel tests passed |
| `sanitizePayload` removed from the JSONL write path | 3 store tests failed; restored store tests passed |
| Runtime dependency `left-pad` added to core | 1 dependency test failed; restored dependency tests passed |

---

## Phase 12 — Packaging and the open flywheel (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 12.1 | Cross-platform Tauri builds with a documented size budget | 🔄 evidence-gated | Added native Windows/NSIS, macOS/DMG, and Ubuntu 22.04/AppImage jobs; host-native sidecar build and protocol smoke check; strict `<100,000,000-byte` artifact validator with SHA-256 size manifests; artifact upload; release-size Cargo profile; and `PACKAGING.md`. Corrected two real Tauri packaging defects: the invalid v2 window `name` property and a macOS-conflicting identifier ending in `.app`. Local sidecar is 87 MiB and passes protocol checks. The Windows Tauri build reached Rust compilation, then this host's Application Control blocked Cargo build scripts (OS error 4551) and `dlltool.exe` was missing. macOS/Linux were not run here. The task remains open until all three native workflow jobs produce uploaded installers whose manifests pass the budget. |
| 12.2 | Clean-machine local-first proof | 🔄 preflight built; evidence pending | Fixed the shipped run path so AgentChat resolves `selectedProvider` against the one key-free AppState provider list and both HTTP/stdin transports forward that exact entry. Added a direct production-sidecar preflight that refuses non-loopback, missing-model, and unavailable endpoints, requires Ollama's identity/model responses, and never starts or substitutes a stub/fake provider; it indexes a fresh fixture, requires plan/edit/verify/completion events, verifies exact bytes, and writes a limitation-labelled artifact. Added `OFFLINE-PROOF.md` for installer, UI review/apply, graph, event, final-byte, process-tree, DNS, socket, and packet evidence. Ollama is absent on this host, so no real-model run occurred and task 12.2 remains open. |
| 12.3 | Open-source scaffolding and signed-release provenance | 🔄 path built; release evidence pending | Added deterministic three-platform release assembly with strict input shape, re-hashing against size manifests, copy re-verification, version/tag/commit/repository binding, atomic `release-manifest.json`, and `SHA256SUMS`. The tag-only release job depends on the complete native matrix, uses GitHub OIDC build-provenance attestations, verifies every asset before `gh release create --verify-tag`, and scopes write/OIDC permissions to that job. `RELEASES.md`, `CONTRIBUTING.md`, and `PACKAGING.md` distinguish provenance from native code signing and preserve marketplace hash/scope/digest-review controls. No tag workflow has run, no release exists, and no Authenticode or Apple Developer ID identity is configured, so 12.3 remains open. |
| 12.4 | Serverless community-format skill flywheel | 🔄 production path proved locally; third-party evidence pending | A locally authored `skill.json` community-format fixture now passes open-registry digest review, installs with a persisted digest-bound narrower grant, runs through production RPC, captures and replays four evals, trains under strict held-out improvement, writes a candidate outside the active skill, promotes only after explicit review, and reruns with no HTTP/stdio Sketch server and `fetch` forbidden. The desktop exposes the same explicit candidate review/promotion seam over both transports. This is not a real third-party community skill; retained source/license provenance and execution of one remain required. |
| 12.5 | Nine-category extensibility audit and host registries | ✅ complete | `EXTENSIBILITY.md` now maps every required category to a production-consumed contract. Core adds host-scoped canonical provider, validated MCP catalog, memory-store, registered-agent, and explicit versioned-workflow registries carried by both production transports. Desktop production consumes theme, extension mapping, new-language, and declarative Monarch tokenizer registrations. Skills remain filesystem-discovered and model IDs runtime-configured. The behavioral gate and guard mutations pass. These are host code-registration contracts, not a plugin store or arbitrary executable package loader; the local MCP script is not third-party-server evidence. |
| 12.6 | Canonical end-to-end acceptance | ✅ complete | Scripted offline adapters drive a fresh booking project through the engine plan gate, real child-process verification, deterministic swarm consensus/merge/conflict handling, a deterministic cost stop with no escalation, and final green assembly. Dispatcher outcome events persist bounded consensus/merge/verify summaries and the Timeline reconstructs terminal states and evidence from those events alone. This is harness evidence, not evidence that a real provider can build a booking product. |

### Task 12.1 validation so far

`npm run build`, `npm run typecheck`, core **1,028 tests / 51 files**, desktop **484 tests / 49 files**, `build:sidecar`, and `verify:sidecar` pass. The native package attempt is recorded as a blocked attempt, not a pass. Mutation evidence: changing the package ceiling from strict `<` to `<=` failed one test; removing the Linux matrix identity failed one test; restoring the invalid Tauri window `name` failed one test. Each mutation was restored and all three packaging tests pass.

### Task 12.2 preparation validation

Canonical order passes: `npm run build`, `npm run typecheck`, core **1,028 tests / 51 files**, and desktop **489 tests / 51 files**. The rebuilt 87 MiB host sidecar passes its protocol smoke check with `fakeProvider: false`. The forwarding-focused set passes **18 tests / 3 files**. On this machine `npm run preflight:ollama -- --model definitely-not-installed` refuses with exit 1 because `127.0.0.1:11434` is unavailable and states that no stub/fake fallback is permitted; this is refusal evidence only, not a real-Ollama run.

Mutation evidence, each restored and re-run green:

| Mutation | Observed failure |
|---|---|
| Remove provider from stdio `run` frame | exact-frame test failed: received `undefined` |
| Remove provider from HTTP `run` request | exact-request test failed: received `undefined` |
| Ignore `selectedProvider` and take the first configured row | both AgentChat selection/no-fallback tests failed |

No provider key was added to AppState or the wire type: `RunOptions.provider` is the canonical key-free `ProviderSettingsEntry`. No real model was called, no native installer was exercised, and no network capture was taken.

### Task 12.3 preparation validation

Canonical order passes: `npm run build`, `npm run typecheck`, core **1,028 tests / 51 files**, and desktop **495 tests / 52 files**. The focused release/packaging set passes **9 tests / 2 files**; the preserved Phase 6 marketplace hash, capability, and digest-bound review set passes **54 tests / 3 files**. `node --check packages/desktop/scripts/assemble-release.mjs` and `git diff --check` pass.

Mutation evidence, each restored and re-run green:

| Mutation | Observed failure |
|---|---|
| Remove the assembler's SHA-256 comparison while preserving installer byte length | the same-size tamper test failed: the modified installer was incorrectly accepted |
| Remove `needs: package` from the release job | the workflow policy test failed on the missing complete-matrix dependency |
| Remove `gh attestation verify` before publication | the workflow policy test failed on the missing verification step |

No production tag or GitHub Release was created; no workflow attestation was issued or independently verified. The repository has no configured Authenticode certificate or Apple Developer ID/notarization identity. GitHub build provenance, native OS code signing, and marketplace trust controls are three separate claims: the workflow implements the first path, does not implement the second, and does not replace the third.

### Task 12.4 preparation validation

Canonical order passes: `npm run build`, `npm run typecheck`, core **1,029 tests / 52 files**, and desktop **498 tests / 52 files**. Focused core registry/flywheel tests pass **26 tests / 2 files**; focused desktop panel/transport tests pass **33 tests / 3 files**. Diagnostics report no issues in the changed TypeScript/TSX files.

The gate uses a locally authored community-format fixture, not a third-party skill. It proves the production joins: unreviewed open-registry bytes are refused; the installed declaration asks for `net:http` while persisted authority grants only `fs:read:project`; changed installed bytes receive no grant; four real captures reload and replay at 1.0; the trainer accepts a strict held-out 0.0 → 1.0 improvement; a candidate that changes capabilities is refused; explicit promotion updates active bytes and authority; the promoted skill replays at 1.0. `fetch` is replaced with a rejecting counter and remains at zero, and no Sketch HTTP or stdio server starts.

The desktop requests `write: true` only to create the out-of-tree candidate artifact, renders the returned candidate body, and exposes “Use trained version” only for a measured improvement with an artifact. The installed `SKILL.md` stays byte-unchanged through training/review and changes only after that button invokes `skill-promote`; HTTP and stdio exact-wire tests cover `{ root, name }` forwarding. The mock transport refuses promotion rather than fabricating success.

Mutation evidence, each restored and re-run green:

| Mutation | Observed failure |
|---|---|
| Resolve production authority from the skill's declarations instead of the persisted grant | gate failed: received `fs:read:project, net:http` instead of only `fs:read:project` |
| Remove the active-digest comparison | gate failed: tampered installed bytes retained `fs:read:project` instead of receiving no capabilities |
| Skip the persisted-grant write at install | gate failed opening the missing `.grants/community-reviewer.json` authority file |
| Keep the old active digest after promotion | gate failed: reloaded promoted authority was stale and `readInstalledSkillGrant().ok` was false |

Task 12.4 remains open. No genuine third-party community skill was downloaded or retained, and no source/license provenance for one was reviewed; the local fixture proves format compatibility and the shipped flywheel, not the community-evidence claim.

### Task 12.5 completion result

Canonical order passes with `SKETCH_FAKE_PROVIDER` unset: `npm run build`, `npm run typecheck`, core **1,034 tests / 53 files**, and desktop **502 tests / 53 files**. Both workspace suites also pass with `SKETCH_FAKE_PROVIDER=1`. One unset core attempt hit the documented `verify-live` port-release flake and passed on focused plus full reruns; one fake-enabled core attempt timed out in the existing event-store property test under parallel load and passed in isolation plus on a complete rerun. No assertion was weakened. `git diff --check` passes.

`EXTENSIBILITY.md` is the contributor-facing nine-category matrix. Runtime configuration covers model IDs; filesystem discovery covers skills; immutable host registries cover canonical provider factories, validated MCP catalog entries, memory-store factories, exact-version agents, and exact-version workflows; the desktop editor registry covers Monaco themes, extension mappings, new language IDs, and declarative Monarch tokenizers. Core transport contexts carry one host-owned registry through both stdio and the Vite bridge. Importing core registers nothing globally.

`packages/core/test/phase12-extensibility-gate.test.ts` proves five production paths: fresh canonical provider factories with fake precedence and provider-backed RPC; external MCP metadata validation plus a local handshake, tool discovery, namespacing, capability denial, successful dispatch, and launch refusals; alternate memory remember/supersede/search/list/close with JSONL default and unknown-selector refusal; and explicit versioned workflow/agent execution with deterministic order, pre-call availability checks, capability intersection, unchanged default `single`, and unknown-workflow refusal. The desktop production-path test proves theme/language/tokenizer installation into Monaco.

Mutation evidence, each restored and re-run green:

| Mutation | Observed failure |
|---|---|
| Remove fake-provider precedence from `CanonicalProviderRegistry.resolve` | provider gate failed because the custom adapter ran instead of `FakeChatAdapter` |
| Disable exact-version MCP validation | malformed `@latest` registration was accepted and its refusal assertion failed |
| Disable registered-agent verification-stage availability | unavailable integration agent ran and spent a model call instead of being skipped |
| Replace capability intersection with the agent's full list | planner received ungranted `fs:write:project` and the capability assertion failed |
| Fall back to JSONL for an unknown memory selector | unknown-selector promise resolved instead of rejecting |
| Remove Monaco `setMonarchTokensProvider` | production language registration test failed; restored focused test and typecheck passed |
| Remove `sanitizePayload` from `JsonlEventStore.emit` | 3 on-disk redaction tests failed; restored store suite passed 24/24 |

Task 12.5 is complete; the legacy task counter recorded **79/96** at that checkpoint. The boundary remains explicit: these are host code-registration contracts, not a filesystem-installed executable plugin manager or plugin store. MCP entries remain exact-version, structured-argv, capability-gated host data; the positive handshake uses a repository-local script through the launch-override test seam and is not execution or audit evidence for an actual third-party MCP package. Memory persistence/sharing/lifetime belongs to the host factory. Registered workflows are explicit and do not change built-in `single` or enable `swarm`.

### Task 12.6 completion result

Canonical order passes with `SKETCH_FAKE_PROVIDER` unset: `npm run build`, `npm run typecheck`, core **1,036 tests / 54 files**, and desktop **503 tests / 54 files**. Both workspace suites pass at the same counts with `SKETCH_FAKE_PROVIDER=1`; common hosted-provider key variables were unset. Diagnostics on the four implementation/gate files and `git diff --check` pass.

The core gate uses scripted offline adapters, a fresh real filesystem project, real `node` child processes for format/lint/build/unit checks, real twelve-document plan artifacts, real file edits, durable JSONL, and production dispatch/merge/consensus/budget contracts. It proves edit-before-plan refusal; correct pricing passing; wrong pricing failing `unit`; six verifiable swarm roles merging four non-conflicting files; two proposers for one path producing `multiple-proposers`, untouched bytes, and a follow-up task; a deterministic token stop with `run_failed{reason:"budget"}` and no escalation; and seven final checks over five assembled modules. A second run proves identical budget configurations stop identically.

Dispatcher outcome events now carry bounded per-attempt consensus, merge, and verification summaries. The desktop gate generates its event log through real core `runTask()` and `dispatch()`, then proves the Timeline labels the dispatcher slice completed and exposes planning, verification, consensus, merge, and budget evidence. Every model turn is scripted. This is acceptance-harness evidence for production contracts, not evidence that a real provider can build an Airbnb-like product. Nothing ran against a hosted provider or Ollama, and `swarm` remains off by default.

Mutation evidence, each restored and re-run green:

| Mutation | Observed failure |
|---|---|
| Remove the engine `plan.hasPlan()` check | acceptance gate failed because no `edit_rejected` event existed |
| Force verification policy outcomes to succeed | acceptance gate failed because deliberately wrong pricing incorrectly returned ok |
| Disable `multiple-proposers` conflict refusal | acceptance gate failed because conflicting proposals incorrectly succeeded |
| Disable the loop cost guard | acceptance gate failed because the budgeted run incorrectly succeeded |
| Remove consensus from the persisted dispatcher outcome summary | acceptance gate failed at the durable-event assertion: persisted consensus was `undefined`; restored focused gate passed |
| Stop treating `strategy_selected{phase:"outcome"}` as terminal in the Timeline | desktop gate failed because `timeline-swarm` rendered as `running`; restored focused gate passed |
| Remove `sanitizePayload` from `JsonlEventStore.emit` | 3 on-disk redaction tests failed; restored store suite passed 24/24 |

Task 12.6 is complete; the legacy task counter recorded **80/96** at that checkpoint. Tasks 12.1–12.4 remain evidence-gated on native artifacts, installed-app clean-machine/Ollama evidence, a real verified tag release, and genuine third-party skill provenance respectively.

---

## Phase 13 — Documentation reconciliation (spec: `.kiro/specs/sketch-engineering-os`)

| # | Task | Status | Notes |
|---|---|---|---|
| 13.1 | Reconcile `rules.md` | ✅ complete | Rule 4 now permits roles and consensus only through eval-gated `swarm`, keeps `single` as the default, and keeps `swarm` off without measured pass@k lift. Rule 6 replaces the keytar mandate with the OS credential store through a host outside core, limits key transit to purpose-bound credential/invocation channels, and preserves no-log/no-event/no-return guarantees. |
| 13.2 | Reconcile `what-not-we-are-building.md` | ✅ complete | The curated pinned/content-hash registry and discovery/install surface are allowed as the v1-family foundation delivered in the v1.5 implementation phase. Open community publishing remains v2-only behind tested integrity and capability scopes, a review queue, exact-digest approvals, and separately persisted digest-bound grants. The document does not claim public-key author signatures. |
| 13.3 | Reconcile `trd.md` and `architecture.md` | ✅ complete | The documents now match the npm workspace, zero-runtime-dependency core, seam-plus-implementation persistence/vector/credential/MCP boundaries, event-sourced JSONL run log, on-demand `.sketch/` layout, versioned date-sharded memory, and fixed nine-stage verification contract. |
| 13.4 | Reconcile `prd.md` | ✅ complete | Cowork and Code are now documented as two presentations over one client/event/project substrate. Product optimization is defined by same-model lift, fixed-budget reliability distributions, and strict held-out compounding; adoption counts are not capability evidence. |
| 13.5 | Audit and reconcile the living log | ✅ complete | Historical snapshots and immutable gate evidence are labelled; all spec conflict/authority decisions are mapped; the task count is reproducible at 78/82 actionable leaves, with only evidence-gated 12.1–12.4 open. |

### Task 13.1 completion result

No production code changed. The stale phrases `Multi-model consensus logic`, `stored only via keytar`, and the absolute IPC prohibition are absent from `rules.md`; the required `single`, eval-gated `swarm`, pass@k, consensus-only-in-swarm, OS credential-store, outside-core, and purpose-bound transit language is present. Markdown diagnostics are clean for `rules.md`, `NEED-TO-DO.md`, and `tasks-executed.md`; `tasks.md` retains only its known legacy heading/dependency-graph diagnostics. `git diff --check` passes.

Focused behavioral validation passes: core **31 tests / 2 files** (`phase10-gate`, `secrets.store`) and desktop **49 tests / 2 files** (`ProviderSettings`, `security`). Canonical order also passes with hosted-provider keys unset: `npm run build`, `npm run typecheck`, core **1,036 tests / 54 files**, and desktop **503 tests / 54 files**. Both complete workspace suites pass at the same counts with `SKETCH_FAKE_PROVIDER=1`.

This task copies already-resolved Requirements 17.3–17.4 and 24.1/24.8/24.9 plus design conflicts 4 and 10 into the contributor rules; it introduces no new architecture. Task 13.1 is complete; the legacy task counter recorded **81/96** at that checkpoint.

### Task 13.2 completion result

No marketplace production code changed. The broad stale prohibitions `No skill registry`, `no skill discovery UI`, the old `Not a Skills Marketplace (v1)` heading, and `Plugin store in v1` scope-trap row are absent. `what-not-we-are-building.md` now permits the curated pinned/content-hash-verified registry and discovery/install surface as the staged v1-family foundation delivered in the v1.5 implementation phase. Open community publishing remains v2-only behind tested content integrity and capability scopes, a review queue with exact-digest approvals, and separately persisted digest-bound grants that changed bytes invalidate. The document explicitly states that current “signed registry” evidence is not public-key author identity, native application signing, or release provenance.

Focused validation passes: core **42 tests / 4 files** (`registry`, seed pins, Phase 6 chain, Phase 12.4 flywheel preparation) and desktop **15 tests / 1 file** (`SkillsMarketplace`). Canonical final verification passes with hosted-provider keys unset: `npm run build`, `npm run typecheck`, core **1,036 tests / 54 files**, and desktop **503 tests / 54 files**; both complete workspace suites pass at the same counts with `SKETCH_FAKE_PROVIDER=1`. Document diagnostics are clean except for the pre-existing `tasks.md` heading/dependency-graph diagnostics, and `git diff --check` passes.

The first unset core attempt reproduced the documented Windows `verify-live` port-release flake: the listener remained visible after the 300 ms post-kill wait. The prescribed recurring-flake fix was committed separately as `012e109`: only the settle allowance changed to 1,000 ms, while the exact `isPortListening(port) === false` assertion stayed intact. The file passed **28/28** three consecutive focused runs and the final full core suites in both provider environments. No assertion was weakened.

Task 13.2 copies the already-resolved Requirement 11/28.2 and design conflict 5 boundary into the scope document; it creates no new marketplace architecture and does not complete evidence-gated task 12.4. Task 13.2 is complete; the legacy task counter recorded **82/96** at that checkpoint.

### Task 13.3 completion result

No production code changed. `trd.md` and `architecture.md` now replace the former mandatory `better-sqlite3`, `sqlite-vec`, `keytar`, `hnswlib-node`, and MCP SDK choices with the contracts actually shipped: a zero-runtime-dependency `@sketch/core`; `EventStore`, `MemoryStore`, `VectorStore`, and `SecretStore` seams; append-only JSONL/file defaults; native-host OS credential persistence; and hand-rolled JSON-RPC 2.0 over stdio. The documents record the `packages/core` + `packages/desktop` workspace, the event log as the source of run history, the on-demand `.sketch/` artifacts, and the fixed `format → lint → typecheck → build → unit → integration → security → performance → dependency-audit` policy.

The reconciliation preserves implementation limits rather than copying an aspirational shape: vectors currently default to `MemoryVectorStore`; `.sketch/index/graph.json` persists graph/index metadata rather than a sqlite-vec database; `JsonlMemoryStore` writes date-sharded `.sketch/memory/<YYYY-MM-DD>.jsonl`; project memory is separate from the run log and does not yet automatically ingest every live run; MCP catalog coverage is not third-party execution/audit evidence; and nothing is described as real hosted-provider evidence.

Validation passes in canonical order: `npm run build`, `npm run typecheck`, core **1,036 tests / 54 files**, and desktop **503 tests / 54 files** with `SKETCH_FAKE_PROVIDER` unset; both full suites pass at the same counts with it set to `1`. Focused source-contract validation passes **163 tests / 6 files** (`deps`, event store/redaction, verification policy, memory, MCP, and secret store). Both amended documents have no diagnostics and `git diff --check` passes. No guard or production path changed, so no guard mutation was required; the mandatory `sanitizePayload` phase-gate mutation rule remains unchanged.

Task 13.3 copies Requirements 1, 3, 4, 17, 21, 22, and 28.3–28.4 plus design conflicts 1, 2, 6, and 7 into the prior-generation architecture documents. It introduces no new architecture and completes no external Phase 12 evidence gate. Task 13.3 is complete; the legacy task counter recorded **83/96** at that checkpoint.

### Task 13.4 completion result

No production code changed. `prd.md` now defines the shipped `Cowork | Code` toggle as two presentations over one `SketchClient`, event stream, project/file state, provider selection, skills, memory contracts, budgets, and verification results. Cowork is the task/review surface; Code is the IDE/file/diff/Git/terminal/test surface. The document removes the stale four-check verifier, SQLite-memory claim, absolute no-consensus/no-marketplace exclusions, and adoption targets as product-quality evidence.

The PRD now makes the three authoritative optimization metrics explicit: same-model/same-budget `M + Sketch` versus `M + naive` lift; pass@1/pass@k plus the full distribution under fixed call/token/cost/time budgets for reliability; and strict held-out eval improvement with separate review/promotion for compounding. It retains the narrow evidence labels: committed benchmark lift is synthetic offline regression evidence, `swarm` remains off without measured strategy lift, default desktop retrieval and automatic live-run memory ingestion remain absent, and configured native/release/Ollama/community/MCP/provider paths do not substitute for retained external evidence.

Validation passes in canonical order: `npm run build`, `npm run typecheck`, core **1,036 tests / 54 files**, and desktop **503 tests / 54 files** with `SKETCH_FAKE_PROVIDER` unset; both full suites pass at the same counts with it set to `1`. Focused validation passes core **43 tests / 3 files** (`phase10-gate`, `phase11-gate`, trainer) and desktop **3 tests / 2 files** (shared `SketchClientProvider` and the real Cowork-run-to-Code-file flow). `prd.md` has no diagnostics and `git diff --check` passes. No guard or source path changed, so no guard mutation was required.

Task 13.4 copies Requirements 14, 24.8, 25, and 28.5 into the prior-generation product document without adding a new product surface or making a new capability claim. It completes no external Phase 12 evidence gate. The legacy counter recorded **84/96** at that checkpoint; task 13.5 replaces that counter with the reproducible actionable-leaf convention.

### Task 13.5 completion result

No production code changed. The audit distinguishes historical truth from current truth instead of rewriting either: Milestones 1–5 are explicitly immutable pre-spec snapshots, each numbered phase section remains immutable checkpoint evidence, and the Phase 12/13 tables carry current status. The old Milestone 4 fixture/security inventory and Milestone 5 deferred MCP/context/memory notes therefore no longer read as present-day claims.

The Decision Log now covers all ten resolved conflicts and all five decisions the design made on its own authority. Existing rows were expanded for the MCP-SDK seam, always-on planning with optional human approval, and deleted keytar-shaped storage; stale sqlite-vec and blanket no-consensus decisions are explicitly superseded. New rows record eval-gated `swarm`, curated-registry versus open-publishing boundaries, the exact nine-stage verification order, historical-baseline reconciliation, the unrestricted-shell defect pulled forward to Phase 1.5, and collision-resistant time-sortable run ids.

Progress is now mechanical rather than manually inferred. `tasks.md` contains 96 rows: 83 leaves plus 13 phase summaries. Excluding superseded leaf 4.3 yields 82 actionable leaves; **78 are complete and four remain open** (12.1–12.4). Parent rows for completed Phases 1, 4, and 13 are normalized to complete. The raw row state is **90 complete, 4 evidence-gated, 1 superseded, and 1 open Phase 12 summary**. Earlier `/96` numbers remain labelled as legacy checkpoint counters.

Validation is documentation-focused and canonical source validation remains green at the unchanged `437d004` source tree: `npm run build`, `npm run typecheck`, core **1,036 tests / 54 files**, and desktop **503 tests / 54 files** with `SKETCH_FAKE_PROVIDER` unset and set to `1`. Markdown diagnostics are clean except for the pre-existing `tasks.md` heading/dependency-graph diagnostics; the checkbox/count audit and required-decision scan pass; `git diff --check` passes. No guard or source path changed, so no guard mutation was required.

Task 13.5 completes Requirement 28.6 and the Phase 13 documentation-reconciliation parent. It does not complete any Phase 12 evidence gate. Tasks 12.1–12.4 remain open on native installer artifacts, installed-app clean-machine/Ollama plus process-attributed no-egress evidence, a real independently verified tag release, and genuine third-party skill source/license provenance respectively. Current progress is **78/82 actionable leaves complete**.

---

## Post-Phase 13 — mutation-verification findings (no owning task)

A mutation-verification pass over the trainer gate, capability scoping, and the budget guard
confirmed all three are genuinely enforced. It surfaced two findings that were neither recorded nor
guarded. Both are closed here: the first with a tripwire, the second with a written risk.

### Finding 1 — the no-real-provider invariant is now structural

**Before:** "Nothing has ever run against a real provider" was asserted in `HANDOFF.md`,
`NEED-TO-DO.md`, `tasks.md`, and this file, and corroborated by every `.sketch/bench` artifact
carrying `"provider": "synthetic-offline"`. Nothing structurally prevented a future test from
constructing a real adapter with a key and dialling out. `test/providers.fake.test.ts` tripwires one
run, `test/verify-live.test.ts` refuses to probe anything but loopback, and the desktop has a
source-level egress guard — none of which covers the core suite.

**Now:** `packages/core/test/setup/noEgress.ts` is installed as a vitest setup file for EVERY core
test file through the new `packages/core/vitest.config.ts` (which sets `setupFiles` and nothing else,
so file discovery, pool, and isolation are unchanged from the configuration-free setup it replaced).
It wraps `fetch` and, as a backstop, `net.Socket.prototype.connect`, refuses any non-loopback
destination, and names the destination plus the offending test. Loopback is deliberately, permanently
allowed: the suite depends on it for `verify-live`'s real servers on ephemeral ports,
`providerSettings`'s real `node:http` servers and the Ollama-shaped `11434` endpoint, and the dev
bridge. Non-socket schemes (`data:`, `file:`) and IPC paths are not egress and pass through.

The same guard file exports `isSyntheticProviderIdentity`, which `test/no-egress.test.ts` runs over
every `.sketch/bench` artifact present on the machine: a `provider` field that is not a
synthetic/offline identity fails the suite, so the day someone runs a real benchmark the
documentation cannot silently go stale. The check requires a synthetic token AND the absence of a
hosted-provider token, so `openai-offline` is refused rather than waved through. Because `.sketch` is
gitignored working state, the artifact count is machine-dependent; a second test therefore runs the
same scan over a fixture containing one synthetic and one `"provider": "openai"` artifact, which is
what stops the scan from being a vacuous pass on a fresh clone.

**No existing test was weakened, skipped, or rewritten**, and no provider adapter test needed
changing. The mocked-`fetch` and injected-`fetchImpl` tests keep exercising real HTTP request/response
shapes: replacing `global.fetch` replaces the wrapper, and a mock opens no socket. **No test in the
core suite legitimately needed a non-loopback host** — the full suite passed on the first run with the
guard installed, so no hole was punched.

One real defect in the guard was found by mutating it rather than by reading it: the first draft
judged `Socket.prototype.connect` by its public signature, but `net.connect()` and `http`'s agent
normalise their arguments and pass ONE array, `[options, listener]`. The first draft therefore let
every raw `node:http`/`node:https` request and Node's own fetch implementation through while looking
correct. It now unwraps the normalised array.

**Mutation evidence** (a temporary probe test was added, watched fail, and deleted):

| Probe | Observed refusal |
|---|---|
| `await fetch('https://example.com/')` | `NO-EGRESS TRIPWIRE: refused fetch to https://example.com/ from test "mutation probe > reaches a real external host"` — 1 failed |
| `await fetch('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer sk-live-…' } })` | `NO-EGRESS TRIPWIRE: refused fetch to https://api.openai.com/v1/models from test "mutation probe > reaches a real provider endpoint with a key"` — 1 failed |
| Raw `node:https` `request({ host: 'example.com', port: 443 })`, bypassing `fetch` entirely | `NO-EGRESS TRIPWIRE: refused socket connect to example.com from test "mutation probe > reaches a real external host with a raw https client"` at `TLSSocket.guardedConnect` — 1 failed |

After deleting the probe file the suite is green: core **1,050 tests / 55 files** (the 1,036 / 54
baseline plus this file's 14 tests), desktop **503 tests / 54 files** unchanged.

### Finding 2 — `GitTool` sits outside the capability dispatcher (recorded, not fixed)

`packages/core/src/tools/` contains one real tool, `git.ts`, and `GitTool` is **not** a
`ToolDescriptor` with a `requires` field, so it never passes through `ToolDispatcher`'s
authorisation. Consequently five of the six adversarial denial paths in
`test/capabilities.test.ts` — network (twice), subprocess, fs read outside the project, and secrets
read; every one except `fs:write:home`, which really writes — are proved by "the tool's `run` body was
not entered" using `ToolDescriptor`s **defined inside the tests**. The only production descriptors are
minted by `mcp/host.ts` for catalogued third-party servers this project has neither audited nor
executed.

The gate is correct and singular; the population of real tools behind it is one file that bypasses it.
Stated consequence: **the gate is verified against synthetic descriptors, and routing `GitTool`
through the dispatcher is the work that would make the adversarial suite bite on a real tool.**
`GitTool` was deliberately **not** changed — moving it behind the dispatcher changes the Git panel's
call path and failure modes, which is a behaviour change with no owning task. Recorded in
`HANDOFF.md` open risk 10 and `NEED-TO-DO.md` §4.7.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-03 | The legacy `verifier/` is **deleted, not commented**, and `shell: true` is now forbidden across `packages/core/src/` by a guard — **closes `HANDOFF.md` open risk 9 and `NEED-TO-DO.md` §4.2** | Two verify paths one letter apart, one of them spawning through a shell, is a defect waiting for its first caller. The prior recommendation was to add a comment at the entry point saying "do not pass caller-supplied strings here", which is a request, not a boundary. Mapped before deleting: `src/verifier/` had exactly ONE production importer, `src/orchestrator/orchestrator.ts` (`VerifyLoop`, `Fixer`, `FixContext`), plus three test files (`verifier.test.ts`, `e2e.test.ts`, `orchestrator.test.ts`). That orchestrator was itself reachable from **nothing shipped** — the agent loop, the RPC methods, the CLI and the desktop all import only `orchestrator/file-writer.ts` and `orchestrator/json.ts`, exactly as `HANDOFF.md` claimed — so it and its two collaborators (`planner.ts`, `agent-runner.ts`) went with it. `verifier/detector.ts` needed no migration: `verify/policy.ts` had already reimplemented its node/python/rust/go answers verbatim as the baseline for the nine stages and only ever cited it in a comment, never imported it. What survives of `orchestrator/` is `file-writer.ts`, `json.ts` and the `FileEdit` type, all genuinely shared. Test delta **core 1056 → 1042 (−14), 55 → 53 files**, fully accounted: −21 tests of deleted code (12 `Verifier`/`VerifyLoop`, 3 `topoSort`, 4 `Orchestrator`, 2 legacy-pipeline e2e — of which one, the `DiskFileWriter` escape refusal, covered **surviving** code and was migrated rather than dropped), +7 new (2 `DiskFileWriter` including that migration, 1 `MemoryProjectMemory` conversation test replacing coverage the e2e run had provided indirectly, 1 asserting the `verifier` namespace is gone from the package root, 3 for the guard). The invariant is held structurally: `verify-runner.test.ts` walks every `.ts` file under `packages/core/src/`, strips comments, and fails unless every `shell` spawn option is the literal `false` — a computed value is how `true` gets back in without the word. Mutation-verified against the case that matters — a **new** file, not an existing spawn site: adding `src/mutation-probe.ts` containing `spawn(command, { shell: true })` fails the guard with `spawn without a shell. Offending sites: mutation-probe.ts: shell: true` (15 pass, 1 fail); deleting the probe restores 16/16. A guard that only caught edits to spawn sites it already knew about would have missed that file entirely. Left standing deliberately: `ProjectMemory`/`legacyProjectMemory` is now published API with no in-repo caller, and retiring it is a breaking change, so it is recorded in `NEED-TO-DO.md` §1.3 rather than swept up here (Requirements 4.1, 4.2, 4.6, 4.8) |
| 2026-08-03 | `git:read` joins `DEFAULT_CAPABILITIES`, and the five assertions it moves each say why — **supersedes the "absent" half of the 2026-08-01 vocabulary row** | Reading a repository is part of reading a project: the files on disk are one revision of the same bytes, and a skill permitted to read `a.ts` but not permitted to ask when `a.ts` last changed draws a line users do not recognise. `DEFAULT_CAPABILITIES` is therefore `['fs:read:project', 'git:read']`. This is a **user decision taken on its own merits**, which is what makes it legitimate: the preceding commit (`f2e2fd4`, `GitTool` routed through the gate as six descriptors) deliberately left the default alone precisely because widening it there would have meant editing tests so new code could pass. Landing it as its own change with its own rationale is the difference. The default stays read-only on both halves — `fs:write:project` and `git:write` are absent, and `capabilities: []` still means nothing. What it costs, stated plainly: a skill declaring nothing can now run `git-status`, `git-branch` and `git-diff` autonomously, so commit messages, author names and branch names are inside the default grant — the same trust boundary the file contents already were. Five assertions moved, each with an in-test comment naming the decision so a future reader cannot mistake them for tests loosened to accommodate code: the `DEFAULT_CAPABILITIES` equality and the hostile-skill default-grant equality in `capabilities.test.ts` (both now also pinning that `git:write` and `fs:write:project` are *not* granted), and three copies of the run-dispatcher log line — two in `mcp.test.ts`, one in `phase12-extensibility-gate.test.ts` — which went from `mcp: 0 server(s) open, 0 tool(s) reachable with fs:read:project` to `mcp: 0 server(s) open, 3 tool(s) reachable with fs:read:project, git:read`. The three are the engine's own read-only git descriptors; `0 server(s) open`, the claim those tests exist for, did not move. The adversarial suite still bites: none of §3's six escalations costs `git:read`, so all six remain denied, and a new §6 test proves the new boundary at effect level — a dispatcher granted `capabilitiesForSkill(undefined)` reads a real `git init` repository and is still refused `git-stage`/`git-commit`, with commit count and `git status --porcelain -b` byte-identical afterwards. Mutation-verified: adding `git:write` to the default fails it with `8ca4562 this commit must never exist` in `git log` (Requirements 11.4, 11.5, 14.6) |
| 2026-08-03 | The no-real-provider claim gets a **suite-wide tripwire**, and loopback stays open | Every other invariant here has a tripwire; the strongest claim in the repository had only convention plus two single-file guards. `packages/core/vitest.config.ts` now installs `test/setup/noEgress.ts` for every core test file, refusing any non-loopback `fetch` or socket connect and naming the destination and the test. Loopback is not negotiable in the other direction either: `verify-live`, the Ollama-shaped `11434` endpoint, and the dev bridge all need it, so the guard's line is loopback, not "no network". Provider tests keep using mocked `fetch`/injected `fetchImpl`, which open no socket. |
| 2026-08-03 | A bench artifact whose `provider` is not synthetic **fails the suite** | The documented claim that no benchmark has run against a real provider is corroborated only by artifact contents, and `.sketch` is gitignored working state that no reviewer sees. Scanning every present artifact for a synthetic/offline identity — synthetic token required, hosted token forbidden — means the day a real benchmark runs, the suite fails instead of the docs going stale. A fixture-based companion test keeps the scan from passing vacuously on a fresh clone. |
| 2026-08-03 | `GitTool` stays outside the dispatcher **as a recorded risk**, not a silent one | `GitTool` is the only real tool in `tools/` and it is not a `ToolDescriptor`, so the adversarial denial suite proves five of its six paths against descriptors defined inside the tests. The gate is singular and mutation-verified; the tool population behind it is not. Routing `GitTool` through the dispatcher changes the Git panel's call path and failure modes, which is a behaviour change with no owning task, so it is written down in `HANDOFF.md` open risk 10 and `NEED-TO-DO.md` §4.7 and left for a task that owns it. |
| 2026-08-03 | Single-agent remains the default; roles and consensus exist only through eval-gated `swarm` | This supersedes the blanket 2025 “cut consensus” decision without enabling it by default. Consensus runs only inside `swarm`, and `swarm` remains off for a task class until strict measured pass@k lift over `single` justifies the extra cost and complexity. |
| 2026-08-03 | Curated registry discovery is allowed; open publishing remains digest-gated | The shipped v1-family surface installs pinned content-hash-verified bytes with separately persisted digest-bound grants. Open community publishing remains v2-only behind tested integrity and capability scopes, a review queue, and exact-digest approvals. A content pin is not public-key author identity. |
| 2026-08-03 | Verification has one fixed nine-stage order | The canonical order is `format → lint → typecheck → build → unit → integration → security → performance → dependency-audit`; build follows typecheck because later integration/security/performance checks may require its artifact. The legacy four-check verifier remains compatibility history, not the canonical policy. |
| 2026-08-03 | Milestones 1–5 are historical snapshots; numbered phase sections are current authority | The pre-spec inventory is valuable evidence of what changed but became misleading when its fixture/deferred rows were read as current. Labelling snapshots preserves history while satisfying Rule 9's requirement that the living log identify present truth. |
| 2026-08-03 | The unrestricted `run_command` shell was a defect pulled forward to Phase 1.5 | A real bridge into `cmd /C`/`sh -c` before capabilities, containment, confirmation, and CSP would have exposed an unsandboxed execution path. Hardening therefore landed before the transport, with one shell-less policy path, rather than waiting for the later MCP phase. |
| 2026-08-03 | Run ids are random and time-sortable, never a process-local counter | Concurrent CLI, desktop, eval, and dispatcher processes can write the same event directory. Random time-sortable ids avoid cross-process collisions while preserving readable chronology without shared mutable state. |
| 2026-08-03 | Progress counts actionable leaves, not phase-summary rows | `tasks.md` contains 83 leaves and 13 summaries. Excluding superseded leaf 4.3 yields 82 actionable leaves; this makes 78 complete plus four evidence-gated leaves reproducible, unlike the old manually maintained `/96` counter. |
| 2026-08-03 | Dispatcher completion is a durable `strategy_selected{phase:"outcome"}` event with bounded evidence summaries | Dispatcher slices do not emit `run_completed`. Persisting consensus, merge, and verification summaries makes the event log sufficient for Timeline reconstruction without adding a new EventKind or retaining unbounded model output. |
| 2026-08-03 | The canonical booking acceptance is **scripted contract evidence**, not model-capability evidence | Real filesystem bytes, child processes, merge/consensus, budgets, and UI reconstruction test the production joins deterministically offline. Scripted turns cannot establish that any real provider can build the product, so `swarm` remains off and the claim stays narrow. |
| 2026-08-03 | Extension registration is **host-scoped code composition**, not global plugin loading | `createEngineExtensionRegistry` constructs immutable provider/MCP/memory/agent/workflow registries that both production transports carry; the editor host supplies its own theme/language registry to `prepareMonaco`. Importing a package changes no global state, unknown selectors fail closed, custom providers are fresh per call, and workflows are explicit. This satisfies the nine production extension contracts without claiming a plugin store, arbitrary executable package loader, or third-party MCP execution evidence. |
| 2026-08-03 | Extensibility status follows the **production loading path**, not interface vocabulary | A test runner can be injected and a fixed table can be edited, but neither lets a user or host supply an independently versioned extension. The audit therefore labels custom endpoint/model configuration, skill discovery, `MemoryStore` composition, and reviewed MCP catalog changes precisely, and keeps agents, workflows, themes, and languages closed until production registries/loaders and behavioral gates exist. |
| 2026-08-03 | Registry-installed skill authority is a **persisted, digest-bound grant**, never the skill's own declaration | A community skill can ask for more than review approved. Installation therefore stores the exact registry grant under `.sketch/skills/.grants`, binds it to reviewed source and active digests, and production runs deny all capabilities if that authority is missing, malformed, or stale. Custom skill directories retain declaration-derived behavior because no registry claimed authority over them. |
| 2026-08-03 | Training and activation are **two separate actions** | A strict held-out win authorizes presenting a candidate, not silently replacing installed bytes. Training writes `.sketch/training/<name>/best_skill.md`; the desktop renders that real body; promotion requires a separate click, refuses name/capability changes, atomically activates `SKILL.md`, and updates the digest-bound grant. This keeps measurement, review, and activation independently observable. |
| 2026-08-03 | A local community-format fixture proves integration, **not community provenance** | The fixture exercises `skill.json`, open-registry review, install, run, capture, train, promote, and rerun without a Sketch server or network. Because it was authored in this repository, it cannot satisfy the claim that a genuine third-party community skill with retained source/license provenance works; task 12.4 remains evidence-gated. |
| 2026-08-02 | GitHub OIDC build provenance and native OS code signing are **separate release claims** | The workflow can attest that exact bytes came from this repository's tag workflow and bind them to a commit, but it cannot create an Authenticode publisher identity or Apple Developer ID/notarization trust. `RELEASES.md`, `PACKAGING.md`, and the task gate state both boundaries. Task 12.3 remains open until a real tag release is retained and independently verified; native signing remains absent until project-owned identities and platform verifier output exist. |
| 2026-08-02 | Release publication happens only **after complete native inputs, byte re-validation, attestation, and verification** | `needs: package` prevents a partial matrix from publishing. The assembler accepts exactly one installer and passing size manifest per platform, rejects changed or extra bytes, and emits deterministic metadata atomically. The release job verifies each GitHub attestation before `gh release create --verify-tag`; mutation tests prove the digest, matrix dependency, and verifier steps are live. Marketplace content hashes, fail-closed scopes, and digest-bound review remain independent and were re-tested. |
| 2026-08-02 | A desktop run forwards the **selected persisted entry**, not a model string or a fallback | Provider configuration already has one authority: the key-free `ProviderSettingsEntry` loaded into AppState. AgentChat resolves `selectedProvider` against that list at send time and both transports carry the exact object. An absent/stale selection stays absent so core gives its existing `params.provider is required` refusal; selecting the first row would silently run a model the user did not choose. The type cannot carry `apiKey`, preserving the persisted-state boundary. |
| 2026-08-02 | Real-Ollama preflight and Requirement 26.2 proof are **different artifacts** | The preflight is deliberately useful but narrower: production sidecar, fresh index, operator-supplied loopback Ollama with identity/model endpoint checks, edit, verification, exact bytes. It starts no stub or fake fallback, yet it does not attest process provenance, install the Tauri app, exercise UI review/apply, or observe process-level egress. Its JSON labels those limits. Only the retained clean-snapshot procedure in `OFFLINE-PROOF.md` can close 12.2. |
| 2026-08-02 | No-egress means **raw process-attributed attempts**, not a source scan or firewall success | A denied connect is still attempted egress; a packet trace without PID attribution cannot distinguish Sketch from Ollama or the OS; a process list without packets can miss DNS. The proof therefore retains packet/DNS/socket data plus process start/exit identity and treats gaps, dropped records, unresolved PIDs, and any non-loopback attempt as inconclusive/failed. |
| 2026-08-02 | Cross-platform packaging means **one native runner per OS**, never a renamed runtime | The sidecar embeds `process.execPath`; setting `SKETCH_TARGET_TRIPLE` only changes its filename and cannot turn a Windows Node executable into a macOS or Linux binary. Each job therefore builds and verifies its own sidecar before Tauri packaging. |
| 2026-08-02 | Keep the PRD's size target as strict **`<100,000,000 bytes` per deliverable** | “100 MB” is decimal and `<` excludes the boundary. The measured object is the largest distributable NSIS, DMG or AppImage artifact, not unpacked app bytes or debug output. The current 87 MiB uncompressed Node runtime makes the margin explicit rather than silently raising the target. |
| 2026-08-02 | A packaging workflow is **not build evidence** | Source tests prove that three native jobs, sidecar verification, budget enforcement and artifact upload are wired. Only a successful native job and its uploaded SHA-256 size manifest prove an OS build exists. Task 12.1 stays open until all three do. |
| 2026-08-02 | The detailed eval seam is **additive** | `runEvalDetailed` returns both the score and actual run while `runEval` remains the result-only wrapper. Existing callers and exactly-one `eval_scored` semantics remain unchanged, while benchmarks can project real timing, events and verification. |
| 2026-08-02 | Fixtures are **content-pinned and freshly copied per attempt** | Formatting-independent suite identity is not enough if fixture bytes drift or one attempt contaminates another. Every regular fixture file participates in the digest; symlinks/special entries are refused; every attempt starts in a new workspace. |
| 2026-08-02 | Unknown manual edits and cost are **`null`, never zero** | An automated run did not observe human edits, and an unpriced model is not free. Null preserves the distinction between measured zero and not measured. |
| 2026-08-02 | Benchmark completion comes only from **`EvalResult.passed`** | A completed process, a model saying done, or green unrelated stages are not task completion. The same eval checks that define the case define completion. |
| 2026-08-02 | Build and test metrics use the **canonical verification stages** | Re-parsing command names would create a second verification vocabulary and eventually report a green benchmark beside a red verification contract. |
| 2026-08-02 | The **entire fixed budget** is comparison identity | Same model and same `k` are insufficient if one side receives more calls, tokens or time. Any budget-field mismatch is refused rather than subtracted as lift. |
| 2026-08-02 | Lift is strict `>` and a tie retains the incumbent | More orchestration without measured improvement is extra cost and complexity, not a win. `>=` was mutation-tested and failed two tests. |
| 2026-08-02 | Offline CI evidence is labelled **synthetic, never public model evidence** | The scripted executor proves harness plumbing and catches regressions deterministically. It says nothing about a real provider, so public reporting remains blocked until several real same-model pairs are deliberately run and recorded. |
| 2026-08-02 | The Benchmarks panel is **read-only** | Mounting a reporting surface must not spend tokens or execute project code. Only an explicit bench command writes reports; the panel validates and renders the latest artifact. |
| 2026-08-02 | Benchmark artifacts are **validated and atomic** | Reports are parsed against an exact schema, recomputed metrics and forbidden secret/config-shaped keys before a temporary file is renamed into place; readers never accept half-written or self-inconsistent evidence. |
| 2026-08-03 | A role's verification signal is a **union of three kinds**, not a verify stage | The first draft assigned each of the thirteen roles a stage and claimed the assignment was pairwise-unique. It cannot be: thirteen roles over nine stages. What it actually bought was the Planner graded by `typecheck` and the Research role graded by `lint` — checks that never look at a document, running green for reasons unrelated to the role's output, which is the exact failure this project keeps finding. So `RoleSignal` is `verify-stage` for roles that write or measure code, `plan-artifact` for the ones whose output IS the plan, and `citations` for the findings roles. "Distinct" means each role has a signal of its own, and a test asserts the impossible uniqueness claim is gone (Requirement 24.6) |
| 2026-08-03 | A role that cannot be checked is **skipped, twice**, and never run-then-believed | `runTask` returns `ok: true` for a task with no verification configured, which is right for the single-agent case and catastrophic for a role: hand thirteen roles an empty policy and you get thirteen confident nothings that read as unanimity, and it is invisible from outside. So there are two independent refusals — `partitionRoles` before a token is spent, and `gradeRole` refusing a `verify-stage` role with zero verify results however `run.ok` reads. Two guards for one hazard, because this is the one failure mode of a multi-agent system that cannot be seen in the output (Requirements 24.5, 24.6) |
| 2026-08-03 | Two proposals for one path is a **conflict, full stop**, and file granularity is the honest limit | Requirement 24.7 says a conflict is never guessed, and the temptation is a three-way merge. But `loop/edits.ts` emits whole-file replacements deliberately — one hunk, so a reviewer cannot accept a grouping the model never proposed — so two of those for one path, computed from the same base, cannot be combined without inventing which lines belonged to whom. Splitting them into finer hunks by heuristic IS the guess. So the rule is one proposer per path or nobody, including the case of one role proposing twice, and the conflict leaves as a task with both sub-run ids on it. Coarse, and stated as coarse rather than discovered later |
| 2026-08-03 | Consensus **gates the merge**, and returns `null` outside `swarm` | Merging first and then discovering the Security role objected would mean the objection arrived after the bytes. So grading happens, then consensus, then the merge — and a blocked swarm writes nothing at all, with the findings leaving as a follow-up task. `null` rather than a permissive verdict for `single` and `plan-then-code` because Requirement 24.9 says consensus runs only inside swarm, and a caller that received `{ reached: true }` from a strategy with nobody to agree with would eventually treat it as agreement. The bias is towards stopping: a false stop costs a human a minute, a false ship costs whatever the security finding was about |
| 2026-08-03 | Escalation requires failing **within** the budget, and a budget breach is not that | Requirement 24.3's load-bearing word is "within". A run that failed verify, or exhausted its turn cap, was given its budget and did not succeed — there is a case for spending more. A run cut off by the money ceiling, an abort, or a provider error never got its budget, and escalating would turn one ceiling into thirteen bills while the user believes a ceiling is in force. `ESCALATABLE_REASONS` is that distinction as data rather than a condition inline, because getting it wrong is a money bug and a money bug should be a list somebody can read |
| 2026-08-03 | The dispatcher emits under its **own slice**, with `component: 'dispatcher'` and no `policy` key | `strategy_selected` already had two emitters, both the Phase 8 cost router inside `runTask`, and `budget.test.ts` finds them with a bare `.find(kind === 'strategy_selected')` — so a dispatcher event landing earlier in the same slice would be picked up instead. Beyond the test, the two decisions are different in kind: the router picks a model tier, the dispatcher picks a strategy, and one payload shape meaning both would make the log unreadable. A swarm is also N runs with no single run to belong to, so the ladder gets a dispatch id and sub-run ids derive from it as `<dispatchId>-r<n>` — distinct even under a frozen clock, and readable, so a person can see the parent without a lookup |
| 2026-08-03 | `shouldDefaultToSwarm` has **no override parameter**, and no data can never enable | Requirement 24.8 permits `swarm` as a default only on measured pass@k lift. A `force: true` escape hatch would be used, and the requirement would become a comment. So the only input is two reports, the comparison is strict `>`, an empty report scores 0, and reports with different `k` or different case ids are **refused as incomparable** rather than subtracted — a pass@10 beating a pass@1 is a bigger budget, not lift, and quietly subtracting the two is how that ships as a result. On this repository's own suite the verdict is off, and the gate asserts the off (Requirements 24.8, 25.3) |
| 2026-08-03 | pass@k is a **sibling** of `runEvalSet`, not a flag on it | `runEvalSet` takes one `deps` for the whole set and is sequential by design, so it cannot express "k attempts, and the attempts may differ" — which is the entire point of k. Bending it would mean a `k` parameter every existing caller ignores, or a mutable deps factory smuggled through it. A sibling function calling `runEval` k times changes nothing about the existing harness and scores identically, so the two are comparable. `passAt1` and the per-case distribution are always populated, because `passAtK` on its own is the flattering number and Requirement 25.3 asks for the distribution |
| 2026-08-03 | Role capabilities are **intersected** with the run's grant, and the dispatcher builds no dispatcher | A role table is a narrowing device. If it could add a capability the caller was not granted, thirteen roles would be thirteen ways around the one authorisation point — the Deployment role asks for `proc:spawn` and gets it only from a run that already held it. And the dispatcher does not construct a `ToolDispatcher` itself, for the same reason the loop does not: resolving a grant means knowing which skill is speaking and what the registry granted it, which is the caller's knowledge. Omitting the `toolsForRole` factory means role sub-runs get no tools and every `tool` action is refused, which is the loop's own honest default (Requirements 11.5, 24.5) |
| 2026-08-03 | The AI Team panel reports what CAN be verified and **no per-role status** | Same correction the MCP panel made, for the same reason. A role exists only inside a dispatch: the dispatcher partitions, runs the verifiable ones, grades them, and it is over. Between dispatches there is no working role and no idle one — there are no roles. So `strategy-catalog` answers whether this project configures a stage that could grade each role, the skipped rows are shown WITH THEIR REASON because that is the load-bearing fact, and live activity is derived from `strategy_selected` events. Three fixtures died for this: four local agents with `1 working`, twelve `state.agentTeam` entries, and `TaskEntry` (Requirements 27.1, 27.5, 14.6) |
| 2026-08-03 | Task state is a **projection of the event log**, so `AppState.tasks` is deleted | Fourth vocabulary for the same idea, and the array was never populated or read. A task IS a run, and a run's whole story is already append-only: prompt, adapter, iterations, verify rows, terminal reason. `projectRuns(events)` derives the rows, which also means the panel cannot disagree with the Timeline. The invented per-row costs went with it and were not replaced — the Cost panel owns the money number, and a second figure here would be a second source (Requirements 20.2, 14.6) |
| 2026-08-03 | Superseding **appends a close op**; no memory line is ever rewritten | The same append-only discipline as the event log, and here it forces a design decision rather than merely describing one: closing a window cannot mean editing the row, so the store writes `{op:'close', id, validTo, reason, by}` and `readAll` folds the ops. The alternative — writing only the new row and deriving the old one's end from the next row's start — breaks the moment two entries with the same key arrive out of order, or one is expired with no replacement. `validTo` on the OLD row is what makes "what did we believe in March" a lookup instead of an inference, and that question is the entire reason versioned memory exists (Requirements 21.2, 21.7) |
| 2026-08-03 | Retrieval **excludes retracted entries by default**; the panel shows them | Two opposite defaults, for two different readers, and both are load-bearing. A withdrawn fact presented to a model as current is worse than no memory at all, because the model trusts it and the user cannot see why the output is wrong — so retrieval and the prompt digest exclude closed rows, and the gate asserts the digest specifically. But a history a user cannot see is a history they cannot correct, so the panel shows closed rows greyed and labelled with their reason: "why does the agent think we use REST" is answered by seeing the row that said so and when it closed (Requirements 21.5, 21.6) |
| 2026-08-03 | Recency is a **bounded prior**, capped below the rerank boost, never a sort | A newer memory is usually the right one, so recency has to count. But sorting by it makes memory a stack, and the most useful entry is frequently an old architectural decision that explains everything — exactly what a recency sort buries. So it is a multiplier capped at 0.5 against a rerank boost of 1.0: recency is weaker evidence than actually matching the question, and a strongly matching old entry still beats a barely matching new one. `recencyBoost` is exported so a test pins the curve rather than inferring it, and that test caught a real inversion where an infinitely old entry received the maximum boost (Requirement 21.5) |
| 2026-08-03 | The lint pass **reports; it never supersedes** | Requirement 21.4 asks for a lint pass for contradictions, and a lint pass reports. The tempting alternative is deciding from prose which of two decisions is stale — and that would eventually discard the correct one, at which point a user has a memory store that silently deletes true things and no way to debug it from outside. So findings carry `certain` / `likely` / `possible`, name the entries, and suggest; the user decides. What IS automatic is superseding on kind AND key, because a second `standard` keyed `test-location` is an explicit statement of identity by whoever wrote it, and treating that as a contradiction would be pedantry (Requirements 21.3, 21.4) |
| 2026-08-03 | Expiry has **no default ages**, and `source: 'user'` is exempt | A default expiry would silently delete a project's architectural decisions after some number this file chose, and the right answer differs completely per kind and per project — a `test` outcome is stale in a week, an `architecture` note can hold for years. So a caller that wants expiry says what it wants expired. And a person who wrote something down deliberately does not get overruled by a heuristic: user entries are never auto-expired or auto-superseded, though they can still be superseded by another user action (Requirement 21.4) |
| 2026-08-03 | `fuseRankedIds` extracted so the RRF arithmetic has **one** implementation | Requirement 21.5 says reuse the Phase 5 path, and `hybridSearch` itself cannot be reused — it is bound to a `RepoGraph` and reads files from disk, while memory entries are rows. The two bad options were writing memory out as files to fit the signature, or copying the scoring rule. Both were refused: `RankedItem` carries `path`, `chunkIndex` and line numbers, so forcing rows through it would mean inventing file coordinates that a surface would eventually display, and a second copy of a scoring rule drifts invisibly in the output. So the arithmetic moved into a generic over ids and `reciprocalRankFusion` became a thin wrapper that re-attaches the code-specific fields |
| 2026-08-03 | The legacy `ProjectMemory` is **bridged, not rewritten** | `orchestrator.ts` is a live caller using four members, and it is documented as not yet wired into the new loop. Changing its dependency to fit Phase 9 would be a breaking edit to working code that gains that code nothing. `legacyProjectMemory` satisfies the old interface over the new store, so an orchestrator run through it gets validity windows and supersede-with-a-reason underneath without learning any of it exists. Where the models do not line up, the mapping is stated rather than silent: `setStandard` becomes a supersede (strictly more informative — the old value survives with its window), caller-supplied ids are kept in `data.legacyId` rather than discarded, and `test` history is written unkeyed so a run's outcome follows the previous one instead of replacing it |
| 2026-08-03 | A `MemorySource` value is spelled `imported`, because `'import'` trips the dependency guard | Third occurrence of this exact shape. `test/deps.test.ts` scans for `import <quote>` literally, so the bare literal `'import'` reads to it as the `import` KEYWORD followed by a quote — as `['from', 'into']` did in the retrieval stopword list, and as this task's own explanatory comments did to the desktop fixture guard. The guard is right to be that literal: it is the thing standing between this package and a silent dependency. Each time, the DATA moved. Recorded a third time because the next person to write a string union in this package will hit it again (Rule 1) |
| 2026-08-02 | An unpriced model costs **`null`, never `0`**, and the ledger counts those calls separately | This is the single most expensive lie a cost surface can tell. `$0.00` for a model that is not in the price table means the user sees free, leaves it running, and finds out from an invoice — and it fails in the direction that costs them money, which is the direction to be paranoid about. So `null` propagates: a run with one unpriced call reports a priced subtotal *and* `unpriced: 1`, and `describeLedger` calls the total a lower bound. The consequence is accepted rather than worked around: a currency budget cannot constrain an unpriced model, which is exactly why `maxTokens` exists beside `maxUsd` and why `describeBudget` warns about a currency-only policy (Requirements 20.1, 20.3) |
| 2026-08-02 | The money number is a **pure function of the event log**, with no second source anywhere | Fifth time this codebase has made the one-source bet — one file cache (3.1), one authorisation point (6.3), one skill-state home (6.4), one way to read a run (7.5) — and cost is the highest-stakes instance, because the number is money and a user will act on it. A running counter and a log agree right up until they do not, and when a *money* figure disagrees with itself nobody can tell which half to believe. So `ledgerFor(events)` and nothing else: no counter in the loop, no subtotal on the seam, no `totalCost` in `AppState`, no accumulation in the panel. It also makes 8.5's reconciliation an **equality** rather than a tolerance, which is the only version of that test worth writing (Requirement 20.2) |
| 2026-08-02 | Nine price tables collapsed to one, and `PRICED_AT` travels with every figure | Three private `COSTS` tables meant three answers to "what did that cost", and six `estimateCost` overrides returning `0` meant a real run on Groq or OpenRouter reported **free** — the same drift the provider catalog and the secret-pattern table were centralised to avoid, but with money attached. One table, one `estimateCost` in `BaseAdapter`, and a test asserting no module outside `cost/` declares a per-model price. The date is part of the data because a table without one implies live pricing, which this product cannot do without a startup network call it refuses to make; `costFor` flags itself stale after 180 days and the panel says so (Requirements 20.1, 20.8) |
| 2026-08-02 | `onBreach` is **required, with two values and no default** | Requirement 20.4 asks for deterministic-by-configuration, and a default would have quietly made that choice on the user's behalf — the worst outcome, because it is the one they never see. Forgetting it is now a compile error. `downgrade` is also held to meaning something: with no cheaper adapter it becomes a stop and the event records `outcome: 'stopped'` with the reason, because a run reporting "downgraded" while calling the same expensive model is worse than one that stops (Requirements 20.4, 20.5) |
| 2026-08-02 | The pre-flight projection uses the **largest call observed in this run**, and the residual overshoot is stated | The gate caught a 600 000-token ceiling being overshot to 750 000 *while the guard reported success*: a ~1 500-token prompt estimate was being compared against calls that really cost 250 000 each. After one call there is better evidence than a guess — what a call in this run actually cost — so the projection uses the worst observed, largest rather than mean because a ceiling that holds on average is not a ceiling. What no pre-flight check can do is guarantee the ceiling is never crossed, since the first call's cost is unknowable before making it; the guaranteed bound is therefore *ceiling plus one call*, and that sentence is in `describeBudget` rather than in a comment nobody reads (Requirement 20.3) |
| 2026-08-02 | The response cache stores the response but only the **hash** of the request | This is the first cache in the project to store model output, and `embedding-cache.ts` next door deliberately stores no text at all with a test asserting it — so the difference needed a decision rather than a default. The response has to be stored: replaying it is the entire feature. The prompt does not, and it routinely contains the user's source and occasionally a secret they pasted. A hash is enough to match a repeat and useless to anyone reading the directory. Every option is in the key, sorted, because a cache that ignores `temperature` returns a wrong answer **with total confidence**, which is worse than a miss by a wide margin — a miss costs money, a wrong hit costs correctness and is invisible (Requirement 20.7) |
| 2026-08-02 | The status bar shows a **button**, not a figure | A live total in the corner of the window would be a second cost source by definition, and two money numbers disagree eventually — at which point the user has to work out which one lied. Deleting `$1.4025` without replacing it is the honest move: the panel owns the number, the bar links to it. The same reasoning retired three neighbouring fixtures, and `0 errors / 2 warnings` is worth naming separately — a status bar claiming two warnings while the editor shows none teaches the user to ignore the status bar, which is a durable cost for a decorative gain (Requirements 20.8, 27.3, 14.6) |
| 2026-08-02 | The comment stripper the fixture guards need lives in **one** place, with a self-test | Two guards in two files needed it, and copying it was tempting and wrong: a duplicated guard mechanism drifts, and this drift would be **silent**, because a stripper that removed too much would make every assertion built on it pass for no reason at all. A false positive is loud; a hollow guard is not. `testing/source.ts` holds it and `testing/source.test.ts` proves it keeps code, string literals, JSX and a `//` inside a URL while dropping prose. Third time the "comment tripped the guard" shape has appeared — after `deps.test.ts`'s stopword array and task 7.4's `mcpToolsStatus` — so it is now a shared tool rather than a lesson to relearn (Rule 4) |
| 2026-08-02 | `skipped` and `not-run` stay **different words** all the way to the panel | Nothing ran in either case, so the temptation is one grey badge. But they call for opposite responses: `skipped` means this project configures no command for the stage and the fix is to configure one; `not-run` means an earlier stage failed and the sequence stopped, and the fix is above. Collapsing them also hides the more dangerous reading — a wall of grey that a user interprets as "fine". The same reasoning is why `verifiedAnything` exists: `ok` is true for a project that configures nothing, and that must never read as evidence (Requirements 4.3, 4.8) |
| 2026-08-02 | Live feedback is **how the `integration` stage is performed**, not a tenth stage | Requirement 4.3 fixes nine stages. Adding a tenth would have meant either editing the contract or putting a check outside the `ok` rule, and the second is worse: a runtime error that does not count is a runtime error nobody acts on. So `policy.live` runs after the integration stage's commands and its verdict counts exactly like theirs. Its full verdict is carried separately from its result row because a row cannot say `failed-to-start` versus `runtime-error`, and those point at completely different bugs (Requirements 4.3, 23.2) |
| 2026-08-02 | The MCP catalog is **data in this repository**, pinned to exact versions, with no runtime name resolution | Requirement 22.2 asks for curated, pinned and isolated. So the list is a committed table and there is deliberately no code path that turns a server name into a command at runtime: adding one is a diff where the argv and the capability it costs are both visible. `@latest` is forbidden and asserted, because a command that changes under you means a supply-chain compromise arrives silently on the next invocation. Honestly labelled: these are launch descriptions for third-party packages, fetched by the user's own package manager, **not audited here** — the content pin that protects skills cannot reach them without vendoring (Requirement 22.2) |
| 2026-08-02 | A hang **latches** the server off for the run, and the latch is per-server | Timing out is the easy half. Requirement 22.3's middle clause — unavailable "for the remainder of the run" — is the half a naive implementation misses, and the cost of missing it is linear in retries: a model attempting three tools against a dead 20-second server spends a minute of the run waiting for something already known to be broken. One timeout is paid; the rest are free. Per-server, because a run whose GitHub server hangs must still be able to read a file. The process is killed as a group rather than left alive to be polite: a hung server holds a pipe, a port and often a lock, and leaving it means the next run inherits the mess (Requirement 22.3) |
| 2026-08-02 | A server the run's grant cannot reach is **not started**, not merely refused | Refusing the calls is enough for correctness. Not spawning is stronger: a process that never launched cannot read a token from the environment, cannot open a socket, and cannot download a browser. So `run` consults the grant before `host.open`, and the refusal is logged by id and capability so a user can see why a server they expected is absent. The grant itself comes from the loaded skills and **nothing on the wire can widen it** — there is deliberately no `params.capabilities`, because consent is recorded at install time and a request parameter that could add `proc:spawn` would make that consent decorative (Requirements 22.4, 11.5) |
| 2026-08-02 | The MCP panel reports **`configured`, never `connected`** | The honest correction to a fixture, not a shortcut around one. Servers start per run and only for the capabilities that run holds; the unavailability latch is per-run by definition, and a host outliving a run would carry a dead server's verdict into a run that might have worked. So between runs nothing is connected and there is no number to show — `{ connected: 5, total: 8 }` was false in a way no smaller value would fix. What a user can usefully know beforehand is whether a server *could* start, which is a list with reasons and therefore a panel rather than a badge (Requirements 22.5, 27.5) |
| 2026-08-02 | The `verify` RPC method **resolves by default and runs only when asked**, and a run defaults to a full report | Two opposite defaults, for two different readers. Resolving is a file read, so it may happen on mount; running executes the project's build and test suite and, for a policy with a live check, binds a port — that cannot be a side effect of clicking a sidebar icon. And when it does run, `continueOnFailure` defaults to **true** here and only here: the loop is fail-fast because the first failure usually explains the rest and a model does not need eight more, but a user reading a report wants to know that lint failed *and* the tests fail, not to fix lint and discover the tests separately (Requirements 4.5, 27.1) |
| 2026-08-02 | The rule that **tool output is never an instruction** lives in the system prompt, unconditionally | `framePayload` marks every tool result as untrusted data, but a frame with no rule attached is decoration. The rule is stated in `systemPrompt`, which every run gets, rather than in the tools block a caller only receives when a dispatcher was supplied — a future path that registers tools without going through `contextMessages` would otherwise ship the frame and lose the rule. It is also honest about what it can achieve: this is not a sanitiser and cannot be, because the text has to reach the model intact to be useful. Enforcement is the capability gate; this is the model being told what it is reading (Requirements 22.1, 11.5) |
| 2026-08-01 | The registry hashes the **whole skill directory**, bytes not strings, and calls itself a content pin rather than a signature | A skill is prose plus executables — the folder layout has `tools/`, `workflows/`, `tests/` — so hashing `SKILL.md` alone protects the half that does not run. Files are read as bytes because a CRLF checkout genuinely is a different artifact, and normalising would mean a tampered file could match. The path is hashed with the content, so moving a script into a name the manifest trusts is not free. And it is named honestly: it proves *what* you install, never *who* wrote the manifest — a homemade signature scheme would be worse than an honest pin, and the trust root is the signed release that 26.3 still owes (Requirements 11.1, 11.2) |
| 2026-08-01 | The six packs are **written for this project, not vendored** from a community repo | Vendoring means a network fetch, a license review, a recorded commit SHA, and shipping scripts that will eventually run with the user's permissions — none of it work to do implicitly while seeding a registry. Every seed here is prose, so the whole set is installable before the tool layer exists without anyone running a stranger's Python. The format stays compatible on purpose: any `SKILL.md` directory can be pinned by `pinRegistry` and installed by `installSkill` with no change to either, so adapting community skills is a later deliberate act with its own review step (Requirement 11.3) |
| 2026-08-01 | The capability vocabulary **fails closed**, and an absent key differs from an empty one | Ignoring an unrecognised token reads as safe and is not: the skill installs, is granted nothing, and behaves inexplicably while the user believes it has access. The same leniency across versions means an old build silently drops a capability a newer manifest granted, so a skill audited as sandboxed on one version is something else on another. An unknown token is therefore an error in both directions. `capabilities:` absent → `fs:read:project` only, because a skill that cannot read the project can do nothing and a useless default pushes publishers into asking for everything; `capabilities: []` → nothing, because the publisher said so (Requirements 11.4, 10.6) — **the "absent" half of this row was superseded 2026-08-03**: the default is now `fs:read:project` + `git:read`, for the reason given in the newer row at the top of this log. The `capabilities: []` half and the fail-closed rule still stand unchanged. |
| 2026-08-01 | Enforcement is **one function**, and a denial is a **result** | Third time this codebase has made the bet — one `hasPlan` in `runTask`, one `resolve_within` in `command_policy.rs`, now one `#authorised` in `ToolDispatcher`. What makes it work is not the check but that there is nowhere else to look; a capability system with two dispatch paths has one hole. The prompt's tool list goes through the same predicate so the two cannot drift. And `call` returns `{ ok: false }` rather than throwing: the most demanding community skill reads ~20 network sources and must still be useful when nineteen are denied, because a sandbox that turns "did less" into "broke your task" is a sandbox users switch off (Requirements 11.5, 22.4) |
| 2026-08-01 | The optimizer may rewrite the **body and nothing else** | An optimizer that could rewrite `capabilities:` would be a privilege escalation with a training run as its delivery mechanism: propose a body that also asks for `net:http`, score well on unrelated cases, and the strict gate accepts a skill that can now reach the network. Closed twice — the candidate is built as `{ ...incumbent, body }`, and a proposed body's own frontmatter is stripped so the written artifact cannot contain a second block the loader would read instead of ours. The mutation run confirms the second guard is load-bearing, not decorative (Requirements 9.1, 9.5) |
| 2026-08-01 | An **open** registry requires an approved review OF THE PINNED BYTES | Requirement 11.6's review queue is only real if something refuses. So an entry from an `open` registry is installable only with `decision: "approved"`, and a review that records the digest it examined is **invalidated when the content changes after it** — otherwise a submitter gets one approval and inherits it for every later re-pin. Curated registries need no per-entry record: curation is the review and the manifest is committed and diffable. The shipped registry stays `curated`, asserted by test, so flipping one string cannot quietly mean "install anything" |
| 2026-08-01 | `SKETCH_REGISTRY_DIR` and an explicit param, with **no path-relative default** | The sidecar is one esbuild-bundled file copied next to the app binary: no `node_modules`, no package layout, nothing at a path relative to `import.meta.url`. A default computed that way resolves in tests, resolves from `dist/`, and points at nothing in the shipped app — and `cli.test.ts`'s sidecar-hazard guard caught exactly that during this task. With no registry configured the catalog reports it and names the parameter, which is an honest nothing rather than an empty list that reads as "there are no skills" (Requirements 12.7, 27.3) |
| 2026-07-31 | Retrieved context reaches the loop as a **string**, and the RPC assembles it only when asked | The loop does no retrieval, owns no budget and reads no index: `assembleContext` enforces the budget *before* the text is built, and re-deciding it inside the loop would mean discovering an overrun after the money was spent. It is kept separate from `projectContext` because `AGENTS.md` is a standing instruction the user wrote while this is a retriever's guess for one query, and a model that reads a guess as a rule will obey a file it merely happened to find. Opt-in via `contextBudgetTokens` rather than on by default: retrieval adds tokens to every request on a paid provider, and the guard that would bound that spend is Phase 8 (Requirements 18.4, 18.6) |
| 2026-07-31 | The lexical channel searches query TERMS, ranked by coverage, with per-term smart case | Searching the whole prompt as one fixed string found nothing, so hybrid retrieval silently became vector-only for every natural-language task — 18.2's failure mode arriving through the front door rather than through a config flag. Terms are identifier-shaped runs with stopwords removed, capped at eight (each costs a scan or a spawn), and `termsMatched` is the **first** sort key: a chunk mentioning `payments`, `retry` and `budget` once each is the answer, and a chunk repeating `budget` twelve times is not. Smart case is per term because prose is lower-case and the constant is `RETRY_BUDGET_MS`; an explicit `ignoreCase` still wins in both directions, and a single-identifier query behaves exactly as before (Requirement 18.2) |
| 2026-07-31 | The gate's baseline is allowed to win a case, and does | A whole-repo baseline truncated at the budget reaches whatever sorts first, so the fixture's `auth` domain is answerable from it — and `auth` is deliberately in the **held-out** split, making the reported rise 0.333 → 1.000 rather than 0 → 1. A comparison whose baseline scores zero measures the fixture's construction, not the retriever. For the same reason the dev split's numbers are printed next to the held-out ones instead of being quietly dropped (Requirement 18.7) |
| 2026-07-31 | The eval half is measured with an instrument, and the instrument is tested | `ContextFaithfulAdapter` answers only from the text it was given and refuses otherwise, which makes the score a measurement of retrieval rather than of a model's mood, and lets the gate run offline at $0. Its honesty is asserted directly: handed an empty context, or another domain's files, it must score 0. What it cannot do is show that a real model reasons better on less context — that claim is not made anywhere, and nothing here has ever run against a real provider (Requirements 18.7, 1.6) |
| 2026-07-31 | The stopword list is one space-separated string, because the zero-dependency guard reads source literally | Written as an array it contained `'from', 'into'`, which `deps.test.ts` parsed as a bare import specifier and failed the build — correctly. The guard is the thing standing between `packages/core` and a silent dependency, so the **data** moved rather than the guard being widened. Recorded because the next person to write a word list here will hit it again (Rule 1) |
| 2026-07-31 | Fonts are vendored into the package, not fetched from a CDN | `index.html`'s two `preconnect` hints and Google Fonts stylesheet were a third party contacted on launch, before any user action, in a product whose claim is that nothing leaves the machine unasked. The packaged CSP blocked the stylesheet and the font files, but **no CSP directive covers `preconnect`** — the DNS lookup and TLS handshake could still disclose the IP and the fact that the app started, so the policy was not a control and the tags had to go. Two latin-subset variable woff2 files (88 KB together) replace seven static weights, ship their OFL text, and are served from the app's own origin. `privacy.egress.test.ts` fails the build if any file under `packages/*/src` or `index.html` names a font CDN, references a non-loopback URL in a subresource position, or declares a `preconnect` / `dns-prefetch` / `prefetch` / `preload` hint. A provider endpoint is deliberately not a finding: it is not a subresource and PRIVACY.md §1 documents it (Requirements 17.7, 26.2) |
| 2026-07-31 | `providers.json` is guarded in layers, and the byte-level check is the one that counts | Three independent things must all fail before a key reaches that file: `sanitizeEntry`'s five-field **whitelist** (an unnamed field cannot survive, so a future `token`/`secret`/`bearer` spelling needs no maintenance), `serializeProviderSettings`'s re-projection of those same five fields, and `assertKeyFree` on the **serialized bytes** against the shared pattern table — which is what catches a key smuggled inside a whitelisted field, such as a `baseUrl` with `?api_key=…`. The mutation run proved the layering is real rather than decorative: leaking the field through the whitelist failed three tests while the bytes on disk stayed clean, and only breaking the projection as well reached the file. Tests assert bytes, never objects (Requirement 17.2) |
| 2026-07-31 | Deployment metadata is registry-owned, never persisted in a settings entry | `serverless` and `keyRequired` describe a provider, not a user's choice, so they are looked up from `ProviderDescriptor` by id at render time instead of being written into `providers.json`. A persisted copy would go stale the moment the catalog changed, and a stale row would tell the user a cost, latency and privacy story the engine no longer agrees with. The persisted entry is exactly the five fields a user actually decided: `id`, `kind`, `baseUrl`, `model`, `label` (Requirements 17.1, 17.2) |
| 2026-07-31 | `SecretStore` stays in core with **no** implementation that persists | Requirement 17.3 reads as layering; it is a security property. An engine with no code path to a credential store cannot leak one, and a zero-dependency engine has no native module that could. So core ships the seam, a process-lifetime `Map` with no `node:fs` import, and a default whose three methods **throw** — a default that returned `null` from `get` and swallowed `set` would look like an empty keychain, and "your key was silently discarded" is the worst failure mode this seam has. Real storage lives in Rust, where the platform-specific half already belongs, with no file fallback anywhere near it (Requirements 17.3, 17.4) |
| 2026-07-31 | The IPC credential surface is presence-only: there is no read command | `list_providers` returns provider ids and a `has_key` boolean. Nothing returns a key value — not truncated, not a four-character prefix, because four characters of a secret are still four characters of a secret. A key that cannot re-enter the webview cannot reach a console log, an error boundary, a crash dump or a screenshot. The cost is stated rather than hidden: **a stored key cannot reach a model call today**, so Requirement 17.4 is half-wired and the run path still needs a key the user just typed. Choosing where the key crosses — Rust straight to the sidecar's stdin, or the sidecar reading the OS store itself — is a spec decision, not a gate improvisation (Requirements 17.3, 17.4) |
| 2026-07-31 | The IPC boundary is asserted statically, because a double above it can never prove what serde emits | `read_dir` returned `is_dir` and `bridge.ts` read `isDir`, so every directory rendered as a file in the shipped app while the suite stayed green — the doubles sit at the TypeScript seam and built entries in the intended shape. `CommandOutput.exit_code` had the identical defect. The fix is not a better double: `ipc/wireShape.test.ts` reads `main.rs` and `bridge.ts` together, the only place both sides of the boundary are visible at once, and asserts every returned struct's serialized field names against the declared interface. Tauri camelCases *arguments* and does nothing to a *return* value, which is precisely the asymmetry that produced the bug (Requirements 13.8, 27.5) |
| 2026-07-26 | Scope Tauri capabilities & CSP | Prevents arbitrary filesystem and shell access from untrusted webview content |
| 2026-07-26 | Dev bridge SSE + POST transport | Allows browser dev mode to connect directly to `@sketch/core` engine without external server dependencies |
| 2026-07-30 | One file-state owner: `AppState.files[path].content`, Monaco as a projection | Two caches for what a file contains diverge, and the user loses work. Exactly two functions cross the boundary — `ModelRegistry.sync()` (state→model, the only `setValue` in shipped code, asserted by a source-level guard) and one `onDidChangeContent` (model→state). `sync` suppresses the change callback for its own write because Monaco fires the same event for `setValue` as for typing. Everything else — the reviewer applying hunks, the engine writing a file, a reload — goes through the reducer, so the editor cannot hold a version of a file that nothing else agrees with (Requirement 15.2) |
| 2026-07-30 | The diff engine lives in core, not the UI | `parseUnifiedDiff` and `applyHunks` are pure functions in `packages/core/src/diff/hunks.ts` with no I/O and no dependency, so the data-loss-shaped cases — CRLF, a missing trailing newline, out-of-order and overlapping hunks, a stale proposal — are tested directly instead of through React. The React surface owns only verdicts. It also means the CLI and eval paths could review hunks later without a second implementation |
| 2026-07-30 | The UI plan gate is a run-scoped projection, never an authorisation cache | `DiffReview` computes `plan_written && runId === selected.runId` from the shared event log on every render. Keyed by run, because a plan for run A says nothing about run B; recomputed rather than stored, because a remembered "unlocked" bit is exactly the in-memory belief the engine gate was designed not to trust. The engine still asks `PlanWriter.hasPlan(runId)` of the filesystem before every edit and may refuse when the UI thinks a plan exists — the engine wins and its refusal is what the user sees (Requirement 16.4, defence in depth over Requirement 6.5) |
| 2026-07-30 | Reject-all is proven by counting writer CALLS, not by comparing bytes | "The file did not change" is satisfied by rewriting identical content, which still bumps the modification time, wakes every watcher and shows up in a build. So the reject-all path never reaches the file layer — no read, no write — and the test asserts the writer was called zero times. A byte-comparison test would pass for the wrong implementation; a call count cannot (Requirement 16.5) |
| 2026-07-30 | The file tree is lazy and derived, holding names and expansion state only | Children are read on expand, never on mount: an eager walk of this repo's own `node_modules` would hang the window. The tree deliberately stores no file content, so it cannot become the second cache decision 1 above exists to prevent, and `.gitignore` handling is reused from the existing walker rather than re-implemented as a second matcher |
| 2026-07-30 | Every panel renders engine and command output as text nodes only | Terminal output, search hits, diff hunks and git output are all attacker-influenced — model output or process output about file contents — and the app's CSP still carries `script-src 'unsafe-inline'`, which makes an injection an execution. No `dangerouslySetInnerHTML`, no `innerHTML`, no `insertAdjacentHTML`, no `DOMParser` in any Phase 3 panel, asserted by a source-level guard so a future "nicer highlighting" change has to argue with a red test first |
|---|---|---|
| 2025-07-25 | Use Tauri over Electron | Smaller binary, native OS APIs, Rust security |
| 2025-07-25 | **SUPERSEDED** — Use sqlite-vec over an external vector DB | This was the original local-first preference. The dependency-free core decision supersedes the implementation mandate: `MemoryVectorStore` is the shipped default, graph metadata persists separately, and any future durable vector backend must stay behind `VectorStore`. |
| 2025-07-25 | **SUPERSEDED** — Cut multi-model consensus from v1 | The cost/complexity concern remains, but the blanket prohibition is superseded by eval-gated `swarm`: `single` stays default, consensus runs only in `swarm`, and no task class enables it without measured pass@k lift. |
| 2025-07-25 | Lead with verify loop as differentiator | No existing tool owns "AI that verifies its own output" |
| 2025-07-25 | Use OpenRouter as onboarding path | One key covers many models, reduces friction for new users |
| 2026-07-26 | Migrate to an npm workspace under `packages/` | One root `npm install`, one `npm test` that covers both packages, and a `@sketch/core` the desktop package consumes by name instead of by relative path. The move also gave the migration a safety net: the pre-existing tests had to keep passing |
| 2026-07-26 | Dependency-free core; `better-sqlite3`, `sqlite-vec`, `keytar`, and the MCP SDK replaced by seams | Native/runtime packages would have meant a compiler on contributors' machines, rebuilds per Node version, and a sidecar that cannot be one bundled file. `EventStore`/`MemoryStore` use JSONL/file defaults, `VectorStore` uses a memory default, `SecretStore` is implemented by the Rust host, and MCP uses hand-rolled JSON-RPC 2.0 over stdio. Future backends may drop in behind those seams without becoming mandatory core dependencies. Supersedes `trd.md`'s dependency list (task 13.3). |
| 2026-07-26 | keytar dropped outright | It was never installed, is native, and is not required to express the security boundary. Phase 4 deleted the keytar-shaped `KeychainCredentialStore`; core retains only `SecretStore` plus ephemeral/test implementations, while the Rust host persists to the OS credential store with no file fallback. Stored hosted-key invocation remains half-wired and is not overstated. Supersedes Rule 6's keytar-specific wording (task 13.1). |
| 2026-07-26 | Keep the legacy `ProviderAdapter` alongside the canonical `ChatAdapter` | The legacy surface has live callers (the orchestrator, 34 provider tests) and carries streaming and cost data the canonical seam does not. Deleting it to reach one interface would have meant rewriting working, tested code inside a migration. Both surfaces are implemented by the same adapter classes; the loop only ever sees `ChatAdapter` |
| 2026-07-26 | Rename `VerifyResult` → `VerifySummary` and `RunResult` → `OrchestratorRunResult` | The canonical contracts need those two names, and the design reproduces them verbatim. Renaming the pre-existing aggregates was mechanical; bending the contract to dodge a collision would have made `types.ts` no longer the spec |
| 2026-07-26 | The event log is the single source of truth | The Timeline, replay, cost accounting, eval capture, and benchmarks are all projections of one append-only JSONL stream. No subsystem gets a private log, so the dashboard cannot disagree with the log — there is nothing else to disagree with |
| 2026-07-26 | Planning is always on; the engine plan gate is authoritative and human approval is optional | Every task persists plan artifacts before an edit, and `edit` asks `PlanWriter.hasPlan(runId)`—the filesystem, not an in-memory flag—inside `runTask`. Every caller goes through that one gate. A surface may ask a person to review/approve, but approval is not the safety precondition; the UI mirror is defense in depth only. |
| 2026-07-26 | Unsupplied plan documents are omitted, not stubbed | The gate is stated as "directory absent or empty". Writing stubs for the eight documents a `plan` action never supplies would make an empty plan structurally identical to a real one and force `hasPlan` to sniff file bodies for stub markers — a content heuristic guarding a safety precondition. With omission the invariant is flat: a document file exists iff that document was planned |
| 2026-07-26 | `verify-pass` fails when nothing was verified | The loop's `RunResult.ok` is true when no verify commands were configured, which is correct for a run. A `verify-pass` **check** asserts verification happened and passed. Inheriting the loop's reading would score an empty `verify: []` case at 1.0, and since the trainer accepts on a strictly greater validation mean, a split of such cases would hand every candidate a perfect score and turn the gate into a coin flip |
| 2026-07-26 | Strict `>` in the trainer, no epsilon | A tie keeps the incumbent. An epsilon would need a defensible value, and any value large enough to matter accepts noise as improvement. `meanScore` returns 0 rather than NaN on an empty split so the comparison stays meaningful |
| 2026-07-26 | Sequential CLI protocol with `kind:"event"` frames | Newline-delimited `{id, method, params}` in, `{id, ok, result}` out, with run progress interleaved as event frames correlated by `runId`. Frames go to stdout and diagnostics to stderr, which is what lets a sidecar be driven by a pipe with no framing library. Cost: no cancellation verb yet (see Phase 1 spec gaps) |
| 2026-07-26 | Provider registry singleton deleted | A process-global adapter cache is a process-global API-key cache. `resolveAdapter` constructs a fresh adapter per resolution; `PROVIDER_CATALOG` is data only and holds no credentials and no sockets |
