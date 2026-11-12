# Sketch IDE — UI/UX Audit (W1)

Audit date: 2026-11-01. Build: Vite dev preview of current source (same source as the
2026-11-01 12:15 release exe). Driven live over CDP in headless Edge 156 against
`http://127.0.0.1:1420/` with an isolated home and `SKETCH_FAKE_PROVIDER=1`.

Why the dev preview and not the packaged exe: on this host (WebView2 runtime 156) the Tauri exe
does not honour `WEBVIEW2_USER_DATA_FOLDER` / `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, so no
DevTools/CDP port is exposed and the real window cannot be driven. The dev preview is the same
React source and the same engine (in-process bridge); its one limitation is that native
filesystem commands are unavailable, so file/terminal/git *workflows* were audited at the
engine + `command_policy` source level and the *UI* of every screen was audited live.

Screenshots: `picture/overhaul/w1/` (gitignored). Severity: P0 blocker · P1 major · P2 moderate ·
P3 polish.

Responsive summary: measured `document.scrollWidth` vs `clientWidth` at 1920×1080, 1600×900,
1366×768, 1280×720 and 1024×640 — **no horizontal overflow at any size** (scrollWidth ==
clientWidth each time). The shell is genuinely responsive down to 1024×640.

---

## Design-token inventory (`packages/desktop/src/styles/global.css`, `themeColors.ts`)

Dark theme `:root` tokens (the brand identity):
- Backgrounds: `--bg-primary #121212`, `--bg-secondary #171717`, `--bg-surface #1e1e1e`,
  `--bg-elevated #262626`, `--bg-hover #2a2a2a`, `--bg-active rgba(249,115,22,.15)`.
- Text: `--text-primary #f5f5f5`, `--text-secondary #a3a3a3`, `--text-muted #737373`.
- Accent (orange): `--accent #f97316`, `--accent-hover #fb923c`, `--accent-fill #ea580c`,
  `--accent-fill-hover #c2410c`, `--accent-subtle rgba(249,115,22,.2)`.
- Status: `--success #22c55e`, `--warning #eab308`, `--error #ef4444`, plus `--purple`, `--pink`.
- Borders: `--border #262626`, `--border-subtle #1e1e1e`.
- Type: `--font-sans Inter`, `--font-mono 'JetBrains Mono'`, `--font-serif Georgia`.
- Radii: `--radius-sm 4px`, `--radius 6px`, `--radius-lg 10px`.

The light theme is not hand-authored per token; `themeColors.ts` derives light values from the
dark ones with a perceptual (Lab) role-aware mapping (`fg`/`bg`/`border`/`shadow`). This is a
strong, consistent system.

**Token finding (P3, maintainability):** the accent tokens are still named for the OLD brand
colour — `--accent-teal`, `--accent-teal-bright`, `--bg-teal-dark/main/elevated` — but hold
ORANGE values. The names should be renamed to match (or aliased) so a maintainer is not misled.
No runtime effect. Component CSS: `components/*/*.module.css` and `panels/*/*.module.css`.

Where hard-coded values bypass tokens: the design is largely token-driven. A full static sweep of
every `.module.css` for literal hex/px that should be a token is a follow-up for the design-system
fix item; spot checks found the shell CSS using the variables correctly.

---

## Screen-by-screen (live)

### Onboarding — "Connect a model" wizard (`components/settings/ConnectWizard.tsx`)
Auto-opens on first run when no provider is configured. Screenshot `00-initial-1920.png`.
- Well grouped: ChatGPT sign-in (NO API KEY), OpenRouter (FREE MODELS), "USE AN API KEY"
  (OpenAI, Anthropic, Gemini, Groq, Grok, Kimi, DeepSeek, Mistral, Cerebras, NVIDIA NIM, GitHub
  Models), "RUN A MODEL ON THIS COMPUTER" (Ollama, llama.cpp, LM Studio), "ADVANCED" (Azure,
  Cloudflare Workers AI, Custom OpenAI-compatible). Free tiers badged.
- States present: default, hover; the grid is clean and reads well. No overflow.
- **Finding (P3):** at 1920 the title bar above the modal is a wide empty dark band; the window
  controls (min/max/close glyphs) are faint/low-contrast against `--bg-primary`. Component:
  `components/TitleBar.tsx` + `TitleBar.module.css`.

### Cowork surface — new-task hero (`components/AgentLayout.tsx`, `panels/agent/*`)
Screenshots `01-cowork-empty-1920.png`, `10-cowork-1280x720.png`, `11-cowork-1024x640.png`.
- Clean centered hero ("What can I take off your plate?"), composer with Ask/Agent/Auto mode
  pills (Agent active, orange), model selector ("No model configured"), "Work in a project or
  folder" button, four task suggestions with emoji, a "Connect a model" banner + CTA, sidebar
  nav (New task, Projects, Runs, Timeline, Agent Console, Skills, Recents), Settings at bottom,
  a status bar (Cost + AGENT badge).
- States: the composer shows a correct **blocked/empty** state ("Connect a model to start",
  "Work in a project or folder") rather than a dead Send. Mode pills have descriptive tooltips
  (verified via `aria-label`).
- Responsive: holds at 1280×720 and 1024×640 with no overflow or overlap; the centred column
  reflows and the sidebar stays usable.
- **Finding (P3):** at 1920 the empty canvas on either side of the centred column is large
  dotted-grid negative space. Intentional, but a max-content-width with the grid feels sparse on
  very wide monitors. Component `AgentChat.module.css`.

### Code surface (`components/IdeLayout.tsx`, `components/ide/*`, `panels/ide/*`)
Live DOM confirms the full IDE chrome is present even with no folder open: ActivityBar (Explorer,
Search, Source Control, Diff Review, Live Architecture, Timeline, Agent Console, Run, Test
Results), file-tree toolbar (New file, New folder, Refresh the file tree, Collapse all folders —
all with `aria-label`s), the Explorer empty state ("No folder opened" + Open Folder + Clone
Repository), the Code chat sidebar, and the bottom panel (PROBLEMS / TERMINAL tabs, New terminal,
Clear the scrollback, Maximize/Hide panel). The terminal shows a correct empty state: "No folder
is open, so there is nowhere to run a command. Open a folder first."
- States: empty states are explicit and actionable everywhere a folder is required.
- Editor/split/syntax/tabs/breadcrumbs could not be exercised live because opening a real folder
  needs the native picker (unavailable in the dev bridge). **UNTESTED in a running app** — Monaco
  wiring, `CodeEditor`, model registry and `paths.ts` were reviewed at source and are sound.

### Settings dialog (`components/settings/SettingsDialog.tsx`)
Screenshots `03-settings-1920.png` (Models), `04-settings-agent.png` (Agent). Tabs: Models,
Agent, Editor, Privacy, "Shortcuts & privacy". Footer: "Engine: ready · v0.1.0".
- **Models:** "On this computer" card showing REAL hardware (16 GB / 2 GB free · 20 CPU threads ·
  RTX 3060 6 GB), an Ollama-not-installed state with a "Get Ollama" link + Refresh, and a provider
  list (ChatGPT sign-in, OpenAI/Anthropic/Gemini/… each "Not configured" + Add) with a
  "No provider configured" empty state. Honest, specific copy.
- **Agent:** "Apply edits automatically" and "Check changes with the project's own tests" toggles,
  each with a clear one-paragraph explanation.
- **Editor:** Color theme (Dark/Light/Match system), Font size, Indentation (2/3/4/8 · Spaces/Tabs),
  Auto save, etc. Inputs are labelled.
- **Privacy:** Offline Mode toggle + description, Network activity (Refresh), data storage.
- **"Shortcuts & privacy":** the content header is **"Privacy & safety"** and the body is privacy
  statements (no account, keys in OS store, agent scoped to the open folder, `.sketch/` log) — not
  a keyboard-shortcut reference.
- **Finding (P2):** the nav label "Shortcuts & privacy" does not match its content header
  "Privacy & safety", and "Privacy" appears in TWO tab names, which is confusing; where the actual
  keyboard shortcuts are listed is unclear (there is a Command Palette, Ctrl+Shift+P). Component
  `components/settings/SettingsDialog.tsx` + `SettingsDialog.module.css`. Owning area: settings.
- **Finding (P3):** the modal is a fixed width with a large empty right gutter at 1920; verify it
  centres and uses width better on wide screens. `SettingsDialog.module.css`.
- Persistence: settings read back from the engine (`provider-catalog`, `privacy-status`) and the
  key-free `providers.json`; editor/agent prefs persist with the window. No dead inputs observed.

### Skills page (`panels/SkillsMarketplace.tsx`, `SkillsMarketplace.module.css`)
Screenshot context `08`/`11` (empty state). Given its own section per the brief.
- **Empty state (no folder):** "No folder opened — Skills install into the open project, under
  `.sketch/skills/`. Open a folder first." Correct gating (skills are per-project).
- **Registry tab:** header states the registry name, the distribution, and —
  when `distribution === 'curated'` — the explicit message **"the open marketplace is not enabled
  in this build"** (`SkillsMarketplace.tsx:307`). This is exactly the clear communication the brief
  asked for. The curated registry has 7 skills (verified via engine: commit-context,
  context-packing, finance-quant, frontend-design, research-stage, scope-discipline, web-data),
  each card showing name, summary, version, pack, capability grant, license, and an installed tag
  vs an install action. Install shows a verified outcome ("Installed … N file(s) verified against
  <digest>").
- **Installed tab:** lists installed skills in cards with name, description, capabilities, source
  path, and a "Train on my project" button when training is available.
- **Finding (P1, functional — overlaps BUG_AUDIT B-002):** there is **no Uninstall control** on an
  installed skill card (`SkillsMarketplace.tsx:403`+). The brief lists "Uninstall functionality"
  for this page; it is absent in both the UI and the engine (no `skill-uninstall` method). A user
  can install but cannot remove a skill from within Sketch.
- Install buttons, version labels, permissions (capability chips), install progress and
  success/failure states are all present and correctly aligned at the sizes checked; no overlapping
  install buttons or overflowing text were observed in the registry cards at 1920/1366/1024.

### Model selector (`components/ModelSelector.tsx`)
Shows "No model configured" when none set; the selected model id flows to the run (verified at
source — see ARCHITECTURE_REVIEW §5b). Dropdown behaviour not exercised live without a provider;
**UNTESTED live**, logic sound at source.

### What's new, Projects, Runs, Timeline, Agent Console, MCP Tools, Cost, Memory, etc.
Reachable from the nav; present in the DOM. Not individually screenshotted this pass (time budget;
breadth over depth). Empty-state copy is consistent with the panels reviewed. A deeper per-panel
visual pass with a folder open is a follow-up once the native-FS path is drivable (packaged app on
a host where CDP works, or a dev build that stubs the picker).

---

## Missing-state check (summary)
Across the screens exercised, the explicit states were present and correct: **default, hover,
disabled (Send when blocked), empty (no folder / no provider / no skills), and
blocked/offline messaging**. Loading and error states for the model-backed panels (chat streaming,
provider test) were not exercised live because no real provider key is available; they are
implemented at source (`ThinkingIndicator`, provider-test states in `AppState`) and marked
**UNTESTED live** with that reason.

## Dead buttons found
None confirmed dead in the screens exercised. The one gap that reads like a missing button is the
**absent Skills "Uninstall"** — it is not a broken handler, it is unimplemented (B-002). The
TitleBar window controls "work" in the packaged app but throw in the dev bridge (B-008) — not
dead, environment-specific.
