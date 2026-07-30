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
| 0.7 | Write `rules.md` | ✅ | `rules.md` exists at the repo root. Rules 6 and 4 are superseded in part by Phase 1 decisions (keytar dropped; v2 consensus behind the eval gate) — reconciliation is spec task 13.1 |

---

## Milestone 1 — Provider Adapter Layer

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

## Milestone 2 — Context Engine

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

## Milestone 3 — Verify Loop

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

## Milestone 4 — Desktop App Shell

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

## Milestone 5 — Orchestrator + Memory

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

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
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
| 2025-07-25 | Use sqlite-vec over external vector DB | Local-first, zero-config, sufficient for repo scale |
| 2025-07-25 | Cut multi-model consensus from v1 | Unproven, expensive, complex — defer with evidence |
| 2025-07-25 | Lead with verify loop as differentiator | No existing tool owns "AI that verifies its own output" |
| 2025-07-25 | Use OpenRouter as onboarding path | One key covers many models, reduces friction for new users |
| 2026-07-26 | Migrate to an npm workspace under `packages/` | One root `npm install`, one `npm test` that covers both packages, and a `@sketch/core` the desktop package consumes by name instead of by relative path. The move also gave the migration a safety net: the pre-existing tests had to keep passing |
| 2026-07-26 | Dependency-free core; `better-sqlite3`, `sqlite-vec`, and `keytar` replaced by seams | Three native modules would have meant a compiler on every contributor's machine, a rebuild per Node version, and a sidecar that cannot be a single bundled file. `SecretStore` and the existing `VectorStore` / `Store` interfaces give the same capability with the platform-specific half pushed outside core — where Rust already lives. Supersedes `trd.md`'s mandated dependency list (spec task 13.3) |
| 2026-07-26 | keytar dropped outright | Never installed, unmaintained, and native. The OS credential store is reached through the Rust side in spec task 4.2; `KeychainCredentialStore` is a seam awaiting deletion. Supersedes Rule 6's keytar-specific wording (spec task 13.1) |
| 2026-07-26 | Keep the legacy `ProviderAdapter` alongside the canonical `ChatAdapter` | The legacy surface has live callers (the orchestrator, 34 provider tests) and carries streaming and cost data the canonical seam does not. Deleting it to reach one interface would have meant rewriting working, tested code inside a migration. Both surfaces are implemented by the same adapter classes; the loop only ever sees `ChatAdapter` |
| 2026-07-26 | Rename `VerifyResult` → `VerifySummary` and `RunResult` → `OrchestratorRunResult` | The canonical contracts need those two names, and the design reproduces them verbatim. Renaming the pre-existing aggregates was mechanical; bending the contract to dodge a collision would have made `types.ts` no longer the spec |
| 2026-07-26 | The event log is the single source of truth | The Timeline, replay, cost accounting, eval capture, and benchmarks are all projections of one append-only JSONL stream. No subsystem gets a private log, so the dashboard cannot disagree with the log — there is nothing else to disagree with |
| 2026-07-26 | The plan gate is enforced in the engine, not the UI | `edit` asks `PlanWriter.hasPlan(runId)` — the filesystem, not an in-memory flag — inside `runTask`. Every caller (CLI, eval harness, desktop) goes through that one function, so there is no second path that could skip the check. The UI mirror is spec task 3.6 and is defence in depth only |
| 2026-07-26 | Unsupplied plan documents are omitted, not stubbed | The gate is stated as "directory absent or empty". Writing stubs for the eight documents a `plan` action never supplies would make an empty plan structurally identical to a real one and force `hasPlan` to sniff file bodies for stub markers — a content heuristic guarding a safety precondition. With omission the invariant is flat: a document file exists iff that document was planned |
| 2026-07-26 | `verify-pass` fails when nothing was verified | The loop's `RunResult.ok` is true when no verify commands were configured, which is correct for a run. A `verify-pass` **check** asserts verification happened and passed. Inheriting the loop's reading would score an empty `verify: []` case at 1.0, and since the trainer accepts on a strictly greater validation mean, a split of such cases would hand every candidate a perfect score and turn the gate into a coin flip |
| 2026-07-26 | Strict `>` in the trainer, no epsilon | A tie keeps the incumbent. An epsilon would need a defensible value, and any value large enough to matter accepts noise as improvement. `meanScore` returns 0 rather than NaN on an empty split so the comparison stays meaningful |
| 2026-07-26 | Sequential CLI protocol with `kind:"event"` frames | Newline-delimited `{id, method, params}` in, `{id, ok, result}` out, with run progress interleaved as event frames correlated by `runId`. Frames go to stdout and diagnostics to stderr, which is what lets a sidecar be driven by a pipe with no framing library. Cost: no cancellation verb yet (see Phase 1 spec gaps) |
| 2026-07-26 | Provider registry singleton deleted | A process-global adapter cache is a process-global API-key cache. `resolveAdapter` constructs a fresh adapter per resolution; `PROVIDER_CATALOG` is data only and holds no credentials and no sockets |
