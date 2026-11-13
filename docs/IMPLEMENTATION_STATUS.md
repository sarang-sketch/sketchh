# Implementation status

Date: 2026-11-01. This page says what was built in this task, what was already there, and what is still missing. The full feature-by-feature audit is `docs/SKETCH_FEATURE_AUDIT.md`; test evidence is `docs/SKETCH_TEST_REPORT.md`.

## 2026-11-13 polish (branch `sketchh-polish`, not pushed yet)

See `asta.md` for the full record with validation numbers. In short:

- **Normal / Turbo speed** in the chat composer, wired to real run caps (turns,
  history, token budget) — the committed code had no Turbo control at all.
- **Chat management**: download a conversation as Markdown or JSON, import a
  JSON export back (validated). Rename, copy-as-Markdown and Retry (regenerate)
  already existed.
- **Context meter** in the chat header (estimated tokens, turns, kept turns).
- **Git init**: a `git-init` engine method (the engine now answers 85 RPC
  methods after the production pass added `hooks-list`, `hooks-save` and
  `hooks-test`) and an "Initialise repository" button in the Git panel; the first
  checkpoint is the existing Commit button.
- **Asta theme**: dark tokens aligned to the cover values (canvas `#141414`,
  sidebar `#191919`, graphite `#222222`, dividers `#303030`, porcelain
  `#eeeeec`, ember `#f58a50`).
- **Sketch Mobile** (`packages/mobile/`): a PWA / Capacitor-ready phone app —
  Files, Editor, Agent (same modes + Normal/Turbo), Preview, Settings. No
  terminal on mobile. APK not built in the Linux VM (no Android SDK); see
  `packages/mobile/README.md` for the exact build steps.
- **Windows EXE not built** in this VM (no Rust toolchain; NSIS packaging is
  native-Windows-only per `PACKAGING.md`). Run
  `npm run package:windows -w @sketch/desktop` on a Windows host.
- **2026-11-13 production pass** (same branch, still not pushed — GitHub repo
  selection unconfirmed): hooks (SessionStart / PreToolUse / PostToolUse /
  Stop, argv-only, opt-in per run), remote MCP over Streamable HTTP (no
  OAuth), Project Rescue, UI Doctor, API Lab, chat pin/archive, per-chat
  model, thumbs feedback, edit-and-resend, voice input (Dictate button),
  debugger basics (breakpoints recorded, bare `node --inspect` launch, no
  stepping), daily briefing (conversations only), Cost Dashboard per-model
  grouping, mobile service worker + file-bundle sync (v2, not live sync).
  Split editor is built but **not wired** (`CodeEditor` needs per-pane
  props first). Validation: core 1,450 passed / 1 skipped (88 files),
  desktop 1,049 passed (117 files), mobile 25 passed (4 files); typecheck
  clean in all three; desktop build + bundle check pass; mobile build
  passes. See `asta.md` for the full record.

## Delivered in this task

| Milestone | What a user gets | Engine | Window | Tests |
|---|---|---|---|---|
| M1 Offline Mode | Settings → Privacy: one switch that keeps the engine on this computer; a list of every request the engine made (address and result only); where Sketch keeps data; "Clear chat history"; an "Offline" chip in the status bar | `core/privacy/offline.ts`; RPC `privacy-status`, `privacy-set`; guard installed in `core/rpc/server.ts` `main()` and the Vite bridge | `desk/components/settings/PrivacySettings.tsx`, `StatusBar.tsx` | `offline-mode` (10), `PrivacySettings` (4) |
| M2 Local model manager | Settings → Models → "On this computer": Ollama status (running, installed but stopped, not installed), installed models with size, quantisation, context length and capabilities, loaded state, Load / Unload, Remove (asks first), recommendations for this machine's memory and GPU, Download with progress (asks first, shows size), "Use for chat" | `core/local/ollama.ts`, `core/local/hardware.ts`; RPC `local-models`, `local-model-pull`, `local-model-pull-status`, `local-model-pull-cancel`, `local-model-delete`, `local-model-load` | `desk/components/settings/LocalModels.tsx` | `local-models` (10), `LocalModels` (4) |
| M3 Protected paths | The agent can no longer write `.git/`, Sketch's own records (`.sketch/events`, snapshots, memory...), skill grants, `.env` files or private keys, and can no longer read secrets files or get their lines from search | `core/tools/protectedPaths.ts`, used by `core/loop/edits.ts` and `core/tools/project.ts` | - | `protected-paths` (7) |
| M4 Your MCP servers | MCP panel → "Your servers": add a server (name, command, arguments, environment), import a Claude Desktop / Cursor / Claude Code config, test it (starts it and lists its tools), approve a project's server, remove, and "Use in chats" | `core/mcp/userServers.ts`, `McpCatalogRegistry.withUserServers`; RPC `mcp-servers`, `mcp-server-save`, `mcp-server-remove`, `mcp-server-trust`, `mcp-server-test`; run parameter `userMcpServers` | `desk/panels/UserMcpServers.tsx`; `AgentSession.tsx` passes enabled servers | `user-mcp` (7), `UserMcpServers` (4) |

The engine now answers 85 RPC methods (81 before the 2026-11-13 polish added `git-init`; 85 after the production pass added `hooks-list`, `hooks-save`, `hooks-test`).

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
| Project Rescue analyses real repositories | Met for the open files | Pure analyser over the open files (partial view, not a whole-tree scan); `.env` flagged, contents never rendered; no auto-fix |
| Health checks use actual tools | Partly met | The Test Results panel runs the project's real checks; no dependency audit or health score (roadmap M8) |
| UI Doctor runs real browser tests | Met for the page it runs in | Real DOM checks (alt text, accessible names, labels, title/lang, contrast estimate); cannot check an arbitrary URL |
| API Lab makes actual requests | Met | Real fetch, 10 s default timeout, 50 KB body cap, secrets scrubbed from history; no manual Cancel/replay |
| Git checkpoints work | Partly met | Every auto-applied run has a file snapshot and Undo; no git-based checkpoints |
| Import / export works | Partly met | Clone, open folder, MCP config import; no ZIP or chat export (roadmap M5) |
| Offline Mode prevents external AI calls | Met | Explicit checks plus a guard around the engine's `fetch`; tests prove no request leaves while it is on |
| Critical workflows pass end-to-end tests | Partly met | Engine and window tests drive real engine methods, real git, real stdio processes and real loopback HTTP; the installed desktop app was not driven end to end in this task |
| Documentation is complete | Met for what exists | The ten requested docs plus the five audit docs |

Sketch does **not** have feature parity with Claude Code or Codex. The largest remaining gaps are now the honest stubs and missing pieces of this round: split editor wiring (`CodeEditor` per-pane props), debugger stepping, hooks trust/approval and remote MCP OAuth, live (not file-bundle) mobile↔desktop sync, and a desktop-side sync-bundle import.

## Still pending, with the precise limitation

| Area | Limitation today | Roadmap |
|---|---|---|
| Chat management | Pin, archive, per-chat model, thumbs feedback and edit-and-resend now exist; no branch | M5 |
| Hooks | SessionStart, PreToolUse (can deny), PostToolUse, Stop exist, opt-in per run; no per-file trust/approval flow yet; matcher is a tool-name glob only | M6 |
| Instructions and skills | `SKETCH.md`, global instructions, global skills and the 12 default role skills are missing | M7 |
| Project Health | No dependency audit, outdated-package check, large-file or complexity findings, score or history | M8 |
| API Lab, local embeddings | API Lab built (real requests); semantic search still uses a hashing embedder unless a provider is configured | M9 |
| Git | Init, stage, commit, branches and sync exist; no stash, merge, rebase, conflict resolution, GitHub issues or pull requests | M10 |
| Providers | No Hugging Face entry (reachable through Custom); per-chat model exists; no fallback; context meter now exists in the chat header | M10 |
| MCP | Stdio + Streamable HTTP; no OAuth, resources, prompts or sampling; Offline Mode starts no user server | M4 follow-up |
| Local models | Only Ollama is managed (LM Studio and llama.cpp are used, not managed); GPU memory is read only from NVIDIA's `nvidia-smi`; the memory rule is an estimate | M2 follow-up |
| Split editor, debugger stepping, voice on all browsers, daily briefing sources | Split editor built but not wired (`CodeEditor` needs per-pane props); debugger records breakpoints and launches a bare inspector, no stepping/pausing/variables; voice is SpeechRecognition where the browser has it; daily briefing covers conversations only (no runs/costs/tasks) | M11 |

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
