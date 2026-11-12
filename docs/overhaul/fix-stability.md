# W10 — Stability and the cross-item regression sweep: fix

Item W10 of the Sketch IDE overhaul. It covers brief §4 "Backend and application
stability" plus the cross-item regression sweep: eight items (W2–W9) changed this
codebase one after another, each running only its own targeted tests, so W10 runs **both
full suites serially** and fixes every cross-item break at its root, then hardens the
seven stability invariants the lead set.

Repo root: `C:\Users\saran\Downloads\sketch`. All anchors are `file:line` at that root.
No provider API key was used or requested: every run drove the engine's fake provider or
a local loopback server. No tracked file outside the W10 ownership list was changed; the
pre-existing dirty files in the worktree (the owner's work from earlier sessions) were
left exactly as they were — nothing was committed, pushed, stashed, reset, or reverted.
Each typecheck/test ran in a **later step** than the edits it checks; `--maxWorkers=1`
throws on vitest 2.1.9 here, so serial execution used
`--pool=forks --poolOptions.forks.singleFork=true` with `NODE_OPTIONS=--max-old-space-size=1536`.

Inputs read first, as leads not facts: every `docs/overhaul/fix-*.md` (W2–W9),
`docs/BUG_AUDIT.md` (stability section — W1 found no stability defect beyond B-008, which
W3 fixed, and claimed process cleanup was implemented), and `docs/ARCHITECTURE_REVIEW.md`
§3 and §5(i). W1's claims were VERIFIED against the real code, not assumed.

---

## 1. Full-suite results, before and after (invariant 1)

Both suites were run serially, one shared fork, after `npm run build -w @sketch/core`
(desktop tests import `@sketch/core` from its built `dist`).

### 1.1 Commands and final counts (AFTER)

```
# engine (packages/core)
cd packages/core && npx tsc --noEmit                     → exit 0
cd packages/core && npx vitest run \
  --pool=forks --poolOptions.forks.singleFork=true \
  --exclude '**/no-egress.test.ts' --exclude '**/local-models.test.ts' \
  --exclude '**/phase4-gate.test.ts'
  → Test Files 83 passed (83);  Tests 1386 passed (1386)
cd packages/core && npx vitest run \
  test/no-egress.test.ts test/local-models.test.ts test/phase4-gate.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 3 passed (3);   Tests 27 passed (27)
# ⇒ core TOTAL: 85 files, 1411 tests, all pass

npm run build -w @sketch/core                            → exit 0 (tsc -p tsconfig.build.json)

# desktop (packages/desktop)
cd packages/desktop && npx tsc --noEmit                  → exit 0
cd packages/desktop && npx vitest run \
  --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 99 passed (99);  Tests 932 passed (932)

# one vite build (the canonical CSS-compile gate)
NODE_OPTIONS=--max-old-space-size=1536 npm run build -w @sketch/desktop
  → ✓ built in 18.78s (exit 0)   (only the pre-existing monaco >500kB chunk-size warning)
```

Baselines named by the lead were core 1,353 and desktop 818; both grew with the sibling
items plus W10's own tests (core +9 rpc-server, +3 providerSettings, +2 user-mcp, +2
cli-process; desktop +8 ErrorBoundary, +3 stdioClient lifecycle, +1 ClientProvider
unsubscribe, +2 settingsPersistence, +2 vanished-root). **Final: core 1413, desktop 932 —
both fully green.** (Round-2 note: the lead's two extra clauses — the engine's own
unhandled rejection, §6; and a restored folder that no longer exists, §7 — added
`cli-process.test.ts` to core and `useFileActions.vanishedRoot.test.tsx` to desktop.)

### 1.2 The two methodology notes that matter

- **The 3 excluded core files are NOT failures.** `no-egress`, `local-models` and
  `phase4-gate` each make real HTTP against loopback / an Ollama-shaped stub on
  `127.0.0.1:11434`. When all 86 core files share ONE fork, another file's manipulation of
  the global `fetch`/`net` guard and the stub's port state contaminates these three, and
  they fail. **Run in their own invocation they all pass (27/27).** Every sibling item ran
  targeted batches for exactly this reason; the one-shared-fork run is the wrong
  methodology for these network-stateful files, not a product defect, and not anything
  W10 touched (W10 changes no networking). Proof: `vitest run test/no-egress.test.ts
  test/local-models.test.ts test/phase4-gate.test.ts` → 3 files, 27 tests, pass.
- **The desktop suite has no such files** and runs fully green in one shared fork.

### 1.3 Every failure found, its root cause, and the item that caused it

The one-shared-fork sweep surfaced **five real failures in four desktop files** (the three
core "failures" above are the shared-fork artifact, not real). Each was root-caused and
fixed by **un-staling a test to the CURRENT contract — never by weakening, skipping,
`.only`-ing or deleting a test**. Each fix was confirmed by re-running the file (all four
re-pass: 44 tests), then by the full desktop re-run (98 files / 930 green).

| # | File:line | Failure | Root cause | Originating item | Fix |
|---|---|---|---|---|---|
| 1 | `packages/desktop/src/chat-ui.test.tsx:198` | `loadPersistedState()` for corrupt storage expected `{}`; got `{ editorNotice }` | W10's own invariant-5 change: corrupt `sketch.ui.v1` now resets AND surfaces a notice instead of a silent empty load | **W10** (this item) | Updated the assertion to the new contract: corrupt → no conversations/root, an `info` notice, and the bytes preserved under `sketch.ui.v1.corrupt`. |
| 2 | `packages/desktop/src/cowork-keys.test.tsx:139` | expected selecting a conversation to move `projectRoot` to the conversation's root; got the already-open root | W2 made **selecting a conversation never move the workspace boundary** (`fix-workspace-paths.md` §4.2); this older keyboard test was left asserting the pre-W2 behaviour | **W2** | Updated to the W2 contract: the keyboard path selects the conversation and leaves `projectRoot` at the open folder, exactly as the click does. |
| 3 | `packages/desktop/src/phase3-guards.test.ts:64` | `main.rs` no longer contains `args.push("--".to_string())` | W8/B-010 **removed** the native `git_status`/`git_diff` from `main.rs` (`fix-editor-workbench.md` §3); git is engine-only now, so "both git implementations" no longer exists | **W8** | Updated to the one-implementation contract: assert the engine's option termination (unchanged) and that `main.rs` no longer defines `fn git_status`/`fn git_diff`. |
| 4 | `packages/desktop/src/styles/themeColors.test.ts:91` | `themed` count `264 < 300` | W3/W6/W7/W8/W9 tokenisation replaced hundreds of raw colour literals with `var(--token)`, so fewer literals remain to be auto-themed — the goal, not a regression | **W3/W6/W7/W8/W9 (collective)** | Lowered the stale floor to `> 260` (current 264), with a comment; still a real floor — a collapse of the themed set fails here. |
| 5 | `packages/desktop/src/styles/themeColors.test.ts:124` | `pairs` count `18 < 20` | Same tokenisation shift: fewer rules now set a literal `color`+`background` pair (most go through `var(--token)`) | **W3/W6/W7/W8/W9 (collective)** | Lowered the stale floor to `> 15` (current 18). The load-bearing assertion — every examined pair still passes the light-theme contrast check (`failures` is empty) — is **unchanged**. |

Measured independently: with W10's new `ErrorBoundary.module.css` moved aside, the
`themed` count is **255** (even lower) and the test still fails, confirming #4/#5 are
pre-existing sibling regressions, not caused by W10 — W10's CSS actually RAISES the count
(255→264) because it adds themed literals.

W1's own stability survey (`BUG_AUDIT.md` "Stability observations") recorded "no new
defect found beyond B-008"; these five are the cross-item breaks that the
run-your-own-tests-only discipline could not catch, which is the entire reason W10 exists.
Only one break pre-W10 round was already known (W2's refusal-message reword broke
`fileIo.ts`/`commandLine.ts`, fixed by W8); this sweep found the rest.

---

## 2. Invariant 2 — no unhandled error takes the window down

### Before (evidence)
`packages/desktop/src/main.tsx` rendered `<App/>` with **no error boundary** and installed
**no** `unhandledrejection`/`error` listener; a repo search for `unhandledrejection`,
`ErrorBoundary` and `window.onerror` across `main.tsx`, `App.tsx` and `lib` found nothing.
So a throw in any render path would unmount the React tree to a blank window, and a
rejected promise or an error thrown outside render (an event handler, a timer, an async
callback) would reach only the console — the user would see nothing.

### The fix
New `packages/desktop/src/components/ErrorBoundary.tsx` (+ `ErrorBoundary.module.css`),
wired into `main.tsx`:

- **`<ErrorBoundary>`** is a React class error boundary (only a class can implement
  `getDerivedStateFromError`/`componentDidCatch`). It wraps the whole app **outside every
  provider**, so a throw anywhere below it — including in a provider's own render — lands
  here and shows a plain recovery screen (`role="alert"`) with the error message and a
  **Reload** button, never a blank window. It warns that unsaved edits in open editor tabs
  may be lost (honest: the reducer restores the tab PATHS but does not persist unsaved
  CONTENT byte-for-byte, so the screen says so rather than promising a recovery the app
  cannot make). `componentDidCatch` always writes a console record — the error is reported,
  never swallowed.
- **`installGlobalErrorReporter()`** adds window `unhandledrejection` and `error`
  listeners. Each handler writes a `console.error` record **and** surfaces a dismissible
  `role="alert"` notice (following W9's convention — errors are `alert`, there is no central
  toast — via a self-contained host node, since these fire from anywhere at any time), and
  **never calls `preventDefault`**, so the platform's own default reporting still runs.
  Nothing is swallowed. It returns a disposer that removes BOTH listeners and the host, so
  installing once is StrictMode-double-invoke safe and a leaked handler cannot double a
  notice. The notice stack is capped (4) so a rejection storm cannot fill the screen.
- `main.tsx` installs the reporter once at module load and wraps `<App/>` in
  `<ErrorBoundary>`.

### Proof after
`packages/desktop/src/components/ErrorBoundary.test.tsx` (8 cases): a throwing child shows
the recovery screen with the real message and a working Reload (not a blank window) and a
console record; the global reporter shows a dismissible alert carrying the reason and
records it for both a rejected promise and an uncaught error; the notice stack is capped;
and the disposer removes both listeners (no doubled handler under a second install).
**Mutation checks:** (a) `render()` returning `this.props.children` unconditionally → the
3 recovery-screen cases FAIL (the throw propagates); restored → pass. (b) the global
handler skipping `showNotice` → the 3 notice cases FAIL; restored → pass.

Files: `components/ErrorBoundary.tsx` (new), `components/ErrorBoundary.module.css` (new),
`components/ErrorBoundary.test.tsx` (new), `main.tsx` (wired in).

---

## 3. Invariant 3 — the engine process lifecycle is sound

### Verified (already correct) + new coverage
`packages/desktop/src/lib/stdioClient.ts`:

- **The sidecar spawn** (`tauriSpawner`, ~`:192`) maps the shell plugin's `'close'` and
  `'error'` to one `exit` handler → `handleExit`. When the engine dies mid-run,
  `handleExit` calls `failPending`, which rejects every in-flight request with
  **`"the sketch engine sidecar stopped (<detail>)…"`** — a clear "engine stopped" error,
  not a hang and not a leak. The UI's run surface renders that rejection as the run's
  failure.
- **`ensureStarted`** is single-flight: a `this.starting` promise is reused, so concurrent
  first calls spawn the process **once**, not twice. A failed spawn is not cached, so the
  **next action restarts the engine** and a retry after a fixed install works without
  reloading the window.
- **`close()`** kills the child and fails anything in flight, and is idempotent.
- **Shutdown cleanup (Rust):** `src-tauri/src/main.rs` `RunEvent::Exit` →
  `terminal_ipc::TerminalState.manager.close_all()` ends every terminal shell (and the dev
  servers they started). The engine sidecar is a Tauri shell-plugin child, which the Tauri
  runtime terminates on app exit; `stdioClient.close()` also kills it. (Verified by reading
  `main.rs:340` and the shell-plugin spawn path; a live-app check is deferred to W11 — §8.)

### Proof after
`packages/desktop/src/lib/stdioClient.test.ts` already covered the kill-mid-request path
("fails everything in flight when the sidecar exits, quoting its stderr"). W10 added a
"process lifecycle" describe (3 cases): **no double-spawn** when two first calls race
(spawnCount === 1, both frames written to the one process); **a clear engine-stopped error
mid-request, then the next call restarts the engine** (first run rejects with
`/sidecar stopped/`, the next `ping` spawns a fresh process, spawnCount === 2, and
succeeds); and **`close()` kills the child, fails the in-flight request, and is
idempotent**. **Mutation check:** dropping the `this.starting` single-flight guard in
`ensureStarted` → the no-double-spawn case FAILS (spawnCount === 2); restored → pass.

Files: `lib/stdioClient.test.ts` (3 new lifecycle cases). No source change was needed —
the lifecycle code was already correct; W10 added the proof.

---

## 4. Invariant 4 — no duplicate listeners, leaked timers or subscriptions

### Audit (every `addEventListener`, `setInterval`/`setTimeout`, `subscribe`/`.on`, `ResizeObserver`, `MutationObserver` in `packages/desktop/src`)
- `addEventListener` 53 vs `removeEventListener` 51. The 2-count delta is accounted for and
  benign: the self-removing `{ once: true }` abort listeners in `stdioClient.ts`/
  `httpClient.ts`/`jsdomFetchBridge.ts` (they remove themselves on fire), and the transient
  per-notice `dismiss` click listener in `ErrorBoundary.tsx` (on a node that is `.remove()`d,
  so its listeners are collected with it). Every component-scoped window/document listener
  returns a matching `removeEventListener` from its effect cleanup (App.tsx's global
  keydown, ConfirmDialog, ContextMenu, TitleBar, EditorArea, SidePanel, SearchPanel,
  Terminal, FileExplorer, diskSync, desktopGuards, colorTheme, ShellSessions, and the rest).
- `setInterval`: `terminal/TerminalRunner.tsx` (→ `clearInterval` on cleanup) and
  `components/settings/LocalModels.tsx` (cleared on completion/error, AND an unmount effect
  clears every still-running timer in its `timers` ref). No leak.
- `ResizeObserver`: `panels/ide/ShellTerminal.tsx` → `observer.disconnect()` on cleanup. No
  `MutationObserver` in the tree.
- Event-stream subscription: `lib/ClientProvider.tsx` owns the one `client.subscribe` and
  returns its `unsubscribe` from the effect — released on unmount, StrictMode-safe.

### Proof after (the riskiest subscription, as the lead named)
`packages/desktop/src/lib/ClientProvider.test.tsx` adds a case: a client wrapper counting
live subscriptions shows **exactly one** while the provider is mounted (not doubled under
StrictMode) and **zero after unmount** — the subscription is released, nothing is left
listening to a dead component. (The global keydown handler in `App.tsx` already removes
itself on unmount — verified in the audit; the ClientProvider subscription is the riskier
of the two the lead offered, and is the one now pinned by a test.)

Files: `lib/ClientProvider.test.tsx` (1 new case). No source change was needed — every
listener/timer/subscription already cleans up.

---

## 5. Invariant 5 — corrupted configuration never bricks the app

### Before (evidence)
The loaders already failed SAFE (a corrupt file was ignored, the app started empty, no
crash — W1 confirmed this), but they did **not** back up the corrupt file and the reset was
silent: no `<name>.corrupt-<timestamp>` and no plain notice, which is what the lead's
invariant requires ("clean start with that piece reset and a plain notice … back up the
corrupt file first; never silently delete user data").

### The fix
A single shared helper, `backupCorruptConfig(path)` in
`packages/core/src/settings/providerSettings.ts` (exported from `settings/index.ts`), moves
a genuinely-corrupt whole-file config aside to `<path>.corrupt-<ISO-timestamp>` (colons
compacted for Windows), **never deleting it**. It is best-effort: a rename failure is
reported in the return value, never thrown into the loader. Both whole-file config loaders
write through temp-then-rename, so a reader never sees a half-written file — "corrupt" means
a hand-edit or disk damage, which is safe to set aside. Wired in:

- **`providers.json`** — `loadProviderSettings`: on invalid JSON, back up + start empty +
  a diagnostic naming the problem and the backup. (A merely-missing file stays the honest
  empty state, no backup, no notice; a key found in a hand-edited file is still stripped and
  reported, as before.)
- **`mcp.json`** — `readUserServers`: a corrupt file is backed up and reported; MCP still
  loads (empty), never bricks.
- **`mcp-trust.json`** — `readUserServers`: a corrupt trust file **fails CLOSED** (no
  project server is treated as approved) and is backed up with a notice, so the user
  re-approves deliberately rather than trusting silently.
- **`usage/*.jsonl`** — `cost/usage-log.ts` `summarizeUsage` already **skips a malformed
  line and counts it** (`UsageSummary.skipped`), which is the right behaviour for an
  append-only log (a crash truncates only the last line); re-confirmed, unchanged. The event
  log (`events/store.ts` `readAllDetailed`) does the same for `.sketch/events/*.jsonl`,
  skipping+counting truncated/invalid lines — re-confirmed, unchanged.
- **localStorage `sketch.ui.v1`** — `state/AppState.tsx` `loadPersistedState`: corrupt JSON
  now preserves the bytes under the sidecar key `sketch.ui.v1.corrupt`, clears the main key
  so the next save is clean, and returns an `info` `editorNotice` so the window does not
  start blank unexplained (localStorage is not a file, so the sidecar key is the backup).

### Proof after
- `packages/core/test/providerSettings.test.ts` (new describe, 3 cases): corrupt
  `providers.json` → clean empty start + a diagnostic naming the `.corrupt-` backup; the
  original bytes are preserved in the backup and the original path is gone;
  `backupCorruptConfig` reports a rename failure instead of throwing; a missing file is the
  honest empty state (no backup, no notice).
- `packages/core/test/user-mcp.test.ts` (2 new cases): corrupt `mcp.json` is backed up and
  reported, not fatal, bytes preserved; corrupt `mcp-trust.json` **fails closed** (a
  previously-approved project server becomes untrusted) with a notice and a backup.
- `packages/desktop/src/state/settingsPersistence.test.ts` (2 new cases): corrupt
  `sketch.ui.v1` preserves the bytes under `.corrupt`, resets cleanly, surfaces an `info`
  notice; a missing key is the honest empty state with no notice.
- **Mutation check:** making `backupCorruptConfig` skip the rename made **4** cases FAIL
  across `providerSettings.test.ts` + `user-mcp.test.ts` (no backup appeared); restored →
  pass.

Files: `settings/providerSettings.ts`, `settings/index.ts`, `mcp/userServers.ts`,
`state/AppState.tsx`; tests `providerSettings.test.ts`, `user-mcp.test.ts`,
`settingsPersistence.test.ts`.

---

## 6. Invariant 6 — the RPC is robust

### Verified (already correct) + new coverage
`packages/core/src/rpc/server.ts` + `rpc/frames.ts` already handle every hostile input by
design, and `rpc/server.ts`'s header documents it (Requirements 12.3/12.4): `parseRequest`
maps malformed JSON → `malformed_json`, a non-object line → `invalid_request`, a bad/empty
method → `invalid_request`, non-object params → `invalid_request`; an unknown method →
`unknown_method` (listing the known ones); a handler throw → `handler_error` via `codeFor`.
Each produces exactly one error frame and NOTHING else — the queue keeps draining. `run`,
`eval` and `skill-train` are the `EXCLUSIVE_METHODS`: they serialize among themselves in
arrival order (two concurrent runs cannot fight over a project root), while every other
method is answered immediately even while a run is open (so `cancel`/`reply` reach a live
run). `main()` never calls `process.exit`, so stdout drains on shutdown. A frame has no
fixed size cap: a 2 MB line parses or fails as `malformed_json` — either way the process
survives.

### The engine's own unhandled rejection (round-2 fix — the clause that was unmet)
The seed requires the engine's own unhandled rejection to be "logged and not kill the
engine silently". **It was NOT**: nothing in `cli.ts` or `rpc/` registered
`process.on('unhandledRejection')` / `process.on('uncaughtException')`, and on the Node
versions that run the sidecar an unhandled rejection terminates the process by default —
so one stray promise in any handler would end the engine mid-session with only a stack
trace on stderr. (The first draft of this doc wrongly said the existing suites covered it;
none did.)

**The fix (`packages/core/src/cli.ts`):** both handlers are registered **before** `main()`.
Each writes exactly one diagnostic line to **stderr** — `"sketch: unhandled rejection: …"`
or `"sketch: uncaught exception: …"` with the stack — and the process keeps serving. It
**never** writes to stdout (the protocol owns that stream). The fatal-startup path is
unchanged: an error thrown by `main()` itself still exits non-zero. A test-only switch,
`SKETCH_TEST_UNHANDLED=1`, read ONLY in `cli.ts` and inert otherwise, schedules one rejected
promise after start-up so a spawned-process test can prove the behaviour.

### Proof after
- In-process: `packages/core/test/rpc-server.test.ts` (9 cases) drives the real
  `ProtocolServer` with crafted lines: malformed JSON → `malformed_json`/null id; a
  non-object line → `invalid_request`; an unknown method → `unknown_method` echoing the id;
  non-object params → `invalid_request`; a throwing handler → `handler_error` **then the
  next request is served normally**; a blank line answered with nothing; a 2 MB oversized
  frame carried without crashing; two concurrent exclusive runs serialize in arrival order;
  a non-exclusive method answered while an exclusive run is open. **Mutation check:** making
  `handleLine` treat exclusive methods as non-exclusive → the serialization case FAILS;
  restored → pass.
- **Over the real stdio CLI** (round-2 — closes the "over the real stdio CLI" clause the
  in-process test left open): `packages/core/test/cli-process.test.ts` (2 cases) **spawns
  the built `packages/core/dist/cli.js`** with `node` and an isolated HOME/USERPROFILE:
  - with `SKETCH_TEST_UNHANDLED=1`, after a first `ping` succeeds, the injected rejection
    fires; the test asserts stderr shows `"sketch: unhandled rejection: …"` AND the process
    is **still alive and still answers a second `ping`** — logged, not fatal.
  - with no switch, it sends crafted frames over the real pipe — malformed JSON (one
    `malformed_json` error, null id), an unknown method (one `unknown_method` error), and an
    oversized 2 MB line (one error) — asserts one error frame each, that the process is
    alive afterwards, and that it still answers a well-formed `ping`.
  - **Mutation check:** removing the `unhandledRejection` handler and rebuilding → the
    engine-survives case FAILS (no logged line; the process would die); restored → pass.

Files: `packages/core/src/cli.ts` (handlers + test-only switch), `test/rpc-server.test.ts`
(new), `test/cli-process.test.ts` (new). The RPC dispatch itself was already robust; W10
added the engine-level handlers it lacked and the real-pipe proof.

---

## 7. Invariant 7 — startup and shutdown are clean

### Verified (against the real code)
- **Cold start, empty isolated home:** `App.tsx` `FirstRun` opens the "Connect a model"
  wizard once when the engine answers with an empty provider list and `sketch.onboarded.v1`
  is unset — onboarding, not a crash. (Covered by the existing provider/onboarding suites,
  re-run green.)
- **Engine not reachable at startup:** `lib/ClientProvider.tsx` pings on mount; a rejected
  ping becomes `status.state === 'error'` carrying the reason — the UI shows an error state,
  not a blank window or a crash.
- **Restored workspace whose folder no longer exists (round-2 fix — was argued, now
  implemented + tested):** persisted state can carry a `projectRoot` that has since been
  deleted or renamed. At startup the Explorer reads the root once; when that read comes back
  as a genuine not-found, `panels/FileExplorer.tsx` dispatches the new
  `CLEAR_PROJECT_ROOT` action (`state/AppState.tsx`) — going to the welcome / no-folder
  state with one plain notice, **"The folder &lt;name&gt; is no longer available. Open a
  folder to continue."**, instead of leaving a dead explorer, a stuck spinner, or a stream
  of not-found errors. The restored tabs for that root are dropped with it; any file that
  still carries UNSAVED edits is **kept** (a vanished folder has none on a fresh start, but
  losing unsaved work silently is worse than a stale tab), while clean disk-backed entries
  are cleared. Only the ROOT and only a true not-found trigger this — a permission error or
  a refused nested folder is still shown as an error row. The detection reuses the Explorer's
  existing root read, adding **no extra disk call** (the first attempt put the probe in
  `useFileActions.ts` and it added a read that broke the Explorer read-count tests, so it was
  moved to the one read that was already happening). **Lead-approved additions** (outside the
  original W10 list, granted for this clause): `panels/FileExplorer.tsx` (the detection +
  a `describesMissingFolder` matcher) and `state/AppState.tsx` (the `CLEAR_PROJECT_ROOT`
  action — AppState was already in the list for corrupt-load; this broadens it to the
  vanished-folder clear). *Proof:* `packages/desktop/src/editor/useFileActions.vanishedRoot.test.tsx`
  (2 cases, jsdom): an io double whose `readDir`/`readFile` reject not-found for the restored
  root → the root clears to none, the notice appears ("is no longer available" / "Open a
  folder to continue"), the restored tabs are gone, and the "No folder opened" welcome state
  shows; a folder that still exists stays open with no notice. **Mutation check:** disabling
  the detector → the clear case FAILS (the root stays set, no notice), the control passes;
  restored → pass.
- **Shutdown flushes/asks:** `lib/windowClose.ts` `askToClose` (wired in `App.tsx`
  `DesktopShell` via `onCloseRequested`) asks Save / Don't Save / Cancel for dirty buffers on
  every close path (the title bar's ✕, Alt+F4, the taskbar Close), and `main.rs`
  `RunEvent::Exit` → `close_all` stops the terminal shells and their child processes. (All
  verified by reading the code and by the existing windowClose/desktop tests, re-run green.)

### Deferred (as the invariant explicitly permits)
The optional QA-app rebuild (`fix-workspace-paths.md` §6, GNU toolchain) with ALL changes
so far (including W8's Rust B-010 removal) + `smoke:boot` was **NOT run**: this host's memory
was CRITICAL/TIGHT (1.2–2.8 GB free) for the whole session, and a Tauri GNU build +
`smoke:boot` is far heavier than the two suites — running it would risk OOM-failing and
destabilising the owner's running app and the other sessions on this shared machine. Per the
invariant ("If memory never allows, say so; W11 will do it"), this is handed to **W11**. The
W10 changes that could affect boot are: a React error boundary and global listeners in
`main.tsx`/`ErrorBoundary.tsx` (pure front-end, no Tauri config touched) and corrupt-config
handling in the engine/reducer (no Tauri config touched), so none alters the compiled-in
Tauri config whose only proof is booting the built app.

---

## 8. Files modified / added

| File | Change | In W10's list? |
|---|---|---|
| `packages/desktop/src/components/ErrorBoundary.tsx` | **New.** React error boundary (recovery screen) + `installGlobalErrorReporter()` (unhandledrejection/error → console + dismissible notice). | yes (new ErrorBoundary.tsx) |
| `packages/desktop/src/components/ErrorBoundary.module.css` | **New.** Recovery-screen + notice-stack styles on W3 tokens. | yes (its CSS) |
| `packages/desktop/src/components/ErrorBoundary.test.tsx` | **New.** 8 cases (recovery screen + global reporter). | yes (tests) |
| `packages/desktop/src/main.tsx` | Wrap `<App/>` in `<ErrorBoundary>`; install the global reporter once. | yes |
| `packages/core/src/cli.ts` | **Round-2 (§6).** Register `process.on('unhandledRejection')` + `process.on('uncaughtException')` before `main()` (one stderr line, keep serving, never stdout); fatal-startup path unchanged; test-only `SKETCH_TEST_UNHANDLED` switch. | yes (`cli.ts`) |
| `packages/core/test/cli-process.test.ts` | **New, round-2 (§6).** Spawns `dist/cli.js`: engine survives its own unhandled rejection + crafted frames over the real pipe. 2 cases. | yes (tests) |
| `packages/desktop/src/panels/FileExplorer.tsx` | **Round-2 (§7), lead-approved.** On a not-found ROOT read, dispatch `CLEAR_PROJECT_ROOT` (welcome state + notice) instead of a dead error tree; `describesMissingFolder` matcher. Reuses the existing read; no extra disk call. | **No — lead-approved for this clause (§7).** |
| `packages/desktop/src/editor/useFileActions.vanishedRoot.test.tsx` | **New, round-2 (§7).** jsdom: a restored vanished folder clears to welcome + notice; a present folder stays. 2 cases. | yes (tests) |
| `packages/core/src/settings/providerSettings.ts` | `backupCorruptConfig()`; `loadProviderSettings` backs up a corrupt `providers.json`. | yes (config loaders, corrupt handling) |
| `packages/core/src/settings/index.ts` | Export `backupCorruptConfig`. | yes (its index glue) |
| `packages/core/src/mcp/userServers.ts` | Back up a corrupt `mcp.json`; fail-closed + back up a corrupt `mcp-trust.json`. | yes (config loaders) |
| `packages/desktop/src/state/AppState.tsx` | `loadPersistedState` preserves corrupt `sketch.ui.v1` under a sidecar key + `info` notice (corrupt-load handling); **round-2 (§7):** new `CLEAR_PROJECT_ROOT` action → welcome state, drops restored tabs, keeps unsaved buffers, sets the notice. | yes (loading corrupted persisted state) + lead-approved for the CLEAR_PROJECT_ROOT action (§7) |
| `packages/core/test/providerSettings.test.ts` | +3 corrupt-backup cases. | yes (tests) |
| `packages/core/test/user-mcp.test.ts` | +2 corrupt-config cases. | yes (tests) |
| `packages/core/test/rpc-server.test.ts` | **New.** 9 RPC-robustness cases. | yes (tests) |
| `packages/desktop/src/lib/stdioClient.test.ts` | +3 process-lifecycle cases. | yes (tests for owned file) |
| `packages/desktop/src/lib/ClientProvider.test.tsx` | +1 unsubscribe-on-unmount case. | yes (tests, invariant 4) |
| `packages/desktop/src/state/settingsPersistence.test.ts` | +2 corrupt-localStorage cases. | yes (tests) |
| `packages/desktop/src/chat-ui.test.tsx` | Un-staled the corrupt-load assertion (regression #1). | yes (root-caused test) |
| `packages/desktop/src/cowork-keys.test.tsx` | Un-staled the conversation-select-root assertion to the W2 contract (regression #2). | yes (root-caused test) |
| `packages/desktop/src/phase3-guards.test.ts` | Un-staled the git-implementation guard to the B-010 one-implementation reality (regression #3). | yes (root-caused test) |
| `packages/desktop/src/styles/themeColors.test.ts` | Lowered two stale tokenisation floors (regressions #4/#5); readability assertion unchanged. | yes (root-caused test) |

**Dependencies added: none.** **Mock data introduced: none.** **Security checks weakened:
none** (the corrupt-config handling fails closed for trust, strips keys as before, and never
deletes user data; the RPC and process code are unchanged, only newly proven). No tracked
file outside the W10 list was changed; the pre-existing dirty worktree was left as-is;
nothing was committed, pushed, stashed, reset, or reverted.

---

## 9. Every command with its result

```
# core typecheck + targeted new tests
cd packages/core && npx tsc --noEmit                                           → exit 0
npx vitest run test/rpc-server.test.ts test/providerSettings.test.ts \
  test/user-mcp.test.ts --pool=forks --poolOptions.forks.singleFork=true       → 3 files, 46 tests pass
npm run build -w @sketch/core                                                  → exit 0

# desktop typecheck + targeted new tests
cd packages/desktop && npx tsc --noEmit                                        → exit 0
npx vitest run src/components/ErrorBoundary.test.tsx \
  src/state/settingsPersistence.test.ts src/lib/stdioClient.test.ts \
  src/lib/ClientProvider.test.tsx --pool=forks --poolOptions.forks.singleFork=true
                                                                               → 4 files, 43 tests pass

# round-2 clauses (§6, §7): rebuild + targeted new tests + both typechecks
npm run build -w @sketch/core                                                  → exit 0
cd packages/core && npx vitest run test/cli-process.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true                             → 1 file, 2 tests pass
cd packages/desktop && npx vitest run \
  src/editor/useFileActions.vanishedRoot.test.tsx \
  src/panels/FileExplorer.test.tsx src/panels/FileExplorer.crud.test.tsx \
  src/panels/FileExplorer.os.test.tsx --pool=forks --poolOptions.forks.singleFork=true
                                                                               → 4 files, 28 tests pass
cd packages/core && npx tsc --noEmit                                           → exit 0
cd packages/desktop && npx tsc --noEmit                                        → exit 0

# full-suite sweep (invariant 1) — commands + counts in §1.1
core:    83 files/1386 + 3 network files/27 = 86 files, 1413 tests pass
desktop: 99 files, 932 tests pass
vite build (desktop):                                                          → ✓ built in 18.78s, exit 0

# mutation checks (each applied, the test re-run, then reverted and re-run green)
error-boundary render returns children unconditionally   → 3 recovery cases FAIL → restored → pass
global reporter skips showNotice                         → 3 notice cases FAIL   → restored → pass
backupCorruptConfig skips the rename                     → 4 corrupt cases FAIL  → restored → pass
RPC exclusive methods treated as non-exclusive           → serialization FAILS   → restored → pass
ensureStarted drops the single-flight guard              → no-double-spawn FAILS → restored → pass
cli.ts unhandledRejection handler removed (rebuilt)      → engine-survives FAILS → restored → pass
FileExplorer vanished-root detector disabled             → clear case FAILS      → restored → pass
```

---

## 10. Remaining limitations

- **The QA-app rebuild + `smoke:boot` was not run** (invariant 7, §7): the host was memory
  CRITICAL/TIGHT (1.2–2.8 GB free) throughout, and a Tauri GNU-toolchain build is far heavier
  than the two suites; running it would risk OOM and disturb the owner's running app and the
  other sessions on this shared machine. Handed to W11, as the invariant allows. The W10
  changes touch no Tauri config, so they cannot change app boot.
- **The 3 network-stateful core files** (`no-egress`, `local-models`, `phase4-gate`) pass in
  their own invocation but fail when all 86 core files share one fork (shared global
  `fetch`/stub state), so the full-core run is split into an 83-file batch + a 3-file batch
  (§1.2). This is a pre-existing test-isolation property of those files, not a product
  defect and not anything W10 changed; every sibling item ran targeted batches for the same
  reason.
- **Two `themeColors.test.ts` floors were lowered** to the current tokenised counts (260/15).
  This tracks the sibling items' legitimate reduction of raw colour literals; the
  load-bearing readability assertion (every examined pair meets the contrast bar) is
  unchanged, so a real theme regression still fails there.
