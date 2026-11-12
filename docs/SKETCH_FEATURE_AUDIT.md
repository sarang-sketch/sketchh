# Sketch feature audit

Date: 2026-11-01. Scope: the whole repository at `packages/core` (engine), `packages/desktop/src` (window) and `packages/desktop/src-tauri` (native shell).

## 1. How this audit was done

Every status below comes from reading the execution path in source, not from the presence of a button:
window component → window state (`AppState.tsx`) → client seam (`lib/client.ts`, `stdioClient.ts`, `httpClient.ts`) → engine RPC method (`core/rpc/methods.ts`) → engine module → disk, OS or provider.

Path prefixes used in the tables:

| Prefix | Means |
|---|---|
| `core/` | `packages/core/src/` |
| `desk/` | `packages/desktop/src/` |
| `rs/` | `packages/desktop/src-tauri/src/` |
| `test:` | a test file name without `.test.ts(x)`, under `packages/core/test/` or next to the desktop source |

Statuses:

| Status | Meaning |
|---|---|
| IMPLEMENTED | Works end to end through the path above and has tests. |
| PARTIAL | Works, but part of the feature is missing. The gap is named. |
| UI ONLY | A control exists with no working backend. |
| MOCKED | Shows static or simulated data as if real. |
| BROKEN | Exists and does not work. |
| MISSING | Not in the code. |
| N/A | Does not apply to this architecture. |

Limits of this audit:
- The full test suites were not re-run while auditing, because the host had about 1.3 GB of free memory. The last full runs recorded in the work log were engine 1,305/1,305 and desktop 804/804. Test results for work done in this task are in `docs/SKETCH_TEST_REPORT.md`.
- No mocked production data was found. `desk/lib/mockClient.ts` is reachable only with `VITE_BRIDGE=mock` (`desk/lib/factory.ts`), labels itself `mock/echo-1`, and 19 of its methods refuse with `noEngine` instead of inventing results.
- "Tests" names the test files that exercise the feature. It does not claim that every branch is covered.

## Summary

233 features audited across the 15 modules of the first brief and the local-first modules of the second. The matrix in section 3 records the state **before** this task's changes; section 8 lists the rows this task changed.

| Status | Before | After this task |
|---|---|---|
| IMPLEMENTED | 94 | 102 |
| PARTIAL | 52 | 55 |
| MISSING | 83 | 72 |
| UI ONLY | 0 | 0 |
| MOCKED | 0 | 0 |
| BROKEN | 0 | 0 |
| N/A | 4 | 4 |

No control was found that pretends to work. The largest gaps are local model management, an offline guarantee, MCP from the window, protected files, hooks, chat management (rename, export, feedback) and the new tools of the second brief (Project Rescue, UI Doctor, API Lab, daily briefing). Sketch does **not** have feature parity with Claude Code or Codex; section 3 says exactly where.

## 2. What Sketch is, as built

| Layer | Technology | Where |
|---|---|---|
| Native shell | Tauri 2 (Rust): window, OS keychain, contained file commands, engine sidecar launch | `rs/` |
| Window | React 19, Monaco 0.52.2, xterm 6, CSS modules, light and dark themes | `desk/` |
| Engine | Node 22, TypeScript, **no runtime npm dependencies** | `core/` |
| Transport | JSON-RPC over stdio (desktop app) or HTTP (Vite dev bridge) | `core/rpc/server.ts`, `desk/lib/stdioClient.ts`, `desk/lib/httpClient.ts` |
| Storage | Append-only JSONL event log and memory store per project under `.sketch/`; window state in `localStorage` key `sketch.ui.v1`; API keys in the OS credential store | `core/events/store.ts`, `core/memory/store.ts`, `desk/state/AppState.tsx`, `rs/secret_store.rs`, `rs/os_credentials.rs` |
| Agent | Model-agnostic JSON action protocol (`plan`, `edit`, `tool`, `verify`, `think`, `ask`, `done`), so any chat model can drive it without native tool calling | `core/loop/actions.ts`, `core/loop/agent.ts` |

There is no server, no account system and no database. "Database" in the matrix is therefore **Storage**: which file or store holds the feature's data.

Authentication is N/A for the app itself (it is a local program). Provider authentication is API keys, "Sign in with ChatGPT" (OAuth with PKCE, `core/settings/chatgptAuth.ts`) and a loopback OAuth listener (`core/settings/oauthLoopback.ts`).

Before this task the engine answered 68 RPC methods, listed in `core/rpc/methods.ts` (`METHODS`, line 3498).

## 3. Feature matrix

### 3.1 Chat

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Multiple conversations | IMPLEMENTED | Yes | n/a | localStorage | chat-ui | - | `desk/panels/agent/ConversationSidebar.tsx`; `NEW/SET/DELETE_CONVERSATION` in `desk/state/AppState.tsx` |
| History survives restart | IMPLEMENTED | Yes | n/a | localStorage | ideState, chat-ui | - | `loadPersistedState`/`savePersistedState`; at most 60 conversations x 200 messages; credential-shaped text scrubbed before saving (`scrubSecrets`) |
| Search conversations | IMPLEMENTED | Yes | n/a | localStorage | chat-ui | - | Sidebar filter matches titles and message text |
| Rename conversation | MISSING | No | n/a | - | - | P1 | Title is always the first prompt (`titleFor`) |
| Delete conversation | IMPLEMENTED | Yes | n/a | localStorage | chat-ui | - | `DELETE_CONVERSATION` |
| Archive conversation | MISSING | No | - | - | - | P2 | |
| Pin conversation | MISSING | No | - | - | - | P1 | |
| Continue / resume | IMPLEMENTED | Yes | Yes | localStorage | connect, phase9-gate | - | `historyFrom` sends earlier turns as `params.history`; the engine keeps the newest turns |
| Branching | MISSING | No | - | - | - | P2 | |
| Edit a sent message / regenerate | MISSING | No | - | - | - | P1 | "Regenerate" exists only for inline edits and architecture views |
| Streaming | PARTIAL | Yes | Yes | event log | AgentTimeline, AgentConsole | P2 | Run steps stream as events (`core/rpc/streaming-store.ts`); each model turn's text arrives whole, not token by token |
| Stop generation | IMPLEMENTED | Yes | Yes | - | cancel | - | `cancel` RPC aborts the run's signal |
| Retry failures | PARTIAL | No | Yes | - | provider-http | P1 | HTTP 429/5xx retried with backoff and `Retry-After` (`core/providers/http.ts`); no Retry button on a failed chat turn |
| Markdown rendering | IMPLEMENTED | Yes | n/a | - | chat-ui | - | `desk/components/Markdown.tsx`, own renderer, no raw HTML |
| Code highlighting in chat | MISSING | No | - | - | - | P2 | Code blocks render as plain monospace |
| Copy | PARTIAL | Yes | n/a | - | chat-ui | P2 | Copy button on code blocks only (`Markdown.tsx`) |
| Download a reply | MISSING | No | - | - | - | P2 | |
| Image / document attachments | MISSING | No | No | - | - | P2 | Engine `Message` content is text only |
| Drag-and-drop into chat | MISSING | No | - | - | - | P2 | Drag-and-drop exists in the Explorer and editor only |
| `@` file references | IMPLEMENTED | Yes | Yes | - | composer | - | `project-files` RPC feeds `@` mentions in `Composer.tsx` |
| Custom slash commands | IMPLEMENTED | Yes | Yes | `.sketch/commands/*.md`, `~/.sketch/commands/*.md` | agent-modes | - | `commands-list` RPC, `desk/lib/slashCommands.ts` |
| Message feedback (thumbs) | MISSING | No | No | - | - | P1 | |
| Conversation import / export | MISSING | No | No | - | - | P1 | |
| Context preservation | PARTIAL | Yes | Yes | - | phase9-gate | P1 | Older turns are dropped, not summarised |
| Project-specific conversations | PARTIAL | Yes | n/a | localStorage | - | P2 | Each conversation stores its folder and reopening it switches to that folder; the list is not filtered by project |

### 3.2 Models and providers

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| OpenAI | IMPLEMENTED | Yes | Yes | keychain | providers, providerSettings | - | `core/providers/registry.ts` (`openai`) |
| Anthropic | IMPLEMENTED | Yes | Yes | keychain | providers.chat | - | `anthropic-messages` adapter, `core/providers/anthropicMessages.ts` |
| Gemini | IMPLEMENTED | Yes | Yes | keychain | providers | - | Google's OpenAI-compatible endpoint |
| Groq, OpenRouter | IMPLEMENTED | Yes | Yes | keychain | providers | - | Plus xAI, Kimi, DeepSeek, Mistral, Cerebras, NVIDIA NIM, GitHub Models, Azure OpenAI, Cloudflare Workers AI |
| ChatGPT sign-in | IMPLEMENTED | Yes | Yes | engine token file | chatgpt, chatgpt-signin | - | `core/providers/chatgpt.ts`, `core/settings/chatgptAuth.ts` |
| Hugging Face | MISSING | No | No | - | - | P1 | No catalog entry; reachable only through Custom |
| Ollama (chat) | IMPLEMENTED | Yes | Yes | - | onboarding, preflight-ollama | - | `http://localhost:11434/v1`; the Connect window detects a running server |
| LM Studio, llama.cpp | IMPLEMENTED | Yes | Yes | - | onboarding | - | Local OpenAI-compatible servers |
| Custom OpenAI-compatible | IMPLEMENTED | Yes | Yes | keychain | providerSettings | - | `custom` entry |
| API key management | IMPLEMENTED | Yes | Yes | keychain | ProviderSettings, keyStore | - | `desk/panels/ProviderSettings.tsx`, `provider-config-save` |
| Secure credential storage | IMPLEMENTED | Yes | Yes | OS credential store | keyStore, Rust secret_store tests | - | Windows Credential Manager, macOS Keychain, Secret Service; keys never in localStorage |
| Connection test | IMPLEMENTED | Yes | Yes | - | providerSettings, ProviderSettings | - | `provider-test`, `core/settings/connectionTest.ts` |
| Model discovery | IMPLEMENTED | Yes | Yes | - | connect, onboarding | - | `provider-models` lists the server's `/models` |
| Model selection / default model | IMPLEMENTED | Yes | Yes | provider config | onboarding | - | `desk/components/ModelSelector.tsx` |
| Switching model mid-conversation | IMPLEMENTED | Yes | Yes | - | chat-ui | - | Next turn uses the new model with the same history |
| Per-chat model memory | MISSING | No | - | - | - | P2 | Selection is window-wide |
| Per-project model | MISSING | No | - | - | - | P2 | |
| Provider fallback | MISSING | No | No | - | - | P2 | |
| Retry handling | IMPLEMENTED | n/a | Yes | - | provider-http | - | Backoff, `Retry-After`, stalled retry bodies released |
| Tool use | IMPLEMENTED | n/a | Yes | - | loop, agent-modes | - | Own JSON action protocol; does not depend on native tool calling |
| Capability detection (tools, vision, embedding) | MISSING | No | No | - | - | P0 | Every model is treated alike |
| Context-window information | MISSING | No | No | - | - | P0 | Ollama's 4,096-token default is explained in the Connect window, nothing is measured |
| Model-specific settings | PARTIAL | Yes | Yes | provider config | providerSettings | P2 | Base URL, key, model id; no temperature or context size |
| Parallel model comparison | MISSING | No | Partial | - | bench | P2 | `core/bench/compare.ts` compares benchmark artifacts, not chats |
| Local model execution | IMPLEMENTED | Yes | Yes | - | onboarding | - | Through Ollama, LM Studio or llama.cpp; Sketch does not run models itself |
| Local model download / removal / load | MISSING | No | No | - | - | P0 | `EXTENSIBILITY.md`: "Sketch does not download, host, or manage model lifecycle" |
| Hardware-based model recommendation | MISSING | No | No | - | - | P0 | |

### 3.3 Tokens and usage

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Input / output / total tokens | IMPLEMENTED | Yes | Yes | event log | cost, CostDashboard | - | Provider-reported `usage` parsed in each adapter; summed by `ledgerFor` (`core/cost/ledger.ts`) |
| Tokens per message | IMPLEMENTED | Yes | Yes | conversation | chat-ui | - | Run receipt under each agent reply (`desk/lib/runSummary.ts`) |
| Per conversation | MISSING | No | - | - | - | P2 | |
| Per provider / per model | PARTIAL | Partial | Yes | event log | cost | P1 | Ledger entries carry model, provider and `local`; no grouped view in `CostDashboard.tsx` |
| Cost estimate | IMPLEMENTED | Yes | Yes | - | cost, budget | - | Price table `core/cost/pricing.ts`; unpriced calls counted separately, never guessed |
| Provider-reported cost | MISSING | No | No | - | - | P2 | |
| Cached tokens / reasoning tokens | MISSING | No | No | - | - | P2 | Response-cache hits are counted (`cacheHits`, `savedUsd`); provider cache and reasoning counts are not read |
| Context consumption / remaining | MISSING | No | No | - | - | P1 | |
| Daily / monthly analytics | MISSING | No | No | - | - | P1 | |
| Rate-limit information | PARTIAL | Yes | Yes | - | chatgpt, provider-http | P2 | 429 handling; ChatGPT usage-limit message with reset time |
| Budgets and warnings | IMPLEMENTED | Yes | Yes | - | budget | - | Per-run `maxUsd` / `maxTokens` / `maxCalls`, checked before each request |
| Estimated vs reported | PARTIAL | No | Yes | - | budget | P1 | The only estimate is the pre-request budget check (`estimateRequestTokens`); the screen does not label which numbers are estimates |
| Compaction / summarisation | PARTIAL | n/a | Yes | - | assembly | P1 | Retrieved context is packed under a token budget (`core/context/assembly.ts`); chat history is truncated, not summarised |

### 3.4 MCP

The engine has a working MCP client. The window cannot use it: no window code passes `params.mcpServers` to a run (searched all of `desk/`), so the MCP panel lists servers that a desktop user has no way to start.

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Local servers over stdio | PARTIAL | No | Yes | - | mcp, phase7-gate, phase12-extensibility-gate | P0 | `core/mcp/client.ts`, `protocol.ts`, `host.ts`; started per run from `params.mcpServers`, which the window never sends |
| Remote servers / Streamable HTTP | MISSING | No | No | - | - | P1 | |
| Curated catalog | IMPLEMENTED | Yes | Yes | - | mcp, McpTools | - | 15 pinned entries (`core/mcp/catalog.ts`): filesystem, terminal, git, github, docker, playwright, browser, ssh, postgres, supabase, cloudflare, notion, slack, figma, android |
| Manual server configuration | MISSING | No | No | - | - | P0 | Only host-code registration (`McpCatalogRegistry`); `EXTENSIBILITY.md` states there is no wire command resolver |
| Config import / export, JSON editor | MISSING | No | No | - | - | P1 | |
| Environment variables / tokens | PARTIAL | Yes | Yes | process env | mcp | P1 | Catalog rows report missing credentials (`configured`); tokens come from the environment, not the keychain |
| OAuth | MISSING | No | No | - | - | P2 | |
| Connect / disconnect / restart / enable | MISSING | No | Partial | - | - | P0 | Lifetime is one run by design |
| Status and health | PARTIAL | Yes | Yes | - | McpTools | P1 | Shows `configured`, never a live connection |
| Tool discovery and invocation | IMPLEMENTED | No | Yes | event log | mcp | - | `tools/list` at handshake; calls go through `ToolDispatcher` (`core/capabilities/guard.ts`) |
| Resources, prompts, sampling | MISSING | No | No | - | - | P2 | |
| Per-server permissions | IMPLEMENTED | Yes | Yes | - | mcp, capabilities | - | A server is not even launched unless the run's grant covers its capability |
| Per-tool permissions / approval | PARTIAL | No | Yes | - | capabilities | P1 | Capability-level only; no per-tool allow or ask |
| Project / global configuration | MISSING | No | No | - | - | P0 | |
| Marketplace | PARTIAL | Yes | Yes | - | McpTools | P2 | The curated catalog is read-only |

### 3.5 Skills

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| `SKILL.md` compatibility | IMPLEMENTED | Yes | Yes | `.sketch/skills/<name>/SKILL.md` | skills, frontmatter | - | `core/skills/loader.ts`, `frontmatter.ts`; also community `skill.json` folders |
| Create a skill | MISSING | No | No | - | - | P1 | No form; a user can only hand-write the file |
| Edit a skill | PARTIAL | Partial | Yes | - | SkillsMarketplace, skill-train-edits | P1 | Training proposes and scores edits; no editor form |
| Delete a skill | MISSING | No | No | - | - | P1 | |
| Import / export | PARTIAL | Yes | Yes | - | registry, registry.embedded | P1 | Install from the registry with digest checks; no export or import of a folder |
| Project skills | IMPLEMENTED | Yes | Yes | `.sketch/skills/` | skills | - | |
| Global skills | MISSING | No | No | - | - | P1 | Only `<project>/.sketch/skills` is loaded |
| Discovery / search | PARTIAL | Yes | Yes | - | SkillsMarketplace | P2 | Catalog list; no text search |
| Manual invocation | IMPLEMENTED | Yes | Yes | - | composer | - | `/skill-name` in the composer sends `skillNames` |
| Automatic activation | IMPLEMENTED | n/a | Yes | - | skills | - | `use_skill` tool lists installed skills to the model (`core/tools/skills.ts`) |
| Supporting files, scripts, templates | PARTIAL | No | Yes | skill folder | skills | P2 | `skill.json` layout is enumerated; files are read by path at run time |
| Permissions | IMPLEMENTED | Yes | Yes | grants file | registry, capabilities | - | Declared capabilities; digest-bound grants (`core/registry/grants.ts`) |
| Versioning / updates | PARTIAL | Yes | Yes | registry | registry | P2 | Exact versions and digests; no update check |
| Dependencies | MISSING | No | No | - | - | P2 | |
| Validation | IMPLEMENTED | Yes | Yes | - | frontmatter, registry | - | `parse-skill`; install verifies before it writes |
| Community skill install | IMPLEMENTED | Yes | Yes | - | phase12-third-party-flywheel-gate | - | |
| Skill training (SkillOpt method) | IMPLEMENTED | Yes | Yes | - | skill-edits, edit-optimizer, skill-train-edits, SkillsMarketplace | - | `skill-train` with `mode: 'edits'` or `'rewrite'`; kept only when held-out evals improve |
| Default role skills (frontend, backend, reviewer...) | MISSING | No | No | - | - | P1 | The built-in registry seeds 7 skills (`core/registry/seeds.ts`: context-packing, commit-context, scope-discipline, web-data, frontend-design, research-stage, finance-quant); none is one of the 12 roles the brief lists |

### 3.6 Agents and subagents

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Main coding agent | IMPLEMENTED | Yes | Yes | event log | loop, agent-modes | - | `runTask` in `core/loop/agent.ts` |
| Build Team (Frontend, Backend, Database chats) | IMPLEMENTED | Yes | Yes | window state | handoff, TeamPanel | - | `desk/team/`; a role ends its reply with `@backend: ...` to hand off; 6 hand-offs per message |
| Strategy roles | PARTIAL | Yes | Yes | event log | strategy, phase10-gate | P2 | 13 roles exist only inside a `plan-then-code` or `swarm` dispatch; `swarm` stays off until measured (`core/strategy/`) |
| User-defined agents | MISSING | No | Partial | - | phase12-extensibility-gate | P1 | Only host-code registration (`RegisteredAgentRegistry`) |
| Per-agent model, tools, skills, permissions | MISSING | No | Partial | - | - | P1 | Team roles share the selected model |
| Parallel agents | PARTIAL | No | Yes | - | strategy | P2 | `swarm` only, off by default |
| Sequential delegation | IMPLEMENTED | Yes | Yes | - | handoff | - | Team hand-offs |
| Background agents | MISSING | No | No | - | - | P2 | Background processes exist; background agent runs do not |
| Status, logs, cancel | IMPLEMENTED | Yes | Yes | event log | TaskLog, AgentTimeline, cancel | - | |
| Retry an agent run | MISSING | No | - | - | - | P1 | |
| Result aggregation | MISSING | No | No | - | - | P2 | |
| Worktree isolation | MISSING | No | No | - | - | P2 | |

### 3.7 Agentic coding engine

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Repository analysis and indexing | IMPLEMENTED | Yes | Yes | `.sketch/` graph | walker, repo-graph, architecture | - | `core/context/walker.ts` (honours `.gitignore`), `repo-graph.ts`, `architecture.ts` |
| Semantic search | PARTIAL | Yes | Yes | in memory | hybrid-search, embeddings | P1 | Lexical plus hashing-trick vectors; `core/context/embedder.ts` says plainly these are not semantic; provider embeddings are an optional fallback; no local Ollama embeddings |
| Read / create / modify / multi-file edits | IMPLEMENTED | Yes | Yes | snapshot journal | loop, orchestrator | - | `read_file`, `edit` action (exact search/replace), `SnapshottingFileWriter` |
| Delete files | PARTIAL | Yes | Partial | OS trash | fsops | P2 | The Explorer deletes to the OS trash; the agent can delete only through `run_command`, which treats recursive deletes as destructive |
| Directory listing | IMPLEMENTED | Yes | Yes | - | project-tools | - | `list_dir`, `find_files`, `search_code` |
| Terminal commands | IMPLEMENTED | Yes | Yes | event log | agent-modes, terminal | - | `run_command` (`core/tools/command.ts`), asked before running in Agent mode |
| Long-running processes, dev servers | IMPLEMENTED | Yes | Yes | - | background | - | `background: true`, `process_output`, `stop_process` |
| Output streaming of agent commands | PARTIAL | Yes | Yes | - | background | P2 | Output returns when the command ends, or by polling a background process |
| Build, test, lint, typecheck, format | IMPLEMENTED | Yes | Yes | event log | verify-policy, verify-runner, TestResults | - | Nine ordered stages from `verify.yaml` or detected scripts (`core/verify/policy.ts`) |
| Security and performance checks | PARTIAL | Yes | Yes | - | verify-policy | P1 | Stages exist; they run only what the project configures |
| Debugger | MISSING | No | No | - | - | P2 | |
| Error and stack-trace analysis | PARTIAL | Yes | Yes | - | Terminal (links) | P2 | Model-driven from verify output; terminal file:line links |
| Refactor / generate / explain / review / tests | IMPLEMENTED | Yes | Yes | - | editorFeatures, DiffReview | - | Editor actions Ask, Edit, Explain, Fix, Write tests (`desk/editor/CodeEditor.tsx`); Review mode proposals (`desk/panels/DiffReview.tsx`) |
| Plan mode | IMPLEMENTED | Yes | Yes | event log | plan, loop | - | Edits are refused before a `plan` exists; `plan-then-code` strategy |
| Ask (read-only) / Agent / Auto modes | IMPLEMENTED | Yes | Yes | - | agent-modes, composer | - | `readOnly` enforced in the loop; Auto still asks for destructive commands |
| Checkpoints and undo | IMPLEMENTED | Yes | Yes | snapshot journal | connect, find-replace | - | `undo-run` restores the run's file snapshot without Git |

### 3.8 Hooks and automation

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, compaction events | MISSING | No | No | - | - | P1 | No hook runner anywhere in `core/` or `desk/` |
| Custom / shell hooks, conditions, timeouts, logs | MISSING | No | No | - | - | P1 | |
| Project / global hooks | MISSING | No | No | - | - | P1 | |
| Automatic formatting | IMPLEMENTED | Yes | Yes | - | editorFeatures | - | Format on save (Monaco formatters); `format` verify stage |
| Automatic testing after changes | IMPLEMENTED | Yes | Yes | event log | agent-modes | - | "Check changes" runs the project's checks after auto-applied edits (`AgentPrefs.verifyChanges`) |
| Desktop notifications | MISSING | No | No | - | - | P2 | |

### 3.9 Git and GitHub

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Repository detection, status | IMPLEMENTED | Yes | Yes | - | git, GitPanel, gitStatus | - | `git-status`, `core/tools/git.ts`, `desk/git/GitProvider.tsx` |
| Initialise a repository | MISSING | No | No | - | - | P1 | No `git init` method |
| Diff viewer | IMPLEMENTED | Yes | Yes | - | DiffView, GitPanel | - | Side-by-side and inline, working tree vs index vs HEAD (`desk/editor/DiffView.tsx`) |
| Stage, unstage, discard, commit | IMPLEMENTED | Yes | Yes | - | git, GitPanel, GitPanel.more | - | |
| Branch create and switch | IMPLEMENTED | Yes | Yes | - | git-more | - | `git-switch` with `create` |
| Merge, rebase, stash, revert a commit | MISSING | No | No | - | - | P1 | |
| Commit history | IMPLEMENTED | Yes | Yes | - | git-more, GitPanel.more | - | `git-log`, Recent Commits |
| File history / blame | MISSING | No | No | - | - | P2 | |
| Conflicts | PARTIAL | Yes | Yes | - | git | P1 | Conflicted files are listed; no resolution view |
| Push, pull, fetch | IMPLEMENTED | Yes | Yes | - | git-more | - | Uses the system git and its credential helper |
| Clone | IMPLEMENTED | Yes | Yes | - | git | - | `git-clone`, `desk/components/CloneDialog.tsx` |
| AI commit message | IMPLEMENTED | Yes | Yes | - | git-more, GitPanel.more | - | `git-commit-message`, one model call, commits nothing |
| GitHub sign-in, issues, pull requests, reviews, Actions | MISSING | No | No | - | - | P2 | Only reachable through the `github` MCP catalog entry inside a run |
| PR descriptions | MISSING | No | No | - | - | P2 | |
| Worktrees | MISSING | No | No | - | - | P2 | Worktree paths are only parsed in status output |

### 3.10 Import and export

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Open a local folder | IMPLEMENTED | Yes | Yes | localStorage (recent list) | FileExplorer | - | |
| Clone a Git repository | IMPLEMENTED | Yes | Yes | - | git | - | |
| ZIP import / ZIP export | MISSING | No | No | - | - | P1 | |
| Drop files from the OS into the project | MISSING | No | No | - | - | P2 | Explorer drag-and-drop moves files inside the project only |
| Chat import / export (Markdown, JSON, PDF) | MISSING | No | No | - | - | P1 | |
| MCP, agent, settings, model-preset import / export | MISSING | No | No | - | - | P1 | |
| Skills import | PARTIAL | Yes | Yes | - | registry | P1 | Registry install only |
| Project instructions import | PARTIAL | n/a | Yes | - | skills | P2 | `AGENTS.md` and `CLAUDE.md` are read; `.cursorrules` and other IDE formats are not |
| Usage report export | MISSING | No | No | - | - | P2 | |
| Git patch / diff export | MISSING | No | No | - | - | P2 | |
| Commit and push | IMPLEMENTED | Yes | Yes | - | git-more | - | |
| Secrets excluded from exports | N/A | - | - | - | - | - | No export exists yet; stored chats are already scrubbed |

### 3.11 Project memory and context

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Project instructions (`AGENTS.md`, `CLAUDE.md`) | IMPLEMENTED | Yes | Yes | project files | skills, loop | - | `loadProjectContext` in `core/skills/loader.ts` |
| `SKETCH.md` | MISSING | No | No | - | - | P1 | |
| Global instructions | MISSING | No | No | - | - | P1 | |
| Directory-specific rules | MISSING | No | No | - | - | P2 | Only the root files are read |
| Persistent project memory | IMPLEMENTED | Yes | Yes | `.sketch/` JSONL, append-only | memory, memory-recall, memory-ingest, MemoryPanel | - | `memory-list`, `memory-search`, `memory-remember`, `memory-supersede` |
| Decision tracking | PARTIAL | Yes | Yes | memory store | memory | P2 | Memory entries have kinds such as `decision`; no dedicated view |
| Context search | IMPLEMENTED | Yes | Yes | - | memory, project-search | - | |
| Edit / delete memory | PARTIAL | Yes | Yes | memory store | MemoryPanel | P2 | Superseding with a reason; no hard delete (append-only by design) |
| Clear project memory | MISSING | No | No | - | - | P1 | |
| Architecture summaries | IMPLEMENTED | Yes | Yes | `.sketch/` graph | architecture, LiveArchitecture | - | Seven views from the persisted graph |
| Context visualisation | PARTIAL | Yes | Yes | event log | AgentTimeline | P2 | `context_assembled` events in the timeline |
| Session restoration | IMPLEMENTED | Yes | n/a | localStorage | ideState | - | Conversations, tabs, layout and theme reopen |
| Ignore rules | IMPLEMENTED | n/a | Yes | - | walker | - | `.gitignore` honoured by the walker |

### 3.12 Editor and IDE

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Monaco editor, syntax highlighting, tabs | IMPLEMENTED | Yes | n/a | localStorage (tab paths) | editor, editorFeatures | - | `desk/editor/CodeEditor.tsx`, `monacoLanguages.ts` |
| IntelliSense, hover, diagnostics | PARTIAL | Yes | n/a | - | editorFeatures, ProblemsPanel | P2 | TypeScript, JavaScript, JSON, CSS, HTML through Monaco's workers; nothing for other languages |
| Go to definition, references, rename symbol | PARTIAL | Yes | n/a | - | - | P2 | Monaco's TypeScript worker, for files open as models only |
| Language servers (LSP) | MISSING | No | No | - | - | P2 | |
| AI ghost-text completion | IMPLEMENTED | Yes | Yes | - | ghostCompletion, inlineCompletion.editor | - | `complete` RPC, cancellable |
| Inline AI edit (Ctrl+K) | IMPLEMENTED | Yes | Yes | - | inline-edit, inlineEdit.editor | - | |
| Split editor | MISSING | No | - | - | - | P2 | |
| File explorer | IMPLEMENTED | Yes | Yes | - | FileExplorer, FileExplorer.crud, FileExplorer.os | - | Create, rename, delete to trash, reveal, live disk watching |
| Integrated terminal, several terminals | IMPLEMENTED | Yes | Yes | - | Terminal, ShellTerminal, ShellSessions, terminal | - | Real shell (`term-start` needs `confirmed: true`), profiles, several tabs |
| Find / replace, global search and replace | IMPLEMENTED | Yes | Yes | snapshot journal | SearchPanel, find-replace | - | Replace in files is undoable |
| Problems panel | IMPLEMENTED | Yes | n/a | - | ProblemsPanel | - | |
| Debugger | MISSING | No | No | - | - | P2 | |
| Keyboard shortcuts | PARTIAL | Yes | n/a | - | cowork-keys | P2 | Built-in shortcuts; no custom keybindings |
| Themes | IMPLEMENTED | Yes | n/a | localStorage | colorTheme, themeColors | - | Dark, light, follow system |
| Editor settings, format on save, autosave | IMPLEMENTED | Yes | n/a | localStorage | editorFeatures | - | |
| Run panel (project scripts) | IMPLEMENTED | Yes | Yes | - | RunPanel, scripts | - | |

### 3.13 Feedback

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Thumbs up / down, message feedback | MISSING | No | No | - | - | P1 | |
| Reporting wrong code, hallucinations, tool / MCP / agent failures | MISSING | No | No | - | - | P1 | |
| Bug reports, feature requests, categories, history, submission status | MISSING | No | No | - | - | P2 | `SECURITY.md` and GitHub issues are the only channels |
| Privacy of feedback | N/A | - | - | - | - | - | Nothing is collected or sent today (`PRIVACY.md`, test: no-egress) |

### 3.14 Security and permissions

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Read-only mode | IMPLEMENTED | Yes | Yes | - | agent-modes | - | Ask mode; the loop refuses `edit` |
| File-edit approval | IMPLEMENTED | Yes | Yes | - | DiffReview, proposals | - | Review mode leaves edits as proposals |
| Terminal approval | IMPLEMENTED | Yes | Yes | - | agent-modes, composer | - | Allow / Allow always / Deny (`parseApproval`) |
| Tool-level permissions | IMPLEMENTED | n/a | Yes | grants | capabilities | - | One enforcement point, `ToolDispatcher.call` |
| Directory restrictions | IMPLEMENTED | n/a | Yes | - | orchestrator, fsops, security | - | Real-path containment, links refused (`core/orchestrator/file-writer.ts`, `rs/` command policy) |
| Protected files (`.env`, `.git/`) | MISSING | No | No | - | - | P0 | The agent may edit any file inside the project |
| Command allowlist / denylist | PARTIAL | n/a | Yes | - | agent-modes | P1 | Built-in classifier (`commandRisk`) with no shell, pipes or `&&`; not user-configurable |
| Secret redaction | IMPLEMENTED | Yes | Yes | - | secrets.patterns, privacy | - | `core/secrets/patterns.ts`, `core/events/redact.ts`, `scrubSecrets` in the window |
| API keys encrypted at rest | IMPLEMENTED | Yes | Yes | OS credential store | keyStore | - | |
| Network restrictions / offline switch | MISSING | No | No | - | no-egress | P0 | No egress beyond configured endpoints, but no switch that forbids non-local endpoints |
| Sandboxed execution | MISSING | No | No | - | - | P2 | `core/tools/command.ts`: "a seatbelt, not a sandbox" |
| Destructive-action confirmation | IMPLEMENTED | Yes | Yes | - | ConfirmDialog, agent-modes | - | Auto mode still asks before destructive commands |
| Audit log | IMPLEMENTED | Partial | Yes | append-only event log | store, TaskLog | - | `tool_called`, `tool_denied`, approvals recorded per run |
| Rollback | IMPLEMENTED | Yes | Yes | snapshot journal | connect | - | `undo-run` |
| Git checkpoints | MISSING | No | No | - | - | P1 | |

### 3.15 Advanced features

| Feature | Status | Frontend | Backend | Storage | Tests | Priority | Evidence / gap |
|---|---|---|---|---|---|---|---|
| Browser automation | PARTIAL | No | Partial | - | mcp | P1 | `playwright` and `browser` MCP catalog entries, unreachable from the window |
| Screenshot analysis, visual development | MISSING | No | No | - | - | P2 | |
| Figma | PARTIAL | No | Partial | - | - | P2 | `figma` catalog entry only |
| Web search, documentation search | MISSING | No | No | - | - | P2 | |
| Live app check | PARTIAL | Yes | Yes | - | verify-live | P1 | `core/verify/live.ts` starts the app and checks it answers; no browser |
| Voice input | MISSING | No | No | - | - | P2 | |
| Background execution | PARTIAL | Yes | Yes | - | background | P2 | Processes only |
| Cloud execution | N/A | - | - | - | - | - | Local-first product |
| Project templates | MISSING | No | No | - | - | P2 | |
| Extensions / plugins | PARTIAL | n/a | Yes | - | phase12-extensibility-gate, extensionRegistry | P2 | Host-code registries; no executable plugin loader, by design (`EXTENSIBILITY.md`) |
| Multiple workspaces | PARTIAL | Yes | n/a | localStorage | ideState | P2 | Recent folders; one folder per window |

### 3.16 Local-first modules from the second brief

| Module | Status | Evidence / gap | Priority |
|---|---|---|---|
| Local AI engine (Ollama install check, model list, download, remove, load, unload, capabilities, context size, RAM / GPU, recommendations) | PARTIAL | Chat through Ollama works and a running server is detected. Download, removal, loading, capability and context detection, hardware checks and recommendations are missing | P0 |
| Offline Mode and privacy dashboard | MISSING | `PRIVACY.md` documents every egress path and `no-egress` tests guard it, but there is no switch, no network activity view and no "clear my data" control | P0 |
| SQLite storage | N/A | Not adopted on purpose: the event log and memory store are append-only JSONL by construction (a test reads the source to prove it), and the engine has no runtime dependencies. `node:sqlite` would add an experimental API for no gained feature | - |
| Sketch Brain (local semantic memory) | PARTIAL | Memory store, hybrid search and architecture graph exist; embeddings are a hashing trick unless a provider is configured; no Ollama embeddings; no cross-project search; no "clear index" | P1 |
| Project Rescue | MISSING | Pieces exist (verify gauntlet, repo graph, undo snapshots); no workflow | P1 |
| Project Health | PARTIAL | Test Results panel runs the real verify stages; no dependency audit, outdated check, large-file or complexity findings, score or history | P1 |
| Project DNA (diagrams) | PARTIAL | Live Architecture shows seven views from static analysis with Mermaid source (`desk/panels/LiveArchitecture.tsx`, `desk/architecture/flowchart.ts`); no export or comparison | P2 |
| UI Doctor (Playwright) | MISSING | Only the run-only Playwright MCP entry | P2 |
| API Lab | MISSING | | P1 |
| Replay | PARTIAL | Task Log, Agent Timeline and Undo read the event log; no restore preview, search or export | P2 |
| Learn | PARTIAL | Editor "Explain This Code"; no quizzes, exercises or learning history | P2 |
| Command Center | PARTIAL | Command palette (`desk/components/CommandPalette.tsx`); no natural-language commands | P2 |
| Cost and token optimizer | PARTIAL | Cost Dashboard sums the log and marks all-local runs as zero cost; no daily view or model comparison | P1 |
| Daily briefing | MISSING | | P2 |
| First-run local model setup | PARTIAL | Connect window finds a running Ollama, LM Studio or llama.cpp and connects it in one click; it cannot install a model or tell whether Ollama is installed but stopped | P0 |

## 4. Security issues found

| # | Issue | Why it matters | Severity | Fix |
|---|---|---|---|---|
| S1 | The agent may write anywhere inside the project, including `.git/` and `.env` files | A prompt injection in a file the agent reads could make it write `.git/hooks/pre-commit` or `.git/config`, which git then runs on the user's next commit; `.env` holds secrets | High | Protected paths refused at the edit layer (milestone M3) |
| S2 | No way to guarantee local-only operation | A user with private code cannot prove that no prompt goes to an internet provider | Medium | Offline Mode enforced in the engine (milestone M1) |
| S3 | `run_command` runs with the user's own rights | A command that passes the classifier can still do anything the user can | Medium, documented | Unchanged: the classifier and per-command approval remain; a real sandbox is P2 |
| S4 | Chats are stored as plain text in the window's local storage | Anyone with access to the user profile can read them; only key-shaped strings are scrubbed | Low | Documented in the privacy view; a "Clear chat history" control (milestone M1) |
| S5 | The Windows installer is not code-signed | SmartScreen warns, and users cannot verify the publisher | Low, distribution | Sign releases in CI when a certificate exists |

## 5. Technical debt

- `core/rpc/methods.ts` is 158 KB (about 3,600 lines), and `desk/state/AppState.tsx` is 72 KB. Both are hard to review. New methods in this task live in their own modules and are only registered in `methods.ts`.
- Two provider adapter generations sit side by side. `core/providers/openai.ts`, `anthropic.ts` and `gemini.ts` call `fetch` directly and are still imported by `registry.ts`; the newer adapters go through `providerFetch`, which owns retries and timeouts.
- The repository root holds large working notes (`NEED-TO-DO.md` 135 KB, `tasks-executed.md` 196 KB, `claude.md` 93 KB, `sol.md` 84 KB), a log file, a video and screenshots. They should move under `docs/history/` or out of the public repository before launch.
- The window reads and writes files on the Tauri main thread, so a very large file can briefly freeze the window.

## 6. Recommended architecture changes

1. **One network gate in the engine.** Every engine request already goes through the global `fetch`, so a single guard at that point can enforce Offline Mode and record network activity for every path, including future ones.
2. **Local model manager as an engine module**, not window code, so the CLI and both transports share it, and the agent runtime keeps talking to models only through provider adapters.
3. **User-configured MCP servers as data with explicit trust.** A project file can be written by anyone who controls the repository, so a project-level server must be approved by the user before it can start, the way a cloned repository's tasks are treated in other IDEs.
4. **Keep JSONL storage.** The append-only guarantees are load-bearing for the audit log and undo. SQLite would add a dependency without adding a feature.

## 7. Prioritised roadmap

| Milestone | Scope | Priority |
|---|---|---|
| M1 | Offline Mode in the engine, network activity view, privacy section with data locations and "clear chat history" | P0 |
| M2 | Local model manager: Ollama status, installed models with capabilities and context size, running models, download with progress, remove, load and unload, RAM-based recommendations | P0 |
| M3 | Protected paths for agent edits (`.git/`, `.sketch/`, `.env` files) | P0 |
| M4 | User-configured MCP servers (stdio) with trust approval, connection test and per-chat enabling | P0 |
| M5 | Chat management: rename, pin, export to Markdown and JSON, import, message feedback, regenerate | P1 |
| M6 | Hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop) from trusted config | P1 |
| M7 | `SKETCH.md` and global instructions, global skills, default role skills | P1 |
| M8 | Project Health (dependency audit, outdated packages, large files, transparent score) | P1 |
| M9 | API Lab (REST requests, collections, history), local embeddings through Ollama for Sketch Brain | P1 |
| M10 | Git stash, merge, init; Hugging Face provider entry; context meter | P1 |
| M11 | UI Doctor, Project Rescue, Replay restore preview, Learn, daily briefing, split editor, debugger | P2 |

What was actually delivered in this task, and what is still open, is recorded in `docs/IMPLEMENTATION_STATUS.md`.

## 8. Rows changed by this task

| Section | Feature | Before | After | Evidence |
|---|---|---|---|---|
| 3.2 | Capability detection | MISSING | PARTIAL | Ollama models show their capabilities (`/api/show`) in Settings → Models; runs do not adapt to them yet |
| 3.2 | Context-window information | MISSING | PARTIAL | Each Ollama model's context length is shown; no context meter in chats |
| 3.2 | Local model download / removal / load | MISSING | IMPLEMENTED | `core/local/ollama.ts`, `LocalModels.tsx`; tests `local-models`, `LocalModels` |
| 3.2 | Hardware-based model recommendation | MISSING | IMPLEMENTED | `core/local/hardware.ts` (memory, NVIDIA GPU, stated rule) |
| 3.4 | Local servers over stdio | PARTIAL | IMPLEMENTED | Your servers can be used in chats (`userMcpServers`); curated catalog entries still cannot be switched on from the window |
| 3.4 | Manual server configuration | MISSING | IMPLEMENTED | `core/mcp/userServers.ts`, MCP panel → Your servers |
| 3.4 | Config import / export, JSON editor | MISSING | PARTIAL | Import of a pasted `mcpServers` block; no export |
| 3.4 | Connect / disconnect / restart / enable | MISSING | PARTIAL | "Use in chats" and "Test"; servers still live for one run |
| 3.4 | Project / global configuration | MISSING | IMPLEMENTED | `~/.sketch/mcp.json` and `<project>/.sketch/mcp.json`, with project-server approval |
| 3.14 | Protected files | MISSING | IMPLEMENTED | `core/tools/protectedPaths.ts`; test `protected-paths` |
| 3.14 | Network restrictions / offline switch | MISSING | IMPLEMENTED | `core/privacy/offline.ts`; test `offline-mode` |
| 3.16 | Offline Mode and privacy dashboard | MISSING | IMPLEMENTED | Settings → Privacy; tests `offline-mode`, `PrivacySettings` |
| 3.16 | Local AI engine | PARTIAL | PARTIAL | Ollama is now managed end to end; LM Studio and llama.cpp are used but not managed; GPU memory only from `nvidia-smi` |
| 3.16 | First-run local model setup | PARTIAL | PARTIAL | Settings → Models now detects installed-but-stopped Ollama, recommends and downloads models and selects one; there is still no guided first-run flow with a test conversation |

Security issues S1 (agent writes to `.git/` and `.env`) and S2 (no offline guarantee) from section 4 are fixed. S4 is reduced: Settings → Privacy can now clear chat history, but chats are still stored as plain text. S3 and S5 are unchanged.
