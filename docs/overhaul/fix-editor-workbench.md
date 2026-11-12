# W8 — The Code workbench: fix

Item W8 of the Sketch IDE overhaul. It owns the Code surface: the file lifecycle
(open/create/rename/delete/save), tabs/breadcrumbs/context menus/shortcuts, find and
replace, the terminal, the Git panel, Run + preview, file watchers and large files —
at every window size. Inputs read first as leads, not facts: `docs/BUG_AUDIT.md`
(B-010 and the UNTESTED editor/terminal/git list), `docs/UI_UX_AUDIT.md` (Code
section), `docs/ARCHITECTURE_REVIEW.md` §5(a)/§5(f)/§5(g)/§6, and the earlier fix docs
`fix-workspace-paths.md` (W2 — paths.ts/fileIo.ts behaviour and the QA build recipe
§6), `fix-design-system.md` (W3 — tokens and `sk-*` classes), `fix-chat-panel.md`
(W6), `fix-agent-engine.md`/`fix-ai-providers.md`/`fix-skills-mcp.md` (W4/W5) — none of
whose behaviour this item undoes.

Repo root: `C:\Users\saran\Downloads\sketch`. All anchors are `file:line` at that root.
No provider API key was used or requested: every run drove the engine's fake provider
(`SKETCH_FAKE_PROVIDER=1`) or a keyless local provider. No tracked file outside the W8
ownership list was changed, except the three files the lead granted in round 7 for the
cross-item policy-wording regression (§4) — all listed in §10. The ~120 pre-existing
dirty files in the worktree were left as they were; nothing was committed, pushed,
stashed, reset, or reverted. Every QA launch used a throwaway `%TEMP%` home and stopped
the vite/Edge processes it started, by the PIDs it launched.

---

## 1. What the owner asked, as it applies to W8

The Code surface should feel like a finished, reliable IDE: a file opens, edits, saves
and closes without losing work; tabs, breadcrumbs, context menus and keyboard shortcuts
all do what they say; find/replace lands on the right line; the terminal streams,
stops, and leaves no orphan process; the Git panel does the whole working-tree workflow
with one source of truth; Run detects the project's scripts and runs them; nothing
overflows or overlaps at any window size; and every panel carries its loading, empty,
error and offline states on W3's tokens. The owner named one defect here — **B-010**,
the two git-status parsers — which W8 collapses to one.

## 2. Summary of findings

The Code workbench was already mature from earlier rounds: the file lifecycle
(`editor/useFileActions.ts`), the Explorer (`panels/FileExplorer.tsx`), the Git owner
(`git/GitProvider.tsx`) and the engine's git/fs/find/terminal tools
(`packages/core/src/tools/*`) were built and unit-covered. W8's correct engineering
call (owner rule 1) was to leave the working behaviour untouched, prove each invariant
at the honest layer, and spend the budget on the two real defects and the design pass:

| Invariant | State found | Action |
|---|---|---|
| 1. File lifecycle | Complete (save/save-all/dirty markers, close-asks-to-save, inline create with the `editingRef` once-guard, rename, trash delete, 2 MB/binary refusal, diskSync/projectWatcher) | **Verified** (jsdom + RPC); no code change needed |
| 2. Tabs & editor | Tabs scroll+reorder, switch, close; syntax via Monaco; empty/loading/error states; breadcrumbs; every context-menu item; shortcuts. **No split editor exists.** | **Verified**; split recorded as a limitation (not built) |
| 3. Search | find/replace land on the right line, respect .gitignore + root, distinct empty/no-match/error, replace confirms | **Verified** (RPC + jsdom) |
| 4. Terminal | open/close tabs, stream, Ctrl+C kills the tree, cwd contained, PowerShell/pwsh/cmd profiles, PTY resize, no orphans, links | **Verified** (RPC + jsdom) |
| 5. Git + **B-010** | full workflow on one engine parser; **two git-status parsers still existed in Rust** | **Fixed** (B-010): the native `git_status`/`git_diff` removed |
| 6. Run + preview | package.json/Makefile/py/rust/go scripts, each in a terminal tab with Stop; http(s) links open safely; breakpoint debug stated absent | **Verified** |
| 7. Every size | — | **Proved** 0 overflow at 6 sizes × 9 views over the dev preview |
| 8. States & tokens | Mostly tokenised; `EditorArea.module.css` carried 46 colour literals | **Tokenised** (46→2) |
| — Cross-item regression | W2's Rust message reword left `fileIo.ts`/`commandLine.ts` keyed on the OLD wording | **Fixed** (§4), lead-approved |

---

## 3. Invariant 5 / B-010 — one git-status parser, not two

### Before (evidence)
`docs/BUG_AUDIT.md` B-010 and `docs/ARCHITECTURE_REVIEW.md` §6(1): two porcelain
parsers existed. The authoritative one is `packages/core/src/tools/git.ts` (handles
renames `R old -> new`, C-quoted/non-ASCII paths, detached HEAD, "no commits yet", and a
non-zero exit code); the Git panel, the status bar, the diff view and the editor's
change markers all read it through the `SketchClient` seam (`git/GitProvider.tsx:127`,
`:144`, `:244` call `client.gitStatus({root})` / `client.gitDiff({…})` — the ENGINE RPC
methods, param shape `{ root }`). The second parser was the Rust
`main.rs` `git_status`/`git_diff` (`#[tauri::command]`), a fixed-offset splitter with
none of those cases, kept only for the bridge wrappers in `ipc/bridge.ts`.

### Root cause (file:line)
`packages/desktop/src-tauri/src/main.rs` `git_status` + `git_diff` and the `GitStatus`
struct; `packages/desktop/src/ipc/bridge.ts` `gitStatus`/`gitDiff` wrappers + the
`GitStatus` interface. First I verified **nothing calls them**: a repo-wide search for
`gitStatus(`/`gitDiff(` and for any import of those names from `bridge` found only (a)
the engine-RPC `client.gitStatus({root})` callers and `SketchClient` mocks (object
param — a different method), and (b) the bridge's own definitions. No import of the
bridge wrappers exists anywhere. So the Rust pair was a dead second source of truth AND
a webview-reachable path that spawned `git`.

### The fix
Per the lead's B-010 decision ("if nothing calls them, remove those two native
commands, their bridge wrappers and their tests; that also removes a webview-reachable
path that runs git; `command_policy.rs` stays untouched"):

- `main.rs`: removed `fn git_status`, `fn git_diff`, the `struct GitStatus`, and both
  entries from `generate_handler!`. Replaced the Git-commands section with a comment
  that records git is an engine capability now (B-010).
- `ipc/bridge.ts`: removed the `gitStatus`/`gitDiff` wrappers and the `GitStatus`
  interface; the module header now says git is not here.
- `ipc/wireShape.test.ts`: dropped `'GitStatus'` from `RETURNED_TO_WEBVIEW` (the test
  asserts the Rust-struct set equals that list exactly).

`command_policy.rs` is unchanged (per the grant). Its `resolve_pathspec_within` is now
only used by the removed `git_diff`, so `cargo check` emits one `never used` warning for
it — an expected, documented consequence of the removal, left in place because the brief
forbids touching `command_policy.rs`.

### Proof after (layer: RPC + Rust compile + TS static)
- The one git parser works end to end over the engine RPC and through the panel —
  `test/git.test.ts` (32) + `test/git-more.test.ts` (9) against REAL repos
  (status/stage/unstage/commit/discard/branches/switch/log/push/pull/AI-message), and
  `panels/GitPanel.test.tsx` (10) + `panels/GitPanel.more.test.tsx` (7) drive those
  through the panel's own buttons. §7.
- `security.test.ts` "names only commands that exist in main.rs" stays green: the
  bridge no longer invokes `git_status`/`git_diff`, and `main.rs` no longer defines
  them, so the two sides remain consistent.
- `ipc/wireShape.test.ts` passes with 3 structs (FsEntry, CommandOutput,
  ProviderKeyPresence).
- **Rust compile:** `cargo check` (GNU, `CARGO_BUILD_JOBS=2`) exits 0 after the removal;
  the only warning is the expected `resolve_pathspec_within is never used`. §7.
- `npx tsc --noEmit` exit 0. §7.

---

## 4. Cross-item regression — the policy-refusal wording (lead-approved, round 7)

### Before (evidence)
W2 (`fix-workspace-paths.md` §4.1) rewrote `command_policy.rs`'s containment refusal
from `"<x> is outside the open project root <root>"` to the actionable, verbatim-prefix-
stripped `"This <x> is outside the folder you have open in Sketch … open the folder …"`,
and the parent-escape message from `"escapes the project root"` to `"escapes the open
folder"`. Two TypeScript layers match the WORDS of that refusal and were left on the OLD
wording:

- `editor/fileIo.ts` `describeFileFailure` matched `'outside the open project root'` /
  `'escapes the project root'` — neither of which the current Rust emits — so a
  legitimately refused out-of-project path fell through to the generic branch and the
  editor showed the whole multi-line Rust string appended after "Cannot open X:".
- `terminal/commandLine.ts` `classifyRunFailure` had the same stale phrases in its
  `DENIAL_PHRASES`, so a terminal command refused for being outside the project was
  mis-classified as a breakage (`failed`) rather than a denial (`denied`).
- `lib/security.test.ts:138` still asserted `command_policy.rs` contains `'outside the
  open project root'` — a stale assertion that failed on the current Rust source. (This
  is the failure W8 first surfaced; it predated any W8 edit — both
  `command_policy.rs` and `security.test.ts` are W2's and were already dirty.)

Neither is a security hole — the Rust side still refuses — but both are the "hide an
error behind a vaguer one" failure the overhaul exists to remove.

### Root cause (file:line)
`editor/fileIo.ts` `describeFileFailure` (the two stale `lower.includes(...)` branches);
`terminal/commandLine.ts` `DENIAL_PHRASES` (stale literals); plus the test doubles and
fixtures that reproduced the OLD Rust refusal shape (`editor/fakeDisk.ts`,
`panels/FileExplorer.test.tsx`, `test/engineHarness.ts`, `phase3-gate.test.tsx`,
`editor/editor.test.tsx`, `editor/fileIo.test.ts`, `terminal/commandLine.test.ts`) and
`lib/security.test.ts:138`.

### The fix (the lead's approved plan)
- **New `packages/desktop/src/ipc/policyMessages.ts`** — the single list of the
  refusal phrases, `CURRENT_POLICY_PHRASES` (what `command_policy.rs` emits today) and
  `LEGACY_POLICY_PHRASES` (pre-W2, kept so a not-yet-rebuilt engine's message is still
  recognised), plus the predicates `isOutsideProjectRefusal`, `isNoProjectRootRefusal`
  and `isDenialMessage` / `DENIAL_PHRASES`.
- `editor/fileIo.ts` `describeFileFailure` now calls `isOutsideProjectRefusal` /
  `isNoProjectRootRefusal`; it stays one clear message that names the operation and the
  file ("Cannot open `id_rsa`: it is outside the folder open in Sketch. To work with it,
  open the folder that contains it (File → Open Folder).").
- `terminal/commandLine.ts` `classifyRunFailure` now calls `isDenialMessage`.
- The doubles throw the CURRENT Rust shape (`fakeDisk.ts`, `FileExplorer.test.tsx`,
  `engineHarness.ts`, `phase3-gate.test.tsx`, `editor.test.tsx`); `fileIo.test.ts` keeps
  a LEGACY phrase on purpose, to prove the legacy matcher still fires; `commandLine.test`
  asserts both current and legacy wording classify as `denied`.
- `lib/security.test.ts:138` now asserts the CURRENT wording, and a new contract-test
  block asserts every `CURRENT_POLICY_PHRASES` value is present in `command_policy.rs`,
  so the next reword fails here loudly instead of regressing the UI quietly. No other
  security assertion is weakened. `command_policy.rs` is untouched.

### Proof after (layer: jsdom + static contract)
- `editor/fileIo.test.ts` (10) — containment refusal (current AND legacy wording) → one
  clean message naming the file; `editor/editor.test.tsx` (17) — a refused save shows
  "outside the folder open in Sketch" and keeps the tab dirty;
  `terminal/commandLine.test.ts` (19) — current + legacy denials classify as `denied`,
  breakages as `failed`; `lib/security.test.ts` (40+, incl. the new contract block);
  `FileExplorer.test.tsx` (15), `phase3-gate.test.tsx` (1). All green. §7.
- **Mutation checks (non-vacuity):**
  - setting a `CURRENT_POLICY_PHRASES` value to a string NOT in the Rust source made the
    new contract test FAIL (1 failed) — restored → pass.
  - disabling `isOutsideProjectRefusal` (`return false && …`) made 4 cases across
    `fileIo.test.ts` + `editor.test.tsx` FAIL — restored → pass.

---

## 5. Invariants verified without a code change (how each was proved)

**Invariant 1 — file lifecycle.** `editor/useFileActions.ts` + `state/AppState.tsx`:
open/activate, `save`/`saveAll` with format-on-save, `closeMany` asks Save / Don't Save
/ Cancel for dirty tabs, create file/folder, rename, move, trash delete with a permanent
fallback and an unsaved-changes warning. `panels/FileExplorer.tsx` holds the inline name
box's state in `editingRef` so Enter-then-blur creates once (`commit()` reads
`editingRef.current`). Large/binary refusal is in `editor/fileIo.ts`
(`MAX_OPEN_BYTES = 2_000_000`, `looksBinary`). *Proof:* jsdom — `editor/editor.test.tsx`
(17), `editor/editorFeatures.test.tsx` (8, auto-save waits for typing to stop and does
not format), `editor/diskSync.test.tsx` (17, auto-save never resurrects a branch-switch-
removed file; a save is not mistaken for a disk change), `editor/projectWatcher.test.tsx`
(5), `panels/FileExplorer.crud.test.tsx` (7), `explorer/fileTree.test.ts` (10). RPC —
`test/fsops.test.ts` (12), `test/fsops-rename-recovery.test.ts` (1).

**Invariant 2 — tabs & editor.** Tab bar scrolls and reorders
(`components/EditorArea.module.css` `.tabBar` overflow-x + `.tabDragging`); Ctrl+Tab /
PageUp/PageDown switch, Ctrl+W closes (`EditorArea.tsx` keydown). Empty state
("emptyEditor"), load failure ("editorFailure"), file errors (the notice bar), and
breadcrumbs with clickable folder links are all in `EditorArea.tsx`/`.module.css`.
Context menus: `panels/FileExplorer.tsx` `menuItems` (New File/Folder, Open, Rename F2,
Delete Del, Copy Path, Copy Relative Path, Reveal, Open in Integrated/External Terminal,
Ask Sketch, Refresh, Collapse All). *Proof:* jsdom — `editor/DiffView.test.tsx` (6,
against a real repo), `panels/FileExplorer.test.tsx` (15), `panels/FileExplorer.os.test.tsx`
(4). **Split editor:** no split command, button, or state exists anywhere in the source
(searched `splitEditor|SplitEditor|splitView|SPLIT_`); per the invariant it is NOT built
— recorded as a limitation (§11).

**Invariant 3 — search.** `packages/core/src/tools/findReplace.ts` via `find-in-files`
/ `replace-in-files`; `panels/ide/SearchPanel.tsx` opens a hit at the right file+line and
confirms a multi-file replace. *Proof:* RPC — `test/find-replace.test.ts` (18),
`test/project-search.test.ts` (14, .gitignore + root respected, caps, distinct
empty/no-match/error). jsdom — `panels/ide/SearchPanel.test.tsx`.

**Invariant 4 — terminal.** `packages/core/src/tools/terminal.ts` via `term-start`
(refuses without `confirmed:true`) / `term-read` / `term-write` / `term-kill`; cwd
contained; PowerShell 5.1 / pwsh / cmd profiles from `terminal_ipc.rs`
`terminal_profiles`; PTY resize via `terminal_resize`; `main.rs` `RunEvent::Exit` closes
all shells (no orphans). *Proof:* RPC — `test/terminal.test.ts` (13: streams while
running, stops a forever command, `&&`/`||` chains, term-start/read through the method
table). jsdom — `panels/ide/Terminal.test.tsx` (14, looks at the disk while a long
command prints), `panels/ide/ShellTerminal.test.tsx` (4), `terminal/ShellSessions.test.tsx`
(16), `terminal/ansi.test.ts` (4), `terminal/commandLine.test.ts` (19),
`terminal/links.test.ts` (8).

**Invariant 6 — Run + preview.** `panels/ide/RunPanel.tsx` + `run/scripts.ts` detect
package.json scripts (right package manager), Makefile targets, and Python/Rust/Go entry
points, each run in its own terminal tab with a Stop; a Stop within
`RUN_DOUBLE_CLICK_MS` of the same Run is ignored (double-click guard). Breakpoint
debugging is stated absent rather than faked. Preview: terminal `http(s)://` links are
the only scheme `terminal/links.ts` linkifies, so a click only ever hands an http/https
URL to the opener; file/folder "open externally" goes through
`core/src/tools/desktopOpen.ts` (shell:false, contained path). *Proof:* jsdom —
`panels/ide/RunPanel.test.tsx` (3), `run/scripts.test.ts` (5), `terminal/links.test.ts`
(8). RPC — `test/desktopOpen.test.ts` (8).

**Invariant 7 — every size.** Proved over the Vite dev preview in headless Edge via the
new `packages/desktop/scripts/w8-code-shots.mjs`. The first-run Connect-a-model dialog
was dismissed by seeding a keyless `custom` provider into the isolated home's
`providers.json` and `selectedProvider`/`selectedModel` into localStorage (the method
`w4-ui-proof.mjs` uses), so the Code surface — not a modal — was measured. For each of
1920×1080, 1600×900, 1366×768, 1280×720, 1024×640, 900×600 (the app's
`tauri.conf.json` minimum), each of the 9 activity-bar views was opened and
`documentElement.scrollWidth` vs `clientWidth` recorded.

| Size | Views opened | Horizontal overflow (any view) |
|---|---|---|
| 1920×1080 | 9/9 | none (sw 1920 = cw 1920) |
| 1600×900 | 9/9 | none (1600 = 1600) |
| 1366×768 | 9/9 | none (1366 = 1366) |
| 1280×720 | 9/9 | none (1280 = 1280) |
| 1024×640 | 9/9 | none (1024 = 1024) |
| 900×600 (min) | 9/9 | none (900 = 900) |

All 9 views open at every size: Explorer, Search, Source Control, Run, Diff Review, Live
Architecture, Timeline, Agent Console, Test Results. The side-panel resize handle and the
bottom-panel Hide + Maximize controls are present (`after-code-overflow.json`
`panelProbe`). **No horizontal overflow at any size on any view.** Screenshots (6):
`picture/overhaul/w8/after-code-{1920x1080,1600x900,1366x768,1280x720,1024x640,900x600}.png`;
data in `picture/overhaul/w8/after-code-overflow.json`. (The dev preview has no native
filesystem — `ipc/bridge.ts` throws "not running under Tauri" — so this proves LAYOUT;
the file/editor/git/terminal WORKFLOWS are proved at the RPC + jsdom layers above.)

**Invariant 8 — states & tokens.** Every owned panel already carries loading / empty /
error / success / disabled / offline states (FileExplorer "No folder opened"; Terminal
"No folder is open…"; RunPanel loading/error/empty; GitPanel clean-vs-not-a-repo; Search
empty/no-match/error). Colour-literal sweep: `EditorArea.module.css` was the big
offender and was tokenised to W3's tokens (§8).

---

## 6. Keyboard shortcuts (the actual list; W9 shows it in settings)

Bound globally in `App.tsx` `Shortcuts` (Ctrl = Cmd on macOS):

| Shortcut | Action |
|---|---|
| Ctrl+, | Open Settings |
| Ctrl+O | Open Folder |
| Ctrl+P | Quick Open (go to file) |
| Ctrl+Shift+P | Command Palette |
| Ctrl+` | Toggle Terminal |
| Ctrl+Shift+` | New Terminal |
| Ctrl+J | Toggle bottom panel |
| Ctrl+B | Toggle side bar |
| Ctrl+Shift+E | Explorer |
| Ctrl+Shift+F | Find in Files |
| Ctrl+Shift+H | Replace in Files |
| Ctrl+Shift+G | Source Control |
| Ctrl+Shift+M | Problems |
| Ctrl+N | New File (in the Explorer) |
| Ctrl+= / Ctrl+- / Ctrl+0 | Editor zoom in / out / reset |
| Alt+Z | Toggle word wrap |
| Shift+Alt+R | Reveal active file in File Explorer / Finder |

Bound in `components/EditorArea.tsx` (IDE mode, on the window so a tab or the text both
work): **Ctrl+S** save · **Ctrl+Alt+S** save all · **Ctrl+W** close tab ·
**Ctrl+Tab / Ctrl+PageDown / Ctrl+PageUp** switch tab.

Routed through Monaco by `components/CommandPalette.tsx`: **Ctrl+G** go to line ·
**Ctrl+Shift+O** go to symbol · **Ctrl+F** find · **Ctrl+H** replace · **Ctrl+/** toggle
comment · **Ctrl+K** edit selection with AI.

## Dead-button / missing-feature list

- **No dead button found** on the Code surface. Every Explorer header button, context-
  menu item, editor tab control, Git panel button, terminal control and Run button maps
  to a working action (proved by the suites in §7).
- **Split editor** — not implemented anywhere in the source. Per invariant 2, not built;
  recorded as a limitation (§11).
- **Breakpoint debugging** — not in this build; `RunPanel.tsx` says so and points the
  user at `node --inspect` / `python -m pdb` rather than drawing a dead call stack.

## Colour-literal counts (owned CSS)

| File | before | after | Remaining (why) |
|---|---|---|---|
| `components/EditorArea.module.css` | 46 hex / 2 rgb | **2 hex / 1 rgb** | two dark error/warning washes + the Monaco status scrim, all marked `theme: fixed` |
| `panels/ide/Terminal.module.css` | 11 hex / 7 rgb | **10 hex / 7 rgb** | removed the `#fff` button label; the 8 ANSI palette colours stay literal on purpose (a terminal colour contract, documented `theme: fixed`) + accent/error tints W3 derives for light |

Other owned modules were already token-driven or near it (`DiffView`, `BottomPanel`,
`LiveArchitecture`, `FileExplorer`, `SearchPanel`, `ContextMenu`), or use a
`var(--token, #fallback)` pattern where the hex is a harmless fallback
(`TestResults.module.css`, whose bespoke muted nine-stage status palette is deliberate
and left as-is per owner rule 1). No `sk-*` primitive was needed beyond what the panels
already use.

---

## 7. Tests, typecheck, build, mutation checks (every command + result)

Each typecheck/test ran in a **later step** than the edits it checks. Vitest
`--maxWorkers=1` throws on 2.1.9 here, so serial execution used
`--pool=forks --poolOptions.forks.singleFork=true`. `NODE_OPTIONS=--max-old-space-size=1536`.

### Core engine (RPC layer, `packages/core`)
```
npx vitest run test/git.test.ts test/git-more.test.ts test/fsops.test.ts \
  test/fsops-rename-recovery.test.ts test/find-replace.test.ts test/project-search.test.ts \
  test/project-tools.test.ts test/terminal.test.ts test/watcher.test.ts test/desktopOpen.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
→ Test Files 10 passed (10);  Tests 139 passed (139)
  (git 32, git-more 9, fsops 12, fsops-rename-recovery 1, find-replace 18,
   project-search 14, project-tools 19, terminal 13, watcher 13, desktopOpen 8)
```

### Desktop (jsdom + static, `packages/desktop`)
```
npx vitest run src/editor/editor.test.tsx src/editor/editorFeatures.test.tsx \
  src/editor/diskSync.test.tsx src/editor/projectWatcher.test.tsx src/editor/fileIo.test.ts \
  src/editor/DiffView.test.tsx src/editor/models.test.ts src/editor/lineDiff.test.ts \
  src/explorer/fileTree.test.ts src/git/gitStatus.test.ts \
  src/panels/FileExplorer.test.tsx src/panels/FileExplorer.crud.test.tsx \
  src/panels/FileExplorer.os.test.tsx src/panels/GitPanel.test.tsx src/panels/GitPanel.more.test.tsx \
  src/panels/ide/SearchPanel.test.tsx src/panels/ide/Terminal.test.tsx \
  src/panels/ide/ShellTerminal.test.tsx src/panels/ide/RunPanel.test.tsx \
  src/panels/ide/ProblemsPanel.test.tsx src/run/scripts.test.ts src/terminal/ansi.test.ts \
  src/terminal/commandLine.test.ts src/terminal/links.test.ts src/terminal/ShellSessions.test.tsx \
  src/ipc/wireShape.test.ts src/lib/security.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
→ Test Files 27 passed (27);  Tests 303 passed (303)
```

### Typecheck
```
cd packages/desktop && npx tsc --noEmit        → exit 0, no errors
```

### Build (canonical CSS-compile gate)
```
NODE_OPTIONS=--max-old-space-size=1536 npm run build -w @sketch/desktop
→ ✓ built in 20.02s (exit 0); the tokenised CSS compiles.
  (the monaco chunk-size warning is pre-existing, unrelated to W8.)
```

### Rust (B-010)
```
cd packages/desktop/src-tauri
CARGO_BUILD_JOBS=2 RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu cargo check --message-format=short
→ Finished in 1m13s, exit 0.
  one warning: `resolve_pathspec_within is never used` (expected: its only caller,
  git_diff, was removed; command_policy.rs is left untouched per the grant).
```

### Dev-preview responsive proof
```
node packages/desktop/scripts/w8-code-shots.mjs
→ connect-modal-visible: false; ide chrome present; 9/9 views open at each size;
  No horizontal overflow at any size on any Code-surface view.
  6 shots + after-code-overflow.json in picture/overhaul/w8/.
```

### Mutation checks (non-vacuity)
- **B-010 wireShape:** `wireShape.test.ts` already asserts the Rust-struct set EQUALS
  `RETURNED_TO_WEBVIEW`; before dropping `'GitStatus'` from that list the test failed
  with a set mismatch, which is what forced the list to track the removal.
- **Policy contract test:** setting `CURRENT_POLICY_PHRASES.outsideProject` to a string
  not in `command_policy.rs` made the new `security.test.ts` contract case FAIL (1
  failed) — restored → 40+ pass.
- **describeFileFailure path:** `return false && …` in `isOutsideProjectRefusal` made 4
  cases across `fileIo.test.ts` + `editor.test.tsx` FAIL — restored → pass.

### A pre-existing failure this round surfaced and fixed
`lib/security.test.ts:138` was RED before any W8 edit (it asserted the pre-W2 Rust
wording). It is green now via §4. No other failing test was found in the owned surface.

---

## 8. CSS tokenisation detail

`components/EditorArea.module.css` (W8 owns its behaviour + tokens; W3 left it for the
later items). 46 colour literals mapped to W3 tokens: `#121212`→`--bg-primary`,
`#171717`→`--bg-secondary`, `#262626`→`--bg-elevated`/`--border`, `#333333`→
`--border-strong`, `#a3a3a3`→`--text-secondary`, `#737373`→`--text-muted`,
`#525252`→`--text-disabled`, `#ffffff`→`--text-primary`/`--text-on-accent`,
`#ea580c`→`--accent-active`, the `S` logo gradient stops →`--accent-strong`/
`--accent-active`, `#fbbf24`→`--warning`, `#fca5a5`→`--error`. Two dark washes (`#2a1414`
error, `#2a2412` warning) and the Monaco status scrim (`rgba(18,18,18,.85)`) are marked
`theme: fixed` — they are washes behind themed text, not surface tokens. Because W3's
tokens carry both themes, converting a literal to a token is strictly safer than the
literal (which `themeColors.ts` had to rewrite for light). `panels/ide/Terminal.module.css`:
the `#fff` run-button label →`--text-on-accent`; the ANSI 8-colour palette stays literal
by design (documented). `npm run build` confirms both compile.

---

## 9. How each invariant was proved — the layer honesty table

| Invariant | RPC (engine) | jsdom (reducer/UI) | dev preview | real app (UIA) |
|---|---|---|---|---|
| 1 file lifecycle | fsops, rename-recovery | editor, editorFeatures, diskSync, projectWatcher, FileExplorer.crud | layout only | not run (§11) |
| 2 tabs/editor/menus | — | editor, DiffView, FileExplorer, FileExplorer.os | overflow + views | not run |
| 3 search | find-replace, project-search | SearchPanel | — | not run |
| 4 terminal | terminal | Terminal, ShellTerminal, ShellSessions, ansi, commandLine, links | — | not run |
| 5 git / B-010 | git, git-more | GitPanel, GitPanel.more, gitStatus; wireShape; cargo check | — | not run |
| 6 run/preview | desktopOpen | RunPanel, scripts, links | — | not run |
| 7 every size | — | — | w8-code-shots (6 sizes × 9 views) | not run |
| 8 states/tokens | — | all the above | screenshots | not run |

---

## 10. Files modified / added

| File | Change | In W8's list? |
|---|---|---|
| `packages/desktop/src-tauri/src/main.rs` | B-010: removed `git_status`/`git_diff` commands, the `GitStatus` struct, and both `generate_handler!` entries; comment records git is engine-owned now. | yes (main.rs for B-010) |
| `packages/desktop/src/ipc/bridge.ts` | B-010: removed the `gitStatus`/`gitDiff` wrappers + `GitStatus` interface; header updated. | yes (bridge.ts, git wrappers for B-010) |
| `packages/desktop/src/ipc/wireShape.test.ts` | Dropped `'GitStatus'` from `RETURNED_TO_WEBVIEW`. | yes (tests for owned files) |
| `packages/desktop/src/components/EditorArea.module.css` | Tokenised (46→2 colour literals). | yes (EditorArea tokens) |
| `packages/desktop/src/panels/ide/Terminal.module.css` | `#fff`→token; documented the ANSI palette. | yes |
| `packages/desktop/src/ipc/policyMessages.ts` | **New.** Single source of current + legacy policy-refusal phrases and the predicates. | **round-7 grant** (§4) |
| `packages/desktop/src/editor/fileIo.ts` | `describeFileFailure` uses `isOutsideProjectRefusal`/`isNoProjectRootRefusal`; one clear op+file message. | yes (fileIo.ts — W2's paths behaviour untouched) |
| `packages/desktop/src/terminal/commandLine.ts` | `classifyRunFailure` uses `isDenialMessage`. | yes (terminal/**) |
| `packages/desktop/src/lib/security.test.ts` | Line 138 un-staled to the current wording; new contract-test block asserting every current phrase is in `command_policy.rs`. | **round-7 grant** (§4) |
| `packages/desktop/src/editor/fakeDisk.ts` | Double throws the current Rust refusal shape. | yes (tests) |
| `packages/desktop/src/panels/FileExplorer.test.tsx` | Doubles throw the current shape. | yes (tests) |
| `packages/desktop/src/test/engineHarness.ts` | Double throws the current shape. | **round-7 grant** (§4) |
| `packages/desktop/src/phase3-gate.test.tsx` | Double throws the current shape. | **round-7 grant** (§4) |
| `packages/desktop/src/editor/editor.test.tsx` | Refused-write case uses the current shape + wording. | yes (tests) |
| `packages/desktop/src/editor/fileIo.test.ts` | Asserts the new wording; keeps one legacy-phrase case on purpose. | yes (tests) |
| `packages/desktop/src/terminal/commandLine.test.ts` | Denial cases cover current AND legacy wording. | yes (tests) |
| `packages/desktop/scripts/w8-code-shots.mjs` | **New.** Dev-preview Code-surface overflow + view-open driver (6 sizes × 9 views). | yes (a script under packages/*/scripts) |

**Dependencies added: none.** **Mock data introduced: none.** **Security checks
weakened: none** (`command_policy.rs` untouched; the containment refusal is still
authoritative; the UI only matches its wording). The round-7 grant covered
`policyMessages.ts`, `security.test.ts`, `engineHarness.ts` and `phase3-gate.test.tsx`
explicitly.

---

## 11. Remaining limitations

- **No split editor.** The app has no split-editor command, button, or state (searched
  the whole source). Per invariant 2 this is recorded, not built.
- **Real-app UIA walkthrough not run.** The optional, time-boxed UI-Automation drive of
  the packaged QA app (open a folder, edit+save a file, run one terminal command in the
  real runtime) was not performed: a full GNU `tauri build --debug` + `smoke:boot` is the
  heaviest step on this host and memory stayed TIGHT (2.6–2.9 GB free) throughout. The
  B-010 Rust change is verified by `cargo check` (exit 0); the file/editor/git/terminal
  workflows are verified at the engine RPC layer (against real repos and a real PTY) and
  the jsdom layer (the real reducer + `fakeDisk`); the layout is verified in the dev
  preview. A QA rebuild + `smoke:boot` + `qa-window-shot.ps1` is the follow-up when
  memory allows, per the item's memory-aware verification notes.
- **Dev preview has no native filesystem.** `ipc/bridge.ts` throws "not running under
  Tauri", so `w8-code-shots.mjs` proves layout/sizes/panels only — which is what the dev
  preview is for. The workflows that need the OS are proved over RPC + jsdom.
- **`resolve_pathspec_within` is now unused** in `command_policy.rs` (its only caller,
  `git_diff`, was removed). It emits one `cargo check` `never used` warning. The brief
  forbids touching `command_policy.rs`, so the helper is left in place and the warning is
  recorded here rather than silenced.
- **CDP cannot drive the packaged app on this host** (WebView2 156 opens no DevTools
  listener — diagnosed in `fix-workspace-paths.md` §6.4), so every live UI measurement
  used the Vite dev preview over headless Edge.
