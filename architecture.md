# Architecture

## Overview

Sketch is a local-first desktop application. All computation runs on the user's machine. No Sketch servers exist.

```
┌─────────────────────────────────────────────────────┐
│                  Sketch Desktop App                  │
│                  (Tauri + React)                     │
├─────────────────────────────────────────────────────┤
│                  Orchestrator Core                   │
│         Plan → Execute → Verify → Retry             │
├──────────────┬──────────────┬────────────────────────┤
│   Context    │    Agent     │      Tool Layer        │
│   Engine     │    Runner    │      (MCP)             │
├──────────────┴──────────────┴────────────────────────┤
│               Project Memory (SQLite)                │
├─────────────────────────────────────────────────────┤
│              Provider Adapter Layer                  │
│  OpenAI │ Anthropic │ Gemini │ Groq │ Ollama │ ...  │
└─────────────────────────────────────────────────────┘
```

---

## Layers

### 1. Desktop Shell
- **Framework**: Tauri (Rust backend + React frontend)
- **Editor**: Monaco Editor
- **UI**: React + TypeScript
- **Panels**: Explorer, Chat, Terminal, Cost Dashboard, Task Log, Git

### 2. Orchestrator Core
The heart of Sketch. Runs the verify loop autonomously.

```
User Task
    │
    ▼
Planner (breaks task into steps)
    │
    ▼
Agent Runner (executes each step)
    │
    ▼
Verifier
  ├── Lint
  ├── Type-check
  ├── Tests
  └── Build
    │
    ├── PASS → Mark complete
    └── FAIL → Diagnose → Fix → Re-verify (max N retries)
```

### 3. Context Engine
Sends only relevant code to the model — not the whole repo.

```
Repo
 │
 ├── File tree indexer
 ├── Dependency graph builder
 ├── Embedding index (local vector store)
 └── Semantic search
         │
         ▼
    Relevant files only → Model
```

- Embeddings stored locally (no external vector DB required in v1)
- Re-indexes on file change
- Dependency graph used to pull in related files automatically

### 4. Agent Runner
Executes a single step. Calls the model, applies the result, hands off to Verifier.

- Stateless per step
- Receives: task step + relevant context + tool list
- Returns: file changes + tool calls made
- Sub-agents used only for genuinely parallel work (e.g. writing two independent modules simultaneously)

### 5. Tool Layer (MCP)
All external actions go through MCP tools.

Core tools (v1):
- `filesystem` — read/write/delete files
- `terminal` — run shell commands
- `git` — commit, diff, branch
- `browser` — Playwright-based web access

Extended tools (v2+):
- GitHub, Docker, Supabase, Databases, SSH, Figma, Slack

### 6. Project Memory
Per-project SQLite database stored locally.

Tables:
- `decisions` — architecture choices and why
- `conversations` — past chat history
- `standards` — coding style, lint rules, naming conventions
- `bugs` — past bugs and how they were fixed
- `test_history` — which tests passed/failed and when

Loaded into context at session start. Pruned by relevance, not age.

### 7. Provider Adapter Layer
Uniform interface over all AI providers.

```typescript
interface ProviderAdapter {
  complete(messages: Message[], options: CompletionOptions): Promise<Response>
  stream(messages: Message[], options: CompletionOptions): AsyncIterable<Chunk>
  models(): Promise<Model[]>
  tokenCount(messages: Message[]): number
}
```

Adapters:
| Provider | Auth | Notes |
|---|---|---|
| OpenAI | API key | Standard |
| Anthropic | API key | Standard |
| Google Gemini | API key | Standard |
| Groq | API key | Fast inference |
| Grok (xAI) | API key | Standard |
| Kimi / Moonshot | API key | Standard |
| OpenRouter | API key | Multi-model via one key |
| Ollama | Base URL | Local, no key |
| LM Studio | Base URL | Local, no key |
| Azure OpenAI | API key + endpoint | Standard |
| Custom | API key + base URL | OpenAI-compatible |

Credentials stored in OS credential store only. Never written to disk in plaintext.

---

## Data Flow: User asks "Add user authentication"

```
1. User types task in chat
2. Planner reads task + project memory + file tree
3. Planner produces: steps, files to change, estimated scope
4. User reviews plan (optional confirmation step)
5. For each step:
   a. Context Engine finds relevant files
   b. Agent Runner calls model with context + step
   c. Model returns file diffs
   d. Diffs applied to disk
   e. Verifier runs: lint → typecheck → tests → build
   f. If fail: diagnose → fix → re-verify
   g. If pass: next step
6. All steps done → summary shown to user
7. Decisions written to project memory
```

---

## Technology Choices

| Concern | Choice | Reason |
|---|---|---|
| Desktop framework | Tauri | Smaller binary than Electron, Rust backend |
| UI | React + TypeScript | Ecosystem, Monaco compatibility |
| Editor | Monaco | Same engine as VS Code, excellent API |
| Core engine | TypeScript (Node via Tauri sidecar) | Fastest iteration, large AI SDK ecosystem |
| Storage | SQLite | Local, zero-config, reliable |
| Vector index | sqlite-vec or hnswlib-node | Local, no external service |
| Credential store | OS keychain (keytar) | Secure, cross-platform |
| MCP | Official MCP SDK | Standard, extensible |

---

## What Is Intentionally Absent

- No Sketch cloud backend
- No remote database
- No telemetry or analytics
- No authentication service
- No model hosting
