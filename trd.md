# Technical Requirements Document (TRD)

**Product**: Sketch  
**Version**: 1.0  
**Status**: Implemented baseline; external Phase 12 evidence gates remain open

---

## Tech Stack and Dependency Boundary

| Layer | Technology | Rationale |
|---|---|---|
| Desktop shell | Tauri 2 (Rust) | Native OS APIs, scoped IPC, and smaller packages than Electron |
| Frontend | React 19 + TypeScript | Component ecosystem and Monaco compatibility |
| Editor | Monaco Editor | Mature code-editing API and language support |
| Core engine | TypeScript, Node.js sidecar | Portable orchestration package with a JSON-line CLI |
| Project persistence | `EventStore` / `MemoryStore` seams with append-only JSONL and file defaults | Auditable, local, dependency-free storage |
| Vector index | `VectorStore`; zero-dependency `MemoryVectorStore` default | Replaceable search storage without a native runtime module |
| Credential store | Core `SecretStore`, implemented by the native host with the OS credential store | Core cannot persist credentials; no file fallback |
| MCP | Hand-rolled JSON-RPC 2.0 over stdio | Standard protocol without an MCP SDK runtime dependency |
| Build | npm workspaces, TypeScript, Vite, Cargo | One root build/test surface with native desktop packaging |

`packages/core` has **zero runtime dependencies**. It uses Node built-ins and raw `fetch`; its
`package.json` may contain development dependencies for compilation and tests but has no runtime
`dependencies`. Persistence, vectors, credentials, providers, and MCP are replaceable contracts.
A future backend may implement one of those seams, but `better-sqlite3`, `sqlite-vec`, `keytar`,
`hnswlib-node`, and `@modelcontextprotocol/sdk` are neither shipped nor mandated by core.

---

## Repository Structure

```
sketch/
├── package.json                    # npm workspace root
├── *.md                            # product, architecture, policy, and execution docs
└── packages/
    ├── core/                       # @sketch/core; dependency-free runtime
    │   ├── src/                    # engine, events, verify, context, memory, tools, RPC
    │   ├── test/                   # core unit, integration, and phase-gate tests
    │   ├── registry/               # pinned curated skill registry
    │   └── package.json            # exports, types, and sketch CLI bin
    └── desktop/                    # @sketch/desktop
        ├── src/                    # React UI and both SketchClient transports
        ├── src-tauri/              # Rust host, capabilities, native commands
        ├── scripts/                # sidecar, packaging, release, and preflight tooling
        └── package.json
```

The old flat `engine/`, `desktop/`, root `src/`, and root `src-tauri/` paths are historical. Tests
live with their owning workspace; repository-level workflows and documentation stay at the root.

### Project-local `.sketch/` state

The engine creates state on demand under the opened project and writes a self-ignore marker at
`.sketch/.gitignore`. It does not rewrite the project's own `.gitignore`.

```
.sketch/
├── plan/<runId>/                  # twelve canonical plan documents
├── events/<YYYY-MM-DD>.jsonl     # append-only SketchEvent stream
├── evals/evals.jsonl             # captured eval cases
├── cache/                         # content-addressed response data
├── index/graph.json              # persisted repository graph/index metadata
├── memory/<YYYY-MM-DD>.jsonl     # versioned append-only memory operations
├── skills/<name>/                # installed skills; grants are stored separately
├── training/<name>/best_skill.md # inactive trained candidate
└── bench/<timestamp>.json        # validated benchmark reports
```

This is an implementation layout, not a claim that every directory always exists. In particular,
memory is currently date-sharded under `.sketch/memory/`; it is not a SQLite database or a single
rewritten row store.

---

## Provider and Credential Contracts

The canonical agent loop depends on the minimal `ChatAdapter.chat()` contract. Existing richer
provider adapters may additionally expose completion, streaming, model-list, token, and cost
operations; callers do not need those methods to run the loop.

Key-free provider configuration is persisted separately from credentials. Credential flow is:

1. The user supplies a key through Provider Settings.
2. The Tauri/Rust host validates the identifier and persists the value in the operating system's
   credential store.
3. Core exposes only the injected `SecretStore` contract (`get`, `set`, `del`) and has no
   filesystem-backed implementation.
4. A resolved key may cross only the purpose-bound credential/invocation channel needed for a
   provider call. It is excluded from files, logs, errors, events, responses, commits, and console
   output.

The process-memory `MemorySecretStore` is a test/ephemeral implementation, not persistence. There
is deliberately no `keytar` dependency and no plaintext fallback.

---

## Orchestration and Event Sourcing

A run plans before editing, executes actions, verifies outcomes, and either completes or emits a
named failure. The hard plan gate is enforced by core against the persisted plan directory; human
approval is a separate optional interaction and is not the source of edit authority.

`EventStore` is the run-history seam. `JsonlEventStore` appends one sanitized event object per line
to `.sketch/events/<YYYY-MM-DD>.jsonl`; `MemoryEventStore` is the test implementation. Existing
lines are never rewritten or truncated, malformed lines are skipped during reads, and `forRun`
preserves emission order. Exactly one terminal `run_completed` or `run_failed` event closes a run.

The event stream is the single source of truth for Timeline/replay, cost accounting, eval capture,
and benchmark projections. Project memory is a separate versioned append-only store; it does not
replace or duplicate the run log.

---

## Verification Contract

The only implementation is `packages/core/src/verify/`. The compatibility-era four-check
`packages/core/src/verifier/` path was deleted on 2026-08-03; a source-level guard now forbids
`shell: true` anywhere under `packages/core/src/`. Verification runs this fixed order:

```
format → lint → typecheck → build → unit → integration → security → performance → dependency-audit
```

- `verify.yaml` at the project root takes precedence; `verify.yml` and `verify.json` are also read,
  and stack auto-detection is used when no policy file exists.
- Every command uses the one shell-less runner (`shell: false`) with bounded output, timeout, and
  captured exit code/stdout/stderr/duration.
- An unconfigured stage is `skipped` and does not fail. Stages after the first failure are
  `not-run`, which is distinct from skipped.
- Every configured non-skipped stage must pass. A project with no configured checks can finish a
  run, while an eval's `verify-pass` check still refuses vacuous verification.
- `verify_started` precedes each command and `verify_result` follows it.
- Live application/browser feedback is part of `integration`, not a tenth stage.

The Node, Python, Rust, and Go detector behavior remains the auto-detection baseline and is extended
into this nine-stage policy.

---

## Context Engine

### Indexing pipeline

```
1. Walk the file tree while respecting ignore rules and size limits.
2. Parse dependencies and persist the repository graph incrementally by content hash.
3. Chunk source and build local or provider-backed embeddings.
4. Put embedded chunks behind the VectorStore seam.
5. Use MemoryVectorStore as the current zero-dependency vector default.
```

The persisted `.sketch/index/graph.json` is graph/index metadata. This document does not claim that
vectors survive sessions through `sqlite-vec`; a durable vector implementation may be added later
behind `VectorStore` without changing callers.

### Query pipeline

```
1. Run lexical and vector retrieval.
2. Fuse channels, rerank, and expand one hop through the dependency graph.
3. Deduplicate under a token budget, preserving signatures before bodies.
4. Return labelled evidence plus selected paths and the token estimate.
```

Repository context is distinct from standing project instructions. Provider embeddings are cached
locally when used; the hashing embedder supplies the offline-first fallback.

---

## Project Memory Contract

`MemoryStore` represents versioned decisions, architecture, summarized conversations, standards,
preferences, style, bugs, performance history, and test history. Every entry has a validity window.
Superseding an entry appends a close operation and optional replacement rather than rewriting prior
bytes. `JsonlMemoryStore` persists date-sharded JSONL under `.sketch/memory/`; `InMemoryStore` is the
test double behind the same interface.

Memory retrieval includes reranking and recency, and hygiene can report contradictions or expire
entries. The store and panel are implemented. Memory does not yet populate itself from every live
agent run, so this contract must not be described as automatic run-time learning.

---

## IPC: Frontend ↔ Engine

The React application depends on one `SketchClient` interface. Production uses a bundled stdio
JSON-line sidecar in Tauri; development can use the Vite HTTP/SSE bridge. Both carry the same RPC
methods and `SketchEvent` stream. Protocol frames are written to stdout only and diagnostics to
stderr. The wire supports task runs, evals, capture, project/file/tool/settings operations, and
extension configuration through the registered method table; it does not invent a second engine.

---

## Tool and MCP Boundary

All side-effecting model actions pass through the capability-scoped tool layer and emit
`tool_called` or `tool_denied`. First-party/host tools and curated isolated MCP processes are tool
transports; it is inaccurate to call every external action an MCP call. MCP communication uses the
hand-rolled stdio JSON-RPC client, per-run grants, timeouts, and fail-closed availability. Catalog
entries are pinned launch descriptions, not proof that every third-party server has been audited or
executed.

---

## Security Requirements

- No Sketch server, account, telemetry, analytics, or crash-reporting backend.
- Network access is limited to user-configured provider/tool endpoints and explicitly granted
  capabilities; local-only paths remain available.
- Secrets are stored only by the native host in the OS credential store and are redacted at every
  error/event boundary.
- File operations are contained to the opened project or an explicitly scoped root.
- Terminal execution is shell-less, allowlisted, rooted in the project, and confirmation-gated
  where required. It is not described as a sandbox.
- Tool authority is capability-scoped, per run where applicable, and fails closed.

---

## Performance Targets

| Operation | Target |
|---|---|
| App cold start | < 3s |
| Project index (10k files) | < 10s |
| Context retrieval for a task | < 500ms |
| First token from provider | < 2s (network dependent) |
| Lint + typecheck fast path | < 30s for a typical project |
| Memory usage at idle | < 500 MB |

The `<30s` row is a fast-path target, not a promise that all nine verification stages finish in
that time.

---

## Error Handling

- Provider and connection failures are redacted and surfaced with actionable provider/endpoint
  context; retry policy remains adapter/run configuration rather than a hidden universal fallback.
- Verification failures preserve the failed stage and captured output; retries remain bounded.
- Index and memory diagnostics degrade explicitly rather than claiming unavailable evidence.
- Credential errors name only the credential identifier or provider, never the secret value.
