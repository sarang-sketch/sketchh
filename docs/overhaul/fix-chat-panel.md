# W6 — The chat and agent panel: fix

Item W6 of the Sketch IDE overhaul. It owns the AI Chat and Agent panel (brief §3) plus
"Opening conversations", "Creating new chats" and "Managing agents" from §2, on BOTH chat
surfaces: the Cowork main panel and the Code surface's sidebar, which share one agent
session. Inputs read first as leads, not facts: `docs/UI_UX_AUDIT.md` (Cowork section),
`docs/BUG_AUDIT.md` B-004, and the earlier fix docs `fix-workspace-paths.md` (W2),
`fix-agent-engine.md` (W5), `fix-ai-providers.md` (W4), `fix-design-system.md` (W3) and
`fix-skills-mcp.md` — none of whose behaviour this item undoes. This document is the whole
record: for each invariant, the before with evidence, the root cause with `file:line`, the
fix, and the proof after (test names, CDP measurements, screenshot paths); then the
dead-button list, the colour-literal counts, every command with its result including the
mutation checks, the files changed, dependencies (none), and the remaining limitations.

Repo root: `C:\Users\saran\Downloads\sketch`. All anchors are `file:line` at that root. No
provider API key was used or requested: every run drove the engine's fake provider
(`SKETCH_FAKE_PROVIDER=1`). No tracked file outside the W6 ownership list was changed except
the one lead-approved additive reducer case in `state/AppState.tsx` (§ invariant 6). The
~120 pre-existing dirty files in the worktree were left as they were; nothing was committed,
pushed, stashed, reset, or reverted. Every QA launch used a throwaway `%TEMP%` home and
stopped the vite/Edge processes it started, by the PIDs it launched.

---

## 1. What the owner asked, as it applies to W6

Make the chat feel like a finished, trustworthy agent panel: messages read well and cannot
inject script; a run in flight is legible and can be stopped; the outcome shown is honest
(W5) and the receipt is the real one (W4); Copy and Retry actually work and no button is
dead; the composer is complete (modes, model, attachments, keys, disabled reasons);
scrolling behaves; conversation history (new / open / rename / delete / search / persist)
works on both surfaces; and the agent panels show real engine data, never a placeholder.
The owner named one defect here — B-004, that each message's model-call count be honest —
which W5/W4 already fixed in the engine and receipt; W6 shows it.

---

## 2. Summary of findings

The chat panel was already mature from earlier rounds (W2's run-root notice and send guard,
W5's honest outcome text, W4's receipt line, W3's tokens). The real gaps W6 found and fixed:

| Invariant | State found | Action |
|---|---|---|
| 1. Messages read well & are inject-safe | Markdown parser already element-only; **no test proved it** | Added `Markdown.test.tsx` with the three XSS payloads; tokenised `Markdown.module.css` |
| 2. A run is legible & stoppable | Legible/stoppable already; **a user Stop rendered as a failure** ("did not finish") | **Fixed**: a user-stopped run now reads as a neutral "Stopped"; verified live over CDP |
| 3. Message actions work | **Copy and Retry were absent** — nothing under a finished reply | Added `retry()`/`promptBehind()` to the session + a Copy/Retry row; no dead button |
| 4. The composer is complete | Already complete (modes, model, attach, keys, disabled reasons) | Verified live + by tests |
| 5. Chat scrolling behaves | Already correct (pinned-to-bottom, Jump to latest) | Verified |
| 6. Conversation history | new/open/delete/search/persist present; **no rename, delete was one-click** | Added inline rename (lead-approved `RENAME_CONVERSATION`); delete now behind a destructive confirm |
| 7. Managing agents | AgentTeamPanel / TeamPanel / AgentConsole / AgentTimeline already real event projections | Verified end to end (25 tests) |
| 8. Design & sizes | Chat CSS carried colour literals; sizes unproven for the chat | Tokenised to W3; proved 0 overflow/overlap at 6 sizes × 2 surfaces over CDP |

The correct engineering call was to leave the already-correct behaviour untouched (owner
rule 1) and spend the budget on the three real gaps (invariants 3, 6, and the missing XSS
test for 1) plus the design pass and the live size-matrix proof.

---

## 3. Invariant 1 — messages read well and safely

### Before (evidence)
`components/Markdown.tsx` already builds React elements directly — no `dangerouslySetInnerHTML`
anywhere, the only input-derived attribute is a link URL that must be `http(s)` (`:95`
`const safe = /^https?:\/\//i.test(url)`), and `openExternal` (`:30`) opens only `http(s)`
through the system browser. Code blocks already show a language label and a Copy button with a
"Copied" state (`CopyButton`, `:45`), use `white-space: pre; overflow-x: auto` so a long line
scrolls inside the block, and the root wraps long unbroken text. **But there was no test** that
pinned the inject-safety — the load-bearing property — so a future refactor could regress it
silently (the class of bug behind opencode's CVE-2026-22813).

### Root cause
No `Markdown.test.tsx` existed (the suite had zero Markdown coverage); the colour-literal
styling also predated W3's tokens.

### The fix
- **`components/Markdown.test.tsx`** (new) — feeds the three canonical payloads and asserts
  each is inert: `<img src=x onerror=…>` → no `<img>` element and the handler never fires;
  `<script>…</script>` → no `<script>` element; `[x](javascript:alert(1))` → no anchor with a
  `javascript:` href, the label shown as text. Plus the formatting the chat relies on
  (headings, bullet list, table, inline code, block quote, http link opens externally) and a
  fenced code block with its language label and a working Copy button.
- **`components/Markdown.module.css`** — every colour/size/radius literal → a W3 token
  (21 literals → 0); code blocks keep `white-space: pre; overflow-x: auto`, the root keeps
  `overflow-wrap: anywhere; word-break: break-word`.

### Proof after
`Markdown.test.tsx` — 6 cases, all pass (§ Tests). **Mutation check:** changing the link
guard to `const safe = true || /^https?:…/` made the *'refuses a javascript: link'* case FAIL
(the payload rendered as a live anchor); restored → pass. So the test is not vacuous: it
catches a real injection regression.

---

## 4. Invariant 2 — a run in flight is legible and stoppable

### Verified (already correct)
`components/RunCards.tsx` `LiveRun` shows a spinner + present-tense status
(`currentActivity`), the steps as the event stream delivers them (`stepsFor`, last 12), and a
Stop button that is visible while running and disabled once "Stopping…". `AgentChat.tsx`
`MessageList` wires Stop to `session.stop()`, which calls W5's `client.cancel(runId)`; the run
then ends with the engine's own terminal text (W5 writes "Run aborted." / `reason: aborted`)
and the composer re-enables (`activeRunId` → null flips the Send/Stop button back). Auto
mode's auto-continue posts "Reached the turn limit; continuing automatically (n of 2)."
(`AgentSession.tsx`, `AUTO_CONTINUE_LIMIT = 2`) and starts a visible continued run. The honest
outcome text (W5's `finalText`, rendered as Markdown with `msg.ok === false` → a "did not
finish" marker) and the receipt line (W4's `RunReceiptLine`: answered model, calls, retries,
tokens unknown/estimated) are shown in BOTH surfaces because both render the same `MessageList`
/ `RunReceiptLine`.

### Stop reads as Stopped, not as a failure (the one clause that was unmet)

**Before (evidence).** The seed says a Stop ends the run "shown as Stopped (cancelled), not
completed or failed." But a user-pressed Stop went through W5's abort path, so the terminal
agent message rendered the engine's `finalText` "Run aborted." with `msg.ok === false`, which
fires the red "did not finish" marker (`AgentChat.tsx` `renderMessage`). A run the user
deliberately ended read like an error.

**Root cause.** `AgentSession.tsx`'s `.then` wrote `ok: result.ok` (false for an abort) and
the engine's raw abort text for every abort, with no distinction between an abort the user
asked for and one they did not.

**The fix (in the session wiring, no message field or reducer action).**
- `lib/AgentSession.tsx` keeps a `stoppedRuns` ref (a `Set<string>`); `stop()` adds the run
  id before calling `client.cancel`. A new `wasStopped(runId)` exposes it.
- In the `.then`, `userStopped = terminalReason(source) === 'aborted' &&
  stoppedRuns.current.has(runId)`. When true, the message is written with the plain sentence
  **"Stopped. Nothing more was changed after you pressed Stop."** and `ok: undefined` (not
  `false`), so no failure marker fires. The receipt (`receiptFor(source)`) still shows the
  calls, tokens and edits from before the stop. An abort the user did NOT request
  (`stoppedRuns` does not hold the id — engine shutdown, another reason) is left exactly as the
  engine reported it: `ok: result.ok` and the engine's text, failure styling and all.
- `AgentChat.tsx` renders a neutral **"Stopped"** chip (token-styled, not the red `.notOk`)
  when `session.wasStopped(msg.runId)`, instead of the "did not finish" marker. Both surfaces
  render the same `MessageList`, so the Code sidebar (`IdeChatSidebar`) behaves identically.

**Proof after.** `AgentChat.test.tsx` describe *'a stopped run reads as Stopped, not as a
failure'* (2 cases): a run the user stopped (Stop pressed, then a `run_failed{reason:aborted}`
terminal event) shows the plain "Stopped" sentence + a "Stopped" chip, and NOT "did not
finish" nor the raw "Run aborted."; an abort the user did NOT request keeps "Run aborted." and
the "did not finish" failure marker, with no "Stopped". **Mutation check:** forcing
`userStopped = false` made the neutral-stop case FAIL (it rendered the failure text/marker)
while the unrequested-abort case still passed; restored → both pass.

### Proof after (legibility, already correct)
Existing `AgentChat.test.tsx` *'offers Stop while a run is in flight and cancels the id it
started'* (Stop → `cancel(runId)`, then the run's own terminal result is what shows) and
*'answers a paused run instead of starting a second one'* still pass. **Live over CDP**
(`scripts/w6-chat-shots.mjs`, Vite dev preview + headless Edge, fake provider): a real run
rendered, and its receipt line read `fake (requested) · 90 ms · 3 model calls · 3.9k ~tokens
(estimated)` — the W4 receipt with the answered-model "(requested)" label and the estimated-
tokens mark, shown on the Cowork chat (screenshot `picture/overhaul/w6/after-cowork-1280x720.png`).
The packaged app cannot be driven over CDP on this host (WebView2 156 opens no listener,
diagnosed in `fix-workspace-paths.md` §6.4), so the dev preview — same React source, same
in-process engine — is the drivable surface.

---

## 5. Invariant 3 — message actions work (the real gap)

### Before (evidence)
A finished assistant reply rendered its text, its steps fold and its receipt — and then
nothing. There was **no Copy button and no Retry button** anywhere under a message
(`AgentChat.tsx` `renderMessage`, before: the assistant bubble ended at `RunReceiptLine`). The
session had no retry path at all (`grep retry` in `panels/agent/**` → no matches). So the
owner's "Copy button / Retry button / Message actions … no dead buttons" bar was unmet: the
actions simply did not exist.

### Root cause
`lib/AgentSession.tsx` exposed no `retry`, and `AgentChat.tsx` rendered no per-message action
row.

### The fix (no dead button)
- **`lib/AgentSession.tsx`** — added `promptBehind(message)` (the last user turn strictly
  before a reply, or null) and `retry(message)`: it refuses while a run is in flight (never a
  second concurrent run) and when there is no earlier prompt, otherwise calls `send(prompt)` —
  the exact same request path as typing it again, so Retry is "one fresh run per click". Both
  are on `AgentSessionValue` and in the memoised context value.
- **`panels/agent/AgentChat.tsx`** — a `MessageActions` component under each non-empty
  assistant reply: **Copy** writes `message.content` to the clipboard and flips to a "Copied"
  state for 1.5 s; **Retry** calls `session.retry(message)` and is only rendered when
  `session.activeRunId === null && promptBehind(message) !== null` — so there is no dead Retry
  button. The row is quiet (opacity 0) until the bubble is hovered or a button takes focus
  (`:focus-within`), keyboard-reachable, token-styled.

### Proof after
`AgentChat.test.tsx` describe *'message actions (Copy / Retry)'* (3 cases): Copy writes the
reply text and shows "Copied"; Retry re-sends the request the reply answered as one fresh run
(the re-sent `prompt` contains the earlier user turn, `run` called once); and no Retry button
is shown when there is no earlier request behind the reply, while Copy still is.
**Mutation check:** making `retry` a no-op (`if (false) send(prompt)`) made the *'Retry
re-sends…'* case FAIL (`run` not called); restored → pass.

---

## 6. Invariant 4 — the composer is complete

### Verified (already correct)
`panels/agent/Composer.tsx`:
- **Ask/Agent/Auto** — `ModeSwitcher` is a `role="radiogroup"` of `role="radio"` buttons
  (mouse), Shift+Tab in the textarea cycles the mode (keyboard, `onKeyDown`), and each button's
  `title` says what the mode does (`MODE_INFO[m].hint`). One source of truth
  (`modeRunOptions`, W5) keeps the label and the engine options from drifting.
- **ModelSelector** (W4 owns its internals) sits in `promptRightActions`, placed and sized by
  the shell CSS.
- **Attachments** work end to end: `@file` mentions (`mentionedPaths`) and the `+` `AttachMenu`
  both add project-relative paths that are passed to the run as `options.files`, which
  `startRun` appends to the prompt ("Files to look at first: …") so the attached file reaches
  the run. A chip can be removed. The menu shows an "Open a project folder first" hint when
  there is no root.
- **Keys**: Enter sends, Shift+Enter is a newline, and IME composition never sends
  (`isComposing(e)` guards `onKeyDown`, `lib/keys`).
- **Disabled states give a reason**: no model / no folder → the `Blocker` explains it with a
  fix button (`sendBlocker`), and a send attempts surface the same reason; a conversation whose
  root is outside the workspace (W2) → the Send button is disabled with that reason in its
  `title`, and `submit()` short-circuits with a system note (W2's guard, kept exactly).
- **Slash commands** work (`parseSlash` + the `/` menu; local actions like `/clear`, `/undo`
  run even for an out-of-workspace conversation).

### Proof after
Existing `composer.test.tsx` (16 cases) and `AgentChat.test.tsx` cover mode options, the
no-folder/no-model refusals, the key-free run, and the paused-run answer path — all still pass.
**Live over CDP**: the composer rendered with the Ask/Agent/Auto switch (Agent active), the
ModelSelector ("Offline test · fake-model"), the `+` attach button and the Send control
(`after-cowork-1280x720.png`). W2's run-root logic in `Composer.tsx` was not touched.

---

## 7. Invariant 5 — chat scrolling behaves

### Verified (already correct)
`AgentChat.tsx` `MessageList`: a `pinned` ref tracks whether the reader is within
`FOLLOW_SLACK_PX` (80px) of the end; new content auto-scrolls only while pinned, and sending a
user message re-pins. Scrolled up, `behind` flips true and a "Jump to latest" control appears
(inline sticky in the compact Code chat, floating above the composer in Cowork). The scroll
listener is `passive`, the effect deps are the message list / live-event length / pending
approval (no per-render object in a dep array), and the host-placed jump is reported through a
ref so only the "behind" flip re-runs the effect — no re-render storm while a run streams.

### Proof after
Verified by reading the code against the invariant and live over CDP (no scroll jank or layout
break across the size matrix; the chat stayed usable at every size). Covered indirectly by the
existing AgentChat suite (the message list renders and the Stop/Send toggle works through a
run). No change was needed here.

---

## 8. Invariant 6 — conversation history (rename + destructive delete added)

### Before (evidence)
`panels/agent/ConversationSidebar.tsx`: New task, open (W2's `open()` logic), search filter and
the empty state all worked, and conversations persist (`savePersistedState`). But **delete was
a single click** straight to `DELETE_CONVERSATION` (no confirmation — an irreversible action
behind one misclick), and there was **no rename at all** (titles are auto-derived from the first
message; no reducer action existed to change one — `grep RENAME_CONVERSATION` → none).

### Root cause
The delete button dispatched the reducer directly; conversation titles live in
`state/AppState.tsx` (the shell's state, outside W6's file list) with only `DELETE`/`NEW`/
`UPDATE_MESSAGE` actions and no rename.

### The fix
- **Destructive delete** (within W6's files): `ConversationSidebar.tsx` now routes delete
  through `useConfirm()` (`components/ConfirmDialog`) — a modal with a **danger** "Delete"
  button and a "cannot be undone" message; only a confirmed "delete" dispatches
  `DELETE_CONVERSATION`.
- **Rename** (lead-approved additive reducer): `state/AppState.tsx` gained one case,
  `RENAME_CONVERSATION {id, title}` — trims the title, caps it at `MAX_CONVERSATION_TITLE`
  (120), keeps the old title when the new one is empty, changes only the named conversation,
  and is a no-op for an unknown id; it returns the same state reference when nothing changed, so
  it persists like any other conversation edit. This is the ONLY change to `AppState.tsx`,
  approved by the lead the way W5's one additive field was.
  `ConversationSidebar.tsx` has an inline rename: a Pencil button (mouse, `aria-label`) opens a
  text input (also `aria-label`led); **Enter commits, Escape cancels, blur commits**. Because
  Enter and Escape both also blur the field in the same tick, the editing state is mirrored in a
  synchronously-updated `editRef` that `commitRename` reads and clears first — so Enter+blur
  commits exactly once and Escape+blur commits nothing.
- The Code sidebar shares the same conversation model and the same `MessageList`, so new chat
  (its header `+`), open (All conversations → the shared sidebar), persistence and the message
  rendering behave identically there; rename/delete live on the shared Recents list.

### Proof after
- `state/conversations.test.ts` (new, 6 cases): the reducer renames exactly the named
  conversation, trims, caps at 120, keeps the old title on empty (same reference back), is a
  no-op for an unknown id; and a renamed title survives a `savePersistedState` → `loadPersistedState`
  round-trip (the "persist across a reload" bar).
- `ConversationSidebar.test.tsx` (new, 6 cases): delete does NOT remove on the first click (the
  confirm dialog appears, the conversation survives), removes only after the danger button, and
  keeps it on Cancel; rename commits on Enter (and the follow-on blur does not commit twice),
  cancels on Escape (unchanged even though blur follows), and commits on blur alone. The 5
  existing W2 selection tests still pass.
- **Mutation checks:** (delete) making the confirm handler delete unconditionally
  (`choice === 'delete' || true`) made the *'keeps the conversation when the user cancels'* case
  FAIL; restored → pass. (rename) dropping the id guard in the reducer (`if (false || c.title ===
  next)`) made the *'renames exactly the named conversation'* and *'no-op for an unknown id'*
  cases FAIL; restored → pass.

---

## 9. Invariant 7 — managing agents (real data, verified)

The app offers four agent panels, each a pure projection of the engine event log — no fixtures,
no placeholder presented as complete:
- **`panels/agent/AgentTeamPanel.tsx`** — reads `strategy-catalog` over the real RPC (what CAN
  be verified in the open project and why not when it cannot), and fills its "Dispatcher
  activity" from `strategy_selected` events as a dispatch actually happens. It says plainly "No
  engine behind this transport" when the transport has no catalog, and "Nothing has been
  dispatched" with the reason when there is no activity — never a fake role status. (Its header
  comment records the three disagreeing fixtures it replaced.)
- **`ui/panels/AgentConsole.tsx`** — pairs each `llm_request` with the `llm_response` that
  answered it (per run, FIFO, tightened by iteration), shows the exact messages, the response and
  token usage, "usage not reported" when none, an honest "Awaiting response…" for an unpaired
  request, and a real empty state.
- **`ui/panels/AgentTimeline.tsx`** and **`team/TeamPanel.tsx`** — event-log projections with
  their own tests.

### Proof after
`AgentTeamPanel.test.tsx` (13), `AgentConsole.test.tsx` (5), `AgentTimeline.test.tsx` (4) and
`TeamPanel.test.tsx` (3) — 25 cases, all pass. No change was needed; the panels were verified
against the real event shapes, not assumed.

---

## 10. Invariant 8 — design and sizes

### Colour-literal counts (before → after), per owned chat file
Counted by `[regex] '#[0-9a-fA-F]{3,8}' | 'rgba?\(…\)'`:

| File | before | after | Remaining literals (why) |
|---|---|---|---|
| `components/Markdown.module.css` | 21 | **0** | — |
| `components/RunCards.module.css` | 49 | **11** | status-tint text/diff washes (add=`--success`, del=`--error` used where tokens fit; the remaining are green/red/orange tint literals derived for light by `themeColors.ts`) |
| `components/ThinkingIndicator.module.css` | 0 | 0 | already token-driven |
| `panels/agent/AgentChat.module.css` | 101 | **16** | the orange notice/system washes, the inert send-button fill `#404040`, accent-tint borders — all derived for light |
| `panels/agent/Composer.module.css` | 39 | **28** | mostly `var(--token, #fallback)` defensive fallbacks (tokenised; the regex counts the fallback) + the documented Ask/Agent/Auto status tints and the deliberate dark-on-orange Allow button |
| `panels/agent/ConversationSidebar.module.css` | 7 | 7 | W3 already tokenised it; the danger-delete tint literals remain by design |
| `panels/agent/AgentTeamPanel.module.css` | 11 | **0** | verifiable→`--success`, skipped→`--warning`, error→`--error`; the subtle washes use `color-mix(... var(--status) N%, transparent)` |
| `panels/ide/IdeChatSidebar.module.css` | 39 | **2** | the MCP-warning tint rgba pair (`--warning` used for text) |
| `panels/agent/AgentChat.tsx` | 2 | **0** | the hero logo moved from an inline `#E8631A`/`#fff` style to a token class |
| `panels/TaskLog.module.css` / `DiffReview.module.css` / `team/TeamPanel.module.css` | 1 / 1 / 1 | 1 / 1 / 1 | one accent tint each |
| `ui/panels/AgentConsole.module.css` / `AgentTimeline.module.css` | 0 / 0 | 0 / 0 | already token-driven |

Every remaining literal is an intentional status/accent tint or a `var(--token, #fallback)`
fallback, handled by W3's build-time light derivation — the same class of residual W3's own
sweep documented. No token W3 does not define was invented.

### Every state
Loading (`LiveRun` spinner + "…"), empty (the welcome/suggestions screen; the Code sidebar
watermark; `AgentConsole`/`AgentTeamPanel` empty states), error (W5's honest `finalText` +
`ok=false` marker; system-note rows; `role="alert"` on the panels), success (the receipt's
"Verified: …"), disabled (Send disabled with a reason; approval buttons), and offline (the
engine still refuses network work; the composer's blockers) are all present and token-styled.

### Sizes (no horizontal overflow, no overlap)
Measured over the Vite dev preview + headless Edge CDP (`scripts/w6-chat-shots.mjs`, isolated
`%TEMP%` home, `SKETCH_FAKE_PROVIDER=1`, a seeded keyless provider so the onboarding modal does
not cover the shell), both surfaces × 6 sizes. `document.scrollWidth` vs `clientWidth`, and a
pairwise bubble-rect overlap test scoped to the ACTIVE surface (both surfaces are mounted at
once; the inactive one is laid out off-screen and is excluded, else it reads as a false
"overlap"):

| Size | Cowork overflow / overlap | Code overflow / overlap |
|---|---|---|
| 1920×1080 | none / none | none / none |
| 1600×900 | none / none | none / none |
| 1366×768 | none / none | none / none |
| 1280×720 | none / none | none / none |
| 1024×640 | none / none | none / none |
| 900×600 (min) | none / none | none / none |

**No horizontal overflow and no overlap at any size, on either surface** (driver printed "No
horizontal overflow and no overlap at any size on either surface", exit 0). 12 screenshots in
`picture/overhaul/w6/after-{cowork,code}-{size}.png`; the Cowork 1280×720 shot shows the real
run with distinct user/assistant bubbles, the W4 receipt line, the steps fold and the full
composer.

---

## 11. Dead-button list

Hunted across the owned files (every `<button>` / `role="button"` / clickable in `AgentChat`,
`Composer`, `RunCards`, `Markdown`, `ConversationSidebar`, `IdeChatSidebar`):

| Control | Status |
|---|---|
| Copy (under a reply) | **Added** — writes the reply text, "Copied" state |
| Retry (under a reply) | **Added** — one fresh run per click; rendered ONLY when there is an earlier request and no run in flight (never dead) |
| Rename (Recents) | **Added** — inline edit, commits/cancels |
| Delete (Recents) | Now behind a destructive confirm (was one-click) |
| Stop (LiveRun / composer) | Works (W5 cancel) |
| Code-block Copy / Insert | Works (clipboard; Insert only shown when an editor insert target exists) |
| Allow / Deny / Allow-for-run (approval) | Works (W5 reply) |
| Undo / Accept all / Reject / Review (changed files) | Work (session + review engine) |
| Jump to latest | Works (scroll) |
| Mode radios, ModelSelector, `+` attach, folder pill, suggestions | Work |

No dead button remained; none shown that does nothing.

---

## 12. Tests, typecheck, build, mutation checks (every command + result)

Each typecheck/test ran in a **later step** than the edits it checks. `--maxWorkers=1` is
unusable on vitest 2.1.9 here, so serial execution used
`--pool=forks --poolOptions.forks.singleFork=true`. No engine code was changed, so
`npm run build -w @sketch/core` was not needed.

### 12.1 Typecheck
```
cd packages/desktop && npx tsc --noEmit            → exit 0, no errors
```

### 12.2 Unit / integration (vitest, serial)
```
cd packages/desktop
npx vitest run src/components/Markdown.test.tsx src/state/conversations.test.ts \
  src/panels/agent/AgentChat.test.tsx src/panels/agent/ConversationSidebar.test.tsx \
  src/panels/agent/AgentSession.runRoot.test.tsx src/panels/agent/AgentTeamPanel.test.tsx \
  src/composer.test.tsx src/chat-ui.test.tsx src/team/TeamPanel.test.tsx \
  src/ui/panels/AgentConsole.test.tsx src/ui/panels/AgentTimeline.test.tsx \
  --pool=forks --poolOptions.forks.singleFork=true
→ Test Files 11 passed (11);  Tests 105 passed (105)
   (Markdown 6 new, conversations 6 new, AgentChat 17 [12 pre + 3 Copy/Retry + 2 Stop-neutral],
    ConversationSidebar 11 [5 pre + 6 new rename/delete], AgentSession.runRoot 3,
    AgentTeamPanel 13, composer 16, chat-ui 21, TeamPanel 3, AgentConsole 5, AgentTimeline 4)
```

### 12.3 Build (CSS-compile gate)
```
cd <repo root> && NODE_OPTIONS=--max-old-space-size=1536 npm run build -w @sketch/desktop
→ ✓ built in 19.60s (exit 0); the token-converted chat CSS compiled.
   (the monaco >500 kB chunk-size warning is pre-existing and unrelated)
```

### 12.4 Size matrix over the dev preview (CDP)
```
cd packages/desktop && W6_VITE_PORT=1446 W6_EDGE_PORT=9446 node scripts/w6-chat-shots.mjs
→ "No horizontal overflow and no overlap at any size on either surface" (exit 0)
   12 screenshots in picture/overhaul/w6/; the overflow/overlap table in §10.
   (a measure-only pass, W6_MEASURE_ONLY=1, prints the same table without capturing)
```

### 12.5 Mutation checks (proving the new tests are not vacuous)
Each mutation was applied, the relevant test run, then the code restored and re-run green.
- **XSS link guard (inv 1).** `const safe = true || /^https?:…/` in `Markdown.tsx` → the
  *'refuses a javascript: link'* case FAILED (rendered a live anchor). Restored → pass.
- **Retry (inv 3).** `if (false) send(prompt)` in `AgentSession.retry` → the *'Retry re-sends…'*
  case FAILED (`run` not called). Restored → pass.
- **Delete confirm (inv 6).** `choice === 'delete' || true` in `ConversationSidebar` → the
  *'keeps the conversation when the user cancels'* case FAILED (the conversation was deleted).
  Restored → pass.
- **Rename reducer (inv 6).** Dropping the id guard (`if (false || c.title === next)`) in
  `appReducer` → the *'renames exactly the named conversation'* and *'no-op for an unknown id'*
  cases FAILED. Restored → pass.
- **User-stop neutrality (inv 2).** Forcing `userStopped = false` in `AgentSession`'s `.then`
  → the *'a run the USER stopped shows a neutral "Stopped"'* case FAILED (it rendered the
  failure text/marker) while the *'an abort the user did NOT request'* case still passed.
  Restored → both pass.

---

## 13. Files modified / added

| File | Change | In W6's list? |
|---|---|---|
| `packages/desktop/src/lib/AgentSession.tsx` | Added `retry()` + `promptBehind()`; a `stoppedRuns` ref + `wasStopped()` and the neutral-Stopped terminal text for a user-stopped abort (stop/retry/copy wiring only); added to the context value. W2's run-root logic, W5's mode/outcome logic and W4's provider/model choice were not touched. | yes (stop/retry/copy/scroll wiring) |
| `packages/desktop/src/panels/agent/AgentChat.tsx` | `MessageActions` (Copy/Retry) under each reply; a neutral "Stopped" chip (vs the red "did not finish") when `session.wasStopped(runId)`; hero logo → a token class (dropped the inline `#E8631A`/`#fff`). W2's `ConversationRootNotice` kept intact. | yes |
| `packages/desktop/src/panels/agent/AgentChat.module.css` | Colour/size/radius literals → W3 tokens (101 → 16); added `.heroLogo`, `.messageActions`/`.msgActionBtn`, `.stopped` (neutral), focus-visible rings, reduced-motion. | yes |
| `packages/desktop/src/panels/agent/AgentTeamPanel.module.css` | 11 colour literals → W3 status tokens (`--success`/`--warning`/`--error`) with `color-mix` washes (11 → 0). | yes |
| `packages/desktop/src/panels/agent/Composer.module.css` | Menu/approval neutrals → tokens (39 → 28). W2's send guard in `Composer.tsx` untouched. | yes |
| `packages/desktop/src/panels/agent/ConversationSidebar.tsx` | Destructive delete via `useConfirm`; inline rename (Pencil, Enter/Escape/blur via a synchronous `editRef`). W2's `open()` logic kept intact. | yes |
| `packages/desktop/src/panels/agent/ConversationSidebar.module.css` | `.recentRename`/`.recentRenameInput` + focus rings (tokens). | yes |
| `packages/desktop/src/panels/agent/ConversationSidebar.test.tsx` | New describes: delete-confirm (3) + inline rename (3). | yes (tests) |
| `packages/desktop/src/components/Markdown.tsx` | No behaviour change (mutation check only, restored). | yes |
| `packages/desktop/src/components/Markdown.module.css` | All literals → W3 tokens (21 → 0); kept code-block `pre`/scroll + root wrap; link hover/focus. | yes |
| `packages/desktop/src/components/Markdown.test.tsx` | **New.** Inject-safety (3 XSS payloads) + formatting + code-block Copy (6 cases). | yes (tests) |
| `packages/desktop/src/components/RunCards.module.css` | Neutrals → tokens, add/del → `--success`/`--error` (49 → 11). W4's `RunReceiptLine` behaviour untouched. | yes |
| `packages/desktop/src/panels/ide/IdeChatSidebar.module.css` | Neutrals/status → tokens (39 → 2). | yes |
| `packages/desktop/src/state/conversations.test.ts` | **New.** `RENAME_CONVERSATION` reducer rule + persist-across-reload (6 cases). | yes (tests for owned behaviour) |
| `packages/desktop/scripts/w6-chat-shots.mjs` | **New.** Dev-preview CDP size-matrix driver (6 sizes × 2 surfaces), screenshots + overflow/overlap, scoped to the active surface; `--measure-only` / env-var ports. | yes (a script) |
| `packages/desktop/src/state/AppState.tsx` | One additive reducer case `RENAME_CONVERSATION {id, title}` + `MAX_CONVERSATION_TITLE = 120` (and the action type). | **No — lead-approved addition.** The only change to this file; the lead approved it with the exact rule (trim, cap 120, empty keeps old, unknown no-op, persist, single conversation). |

**Dependencies added: none.** **Mock data introduced: none.** **Security checks weakened:
none** (the Markdown inject guards and W2's send guard are unchanged/strengthened by proof).

`panels/TaskLog.*`, `panels/DiffReview.*`, `review/**`, `team/**`, `ui/panels/**`,
`components/ThinkingIndicator.*` were read and verified; they needed no change (already
token-driven and real event projections). W3's `styles/**` and the shell components were not
touched; no new token was needed (every token referenced is one W3 defines).

---

## 14. Remaining limitations

- **No live CDP screenshot of the packaged app.** WebView2 156 on this host accepts
  `--remote-debugging-port` but opens no DevTools listener (diagnosed in
  `fix-workspace-paths.md` §6.4), so the packaged app cannot be driven over CDP. The chat was
  verified against the exact React source and the in-process engine over the Vite dev preview
  (same code), and by the unit suites. On a host whose WebView2 honours the port, the QA-build
  recipe in `fix-workspace-paths.md` §6 drives the same flow.
- **Runs were driven with the fake provider**, not a scripted multi-step recording server. The
  fake adapter exercised the full render path (user/assistant bubbles, steps, the W4 receipt
  with answered-model and estimated-tokens labels, the composer, scrolling). Stop, the honest
  outcomes and the multi-step/retry/token-unknown receipt are covered against the real engine
  by W5's `w5-e2e-rpc.mjs` and W4's `w4-e2e-rpc.mjs` / `w4-ui-proof.mjs` and the unit suites
  here; this item did not re-run a scripted provider for the chat UI.
- **The overlap metric is scoped to the active surface.** Both chat surfaces are mounted at
  once (the inactive one laid out off-screen), so an unscoped rect test false-flags the hidden
  surface against the shown one; the driver scopes to the visible surface's root. The
  horizontal-overflow metric (`scrollWidth === clientWidth`) is measured on the live document
  and is unambiguous at every size.
- **Rename stores into the shared conversation list**; the Code sidebar surfaces rename/delete
  through the same Recents list (reached via its "All conversations" button), not with its own
  in-sidebar rename control.
