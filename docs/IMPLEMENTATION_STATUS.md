# Implementation status

Date: 2026-11-01. This page says what was built in this task, what was already there, and what is still missing. The full feature-by-feature audit is `docs/SKETCH_FEATURE_AUDIT.md`; test evidence is `docs/SKETCH_TEST_REPORT.md`.

## Delivered in this task

| Milestone | What a user gets | Engine | Window | Tests |
|---|---|---|---|---|
| M1 Offline Mode | Settings → Privacy: one switch that keeps the engine on this computer; a list of every request the engine made (address and result only); where Sketch keeps data; "Clear chat history"; an "Offline" chip in the status bar | `core/privacy/offline.ts`; RPC `privacy-status`, `privacy-set`; guard installed in `core/rpc/server.ts` `main()` and the Vite bridge | `desk/components/settings/PrivacySettings.tsx`, `StatusBar.tsx` | `offline-mode` (10), `PrivacySettings` (4) |
| M2 Local model manager | Settings → Models → "On this computer": Ollama status (running, installed but stopped, not installed), installed models with size, quantisation, context length and capabilities, loaded state, Load / Unload, Remove (asks first), recommendations for this machine's memory and GPU, Download with progress (asks first, shows size), "Use for chat" | `core/local/ollama.ts`, `core/local/hardware.ts`; RPC `local-models`, `local-model-pull`, `local-model-pull-status`, `local-model-pull-cancel`, `local-model-delete`, `local-model-load` | `desk/components/settings/LocalModels.tsx` | `local-models` (10), `LocalModels` (4) |
| M3 Protected paths | The agent can no longer write `.git/`, Sketch's own records (`.sketch/events`, snapshots, memory...), skill grants, `.env` files or private keys, and can no longer read secrets files or get their lines from search | `core/tools/protectedPaths.ts`, used by `core/loop/edits.ts` and `core/tools/project.ts` | - | `protected-paths` (7) |
| M4 Your MCP servers | MCP panel → "Your servers": add a server (name, command, arguments, environment), import a Claude Desktop / Cursor / Claude Code config, test it (starts it and lists its tools), approve a project's server, remove, and "Use in chats" | `core/mcp/userServers.ts`, `McpCatalogRegistry.withUserServers`; RPC `mcp-servers`, `mcp-server-save`, `mcp-server-remove`, `mcp-server-trust`, `mcp-server-test`; run parameter `userMcpServers` | `desk/panels/UserMcpServers.tsx`; `AgentSession.tsx` passes enabled servers | `user-mcp` (7), `UserMcpServers` (4) |

The engine now answers 81 RPC methods (68 before).

Every new safeguard was checked by temporarily removing it and confirming its test fails: the provider check and the fetch guard (M1), the clear-history confirmation (M1), the edit and read refusals (M3), the download confirmation in engine and window (M2), and project-server approval in engine and window (M4).

## Final acceptance criteria from the brief

| Criterion | Status | Evidence or limitation |
|---|---|---|
| Core features work without a paid API | Met | Ollama, LM Studio, llama.cpp and Custom endpoints need no key; ChatGPT sign-in and free hosted tiers are optional |
| A local model can power the coding agent | Met in code, not proven on this machine | The agent's JSON action protocol works with any chat model (`core/loop/actions.ts`). No real Ollama model was run in this task: Ollama is not installed on the build PC |
| Filesystem operations work | Met | Agent edits, Explorer create / rename / delete; tests `loop`, `fsops`, `FileExplorer*` |
| Terminal operations work with permissions | Met | `run_command` asks in Agent mode; `term-start` needs `confirmed`; tests `agent-modes`, `terminal` |
| MCP works with compatible servers | Met for stdio servers | Tested with a real stdio server process; remote (HTTP) servers, resources and prompts are not implemented |
| Skills can be discovered and invoked | Met | `/skill-name` and the `use_skill` tool; tests `skills`, `composer` |
| Project memory persists locally | Met | Append-only JSONL under `.sketch/`; tests `memory*`, `MemoryPanel` |
| Agents can execute actual tasks | Met | Single agent and Build Team hand-offs; tests `loop`, `handoff`, `TeamPanel` |
| Project Rescue analyses real repositories | Not met | Not implemented (roadmap M11) |
| Health checks use actual tools | Partly met | The Test Results panel runs the project's real checks; no dependency audit or health score (roadmap M8) |
| UI Doctor runs real browser tests | Not met | Not implemented (roadmap M11) |
| API Lab makes actual requests | Not met | Not implemented (roadmap M9) |
| Git checkpoints work | Partly met | Every auto-applied run has a file snapshot and Undo; no git-based checkpoints |
| Import / export works | Partly met | Clone, open folder, MCP config import; no ZIP or chat export (roadmap M5) |
| Offline Mode prevents external AI calls | Met | Explicit checks plus a guard around the engine's `fetch`; tests prove no request leaves while it is on |
| Critical workflows pass end-to-end tests | Partly met | Engine and window tests drive real engine methods, real git, real stdio processes and real loopback HTTP; the installed desktop app was not driven end to end in this task |
| Documentation is complete | Met for what exists | The ten requested docs plus the five audit docs |

Sketch does **not** have feature parity with Claude Code or Codex. The largest remaining gaps are hooks, remote MCP, chat management (rename, export, feedback), and the new tools of the second brief (Project Rescue, UI Doctor, API Lab, daily briefing).

## Still pending, with the precise limitation

| Area | Limitation today | Roadmap |
|---|---|---|
| Chat management | No rename, pin, archive, branch, edit-and-resend, regenerate, thumbs feedback, or Markdown / JSON export and import | M5 |
| Hooks | No SessionStart, PreToolUse, PostToolUse or Stop hooks | M6 |
| Instructions and skills | `SKETCH.md`, global instructions, global skills and the 12 default role skills are missing | M7 |
| Project Health | No dependency audit, outdated-package check, large-file or complexity findings, score or history | M8 |
| API Lab, local embeddings | Not built; semantic search uses a hashing embedder unless a provider is configured | M9 |
| Git | No init, stash, merge, rebase, conflict resolution, GitHub issues or pull requests | M10 |
| Providers | No Hugging Face entry (reachable through Custom); no per-chat or per-project model; no fallback; no context meter | M10 |
| MCP | Stdio only; no Streamable HTTP, OAuth, resources, prompts or sampling; Offline Mode starts no user server | M4 follow-up |
| Local models | Only Ollama is managed (LM Studio and llama.cpp are used, not managed); GPU memory is read only from NVIDIA's `nvidia-smi`; the memory rule is an estimate | M2 follow-up |
| UI Doctor, Project Rescue, Replay restore preview, Learn quizzes, daily briefing, split editor, debugger, voice | Not built | M11 |

## Install, build and run

Requirements: Windows 10/11, macOS or Linux; Node.js 22 (`.nvmrc`; `package.json` accepts 20 or later); Git. For the desktop build: Rust (stable) and the Tauri 2 prerequisites. Optional: Ollama for local models.

```powershell
npm ci                      # install, exactly as the lockfile says
npm run build:core          # build the engine
npm run dev:desktop         # the window in a browser with the dev bridge (http://localhost:1420)
npm test                    # engine and window tests
npm run typecheck           # both packages
npm run build:desktop       # production web build of the window
npm run package:desktop     # native installer (Tauri); see PACKAGING.md for Windows details
```

Before packaging, `npm run build:sidecar -w @sketch/desktop` bundles the engine into `packages/desktop/src-tauri/resources/sketch-engine.mjs`.

Model setup and hardware guidance: `docs/OLLAMA_SETUP.md`. Troubleshooting for Offline Mode: `docs/OFFLINE_MODE.md`.

## Known limitations

- The Windows installer is not code-signed, so SmartScreen warns on first run.
- On this build PC the local Windows installer can only be built with the GNU toolchain (no Windows SDK); `PACKAGING.md` explains the extra DLL that build must ship. CI builds with Microsoft's toolchain.
- No database migrations were added: Sketch has no database (see `docs/SKETCH_ARCHITECTURE.md`).
