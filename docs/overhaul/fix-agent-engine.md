# W5 — The agent engine: Ask/Agent/Auto, approvals, completion honesty, cancellation, recovery, history

Item W5 of the Sketch IDE overhaul. Inputs read first (as leads, not facts): `docs/BUG_AUDIT.md`
(B-003, B-004), `docs/ARCHITECTURE_REVIEW.md` §5(b)/§5(c), and `docs/overhaul/fix-workspace-paths.md`
(W2 — whose run-root rule I kept intact). This document is the whole record: for each invariant,
the behaviour before with evidence, the root cause with `file:line`, the fix and why it is neither a
suppression nor a security relaxation, and the proof after (test names plus the event-log lines from
real end-to-end runs). Then every test and typecheck command with its result, including the mutation
checks; the files changed; dependencies (none); and the remaining limitations.

Repo root: `C:\Users\saran\Downloads\sketch`. All anchors are `file:line` at that root. No API key was
used or needed: every run drove the engine's fake provider or a local scripted OpenAI-compatible
server on `127.0.0.1`. No tracked file outside the W5 ownership list was changed; the ~120
pre-existing dirty files in the worktree were left as they were; nothing was committed, pushed,
stashed, reset, or reverted.

---

## 1. What the owner asked, as it applies to W5

Make the agent engine behave like a reliable tool: the three modes mean what the UI says they mean,
a command never runs without permission in Agent mode, a run that says "done" has actually done it,
a Stop truly stops, an error ends cleanly and the next message works, and the run's history matches
what really happened. The single defect the owner named — "the agent must not report that a task was
completed if its changes were not successfully applied" — is invariant 1, and it was real (B-003).

---

## 2. Summary of findings

Of the six invariants the item lists, **two had real defects and are fixed here** — completion
honesty (invariant 1, B-003) and the tool-path half of mode enforcement (invariant 2: Ask mode used
the loaded skills' full grant for its tool layer, so a write-capable MCP tool could run). The other
four were already enforced and tested in the shipped engine; I verified each against the real code and
the real RPC rather than assuming, and added end-to-end coverage where it was thin.

| Invariant | State found | Action |
|---|---|---|
| 1. Completion honesty | **BROKEN** (B-003): `done` reported ok over failed edits | **Fixed** in `loop/agent.ts`; new engine + e2e tests |
| 2. Modes enforced by the engine | Edit path enforced; **tool path was a gap** — Ask used the skills' full grant | **Fixed** in `methods.ts`/`vocabulary.ts` (read-only grant); new tests + e2e scenario E |
| 3. Command approval | Enforced (`commandApprover` + `run_command` approver) | Verified; added e2e denial proof |
| 4. Cancellation | Enforced (abort → provider/stream/command tree, `hardKill` `taskkill /T /F`) | Verified; added e2e process-tree-kill proof |
| 5. Recovery | Enforced (single latched `finish`, redacted provider errors, `reply`/retry) | Verified (existing `cancel`/loop tests) |
| 6. History / B-004 | Enforced (event log; `runSummary`; `AUTO_CONTINUE_LIMIT = 2` shown as continued runs) | Verified; surfaced the new edit outcome in the receipt |

Because the approval/cancel/recovery/history paths were already correct and tested, the right
engineering call was to **leave them unchanged** (owner rule 1: do not rebuild working features) and
spend the budget on the two real defects plus the end-to-end proof that the whole set holds against
the shipped build.

---

## 3. Invariant 1 — completion honesty (B-003): the fix

### 3.1 Behaviour before (evidence)

In `packages/core/src/loop/agent.ts`, the `done` action called `finish(verifyOk(), …)`. `verifyOk()`
answers one question only — did verification pass — and for a task with **no** verify policy and an
empty `task.verify` it returns `true` unconditionally:

```ts
// loop/agent.ts, verifyOk() — before
const verifyOk = (): boolean => {
  if (hasPolicy) return verifyState.policy !== null && verifyState.policy.ok
  if (task.verify.length === 0) return true      // ← "nothing to verify" ⇒ ok
  if (lastVerify.length !== task.verify.length) return false
  return lastVerify.every((r) => r.ok)
}
```

The `edit` action recorded each failed edit as an `edit_rejected` event and fed the refusal back to
the model, but **set no run-level failure flag** (the edit-rejection path around the former `:949–984`).
So this sequence reported success:

1. model plans, then sends an `edit` whose `search` string is not in the file;
2. `prepareEdit` fails → `edit_rejected`, nothing written;
3. model sends `done` → `finish(verifyOk(), …)` = `finish(true, …)` → `run_completed`, `ok: true`,
   final text "All set, app.txt updated."

A run that changed nothing reported a clean success — exactly the silent failure the owner reported.

### 3.2 Root cause (`file:line`)

`packages/core/src/loop/agent.ts`:

- `verifyOk()` (around `:596`) is about verification alone and has no knowledge of edit outcomes.
- the `done` action (around `:1146`) passed `verifyOk()` straight to `finish` as the whole verdict.
- the apply path (around `:995–1010`) and the prepare-failure path (around `:975`) emitted
  `edit_rejected` but did not accumulate a run-level record of what landed and what did not.

The verdict was computed from the wrong half of the run's facts.

### 3.3 The fix

No dependency added. No security check weakened. No error hidden. The change is that **"done" is now
checked against what the run's apply-mode edits actually did, not only against verification.**

**(a) The run keeps an honest record of its apply-mode edits** (new state near the other run `let`s,
around `:541`):

```ts
const appliedPaths: string[] = []                       // deduped, insertion order
const failedEdits: Array<{ path: string; reason: string }> = []
const noteApplied = (path) => { if (!appliedPaths.includes(path)) appliedPaths.push(path) }
const noteFailed  = (path, reason) => { failedEdits.push({ path, reason }) }
```

Both the prepare-failure branch and the apply-failure branch call `noteFailed`; a successful write
calls `noteApplied`. What is counted is deliberate:

- an edit the run **tried to apply and could not** (search not found, path refused, write threw) is a
  failure — in Agent/Auto **and** in review mode, because in review mode it could not even become a
  proposal for a human to see;
- a **review-mode proposal** that prepared cleanly is neither applied nor failed — it is pending by
  design, and "done" there means "I have proposed";
- an **Ask-mode or plan-gate refusal** is not counted — those runs were never allowed to edit, so a
  refusal is the mode working, not a failure.

**(b) The verdict at `done` uses both gates** (around `:1146`):

```ts
const netFailures = failedEdits.filter((f) => !appliedPaths.includes(f.path))  // fixed-later ⇒ not a failure
const everyEditFailed = appliedPaths.length === 0 && netFailures.length > 0
const editsOk = netFailures.length === 0
if (!verifyRan && hasVerification) await runVerify()
const ok = verifyOk() && editsOk
```

`netFailures` subtracts any path a **later** edit successfully wrote, so a model that fails an edit,
re-reads the file and fixes it is not punished for the first attempt.

**(c) The user reads the truth, and the model's "done" text cannot stand over failed edits:**

```ts
const finalText = editsOk
  ? modelText
  : everyEditFailed
    ? `No changes were applied — every edit failed:\n${failureList}`
    : `${modelText}\n\nPARTIAL: these edits did not apply, so the change is incomplete:\n${failureList}`
```

**(d) The terminal event carries the accounting, backward-compatibly** (`payload` is
`Record<string, unknown>`, so old logs still load):

```ts
return finish(ok, finalText, {
  reason: ok ? 'done' : everyEditFailed ? 'edits_failed' : netFailures.length > 0 ? 'edits_partial' : 'verify_failed',
  editsApplied: appliedPaths.length,
  editsFailed: netFailures.length,
  ...(netFailures.length > 0 ? { failedEdits: netFailures } : {}),
  … (existing verifiedStages / policy payload unchanged) …
})
```

This is a verdict change, not a suppression (the edits still fail and are still logged) and not a
relaxation (nothing that was refused is now allowed). Edits outrank a green verify: a run that failed
to apply its change is not a success even if the project's checks happen to pass against the unchanged
code.

**(e) The desktop surface shows it in plain words.** Because the engine now returns `ok: false` and
the honest `finalText`, `AgentSession` already renders the true outcome and the `ok=false` styling
with no change. In addition:

- `packages/desktop/src/lib/runSummary.ts` — `receiptFor` reads `editsApplied`/`editsFailed` from the
  terminal event into `RunReceipt.edits`; the `REASONS` map names `edits_failed`
  ("No changes were applied — every edit failed.") and `edits_partial` ("Some edits did not apply —
  the change is incomplete.") so `stepFor(run_failed)` shows them.
- `packages/desktop/src/state/AppState.tsx` — `RunReceipt` gained an optional `edits` field (absent on
  an old log).

I deliberately did **not** add a second outcome line to `AgentChat.tsx`: the honest `finalText`
(rendered as Markdown) plus the `run_failed` step line plus the receipt already state the outcome, and
the receipt line component itself lives under `components/**` (W3's shell), which W5 does not touch.

### 3.4 Proof after

Engine unit tests — `packages/core/test/loop.test.ts`, describe
*'completion honesty: "done" cannot report success over edits that did not land (B-003)'* (6 cases):

- every edit failed, no verify → `ok: false`, terminal `run_failed{reason: edits_failed}`,
  `editsApplied: 0 / editsFailed: 1`, file untouched, `finalText` contains "No changes were applied"
  and not the model's "done" text;
- some edits failed → `edits_partial`, the good edit landed and the bad one did not, `finalText`
  keeps the model summary and appends "PARTIAL" + the failed path only;
- an edit that failed once then was fixed → `run_completed{done}`, `editsFailed: 0`;
- a clean applied edit + passing verify → still a success;
- a failed edit with **passing** verify → still `edits_failed` (edits outrank a green verify);
- review mode → a prepared proposal is not a failure, but an unpreparable edit is (`editsFailed: 1`).

End-to-end over the **real JSON-line RPC** against the built `packages/core/dist/cli.js` — script
`packages/core/scripts/w5-e2e-rpc.mjs`, scenario A, with a local scripted OpenAI-compatible model.
The terminal event line captured from the engine's own stdout:

```json
{"taskId":"t","ok":false,"iterations":3,"verify":[],"reason":"edits_failed","verifiedStages":0,
 "editsApplied":0,"editsFailed":1,
 "failedEdits":[{"path":"app.txt","reason":"search string not found in app.txt; the file was left unchanged. Read the current content and send an exact substring."}]}
```

and `run.result.finalText` began "No changes were applied — every edit failed:" with `ran` nowhere in
it. The file on disk still read `original\n`.

Desktop — `packages/desktop/src/chat-ui.test.tsx`, describe *'the run summary surfaces the engine
completion-honesty verdict (B-003)'* (4 cases): `receiptFor` lifts `edits` from the terminal event,
leaves it absent for an old log, and `stepFor` names both outcomes.

---

## 4. Invariant 2 — modes enforced by the engine, not only the UI

The seed says Ask "writes no file through any tool path (edits, commands, MCP, skills)." The edit
path was already enforced; the **tool path was a real gap** (found in review, round 2), and this
section now covers both.

### 4.1 The edit path (was already correct — verified, not assumed)
The mode options are built in `packages/desktop/src/lib/AgentSession.tsx` `modeRunOptions` (around
`:109`): `ask` ⇒ `{ readOnly: true, reviewEdits: false }` with no command tool; `agent` ⇒
`{ commands: 'ask', reviewEdits: !autoApply }`; `auto` ⇒ `{ commands: 'auto', autonomous: true,
maxIterations ≥ 50 }`. The **engine** honours each:

- **Ask is read-only in the engine.** `loop/agent.ts` refuses every `edit` with `READ_ONLY_REASON`
  before the plan gate and before any byte is read (the `edit` case, `readOnly === true`). The RPC
  `run` handler ignores `commands` entirely when `readOnly` is set (`methods.ts`:
  `const commandMode = readOnly ? undefined : readCommandMode(params)`), so Ask mode cannot run a
  program through `run_command` either.
- **Auto runs autonomously within its iteration limit** and answers the model's own questions with
  `AUTONOMOUS_ANSWER` instead of ending the run.

Proof (edit path): existing `packages/core/test/agent-modes.test.ts` *'Ask mode is read-only in the
engine'* and the Auto-mode suite; E2E scenario C (`w5-e2e-rpc.mjs`) drives a real `readOnly: true`
run over the RPC, and the captured `edit_rejected` reason was
`this run is read-only (Ask mode): files cannot be changed…` with `app.txt` untouched.

### 4.2 The tool path — the gap (before, with the mechanism)

`readOnly` was enforced on the edit action and in the prompt, but `rpc/methods.ts` `run()` still built
the tool layer with the **skills' full grant** in Ask mode: `openToolLayerFor(root, …, granted, …)`
with `dispatcherGrant = granted`. The capability guard (`capabilities/guard.ts`) only checks the
grant, so if a loaded skill's grant included `fs:write:project`, `git:write`, or `proc:spawn`, an Ask
run could launch a write-capable MCP server and call its write tool — a **second write path the edit
gate never touched**. There are in fact THREE places the full grant leaked into Ask mode's tool layer:

1. the launch grant and `dispatcherGrant` passed to `openToolLayerFor` (around `methods.ts:995`);
2. inside `openToolLayerFor`, a user MCP server is **re-granted `proc:spawn`** unconditionally
   (`const dispatcherGrant = userServers.length > 0 ? [...baseGrant, 'proc:spawn'] : baseGrant`,
   around `methods.ts:1273`) — this is the one that actually let a write through in the first draft
   of the test;
3. the workflow and strategy sub-run grants (`executeRegisteredAgent(… granted …)` and
   `dispatch(…, { grant: granted })`).

### 4.3 The fix

No dependency added, no security check weakened, no error hidden. Ask mode's grant is narrowed to an
**allowlist of read capabilities** — a denylist would silently allow a future write-shaped capability
until someone banned it.

- **`packages/core/src/capabilities/vocabulary.ts`** — new `READ_ONLY_CAPABILITIES`
  (`fs:read:project`, `fs:read:home`, `net:http`, `net:localhost`, `secrets:read`, `git:read`) and
  `readOnlyGrant(granted)`, which returns the subset of a grant that is on that allowlist, in
  canonical order. `fs:write:*`, `git:write` and `proc:spawn` are all absent, so an Ask run holds no
  write-shaped capability. Re-exported from `capabilities/index.ts`.
- **`packages/core/src/rpc/methods.ts` `run()`** — `const launchGrant = readOnly ?
  readOnlyGrant(granted) : granted`, used for BOTH the MCP launch grant and the `dispatcherGrant`,
  and for the workflow/strategy sub-run grants. Agent and Auto pass `granted` exactly as before.
- **`openToolLayerFor`** takes a new `readOnly` flag: in a read-only run it does NOT re-grant
  `proc:spawn` for user servers, and it does NOT start a user server at all (a user server runs a
  program, which Ask mode may not). So a write-capable server is **not started**, and any write tool
  the model names is refused by the one guard with the refusal fed back to the model.

The containment itself is unchanged — nothing that was refused before is now allowed, and the guard is
still the single enforcement point. This only removes capabilities from a run that, by the user's own
choice of Ask mode, should never have held them.

### 4.4 Proof after

Engine — `packages/core/test/ask-readonly-tools.test.ts` (6 cases):
- `readOnlyGrant` keeps only reads and drops every write/spawn capability (and is empty for a
  write-only grant);
- the guard **allows** a `fs:write:project` tool under the full grant (the behaviour the fix changes)
  and **refuses** it under `readOnlyGrant`, as a `capability_denied` result (not a throw), and does
  not even offer it to the model;
- end-to-end through `METHODS.run` with a **real stdio MCP server** whose tool writes a file, plus a
  skill granting `fs:read:project, fs:write:project, proc:spawn`: in **Agent** mode the tool runs and
  the file is created (the setup works); in **Ask** mode the write tool call is refused
  (`tool_denied`) and the file is **never created**.

End-to-end over the real RPC — `w5-e2e-rpc.mjs` **scenario E**: the same shape against the built
`dist/cli.js`. Agent mode wrote the file; Ask mode did not, and the captured refusal was:

```json
{"skill":"writer-skill","granted":[],"name":"user-writer.write_file","reason":"unknown_tool",
 "detail":"TOOL DENIED (user-writer.write_file) — no such tool. Available: git-branch, git-commit, git-diff, git-stage, git-status, git-unstage."}
```

The narrowed grant was `[]` (the skill's only capabilities were write/spawn, all stripped), so the
write server was not started and the tool was unreachable.

Mutation check (non-vacuity): dropping the Ask-mode narrowing in `openToolLayerFor` (both the
`&& extra.readOnly !== true` guard on the `proc:spawn` re-grant and the user-server launch skip) made
the Ask test's *'the write tool call is refused and the file is never created'* case FAIL — the file
was written. Restored → pass.

### 4.5 `run_command` in Agent/Auto (unchanged, verified)
`run_command` costs `proc:spawn`, which no skill grant holds by default; `methods.ts` adds it to the
dispatcher grant only when the human enabled commands (`commandMode` set, never in Ask mode). The
capability guard refuses a forbidden tool and returns the refusal as a result the model is shown,
never a throw. Covered by existing `agent-modes.test.ts` *'…has no command tool at all unless the
caller enabled commands'*.

---

## 5. Invariant 3 — command approval

### Before / root cause check
`methods.ts` `commandApprover` puts every command to the human over the same `ask` channel, emitting
an `ask` event carrying an `approval` object and recording the decision as `ask_answered`
(`approval.decision`). `tools/command.ts` `run_command` calls the approver when the command needs a
human (always in `ask` mode, or a risky command in `auto`); a `deny` returns a result telling the
model it was denied and not to retry, and when **nobody can answer** (no approver) the command is
refused outright. A pending approval is bounded (`ASK_REPLY_TIMEOUT_MS = 600_000`,
`AUTO_APPROVAL_TIMEOUT_MS = 120_000`) and a timeout settles as a denial, so a run never hangs forever;
cancelling while one is pending aborts the wait.

### Proof
Existing `agent-modes.test.ts`: *'Agent mode asks before every command'* (denied → not run; allowed →
run; headless → refused). E2E scenario B (`w5-e2e-rpc.mjs`): a real Agent-mode run asked for approval,
I replied `no` over the RPC, and the captured `ask_answered` payload was `…"decision":"deny"…`; the
marker file the command would have written never appeared, and the run still finished.

---

## 6. Invariant 4 — cancellation

### Before / root cause check
`methods.ts` holds one `AbortController` per in-flight run in `inFlightRuns`, keyed by the caller's
run id so a Stop works before `run_started` arrives; `cancel` aborts it and does **not** fabricate a
terminal event (the run writes its own). The signal reaches: the provider request/stream (the adapter
is handed `{ signal }`); any running command (`tools/command.ts` passes `context.signal` to
`runCommand`); and all further edits (the loop checks `signal?.aborted` at the top of each iteration).
`verify/runner.ts` `hardKill` takes down the **whole tree** on Windows with `taskkill /PID <pid> /T /F`
(SIGKILL fallback on POSIX), and the aborted command resolves a failing result rather than leaving a
half-written file — the apply path is never reached after an abort. The run ends `run_failed{reason:
aborted}`, and the id is freed in `finally`, so a new run starts straight after.

### Proof
Existing `packages/core/test/cancel.test.ts` (4 cases): aborts an in-flight run and the run records
`aborted`; honest "nothing to cancel"; refuses a malformed id; refuses a second run under a live id and
frees it afterwards. E2E scenario D (`w5-e2e-rpc.mjs`) closes the gap the brief named — a real long
command (`node -e "…writeFileSync(pid); setTimeout(…,60000)"`): after `cancel`, the terminal event was
`{"ok":false,"reason":"aborted"}`, the child process tree was **gone** (`process.kill(pid, 0)` threw),
and a fresh run started on the same engine immediately after.

---

## 7. Invariant 5 — recovery

### Verified
`loop/agent.ts` has exactly one exit, `#finish`, latched so it cannot double-emit; every failure mode
(adapter throw, abort, iteration exhaustion, internal error, now edit failure) funnels through it with
a specific `reason`. A provider error is redacted with the shared provider redactor before it reaches
the log and becomes `run_failed{reason: provider_error}`, not an unhandled rejection. The next message
is a new run on the same engine (proved incidentally by scenario D's post-cancel run and by
`cancel.test.ts`'s id-reuse case). `reply` re-runs the same request path; retry is a new `run` with the
same prompt.

---

## 8. Invariant 6 — multi-step history and B-004

### Verified
The event log records each step (`plan_written`, `edit_proposed`/`edit_accepted`/`edit_rejected`,
`verify_started`/`verify_result`, `tool_called`, and the terminal event), and the desktop's run
summary is a pure projection of it (`packages/desktop/src/lib/runSummary.ts`: `stepsFor`,
`changedFiles`, `receiptFor`) — nothing invented. Auto mode's auto-continue is visible: `AgentSession`
posts a system line "Reached the turn limit; continuing automatically (n of 2)." and starts a visible
continued run, bounded by `AUTO_CONTINUE_LIMIT = 2`. B-004 (honest per-message model-call count):
`receiptFor` counts `llm_response` events per run, so each message's receipt reports the real number of
model calls and tokens; the new `edits` field now rides the same receipt. I did not touch token
accounting or cost code (a later item owns those).

---

## 9. Files modified

| File | Change | In W5 list? |
|---|---|---|
| `packages/core/src/loop/agent.ts` | Run-level edit-outcome tracking (`appliedPaths`/`failedEdits`); `done` verdict = `verifyOk() && editsOk`; honest `finalText`; `editsApplied`/`editsFailed`/`failedEdits` + `edits_failed`/`edits_partial` reasons on the terminal event (backward compatible). | yes (`loop/**`) |
| `packages/core/test/loop.test.ts` | New describe: completion honesty (6 cases). | yes (tests) |
| `packages/core/test/agent-modes.test.ts` | New describe: completion honesty end-to-end through `run` (3 cases). | yes (tests) |
| `packages/core/src/capabilities/vocabulary.ts` | New `READ_ONLY_CAPABILITIES` allowlist + `readOnlyGrant()` (invariant 2 tool path). | yes (`capabilities/**`) |
| `packages/core/src/capabilities/index.ts` | Re-export `READ_ONLY_CAPABILITIES` and `readOnlyGrant`. | yes (`capabilities/**`) |
| `packages/core/src/rpc/methods.ts` | `run()` narrows the tool-layer launch + dispatcher + sub-run grants to the read-only allowlist in Ask mode; `openToolLayerFor` gains a `readOnly` flag that stops re-granting `proc:spawn` and stops starting a user MCP server. Agent/Auto unchanged. | yes (`rpc/methods.ts` run handler) |
| `packages/core/test/ask-readonly-tools.test.ts` | **New.** Invariant 2 tool path: `readOnlyGrant` + guard refusal + end-to-end Agent-writes / Ask-refuses against a real MCP write server (6 cases). | yes (tests) |
| `packages/desktop/src/lib/runSummary.ts` | `receiptFor` lifts the edit outcome into `RunReceipt.edits`; `REASONS` names `edits_failed`/`edits_partial`. | yes (`runSummary.ts`) |
| `packages/desktop/src/state/AppState.tsx` | `RunReceipt` gained an optional `edits` field. | **No — outside the list.** One additive field needed to carry the engine outcome to the receipt; no behaviour change. Flagged here and accepted by the lead. |
| `packages/desktop/src/chat-ui.test.tsx` | New describe: the run summary surfaces the honesty verdict (4 cases). | yes (tests for owned files) |
| `packages/core/scripts/w5-e2e-rpc.mjs` | **New.** End-to-end driver over the real JSON-line RPC with a local scripted model (scenarios A–E). Tracked path, not under `dist/`/`build/`. | yes (a script) |

`AgentSession.tsx`, `AgentChat.tsx`, `rpc/server.ts`, `orchestrator/**`, `verify/**` were **read and
verified** but needed no change — their invariants already held. W2's run-root logic in
`AgentSession.tsx`/`Composer.tsx` was not touched.

**Dependencies added: none.** **Mock data introduced: none.** **Security checks weakened: none.**

---

## 10. Tests, typecheck, and mutation checks (every command + result)

Each typecheck/test ran in a **later step** than the edits it checks. `--maxWorkers=1` is unusable on
vitest 2.1.9 here, so serial execution was forced with
`--pool=forks --poolOptions.forks.singleFork=true`. Desktop tests import `@sketch/core` from its built
`dist`, so `npm run build -w @sketch/core` ran before the desktop tests.

### 10.1 Engine typecheck
```
cd packages/core && npx tsc --noEmit          → exit 0, no errors
```

### 10.2 Engine unit / integration (vitest)
```
cd packages/core
npx vitest run test/loop.test.ts        --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 1 passed;  Tests 40 passed  (33 pre-existing + 7 new honesty)
npx vitest run test/agent-modes.test.ts --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 1 passed;  Tests 27 passed  (24 pre-existing + 3 new e2e)
npx vitest run test/cancel.test.ts test/verify-policy.test.ts test/verify-runner.test.ts --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 3 passed;  Tests 56 passed  (cancel 4, verify-policy 36, verify-runner 16) — no regression
npx vitest run test/ask-readonly-tools.test.ts --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 1 passed;  Tests 6 passed   (invariant 2 tool path: readOnlyGrant, guard, e2e MCP write)
# regression sweep over everything the capability/grant change touches:
npx vitest run test/ask-readonly-tools.test.ts test/agent-modes.test.ts test/loop.test.ts test/user-mcp.test.ts test/mcp.test.ts test/capabilities.test.ts --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 6 passed;  Tests 145 passed  — no regression in the MCP / user-server / capability suites
```

### 10.3 Engine build (so the e2e + desktop tests see the change)
```
npm run build -w @sketch/core                 → exit 0  (tsc -p tsconfig.build.json)
```

### 10.4 End-to-end over the real RPC
```
node packages/core/scripts/w5-e2e-rpc.mjs     → exit 0,  "W5 E2E: ALL PASS"
```
23 checks across scenarios A (completion honesty), B (approval denied), C (Ask read-only edit),
D (cancel → process tree gone → restart), and E (Ask cannot reach a write-capable MCP tool). The
terminal-event / `ask_answered` / `edit_rejected` / `tool_denied` lines each scenario prints are the
evidence quoted in §3.4, §4.4, §5, §6.

### 10.5 Desktop typecheck
```
cd packages/desktop && npx tsc --noEmit        → exit 0, no errors
```

### 10.6 Desktop unit (vitest)
```
cd packages/desktop
npx vitest run src/chat-ui.test.tsx --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 1 passed;  Tests 15 passed  (11 pre-existing + 4 new)
npx vitest run src/panels/agent/AgentChat.test.tsx src/panels/agent/AgentSession.runRoot.test.tsx src/composer.test.tsx --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 3 passed;  Tests 31 passed  (AgentChat 12, runRoot 3, composer 16) — W2's run-root tests still green
```

### 10.7 Mutation checks (proving the new tests are not vacuous)
Each mutation was applied, the relevant tests run, then the code restored and re-run green.

- **Verdict mutation (invariant 1).** In `loop/agent.ts`, changing `const ok = verifyOk() && editsOk`
  to `const ok = verifyOk()` made **4** honesty cases FAIL (every-edit-failed, partial,
  verify-passes-but-edit-failed, review-mode) — each asserting `result.ok === false`. The two cases
  that stay ok either way (fixed-on-second-try, clean success) still passed, which is correct.
  Restored → all pass.
- **Final-text mutation (invariant 1).** Replacing the honest `finalText` with
  `const finalText = modelText` made **3** cases FAIL — the ones asserting `finalText` contains
  "No changes were applied" / "PARTIAL" / the failed path. Restored → all pass.
- **Grant-narrowing mutation (invariant 2).** In `rpc/methods.ts` `openToolLayerFor`, removing the
  Ask-mode narrowing (dropping `&& extra.readOnly !== true` on the `proc:spawn` re-grant and the
  user-server launch skip) made `ask-readonly-tools.test.ts`'s *'the write tool call is refused and
  the file is never created'* case FAIL — the file **was** written. Restored → pass.

---

## 11. Remaining limitations

- **No live CDP screenshot of the honest outcome in the packaged app.** As W2 diagnosed at the
  process level, WebView2 runtime 156 on this host accepts `--remote-debugging-port` but opens no
  DevTools listener, so the packaged UI cannot be driven over CDP. The behaviour is verified against
  the exact engine code by the unit tests and against the **shipped `dist/cli.js`** over the real RPC
  by `w5-e2e-rpc.mjs`; the desktop projection is covered by the vitest suites. On a host whose
  WebView2 honours the port, the QA-build recipe in `fix-workspace-paths.md` §6 drives the UI.
- **POSIX detached grandchildren.** `hardKill` uses `taskkill /T` on Windows (the owner's host) and
  `SIGKILL` on POSIX without a process group, so a command that double-forks a detached grandchild on
  POSIX could orphan it — a pre-existing, documented residual in `verify/runner.ts`, out of W5's
  scope and untouched here.
- **One additive desktop field outside the list** (`RunReceipt.edits` in `AppState.tsx`) was needed to
  carry the engine's verdict into the receipt; it is additive and behaviour-neutral, and is flagged in
  §9 for the lead.
- I did **not** change provider adapters, token accounting, or cost code (a later item owns those),
  and did not edit the shared `components/RunCards` receipt line (W3's shell).

---

## 12. Owner-safety confirmation

Every run used a throwaway `%TEMP%` scratch root and the fake/scripted local provider on `127.0.0.1`;
no real provider key was used, saved, or changed, and nothing left the machine. The engine processes
the e2e script launched were each stopped by the script (by the pid it owned); no `sketch-*`,
`msedgewebview2`, or unrelated `node` process was touched. The owner's installed app, `~/.sketch`, and
the `unicef india` folder were not read or written. No tracked file outside the W5 list was changed
except the single additive `RunReceipt.edits` field noted in §9 and §11.
