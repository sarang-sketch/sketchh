# Implementation roadmap

Order follows the local-first brief: foundation, core development, extensibility, project intelligence, developer tools, productivity. Each milestone is small enough to build and test on its own. M1 to M4 are done (`docs/IMPLEMENTATION_STATUS.md`).

| Milestone | Scope | Done when | Priority |
|---|---|---|---|
| M1 Offline Mode | Switch, network guard, activity list, data locations, clear chats | Done | P0 |
| M2 Local model manager | Ollama status, models, download, remove, load, recommendations | Done | P0 |
| M3 Protected paths | `.git/`, Sketch records, grants, secrets | Done | P0 |
| M4 Your MCP servers (stdio) | Config, approval, test, use in chats | Done | P0 |
| M5 Chat management | Rename, pin, archive; edit a sent message and resend; regenerate; thumbs up / down stored with the message; export to Markdown and JSON, import JSON (secrets scrubbed) | Each action has a reducer test and a sidebar test; an exported file reimports to the same conversation | P1 |
| M6 Hooks | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` from `~/.sketch/hooks.json` and approved project hooks; argv only, timeout, output logged | A `PreToolUse` hook can block a tool call in a run test; an unapproved project hook does not run | P1 |
| M7 Instructions and skills | `SKETCH.md` beside `AGENTS.md`, `~/.sketch/AGENTS.md`, `~/.sketch/skills`, directory rules, 12 default role skills, skill create / edit / delete forms | A run's system prompt includes each source in a test; the default skills install and validate | P1 |
| M8 Project Health | Dependency audit (`npm audit --json`, `pip-audit` when present), outdated packages, large files, complexity from the repository graph, a score with its formula shown, history | Each finding links to its file and the tool output it came from | P1 |
| M9 API Lab and local embeddings | REST requests with history and collections, OpenAPI import; Ollama embeddings (`/api/embed`) for semantic search | A request to a local test server is recorded; search ranks a synonym above an unrelated file with a real embedding model | P1 |
| M10 Git, providers, context | `git init`, stash, merge, conflict view; Hugging Face entry (verify the router URL first); per-chat model; context meter from the model's real context length | Each git action has a real-repository test | P1 |
| M11 Developer tools | UI Doctor (Playwright, only when installed), Project Rescue workflow, Replay restore preview, Learn exercises, daily briefing, split editor, debugger | Each produces evidence from a real tool run, never a mock | P2 |

Rules for every milestone: reuse the existing modules, add no runtime dependency to the engine without a recorded reason, keep secrets out of every file and export, and do not mark a row done until its test fails without the change.
