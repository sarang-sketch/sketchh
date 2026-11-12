# The agent engine

The coding agent is `runTask` in `packages/core/src/loop/agent.ts`, reached through the engine's `run` method.

## One turn, one action

Each model reply is one JSON object (fenced or bare). Seven actions exist (`loop/actions.ts`):

| Action | Effect |
|---|---|
| `plan` | Records the plan (PRD, architecture, schema, tests). No edit is applied before a plan exists |
| `edit` | Exact search/replace edits; an empty `search` writes a whole file |
| `tool` | Calls one granted tool: read, list, search, git, commands, skills, MCP |
| `verify` | Runs the project's configured checks and feeds PASS/FAIL back |
| `think` | Reasoning that changes nothing. Anything unparseable becomes a `think`, so a malformed reply costs a turn instead of failing the run |
| `ask` | A question for the user (answered in the chat, or "use your judgement" in Auto mode) |
| `done` | The final answer. Successful only if every verify stage passed or none is configured |

Because the protocol is plain JSON, any chat model can drive it, including local models without native tool calling. Success is decided by the engine (edits applied, checks passed), never by the model's own claim.

## Tools

| Tool | Cost | Notes |
|---|---|---|
| `read_file`, `list_dir`, `find_files`, `search_code` | `fs:read:project` | Inside the project only; secrets files refused |
| `run_command` | `proc:spawn` | No shell: argument vectors only; pipes, `&&`, redirects and substitutions refused |
| `process_output`, `stop_process` | `proc:spawn` | For `run_command` with `background: true` (dev servers) |
| git tools | `git:read`, `git:write` | Through the same dispatcher |
| `use_skill` | - | Lists installed skills and loads one on demand |
| MCP tools (`<server>.<tool>`) | The server's capability | Catalog servers, and your own servers (`proc:spawn`) |

Every call goes through `ToolDispatcher.call` (`capabilities/guard.ts`), the single point that checks the run's grant.

## Modes the user picks

| Mode | Edits | Commands | Questions |
|---|---|---|---|
| Ask | Refused (read-only) | Not available | Asked |
| Agent | Applied with Undo, or proposed for review | Each one asked first (Allow / Allow always / Deny) | Asked |
| Auto | Applied with Undo | Run without asking, except destructive ones | Answered with "use your judgement" |

## Safety around edits

- **Containment:** a path outside the project, or a link that points outside, is refused (`orchestrator/file-writer.ts`).
- **Protected paths:** `.git/`, Sketch's records, skill grants, `.env` files and private keys cannot be written (`tools/protectedPaths.ts`).
- **Undo:** every auto-applied write is journalled first; `undo-run` restores the files without Git.
- **Review mode:** edits stay as proposals until the user accepts them.

## Verification

`verify/policy.ts` defines nine ordered stages: format, lint, typecheck, build, unit, integration, security, performance, dependency audit. They come from `verify.yaml` or are detected from the project (`package.json` scripts, `tsconfig.json`, Python tooling). A stage the project does not configure does not run, and the engine never reports a check it did not run.

## Budgets, cancellation, recovery

- A per-run budget (calls, tokens, USD) is checked before every model request (`cost/budget.ts`).
- `cancel` (the Stop button) aborts the run through its abort signal, including a model request in flight.
- Provider calls retry 429 and 5xx answers with backoff and honour `Retry-After` (`providers/http.ts`).
- Every step is an event in the project's append-only log; the window streams them as they are written.

## Limits

- Model output arrives one whole turn at a time, not token by token.
- Older conversation turns are dropped, not summarised, when a conversation grows long.
- There is no debugger integration; the agent reads errors from command and check output.
