# Required workflows: test status

The 28 workflows the local-first brief lists, each marked by the strongest evidence that exists. Suite results and new test files are in `docs/SKETCH_TEST_REPORT.md`.

| Status | Meaning |
|---|---|
| Automated | An automated test drives the real engine path (real files, git, processes or loopback HTTP) |
| Partial | Part of the workflow is tested; the gap is named |
| Not verified | Implemented, but no test or manual run in this task proves it |
| Not built | The feature does not exist yet |

| # | Workflow | Status | Evidence / gap |
|---|---|---|---|
| 1 | Install Sketch without an API key | Not verified | The installer was built and its startup check passed earlier (work log); nothing in setup asks for a key, but a fresh install was not repeated in this task |
| 2 | Install and connect Ollama | Partial | Detection of a running server and one-click connect: `onboarding`; the "not installed / installed but stopped" message: `LocalModels` component; no real Ollama on this PC |
| 3 | Download and load a local model | Automated (stand-in server) | `local-models`, `LocalModels`: download with progress, load, unload, against a server that follows Ollama's documented API |
| 4 | Create a conversation | Automated | `chat-ui`, `composer` |
| 5 | Restart Sketch and resume it | Automated | `ideState`, `chat-ui` (state saved and restored from local storage) |
| 6 | Import an existing repository | Automated | Open folder: `FileExplorer`; clone: `connect` (`git-clone`) |
| 7 | Ask the agent to inspect the project | Automated | `project-tools`, `loop` (read, list, search tools) |
| 8 | Ask the agent to edit multiple files | Automated | `loop`, `orchestrator` |
| 9 | Approve and reject terminal operations | Automated | `agent-modes`, `composer` (Allow / Allow always / Deny) |
| 10 | Run the project | Automated | `RunPanel`, `background` |
| 11 | Run tests | Automated | `verify-runner`, `TestResults` |
| 12 | Inspect failed tests | Automated | `verify-runner`, `TestResults` (failure output shown and fed back to the agent) |
| 13 | Create a Git checkpoint | Partial | File snapshots per run with Undo (`connect`, `find-replace`); no git-based checkpoint |
| 14 | Restore a checkpoint | Automated (file snapshots) | `undo-run` in `connect`, `find-replace` |
| 15 | Create and invoke a skill | Automated | `skills`, `composer` (`/skill-name`) |
| 16 | Connect a local MCP server | Automated | `user-mcp`, `UserMcpServers`: a real stdio server is added, approved and tested |
| 17 | Invoke an MCP tool | Automated | `user-mcp`: a run calls the server's tool and the result reaches the model; `mcp` for catalog servers |
| 18 | Run a subagent | Automated | Build Team hand-offs: `handoff`, `TeamPanel` |
| 19 | Search project memory | Automated | `memory-recall`, `MemoryPanel` |
| 20 | Generate architecture diagrams | Automated | `architecture`, `LiveArchitecture`, `flowchart` |
| 21 | Run Project Health | Partial | The project's own checks run (`verify-*`); no health score or dependency audit |
| 22 | Run Project Rescue | Not built | |
| 23 | Test a website using Playwright | Not built | Only the Playwright MCP catalog entry exists |
| 24 | Test an API through API Lab | Not built | |
| 25 | Export and reimport a project | Not built | No ZIP export or import |
| 26 | Activate Offline Mode | Automated | `offline-mode`, `PrivacySettings` |
| 27 | Verify that no external AI requests occur in Offline Mode | Automated | `offline-mode`: with the fetch replaced by a recorder, runs, connection tests and sign-ins against internet providers make zero requests |
| 28 | Restart Sketch and verify persistent data | Automated | `ideState` (window state); `memory` and `store` (engine JSONL); `offline-mode` (the switch is re-read from disk) |

More than one local model was not tested: no model runtime is installed on this PC.
