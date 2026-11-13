# Asta — Sketch workspace design and implementation

Updated: 13 November 2026 (Asia/Kolkata). This is the design record for the requested Code + Cowork redesign.

## Product intent

Sketch is a free, local-first desktop workspace for coding and delegated work. Keep its real Monaco editor, native terminal, verification loop, project memory, provider choices, skills, MCP integration and event history. Make those capabilities feel like one considered product. Model providers may charge for inference; the interface must never imply otherwise.

The user's reference is `picture/Screenshot 2026-08-06 001613.png`: charcoal surfaces, warm orange, a quiet sidebar and a prominent composer. Preserve that identity while improving spacing, typography, navigation and customization. Existing uncommitted work belongs to the user and is the starting point, not something to reset.

## Research, with primary sources

Reviewed on 10 November 2026:

| Product | Useful pattern | Application in Sketch | Performance consideration |
| --- | --- | --- | --- |
| [Cursor](https://cursor.com/docs) | Code and agent together; quick navigation; explicit review | Full-height agent beside an editor/terminal column; project command bar; review entry points | Keep editing independent of optional panels and provider latency |
| [Cursor review](https://cursor.com/learn/reviewing-testing) | Inspect actual changes and verification results | Preserve real diff review, run receipts and checks | No synthetic success metrics or sample results |
| [OpenCode](https://opencode.ai/docs/) and [agents](https://opencode.ai/docs/agents/) | Provider choice, reusable instructions, permission-aware modes, themes, MCP | Clear Ask/Agent/Auto controls; workflows; direct tools, memory and model access | Reuse one engine/session instead of adding competing clients |
| [Kiro](https://kiro.dev/docs/) and [Crew](https://kiro.dev/docs/crew/) | Shared harness across surfaces; specifications, persistent tasks and memory | Workflows that prepare editable tasks; persistent conversations and project context | Persistent data must stay bounded and startup must not trigger background work |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Everything-is-a-plugin architecture; extensible local workbench | Bring existing skills, MCP and project memory into Cowork; keep module boundaries | Preserve lazy loading and explicit activation; do not install or launch a second harness |
| [VS Code layout](https://code.visualstudio.com/docs/configure/custom-layout) | Familiar pane placement and keyboard-first navigation | Move sidebar/agent, resize, focus mode, top/side activity bar, layout presets | Preserve buffers and running processes when changing layouts |
| [React lazy](https://react.dev/reference/react/lazy) | Load optional screens on first use; declare lazy components at module scope | Lazy-load heavy workspace/panels; retain visited workspaces | Avoid doing editor work before Code is visited |

These are documented capabilities and architectural observations, not a cross-product speed ranking. No controlled Cursor/Kiro/OpenCode/DeepSeek timing comparison was run. Model quality, provider latency, project size and hardware all affect agent performance. Sketch's own checks and build measurements are recorded below after implementation.

## Design system

- Canvas: charcoal `#141414`; sidebar: carbon `#191919`; raised surface: graphite `#222222`.
- Dividers: ash `#303030`; primary text: porcelain `#eeeeec`; accent: ember `#f58a50`.
- Inter for controls and reading, locally bundled JetBrains Mono for code, Georgia for the single Cowork welcome headline, as in the reference. No remote font dependency.
- A 4-pixel spacing rhythm. Compact toolbar controls, generous composition space, clear hover/focus/selected states.
- Small corner radii in the IDE; a softer composer on Cowork. Borders express panel ownership, not decoration.
- Orange marks actions and selection. Status colors retain their meaning. Custom colors derive accessible text/fill pairs.
- Respect reduced motion and small windows. Every icon button has an accessible name. Hidden workspaces must be inert.

### Layout options considered

An all-in-one dashboard would crowd the editor with statistics and cards. A clone of a competitor would lose Sketch's identity. Use two purpose-built surfaces sharing one header, one session and one settings model.

```text
Cowork
┌ Brand / Cowork · Code ─── Project command bar ─── Layout / Settings ┐
│ Workspace       │ Cowork                               Personalize │
│ + New task      │                                                 │
│ Projects        │             Welcome + composer                  │
│ Workflows       │             Context + mode + model              │
│ Runs            │                                                 │
│ Skills / Tools  │             Useful task starters                │
│                 │                                                 │
│ Conversations   │             Recent project work                 │
│ Settings        │                                                 │
└ Branch / Engine ───────────────────────────────────── Cost / Mode ┘

Code
┌ Brand / Cowork · Code ─── Project command bar ─── Layout / Settings ┐
│ A │ Explorer    │ Tabs / breadcrumbs           │ Agent             │
│ c │ Search      │                              │ Chat / Context    │
│ t │ Git         │ Monaco editor                │                   │
│ i │             │                              │ Review / Workflow │
│ v │             ├──────────────────────────────┤                   │
│ e │             │ Terminal / Problems          │ Composer          │
└─────────────────┴──────────────────────────────┴───────────────────┘
```

Cowork content is left aligned inside a centered reading column; the composer is the focal point. Code preserves maximum usable editor area. At narrow widths panels become overlays rather than squeezing the editor. The reference's dot pattern becomes subtle and optional, not a high-contrast full-screen distraction.

## Implementation checklist

- [x] Inspect current architecture, reference image, existing changes and baseline typecheck.
- [x] Research primary sources and install/read the official frontend-design skill.
- [x] Add validated, persistent appearance settings and accessible color derivation.
- [x] Implement appearance previews, accents, surfaces, density, typography and layout controls.
- [x] Redesign shared title bar, navigation, welcome surfaces and composer.
- [x] Reorganize Code into editor/terminal and a full-height agent pane.
- [x] Add focus mode, layout presets and command-palette entry points.
- [x] Add a workflow library with editable built-ins and saved personal workflows.
- [x] Bring projects, tools and memory into Cowork with working navigation.
- [x] Improve startup loading and hide inactive surfaces from focus/accessibility.
- [x] Verify persistence, workflow behavior, keyboard paths, theme contrast, build and tests.
- [x] Visually inspect Cowork; record the limit on further visual verification below.
- [x] Update usage documentation and What's New with implemented features.
- [x] Build and verify the Windows installer.

## Implemented behavior

### A shared workbench

The title bar contains the project command button, Code/Cowork switch and layout controls.
Build, Review and Write presets change the Code workspace. Focus mode temporarily hides
panels; exiting restores the chosen layout. Visited workspaces remain mounted, but the
inactive surface is hidden and inert so its controls cannot capture focus.

Code places Monaco and the terminal in one column, beside a full-height agent pane. The
project sidebar and agent can move independently to either side; the activity bar can be
vertical, horizontal or hidden. Pane sizes are bounded to the window, with overlays at
narrow widths. The welcome screen opens real folders and recent projects or clones a
repository. The agent's Context tab shows the project and open files, supports explicit
attachments and links to memory, skills and tools.

Cowork has a focused welcome composer, useful starters, recent projects and direct links
to Projects, Workflows, Runs, Skills, Tools & MCP, Memory, Timeline and Console. All project
links use the existing guarded folder-opening path. Removing a recent project only removes
the recent entry.

### Customization

Settings → Appearance supports dark/light/system, graphite/midnight/warm stone, preset or
custom accents, compact/comfortable density, Inter/system UI fonts, UI text size, panel
placement, activity bar placement, Cowork reading width and background, status bar, starter
tips and reduced motion. Choices apply immediately and persist locally. Settings export
includes appearance, and earlier exports still import.

Accent and muted text are adjusted against the lightest/darkest relevant workbench surface.
Button labels use a contrasting black or white value, including for custom mid-gray
accents. Built-in Monaco surfaces, cursor, selection and widgets, plus xterm colors, follow
the palette. Custom editor themes retain their syntax settings. Fonts are bundled locally.

### Workflows and drafts

Ten built-in workflows cover useful engineering tasks. Users can search/filter them, edit
instructions and permission mode, and save, edit or delete personal workflows. Saved
records have validated IDs, bounded size/count, secret scrubbing and storage-error handling.
Using a workflow only prepares an editable new draft. Active-run guards prevent replacing
work that is currently running.

Draft text uses a per-window external store, scoped to the current conversation or new
task. Keystrokes notify the composers rather than rerendering the entire workbench. A draft
survives mode switches and closing/reopening the agent panel; New task/New chat starts an
empty draft. The bounded draft store is session-only. Explicit file attachments preserve
the text already being composed.

### Loading and maintenance

Code, Cowork, settings, the command palette and cloning use module-level lazy entry points.
Optional workbenches and the workflow library load separately. The production manifest
check follows static imports and fails if Code, Monaco, settings, workflows or xterm enter
Cowork's startup graph. CI now runs this check after building.

Vitest is updated to 4.1.12 and Vite to 6.4.6, with patched transitive packages. The root
dependency audit reports zero known vulnerabilities. Four test workers keep filesystem
fixtures and jsdom imports from contending on this 20-logical-processor Windows host;
the regular per-test timeouts and test isolation remain enabled.

## Implementation boundaries

No fabricated projects, agent activity, integrations, benchmark wins, or delivery claims. Workflows prepare a prompt for review before the user starts a model run; clicking a starter never incurs a model call. No new mandatory backend or runtime dependency. Existing provider credentials and file safety checks stay authoritative. Native terminal/OS behavior requires the packaged Tauri host; browser preview verifies the frontend and development engine bridge.

## Validation record

- Baseline: root `npm run typecheck` passed before edits.
- Baseline visual inspection: hidden Code controls appeared in the accessibility tree while Cowork was active; Code mounted before first use; terminal spanned the agent's space. These are part of this redesign's acceptance criteria.
- Baseline tests: desktop passed 932 tests in 99 files. Core passed 1,412 tests with one 5-second filesystem property-test timeout under unrestricted worker concurrency.
- Final `npm test`: **2,363 passed** — core **1,413 tests / 86 files**, desktop **950 tests / 104 files**. Core took 28.55 seconds and desktop 50.10 seconds on this host; these are test-run durations, not application speed measurements.
- Full-suite fixes: replaced a synthetic rejected-color URL with a local invalid CSS value, updated the legacy raw-color floor to reflect conversion to appearance tokens, bounded worker concurrency and allowed cold transforms in the first-visit navigation assertion. All per-variable light-theme and contrast checks remain active.
- Root typecheck and production build passed. Windows NSIS installer rebuilt on 11 November 2026 at 01:07 (after the last source edit at 00:46): `packages/desktop/src-tauri/target/release/bundle/nsis/Sketch_0.1.0_x64-setup.exe`, 27,755,350 bytes, SHA-256 `b9da2e10a1d495d351aab6ee8171623d441929a76ba79e2188b1c27b1e922fff`, PE image (`MZ`). `npm run package:size -w @sketch/desktop -- --platform windows` passed against the strict 100,000,000-byte budget and wrote `package-sizes-windows.json`; `npm run verify:sidecar -w @sketch/desktop` passed (ping ok, unknown method and malformed line refused, process survived). The installer was not run on a clean machine, is not Authenticode-signed, and the packaged window was not visually inspected.
- `npm run check:bundle -w @sketch/desktop` passed. Before the final What's New copy update, shell JavaScript was 400,274 bytes (124,652 gzip); Cowork's static JavaScript graph was 468,584 bytes (149,719 gzip). Final build measurements will replace these values after packaging.
- Re-verified on 11 November 2026 (10:49 IST), run serially because the host was low on memory: root typecheck clean in both packages; core 1,413 tests / 86 files and desktop 950 tests / 104 files passed (`--no-file-parallelism`); desktop production build and `check:bundle` passed; `npm audit` found 0 vulnerabilities; `git diff --check` exited 0.
- `npm audit --json`: **0 vulnerabilities**, including development dependencies, on 11 November 2026.
- `npm run bench:check`: passed the existing **synthetic offline** engine gate (measured lift 1; threshold 1). Report: `.sketch/bench/2026-11-10T19-19-14-481Z.json`. This says nothing about real providers or competitors.
- `git -c core.autocrlf=false diff --check`: passed after trimming trailing blank lines in the touched files.

### Visual verification limits

Cowork was visually inspected at 1440 × 960 through Computer Use. A subsequent attempt to
inspect Code in a native browser was blocked because Computer Use could not confidently
verify the browser URL on Windows. No alternate browser automation was used to bypass that
restriction. Code navigation, settings, workflow actions and keyboard behavior passed local
interaction tests. Narrow layouts have source and sizing checks; their visual pass remains
unverified. No final screenshots were saved, and README explicitly labels the retained
screenshots as the previous interface.

## 2026-11-12/13 polish — branch `sketchh-polish` (not pushed yet)

The user asked, with full liberty, to check what was done, finish the IDE end to end,
fix the chat Normal/Turbo display, polish the UI to the cover design, and also build
a mobile coding app, a Windows EXE and an Android APK. This entry records what was
actually found and done on a Linux VM (1.5 CPU, 6 GB RAM), with real measurements.
Nothing here was pushed to GitHub or uploaded to Drive: GitHub/Drive were still
being connected while this work ran, so the branch stays local until access lands.

### Audit findings (re-verified, not taken on trust)

- The 1 November audit docs are stale against the 11 November code. Two of their
  fixes were already in the code: B-008 (TitleBar window controls now guard on
  `isTauri()`) and B-009 (Settings now has separate Privacy and Shortcuts tabs).
  The teal token names the UI/UX audit flagged are already kept as aliases in
  `global.css`.
- Baseline, re-run before any edit: `npm ci` clean; `npm run build:core` clean;
  root `npm run typecheck` passes only after the core build — before it, desktop
  `tsc` fails with `Cannot find module '@sketch/core'`, an ordering quirk, not a
  code bug. Core tests: **1,412 passed, 1 skipped, 86 files, 67.9 s**. Desktop
  tests: **949 passed, 1 failed, 104 files, 124.8 s** — the failure is the
  `devBridge` ping test timing out at 5 s under load; it passes in isolation in
  ~2 s. The claimed 2,363 tests (core 1,413 + desktop 950) match these baseline
  counts within the one skipped / one timed-out test.
- **"Turbo" did not exist in the committed desktop code.** A grep finds it only
  in model pricing names (`gpt-4-turbo`, `gpt-3.5-turbo`) and `.turbo` ignore
  patterns. The chat modes were Ask / Agent / Auto. The user's Turbo control
  lived only in their uncommitted local 13 GB desktop work, which was never
  pushed. So the fix was to build the control properly (below), not to repair a
  reversed one — and the existing mode pills were also hardened with explicit
  left-to-right direction.
- The dark theme in code (`#121212` / `#171717` / `#1e1e1e`, accent `#f97316`)
  did not match this record's cover values. It does now (below).
- Confirmed remaining gaps (from `docs/IMPLEMENTATION_STATUS.md`): chat
  management had rename and copy-as-Markdown, but no file export, no import,
  and no context meter; per-chat model still missing; git had commit/stage/diff
  but no `git init` button (the panel told users to run it in a terminal);
  hooks, remote MCP, Project Rescue, UI Doctor, API Lab, split editor and
  debugger are still not built.

### Research summary (primary sources, 12 November 2026)

Cursor (agent modes, Plan/Ask/Agent/Debug, per-change review, checkpoints),
Kiro (specs as requirements → design → tasks, Crew persistent bots),
OpenCode (agents as Markdown files, allow/ask/deny per-tool permissions,
themes, MCP), DeepSeek Harness (everything-is-a-plugin on Cordis, developer
preview — borrow the architecture, do not depend on the project), VS Code
(two side bars, draggable panels, Zen/Centered modes, one Customize Layout
control). Patterns actually applied here: the mode picker and review entry
points Sketch already had were kept; the permission model stays allow/ask/deny;
no second harness or competing agent client was added. No speed ranking between
products was made or claimed — none of the sources publish comparable,
independently verified figures for this use case.

### What changed

- **Normal / Turbo speed** (`packages/desktop/src/state/AppState.tsx`,
  `lib/AgentSession.tsx`, `panels/agent/Composer.tsx`, `Composer.module.css`).
  A segmented control in the composer bottom row, left of the mode pills:
  Normal first, Turbo second, explicit `dir="ltr"` and `flex-direction: row`,
  with a radiogroup label and tooltips. Speed is orthogonal to mode and never
  switches the model: Normal is the full agent (configured turns, last 12
  turns of history, 400k token budget); Turbo caps turns at 10 (20 in Auto),
  sends only the last 6 turns, and caps the token budget at 150k. The mapping
  is in `modeRunOptions` / `historyFrom` so the label and the run cannot drift.
  4 new tests in `composer.test.tsx` (order, caps, history, validation).
- **Chat management** (`conversationImport.ts`, `ConversationSidebar.tsx`,
  `state/AppState.tsx`). Download a conversation as Markdown or JSON, and
  import a JSON export back (validated; invalid files are refused with a
  reason, run receipts and file states are not trusted from a file). Rename
  and copy-as-Markdown already existed; Retry under a reply is the existing
  regenerate. 5 new tests.
- **Context meter** (`lib/contextMeter.ts`, `panels/agent/AgentChat.tsx`).
  The chat header shows `Context ≈ 3.2k tokens · 8 turns · last 12 sent`,
  estimated at ~1 token per 4 characters and labelled as an estimate, with the
  kept-turn count following Normal/Turbo. 3 new tests.
- **Git init / checkpoints** (`core/src/tools/git.ts`, `core/src/rpc/methods.ts`,
  `desktop/src/lib/{client,httpClient,stdioClient,mockClient}.ts`,
  `desktop/src/git/GitProvider.tsx`, `panels/GitPanel.tsx`). New `git-init`
  engine method (the engine now answers 85 RPC methods), wired through both
  transports; the Git panel's "Not a git repository" state now has an
  "Initialise repository" button, and the first checkpoint is the existing
  Commit button. 3 new tests (2 core, 1 panel, all against real git).
- **Asta theme alignment** (`styles/global.css`, `editor/extensionRegistry.ts`,
  `terminal/ShellSessions.tsx`, `components/settings/ConnectWizard.module.css`,
  plus `var()` fallbacks). Dark tokens are now canvas `#141414`, sidebar
  `#191919`, graphite `#222222`, dividers `#303030`, porcelain `#eeeeec`,
  ember `#f58a50`. One test expectation updated to the new fallback value.
- **Sketch Mobile** (`packages/mobile/`, new). A Vite + React PWA /
  Capacitor-ready app with the same Asta tokens: bottom navigation (Files,
  Editor, Agent, Preview, Settings), 44px touch targets, safe-area insets,
  reduced-motion support. Files live in the phone's browser storage with
  create/rename/delete and JSON export/import; the editor saves on the phone;
  the agent has the same Ask/Agent/Auto + Normal/Turbo controls and calls a
  provider the user configures (base URL + model + key, stored only on the
  phone — no provider, no send); Preview renders HTML live and runs JavaScript
  in a sandboxed frame with console capture. There is no terminal on mobile
  and the app says so. Capacitor config (`dev.sketch.mobile`) and an Android
  manifest are included; see its README for the exact APK steps.

### Validation record (2026-11-13, this VM)

- `npm run typecheck` (root): passes — core, desktop and mobile.
- Core tests: **1,413 passed, 1 failed, 1 skipped, 86 files** (1,415 total;
  +2 git-init tests). The failure is `test/cli.test.ts` "stops a run that is
  still in flight" (41 s in the full run); it passes in isolation in 0.7 s —
  load flakiness on this 1.5-CPU host, unrelated to the change (git tools only).
- Desktop tests: **959 passed, 4 failed, 106 files** (963 total; +13 new
  tests). The failures are the `devBridge` ping timeout and 3
  `workspaceNavigation` lazy-load timing failures; all 4 pass when the two
  files run together (18/18) and in isolation. Same load flakiness, not a
  regression — the baseline full run already had the devBridge timeout.
- Mobile tests: **10 passed, 2 files**.
- `npm run build:desktop`: passes (77 s). `npm run check:bundle`: passes
  (shell JavaScript 401,962 bytes raw / 125,109 gzip).
- Mobile build: passes (212.5 kB JS, 66.96 kB gzip; `dist` 236K). Preview
  smoke test: index, manifest and icon-512 all HTTP 200.
- **No Windows EXE was built**: this VM has no Rust toolchain (`cargo` /
  `rustc` absent) and `PACKAGING.md` states Windows NSIS packaging is
  native-Windows-only. **No APK was built**: no Java, Gradle or Android SDK
  in this VM. No dummy `.exe` / `.apk` was created; the packaging scripts and
  docs are ready for a Windows host (EXE) and an Android-SDK host (APK).

### What remains

Hooks, remote MCP (stdio only), Project Rescue, UI Doctor, API Lab, split
editor, debugger, per-chat model, voice, daily briefing, and a service worker
for the mobile PWA. Visual verification: no screenshots and no packaged-app
visual pass were possible on this VM — same limit as the previous round; the
theme change was verified by tests and build only, and should get a visual
pass on a real machine. Full-suite test runs are timing-sensitive on low-CPU
hosts; run them serially (`--no-file-parallelism` for desktop) if they flake.

## 2026-11-13 production — branch `sketchh-polish` (still not pushed)

Sarang's follow-up, from the Android app at 08:53 IST: "finish all the work,
test it and make it production ready". The GitHub App repository selection was
**not** done at that point, so nothing below was pushed; the branch stays local
until Sarang confirms the selection himself. This entry records what the
production pass actually finished, wired, and verified — and what it honestly
did not.

### Finished and wired (not just built)

- **Hooks** (`core/src/hooks/`, `core/src/rpc/methods.ts`,
  `desktop/src/panels/HooksPanel.tsx`, `hooksAdapter.ts`,
  `components/ide/SidePanel.tsx`). Engine hooks for `SessionStart`,
  `PreToolUse` (can deny the tool call), `PostToolUse`, `Stop`, run as an
  argv array — never a shell string — with timeout kill and 16 KiB output
  caps. Three new RPC methods (`hooks-list`, `hooks-save`, `hooks-test`),
  so the engine now answers **85 RPC methods**. The panel is wired through
  `HooksPanelHost` (load/save/test against the real engine). Hooks are
  **opt-in per run** (`params.hooksEnabled`, off by default, set only when
  the user saves hooks through the panel) — a `.sketch/hooks.json` from an
  untrusted project never runs on its own. Remaining gap, stated plainly:
  there is still no per-file trust/approval flow for hooks like the one MCP
  user servers have, and no OAuth for remote MCP below.
- **Remote MCP** (`core/src/mcp/httpTransport.ts`, `userServers.ts`).
  Streamable HTTP servers (`RemoteMcpServer`, session id, JSON + minimal
  SSE, timeout + latch) alongside stdio; `mcp-server-save` accepts a URL
  (+ optional headers) or a command, never both; `mcp-server-test` branches
  to the remote server for URL servers. Remote servers are not catalogued
  (the host would otherwise try to spawn them) and get `net:http` only, not
  `proc:spawn`. No OAuth, no `resources/read` / `prompts/get` / sampling,
  no streaming push.
- **Project Rescue, UI Doctor, API Lab** (`desktop/src/panels/`,
  wired into the side panel + activity bar). Rescue analyses the open files
  (a partial view, not a whole-tree scan; `.env` flagged, contents never
  rendered). UI Doctor runs real DOM checks on the page it runs in (images
  without alt, buttons without accessible name, inputs without label,
  title/lang, contrast estimate < 3:1 flagged as an estimate). API Lab makes
  real fetches (AbortController, 10 s default timeout, body truncated at
  50 KB, secrets scrubbed from history). No auto-fix in Rescue, no manual
  Cancel/replay in API Lab, UI Doctor cannot check an arbitrary URL.
- **Chat management, complete**: pin/archive (pinned first, archived in
  their own section), per-chat model (a conversation's own model wins over
  the global pick), thumbs up/down feedback (toggle to clear, persisted),
  edit-and-resend (replaces the message, drops everything after it, one
  fresh run, no duplicated user message — the run takes the edited history
  directly to avoid a state-update race), and voice input (a Dictate button
  in the composer, SpeechRecognition where the browser has it, disabled with
  a plain title where it does not; final transcripts append to the draft).
- **Debugger basics** (`panels/ide/DebuggerPanel.tsx`, `debuggerStore.ts`,
  wired into the side panel). Breakpoints are recorded; launch starts a
  bare `node --inspect=<port>` session in the terminal. No entry-file
  selection, no stepping/pausing/variables — that is not implemented, and
  the panel does not pretend otherwise.
- **Daily briefing** (`panels/DailyBriefing.tsx`, `DailyBriefingHost.tsx`).
  Built from what the window actually recorded (conversations only — no
  runs/costs/tasks are seeded); empty days say so. The host exists so no
  briefing module is statically imported by the Code shell (see the bundle
  fix below).
- **Cost Dashboard per-model grouping** (`panels/costGrouping.ts`,
  `CostDashboard.tsx`). A "By model" section above "Every call", sorted by
  cost desc; fully-unknown models show `unknown`, never `$0`. The section
  renders only when entries exist — an empty log still shows the honest-zero
  footnote exactly once.
- **Split editor** (`components/SplitEditor.tsx`): built and tested, but
  **not wired into the UI**. `CodeEditor` takes no path/content/onChange
  props and projects `AppState.activeFile`, so both panes would show the
  active file. Wiring it as-is would ship a split that shows the same file
  twice; it needs a `CodeEditor` per-pane-props change first.
- **Mobile service worker + sync** (`mobile/public/sw.js`,
  `src/serviceWorker.ts`, `src/sync.ts`, Settings → "Sync with desktop").
  App-shell cache-first, network-first navigations, provider/API calls never
  cached; sync bundle v2 (SHA-256 over canonical JSON, FNV-1a fallback
  labelled non-cryptographic, 5 MiB per-file limit, path-traversal
  rejection, newer-wins / conflict-keeps-existing merge). This is
  **file-bundle export/import, not live/real-time sync**, and there is no
  desktop-side bundle import yet.

### Fixes found by testing this round

- The core zero-dependency gate (`test/deps.test.ts`) failed on the two new
  worker test files placed under `src/` (they import `vitest`): moved to
  `test/hooks.test.ts` and `test/httpTransport.test.ts`, the convention the
  rest of the core tests follow.
- The desktop bundle check failed after wiring the panels:
  `IdeLayout.tsx` lost its own lazy entry because SidePanel statically
  imported `buildBriefing` from `panels/dailyBriefing`, which the briefing
  component also imports — Rollup merged the briefing code into the
  IdeLayout chunk. Fixed with `DailyBriefingHost.tsx`: everything
  briefing-related now sits behind one lazy import, and the check passes.
- The `CostDashboard` empty-log test failed (the new "By model" section
  duplicated the honest-zero footnote); fixed by rendering the section only
  when entries exist.
- The `cli.test.ts` cancel test failed once under full-suite load (40.9 s);
  it passes in isolation (~4 s) and per-file. Hardened, not weakened: the
  cancel is now sent at 1,500 ms instead of 700 ms (on a loaded VM the
  engine can take over 700 ms to boot and start the run, so the earlier
  delay exercised the tombstone path instead of the in-flight path the test
  is for) and the test timeout is 60 s. All assertions unchanged.
- The `devBridge` ping timeout (30 s on `beforeAll` and the ping test) and
  the `workspaceNavigation` cold-transform timeout (3 s → 10 s) were raised
  the same way — margins, not weaker assertions. Both files now pass in the
  full suite.
- One stale test fixture remained from the old hook events (`'pre-commit'`
  in `HooksPanel.test.tsx`): updated to the engine events (`SessionStart`,
  `PreToolUse`, `PostToolUse`, `Stop`).

### Validation record (2026-11-13, this VM, final numbers)

- Typecheck clean in all three packages: core, desktop, mobile.
- Core tests: **1,450 passed, 1 skipped, 88 files**.
- Desktop tests: **1,049 passed, 117 files** (`--no-file-parallelism`).
- Mobile tests: **25 passed, 4 files**.
- Desktop build passes; `npm run check:bundle` passes (shell JavaScript
  407,624 bytes raw / 126,520 gzip; Cowork 487,106 / 155,037).
- Mobile build passes; `dist/sw.js` present.
- Theme tokens verified in the built CSS (desktop + mobile): `#141414`,
  `#f58a50`, `#191919`, `#eeeeec` all present. No browser exists on this VM
  (no Chromium/Playwright), so there is still no pixel-level visual pass —
  the Asta colours need a look on a real machine.
- **No Windows EXE**: no `cargo`/`rustc`, no Java/Gradle/Android SDK,
  `ANDROID_HOME`/`JAVA_HOME` unset; `PACKAGING.md` says Windows NSIS is
  native-Windows-only. **No APK**: same reason. No fake `.exe`/`.apk` was
  created. Exact host commands are in the production report.
- **Nothing pushed to GitHub**: repo selection unconfirmed (see above). The
  text-only branch `sketchh-polish-textonly` is the push candidate (drops
  the two binary PWA icons, keeps the SVG icon); it must be refreshed from
  this branch before pushing, since this round added commits after it was
  cut.

## 2026-11-13 EGM plugin — branch `sketchh-polish` (still not pushed)

Sarang, from the Android app: "Use this as your plug in also put it in our
ide sketch https://github.com/google/elephant-goldfish-model". EGM is not a
model: it is Google's open-source plugin of agent skills for designing and
reviewing software (Apache-2.0, ~18k stars, upstream commit
`270b10326bf366d823bc76fd662cf83808d5781e`, read from a shallow clone in
`~/workspace/egm-reference`). Elephant holds project context and drafts the
specification; Goldfish reviewers examine the draft with NO prior
conversation, to expose unstated assumptions and blind spots; the user
approves the spec before implementing.

### What was built

- **Seven skills** in the registry
  (`packages/core/registry/skills/egm-*/SKILL.md`, pack `egm`; 14 skills
  total now): `egm-brainstorm`, `egm-draft`, `egm-review`, `egm-resolve`,
  `egm-bootstrap`, `egm-drift-report`, `egm-review-loop`. Each file carries
  EGM attribution (Apache-2.0, repo link, upstream commit) and states the
  Goldfish fresh-context rule. Registry re-pinned
  (`npm run pin:registry`).
- **Core support** (`packages/core/src/egm/`): `buildGoldfishContext`
  (target document plus the files it links to inside the project only;
  anchor-only, external and missing links excluded with reasons; the result
  has no chat-history field and `priorChatTurns` is always 0), the five
  review stages with their report files, the semantic split at
  "## Detailed Implementation Plan", finding dedup/sort, review-loop
  convergence (two consecutive clean rounds, cap 5 rounds), and the artifact
  conventions (`concepts_brief.md`, `design_draft.md`,
  `docs/designs/<feature>.md`, `{YYYY-MM-DD}_DRIFT_REPORT.md`). One new RPC
  method, `egm-goldfish-context` (read-only). The engine now answers **88
  RPC methods** — the "85" in the production section above was already two
  short of the table, which held 87 at `64b7adc`.
- **Commands** (`packages/desktop/src/lib/egm.ts`, wired into
  `slashCommands.ts`): `/egm-brainstorm`, `/egm-draft`, `/egm-review`,
  `/egm-resolve`, `/egm-bootstrap`, `/egm-drift-report`,
  `/egm-review-loop`. Review and drift-report run in Ask mode (read-only).
  Each command's expanded prompt is self-contained — it carries the file
  conventions and the Goldfish rule — so it works even before the skill is
  installed.
- **Panel** (`packages/desktop/src/panels/EgmPanel.tsx`, activity-bar entry
  "EGM Design & Review", Brain icon): lists the seven skills, the workflow
  (Brainstorm → Draft → Review → Resolve → Implement), a target-file input,
  and a "Preview reviewer context" that shows exactly what the reviewers
  will see — including that they see 0 prior chat turns. Review commands
  start a new conversation and send the run with an empty history.
- **Client seam**: `egmGoldfishContext` on `SketchClient`, implemented in
  the HTTP and stdio clients, `noEngine` in the mock client.

### The honest limit

Sketch cannot yet spawn isolated subagent contexts, so the five Goldfish
review stages run sequentially in ONE fresh session (empty history) instead
of in five isolated subagents. The fresh session still guarantees the
property that matters most — the reviewers never see the drafting
conversation — but the stages can in principle influence each other within
that session. The panel, the review skill text, and the consolidated report
header all say this; a same-conversation "review" is refused by the prompt,
which tells the user to start a new conversation first.

### Validation record (2026-11-13, this VM)

- Typecheck clean in core and desktop.
- Core tests: **1,469 passed, 1 skipped, 89 files** (full suite, third run
  green; two earlier full runs each failed the same one bench test —
  `taskCompletionRate` 0.5 in the offline eval gate — which passes in
  isolation and on re-run, and also fails differently on a clean baseline
  worktree, so it is a load-flaky timing failure in the verify-policy
  stage, not an EGM path: the bench executor never touches the skills
  registry).
- Desktop tests: **1,064 passed, 119 files** (full suite with
  `--no-file-parallelism`; the parallel runs each failed a different timing
  flake — `RunPanel` once, `workspaceNavigation` twice — and each passes in
  isolation, so the flakes are load on this 1.5-CPU VM, not this change).
- New tests: `packages/core/test/egm.test.ts` (fresh-context rule, stages,
  artifacts, registry), `packages/desktop/src/lib/egm.test.ts` (command
  registration, prompts), `packages/desktop/src/panels/EgmPanel.test.tsx`
  (panel, preview, fresh-review start).
- Nothing pushed to GitHub; `packages/mobile/` untouched (another agent was
  rebuilding it during this work).
