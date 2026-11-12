# Sketch IDE — Architecture Review (W1 Audit)

Audit date: 2026-11-01. Scope: read-only. Build tested: release exe at
`packages/desktop/src-tauri/target/release/sketch-desktop.exe` (built 2026-11-01 12:15:42,
newer than the newest source change at 11:25:01, so the exe reflects current source) and the
Vite dev preview (same source). No source or config was changed by this item.

All anchors are `file:line` or `file` at the repo root `C:\Users\saran\Downloads\sketch`.

---

## 1. Top-level layout

| Folder | Purpose |
|---|---|
| `packages/core` | `@sketch/core` — the dependency-free engine (Node/TypeScript). A newline-delimited JSON-RPC server over stdin/stdout. Entry: `src/cli.ts` → `src/rpc/index.ts`. Built to `dist/`. |
| `packages/desktop` | The Tauri 2 desktop app: React 19 + Vite + Monaco + xterm front end (`src/`), Rust back end (`src-tauri/`). |
| `docs` | Project docs, prior audits, and this overhaul's deliverables. |
| `picture` | Gitignored screenshot/scratch store (W1 screenshots under `picture/overhaul/w1`). |
| `.kiro`, `.github`, `.claude`, `.vscode` | Tooling / CI / editor config. |
| `.sketch` | A repo-local Sketch state dir (the app writes per-project state under each opened folder's own `.sketch/`). |

Root `package.json` declares npm workspaces (`packages/*`), Node ≥ 20, and the build/test/
typecheck/bench/package scripts.

The two packages talk over ONE seam: the engine's JSON-line RPC. The desktop reaches it two
ways — a **stdio sidecar** in the packaged app and an **HTTP dev bridge** in `vite` — chosen by
one factory (`packages/desktop/src/lib/factory.ts`). A second, deliberately narrow channel is
the **Tauri native command bridge** (`src/ipc/bridge.ts` ↔ `src-tauri/src/main.rs`) for the
things the OS can do and a webview cannot: folder picker, file read/write, directory listing,
git status/diff, the confirmed terminal command, and OS credential storage.

---

## 2. `packages/core/src` — the engine, module by module

| Module | Purpose | Entry |
|---|---|---|
| `rpc` | The JSON-line protocol: frames, server dispatch, the method table. | `index.ts`, `server.ts`, `methods.ts` |
| `loop` | The agentic loop: plan → edit → verify → done, with the plan gate and edit application. | `index.ts`, `agent.ts`, `edits.ts`, `actions.ts` |
| `providers` | Chat adapters (OpenAI-compatible, Anthropic-messages, ChatGPT/Codex, Gemini, fake), request wire, redaction, registry. | `index.ts`, `openaiCompatible.ts`, `anthropicMessages.ts`, `chatgpt.ts`, `fake.ts`, `wire.ts` |
| `capabilities` | Capability scoping vocabulary and the single enforcement point (`ToolDispatcher`). | `guard.ts`, `vocabulary.ts` |
| `tools` | Tools the engine drives on the user's machine: command, terminal, git, fsops, find/replace, project, watcher, background, desktopOpen, protectedPaths. | `index.ts` |
| `skills` | Loading, editing, optimizing (SkillOpt trainer) and front-matter of skills. | `index.ts`, `loader.ts`, `trainer.ts` |
| `registry` | The curated skill registry: pinned manifest, per-skill content hash, install/materialize/grants/seeds. | `index.ts`, `install.ts`, `manifest.ts`, `materialize.ts` |
| `mcp` | Curated MCP tool layer: hand-rolled JSON-RPC over stdio, pinned servers, catalog, user servers, host/client. | `index.ts`, `catalog.ts`, `client.ts`, `host.ts`, `userServers.ts` |
| `context` | Repo graph, chunking, embeddings (offline embedder), hybrid search, architecture generation, assembly. | `index.ts`, `context-engine.ts`, `assembly.ts` |
| `memory` | Project memory: versioned rows, hygiene, ingest, retrieve, registry. | `index.ts`, `store.ts`, `retrieve.ts` |
| `cost` | Cost accounting, budget guard, model routing, pricing, response cache, ledger. | `index.ts`, `ledger.ts`, `budget.ts`, `pricing.ts` |
| `verify` | Shell-less verification runner and the nine-stage policy. | `index.ts`, `runner.ts`, `policy.ts`, `live.ts` |
| `strategy` | Eval-gated multi-agent: dispatcher, thirteen roles, deterministic merge, pass@k. | `index.ts`, `dispatcher.ts`, `roles.ts` |
| `settings` | Key-free provider configuration, connection test, provider matrix, ChatGPT auth, OAuth loopback. | `index.ts`, `providerSettings.ts`, `connectionTest.ts`, `chatgptAuth.ts` |
| `secrets` | The engine's single definition of what a credential looks like (pattern tables + store). | `index.ts`, `patterns.ts`, `store.ts` |
| `events` | Append-only event store (JSONL per project), ids, redaction, streaming. | `index.ts`, `store.ts`, `redact.ts` |
| `plan` | The plan artifact writer (the plan gate's on-disk evidence). | `index.ts`, `writer.ts` |
| `orchestrator` | File writer with snapshotting (undo), JSON helpers. | `index.ts`, `file-writer.ts` |
| `diff` | Unified-diff parse and per-hunk apply. | `index.ts`, `hunks.ts` |
| `assist` | Editor/composer assistance: inline completion, inline edit, slash commands. | `index.ts`, `completion.ts`, `inlineEdit.ts` |
| `local` | Local model manager (Ollama) and hardware probe. | `ollama.ts`, `hardware.ts` (no `index.ts`) |
| `privacy` | Offline Mode state and the network request guard. | `offline.ts` (no `index.ts`) |
| `extensions` | One immutable host-owned production extension bundle (provider/MCP/memory registries). | `index.ts` |
| `evals` | Eval capture and runner (capture-as-eval → SkillOpt). | `index.ts`, `runner.ts`, `capture.ts` |
| `bench` | Offline benchmark suite, runner, metrics, artifact. | `index.ts`, `runner.ts` |
| `workspace` | The project-local `.sketch` state directory and its marker. | `index.ts`, `state-dir.ts` |

### The RPC method surface (`rpc/methods.ts:3836` `METHODS`)
The engine answers these method names (selected, grouped). The protocol's five required methods
are `ping`, `run`, `eval`, `parse-skill`, `capture-eval` (`methods.ts:3977`).
- Runs: `run`, `cancel`, `reply`.
- Providers/models: `provider-catalog`, `provider-config-save`, `provider-test`, `provider-models`,
  `chatgpt-*`, `oauth-*`, `local-model*`.
- Git: `git-status`, `git-diff`, `git-stage/unstage/commit/discard/branches/switch/push/pull/fetch/log/show/clone`, `git-commit-message`.
- FS/editor/search: `fs-create-file/folder`, `fs-rename`, `fs-delete`, `fs-watch`, `os-reveal`,
  `os-open-terminal`, `project-files`, `project-search`, `find-in-files`, `replace-in-files`,
  `complete`, `inline-edit`, `commands-list`.
- Terminal: `term-start` (refuses without `confirmed:true`), `term-read`, `term-write`, `term-kill`.
- Skills: `skills-catalog`, `skill-install`, `skill-train`, `skill-promote`. **There is NO
  `skill-uninstall`** (see BUG_AUDIT B-002).
- MCP: `mcp-catalog`, `mcp-servers`, `mcp-server-save/remove/trust/test`.
- Verify / cost / memory / strategy / benchmarks / architecture / privacy: `verify`, `cost`,
  `memory-list/search/remember/supersede`, `strategy-catalog`, `benchmark-report`, `architecture`,
  `privacy-status`, `privacy-set`.

`run`, `eval`, `skill-train` are **exclusive** (`server.ts:185`): they serialize against each
other so two project-mutating runs cannot interleave.

---

## 3. `packages/desktop/src` — the front end, directory by directory

| Dir | Role |
|---|---|
| `components` | App shell: `AppLayout`, `AgentLayout` (Cowork), `IdeLayout` (Code), `TitleBar`, `StatusBar`, `BottomPanel`, `CommandPalette`, `ModelSelector`, dialogs (`ConfirmDialog`, `CloneDialog`, `FolderPathDialog`), `ContextMenu`, `ide/ActivityBar`, `ide/SidePanel`, `settings/*` (`SettingsDialog`, `ConnectWizard`, `LocalModels`, `PrivacySettings`). |
| `editor` | Monaco integration: `CodeEditor`, model registry + canonical `paths.ts`, `fileIo.ts`, disk sync, diff view, inline completion/edit, project watcher, editor theme. |
| `explorer` | File-tree model (`fileTree.ts`). |
| `git` | `GitProvider`, `gitStatus` (reads engine `git-status`). |
| `ipc` | `bridge.ts` — the Tauri native command wrappers (the ONLY place that calls `invoke`). |
| `lib` | The engine seam: `client.ts` (`SketchClient` + `RunOptions`), `factory.ts`, `stdioClient.ts`, `httpClient.ts`, `mockClient.ts`, `AgentSession.tsx` (the window's one run session), `ClientProvider`, `contracts.ts`, `secrets.ts`, `desktopGuards.ts`, `runDefaults.ts`. |
| `panels` | Feature panels: `agent/*` (AgentChat, Composer, ConversationSidebar, AgentTeamPanel), `SkillsMarketplace`, `UserMcpServers`, `McpTools`, `ProviderSettings`, `FileExplorer`, `GitPanel`, `DiffReview`, `CostDashboard`, `MemoryPanel`, `BenchmarksPanel`, `LiveArchitecture`, `TaskLog`, `TestResults`, `ide/*` (SearchPanel, ProblemsPanel, RunPanel, Terminal, ShellTerminal, IdeChatSidebar). |
| `state` | `AppState.tsx` — the single reducer/store (files, conversations, provider state, UI). |
| `styles` | `global.css` (design tokens), `fonts.css`, `themeColors.ts` (algorithmic dark→light derivation), `colorTheme.ts`. |
| `terminal` | xterm wiring: ansi, command line, links, pty backend, shell sessions/runner, trust. |
| `review` | Diff proposal engine for Agent-mode review edits. |
| `run` | Run-script detection for the Run panel. |
| `settings` | Key store provider, provider rows/guide/config hooks, PKCE, ChatGPT settings. |
| `team` | AI team panel + handoff. |
| `test`, `testing` | Test harness (`engineHarness.ts`, `jsdomFetchBridge.ts`) and source-of-truth test. |
| `ui/panels` | `AgentConsole`, `AgentTimeline`. |
| `architecture` | Flowchart generator for the architecture view. |

Entry: `src/main.tsx` → `src/App.tsx`. Both surfaces (Cowork and Code) mount at once and are
shown/hidden by CSS in `AppLayout` — **confirmed live**: the DOM carries both composers, the file
tree toolbar, and the terminal simultaneously. This is why `AgentSession` is one session for the
whole window.

## 4. `packages/desktop/src-tauri/src` — the Rust back end

| Module | Purpose |
|---|---|
| `main.rs` | Tauri builder, the 17 `#[tauri::command]`s and their registration in `generate_handler!`, plugins (shell, fs, dialog, window_state), and `RunEvent::Exit` cleanup that closes every terminal shell. |
| `command_policy.rs` | Path containment and terminal policy for every command that touches a path or spawns a process. The single containment implementation. |
| `os_credentials.rs` | Platform bindings for the credential backend (Windows Credential Manager / Keychain / Secret Service). |
| `secret_store.rs` | The platform-independent half of key handling (id validation, policy, errors that cannot hold a value). |
| `terminal_ipc.rs` | Real PTY terminals for the Code surface (`terminal_*` commands), and `close_all` on exit. |
| `secrets_check.rs` | A verification shim, not part of the app. |

Registered commands (`main.rs` `generate_handler!`): `read_dir`, `read_file`, `write_file`,
`open_project_dialog`, `git_status`, `git_diff`, `run_command`, `allowed_programs`,
`list_providers`, `set_api_key`, `resolve_api_key`, `remove_api_key`, and
`terminal_ipc::{terminal_profiles, terminal_open, terminal_write, terminal_resize, terminal_close}`.

---

## 5. Traced end-to-end paths

### (a) Open folder → list → open file → edit → save
1. `useFileActions.openFolder()` calls `io.pickFolder()` → Tauri `open_project_dialog`
   (`main.rs`), or, in the dev bridge, dispatches `sketch:open-folder-path` and opens
   `FolderPathDialog`.
2. `openFolderPath()` (`editor/useFileActions.ts:~283`) closes current buffers if the path
   differs, then dispatches `SET_PROJECT_ROOT`. The reducer (`AppState.tsx:967`) canonicalizes,
   and **on a change clears `openFiles`/`files`/`activeFile`/diagnostics and resets terminal cwds**.
3. File tree calls `listForExplorer` → `readDir` → Tauri `read_dir` (`main.rs`), which resolves
   via `command_policy::resolve_dir_within` and skips dotfiles/`node_modules`/`target`/`dist`.
4. Opening a file: `readForEditor` → `read_file` → `command_policy::resolve_file_within`;
   content keyed by `canonicalPath` (`editor/paths.ts`) in the one model registry.
5. Save: `writeFromEditor` → `write_file` → `command_policy::resolve_write_target` (nearest
   existing ancestor walk for new files). `beginEditorSave` guards disk-sync races (`fileIo.ts`).

### (b) Chat message → provider request → stream → tool call → edit → completion
1. `AgentSession.send()` → `startRun()` (`lib/AgentSession.tsx`). Picks provider =
   `providers.find(id==selectedProvider)`, overriding `model` with `selectedModel` when the picker
   chose another model of the same provider. Resolves the stored key for THIS call only
   (`resolveApiKeyForRun`, `lib/secrets.ts`).
2. `client.run(task, options)` with `root = projectRoot`, mode options from `modeRunOptions`,
   budget, history. Transport (`stdioClient`/`httpClient`) merges the api key onto the outgoing
   provider object and nowhere else.
3. Engine `run` (`rpc/methods.ts:889`): `root = resolve(params.root ?? ctx.cwd())`, builds the
   JSONL event store + `PlanWriter` rooted at the project, calls `loop/agent.ts runTask`.
4. `runTask` iterates: each turn is one `adapter.chat()` call. OpenAI-compatible adapter puts
   `model: this.config.model` in the body (`providers/openaiCompatible.ts:75`) and parses usage
   from `data.usage.prompt_tokens/completion_tokens` (`:135`). Events stream back over the frame
   channel and accumulate in the UI event log.
5. Edits: `edit` action → `prepareEdit`/`applyPreparedEdit` (`loop/edits.ts`) emits
   `edit_proposed` then `edit_accepted` or `edit_rejected`. Completion: `done` action
   (`agent.ts:1099`) runs verification if configured, then `finish(verifyOk(), …)` →
   `run_completed`/`run_failed`.

### (c) Ask vs Agent vs Auto
`modeRunOptions` (`lib/AgentSession.tsx`): `ask` → `readOnly:true`, no command tool;
`agent` → `commands:'ask'`, `reviewEdits = !autoApply`; `auto` → `commands:'auto'`,
`autonomous:true`, `maxIterations ≥ 50`, auto-continue up to 2 on `max_iterations`.

### (d) Skill discover/install/activate
`SkillsMarketplace` → `skills-catalog` (engine materializes the curated registry to
`~/.sketch/registry/curated-*` and lists `installed` from the project's `.sketch/skills`) →
`skill-install {root,name}` verifies the content hash and writes the skill dir, emitting a
`tool_called`/`skill-install` event. **Verified live** (see BUG_AUDIT evidence). Activation is by
the loader reading `.sketch/skills/*`; a run loads a skill by name via `autoSkills`/`skillNames`.

### (e) MCP connect / tool discovery / tool call
`McpTools` → `mcp-catalog` (read-only: 15 curated servers, each with pinned argv,
`requiresEnv`/`missingEnv`, capability cost, caveat). Servers are **started per run**, from
`params.mcpServers`, only when the run's grant covers the capability — nothing is connected
between runs (`mcp/host.ts`, `mcp/client.ts`). User servers: `mcp-server-*` in `mcp/userServers.ts`.

### (f) Terminal command
Two backends. Classic runner → Tauri `run_command` (`main.rs`) → `command_policy`
(allowlist `git/npm/node/cargo/python`, contained cwd, `confirmed:true`, no shell). Real PTY →
`terminal_ipc.rs` (`terminal_open/write/resize/close`) for the Code surface's interactive shell.

### (g) Git status/diff/commit
The panels read the **engine** methods (`git-status`, `git-diff`, `git-commit`, …) through
`SketchClient`; the authoritative porcelain parser is `core/src/tools/git.ts`. The Tauri
`git_status`/`git_diff` commands exist for the native bridge wrapper but use a simpler Rust parser
— a **documented duplication** (`main.rs` comment): two git-status parsers. The panels
deliberately do not depend on the Rust one.

### (h) Settings change → persistence → effect
Editor/Agent settings persist with the window via the reducer; provider config persists to the
key-free `~/.sketch/providers.json` via `provider-config-save`; keys go to the OS credential store
via `set_api_key`. Offline Mode persists via `privacy-set`. Settings read back from the engine
(`provider-catalog`, `privacy-status`) so there is one source of truth.

### (i) Startup and shutdown including the engine sidecar
`main.rs` builds the window (window-state plugin restores size/position). The front end's factory
spawns the stdio sidecar (packaged) or uses the in-process HTTP bridge (dev). On `RunEvent::Exit`
the Rust side calls `terminal_ipc::TerminalState.manager.close_all()` so a dev server a terminal
started does not outlive the IDE. The engine's `cli.ts` never `process.exit()`s so stdout drains.

---

## 6. Architectural problems noted (each with a pointer)

1. **Two git-status parsers** (`src-tauri/src/main.rs` `git_status` vs `core/src/tools/git.ts`).
   The Rust one is simpler (no rename/quoted-path/detached-HEAD handling) and is kept only for the
   native bridge wrapper; the panels read the engine. Low risk but a real second source of truth.
2. **No `skill-uninstall`** anywhere (engine `METHODS` has none; `SkillsMarketplace.tsx` installed
   cards have only a "Train on my project" button). Uninstall is simply not implemented. See
   BUG_AUDIT B-002.
3. **Silent project-root switch** when opening a conversation whose stored `root` differs
   (`panels/agent/ConversationSidebar.tsx:42` → `SET_PROJECT_ROOT`, which closes all buffers).
   This is the root of the "different workspace boundary" symptom. See BUG_AUDIT B-001.
4. **Design-token naming vs value drift**: `styles/global.css` still names the brand accent
   `--accent-teal`, `--bg-teal-*` while the values are orange (`#ea580c`/`#f97316`). Harmless at
   runtime, misleading to maintainers. See UI_UX_AUDIT.
5. **`TitleBar.tsx:237` `windowCall`** calls `getCurrentWindow()` without a Tauri guard, so in the
   dev bridge any window-control click throws an uncaught `TypeError` to the console. Benign in the
   packaged app, but it means the dev console is never clean. See BUG_AUDIT B-008.

Dead modules: none found during this pass. Earlier fixture state (fake `agentTeam`, `tasks`,
`totalCost`, fake skills/providers) has already been removed from `AppState.tsx` (documented in
its own comments).
