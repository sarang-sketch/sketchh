# Architecture

## Overview

Sketch is a local-first desktop application with no Sketch server, account system, telemetry
backend, or hosted model. Orchestration and project state stay on the user's machine. A run may call
only the provider and tool endpoints the user configured and authorized; local providers remain a
first-class path.

```
┌───────────────────────────────────────────────────────────┐
│             Tauri Host + React/Monaco Surfaces            │
│      native commands │ stdio sidecar │ HTTP dev bridge    │
├───────────────────────────────────────────────────────────┤
│                Dependency-free @sketch/core               │
│      Plan → Act → Verify → Feedback → Complete/Fail       │
├───────────────┬────────────────┬──────────────────────────┤
│ Context/Index │ Strategy/Agent │ Capability-scoped Tools  │
│               │                │ first-party + MCP stdio  │
├───────────────┴────────────────┴──────────────────────────┤
│ EventStore + MemoryStore + VectorStore + SecretStore seams│
│ JSONL/files    JSONL/files      in-memory      host-owned │
├───────────────────────────────────────────────────────────┤
│ Provider adapters: hosted, local, and custom endpoints    │
└───────────────────────────────────────────────────────────┘
```

The run event stream is the system spine. Project memory, repository indexes, caches, installed
skills, and plans are separate projections/artifacts under the same project-local state directory.

---

## Workspace Layout

```
sketch/
├── package.json                       # npm workspaces root
├── architecture.md  trd.md  prd.md   # repository-level documents
└── packages/
    ├── core/                          # @sketch/core
    │   ├── src/                       # engine and replaceable contracts
    │   ├── test/                      # unit/integration/phase gates
    │   ├── registry/                  # curated, pinned skills
    │   └── package.json               # exports/types/bin; no runtime deps
    └── desktop/                       # @sketch/desktop
        ├── src/                       # React UI and SketchClient transports
        ├── src-tauri/                 # Rust host and scoped capabilities
        └── scripts/                   # sidecar/package/release tooling
```

`packages/core` has zero runtime dependencies. Node built-ins and raw `fetch` implement its default
paths. Native or third-party implementations stay behind contracts rather than becoming mandatory
core dependencies.

---

## Layers

### 1. Desktop Host and Surfaces

- **Host**: Tauri 2 with a Rust command boundary and scoped capabilities.
- **UI/editor**: React 19, TypeScript, and Monaco.
- **Transports**: bundled stdio JSON-line sidecar in production; HTTP/SSE Vite bridge in development.
- **State**: one frontend `SketchClient` contract and real event-backed panels. Empty panels show
  named empty states rather than sample data.
- **Secrets**: only the native host persists credentials, using the operating system credential
  store. Core exposes `SecretStore` but cannot write credentials to disk.

### 2. Orchestrator Core

The canonical loop writes a persisted plan before any edit, emits each action before executing it,
runs bounded provider/tool calls, and closes with exactly one terminal event.

```
User task
   │
   ▼
Persist twelve-document plan ── edit without plan → refuse
   │
   ▼
Select strategy (`single` by default; heavier strategies are gated)
   │
   ▼
Assemble labelled context → model action → scoped tool/file operation
   │
   ▼
Nine-stage verification policy
   ├── pass → next action or complete
   └── fail → bounded feedback/retry or named failure
```

The event log, not component-local state, determines run history. The compatibility-era legacy
orchestrator/verifier remains in the repository, but the canonical loop uses `src/loop` and
`src/verify`.

### 3. Event Store and Project State

`EventStore` has a memory implementation for tests and an append-only JSONL implementation. The
file-backed store writes one sanitized `SketchEvent` per line to
`.sketch/events/<YYYY-MM-DD>.jsonl`; it never rewrites prior lines and skips malformed lines while
reading. Timeline/replay, costs, eval capture, and benchmark reporting are projections of this one
stream.

The engine creates `.sketch/` on demand and adds an internal self-ignore marker rather than editing
the user's `.gitignore`:

```
.sketch/
├── plan/<runId>/                  # twelve canonical plan documents
├── events/<YYYY-MM-DD>.jsonl     # append-only run history
├── evals/evals.jsonl             # captured eval cases
├── cache/                         # content-addressed responses
├── index/graph.json              # persisted repository graph/index
├── memory/<YYYY-MM-DD>.jsonl     # versioned append-only memory ops
├── skills/<name>/                # installed skill bytes
├── training/<name>/best_skill.md # candidate, inactive until promotion
└── bench/<timestamp>.json        # validated benchmark artifacts
```

Entries are created only when used. The memory filename is intentionally documented as date-sharded
because that is what `JsonlMemoryStore` currently writes.

### 4. Verification

The fixed contract is:

```
format → lint → typecheck → build → unit → integration → security → performance → dependency-audit
```

`verify.yaml` at the project root takes precedence over auto-detection (`verify.yml` and
`verify.json` are also accepted). Missing stages are `skipped`; stages after a failure are
`not-run`; those states are not interchangeable. Commands run through one `shell: false` runner
with timeouts and captured output, and emit `verify_started`/`verify_result`. Live application and
browser feedback is part of integration, not a tenth stage.

A run can finish when no checks are configured because the policy cannot invent project commands.
The eval contract is stricter: `verify-pass` fails when nothing was verified, preventing an
unevidenced result from scoring as success.

### 5. Context Engine

```
Repository
 ├── ignore-aware walker and incremental content hashes
 ├── persisted dependency/repository graph
 ├── lexical retrieval
 ├── local/provider embedding channel behind VectorStore
 └── fusion, reranking, graph expansion, token-budget assembly
          │
          ▼
 labelled relevant evidence → agent loop
```

`MemoryVectorStore` is the current zero-dependency vector default. The repository graph persists at
`.sketch/index/graph.json`; this is not a claim that vectors are persisted by sqlite-vec. A future
durable vector backend can implement `VectorStore` without changing callers.

### 6. Agent Strategies

`single` is the default. `plan-then-code` and the role-constrained `swarm` path exist behind the
strategy dispatcher. Escalation is budgeted, consensus runs only inside `swarm`, and conflicting
multi-proposer edits create a follow-up task instead of being guessed. `swarm` remains off by
default because no measured strategy pass@k lift has justified enabling it.

### 7. Capability-scoped Tool Layer

All side-effecting model actions pass through the scoped tool layer and emit `tool_called` or
`tool_denied`. Filesystem, terminal, Git, browser, and host operations are first-party tool paths;
curated MCP processes are another transport rather than the definition of every tool.

MCP uses a hand-rolled JSON-RPC 2.0 client over stdio—no MCP SDK dependency. Catalog entries are
validated/pinned launch descriptions, processes are isolated per run, grants are capability-scoped,
and a hanging process times out without hanging the run. Catalog coverage is not evidence that each
third-party server has been audited or executed.

### 8. Versioned Project Memory

`MemoryStore` holds versioned decisions, architecture, summarized conversations, standards,
preferences, style, bugs, performance history, and test history. Superseding appends a close record
and optional replacement; old bytes remain available for historical queries. `JsonlMemoryStore`
persists under `.sketch/memory/`, and `InMemoryStore` is the test double behind the same interface.

Retrieval combines relevance with recency and emits `memory_retrieved`; hygiene records
supersession, expiry, and contradictions. The storage and panel are real, but memory does not yet
automatically ingest every live run, so the architecture does not claim that it does.

### 9. Provider Adapter Layer

The loop depends on a minimal `ChatAdapter.chat()` contract. Richer legacy provider adapters can
also expose streaming, model listing, and estimation without widening the loop's dependency.
Hosted, local, and custom OpenAI-compatible endpoints resolve through the provider registry.
Nothing in this repository has yet been demonstrated against a real hosted provider.

Key-free provider settings are persisted separately from credentials. The Tauri/Rust host owns OS
credential persistence; keys cross only a purpose-bound invocation channel and never belong in
logs, event payloads, files, responses, commits, or console output.

---

## Data Flow: User asks "Add user authentication"

```
1. The user submits the task with a selected provider and project root.
2. Core writes the twelve plan artifacts; an edit before that write is refused.
3. The selected strategy assembles instructions, retrieved evidence when enabled, skills, and budget.
4. Each model action is emitted, validated, and executed through contained file/tool boundaries.
5. Proposed edits are reviewable; accepted bytes flow through the one authoritative file state.
6. Verification runs the fixed nine-stage policy in order.
7. A failure is fed back within retry/budget limits; a pass permits the next action.
8. One terminal event closes the run, and every surface reconstructs from durable events/artifacts.
```

Human review can be required by a surface or operation, but it does not replace the core plan,
containment, capability, digest, budget, or verification gates.

---

## Technology Choices

| Concern | Implemented choice | Boundary |
|---|---|---|
| Desktop | Tauri 2, React 19, Monaco | Native host owns OS-only capabilities |
| Core | TypeScript/Node sidecar | Zero runtime dependencies; NodeNext; bundleable CLI |
| Run persistence | `EventStore` + append-only JSONL | One event stream; write-path redaction |
| Memory | `MemoryStore` + append-only versioned JSONL | Separate from the run log; in-memory test double |
| Vectors | `VectorStore` + `MemoryVectorStore` | Durable backend remains replaceable, not mandated |
| Credentials | `SecretStore` + native OS credential implementation | No persisting core implementation or file fallback |
| MCP | Hand-rolled JSON-RPC 2.0 over stdio | Curated isolated processes; no SDK dependency |
| Verification | Nine-stage `verify` policy and one shell-less runner | Legacy four-check path is not canonical |

The seam approach does not ban SQLite, sqlite-vec, keytar-like host libraries, or an MCP library
forever. It means none is a required runtime dependency of `@sketch/core`, and any future backend
must preserve the existing contract and evidence gates.

---

## What Is Intentionally Absent

- No Sketch cloud backend, account, or synchronization service.
- No remote project database or model hosting.
- No telemetry or analytics.
- No arbitrary executable plugin loader.
- No claim that configured workflows, native packaging, third-party skills, MCP catalog entries, or
  provider adapters have external evidence until the corresponding retained run/artifact exists.
