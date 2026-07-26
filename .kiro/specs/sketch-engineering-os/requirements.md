# Requirements Document

## Introduction

Sketch is an open-source, local-first, model-agnostic AI software-engineering platform that ships as one desktop window with two surfaces (`Cowork` and `Code`) over a single shared substrate. It is not a chatbot; it is an autonomous engineering operating system.

The product thesis: Sketch's job is not to be the smartest model in the room — it is to be **the room**. The orchestration layer, verification loop, and skill ecosystem are what Sketch owns and what compound. Models are leased and commoditize.

Only three metrics matter:

- **Lift** — for any model M, `M + Sketch` beats `M + a naive harness`, measured.
- **Reliability** — pass@k under a fixed cost and time budget; optimize the distribution, not the best case.
- **Compounding** — harness, skills, and ecosystem improve on our clock via the SkillOpt validation gate.

### Current state of the repository

This is a brownfield build. The following already exists and is in scope for migration, not rewrite:

- `engine/` — a zero-runtime-dependency TypeScript package (`@sketch/engine`) with provider adapters (OpenAI, Anthropic, Gemini, seven openai-compatible variants, registry, injected-keytar credential seam), a context engine (walker, chunker, dependency graph, hash + provider embedder, in-memory vector store), a verifier (project detector, child-process runner, four-check verifier, fix/retry loop), an orchestrator (planner, agent runner, disk file writer with path guard, state machine, topological step sort), and in-memory project memory. 97 vitest tests pass.
- `desktop/` — a Tauri 2 + React 19 + Vite shell (`@sketch/desktop`) with a Cowork/Code mode toggle, an activity bar, a side panel, and ~20 panel components. Every panel is a static shell backed by module-level `MOCK_*` fixtures. Rust exposes six working commands (`read_dir`, `read_file`, `write_file`, `git_status`, `git_diff`, `run_command`) plus one stub; the frontend calls none of them. Monaco is not installed. No Tauri v2 capabilities file exists. There is no engine import anywhere in the frontend.
- Root docs — `prd.md`, `trd.md`, `architecture.md`, `rules.md`, `what-we-are-building.md`, `what-not-we-are-building.md`, `tasks-executed.md`.

The following do not exist anywhere and represent the substrate that carries the moat: event store, eval harness, run capture, skill loader, skill registry, skill trainer, plan artifact, stdio CLI, client seam, cost accounting, budget guard, response cache, hybrid search, reranking, architecture generator, strategy dispatcher, memory versioning, MCP tool layer, persistent storage of any kind.

### Non-negotiable constraints

These override any default behavior and apply to every requirement below.

- **C1 — Phase order.** No phase begins until the previous phase's gate is green.
- **C2 — Tests are the gate.** A step is done only when its command exits 0 **offline, with no API key set**. The single documented exception is the real SkillOpt optimizer run in Phase 6.4.
- **C3 — The core package is dependency-free.** Node built-ins and raw `fetch` only. No SDKs, no LangGraph, no ORM, no frontmatter library, no HTTP framework. Bundling the CLI with esbuild for the Tauri sidecar is permitted; bundling is not a runtime dependency.
- **C4 — Free by construction.** MIT or Apache-2.0. No Sketch servers, no required account, no subscription, zero telemetry, bring-your-own-key. Tests run on a fake adapter at $0; demos run on local Ollama or a free tier. No paid-only path ever.
- **C5 — Evidence or it did not happen.** Failing output before, passing output after.
- **C6 — Preserve seams.** Where a seam is specified, ship the interface plus a fake/real pair.
- **C7 — Never log secrets.** Redact `Authorization` and `x-api-key` in every thrown error and every event payload.
- **C8 — Serverless means two things and neither is a Sketch server.** (a) Sketch's own compute is server-less: no cloud backend, no infrastructure, install and go, engine runs on-device as a Tauri sidecar or local CLI. (b) The provider layer is provider-agnostic and explicitly includes serverless inference endpoints alongside direct APIs and local models. User keys live in the OS keychain and are never proxied through anything Sketch operates.
- **C9 — The twelve-role brain exists but is never the default.** Roles and multi-model consensus are the available specialization set, activated only by the eval-gated `swarm` strategy. The default for every task is the simplest harness that works: a single agent. Planning-first is not multi-agent, so it is always on.

### Traps that shape these requirements

| ID | Trap | Required alternative |
|---|---|---|
| T1 | Multi-agent by default | Single-agent default; escalate only on measured eval lift |
| T2 | Roles without signals | No new role without a new verification signal |
| T3 | Memory rot | Versioning, supersession, expiration, reranked retrieval from day one |
| T4 | Cost as a footnote | Budget inside the loop; cost-aware routing; response cache |
| T5 | Unsigned marketplace | Curated, signed, capability-scoped before open |
| T6 | Vector-only context | Hybrid lexical + vector, graph expansion, rerank |
| T7 | Framework in the core | No LangGraph, no SDKs in the core package |
| T8 | Benchmark vanity | Optimize lift, reliability, compounding |
| T9 | Training on the hot path | Train offline, on save, nightly, or on demand; deploy free |
| T10 | Keys in logs | Redaction plus a grep test asserting no telemetry strings |
| T11 | Two sources of truth | Editor model and engine share one file state |

### Version boundaries

- **v1** = Phases 1–4. Verify-loop harness, Cowork/Code toggle, full provider matrix via adapters, OS keychain, zero telemetry, event-sourced timeline, native skill loading, curated signed seed registry, real engine behind both surfaces, plan-before-edit enforced.
- **v1.5** = Phases 5, 6, 8. Intelligent context and architecture generator, save-as-eval plus trainer wired to the real optimizer, cost guard and dashboard. The moat begins to compound here.
- **v2** = Phases 7, 9, 10, 11, 12. Full verification contract, hygienic memory, eval-gated twelve-role brain with consensus, honest benchmarks, open marketplace, packaging, extensibility audit.

---

## Requirements

### Requirement 1 — Monorepo layout and a dependency-free core

**User Story:** As a contributor, I want one npm workspace root with a dependency-free core package, so that a local-first install can never fail on a native module and the engine can be bundled into a sidecar.

#### Acceptance Criteria

1. THE repository SHALL have a root `package.json` declaring npm workspaces `packages/core` and `packages/desktop`.
2. THE existing `engine/` package SHALL be relocated to `packages/core` and renamed `@sketch/core`, and the existing `desktop/` package SHALL be relocated to `packages/desktop`, with all imports and tests still resolving.
3. THE `packages/core/package.json` SHALL declare an empty or absent `dependencies` field, and SHALL declare `exports`, `types`, and a `bin` entry for the CLI.
4. WHEN any module under `packages/core/src` is inspected THEN every non-relative import SHALL be prefixed `node:`.
5. THE core package SHALL compile under `module: NodeNext` and `moduleResolution: NodeNext`, and every relative import SHALL carry a `.js` extension.
6. WHEN `npm install && npm run build && npm test` runs at the repository root with no network access and no provider API key in the environment THEN the command SHALL exit 0.
7. THE core `tsconfig.json` SHALL include the test directory in typechecking so tests cannot drift from the contracts.
8. IF a dependency is added to `packages/core` THEN a test SHALL fail asserting the `dependencies` field is empty.

### Requirement 2 — Provider adapter layer covering the full matrix

**User Story:** As a developer with my own keys, I want every provider reachable through the same tiny adapter surface, so that I am never locked to one vendor and can mix direct APIs, serverless endpoints, and local models.

#### Acceptance Criteria

1. THE core SHALL define `ChatAdapter` with a readonly `id` and `chat(messages, options?): Promise<{ text, usage? }>` as the single seam the agent loop depends on.
2. THE core SHALL ship exactly two built-in adapter kinds: `openai-compatible` posting to `{baseUrl}/chat/completions`, and `anthropic-messages` posting to `{baseUrl}/v1/messages` with an `x-api-key` header and bidirectional message-shape translation.
3. THE existing `ProviderAdapter` implementations SHALL be retained and SHALL additionally satisfy `ChatAdapter`, so existing provider tests keep passing.
4. THE provider registry SHALL resolve a `ProviderConfig` to an adapter instance and SHALL support OpenAI, Anthropic, Google Gemini, Groq, OpenRouter, Ollama, GitHub Models, Azure OpenAI, Cloudflare Workers AI, llama.cpp, and an arbitrary custom OpenAI-compatible endpoint.
5. WHERE a provider is a serverless inference endpoint THE registry entry SHALL be marked as such so the UI can present it distinctly.
6. WHEN an adapter receives a non-2xx response THEN it SHALL throw an error whose message includes the status and provider id AND SHALL NOT include the value of `Authorization`, `x-api-key`, or any query-string key.
7. WHEN `SKETCH_FAKE_PROVIDER=1` is set THEN the registry SHALL resolve to `FakeChatAdapter`, whose first call returns `{"action":"plan",...}`, second returns `{"action":"verify"}`, and third returns `{"action":"done",...}`, so the whole loop runs key-free.
8. THE registry SHALL NOT hold configured API keys in module-global singleton state; adapter instances SHALL be constructed per resolution.
9. WHEN an adapter is asked for a token count or cost estimate for an unknown model THEN it SHALL return 0 rather than throwing.

### Requirement 3 — Event-sourced run log as the single source of truth

**User Story:** As a user debugging an agent run, I want every decision recorded in an append-only log, so that the timeline, replay, cost dashboard, and eval capture all read from one place and a run is reproducible.

#### Acceptance Criteria

1. THE core SHALL define `SketchEvent` as `{ id, ts, runId, kind, payload }` where `kind` is one of: `run_started`, `plan_written`, `skill_loaded`, `context_loaded`, `context_assembled`, `llm_request`, `llm_response`, `think`, `verify_started`, `verify_result`, `edit_proposed`, `edit_accepted`, `edit_rejected`, `tool_called`, `tool_denied`, `budget_exceeded`, `cache_hit`, `strategy_selected`, `memory_retrieved`, `memory_superseded`, `diagram_updated`, `run_completed`, `run_failed`, `eval_scored`.
2. THE core SHALL ship an `EventStore` seam with `emit`, `readAll`, and `forRun` methods, a JSONL file-backed implementation appending one JSON object per line, and a `MemoryEventStore` for tests.
3. WHEN the agent loop performs any action THEN the corresponding event SHALL be emitted **before** the action executes.
4. WHEN a run completes or fails THEN exactly one terminal `run_completed` or `run_failed` event SHALL be emitted for that `runId`.
5. THE JSONL file SHALL be append-only; no code path SHALL rewrite or truncate a prior line.
6. WHEN the JSONL file contains a malformed line THEN `readAll` SHALL skip that line and continue rather than throwing.
7. NO event payload SHALL contain an API key, an `Authorization` value, or an `x-api-key` value.
8. WHEN `forRun(runId)` is called THEN it SHALL return that run's events in emission order.
9. THE run identifier SHALL be collision-resistant across processes; a module-global incrementing counter SHALL NOT be used.

### Requirement 4 — Verification contract

**User Story:** As a developer, I want a change to be considered complete only after it passes an ordered gauntlet of checks, so that "done" means the code actually works rather than that the model stopped talking.

#### Acceptance Criteria

1. THE verify runner SHALL spawn commands with `shell: false` and SHALL capture exit code, stdout, stderr, and duration.
2. WHEN a command exceeds its timeout THEN the runner SHALL terminate the process with SIGKILL and SHALL report a failure rather than hanging the run.
3. THE verification contract SHALL run stages in this order: `format`, `lint`, `typecheck`, `build`, `unit`, `integration`, `security`, `performance`, `dependency-audit`.
4. WHERE a stage is not configured for the detected project THE stage SHALL be reported as skipped and SHALL NOT fail the run.
5. THE policy SHALL be expressible in a `verify.yaml` file at the project root and SHALL be auto-detected per stack when absent, with the file taking precedence.
6. WHEN a verify stage runs THEN a `verify_started` event SHALL precede it and a `verify_result` event SHALL follow it.
7. A task SHALL be reported `ok` only if every non-skipped stage passed, or if no stages were configured at all.
8. THE existing four-stage detector behavior (node, python, rust, go) SHALL be preserved as the auto-detection baseline and extended to the nine-stage contract.

### Requirement 5 — Agent loop with a structured action protocol

**User Story:** As a user, I want the model to speak a small parseable action language, so that the harness can verify, gate, and replay every step instead of trusting prose.

#### Acceptance Criteria

1. THE loop SHALL accept `runTask(task, deps)` where every collaborator (adapter, event store, verify runner, file writer, clock, id generator) is injected.
2. THE model SHALL communicate via JSON, fenced or bare, with actions `plan`, `verify`, `edit`, `tool`, `think`, `ask`, and `done`.
3. WHEN model output cannot be parsed as a known action THEN the loop SHALL treat it as `think` and continue rather than failing the run.
4. THE loop's first model turn SHALL be expected to be `plan`.
5. WHEN an `edit` action is received AND no plan artifact exists for the run THEN the loop SHALL refuse the edit, SHALL emit `edit_rejected` with a reason, and SHALL feed the refusal back to the model.
6. WHEN a `verify` action is received THEN the loop SHALL run the task's verify commands and feed PASS/FAIL plus captured output back to the model.
7. THE loop SHALL iterate until `done` or `maxIterations` is reached.
8. WHEN `done` is received THEN the result SHALL be `ok` only if all verify stages passed or none were configured.
9. WHEN a `tool` action names a tool outside the current run's granted scope THEN the loop SHALL emit `tool_denied` and feed the denial back rather than executing it.
10. THE outer autonomous loop SHALL terminate when tests, lint, and build pass and the quality threshold is met; or the user stops; or the cost guard fires.

### Requirement 6 — Planning-first with a durable plan artifact

**User Story:** As a user, I want Sketch to write down what it intends to build before it touches a file, so that I can review the reasoning and the harness has a checkable precondition for editing.

#### Acceptance Criteria

1. WHEN a run begins THEN the orchestrator SHALL obtain a plan and SHALL write it to `.sketch/plan/<runId>/` before any edit is permitted.
2. THE plan artifact SHALL cover product requirements, user stories, architecture, folder structure, component tree, API contracts, database schema, security review, test plan, milestones, risks, and dependencies.
3. WHEN the plan is written THEN a `plan_written` event SHALL be emitted carrying the artifact directory path.
4. IF the plan directory for a run is absent or empty THEN no `edit_accepted` event SHALL ever be emitted for that run.
5. THE plan gate SHALL be enforced in the engine, not only in the UI, so a CLI-driven run cannot bypass it.
6. THE planning step SHALL be single-model and SHALL NOT require the `swarm` strategy.

### Requirement 7 — Eval harness

**User Story:** As a maintainer, I want a scoring harness built before the features it judges, so that every later claim about lift is measured rather than asserted.

#### Acceptance Criteria

1. THE core SHALL provide `runEval`, `runEvalSet`, and `meanScore`.
2. THE harness SHALL support checks `verify-pass`, `contains`, and `not-contains`.
3. WHEN an eval case runs THEN an `eval_scored` event SHALL be emitted with the case id and score.
4. THE score SHALL be the fraction of passed checks, and `passed` SHALL be true only when every check passes.
5. THE harness SHALL run entirely on `FakeChatAdapter` with no network access.
6. WHEN a case throws THEN the harness SHALL record a zero score with the error detail and SHALL continue the set.

### Requirement 8 — Save a run as an eval case

**User Story:** As a user who just watched a run succeed or fail, I want to turn it into a permanent regression test with one click, so that the harness gets better every time I use it.

#### Acceptance Criteria

1. THE core SHALL provide `captureRunAsEval(run, want)` producing an `EvalCase` appended to `.sketch/evals/evals.jsonl`.
2. WHEN a captured case is re-scored against the same recorded conditions THEN its mean score SHALL be 1.0.
3. THE Timeline surface SHALL expose a control that captures the displayed run as an eval case.
4. THE captured file SHALL contain no API key and no `Authorization` value.

### Requirement 9 — SkillOpt trainer with a strict held-out validation gate

**User Story:** As a user, I want my skills to measurably improve from my own captured evals without any model weight changing, so that the harness compounds locally and deployment stays free.

#### Acceptance Criteria

1. THE trainer SHALL treat a skill's markdown body as the trainable state and SHALL produce a compact `best_skill.md` artifact.
2. THE trainer SHALL split cases into train and validation sets and SHALL evaluate candidates only on the held-out validation set.
3. A candidate skill SHALL be accepted only WHEN its validation mean score is **strictly greater** than the incumbent's.
4. WHEN a candidate scores equal to or worse than the incumbent on validation THEN the incumbent SHALL be retained.
5. THE `proposeEdit` step SHALL be an injected seam with a deterministic stub for offline tests and a real provider-backed or SkillOpt-backed implementation for actual training.
6. THE trainer SHALL run off the hot path: on demand, on save, or nightly — never inside a user-facing task run.
7. WHEN training is invoked THEN it SHALL execute behind the cost guard.
8. WHEN the stub optimizer proposes an improvement THEN the trainer SHALL accept it, and WHEN it proposes a regression THEN the trainer SHALL reject it; both SHALL be proven by offline tests.

### Requirement 10 — Native skill and project-context loading

**User Story:** As a user with existing agent repositories, I want Sketch to read the formats the ecosystem already uses, so that a thousand community skills install with zero porting.

#### Acceptance Criteria

1. THE loader SHALL parse `SKILL.md` files consisting of YAML frontmatter plus a markdown body using a hand-rolled parser with no third-party dependency.
2. THE loader SHALL load `AGENTS.md` and `CLAUDE.md` as project context.
3. THE loader SHALL load the folder-based layout `skill.json` with `README.md`, `prompts/`, `workflows/`, `tools/`, `tests/`, and `examples/` and SHALL normalize it to the same internal `Skill` shape as `SKILL.md`.
4. WHEN frontmatter is malformed THEN the loader SHALL report a diagnostic naming the file and SHALL skip that skill rather than aborting the run.
5. WHEN a skill is loaded into a run THEN a `skill_loaded` event SHALL be emitted with the skill name and source.
6. THE `Skill` shape SHALL carry `name`, `description`, `body`, `source`, and optional `capabilities`.

### Requirement 11 — Curated, signed, capability-scoped skill registry

**User Story:** As a user installing community skills, I want the supply chain verified and the blast radius bounded, so that a skill cannot quietly exfiltrate my code.

#### Acceptance Criteria

1. THE registry SHALL be a pinned manifest carrying a content hash for every skill.
2. WHEN an installed skill's computed content hash does not match its manifest hash THEN installation SHALL be rejected with a tamper diagnostic.
3. THE seed registry SHALL include a context-packing skill, a web/data skill, a general engineering skill pack, a frontend design skill, a research-stage pack, and a finance/quant pack.
4. THE `capabilities` field SHALL be enforced at the tool and filesystem layer, not merely displayed.
5. WHEN a skill without a network capability attempts a network tool THEN the attempt SHALL be denied and a `tool_denied` event SHALL be emitted.
6. THE open marketplace SHALL NOT ship until signing and capability scoping are both in place and tested, and SHALL include a review queue when it does.

### Requirement 12 — stdio JSON-line CLI

**User Story:** As the desktop app and as a scripting user, I want one line-oriented protocol into the engine, so that the sidecar, the dev bridge, and CI all speak the same contract.

#### Acceptance Criteria

1. THE CLI SHALL read newline-delimited JSON requests `{ id, method, params }` from stdin and SHALL write newline-delimited responses `{ id, ok, result }` or `{ id, ok: false, error }` to stdout.
2. THE CLI SHALL implement methods `ping`, `run`, `eval`, `parse-skill`, and `capture-eval`.
3. WHEN a request references an unknown method THEN the CLI SHALL respond with `ok: false` and a message, and SHALL remain available for further requests.
4. WHEN a request body is malformed JSON THEN the CLI SHALL respond with an error and SHALL NOT exit.
5. THE CLI SHALL write only protocol frames to stdout; diagnostics SHALL go to stderr.
6. WHEN the CLI streams run progress THEN it SHALL emit event frames correlated by `runId`.
7. THE CLI SHALL be bundleable to a single file by esbuild for use as a Tauri sidecar.

### Requirement 13 — Client seam and two real transports

**User Story:** As a frontend developer, I want the UI to talk to the engine through one interface with mock, sidecar, and HTTP implementations, so that components never know which transport is live and browser dev works without Tauri.

#### Acceptance Criteria

1. THE desktop SHALL define `SketchClient` with at minimum `ping`, `run`, and `eval`, plus an event subscription.
2. THE desktop SHALL ship `MockSketchClient`, `StdioSketchClient`, and `HttpSketchClient` behind that interface.
3. NO React component SHALL import a concrete client implementation directly; selection SHALL happen in one factory driven by environment.
4. THE Tauri build SHALL bundle the CLI with esbuild, register it as an `externalBin` sidecar, spawn it on app load, and forward stdio.
5. THE Vite dev server SHALL expose a bridge via `configureServer` using Node's built-in `http` handling with `POST /__sketch` for requests and `GET /__sketch/events` for a server-sent event stream, with no HTTP framework dependency.
6. WHEN the app starts under either transport THEN a startup `ping` SHALL succeed against the real engine offline.
7. WHEN the app runs in a real transport THEN no mock client SHALL be reachable on that code path.
8. THE Tauri configuration SHALL include a v2 capabilities file granting only the permissions actually used.

### Requirement 14 — Two surfaces, one substrate

**User Story:** As a user, I want a single window whose toggle changes the surface and not the brain, so that tab-completion and an overnight autonomous task run on the same harness, skills, memory, and timeline.

#### Acceptance Criteria

1. THE app SHALL present a `Cowork | Code` toggle that switches surface only.
2. BOTH surfaces SHALL read the same event stream, the same skills, the same memory, and the same verification results.
3. THE Cowork surface SHALL provide a task rail, artifacts, scheduled tasks, a new-task entry point, a centered prompt, a model picker, and a "work in a folder" affordance.
4. THE Code surface SHALL provide a file tree, an editor, inline edits, diff review, a terminal, and a debugger entry point.
5. WHEN a run is started from one surface THEN its events SHALL be visible in the other without restarting the app.
6. THE existing static `MOCK_*` fixtures SHALL be removed from every panel that ships as real, and no shipped panel SHALL render fabricated data.

### Requirement 15 — Editor with a single file-state source of truth

**User Story:** As a user editing while an agent edits, I want the editor and the engine to share one view of file state, so that my buffer and the agent's writes never silently diverge.

#### Acceptance Criteria

1. THE editor SHALL use Monaco with a `Map<path, model>` keyed by absolute path.
2. THE editor buffer and the engine's file writer SHALL reconcile through one state owner; two independent caches SHALL NOT exist.
3. WHEN the engine writes a file that is open in the editor THEN the open model SHALL be updated or explicitly flagged as conflicting.
4. WHEN a file is opened THEN its content SHALL come from the real filesystem through the client seam.
5. WHERE optional ghost completions are enabled THE keystroke-to-UI latency SHALL stay under 16 ms and in-flight requests SHALL be cancellable.
6. THE file writer SHALL continue to refuse writes outside the open project directory.

### Requirement 16 — Diff review with per-hunk control

**User Story:** As a user, I want to accept or reject individual hunks of a proposed change, so that I stay in control of what lands.

#### Acceptance Criteria

1. WHEN the loop proposes an edit THEN an `edit_proposed` event SHALL be emitted and the change SHALL be rendered as a reviewable diff.
2. THE review surface SHALL allow accept and reject per hunk.
3. WHEN a hunk is accepted THEN an `edit_accepted` event SHALL be emitted; WHEN rejected, an `edit_rejected` event SHALL be emitted with the reason.
4. WHILE no plan artifact exists for the run THE control that would apply an edit SHALL be disabled in the UI.
5. WHEN all hunks of a proposal are rejected THEN no file on disk SHALL change.

### Requirement 17 — Provider settings, secrets, and provable zero telemetry

**User Story:** As a privacy-conscious developer, I want my keys in the OS keychain and a way to prove nothing phones home, so that I can trust Sketch with real work.

#### Acceptance Criteria

1. THE settings surface SHALL list the full provider matrix, SHALL allow adding a custom endpoint, and SHALL offer a connection test per provider.
2. THE provider configuration file at `~/.sketch/providers.json` SHALL contain no API key material.
3. THE core SHALL depend only on the `SecretStore` seam with `get`, `set`, and `del`; the real implementation SHALL live outside the core and SHALL use the operating system's credential store.
4. WHEN a key is needed for a run THEN it SHALL be supplied to the engine process at invocation time and SHALL NOT be persisted by the core.
5. A test SHALL assert that the strings `analytics`, `telemetry`, `sentry`, and `posthog` do not appear in `packages/**/src`.
6. A test SHALL assert that a thrown provider error does not contain the configured key value.
7. WHEN a connection test targets `http://localhost:11434/v1` with no internet access THEN it SHALL succeed against a local Ollama instance and SHALL fail with a clear diagnostic when none is running.
8. THE repository SHALL contain `PRIVACY.md` stating what leaves the machine and what does not.

### Requirement 18 — Intelligent context: graph, hybrid search, rerank, assembly

**User Story:** As a user with a large repository, I want only the relevant code sent to the model, so that runs are faster, cheaper, and more accurate than dumping the repo.

#### Acceptance Criteria

1. THE context layer SHALL build a repository graph persisted locally, with a regex-based extractor first and a tree-sitter path left open.
2. RETRIEVAL SHALL be hybrid: a lexical channel and a vector channel fused by reciprocal rank, then reranked. Vector-only retrieval SHALL NOT be the shipped default.
3. THE embedding path SHALL work fully offline via a local model, and WHERE a provider embedding endpoint is used THE results SHALL be cached locally and the tradeoff documented.
4. CONTEXT assembly SHALL combine memory, skills, top-k chunks, and one-hop graph neighbors under a token budget.
5. WHEN truncation is required THEN function and type signatures SHALL be preserved in preference to bodies.
6. WHEN context is assembled THEN a `context_assembled` event SHALL be emitted carrying the selected paths and the token estimate.
7. AGAINST a fixed fifty-file fixture THE targeted context SHALL be smaller and more relevant than the whole-repo baseline AND the held-out eval score SHALL rise.
8. THE currently unused dependency-expansion result SHALL be wired into assembly rather than discarded.

### Requirement 19 — Architecture generator

**User Story:** As a user, I want diagrams that regenerate from the real code graph, so that documentation reflects the code instead of decaying beside it.

#### Acceptance Criteria

1. THE generator SHALL derive system, API, database, component, dependency, folder-tree, and call-graph views from the code graph.
2. WHEN a diagram is regenerated THEN a `diagram_updated` event SHALL be emitted.
3. THE diagrams SHALL render in a Live Architecture surface.
4. THE generator SHALL be deterministic for a fixed graph so its output is diffable.
5. THE generator SHALL require no network access.

### Requirement 20 — Cost accounting, budget guard, routing, and cache

**User Story:** As a cost-conscious developer, I want the budget enforced inside the loop rather than reported after the fact, so that a runaway run cannot quietly spend my money.

#### Acceptance Criteria

1. EVERY `llm_response` event SHALL carry token usage.
2. THE reported session total SHALL equal the sum over recorded events; the dashboard SHALL NOT compute from any independent source.
3. THE cost guard SHALL enforce a per-task token and currency budget inside the loop.
4. WHEN a budget would be exceeded THEN the guard SHALL either downgrade to a cheaper route or stop the run with `run_failed` carrying reason `budget`, deterministically and by configuration.
5. WHEN a budget threshold is crossed THEN a `budget_exceeded` event SHALL be emitted.
6. THE router SHALL be able to send cheap or mechanical calls to a local or inexpensive model and reserve a frontier model for hard calls.
7. THE response cache SHALL be content-addressed on the local filesystem, and a repeated identical request SHALL emit `cache_hit` and SHALL NOT issue a second network call.
8. THE Cost Dashboard SHALL reconcile exactly with the event log.

### Requirement 21 — Project memory with hygiene and versioning

**User Story:** As a returning user, I want the project's memory to stay true as decisions change, so that stale knowledge does not silently poison future runs.

#### Acceptance Criteria

1. MEMORY SHALL persist decisions, architecture, summarized prior conversations, coding standards, team preferences, coding style, past bugs, performance history, and test history.
2. EVERY memory row SHALL carry `valid_from` and `valid_to` validity bounds.
3. WHEN a newer entry contradicts an older one THEN the older SHALL be superseded with a recorded reason and a `memory_superseded` event SHALL be emitted.
4. MEMORY SHALL support expiration and a lint pass that surfaces contradictions.
5. RETRIEVAL SHALL use the hybrid search path with reranking and a recency prior, and SHALL emit `memory_retrieved`.
6. WHEN a decision is inserted, then a contradicting decision is inserted, THEN a related query SHALL return the newer entry and SHALL mark the older superseded.
7. THE existing in-memory implementation SHALL remain available as the test double behind the same interface.

### Requirement 22 — Tool layer and a curated MCP registry

**User Story:** As a user, I want tool wiring, failures, and retries to be legible and fixable by me, so that I can trust the harness on real work instead of guessing why a tool warning appeared.

#### Acceptance Criteria

1. ALL side-effecting model actions SHALL route through the tool layer, and every call SHALL emit `tool_called` or `tool_denied`.
2. THE MCP registry SHALL be curated, pinned, and isolated rather than exposing arbitrary servers, and SHALL cover at least GitHub, Docker, Figma, Notion, Slack, terminal, browser, filesystem, SSH, Cloudflare, Supabase, databases, an Android emulator, and Playwright.
3. WHEN a tool server hangs THEN it SHALL time out and be marked unavailable for the remainder of the run, and the run SHALL continue.
4. TOOL grants SHALL be scoped per run and per skill capability.
5. WHEN a tool fails THEN the failure, the reason, and any retry SHALL be visible in the surface, not hidden.
6. THE existing Rust `run_command` shell passthrough SHALL be replaced by or gated behind a scoped, confirmable terminal tool rather than remaining an unrestricted shell.

### Requirement 23 — Live environment feedback

**User Story:** As a user, I want a change that breaks the running application to count as a failure, so that green unit tests cannot mask a broken app.

#### Acceptance Criteria

1. THE verification contract SHALL include a browser tool and an application runner that capture console output and runtime errors.
2. WHEN the application under test emits a runtime error THEN the task SHALL NOT be reported done.
3. WHEN the application fails to start THEN that SHALL be reported as a verification failure with captured output.
4. THE live-feedback stage SHALL be skippable for projects where it does not apply, without failing them.

### Requirement 24 — Eval-gated multi-agent strategies and the twelve-role brain

**User Story:** As a user, I want extra agents only when they are proven to help, so that I am not paying for a swarm that underperforms one well-tooled agent.

#### Acceptance Criteria

1. THE default strategy for every task SHALL be `single`.
2. THE dispatcher SHALL support `single`, `plan-then-code`, and `swarm`, SHALL emit `strategy_selected`, and SHALL record which strategy succeeded.
3. ESCALATION to a heavier strategy SHALL occur only after the lighter strategy fails within its eval and verify budget.
4. THE role set SHALL be CEO, Planner, Research, Architect, Backend, Frontend, Database, Security, Testing, Reviewer, Performance, Deployment, and Documentation, each implemented as a constrained sub-run with its own verification signal.
5. NO role SHALL be added without a distinct verification signal.
6. EACH sub-run SHALL follow the inner loop goal, memory, thinking, action, verification, feedback, retry, consensus.
7. MERGING SHALL be deterministic: the union of verified non-conflicting edits; a conflict SHALL create a new task and SHALL NOT be guessed.
8. `swarm` SHALL become a default for a task class only after a measured pass@k improvement over `single` on the internal suite; otherwise it SHALL remain off. This gate is non-negotiable.
9. MULTI-MODEL consensus SHALL run only inside `swarm`.

### Requirement 25 — Honest benchmarks and regression protection

**User Story:** As a skeptical evaluator, I want lift reported against a naive harness across several models, so that the numbers say something about Sketch rather than about the model.

#### Acceptance Criteria

1. THE internal eval suite SHALL be scored by the eval harness and the verification contract.
2. REPORTED metrics SHALL include task completion rate, build success rate, test pass rate, number of manual edits required, time to completion, and cost.
3. PASS@K SHALL be reported under a fixed budget together with the distribution, not only the best case.
4. PUBLIC benchmarks SHALL be framed as inputs, presented as lift of `M + Sketch` over `M + naive` across several models, never as a headline claim of beating a model.
5. A `bench` script SHALL produce a report artifact.
6. CI SHALL fail when internal-suite lift regresses.

### Requirement 26 — Packaging, offline proof, and extensibility

**User Story:** As a new user on a clean machine, I want to install Sketch and have it work with no account and no internet beyond my own model, so that the local-first promise is verifiable rather than marketing.

#### Acceptance Criteria

1. THE project SHALL produce Tauri builds for macOS, Windows, and Linux with a documented size budget.
2. ON a clean offline machine with a local model available THE app SHALL install, index a repository, and complete a task with no external network call other than to the local model endpoint.
3. THE repository SHALL contain `LICENSE` (MIT or Apache-2.0), `README.md` with a $0 stack recipe, `PRIVACY.md`, and `CONTRIBUTING.md`, and releases SHALL be signed.
4. A community skill SHALL install, run, and train on captured evals with no Sketch server involved.
5. EVERY extension point — providers, agents, skills, tools, models, memory, workflows, themes, languages — SHALL be pluggable and documented.
6. THE `.gitignore` SHALL exclude build output, `node_modules`, and the local `.sketch` working directory.

### Requirement 27 — Observability surfaces

**User Story:** As a user, I want each subsystem to have a real panel backed by real events, so that the harness is inspectable instead of opaque.

#### Acceptance Criteria

1. THE app SHALL provide these surfaces, each reading real data: Explorer, AI Team, Live Architecture, Memory, Tasks, Agent Console, Terminal, Timeline with replay, Cost Dashboard, Benchmarks, Git, Debugger, Test Results, and Provider Settings.
2. THE Timeline SHALL reconstruct a run from the event log alone.
3. WHEN a panel has no data yet THEN it SHALL show an honest empty state rather than sample data.
4. EVERY panel SHALL be reachable through navigation; no shipped panel SHALL be unreachable.
5. WHEN a tool is misconfigured or failing THEN the affected surface SHALL name the tool and the reason.

### Requirement 28 — Documentation reconciliation

**User Story:** As a contributor reading the repository docs, I want them to agree with the code and the current plan, so that the rules I am asked to follow are the real rules.

#### Acceptance Criteria

1. `rules.md` SHALL be amended so that consensus and multi-agent code is permitted from v2 behind the eval gate, replacing the blanket v1 prohibition, while keeping single-agent as the default.
2. `what-not-we-are-building.md` SHALL be amended so that the skills registry and marketplace are scoped as v1.5/v2 deliverables with signing and capability scoping as preconditions, resolving the conflict with the existing skills surface.
3. `trd.md` SHALL be amended to record the dependency-free core decision, replacing the mandated `better-sqlite3`, `sqlite-vec`, `keytar`, and MCP SDK dependencies with the seam-plus-implementation approach actually used.
4. `trd.md` and `architecture.md` SHALL be amended to record the workspace layout, the event-sourced JSONL log, the `.sketch/` working directory layout, and the nine-stage verification contract.
5. `prd.md` SHALL be amended to reflect the two-surface product and the three optimization metrics.
6. `tasks-executed.md` SHALL be updated as each phase gate goes green, including a decision-log row for every architectural decision recorded in this spec.
7. WHERE this spec and an existing document conflict THIS spec SHALL be authoritative until the document is amended.
