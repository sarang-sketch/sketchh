# Test report

Date: 2026-11-01. Host: Windows, Node 24.14.0, run serially (`--maxWorkers=1`) because the host had 1 to 3.5 GB of free memory.

## Full suites, after all changes in this task

| Suite | Command | Result |
|---|---|---|
| Engine (`packages/core`) | `npx vitest run --maxWorkers=1 --minWorkers=1` | **1,353 / 1,353 passed**, 82 files, 91 s |
| Window (`packages/desktop`) | `npx vitest run --maxWorkers=1 --minWorkers=1` | **818 / 818 passed**, 87 files, 146 s |
| Engine typecheck | `npx tsc --noEmit -p tsconfig.json` (tests included) | clean |
| Window typecheck | `npx tsc --noEmit -p tsconfig.json` | clean |
| Engine bundle for the app | `npm run build:sidecar -w @sketch/desktop` | built, 788 KiB; contains the new methods |

The previous full runs recorded in the work log were 1,305 (engine) and 804 (window). The difference is the tests added since: 14 for the SkillOpt training work and 34 + 12 in this task.

## New tests in this task

| File | Tests | What it proves |
|---|---|---|
| `packages/core/test/offline-mode.test.ts` | 10 | The switch saves and reloads; a damaged file counts as on; `SKETCH_OFFLINE` forces it; only this machine is reachable; the error names the origin and never the query string; the guard blocks before the socket and records origin-only activity; `run`, `provider-test`, ChatGPT and OpenRouter sign-in, and `git push` are refused with no request made; a model server on 127.0.0.1 still works; nothing changes while it is off |
| `packages/core/test/protected-paths.test.ts` | 7 | Writes to `.git/` (any letter case, nested repos), Sketch's records, skill grants, `.env` files and private keys are refused; templates and ordinary files are not; a git-hook edit creates no file; `read_file` refuses `.env` and `search_code` does not return its lines |
| `packages/core/test/local-models.test.ts` | 10 | Against a stand-in Ollama on 127.0.0.1: capabilities, context length and loaded state are read; an unreachable server is reported; download and removal need `confirmed: true`; bad names are refused; download progress is summed over layers; removal, load and unload hit the documented endpoints; Offline Mode refuses a download; `nvidia-smi` parsing; the recommendation rule at 8, 16 and 64 GB and with a 24 GB GPU |
| `packages/core/test/user-mcp.test.ts` | 7 | Config parsing and refusals (shell strings, remote URLs, bad env); global servers are trusted, project servers only after approval, and a changed launch voids approval; the connection test starts a real stdio server and lists its tools; an unapproved server is refused; a run calls a user server's tool and the answer reaches the model; an unnamed or unapproved server is not started |
| `packages/desktop/src/components/settings/PrivacySettings.test.tsx` | 4 | The switch writes the engine's file; the activity table shows blocked and sent requests; an environment-forced setting is shown and locked; chat history is cleared only after confirmation |
| `packages/desktop/src/components/settings/LocalModels.test.tsx` | 4 | The real engine methods against a stand-in Ollama: status and model facts; download asks first and shows the size; removal asks first; "Use for chat" selects the model with no key |
| `packages/desktop/src/panels/UserMcpServers.test.tsx` | 4 | Add, test (real stdio process) and enable a server; a project's server stays off until approved; import of a pasted config; the parsers |

## Regression checks (mutation testing)

Each safeguard below was removed temporarily; the named test failed; the safeguard was restored and the test passed again.

| Safeguard removed | Test that failed |
|---|---|
| Offline check when resolving a provider | `offline-mode`: refuses runs... |
| Blocking inside the fetch guard | `offline-mode`: the network guard... |
| Confirmation before clearing chats | `PrivacySettings`: clears chat history only after... |
| Write refusal for protected paths | `protected-paths`: 2 integration tests |
| Read refusal for secrets files | `protected-paths`: read_file refuses .env... |
| `confirmed: true` for downloads (engine) | `local-models`: will not download or remove... |
| The download question (window) | `LocalModels`: asks before downloading... |
| Approval check for project servers (engine) | `user-mcp`: does not start a project server that was never approved |
| Disabled "Use in chats" for unapproved servers (window) | `UserMcpServers`: keeps a project's server off... |

## Not tested in this task

- **The installed desktop app.** The window was not driven inside the packaged app; WebView2 on this PC does not open the debugging connection used earlier (see the work log). The bundled engine was rebuilt but not started inside the app here.
- **A real Ollama.** Ollama is not installed on this PC (`ollama` is not on PATH and not in its default folder). The model manager was tested against a stand-in that follows Ollama's documented API.
- **Third-party MCP packages.** The user-server path was tested with a local stdio server script, not with a published package such as `@modelcontextprotocol/server-filesystem`.
- **Production web build and installer.** Not rebuilt in this task.
- **Visual check of the new screens** in light and dark themes. Their light colours come from the existing build step that derives them from each stylesheet, and the theme tests passed, but nobody looked at the screens.
