# Security model

Sketch runs an AI agent that reads and changes code and runs programs on the user's computer. This page states what it protects against, how, and what it does not protect against. How to report a vulnerability: `SECURITY.md`.

## What is trusted

- **The user**, and files in the user's home that configure Sketch (`~/.sketch/`).
- **Not trusted:** the model's output, every file in a project (a cloned repository can contain prompt injections), tool and MCP results, web content, and project-level configuration such as `<project>/.sketch/mcp.json`.

## Boundaries

| Threat | Defence | Where |
|---|---|---|
| The agent writes outside the project | Real-path containment; links that lead out are refused | `core/orchestrator/file-writer.ts`, `core/loop/edits.ts`, Rust command policy |
| The agent plants code that runs later through git | `.git/` cannot be written (hooks, config) | `core/tools/protectedPaths.ts` |
| The agent rewrites the record of what it did, or approves its own skill | `.sketch/events`, snapshots, memory and skill grants cannot be written | `core/tools/protectedPaths.ts` |
| Secrets reach the model provider | `.env` files and private keys cannot be read or returned by search; key-shaped strings are scrubbed from events, engine responses and saved chats | `core/tools/protectedPaths.ts`, `core/secrets/`, `core/events/redact.ts`, `scrubSecrets` |
| A command does more than it says | No shell: argv only; pipes, `&&`, redirects and substitutions refused; destructive or outward commands classified and asked about even in Auto mode | `core/tools/command.ts` |
| A command runs without the user knowing | Agent mode asks for every command; the user's own terminal needs `confirmed: true` to start | `core/rpc/methods.ts` (`parseApproval`), `term-start` |
| A tool is called without permission | One dispatcher checks the run's capability grant for every call | `core/capabilities/guard.ts` |
| A cloned project starts an MCP server | Project servers start only after the user approves the exact launch (hash includes environment values) | `core/mcp/userServers.ts` |
| Code or prompts leave the machine unexpectedly | The engine contacts only the selected provider; Offline Mode refuses every non-local request and records all requests | `core/privacy/offline.ts`, `PRIVACY.md` |
| Keys stored in plain text | Keys live in the OS credential store; provider settings are key-free | `src-tauri/src/secret_store.rs`, `os_credentials.rs` |
| Unrecoverable edits | Every auto-applied run is journalled and can be undone; Review mode applies nothing until accepted | `core/orchestrator/file-writer.ts`, `undo-run` |
| A model invents success | "Done" counts only when the configured checks passed; the engine runs them | `core/loop/agent.ts`, `core/verify/` |
| Raw HTML or script injection in the window | Markdown is rendered by Sketch's own renderer without raw HTML | `desk/components/Markdown.tsx` |

Every refusal, approval and tool call is an event in the project's append-only log.

## What it does not protect against

- **Commands run with the user's rights.** The classifier is a seatbelt, not a sandbox: a command that passes it, or that the user allows, can do anything the user can. There is no container or OS sandbox.
- **Verification commands come from the project.** `verify.yaml` and `package.json` scripts decide what "checks" run, and the agent can edit those files like any other. Changes show up in the diff and in Undo; review them.
- **Your own MCP servers** run as you, with your network access. Offline Mode does not start them.
- **Programs started outside the engine** (your terminal, project scripts) are not covered by Offline Mode's network guard.
- **Chats in local storage** are plain text apart from scrubbed key shapes; anyone with access to the user profile can read them.
- **Third-party MCP packages** in the curated catalog are pinned by version but not audited by this project.
- **The Windows installer is not code-signed.**

## Reporting

See `SECURITY.md` for the reporting address and what is in scope.
