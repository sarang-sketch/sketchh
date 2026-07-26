# Technical Requirements Document (TRD)

**Product**: Sketch  
**Version**: 1.0  
**Status**: Draft

---

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Desktop shell | Tauri 2 (Rust) | Smaller binary than Electron, native OS APIs, secure IPC |
| Frontend | React 18 + TypeScript | Ecosystem, Monaco compatibility |
| Editor | Monaco Editor | VS Code engine, excellent API, language server support |
| Core engine | TypeScript (Node.js sidecar) | Fast iteration, large AI/MCP SDK ecosystem |
| Storage | SQLite via better-sqlite3 | Local, zero-config, fast, reliable |
| Vector index | sqlite-vec | Embedded, no external service, good enough for repo-scale |
| Credential store | keytar | OS keychain on all platforms |
| MCP | @modelcontextprotocol/sdk | Official SDK, standard protocol |
| Build | Vite + Cargo | Fast dev builds |

---

## Repository Structure

```
sketch/
├── src-tauri/          # Rust: desktop shell, OS APIs, IPC bridge
├── src/                # React frontend
│   ├── components/     # UI components
│   ├── panels/         # Explorer, Chat, Terminal, Cost, Git
│   ├── store/          # State management
│   └── lib/            # Frontend utilities
├── engine/             # TypeScript Node.js sidecar
│   ├── orchestrator/   # Plan → Execute → Verify loop
│   ├── providers/      # Provider adapters
│   ├── context/        # Repo indexer, semantic search
│   ├── memory/         # SQLite project memory
│   ├── tools/          # MCP tool wrappers
│   └── verifier/       # Lint, typecheck, test, build runners
├── docs/               # Project documentation (this folder)
└── tests/              # Integration and e2e tests
```

---

## Provider Adapter Interface

Every provider implements this interface:

```typescript
interface ProviderAdapter {
  id: string
  name: string
  authenticate(config: ProviderConfig): Promise<void>
  complete(req: CompletionRequest): Promise<CompletionResponse>
  stream(req: CompletionRequest): AsyncIterable<CompletionChunk>
  listModels(): Promise<Model[]>
  estimateTokens(messages: Message[]): number
  estimateCost(tokens: TokenUsage): number
}

interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  model: string
  [key: string]: unknown
}
```

Credentials flow:
1. User enters API key in Settings
2. Stored via `keytar.setPassword('sketch', providerId, apiKey)`
3. Retrieved at runtime via `keytar.getPassword('sketch', providerId)`
4. Never written to disk in plaintext, never logged

---

## Orchestrator

### State machine per task

```
IDLE → PLANNING → EXECUTING → VERIFYING → DONE
                      ↑            ↓
                   FIXING ←── FAILED (if retries remain)
                                   ↓
                              NEEDS_HUMAN (if max retries hit)
```

### Planner output schema

```typescript
interface Plan {
  taskId: string
  summary: string
  steps: Step[]
  estimatedFiles: string[]
  estimatedTokens: number
}

interface Step {
  id: string
  description: string
  files: string[]
  dependsOn: string[]
}
```

### Verifier

Detects project type from config files, then runs appropriate tools:

| Check | Detection | Command |
|---|---|---|
| Lint | `.eslintrc*`, `ruff.toml`, `.flake8` | `eslint .` / `ruff check .` |
| Type-check | `tsconfig.json`, `mypy.ini` | `tsc --noEmit` / `mypy .` |
| Test | `jest.config*`, `pytest.ini`, `vitest.config*` | `jest` / `pytest` / `vitest` |
| Build | `package.json#scripts.build`, `Cargo.toml` | `npm run build` / `cargo build` |

Verifier returns structured results:

```typescript
interface VerifyResult {
  passed: boolean
  checks: CheckResult[]
}

interface CheckResult {
  name: string
  passed: boolean
  output: string
  fixable: boolean
}
```

---

## Context Engine

### Indexing pipeline

```
1. Walk file tree (respects .gitignore)
2. Parse imports/requires per file → dependency graph
3. Chunk files into segments (~512 tokens each)
4. Embed each chunk via provider's embedding endpoint
   (or local model if offline)
5. Store in sqlite-vec table
```

### Query pipeline

```
1. Embed the current task description
2. Vector search → top-K relevant chunks
3. Expand via dependency graph (pull in imported files)
4. Deduplicate and rank by relevance
5. Trim to fit model context window
6. Return file list + content
```

### Re-indexing
- Watch file system for changes (Tauri fs watch)
- Re-index changed files only (incremental)
- Full re-index on project open if index is stale

---

## Project Memory Schema

```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  rationale TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  messages TEXT NOT NULL,  -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE standards (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE bugs (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  fix TEXT NOT NULL,
  files TEXT NOT NULL,  -- JSON array
  created_at INTEGER NOT NULL
);

CREATE TABLE test_history (
  id TEXT PRIMARY KEY,
  check_name TEXT NOT NULL,
  passed INTEGER NOT NULL,
  output TEXT,
  created_at INTEGER NOT NULL
);
```

---

## IPC: Frontend ↔ Engine

Tauri commands (Rust → Node sidecar via stdio JSON-RPC):

```typescript
// Frontend calls
invoke('start_task', { task: string, projectPath: string })
invoke('cancel_task', { taskId: string })
invoke('get_plan', { taskId: string })
invoke('approve_plan', { taskId: string })
invoke('get_cost', { sessionId: string })

// Engine events (streamed to frontend)
emit('task:status', { taskId, status, message })
emit('task:file_changed', { taskId, path, diff })
emit('task:verify_result', { taskId, result: VerifyResult })
emit('task:done', { taskId, summary })
```

---

## Security Requirements

- No network calls except to user-configured provider endpoints
- No telemetry, analytics, or crash reporting (opt-in only, v2)
- API keys never appear in logs, IPC messages, or error output
- File writes restricted to the open project directory
- Terminal commands run in a sandboxed shell with user confirmation for destructive operations
- MCP tools operate under least-privilege: read-only by default, write requires explicit user grant

---

## Performance Targets

| Operation | Target |
|---|---|
| App cold start | < 3s |
| Project index (10k files) | < 10s |
| Context retrieval for a task | < 500ms |
| First token from provider | < 2s (network dependent) |
| Verify loop (lint + typecheck) | < 30s for typical project |
| Memory usage at idle | < 500 MB |

---

## Error Handling

- Provider errors: retry with exponential backoff (max 3), then surface to user with actionable message
- Verify loop failures: AI diagnoses and retries (max 3), then surfaces diff + error to user
- Index failures: degrade gracefully (send full file list instead of semantic results)
- Credential errors: prompt user to re-enter key, never expose the key in the error message
