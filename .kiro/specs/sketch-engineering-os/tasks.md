# Implementation Plan

Phase gates are hard. No phase begins until the previous phase's gate task is green. Every gate command must exit 0 **offline with no API key set** — the single documented exception is task 6.10.

---

## Phase 1 — Engine baseline

- [ ] 1. Engine baseline: contracts, providers, events, verify, loop, evals, trainer, CLI, shell
- [x] 1.1 Create the npm workspace root and relocate both packages
  - Write root `package.json` with `workspaces: ["packages/*"]` and scripts `build`, `test`, `typecheck`, `lint` that fan out to both packages
  - Move `engine/` to `packages/core`, rename the package to `@sketch/core`, add `exports`, `types`, and a `bin` entry pointing at the built CLI
  - Move `desktop/` to `packages/desktop`; update `vite.config.ts` and `tauri.conf.json` paths
  - Add root `.gitignore` covering `node_modules`, `dist`, `.sketch`, `.vite`, and build output
  - Add `LICENSE` (Apache-2.0, matching the existing package declaration)
  - Verify all 97 existing tests still pass after the move — this is the migration's safety net
  - _Requirements: 1.1, 1.2, 1.6, 26.6_
- [x] 1.2 Switch the core to NodeNext and lock the zero-dependency rule
  - Change `packages/core/tsconfig.json` to `module: NodeNext` and `moduleResolution: NodeNext`; confirm every relative import already carries `.js`
  - Add `test/**/*.ts` to `include` so tests are typechecked
  - Remove the broken `lint` script that references an uninstalled eslint, or install and configure eslint at the root
  - Write `test/deps.test.ts` asserting `packages/core/package.json` has no non-empty `dependencies` field and that no file under `src/` imports a non-relative, non-`node:` specifier
  - _Requirements: 1.3, 1.4, 1.5, 1.7, 1.8_
- [x] 1.3 Write `src/types.ts` with the canonical contracts
  - Reproduce `EventKind`, `SketchEvent`, `Skill`, `ProjectContext`, `Message`, `Usage`, `ChatAdapter`, `ProviderKind`, `ProviderConfig`, `VerifyCommand`, `VerifyResult`, `Task`, `RunResult`, `Check`, `EvalCase`, `EvalResult`, `SecretStore` exactly as specified in the design
  - Rename the existing aggregate `VerifyResult` to `VerifySummary` and the existing orchestrator `RunResult` to `OrchestratorRunResult` to free the names; update all references and tests
  - _Requirements: 2.1, 3.1_
- [x] 1.4 Build the dependency-free provider adapters and registry
  - `providers/openaiCompatible.ts` — POST `{baseUrl}/chat/completions` via raw `fetch`, return `{ text, usage }`
  - `providers/anthropicMessages.ts` — POST `{baseUrl}/v1/messages` with `x-api-key`, translate messages both ways, map usage
  - Centralize a `redact()` helper and apply it to every thrown provider error so `Authorization`, `x-api-key`, and query-string keys never appear
  - Make the existing OpenAI, Anthropic, Gemini, and openai-compatible adapters also implement `ChatAdapter.chat()` without changing their existing surface
  - Rebuild `providers/registry.ts` to resolve `ProviderConfig → ChatAdapter`, constructing per resolution; delete the module-global `registry` singleton
  - Add registry entries for GitHub Models, Azure OpenAI, Cloudflare Workers AI, and llama.cpp, each flagged for whether it is a serverless inference endpoint
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.9_
- [x] 1.5 Build `FakeChatAdapter` and the offline provider switch
  - Call 1 returns a `plan` action, call 2 returns `{"action":"verify"}`, call 3 returns a `done` action
  - When `SKETCH_FAKE_PROVIDER=1` the registry resolves to the fake so the entire loop runs key-free
  - Test that a full run completes with no network access and no key in the environment
  - _Requirements: 2.7, 1.6_
- [x] 1.6 Build the skill and project-context loader
  - Hand-rolled YAML frontmatter parser: scalars, quoted strings, inline and block sequences — no third-party library
  - Load `SKILL.md` into `Skill`; load `AGENTS.md` and `CLAUDE.md` into `ProjectContext`
  - Load the `skill.json` folder layout (`README.md`, `prompts/`, `workflows/`, `tools/`, `tests/`, `examples/`) and normalize it to the same `Skill` shape
  - Malformed frontmatter produces a diagnostic naming the file and skips that skill without aborting
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.6_
- [x] 1.7 Build the event store
  - `EventStore` interface with `emit`, `readAll`, `forRun`
  - `JsonlEventStore` appending one JSON object per line to `.sketch/events/<date>.jsonl`; never rewrites or truncates
  - `MemoryEventStore` for tests
  - `readAll` skips malformed lines and continues; `forRun` returns events in emission order
  - Time-sortable collision-resistant run ids; no module-global counter
  - Test that no event payload can carry an API key
  - _Requirements: 3.2, 3.5, 3.6, 3.7, 3.8, 3.9_
- [x] 1.8 Build the verify runner
  - `verify/runner.ts` using `spawn` with `shell: false`, capturing exit code, stdout, stderr, and duration
  - Per-command timeout terminating with SIGKILL and reporting failure rather than hanging
  - Emit `verify_started` before and `verify_result` after each command
  - _Requirements: 4.1, 4.2, 4.6_
- [x] 1.9 Build the plan artifact writer
  - Write the twelve plan documents to `.sketch/plan/<runId>/` and emit `plan_written` with the directory path
  - Expose a `hasPlan(runId)` predicate the loop uses as its gate condition
  - _Requirements: 6.1, 6.2, 6.3_
- [x] 1.10 Build the agent loop
  - `loop/agent.ts` exposing `runTask(task, deps)` with adapter, events, verify, files, plan, clock, ids, and maxIterations all injected
  - Parse the seven actions from fenced or bare JSON, reusing the existing `extractJson()`; unknown shapes degrade to `think`
  - Emit the event for every action **before** executing it
  - Enforce the plan gate in the engine: an `edit` with no plan artifact emits `edit_rejected` and feeds the refusal back
  - On `verify`, run the task's commands and feed PASS/FAIL plus output back; iterate to `done` or `maxIterations`
  - `done` is `ok` only when all verify stages passed or none were configured
  - Emit exactly one terminal `run_completed` or `run_failed` per run
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 3.3, 3.4, 6.4, 6.5, 6.6_
- [x] 1.11 Build the eval harness
  - `evals/runner.ts` with `runEval`, `runEvalSet`, `meanScore` and checks `verify-pass`, `contains`, `not-contains`
  - Score is the fraction of passed checks; `passed` only when all pass; emit `eval_scored`
  - A throwing case records zero with the error detail and the set continues
  - Runs entirely on `FakeChatAdapter` with no network
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
- [x] 1.12 Build the SkillOpt trainer and its strict validation gate
  - Implement the train/validation split and the accept-only-on-strictly-greater loop exactly as specified
  - `proposeEdit` is an injected seam with a deterministic offline stub
  - Test that a proposed improvement is accepted and a proposed regression is rejected
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.8_
- [x] 1.13 Build the stdio JSON-line CLI
  - Newline-delimited `{ id, method, params }` in, `{ id, ok, result }` or `{ id, ok: false, error }` out
  - Methods `ping`, `run`, `eval`, `parse-skill`, `capture-eval`
  - Unknown method and malformed JSON both respond with an error and leave the process available
  - Protocol frames on stdout only; diagnostics on stderr; run progress streamed as event frames correlated by `runId`
  - Test by writing frames to stdin and asserting frames on stdout
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_
- [x] 1.14 Wire the desktop shell to a mock client
  - Define the `SketchClient` interface with `ping`, `run`, `eval`, and event subscription; implement `MockSketchClient`
  - Add a single client factory; no component imports a concrete implementation
  - Build the `AgentTimeline` panel rendering real `SketchEvent` objects, and the Agent Console rendering `llm_request`/`llm_response`
  - Keep the existing Cowork/Code toggle; delete the dead `Sidebar.tsx`, `RightPanel.tsx`, `ChatPanel.tsx`, and `AgentInput.tsx` stubs
  - _Requirements: 13.1, 13.2, 13.3, 14.1, 27.2_
- [x] 1.15 Phase 1 gate
  - Run `npm install && npm run build && npm test` at the repository root with no network and no API key; must exit 0
  - Paste failing-then-passing evidence; record real-versus-seam status for every subsystem
  - Update `tasks-executed.md`, reconciling its stale Milestone 4 claim against the code that actually exists
  - _Requirements: 1.6, 28.6_

---

## Phase 1.5 — Tauri security hardening (pulled forward from Phase 4)

Reordered ahead of Phase 2 by explicit user decision: task 2.1 wires a real IPC path from the
webview into the engine, and `src-tauri` currently has no capabilities file, `fs.scope: ["**"]`,
`csp: null`, and an unrestricted `run_command` shell. Wiring the sidecar before hardening would
mean briefly shipping a real IPC path into an unsandboxed shell. This section is the original
task 4.3, moved; nothing in its content changed. Task 4.3 below is marked superseded so the
Phase 4 numbering stays intact for anything that references it.

- [x] 1.16 Harden the Tauri security surface
  - Add the missing `src-tauri/capabilities/default.json` granting only the permissions actually used; the fs and shell plugins are currently unusable from the webview and their scopes are wide open
  - Replace the unrestricted `run_command` shell passthrough with a scoped, confirmable terminal tool
  - Implement the stubbed `open_project_dialog` using the dialog plugin
  - Set a real CSP in place of `csp: null`, and wire the custom titlebar's dead window controls since `decorations: false` leaves the window otherwise uncontrollable
  - _Requirements: 13.8, 22.6_
- [x] 1.17 Phase 1.5 gate
  - Prove the fs and shell plugins are scoped, `run_command` cannot execute an arbitrary string, the dialog plugin opens a real folder picker, and the CSP is non-null
  - _Requirements: 13.8, 22.6_

---

## Phase 2 — Real bridge and save-as-eval

- [x] 2. Real engine behind both surfaces, plus capture-as-eval
- [x] 2.1 Bundle and register the Tauri sidecar
  - esbuild-bundle `cli.ts` to a single file; register it as `externalBin` in `tauri.conf.json`
  - Spawn the sidecar on app load, forward stdio, implement `StdioSketchClient`, and issue a startup `ping`
  - _Requirements: 13.4, 13.6, 12.7_
- [x] 2.2 Build the Vite dev bridge
  - A `configureServer` plugin using Node's built-in `http`: `POST /__sketch` for requests, `GET /__sketch/events` for SSE — no HTTP framework
  - Implement `HttpSketchClient`; select the transport by `VITE_BRIDGE` in the single factory
  - _Requirements: 13.5, 13.6_
- [x] 2.3 Implement capture-as-eval
  - `captureRunAsEval(run, want)` appending an `EvalCase` to `.sketch/evals/evals.jsonl`
  - Add a capture control to the Timeline
  - Test that a captured case re-scores to 1.0 and that the file contains no key material
  - _Requirements: 8.1, 8.2, 8.3, 8.4_
- [x] 2.4 Phase 2 gate
  - Prove native and browser transports both drive the real engine offline
  - Prove a captured case re-scores 1.0, and assert no mock client is reachable on a real path
  - _Requirements: 13.6, 13.7, 8.2_

---

## Phase 3 — Code surface

- [x] 3. Code surface: Monaco, diff review, git, and one file state
- [x] 3.1 Integrate Monaco with a single file-state owner
  - Install Monaco and render it with a `Map<path, model>` keyed by absolute path
  - Make `AppState` the single owner of `openFiles`, `activeFile`, and `files`; delete `EditorArea`'s local `hasFileOpen` and its hardcoded tabs, gutter, and fake syntax markup
  - Load file content from the real filesystem through the client seam
  - When the engine writes an open file, update the model or flag a conflict — no second cache
  - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.6, 14.6_
- [x] 3.2 Build diff review with per-hunk accept and reject
  - Render `edit_proposed` payloads as a reviewable diff with per-hunk controls
  - Emit `edit_accepted` on accept and `edit_rejected` with a reason on reject
  - Rejecting every hunk leaves the file on disk unchanged
  - _Requirements: 16.1, 16.2, 16.3, 16.5_
- [x] 3.3 Build the real Git panel
  - `tools/git.ts` in core shelling out for status, diff, branch, and stage operations
  - Replace `GitPanel`'s `MOCK_STAGED`, `MOCK_CHANGES`, and `MOCK_UNTRACKED` with real data and wire the dead stage, unstage, and commit buttons
  - Add a diff pane; reconcile the branch name shown in `StatusBar` with the real branch
  - CARRIED OVER from the Phase 2 audit: `git_status` and `git_diff` in `src-tauri/src/main.rs` take a `project_root` but never contain it, and `git_diff` forwards a caller-supplied `file` argument to `git diff` unvalidated. Route both through the same `command_policy` containment the fs commands now use, and treat `file` as a contained path rather than an opaque argument
  - _Requirements: 14.6, 27.1, 27.3, 13.8_
- [x] 3.4 Make Explorer, Terminal, and Debugger real
  - Replace `FileExplorer`'s `MOCK_TREE` with real `read_dir` data and wire file clicks to open in the editor
  - Replace the static `Terminal` markup with a real input, real command execution through the scoped terminal tool, and output from state
  - Replace `SearchPanel`'s function-local `mockResults` with real search, wiring the uncontrolled input to state
  - Add a Debugger panel entry point
  - _Requirements: 14.4, 14.6, 27.1, 27.3, 27.4_
- [x] 3.5 Add optional debounced ghost completions
  - Keystroke-to-UI under 16 ms, in-flight requests cancellable, feature off by default
  - _Requirements: 15.5_
- [x] 3.6 Mirror the plan gate in the UI
  - Disable apply-edit controls until `plan_written` has been observed for the run
  - _Requirements: 16.4, 6.5_
- [x] 3.7 Phase 3 gate
  - Prove open → edit → run → review diff → accept → git status works offline with the plan gate enforced in both the engine and the UI
  - _Requirements: 15.2, 16.4_

---

## Phase 4 — Settings, secrets, zero telemetry

- [ ] 4. Provider settings, OS-keychain secrets, and provable zero telemetry
- [x] 4.1 Build the Provider Settings surface
  - List the full provider matrix, allow adding a custom endpoint, and offer a per-provider connection test
  - Persist key-free configuration to `~/.sketch/providers.json`
  - Replace the dead `ModelSelector` fixture and the never-rendered `state.providers` array with real data
  - _Requirements: 17.1, 17.2, 27.1_
- [x] 4.2 Implement the SecretStore seam and OS credential storage
  - Keep `SecretStore` (`get`/`set`/`del`) in core with no implementation that persists
  - Implement real storage on the Rust side against the OS credential store; expose `list_providers`, `set_api_key`, and `remove_api_key` Tauri commands, which the bridge already calls but which do not exist
  - Supply the resolved key to the engine at invocation time only
  - Delete the keytar-shaped `KeychainCredentialStore` in favor of the seam
  - _Requirements: 17.3, 17.4_
- [~] 4.3 Harden the Tauri security surface — SUPERSEDED, moved to Phase 1.5 (task 1.5h)
  - Completed ahead of schedule as task 1.5h, by explicit user decision, before task 2.1 wired
    a real IPC path into the (at the time) unsandboxed webview. See Phase 1.5 above for the
    original content and rationale. This row is kept only so the Phase 4 numbering does not
    shift for anything that cites `4.3`.
  - _Requirements: 13.8, 22.6_
- [x] 4.4 Prove zero telemetry and secret redaction
  - Write `PRIVACY.md` stating exactly what leaves the machine
  - Add a grep test asserting `analytics`, `telemetry`, `sentry`, and `posthog` are absent from `packages/**/src`
  - Add a test asserting a thrown provider error never contains the configured key value
  - _Requirements: 17.5, 17.6, 17.8_
- [x] 4.5 Phase 4 gate — v1 complete
  - Prove keys live only in the OS store, `providers.json` is key-free, the grep test is clean, and a connection test against `http://localhost:11434/v1` succeeds with no internet
  - Write the `README.md` $0 stack recipe: fake adapter for tests, local Ollama or a free tier for demos, never a paid-only path
  - _Requirements: 17.7, 26.3, 1.6_

---

## Phase 5 — Intelligent context

- [x] 5. Intelligent context and the architecture generator
- [x] 5.1 Persist the repository graph
  - Build the graph from the existing walker, chunker, and dependency-graph modules; persist to `.sketch/index/graph.json`; rebuild incrementally by content hash
  - Add the missing test coverage for `walkProject`, including `.gitignore` handling
  - _Requirements: 18.1_
- [x] 5.2 Build hybrid search with reranking
  - Add a ripgrep-backed lexical channel; fuse it with the existing vector channel by reciprocal rank; add a rerank pass
  - Vector-only retrieval must not be the shipped default
  - _Requirements: 18.2_
- [x] 5.3 Make embeddings work offline
  - Local embedding path with no network; provider embeddings cached locally as a documented fallback
  - _Requirements: 18.3_
- [x] 5.4 Build context assembly under a token budget
  - Combine memory, skills, top-k chunks, and one-hop graph neighbors under a token budget
  - Preserve function and type signatures in preference to bodies when truncating
  - Consume the `expandWithDependencies` result that `ContextEngine.retrieve` currently computes and discards
  - Emit `context_assembled` with the selected paths and token estimate
  - _Requirements: 18.4, 18.5, 18.6, 18.8_
- [x] 5.5 Build the architecture generator
  - Derive system, API, database, component, dependency, folder-tree, and call-graph views from the graph; deterministic for a fixed graph; no network
  - Emit `diagram_updated`; render in a Live Architecture panel
  - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 27.1_
- [x] 5.6 Phase 5 gate
  - On a fixed fifty-file fixture, prove targeted context is smaller and more relevant than the whole-repo baseline AND the held-out eval score rises; prove diagrams render
  - _Requirements: 18.7_

---

## Phase 6 — Skills registry and trainer

- [x] 6. Curated signed registry, capability scopes, and the real optimizer
- [x] 6.1 Build the signed curated registry
  - Pinned manifest with a content hash per skill; reject installation on hash mismatch with a tamper diagnostic
  - _Requirements: 11.1, 11.2_
- [x] 6.2 Seed the registry
  - Context packing, web/data, general engineering pack, frontend design, research-stage pack, finance/quant pack
  - _Requirements: 11.3_
- [x] 6.3 Enforce capability scopes
  - Enforce `capabilities:` at the tool and filesystem layer; a skill without a network capability cannot fetch, and the attempt emits `tool_denied`
  - _Requirements: 11.4, 11.5_
- [x] 6.4 Build the real Skills surface
  - Replace `SkillsMarketplace`'s `MOCK_SKILLS` and the duplicate never-read `state.installedSkills` and `state.skillMarketplace` fixtures with registry data; wire the dead `TOGGLE_SKILL` and `INSTALL_SKILL` reducers
  - _Requirements: 14.6, 27.1, 27.3_
- [x] 6.5 Open the marketplace behind the gate
  - Ship the open marketplace with a review queue only after signing and capability scoping are both tested
  - _Requirements: 11.6_
- [x] 6.6 Wire the real optimizer into `proposeEdit`
  - Replace the stub with the real optimizer while keeping our strict validation gate unchanged
  - Add a "Train this skill on my project" action running `trainSkill` on captured evals over a train/validation split, behind the cost guard and off the hot path
  - _Requirements: 9.5, 9.6, 9.7_
- [x] 6.7 Phase 6 gate
  - Prove signed install and scope enforcement offline; prove the stub-optimizer trainer improves a seed skill and rejects a regression
  - The real-optimizer run in 6.6 is the one documented exception that may require a key
  - _Requirements: 11.2, 11.5, 9.8_

---

## Phase 7 — Verification contract and MCP

- [x] 7. Full verification contract, live environment feedback, and curated MCP
- [x] 7.1 Build the verify policy
  - Nine ordered stages: format, lint, typecheck, build, unit, integration, security, performance, dependency-audit
  - `verify.yaml` at the project root takes precedence; auto-detect per stack when absent, extending the existing node/python/rust/go detector
  - Unconfigured stages report as skipped without failing
  - A task is `ok` only when every non-skipped stage passed, or none were configured
  - _Requirements: 4.3, 4.4, 4.5, 4.7, 4.8_
- [x] 7.2 Add live environment feedback
  - Browser tool plus an application runner capturing console output and runtime errors
  - A runtime error means not done; a failure to start is a verification failure with captured output; the stage is skippable where it does not apply
  - _Requirements: 23.1, 23.2, 23.3, 23.4_
- [x] 7.3 Build the curated isolated MCP registry
  - Hand-rolled JSON-RPC over stdio, no SDK dependency; curated and pinned coverage of GitHub, Docker, Figma, Notion, Slack, terminal, browser, filesystem, SSH, Cloudflare, Supabase, databases, Android emulator, and Playwright
  - Route all side-effecting model actions through the tool layer, emitting `tool_called` or `tool_denied`
  - Per-run and per-capability scoped grants; a hanging server times out, is marked unavailable for the run, and the run continues
  - Surface tool failures, reasons, and retries rather than hiding them — replace the hardcoded MCP badge and tooltip with real status
  - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 27.5_
- [x] 7.4 Build the Test Results panel
  - _Requirements: 27.1_
- [x] 7.5 Phase 7 gate
  - Prove broken tests or a broken running app both mean not done, and that a hanging tool cannot hang a run
  - _Requirements: 4.7, 23.2, 22.3_

---

## Phase 8 — Cost and budget

- [x] 8. Cost accounting, budget guard, routing, and cache
- [x] 8.1 Implement usage accounting
  - Every `llm_response` carries usage; the session total equals the sum over events with no independent source
  - _Requirements: 20.1, 20.2_
- [x] 8.2 Implement the cost guard and router
  - Enforce per-task token and currency budgets inside the loop; on breach either downgrade or stop with `run_failed{reason:"budget"}`, deterministically by configuration
  - Emit `budget_exceeded`; route cheap or mechanical calls to a local or inexpensive model and reserve a frontier model for hard calls
  - _Requirements: 20.3, 20.4, 20.5, 20.6, 5.10_
- [x] 8.3 Implement the content-addressed response cache
  - Key on provider, model, messages, and options; store under `.sketch/cache/`; a repeated identical request emits `cache_hit` and issues no second network call
  - _Requirements: 20.7_
- [x] 8.4 Build the Cost Dashboard
  - Reconcile exactly with the event log; replace the hardcoded `$1.4025` in `StatusBar` and `TaskLog` and the never-rendered `state.totalCost`
  - _Requirements: 20.8, 27.1, 14.6_
- [x] 8.5 Phase 8 gate
  - Prove an overrun stops or downgrades deterministically, a cache hit avoids the second call, and the dashboard equals the log
  - _Requirements: 20.4, 20.7, 20.8_

---

## Phase 9 — Memory and hygiene

- [x] 9. Versioned project memory with hygiene
- [x] 9.1 Build the versioned memory store
  - Persist decisions, architecture, summarized conversations, standards, preferences, style, bugs, performance history, and test history; every row carries `valid_from` and `valid_to`
  - Keep the existing in-memory implementation as the test double behind the same interface
  - _Requirements: 21.1, 21.2, 21.7_
- [x] 9.2 Implement hygiene
  - Newer entries supersede older with a recorded reason and a `memory_superseded` event; support expiration and a memory-lint pass for contradictions
  - _Requirements: 21.3, 21.4_
- [x] 9.3 Implement reranked retrieval
  - Reuse the Phase 5 hybrid path with reranking and a recency prior; emit `memory_retrieved`
  - _Requirements: 21.5_
- [x] 9.4 Build the Memory panel
  - _Requirements: 27.1_
- [x] 9.5 Phase 9 gate
  - Insert a decision, insert a contradicting decision, and prove a related query returns the newer while the older is marked superseded
  - _Requirements: 21.6_

---

## Phase 10 — Eval-gated multi-agent

- [x] 10. Strategy dispatcher, the thirteen roles, and consensus
- [x] 10.1 Keep single-agent as the default and add the dispatcher
  - Support `single`, `plan-then-code`, and `swarm`; emit `strategy_selected`; record which strategy succeeded
  - Escalate only after the lighter strategy fails within its eval and verify budget
  - _Requirements: 24.1, 24.2, 24.3_
- [x] 10.2 Implement the roles as constrained sub-runs
  - CEO, Planner, Research, Architect, Backend, Frontend, Database, Security, Testing, Reviewer, Performance, Deployment, Documentation — each with its own verification signal and the inner goal → memory → thinking → action → verification → feedback → retry → consensus loop
  - No role without a distinct verification signal
  - _Requirements: 24.4, 24.5, 24.6_
- [x] 10.3 Implement deterministic merge and consensus
  - Union of verified non-conflicting edits; a conflict creates a new task and is never guessed; consensus runs only inside `swarm`
  - _Requirements: 24.7, 24.9_
- [x] 10.4 Build the AI Team and Tasks panels
  - Render real dispatcher events; replace `AgentTeamPanel`'s four function-local fixtures and the twelve never-rendered `state.agentTeam` entries, and make the panel reachable — no ActivityBar button currently dispatches `agents`
  - Replace `TaskLog`'s `MOCK_TASKS` and its non-functional filter with real task state
  - _Requirements: 27.1, 27.3, 27.4, 14.6_
- [x] 10.5 Phase 10 gate
  - `swarm` becomes a default for a task class only after measured pass@k lift over `single` on the internal suite; otherwise it stays off
  - _Requirements: 24.8_

---

## Phase 11 — Honest benchmarks

- [ ] 11. Benchmarks and lift-regression protection
- [~] 11.1 Build the internal eval suite
  - Scored by the eval harness and the verification contract
  - _Requirements: 25.1_
- [~] 11.2 Report the measurable outcomes
  - Task completion rate, build success rate, test pass rate, manual edits required, time to completion, and cost
  - _Requirements: 25.2_
- [~] 11.3 Report pass@k under a fixed budget
  - Include the distribution, not only the best case
  - _Requirements: 25.3_
- [~] 11.4 Frame public benchmarks as lift
  - Present `M + Sketch` versus `M + naive` across several models; never claim to beat a model
  - _Requirements: 25.4_
- [~] 11.5 Add the bench script and CI gate
  - `bench` produces a report artifact; CI fails on internal-suite lift regression
  - _Requirements: 25.5, 25.6_
- [~] 11.6 Build the Benchmarks panel
  - _Requirements: 27.1_

---

## Phase 12 — Packaging and the open flywheel

- [ ] 12. Packaging, offline proof, and extensibility
- [~] 12.1 Produce cross-platform builds
  - macOS, Windows, and Linux Tauri builds with a documented size budget
  - _Requirements: 26.1_
- [~] 12.2 Prove local-first on a clean offline machine
  - Install, index a repository, and complete a task on local Ollama with no external network call beyond the local model endpoint
  - _Requirements: 26.2_
- [~] 12.3 Ship the open-source scaffolding
  - `CONTRIBUTING.md` and signed releases; the marketplace retains hash, scope, and review
  - _Requirements: 26.3_
- [~] 12.4 Prove the flywheel turns server-less
  - A community skill installs, runs, and trains on captured evals with no Sketch server involved
  - _Requirements: 26.4_
- [~] 12.5 Complete the extensibility audit
  - Confirm and document an extension point for providers, agents, skills, tools, models, memory, workflows, themes, and languages
  - _Requirements: 26.5_
- [~] 12.6 Run the canonical end-to-end acceptance
  - The "build an Airbnb clone" flow runs end to end with the plan gate, verification contract, consensus, and cost guard all observable in the Timeline, completing with every check green
  - _Requirements: 24.7, 6.4, 4.7, 20.4_

---

## Documentation reconciliation (runs alongside, gated per phase)

- [ ] 13. Reconcile the prior-generation documents with this build
- [~] 13.1 Amend `rules.md`
  - Permit consensus and multi-agent code from v2 behind the eval gate, replacing the blanket v1 prohibition while keeping single-agent as the default
  - Replace the keytar-specific credential rule with "the OS credential store, accessed outside the core"
  - _Requirements: 28.1_
- [~] 13.2 Amend `what-not-we-are-building.md`
  - Scope the skills registry to v1 and the open marketplace to v2 with signing and capability scoping as preconditions
  - _Requirements: 28.2_
- [~] 13.3 Amend `trd.md` and `architecture.md`
  - Record the dependency-free core decision, replacing mandated `better-sqlite3`, `sqlite-vec`, `keytar`, and MCP SDK dependencies with the seam approach
  - Record the workspace layout, the event-sourced JSONL log, the `.sketch/` directory layout, and the nine-stage verification contract
  - _Requirements: 28.3, 28.4_
- [~] 13.4 Amend `prd.md`
  - Reflect the two-surface product and the three optimization metrics of lift, reliability, and compounding
  - _Requirements: 28.5_
- [~] 13.5 Keep `tasks-executed.md` current
  - Update at each phase gate, with a decision-log row for every architectural decision recorded in this spec
  - _Requirements: 28.6_
