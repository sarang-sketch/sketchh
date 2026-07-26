# Rules

These rules govern how every AI agent and human developer working on Sketch must behave. They exist to keep the codebase clean, the product focused, and the AI agents from going off-track.

---

## Rule 1 — Read Before You Act

Before starting any task, an AI agent must read:
1. `what-we-are-building.md` — confirm the task is in scope
2. `what-not-we-are-building.md` — confirm the task is not explicitly excluded
3. `tasks-executed.md` — confirm the task has not already been done
4. The relevant section of `architecture.md` or `trd.md` for the area being changed

If any of these files say the task is out of scope or already done, stop and ask the user to clarify.

---

## Rule 2 — One Task at a Time

- Complete one task fully before starting the next
- Do not partially implement multiple features simultaneously
- A task is only complete when: code written + lint passes + type-check passes + tests pass + build succeeds
- Mark the task as ✅ in `tasks-executed.md` only after all checks pass

---

## Rule 3 — Never Break the Verify Loop

The verify loop is the core product differentiator. It must never be:
- Skipped to save time
- Disabled for convenience
- Bypassed with `// eslint-disable` or `@ts-ignore` without a documented reason
- Marked as passing when it is not

If the verify loop cannot pass, the task is not done.

---

## Rule 4 — No Scope Creep

If a task requires building something listed in `what-not-we-are-building.md`, stop immediately. Do not build it. Do not work around it. Ask the user whether the scope has changed.

Examples of things that must never appear in v1 code:
- Multi-model consensus logic
- Sketch cloud API calls
- Sketch account/auth system
- Skills marketplace backend
- Collaborative editing

---

## Rule 5 — Provider Adapters Are Isolated

Each provider adapter must:
- Implement the `ProviderAdapter` interface exactly as defined in `trd.md`
- Never import from another provider's adapter
- Never store credentials in memory beyond the current request
- Never log API keys, tokens, or credentials at any level
- Fail gracefully with a user-readable error if the API key is missing or invalid

---

## Rule 6 — Credentials Are Sacred

- API keys are stored only via `keytar` (OS keychain)
- API keys never appear in: logs, error messages, IPC messages, git commits, console output
- If a credential is accidentally logged, treat it as a security incident: rotate the key, scrub the log
- No `.env` files with real credentials are ever committed

---

## Rule 7 — Context Engine Must Respect .gitignore

The repo indexer must:
- Always read and respect `.gitignore` before walking the file tree
- Never index `node_modules/`, `dist/`, `.git/`, or build output directories
- Never send binary files to the model
- Never send files larger than 1 MB to the model without chunking

---

## Rule 8 — File Writes Are Scoped

AI agents may only write files:
- Inside the currently open project directory
- That were explicitly planned in the current task's step list
- After showing the user a diff (unless the user has enabled auto-apply)

AI agents must never:
- Write outside the project directory
- Delete files without explicit user confirmation
- Overwrite files that were not part of the current task

---

## Rule 9 — Update tasks-executed.md

After every completed task:
- Mark the task ✅ in `tasks-executed.md`
- Add a row to the Decision Log if an architectural decision was made
- If a new task was discovered during implementation, add it as ⏳ in the correct milestone

This file is the single source of truth for what has been built.

---

## Rule 10 — Match the Codebase Style

- Match the existing code's naming conventions, comment density, and file structure
- Do not introduce a new pattern without updating `architecture.md`
- Do not add a new dependency without checking if an existing one covers the need
- TypeScript: strict mode always on, no `any` without a comment explaining why

---

## Rule 11 — Tests Are Not Optional

For every new feature:
- Unit tests for pure functions and adapters
- Integration tests for the verify loop and orchestrator state machine
- Tests must be in the same language and framework as the rest of the project
- A feature with no tests is not complete

---

## Rule 12 — Performance Targets Are Hard Limits

From `trd.md`:
- App cold start: < 3s
- Project index (10k files): < 10s
- Context retrieval: < 500ms
- Memory at idle: < 500 MB

If a change causes any of these to regress, it must be fixed before merging.

---

## Rule 13 — No Telemetry Without Explicit Opt-In

- No analytics, crash reporting, or usage tracking in v1
- No calls to any Sketch-owned server
- No third-party tracking SDKs
- If telemetry is added in v2+, it must be: opt-in, documented, and off by default

---

## Rule 14 — AI Agents Must Explain Diffs

Before applying any file change, the agent must:
- Show the user what files will be changed
- Show a summary of what will change in each file
- Wait for confirmation unless the user has explicitly enabled auto-apply mode

---

## Rule 15 — When in Doubt, Ask

If a task is ambiguous, the agent must ask the user to clarify rather than:
- Guessing and implementing the wrong thing
- Implementing the largest possible interpretation of the task
- Skipping the ambiguous part silently

One clarifying question is always better than hours of wrong implementation.

---

## Quick Reference for AI Agents

```
Before starting:  Read rules 1, 2
While coding:     Follow rules 5, 6, 7, 8, 10, 11
Before finishing: Follow rules 2, 3, 9, 12
Always:           Follow rules 4, 13, 14, 15
```
