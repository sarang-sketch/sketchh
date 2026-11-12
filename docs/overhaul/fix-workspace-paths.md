# W2 — Workspace root and path resolution: fix

Item W2 of the Sketch IDE overhaul. Input: W1's audit (`docs/BUG_AUDIT.md` B-001,
`docs/ARCHITECTURE_REVIEW.md` §5(a)/§6, `docs/overhaul/audit-notes.md`). This document is the
whole record for the fix: the reproduction, the root cause with `file:line`, the change in each
file and why it is neither a suppression nor a security relaxation, the real-app verification, the
Windows path cases, the QA build-and-drive recipe, and every test run.

Repo root: `C:\Users\saran\Downloads\sketch`. All anchors are `file:line` at that root.

> **Round 2 note.** The first pass fixed the confusing message and stopped the *silent* root
> switch, but still *narrowed* the workspace on selecting a nested-root conversation in the common
> (no-unsaved-work) case — so invariants 1-2 were not met. This revision implements the lead's
> product decision: selecting a conversation **never** moves the workspace boundary. See §4.2.

---

## 1. What the owner asked, as it applies to W2

Sketch must behave as if the folder the user opened is the one workspace:

1. The **workspace root is the folder the user opened**. It changes only by an explicit user action
   (Open Folder, a recent folder, or a prompt the user confirms) — never as a side effect of
   selecting a conversation, a run, or a link.
2. For one action, **every layer agrees on that root**: the UI `projectRoot`, the engine run root,
   the Rust `command_policy` root, the terminal cwd, chat file links, and the explorer. A nested
   project (a sub-folder with its own `package.json`) is addressed as a **sub-path** of the
   workspace root; a run or a verify step may target a nested project without narrowing the file
   boundary.
3. A path **outside** the workspace root is still refused by `command_policy` (which must not be
   weakened or bypassed), and the refusal tells the user, in plain words, which file, which open
   folder, and what they can do.
4. **Windows paths behave**: drive-letter case, slash direction, spaces, the `\\?\` verbatim prefix
   that `std::fs::canonicalize` returns on Windows (never shown to a user), UNC, relative vs
   absolute, `..`, and junctions/symlinks where testable.

The concrete symptom reported by the owner: Sketch tries to open
`C:\Users\saran\Downloads\unicef india\index.mjs` while "reporting a different workspace boundary."

---

## 2. Reproduction (before the fix)

### 2.1 The real folder shape

The owner's `C:\Users\saran\Downloads\unicef india` has `index.mjs` + `package.json` at its top and
nested projects (`gateway\` — a monorepo with `apps\*`/`packages\*`, each with `package.json` — and
`nekiyaan\` with `server.mjs` + `package.json`), plus a `.sketch\` state dir. The owner's own
`.sketch\events\2026-11-01.jsonl` holds an **architecture** run, not a refusal, so the error text is
reconstructed from the code path below, not quoted from the owner's log. I never opened
`gateway\.env`, anything under `gateway\data\.secrets`, or any credential file, and wrote nothing in
the owner's folder.

### 2.2 The trigger (the sequence that produces the symptom)

1. A conversation (or a workspace entry) carries a stored `root` of a **nested** project, e.g.
   `…\unicef india\gateway` or `…\unicef india\nekiyaan`.
2. The user clicks that conversation in Recents. The old code **narrowed** `projectRoot` to the
   nested dir — silently in the common case — and the reducer closed every open buffer.
3. The user then opens / edits / links `…\unicef india\index.mjs` — the PARENT folder's entry file.
4. `index.mjs` is **above** the now-narrowed root, so Rust's `command_policy` refuses it. The UI
   surfaces the attempted path AND the (narrower, nested) root.

### 2.3 The exact error text, before the fix

The refusal comes from `command_policy::resolve_file_within` → `outside()`, which formatted
`root.display()` of a **canonicalized** `PathBuf`. On Windows `std::fs::canonicalize` returns the
extended-length ("verbatim") form `\\?\C:\…`. So the message the user saw was, literally:

```
file 'C:\Users\saran\Downloads\unicef india\index.mjs' is outside the open project root \\?\C:\Users\saran\Downloads\unicef india\gateway
```

The `\\?\…\gateway` at the end is a Win32 path detail no user ever typed — it reads as "a different
workspace boundary." (Captured from the real code: the pre-fix `outside()` string and the live
`\\?\` prefix were both reproduced by the `the_refusal_names_the_file_and_the_open_folder_without_a_verbatim_prefix`
test with the strip disabled — see §7.4 — which printed
`open folder: \\?\C:\Users\…\sketch-policy-unicef india`.)

### 2.4 Why it could not be driven live in the packaged app — the bounded CDP diagnosis

W1 could not drive the packaged app over CDP. Round 2 ran the bounded diagnosis the lead asked for,
down to the process level, and the answer is definitive: **on this host WebView2 runtime 156 accepts
the `--remote-debugging-port` argument but never opens the DevTools listener.** See §6.4 for the
exact evidence (both the compiled-config and the env-var recipe). So CDP driving of the packaged app
is impossible on this machine; the behaviour is verified instead by the unit/integration tests in §7
(which run the real `command_policy` code and the real `AgentSession`/`Composer`/reducer logic) and a
real-window screenshot of the running app.

---

## 3. Root cause (with `file:line`)

Two defects combined. **W1's account is confirmed**, with the message-formatting half pinned to the
precise lines, and the UI half generalised: the real defect is that **selecting a conversation was
treated as an "open folder" action at all.**

### 3.1 Selecting a conversation changed the workspace boundary (UI)

`packages/desktop/src/panels/agent/ConversationSidebar.tsx`, the `open()` handler. Originally:

```ts
const open = (c) => {
  dispatch({ type: 'SET_CONVERSATION', payload: c.id });
  dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' });
  if (c.root && c.root !== state.projectRoot) dispatch({ type: 'SET_PROJECT_ROOT', payload: c.root });
};
```

`SET_PROJECT_ROOT` (`AppState.tsx:967`) canonicalises and, on a real change, **closes all
`openFiles`, clears `files`/`activeFile`/diagnostics, and resets terminal cwds**. So selecting a
conversation whose stored root was a *nested* project narrowed the one agreed root; `index.mjs`
(above it) was then correctly but confusingly refused. The root of B-001 is that a conversation
selection moved the workspace boundary — regardless of how the switch was gated.

### 3.2 The confusing refusal message (Rust)

`packages/desktop/src-tauri/src/command_policy.rs`. `outside()` and `absolutize()` built their
messages from `root.display()` of a canonicalized `PathBuf` — on Windows the `\\?\C:\…` verbatim
form. There was **no verbatim-prefix stripping anywhere in `src-tauri/src`**. The containment
decision itself is sound (canonicalise both sides, component-wise `starts_with`); only the
**displayed** string was wrong.

### 3.3 What is NOT the cause (leads checked, not assumed)

- **Engine run root.** `rpc/methods.ts` `run()` (`:889`) uses `root = resolve(params.root ?? ctx.cwd())`.
  The desktop always passes an explicit `root` (`lib/AgentSession.tsx`), so the engine never
  self-narrows. Verify stages are read from the run root's own `package.json`
  (`core/src/verify/policy.ts:536`/`:611`) and commands anchored to the run root
  (`anchorVerifyCommands`); a nested project is targeted as a sub-path, never by narrowing the
  boundary. No engine path picks a nested root on its own.
- **Chat file links.** The changed-files/undo/apply handlers resolve against the **run's** root
  (`message.root ?? latest.current.projectRoot` in `lib/AgentSession.tsx`), via `toAbsolutePath`
  (`review/proposals.ts`). A link in an old conversation resolves against the root that run used.
- **`command_policy` containment.** Sound and unchanged (symlinks canonicalised before the prefix
  test; `..` refused early; write targets anchored to the nearest existing ancestor).

---

## 4. The fix

No dependency added. No security check weakened. No error hidden. The central idea of round 2: the
**conversation's root and the workspace boundary are different things.** Selecting a conversation
never moves the boundary; a conversation's *runs* use its own root when that root is inside the open
workspace, and are blocked when it is outside.

### 4.1 Rust — show the folder the user opened, and say what to do

`packages/desktop/src-tauri/src/command_policy.rs` (unchanged since round 1):

- **`display_root()` (`:146`)** strips the Windows `\\?\` / `\\?\UNC\` verbatim prefix for **display
  only** (`\\?\UNC\server\share` → `\\server\share`; `\\?\C:\x` → `C:\x`). On non-Windows it is
  `display()`. The containment test still runs on the real canonical `PathBuf`; only the shown
  string changes, so **nothing about what is allowed changes**.
- **`outside()` (`:229`)** is a plain-words, multi-line message that names the file, names the open
  folder (through `display_root`), and says what to do:

  ```
  This file is outside the folder you have open in Sketch, so it cannot be reached from here:
    file: C:\Users\saran\Downloads\unicef india\index.mjs
    open folder: C:\Users\saran\Downloads\unicef india\gateway
  To work with it, open the folder that contains it (File → Open Folder).
  ```

  It still reports the candidate as the caller gave it (never the resolved/symlink-followed target).
- **`absolutize()` escape message (`:200`)** is also routed through `display_root`.

This is message/formatting only — **not** a suppression (the path is still refused) and **not** a
relaxation (the containment comparison is byte-identical).

### 4.2 TypeScript — selecting a conversation never moves the workspace boundary

The shared decision lives in one pure helper so every consumer agrees:
`packages/desktop/src/editor/paths.ts` `conversationRootRelation(workspaceRoot, conversationRoot)`
returns `none` | `inside` | `outside` (case/slash-insensitive via `isWithinRoot`; `inside` includes
the equal case; a sibling whose name is a prefix of the workspace, e.g. `project-2` under `project`,
is `outside`).

**`panels/agent/ConversationSidebar.tsx` `open()` (`:57`)** — selecting a conversation:
- **no folder open yet**: adopt the conversation's root as the workspace through the guarded
  `openFolderPath` (nothing to lose), then select.
- **otherwise** (a folder is open, or the conversation has no root): **select only.** The workspace
  root, open buffers, and terminal cwd are never touched here.

So whether the conversation's root is the workspace itself, a nested project, another folder, or a
parent of the open one, **selecting it does not move the boundary** — `../index.mjs` in the editor
keeps working because the editor/explorer/`command_policy` boundary stays the workspace root.

**`lib/AgentSession.tsx` `startRun()`** — the *run* root follows the conversation:
```ts
const workspaceRoot = snapshot.projectRoot
const active = snapshot.conversations.find((c) => c.id === snapshot.activeConversationId)
const convRoot = active?.root ? canonicalPath(active.root) : null
const runRoot = conversationRootRelation(workspaceRoot, convRoot) === 'inside' ? convRoot : workspaceRoot
const root = runRoot ?? undefined
```
A conversation rooted **inside** the workspace runs against its own (possibly nested) root, because
its history and `@file` references are relative to it; everything else runs against the workspace
root. A conversation rooted **outside** never reaches here — the composer blocks its send.

**`panels/agent/Composer.tsx`** — the send guard. When the active conversation's root is `outside`
the workspace, `submit()` short-circuits with a plain system note ("This conversation ran in
`<folder>` … Open that folder to continue it …") and starts no run; pure local actions (`/clear`,
`/undo`) are still allowed. The Send button is disabled with the same reason in its tooltip.

**`panels/agent/AgentChat.tsx`** — the visible cue, `ConversationRootNotice`:
- `inside` but not the workspace root itself → a quiet "**Runs in `<relative path>`**" line.
- `outside` → a plain notice "**This conversation ran in `<folder>`. Open that folder to continue
  it.**" with a guarded **Open folder** button (`openFolderPath`).
- nothing when the conversation has no root or runs at the workspace root.

None of this touches `command_policy`: the one agreed root changes only by an explicit, confirmable
action, and a run never executes against a root the open workspace does not contain.

---

## 5. Files modified

| File | Change | In original list? |
|---|---|---|
| `packages/desktop/src-tauri/src/command_policy.rs` | `display_root()`; rewrote `outside()` + the `absolutize()` escape message; updated test assertions; added the verbatim-prefix test. | yes |
| `packages/desktop/src/editor/paths.ts` | Added `conversationRootRelation()` (the shared inside/outside/none decision). | yes |
| `packages/desktop/src/editor/paths.test.ts` | Added a `conversationRootRelation` describe block. | yes (tests for owned files) |
| `packages/desktop/src/panels/agent/ConversationSidebar.tsx` | `open()` never moves the workspace root; adopts only when no folder is open. | yes |
| `packages/desktop/src/lib/AgentSession.tsx` | Run root = the active conversation's own root when inside the workspace, else the workspace root. | yes (root passing only) |
| `packages/desktop/src/panels/agent/Composer.tsx` | Blocks send when the active conversation's root is outside the workspace; Send button disabled with the reason. | yes (round-2 grant: notice + send guard only) |
| `packages/desktop/src/panels/agent/AgentChat.tsx` | `ConversationRootNotice`: "Runs in `<rel>`" / the outside notice + guarded Open-folder button. | yes (round-2 grant: notice only) |
| `packages/desktop/src/panels/agent/ConversationSidebar.test.tsx` | **New.** (a)/(b)/(c) + equal-spelling + parent cases. | yes (tests) |
| `packages/desktop/src/panels/agent/AgentSession.runRoot.test.tsx` | **New.** run root follows the conversation; outside blocks the run. | yes (tests) |
| `packages/desktop/scripts/qa-drive.mjs` | **New.** CDP driver for a QA build (for hosts whose WebView2 honours a debug port). | yes (a QA script) |
| `packages/desktop/scripts/qa-window-shot.ps1` | **New.** PrintWindow capture of the QA app's own window — the method that WORKS on this host (no CDP). | yes (a QA script) |
| `packages/desktop/src-tauri/qa.conf.json` | **New.** QA build config override (QA identifier/productName, debug port, empty `beforeBuildCommand`). | **No — outside the original list.** Kept at the lead's instruction; it is the QA build input the recipe in §6 references. |
| `packages/desktop/package.json` | Added the `qa:drive` script entry. | **No — outside the original list.** Kept at the lead's instruction; it wires up the QA driver as `npm run qa:drive`. |

**Dependencies added: none** (expected). **Mock data introduced: none. Security checks weakened:
none.**

---

## 6. QA build-and-drive recipe (so every later item can drive the real app)

The owner's installed Sketch runs with the production identifier `dev.sketch.desktop`. WebView2 runs
one browser process per data folder and finds that folder from the identifier via the Windows
known-folder API, so a second app with the SAME identifier attaches to the owner's webview. **Always
build a QA variant with a DIFFERENT identifier**, and never launch a production-identifier build
while the owner's app runs.

### 6.1 Prerequisites

No MSVC linker on this host (`link.exe` → LNK1181, no Windows SDK), so builds use the GNU toolchain
`stable-x86_64-pc-windows-gnu` (WinLibs MinGW). Memory is usually tight: `CARGO_BUILD_JOBS=2`.

### 6.2 Build the QA app (does NOT touch the owner's installer)

```powershell
# from the repo root
$env:SKETCH_TARGET_TRIPLE = 'x86_64-pc-windows-gnu'     # sidecar binary suffix must match the toolchain
npm run build:sidecar -w @sketch/desktop                 # rebuild the engine sidecar bundle (only if engine changed)
npm run build -w @sketch/desktop                         # tsc -b + vite build -> fresh dist (the TS fix)

cd packages\desktop
$env:CARGO_BUILD_JOBS = '2'
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'   # use the GNU rustc/linker
npx tauri build --debug --no-bundle --config src-tauri/qa.conf.json
```

`src-tauri/qa.conf.json` overrides `productName`→"Sketch QA", `identifier`→`dev.sketch.desktop.qa`,
sets `app.windows[0].additionalBrowserArgs` to `--remote-debugging-port=9333 --remote-allow-origins=*`,
and sets `build.beforeBuildCommand` to `""` (the sidecar + dist were built above, so Tauri compiles
Rust only). Output: `packages\desktop\src-tauri\target\debug\sketch-desktop.exe`. **`target\release\bundle`
(the owner's installer) is never written** (`--no-bundle`, debug profile). Confirm the identifier
baked in: the exe contains `dev.sketch.desktop.qa`. A GNU-toolchain link warning — `.rsrc merge
failure: multiple non-default manifests` — is benign; the binary is produced.

### 6.3 Boot-check (always, after any Rust or config change)

```powershell
npm run smoke:boot -w @sketch/desktop -- --exe packages/desktop/src-tauri/target/debug/sketch-desktop.exe --seconds 20
```

Throwaway home + fresh webview profile; PASS means the real runtime booted and stayed up with no
panic. **Never** run it against the production-identifier exe while the owner's app runs.

### 6.4 Drive it — and the definitive CDP finding on this host

**On a host whose WebView2 honours the debug port**, drive over CDP:
```powershell
node packages/desktop/scripts/qa-drive.mjs --exe packages/desktop/src-tauri/target/debug/sketch-desktop.exe --shot 00-after.png --seconds 35
```
It launches isolated, connects to `127.0.0.1:9333`, screenshots into `picture\overhaul\w2\`, probes
the page text, and stops the app and its children. `--seed-root <path>` seeds an opened folder into
localStorage and reloads, so a project opens without the native picker.

**On THIS host, CDP does not work — diagnosed at the process level (round 2).** The QA exe was
launched isolated and its OWN `msedgewebview2` subtree inspected (direct `ParentProcessId` walk, so
the owner's webview is never touched):

- **Compiled-config method** (`additionalBrowserArgs`): the browser (main) webview process showed
  `--remote-debugging-port` present (`debugPort=True`) and `--user-data-dir` pointing at the isolated
  throwaway profile — so the argument **did reach the browser process** — yet that process had **no
  listening ports**, and `GET http://127.0.0.1:9333/json/version` failed ("Unable to connect").
- **Env method** (the recipe that worked here in October:
  `WEBVIEW2_USER_DATA_FOLDER=<fresh empty>` + `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9355 --remote-allow-origins=*"`):
  identical outcome — arg present on the browser process, isolated data folder, **no listener**,
  probe failed.

Conclusion: **WebView2 runtime 156 accepts the debug-port argument but does not open the DevTools TCP
listener** on this machine, by either path. The October recipe no longer works because the runtime
was updated to 156. This is an environment limitation, not a product bug, and it is now diagnosed
rather than assumed.

**The working capture method on this host** (no CDP): `qa-window-shot.ps1` renders the QA app's OWN
window via `PrintWindow(PW_RENDERFULLCONTENT)` — it does not read the screen region, so an overlapping
window from any other app (including the owner's Sketch) is never captured:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packages\desktop\scripts\qa-window-shot.ps1 `
  -Exe 'C:\Users\saran\Downloads\sketch\packages\desktop\src-tauri\target\debug\sketch-desktop.exe' `
  -Out 'C:\Users\saran\Downloads\sketch\picture\overhaul\w2\02-after-round2-qa-running.png' -Seconds 16
```
Captured: `picture\overhaul\w2\01-after-qa-app-running.png` (round 1) and
`picture\overhaul\w2\02-after-round2-qa-running.png` (round 2) — the running app's first-run
"Connect a model" screen over a fresh isolated home.

### 6.5 Cleanup

Every launch uses a throwaway `%TEMP%` home and stops the app (and its children) when done. After
this item: only the owner's app (pid 21768) was left running; no QA process, dev server, or browser
remained; the owner's `~/.sketch`, installed app, webview profile, and `unicef india` folder were
untouched.

---

## 7. Tests, typecheck, and mutation checks (every command + result)

Each typecheck/test ran in a **later step** than the edits it checks.

### 7.1 TypeScript unit/integration tests (vitest)

`--maxWorkers=1` is unusable here: vitest 2.1.9 throws
`RangeError: options.minThreads and options.maxThreads must not conflict`. Serial execution was
forced with `--pool=forks --poolOptions.forks.singleFork=true`.

```
cd packages/desktop
npx vitest run src/editor/paths.test.ts src/panels/agent/ConversationSidebar.test.tsx \
  src/panels/agent/AgentSession.runRoot.test.tsx src/panels/agent/AgentChat.test.tsx \
  --pool=forks --poolOptions.forks.singleFork=true
→ Test Files 4 passed (4);  Tests 34 passed (34)
   (paths 14, ConversationSidebar 5, AgentSession.runRoot 3, AgentChat 12)
```

- `ConversationSidebar.test.tsx` — (a) a nested-root conversation is selected with projectRoot, open
  buffers and terminal cwd unchanged; (a-equal) the same folder spelled differently selects with no
  switch; (b) an outside-folder conversation is selected without changing the root; (b-parent) a
  parent-rooted conversation does not widen the workspace; (c) with no folder open, selecting adopts
  the root.
- `AgentSession.runRoot.test.tsx` — a follow-up runs against the conversation's own root when inside
  the workspace; against the workspace root when the conversation has no root; and does NOT run (with
  an "open that folder" notice) when the conversation ran outside the workspace.
- `AgentChat.test.tsx` — the existing 12 cases still pass, so the Composer/AgentChat changes did not
  regress the normal send path.

### 7.2 TypeScript typecheck

```
cd packages/desktop
npx tsc --noEmit
→ exit 0, no errors
```

### 7.3 Rust unit tests (`command_policy`, unchanged this round)

```
cd packages/desktop/src-tauri/src
rustc +stable-x86_64-pc-windows-gnu --test command_policy.rs -o <tmp>.exe   → compile exit 0
<tmp>.exe
→ test result: ok. 19 passed; 0 failed
```

### 7.4 Mutation checks (proving the new tests are not vacuous)

- **Run root follows the conversation.** Forcing `const root = workspaceRoot` in `AgentSession`
  (ignoring the conversation root) made the "nested root" case FAIL — the run used
  `C:/Users/me/project` instead of `C:/Users/me/project/web-app`. Restored → pass.
- **Outside send is blocked.** Disabling the Composer guard (`if (false && …)`) made the "does not run
  a conversation that ran outside" case FAIL — `run` was called once. Restored → pass.
- **Selecting never moves the root.** Re-introducing the silent switch in `ConversationSidebar.open`
  made the (a) nested, (b) outside, and (b-parent) cases FAIL — `projectRoot` changed — while the
  equal-spelling and fresh-open cases still passed. Restored → all pass.
- **Rust strip (round 1, re-confirmed).** Disabling the `\\?\` strip made the verbatim-prefix test
  FAIL with `the open-folder line still shows a verbatim prefix: open folder: \\?\C:\Users\…`.
  (That FAIL output is the source of the before-fix message text in §2.3.)

### 7.5 Real-app boot

```
npm run smoke:boot -w @sketch/desktop -- --exe …/target/debug/sketch-desktop.exe --seconds 20
→ smoke:boot: PASS — still running after 20s, no panic.   (run against the round-2 QA build)
```

---

## 8. Windows path cases

| Case | Status | How / why |
|---|---|---|
| Drive-letter case (`c:` vs `C:`) | **Tested** | TS `canonicalPath` upper-cases the drive; the same-folder ConversationSidebar test and `conversationRootRelation` tests mix `c:\…` and `C:/…`. Rust `resolve_root` canonicalises. |
| Forward vs back slashes | **Tested** | `canonicalPath` converts `\`→`/`; the sidebar + relation tests mix both. Rust canonicalisation is slash-agnostic. |
| Spaces in names (`unicef india`) | **Tested** | Rust `the_refusal_names_the_file_…` uses a scratch root named `unicef india`; no shell is involved (args pass as literal bytes). |
| `\\?\` verbatim prefix | **Tested** | `display_root` strips it; the Rust test asserts the open-folder line carries no `\\?\` and (on Windows) that the real canonical path still begins with `\\?\`. Mutation-checked (§7.4). |
| UNC (`\\server\share`) | **Partially tested** | `display_root` maps `\\?\UNC\server\share` → `\\server\share` (unit-covered); `canonicalPath` has a UNC branch. Not exercised against a live UNC mount (none available). |
| Relative vs absolute | **Tested** | Rust `absolutize`/`resolve_within` tests; TS `toAbsolutePath`. |
| `..` traversal | **Tested** | Rust `a_parent_escape_is_refused_before_the_disk_is_touched` ("escapes the open folder"); refused before the disk is touched. |
| Junctions / symlinks | **Tested where permitted** | Rust `a_symlink_out_of_the_root_is_refused` creates a real symlink when the OS permits (Windows needs Developer Mode/elevation) and otherwise self-reports SKIPPED; containment canonicalises links before the prefix test either way. |
| Sibling prefix (`project-2` under `project`) | **Tested** | `conversationRootRelation` returns `outside` — component-wise containment via `isWithinRoot`. |

---

## 9. Behaviour after the fix

- **Selecting a conversation never moves the workspace boundary.** With `C:/Users/me/project` open:
  - selecting a conversation rooted at `project/web-app` (nested) keeps `projectRoot`, the open
    buffers and the terminal cwd; `project/index.mjs` stays reachable in the editor. The chat shows a
    quiet "**Runs in web-app**" line, and follow-up runs in that conversation use `project/web-app`
    as their root.
  - selecting a conversation rooted at another folder, or at a **parent** of the open one, keeps the
    workspace root and shows "**This conversation ran in `<folder>`. Open that folder to continue
    it.**" with a guarded **Open folder** button; the composer **blocks send** (no run executes
    against the wrong root) until the user opens that folder.
  - with **no folder open**, selecting a conversation adopts its root as the workspace (nothing to
    lose).

  (Earlier this doc said a nested switch "goes through the Save/Don't-Save/Cancel prompt." That was
  wrong: the prompt only ever appeared when there was unsaved work, so the common case still narrowed
  the workspace. The behaviour above replaces it — selecting does not switch at all.)
- **Message (Rust):** a path above the open folder is still refused, but the message is verbatim-
  prefix-stripped and actionable:
  ```
  This file is outside the folder you have open in Sketch, so it cannot be reached from here:
    file: C:\Users\saran\Downloads\unicef india\index.mjs
    open folder: C:\Users\saran\Downloads\unicef india\gateway
  To work with it, open the folder that contains it (File → Open Folder).
  ```
- **Real runtime:** the round-2 QA build boots clean (smoke:boot PASS, §7.5) and runs
  (`picture\overhaul\w2\02-after-round2-qa-running.png`).

Proven by the 34 tests (§7.1) and the four mutation checks (§7.4).

---

## 10. Remaining limitations

- **No live CDP screenshot of the native refusal in the packaged app.** Diagnosed at the process
  level (§6.4): WebView2 runtime 156 on this host accepts `--remote-debugging-port` (it reaches the
  browser process) but opens no listener, by either the compiled-config or the env-var recipe. The
  refusal and the new selection/run behaviour are verified against the exact code by the tests. On a
  host whose WebView2 honours the debug port, `qa-drive.mjs` (`--seed-root`) reproduces the full flow
  live (open the parent folder, select a nested-root conversation, open `index.mjs`).
- **UNC not exercised against a live share** (none available) — only the `display_root` mapping and
  the `canonicalPath` UNC branch are unit-covered.
- The two git-status parsers (B-010) and other W1 findings are out of W2's scope (other items).

---

## 11. Owner-safety confirmation

- The owner's **installed app** (`AppData\Local\Sketch\sketch-desktop.exe`, pid 21768) was never
  stopped, changed, or reconfigured; it was left running. Every QA launch (build, boot, screenshot,
  CDP diagnosis) targeted only the `dev.sketch.desktop.qa` debug exe and stopped only that instance,
  matched by its `target\debug` path / its own process subtree, never the owner's pid or its webview.
- The owner's **data** was untouched: every launch used a throwaway `%TEMP%` home and a fresh
  WebView2 profile, so `~/.sketch` and `%LOCALAPPDATA%\dev.sketch.desktop\EBWebView` were not read or
  written. No API key was saved, changed, or removed through any build.
- The owner's **`unicef india` folder** was not modified. `.sketch` files there were read read-only;
  `gateway\.env`, `gateway\data\.secrets`, and other credential files were never opened; the repro
  used a scratch layout under `%TEMP%`.
- The **owner's installer** (`packages\desktop\src-tauri\target\release\bundle`) was not overwritten
  or deleted (the QA build is `--debug --no-bundle`).
- No tracked file outside the W2 ownership list was changed, except `package.json` (one `qa:drive`
  script entry) and the new `qa.conf.json`, both kept at the lead's instruction and listed in §5. The
  ~120 pre-existing dirty files in the worktree were left as they were; nothing was committed,
  pushed, stashed, reset, or reverted.
