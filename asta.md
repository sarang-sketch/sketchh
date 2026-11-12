# Asta — Sketch workspace design and implementation

Updated: 11 November 2026 (Asia/Kolkata). This is the design record for the requested Code + Cowork redesign.

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
