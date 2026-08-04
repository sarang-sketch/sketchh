# Design Document

## Overview

Sketch is one desktop window over one substrate. The frontend holds no business logic; the engine holds all orchestration; "serverless" describes the deployment truth (no Sketch compute) and the provider layer (serverless inference endpoints included), never a Sketch-operated server.

This design is a **brownfield migration plus twelve additive phases**. The existing `engine/` package already contains four of the subsystems in a shape close to what we need, and the existing `desktop/` package already contains the visual language and layout. What is missing is the spine that makes them one system: an event-sourced log, an eval harness, a plan gate, a skill layer, a CLI protocol, and a client seam. Those are built first because everything downstream reads from them.

### Design principles carried into every decision

1. **The event log is the spine.** Timeline, replay, cost accounting, eval capture, and benchmark reporting are all projections of one JSONL stream. Nothing gets a private log.
2. **Seams over frameworks.** Every boundary that could tempt a dependency becomes an interface with a fake and a real implementation: `ChatAdapter`, `EventStore`, `SecretStore`, `CommandRunner`, `VectorStore`, `Embedder`, `SketchClient`, `proposeEdit`.
3. **Gates are enforced in the engine.** UI enforcement is a convenience; the CLI path must not be able to bypass the plan gate, the scope check, or the budget guard.
4. **Additive migration.** Existing tests are the regression suite for the migration. A refactor that breaks them is wrong until proven otherwise.

---

## Architecture

### Three tiers

```
┌──────────────────────────────────────────────────────────────────┐
│ FRONTEND — packages/desktop (Tauri webview / browser dev)         │
│ React + TS + Monaco. No business logic.                           │
│ ModeToggle: Cowork | Code — changes the surface, not the brain.    │
│ Panels: Explorer · AI Team · Live Architecture · Memory · Tasks    │
│         Agent Console · Terminal · Timeline · Cost · Benchmarks    │
│         Git · Debugger · Test Results · Provider Settings          │
└───────────────────────────┬──────────────────────────────────────┘
                            │  SketchClient seam only
                            │  Mock | Stdio (sidecar) | Http (dev)
┌───────────────────────────▼──────────────────────────────────────┐
│ BACKEND — packages/core  (@sketch/core, zero runtime deps)         │
│ A long-lived LOCAL process. Not a cloud server.                    │
│                                                                    │
│  Orchestrator ── strategy dispatcher ── agent loop                 │
│       │                                                            │
│       ├── Planning artifact writer  →  .sketch/plan/<runId>/        │
│       ├── Provider adapter layer    →  raw fetch, 2 kinds           │
│       ├── Event store (JSONL)       →  .sketch/events/<date>.jsonl  │
│       ├── Verify policy + runner    →  9 ordered stages             │
│       ├── Eval harness + capture    →  .sketch/evals/evals.jsonl    │
│       ├── SkillOpt trainer + GATE   →  best_skill.md                │
│       ├── Skills loader + registry  →  SKILL.md / skill.json        │
│       ├── Context: graph, hybrid search, rerank, assembly          │
│       ├── Architecture generator    →  diagrams from the graph      │
│       ├── Memory: versioned rows, hygiene, reranked retrieval       │
│       ├── Tools / MCP: curated, isolated, capability-scoped          │
│       ├── Cost: accounting, guard, routing, content-addressed cache │
│       └── Secrets: SecretStore seam (no key ever persisted here)    │
└───────────────────────────┬──────────────────────────────────────┘
                            │  raw fetch, user-configured endpoints only
┌───────────────────────────▼──────────────────────────────────────┐
│ PROVIDERS — direct APIs · serverless endpoints · local models      │
│ OpenAI · Anthropic · Gemini · Groq · OpenRouter · GitHub Models    │
│ Azure · Cloudflare Workers AI · Ollama · llama.cpp · Custom        │
└──────────────────────────────────────────────────────────────────┘
```

### Target folder layout

```
sketch/
├── package.json            (npm workspaces root)
├── .gitignore  README.md  LICENSE  PRIVACY.md  CONTRIBUTING.md
├── prd.md  trd.md  architecture.md  rules.md  tasks-executed.md
├── what-we-are-building.md  what-not-we-are-building.md
└── packages/
    ├── core/                          (was engine/)
    │   ├── package.json  tsconfig.json
    │   ├── src/
    │   │   ├── types.ts  index.ts  cli.ts
    │   │   ├── events/store.ts
    │   │   ├── skills/{loader,registry,trainer}.ts
    │   │   ├── providers/{openaiCompatible,anthropicMessages,fake,registry}.ts
    │   │   │              + existing openai, anthropic, gemini, openai-compatible, base
    │   │   ├── verify/{runner,policy}.ts        (+ existing detector, command-runner)
    │   │   ├── loop/{agent,strategies}.ts
    │   │   ├── plan/writer.ts
    │   │   ├── evals/{runner,capture}.ts
    │   │   ├── context/{graph,search,assemble}.ts  (+ existing walker, chunker, …)
    │   │   ├── arch/generator.ts
    │   │   ├── tools/{git,browser,terminal,mcp}.ts
    │   │   ├── memory/{schema,hygiene,retrieve}.ts
    │   │   ├── cost/{accounting,guard,cache,router}.ts
    │   │   ├── bench/report.ts
    │   │   └── secrets/index.ts
    │   └── test/  frontmatter store verify loop evals trainer cli secrets cost …
    └── desktop/                       (was desktop/)
        ├── package.json  tsconfig.json  vite.config.ts  index.html
        ├── src/
        │   ├── main.tsx  App.tsx
        │   ├── lib/{client,mockClient,stdioClient,httpClient,factory}.ts
        │   ├── state/  ui/  panels/  components/
        └── src-tauri/  tauri.conf.json  capabilities/default.json  src/main.rs
```

### `.sketch/` working directory (per project, gitignored)

```
.sketch/
├── plan/<runId>/         prd.md  stories.md  architecture.md  folders.md
│                         components.md  api.md  schema.md  security.md
│                         tests.md  milestones.md  risks.md  dependencies.md
├── events/<YYYY-MM-DD>.jsonl        append-only, one SketchEvent per line
├── evals/evals.jsonl                captured eval cases
├── cache/<sha256[0:2]>/<sha256>     content-addressed response cache
├── index/graph.json                 repo graph + embeddings index
├── memory/memory.jsonl              versioned memory rows
├── skills/<name>/                   installed skills + best_skill.md
└── bench/<timestamp>.json           benchmark reports
```

---

## Resolved conflicts and their rationale

The repository contains a prior generation of specification documents that conflict with this build in ten places. Each is resolved here; Requirement 28 tracks amending the source documents.

| # | Conflict | Resolution | Rationale |
|---|---|---|---|
| 1 | `trd.md` mandates `better-sqlite3`, `sqlite-vec`, `keytar`, `@modelcontextprotocol/sdk`; the constraint is a dependency-free core | Core stays dependency-free. Each becomes a seam: persistence via a `Store` interface with a JSONL/file default, credentials via `SecretStore` implemented in the Tauri layer, MCP via a hand-rolled JSON-RPC client over stdio | A local-first install must never fail on a native module. The existing code already honors this; only the docs do not |
| 2 | `trd.md` declares a flat layout; the constraint is `packages/core` + `packages/desktop` | Migrate to workspaces. `engine/` → `packages/core` renamed `@sketch/core`; `desktop/` → `packages/desktop` | One install, one build, one test command; the CLI must be bundleable from a known path |
| 3 | Existing `ProviderAdapter` has `complete/stream/listModels/estimateCost`; the contract specifies `ChatAdapter.chat()` | Both. `ChatAdapter` is the minimal seam the loop depends on; existing adapters implement it in addition to their richer surface | Non-destructive. All 34 provider tests keep passing while the loop depends on the smallest possible interface |
| 4 | `rules.md` R4 forbids consensus code in v1 | Amend: single-agent remains the default forever; consensus and roles are v2 code behind the eval gate | The docs said "defer to v2 with evidence". The eval gate *is* the evidence mechanism, so this is fulfillment, not scope creep |
| 5 | `what-not-we-are-building.md` forbids a skills marketplace, yet `SkillsMarketplace.tsx` exists | Amend: curated signed registry is v1; open marketplace is v2 and blocked on signing plus capability scoping | The existing panel is a mock. The prohibition was against an unsigned ecosystem play, which the gate preserves |
| 6 | Verification order: docs say lint→typecheck→test→build; contract says format→lint→typecheck→unit→integration→security→performance→dependency-audit | Nine stages, `build` inserted after `typecheck` | Integration tests, security scans, and performance checks generally need a build artifact. Cosmetic ambiguity, decided and noted |
| 7 | Docs are silent on the event log; declared persistence is relational | JSONL event log is the single source of truth for run history; relational-style memory rows live in their own versioned store | Replay, capture-as-eval, and cost reconciliation all need an ordered append-only stream |
| 8 | Docs say planning happens "for non-trivial tasks" and approval is optional | Planning is always on and the plan artifact is a hard precondition for editing; *approval* remains optional | Planning is cheap and single-model. The gate is about having written the plan down, not about blocking on a human |
| 9 | `tasks-executed.md` claims Milestone 4 is unstarted; substantial desktop code exists | Treat the log as stale; reconcile it during Phase 1 | R9 calls the log the single source of truth for what is built; it must be made true |
| 10 | `rules.md` R6 mandates keytar specifically | Amend to "the OS credential store, accessed outside the core" | keytar is an unmaintained native module; the requirement is the keychain, not the library |

### Decisions this design makes on its own authority

- **Node's built-in SQLite is not required.** Persistence uses a `Store` seam whose default implementation is line-oriented files (JSONL + a JSON index). This keeps the core dependency-free with no Node feature flags and no version floor beyond Node 20. A `node:sqlite`-backed implementation may drop in later behind the same interface if scale demands it. Recorded because `trd.md` and the decision log both assume SQLite.
- **keytar is dropped, not migrated.** Secret storage moves to the Rust side of the Tauri app. The core never sees a persisted key.
- **`run_command` as an unrestricted shell is a security defect, not a feature.** Today the Rust command runs arbitrary strings through `cmd /C` or `sh -c` with no allowlist and no confirmation, and the Tauri v2 capabilities file that would constrain the fs and shell plugins does not exist. This is treated as a Phase 4 hardening item, not deferred to Phase 7.
- **The provider registry singleton is removed.** Adapter instances are constructed per resolution so configured keys are never process-global state.
- **Run ids are random and time-sortable**, not a module-global counter, so runs from concurrent processes cannot collide in the event log.

---

## Core contracts

These types are the contract for Phase 1 and are reproduced exactly. Everything is serializable.

```ts
export type EventKind =
  | "run_started" | "plan_written" | "skill_loaded" | "context_loaded" | "context_assembled"
  | "repo_indexed" | "context_retrieved" | "embedder_degraded"
  | "llm_request" | "llm_response" | "think" | "ask" | "ask_answered"
  | "verify_started" | "verify_result"
  | "edit_proposed" | "edit_accepted" | "edit_rejected"
  | "tool_called" | "tool_denied"
  | "budget_exceeded" | "cache_hit" | "strategy_selected" | "model_selected"
  | "memory_retrieved" | "memory_superseded" | "diagram_updated"
  | "skill_trained"
  | "run_completed" | "run_failed" | "eval_scored";

export interface SketchEvent { id: string; ts: number; runId: string; kind: EventKind; payload: Record<string, unknown>; }
export interface Skill { name: string; description: string; body: string; source: string; capabilities?: string[]; }
export interface ProjectContext { agents: string; claude: string; }
export interface Message { role: "system" | "user" | "assistant" | "tool"; content: string; }
export interface Usage { in: number; out: number; }
export interface ChatAdapter {
  readonly id: string;
  chat(m: Message[], o?: { signal?: AbortSignal }): Promise<{ text: string; usage?: Usage }>;
}
export type ProviderKind = "openai-compatible" | "anthropic-messages";
export interface ProviderConfig {
  id: string; kind: ProviderKind; baseUrl: string; model: string;
  apiKey?: string; headers?: Record<string, string>;
}
export interface VerifyCommand { name: string; cmd: string; args?: string[]; cwd?: string; timeoutMs?: number; }
export interface VerifyResult { name: string; ok: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number; }
export interface Task { id: string; prompt: string; verify: VerifyCommand[]; skillNames?: string[]; }
export interface RunResult { runId: string; ok: boolean; finalText: string; iterations: number; verify: VerifyResult[]; events: SketchEvent[]; }
export type Check = { kind: "verify-pass" } | { kind: "contains"; text: string } | { kind: "not-contains"; text: string };
export interface EvalCase { id: string; task: Task; checks: Check[]; }
export interface EvalResult { caseId: string; score: number; passed: boolean; passedChecks: number; totalChecks: number; detail: string; }
export interface SecretStore { get(id: string): Promise<string | null>; set(id: string, v: string): Promise<void>; del(id: string): Promise<void>; }
```

Note the deliberate naming collision with existing engine types: the existing `VerifyResult` (an aggregate of `CheckResult[]`) is renamed `VerifySummary` during migration, and the new per-command `VerifyResult` above takes the name. The existing `RunResult` in `orchestrator.ts` is renamed `OrchestratorRunResult`. Both renames are mechanical and covered by the existing test suite.

#### `EventKind` amendment — six explicit kinds, and what stays a payload discriminator

The union originally had 24 members. Phases 5 through 12 added five subsystems that had facts to report and no kind to report them under, and because inventing a kind requires a spec change, each overloaded an existing kind with a `component` key in the payload. Eleven such sites accumulated; three unrelated facts shared `context_assembled`, and `think` carried both skill training and the loop's `ask`. A Timeline consumer had to read the payload to learn what an event was.

Six kinds are therefore added, taking the union to **30**. The test for whether a fact earns a kind: **a distinct subsystem reporting a distinct fact gets one; a variant of the same fact does not.**

| Kind | Emitter | Was | Fact |
|---|---|---|---|
| `repo_indexed` | `context/repo-graph.ts` | `context_loaded` + `component: "repo-graph"` | The repository index was built or incrementally rebuilt |
| `context_retrieved` | `context/hybrid-search.ts` | `context_assembled` + `component: "hybrid-search"` | Retrieval ran, and which channels ran or degraded |
| `embedder_degraded` | `context/offline-embedder.ts` | `context_loaded` + `component: "embedder"` | The embedding provider became unreachable and local hashing vectors took over |
| `model_selected` | `loop/agent.ts` (cost router) | `strategy_selected` + `component: "router"` | A model-tier decision under `router.policy`, which is not a strategy decision |
| `skill_trained` | `skills/trainer.ts` | `think` + `component: "skillopt"` | SkillOpt training narration, off the hot path |
| `ask` | `loop/agent.ts` | `think` + `action: "ask"` | The run stopped because it needs a human answer |
| `ask_answered` | `loop/agent.ts` | — (new fact, added with the reply channel) | A human answered an `ask` and the run resumed |

#### `ask_answered` — why a kind and not a payload key on `ask`

The reply channel made `ask` ambiguous. Before it, `ask` meant one thing: the run
stopped and no answer was possible. With a channel, the same kind would have had to
mean both "stopped, unanswered" and "paused, then resumed" — which is precisely the
overloading rule 1a forbids. The two have different causes (no channel or a decline,
versus a human acting), different actors, and different consequences for the run, so a
consumer must not have to read a payload key to tell them apart. `ask` therefore keeps
its original meaning of "a question was raised", and `ask_answered` records that one was
answered. A run that ends unanswered emits `ask` with no `ask_answered` after it.

The channel is OPT-IN (`params.interactive`). Absent, the loop behaves exactly as before,
because the eval harness and every CLI caller are headless and blocking on a human would
hang them. The wait is bounded and an abort ends it, so an interactive run whose surface
went away cannot hold the engine open indefinitely.

Five sites keep `component`, because the discriminator is describing provenance rather than telling two facts apart:

- **`context_assembled`** — `assembly` (the budgeted assembly step, the only emitter with `primary: true`, the selected paths and the token estimate Requirement 18.6 asks for) and `agent-loop` (the loop's message-count breadcrumb). Both report that the context for this turn is now fixed; they differ in fidelity, not in kind.
- **`tool_called` / `tool_denied`** — `mcp` and `registry`. A tool call is a tool call; `component` names which provider ran or refused it.
- **`strategy_selected`** — `dispatcher` is now its only emitter. The key is kept, and consumers keep checking it, because logs written before this amendment carry router events under this kind.
- **`diagram_updated`** — `architecture` is its only emitter; the key is provenance.

`context_loaded` stays in the union with no emitter: it is published contract and appears in logs already on disk.

**Log compatibility.** The event store's reader validates shape, not `kind` — a line whose kind is not a union member still parses and still renders. Old JSONL logs therefore continue to display, under their old kind names, with their payloads intact. What is *not* claimed: old lines do not retroactively gain the new kinds' rendering. An old `context_loaded{component:"repo-graph"}` line shows as `context_loaded` with no one-line summary, exactly as it did before. Consumers that discriminate on `component` are unchanged, so no old line is newly misread.

### Model action protocol

The model speaks JSON, fenced or bare. Unknown shapes degrade to `think` rather than failing the run — the existing `extractJson()` already recovers JSON from fenced blocks, prose, and nested braces and is reused verbatim.

```json
{ "action": "plan",   "artifacts": { "prd": "...", "arch": "...", "schema": "...", "tests": "..." } }
{ "action": "verify" }
{ "action": "edit",   "edits": [ { "path": "...", "search": "...", "replace": "..." } ] }
{ "action": "tool",   "name": "<tool>", "args": {} }
{ "action": "think",  "text": "..." }
{ "action": "ask",    "question": "..." }
{ "action": "done",   "text": "..." }
```

Loop rules:

1. The first model turn should be `plan`. The orchestrator writes `.sketch/plan/<runId>/` and emits `plan_written`.
2. No `edit` executes until a plan artifact exists. Violation emits `edit_rejected` and feeds the refusal back.
3. On `verify`, run the task's commands and feed PASS/FAIL plus output back; iterate until `done` or `maxIterations`.
4. `done` is `ok` only if all verify stages passed, or none were configured.
5. Emit the event for every action **before** executing it.
6. Tool calls pass through the scoped tool layer; out-of-scope calls emit `tool_denied` and feed back.

### The SkillOpt validation gate

This is the anti-rot mechanism and the reason the harness compounds. The optimizer is swappable; **the gate is ours and never moves**.

```ts
let best = seed;
let bestVal = meanScore(await runEvalSet(val, depsFor(best)));
for (let e = 1; e <= epochs; e++) {
  const trainRes = await runEvalSet(train, depsFor(best));
  const cand = await proposeEdit(best, trainRes);          // injected seam
  if (!cand) continue;
  const candVal = meanScore(await runEvalSet(val, depsFor(cand)));
  if (candVal > bestVal) { best = cand; bestVal = candVal; }   // STRICT
}
```

`proposeEdit` is a seam: a deterministic stub offline, a provider call or the real SkillOpt optimizer in Phase 6.4. Strict `>` means ties keep the incumbent, so noise cannot ratchet a skill into decay.

---

## Components and interfaces

### Phase 1 — Engine baseline `[BE + FE shell]`

**Provider layer.** Two new dep-free adapters (`openaiCompatible.ts`, `anthropicMessages.ts`) implementing `ChatAdapter` over raw `fetch`, plus `fake.ts` and a rebuilt `registry.ts` resolving `ProviderConfig → ChatAdapter`. Existing adapters gain a `chat()` method. Error redaction is centralized in one `redact()` helper applied to every thrown provider error.

**Skill and context loader.** Hand-rolled YAML frontmatter parser supporting scalars, quoted strings, and inline/block sequences — enough for `SKILL.md`, no more. `AGENTS.md` and `CLAUDE.md` load into `ProjectContext`. The `skill.json` folder layout normalizes into the same `Skill` shape: `skill.json` supplies `name`/`description`/`capabilities`, `README.md` plus concatenated `prompts/` supply `body`.

**Event store.** `EventStore` interface, `JsonlEventStore` (append via `appendFile`, read via line split with malformed-line tolerance), `MemoryEventStore`. Ids from `crypto.randomUUID()`; run ids time-prefixed for sortability.

**Verify runner.** New `verify/runner.ts` using `spawn` with `shell: false`, per-command timeout with SIGKILL, returning the new per-command `VerifyResult`. The existing `ChildProcessRunner` uses `shell: true` and is superseded on the new path while remaining for the legacy `Verifier`.

**Agent loop.** `loop/agent.ts` implements `runTask`. Fully injected: `{ adapter, events, verify, files, plan, clock, ids, maxIterations }`.

**Eval harness.** `evals/runner.ts` — built before the things it judges, per the master constraint.

**Trainer.** `skills/trainer.ts` with the gate above and a stub `proposeEdit`.

**CLI.** `cli.ts` — readline over stdin, one JSON frame per line, methods `ping|run|eval|parse-skill|capture-eval`. Protocol frames on stdout only; diagnostics on stderr.

**Desktop shell.** `ModeToggle` (already exists as the Cowork/Code pill), `AgentTimeline` reading events, `MockSketchClient`, Agent Console.

*Gate:* `npm install && npm run build && npm test` exits 0 offline with no key.

### Phase 2 — Real bridge and save-as-eval `[BE + FE + SL]`

esbuild bundles `cli.ts` to a single file registered as a Tauri `externalBin`; the app spawns it on load and forwards stdio through `StdioSketchClient`. For browser dev, a ~25-line Vite plugin uses `configureServer` and Node's built-in `http` to serve `POST /__sketch` and `GET /__sketch/events` (SSE) — no Express, no Hono. `VITE_BRIDGE` selects the transport in one factory. `captureRunAsEval(run, want)` appends to `.sketch/evals/evals.jsonl` and the Timeline gains a capture control.

*Gate:* native and browser both drive the real engine offline; a captured case re-scores 1.0; no mock client on a real path.

### Phase 3 — Code surface `[FE + BE]`

Monaco with `Map<path, model>`. **Trap T11 is the crux:** the existing `AppState` already declares `openFiles`, `activeFile`, and `files` but nothing dispatches them, while `EditorArea` keeps its own local `hasFileOpen`. Resolution: `AppState` becomes the single owner, `EditorArea`'s local state is deleted, and engine writes flow back through the client event stream into the same reducer. Diff review renders proposals with per-hunk accept/reject wired to `edit_accepted`/`edit_rejected`. `tools/git.ts` shells out and replaces `GitPanel`'s three mock arrays. Explorer, Terminal, and Debugger panels get real backing. The plan gate is mirrored in the UI by disabling apply-edit controls until `plan_written`.

*Gate:* open → edit → run → review diff → accept → git status, offline, with the plan gate enforced.

### Phase 4 — Settings, secrets, zero telemetry `[FE + BE + SL]`

Provider Settings UI over the full matrix with add-custom and test-connection, writing key-free `~/.sketch/providers.json`. `SecretStore` seam in core; the real implementation is Rust-side using the OS credential store, surfaced through new Tauri commands. The missing `src-tauri/capabilities/default.json` is added, granting only what is used, and the unrestricted `run_command` is replaced by a scoped terminal tool. `PRIVACY.md` plus a grep test asserting `analytics|telemetry|sentry|posthog` are absent from `packages/**/src`, plus a redaction test.

*Gate:* keys only in the OS store; `providers.json` key-free; grep clean; connection test against `http://localhost:11434/v1` with no internet.

### Phase 5 — Intelligent context `[BE]`

Pipeline: indexer → embeddings → dependency graph → semantic search → relevant files only → model. The graph persists to `.sketch/index/graph.json`. Hybrid search fuses a ripgrep-backed lexical channel with the existing vector channel by reciprocal rank, then reranks — **never vector-only (T6)**. Offline embeddings via a local model, with provider embeddings cached locally as a documented fallback. Assembly combines memory, skills, top-k, and one-hop neighbors under a token budget, preserving signatures when truncating, and finally consumes the `expandWithDependencies` result that today is computed and discarded. The Architecture Generator derives seven diagram views from the same graph and emits `diagram_updated`.

*Gate:* on a fifty-file fixture, targeted context is smaller and more relevant AND the held-out score rises; diagrams render.

### Phase 6 — Skills registry and trainer `[BE + FE]`

Pinned manifest with content hashes; a tampered hash is rejected. `capabilities:` enforced at the tool and filesystem layer so a no-network skill cannot fetch. Seed registry: context packing, web/data, general engineering, frontend design, research pack, finance/quant pack. The open marketplace ships only after signing and scoping, with a review queue. Phase 6.4 wires the real optimizer into `proposeEdit` while keeping our gate, behind a "Train this skill on my project" action running on captured evals over a train/val split, cost-guarded and off the hot path.

*Gate:* signed install and scope enforcement offline; the stub-optimizer trainer improves a seed skill and rejects a regression.

### Phase 7 — Verification contract and MCP `[BE + FE]`

`verify.yaml` policy with per-stack auto-detection. Live environment feedback via a browser tool and an app runner capturing console output and runtime errors, so a runtime error means not done. Curated isolated MCP registry with per-run scoped grants; a hanging server times out and is marked unavailable for the run without hanging it. Test Results panel.

*Gate:* broken tests or a broken running app ⇒ not done; a hanging tool cannot hang a run.

### Phase 8 — Cost and budget `[BE + FE]`

Usage rides on `llm_response`; the dashboard total equals the event sum by construction. The guard enforces per-task token and currency budgets **inside** the loop, downgrading or stopping with `run_failed{reason:"budget"}`. Cost-aware routing sends mechanical calls cheap or local. Content-addressed cache on the local filesystem emits `cache_hit` and skips the second call.

*Gate:* overrun stops or downgrades deterministically; a cache hit avoids the second call; the dashboard reconciles with the log.

### Phase 9 — Memory and hygiene `[BE + FE]`

Rows carry `valid_from`/`valid_to`. Newer entries supersede older with a recorded reason and a `memory_superseded` event. Expiration plus a memory-lint pass for contradictions. Retrieval reuses the Phase 5 hybrid path with reranking and a recency prior. The existing in-memory implementation stays as the test double behind the same interface.

*Gate:* insert a decision, insert a contradicting decision, and a related query returns the newer while the older is marked superseded.

### Phase 10 — Eval-gated multi-agent `[BE + FE]`

`single` stays the default. The dispatcher supports `single | plan-then-code | swarm`, emits `strategy_selected`, and records which strategy succeeded. Escalation happens only after the lighter strategy fails within its eval and verify budget. The thirteen roles are constrained sub-runs, each with its own verification signal (**T2**) and the inner loop goal → memory → thinking → action → verification → feedback → retry → consensus. Merging is deterministic: union of verified non-conflicting edits; conflicts create a new task. Consensus runs only inside `swarm`.

*Gate:* `swarm` becomes a default for a task class only after measured pass@k lift over `single`. Non-negotiable.

### Phase 11 — Honest benchmarks `[BE + FE]`

Internal suite scored by the eval harness and the verification contract. Metrics: task completion rate, build success rate, test pass rate, manual edits required, time to completion, cost. Pass@k under a fixed budget plus the distribution. Public benchmarks framed as lift of `M + Sketch` over `M + naive` across several models. `bench` script plus CI failing on lift regression.

### Phase 12 — Packaging and the open flywheel `[all tiers]`

Cross-platform Tauri builds with a documented size budget. Local-first proof on a clean offline machine: install → index → run a task on local Ollama with zero external calls beyond Ollama. `CONTRIBUTING.md`, signed releases, marketplace retaining hash plus scope plus review. Flywheel check: a community skill installs, runs, and trains on captured evals with no Sketch server. Extensibility audit confirming providers, agents, skills, tools, models, memory, workflows, themes, and languages each have a documented extension point.

**Canonical v2 acceptance:** the "build an Airbnb clone" flow — planner creates PRD → stories → research → architecture → database → API → splits → assigns → agents build → merge → test → debug → review → deploy — runs end to end with the plan gate, verification contract, consensus, and cost guard all observable in the Timeline, completing with every check green.

---

## Data models

**Event log line** — one `SketchEvent` per line, append-only, malformed lines skipped on read.

**Plan artifact** — a directory per run containing the twelve markdown documents listed in the `.sketch/` layout. Presence and non-emptiness is the gate condition.

**Memory row**

```ts
interface MemoryRow {
  id: string;
  kind: "decision" | "architecture" | "conversation" | "standard" | "preference"
      | "style" | "bug" | "performance" | "test";
  key?: string;
  body: string;
  reason?: string;          // why this superseded a prior row
  supersedes?: string;      // id of the row this replaces
  validFrom: number;
  validTo: number | null;   // null = currently valid
  embedding?: number[];
}
```

**Repo graph** — `{ nodes: Record<path, { symbols, size, hash }>, edges: Record<path, path[]> }`, persisted as JSON, rebuilt incrementally by content hash. The existing `walkProject`, `chunkFile`, and `buildDependencyGraph` supply this; `walkProject` currently has no test coverage and gets one during migration.

**Cache entry** — key is `sha256(providerId + model + JSON.stringify(messages) + options)`; value is the serialized response. Stored under `.sketch/cache/`.

---

## Error handling

| Failure | Behavior |
|---|---|
| Provider non-2xx | Throw with status and provider id, `Authorization`/`x-api-key` redacted; retry with backoff up to 3 for transient classes |
| Unparseable model output | Degrade to `think`, continue the loop |
| Verify command timeout | SIGKILL, report failure with captured output, never hang |
| Tool server hang | Time out, mark unavailable for the run, continue |
| Out-of-scope tool call | `tool_denied`, feed back to the model, never execute |
| Edit before plan | `edit_rejected` with reason, feed back |
| Budget breach | Downgrade or `run_failed{reason:"budget"}` per configuration |
| Malformed event line | Skip and continue reading |
| Malformed skill frontmatter | Diagnostic naming the file, skip that skill |
| Index failure | Degrade to a file list rather than failing the run |
| Missing credential | Prompt to re-enter; never echo the value |
| Write outside project root | Refuse via the existing `isWithin` guard |

---

## Testing strategy

**The gate is offline.** Every phase gate command must exit 0 with no network and no API key. The only documented exception is the real optimizer run in Phase 6.4.

- **Unit** — pure functions and adapters: frontmatter parsing, event store round-trip, redaction, JSON extraction, cosine similarity, reciprocal-rank fusion, topological sort, path containment, cost arithmetic, budget arithmetic, cache keying.
- **Contract** — every seam gets a fake/real pair and a shared test asserting both satisfy the interface.
- **Integration** — the agent loop end to end on `FakeChatAdapter` against a temp directory; the verify loop with a scripted `CommandRunner`; the CLI driven by writing frames to stdin and asserting frames on stdout.
- **Gate tests** — one per phase, asserting the phase's stated gate. The plan gate, the strict trainer gate, the budget stop, the cache hit, the tamper rejection, the scope denial, the memory supersession, and the lift-regression check each get a dedicated test that fails before the feature and passes after.
- **Regression** — the existing 97 tests are the migration's safety net. Phase 1 is not green until all of them still pass under the new layout.
- **Property-based** — worth applying to the frontmatter parser, reciprocal-rank fusion, the event log's append/read round-trip, budget accounting arithmetic, and the diff hunk apply/reject logic, where invariants are cheap to state and edge cases are dense.
- **Security assertions** — grep test for telemetry strings; redaction test on thrown errors; a test asserting captured eval files carry no key material.

---

## Sequencing and dependencies

```
P1 (baseline: types, providers, events, verify, loop, evals, trainer, CLI, shell)
 └─> P2 (sidecar + dev bridge + capture-as-eval)
      ├─> P3 (Code surface, Monaco, diff review, single file state)
      │    └─> P4 (settings, secrets, capabilities hardening, 0-telemetry)  ── v1 ──┐
      └─> P5 (context: graph, hybrid, rerank, assembly, arch generator)             │
           ├─> P6 (signed registry, scopes, real optimizer)                         │
           └─> P8 (cost accounting, guard, routing, cache)          ── v1.5 ────────┤
                └─> P7 (verification contract, live env, MCP)                       │
                     ├─> P9 (memory versioning + hygiene)                           │
                     │    └─> P10 (strategy dispatcher, roles, consensus)           │
                     │         └─> P11 (benchmarks + lift CI)                       │
                     │              └─> P12 (packaging, offline proof, flywheel) ─ v2┘
```

Phases 3 and 5 are independent after Phase 2 and can proceed in parallel. Phase 6 and Phase 8 are independent after Phase 5.
