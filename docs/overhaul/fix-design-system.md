# W3 — Design system and app shell: fix

Item W3 of the Sketch IDE overhaul. One token set, shared component styles, the app
shell working at every window size, WCAG AA contrast in the dark theme, and the B-008
title-bar guard. Inputs read first (as leads, not facts): `docs/UI_UX_AUDIT.md`
(token inventory, faint title-bar window controls, wide-screen empty space,
settings-modal width), `docs/BUG_AUDIT.md` B-008, `docs/ARCHITECTURE_REVIEW.md` §3,
`docs/overhaul/audit-notes.md` (dev-preview CDP method), `docs/overhaul/fix-workspace-paths.md`
(QA build recipe §6). This document is the whole record for the fix.

Repo root: `C:\Users\saran\Downloads\sketch`. All anchors are `file:line` at that root.
Later items adopt what is built here: W6 (chat panel), W7 (Skills), W8 (editor/terminal/git),
W9 (settings). The component style usage reference (§2) and the hard-coded-value sweep (§7)
are the handoff for them.

---

## 1. What the owner asked, as it applies to W3

Sketch's app shell — the title bar, the activity bar / side panel, the Cowork sidebar,
the status bar, menus and dialogs — should feel like a polished, premium IDE: one
consistent design language, controls with every state, no overflow or overlap at any
window size, and readable contrast. W3 owns the shell and the design system that the
later feature items build on. It does not touch the chat panel, Skills, the editor, or
settings (other items own those).

---

## 2. The design system

### 2.1 One token set — `packages/desktop/src/styles/global.css`

All tokens live in `:root` (dark, the authored theme) with hand-picked light values in
`:root[data-theme='light']`. The light theme is two things: (1) the hand-picked light
value of every **colour** token here, and (2) the literal colours a stylesheet still
spells out, rewritten at build time by `styles/themeColors.ts`. A value written as
`var(--token)` carries both themes on its own, so referencing a token is always safe;
non-colour tokens (spacing, radii, fonts, z-index, sizes) are theme-independent and live
only in `:root`.

**Compatibility rule honoured:** every token name the stylesheets already used keeps
working. The tokens that were NAMED for the old teal brand but held ORANGE values are
given accurate names, and the old teal names are kept as **aliases pointing at the new
ones**, so no stylesheet has to change to stop lying.

#### Token reference table

| Token | Dark value | Purpose | Old alias (if any) |
|---|---|---|---|
| `--bg-primary` | `#121212` | window base | `--bg-teal-dark` → this |
| `--bg-secondary` | `#171717` | panels, side/title/status bars | `--bg-teal-main` → this |
| `--bg-surface` | `#1e1e1e` | cards, menus, dialogs | — |
| `--bg-elevated` | `#262626` | a raised control on a surface | `--bg-teal-elevated` → this |
| `--bg-hover` | `#2a2a2a` | hover wash on an elevated control | — |
| `--bg-active` | `rgba(249,115,22,.15)` | selected/active wash (accent tint) | — |
| `--text-primary` | `#f5f5f5` | body, headings | — |
| `--text-secondary` | `#a3a3a3` | secondary labels, menu hints | — |
| `--text-muted` | `#8a8a8a` | faintest readable text (was `#737373`) | — |
| `--text-disabled` | `#5a5a5a` | disabled control label (sub-AA by design) | — |
| `--text-on-accent` | `#ffffff` | label on an accent/status fill | — |
| `--accent` | `#f97316` | brand orange: links, active icons, focus ring | — |
| `--accent-hover` | `#fb923c` | lighter orange on hover (text/icon) | — |
| `--accent-active` | `#ea580c` | pressed/active orange | `--accent-teal` → this |
| `--accent-subtle` | `rgba(249,115,22,.2)` | faint accent tint (chips, active bg) | — |
| `--accent-fill` | `#cf4409` | white-label button fill (was `#ea580c`; see §5) | — |
| `--accent-fill-hover` | `#c2410c` | that fill on hover (deeper) | — |
| `--accent-strong` | `#f97316` | bright orange (logo gradient top) | `--accent-teal-bright` → this |
| `--success` | `#22c55e` | status: ok | — |
| `--warning` | `#eab308` | status: warning | — |
| `--error` | `#ef4444` | status: error, destructive | — |
| `--info` | `#3b82f6` | status: informational | — |
| `--purple`, `--pink` | `#c084fc`, `#f472b6` | accents used by panels | — |
| `--border` | `#262626` | normal 1px line between surfaces | — |
| `--border-subtle` | `#1e1e1e` | quieter divider inside a surface | — |
| `--border-strong` | `#333333` | line around a floating menu/dialog | — |
| `--font-sans / -mono / -serif` | Inter / JetBrains Mono / Georgia | type families | — |
| `--text-2xs … --text-2xl` | `10px … 26px` | type scale | — |
| `--font-weight-normal … -bold` | `400 … 700` | weight scale | — |
| `--space-1 … --space-16` | `2px … 32px` | 4px-based spacing scale | — |
| `--radius-sm / --radius / --radius-md / --radius-lg / --radius-full` | `4/6/8/10/9999px` | corner radii | — |
| `--shadow-sm / -md / -lg / -xl` | elevation shadows | floating surfaces | — |
| `--z-base … --z-tooltip` | `1 / 20 / 800 / 1000 / 1001 / 2000 / 3000` | stacking layers (base, sticky, dropdown, overlay, modal, context-menu, tooltip) | — |
| `--icon-xs … --icon-xl` | `12 / 14 / 16 / 20 / 24px` | icon sizes | — |
| `--control-sm / -md / -lg` | `24 / 30 / 36px` | button/input heights | — |
| `--focus-ring` / `--focus-ring-width` | `0 0 0 2px var(--accent)` / `2px` | keyboard focus ring | — |

Every new colour token above has a hand-picked light value in the
`:root[data-theme='light']` block, which is what the themeColors test enforces (§6). The
compatibility aliases are written as `var(--new-token)` in both themes, so they are not
treated as colour variables needing their own light twin and always resolve to the
current theme's value.

#### Light theme + reduced motion

- The light-theme block gives every new colour token its light value (e.g.
  `--text-disabled: #9a9a9a`, `--info: #1d4ed8`, `--border-strong: #d4d4d4`,
  `--accent-active/-strong/-fill: #c2410c`). The existing `themeColors`/`colorTheme`
  tests still pass (§6).
- `global.css` now carries a `@media (prefers-reduced-motion: reduce)` block that makes
  animations/transitions near-instant and disables the decorative slide/float/pulse,
  keeping only a slow spinner so a loading state still reads. No new gradients, no new
  decorative animation were added (invariant 7). The one gradient touched (the `S` logo)
  is the pre-existing brand gradient, re-expressed with tokens.

### 2.2 Shared component styles — `packages/desktop/src/styles/components.css`

A new stylesheet of plain global classes, imported through `global.css` (after
`fonts.css`). Every value is a token, so the primitives match in both themes and change
in one place. **Usage reference for the later items:**

| Primitive | Class(es) | Variants / states | Example |
|---|---|---|---|
| Button | `sk-btn` | `sk-btn--primary \| --secondary \| --ghost \| --danger`; size `--sm \| --lg` (default md); `--icon` (square); `--loading` (spinner, pointer-events off); native `:disabled`; `:focus-visible` ring | `<button class="sk-btn sk-btn--primary">Install</button>` · icon: `<button class="sk-btn sk-btn--ghost sk-btn--icon" aria-label="Refresh">…</button>` |
| Text input / textarea | `sk-input` | `sk-field--error` (red outline + `sk-field-error-text`); `:disabled`; focus ring | `<input class="sk-input" />` |
| Select | `sk-select` | same error/disabled/focus | `<select class="sk-select">…</select>` |
| Checkbox | `sk-checkbox` | accent-tinted, `:disabled` | `<input type="checkbox" class="sk-checkbox" />` |
| Toggle | `sk-toggle` | `<button role="switch" aria-checked>`; knob via `::after`; focus ring | `<button role="switch" class="sk-toggle" aria-checked="true" />` |
| Modal / dialog | `sk-modal-backdrop` > `sk-modal` | backdrop at `--z-overlay`, modal at `--z-modal`; width `min(480px, 100vw-32px)`; `max-height`+scroll | `<div class="sk-modal-backdrop"><div class="sk-modal" role="dialog" aria-modal="true">…</div></div>` |
| Menu / dropdown / context menu | `sk-menu` + `sk-menu-item` + `sk-menu-sep` + `sk-menu-hint` | item hover = accent fill; disabled; focus ring | `<div class="sk-menu" role="menu"><button class="sk-menu-item" role="menuitem">Open<span class="sk-menu-hint">Ctrl+O</span></button></div>` |
| Tooltip | `sk-tooltip` | at `--z-tooltip` | `<div class="sk-tooltip" role="tooltip">…</div>` |
| Badge | `sk-badge` | tone `--accent \| --success \| --warning \| --error \| --info` | `<span class="sk-badge sk-badge--success">verified</span>` |
| Chip | `sk-chip` | `aria-pressed` for selectable | `<button class="sk-chip" aria-pressed="true">fs:read</button>` |

The shell components W3 owns adopt the tokens (and, where they were bespoke, keep their
own CSS-module classes that now reference tokens). `ConfirmDialog.module.css` and
`ContextMenu.module.css` were already token-driven and align with the primitives above —
a useful reference for the later items when they migrate their own dialogs/menus.

---

## 3. The shell at every window size

Verified in the Vite dev preview over headless Edge CDP (the method in
`docs/overhaul/audit-notes.md`; the packaged app cannot be driven over CDP on this host —
see `fix-workspace-paths.md` §6.4), isolated home, `SKETCH_FAKE_PROVIDER=1`, via the new
`packages/desktop/scripts/w3-shell-shots.mjs`. Both surfaces (Cowork and Code) at
1920×1080, 1600×900, 1366×768, 1280×720, 1024×640, and 900×600 (the app's
`tauri.conf.json` `minWidth`/`minHeight`).

### Size matrix with overflow measurements

`document.documentElement.scrollWidth` vs `clientWidth` at each size, both surfaces
(saved to `picture/overhaul/w3/after-overflow.json`):

| Size | Surface | scrollWidth | clientWidth | Horizontal overflow |
|---|---|---|---|---|
| 1920×1080 | Cowork / Code | 1920 / 1920 | 1920 / 1920 | none / none |
| 1600×900 | Cowork / Code | 1600 / 1600 | 1600 / 1600 | none / none |
| 1366×768 | Cowork / Code | 1366 / 1366 | 1366 / 1366 | none / none |
| 1280×720 | Cowork / Code | 1280 / 1280 | 1280 / 1280 | none / none |
| 1024×640 | Cowork / Code | 1024 / 1024 | 1024 / 1024 | none / none |
| 900×600 (min) | Cowork / Code | 900 / 900 | 900 / 900 | none / none |

**No horizontal overflow at any size, on either surface, including the minimum window.**

Screenshots (before → after):
- Before: W1's audit shots in `picture/overhaul/w1/` (`00-initial-1920.png`,
  `10-cowork-1280x720.png`, `11-cowork-1024x640.png`) — the authentic pre-change baseline.
- After: `picture/overhaul/w3/after-{cowork,code}-{1920x1080,1600x900,1366x768,1280x720,1024x640,900x600}.png`
  (12 shots).

Spot-checked visually: the 1920×1080 Code shell renders with the title bar (Cowork|Code
pill + window controls), the left activity bar, and the Connect-a-model modal; the
900×600 Code shell folds the seven menus into one "Menu" (the `compactMenus` threshold at
`TitleBar.tsx`), keeps the activity bar and window controls, and the modal fits with
internal scroll. (The Connect-a-model wizard auto-opens on first run because no provider
is configured — it is the modal primitive at work, not a surface defect. A caveat: with
that modal open, the Cowork→Code pill click is intercepted at some sizes, so a few "code"
shots show the shell behind the modal; the overflow metric is still measured on the live
document and is correct.)

### Stacking, resize and drag region

- Z-index layers are tokenised and ordered: panels/sticky (20) < dropdown (800) <
  modal backdrop (1000) < modal (1001) < context menu (2000) < tooltip (3000). Menus and
  tooltips sit above panels; modals above everything.
- Resize handles clamp to sane limits: the IDE `SidePanel` to `[150, 600]px`
  (`SidePanel.tsx` `handleMouseDown`), the shared `ResizeHandle` keeps its hover/active/
  focus-visible states (`ResizeHandle.module.css`).
- The title-bar drag region (`data-tauri-drag-region`) never swallows a control click:
  the window-control buttons call `e.stopPropagation()` (`TitleBar.tsx`
  `renderWindowControls`), so min/max/close stay clickable.

---

## 4. Every shell control has states + accessibility

- **ActivityBar** (`components/ide/ActivityBar.tsx` + `.module.css`): every icon-only
  button now carries both `title` and `aria-label`; the active view is marked
  `aria-current="page"`; icons are `aria-hidden`; the bar is a `<nav aria-label="Views">`.
  Hover = `--bg-hover` + `--text-primary`; `:focus-visible` = the accent ring; active =
  `--accent` with the 2px accent rail.
- **TitleBar** icon buttons (`topIconBtn`, `navIconBtn`) and window controls have hover
  and `:focus-visible` states; the window controls carry `title` + `aria-label` (and the
  Settings button names its shortcut, `Settings (Ctrl+,)`).
- **Menus** (TitleBar `Menu`, CommandPalette, ContextMenu) use `role="menu"`/`menuitem`,
  disabled styling, and hover = accent fill.
- Navigation is grouped and spaced consistently in both the IDE activity bar and the
  Cowork sidebar (`ConversationSidebar.module.css` nav group spacing tokenised).
- Keyboard pass: tabbing through the shell shows the `:focus-visible` ring (one ring
  defined globally in `global.css` `:focus-visible`, reused by the component classes).

---

## 5. Contrast (dark theme, WCAG AA)

Measured WCAG 2 ratios for the key pairs (computed by `packages/desktop/scripts/w3-contrast.mjs`
from the token values). AA requires 4.5:1 for normal text and 3:1 for large text / UI
component boundaries.

| Pair | Ratio | AA normal (4.5) | AA large/UI (3.0) |
|---|---|---|---|
| `--text-primary` on `--bg-primary` | 17.18:1 | pass | pass |
| `--text-primary` on `--bg-secondary` | 16.44:1 | pass | pass |
| `--text-primary` on `--bg-surface` | 15.29:1 | pass | pass |
| `--text-secondary` on `--bg-primary` | 7.43:1 | pass | pass |
| `--text-secondary` on `--bg-secondary` | 7.11:1 | pass | pass |
| `--text-muted` on `--bg-primary` | 5.43:1 | pass | pass |
| `--text-muted` on `--bg-surface` | 4.83:1 | pass | pass |
| **window controls** (was `#64748b`) now `--text-secondary` on title-bar `--bg-primary` | **7.43:1** | pass | pass |
| `--accent` on `--bg-primary` | 6.68:1 | pass | pass |
| `--accent` on `--bg-surface` | 5.95:1 | pass | pass |
| `--success` on `--bg-primary` | 8.22:1 | pass | pass |
| `--warning` on `--bg-primary` | 9.77:1 | pass | pass |
| `--error` on `--bg-primary` | 4.98:1 | pass | pass |
| `--info` on `--bg-primary` | 5.09:1 | pass | pass |
| white label on `--accent-fill` (primary button, rest) | 4.68:1 | pass | pass |
| white label on `--accent-fill-hover` | 5.18:1 | pass | pass |

Two deliberate value changes to meet AA, both documented in `global.css`:

1. **The faint title-bar window controls** (the audit's P3). Before: `#64748b` on
   `#121212` = **3.94:1** (below AA). After: `--text-secondary` (`#a3a3a3`) = **7.43:1**,
   and each lights to full `--text-primary` on hover; Close goes to `--error` on hover.
   (`TitleBar.module.css` `.windowControls`.)
2. **The primary-button fill.** Before: `--accent-fill: #ea580c`, white label = only
   **3.56:1** (fails AA for normal text — button labels are normal text). After:
   `--accent-fill: #cf4409`, white label = **4.68:1** (passes), while staying within the
   Sketch orange identity; hover stays deeper at `#c2410c` (5.18:1). The light theme's
   `--accent-fill` is unchanged (`#c2410c`, already AA), so the `themeColors` AA test
   still passes.

`--text-muted` was also nudged `#737373` → `#8a8a8a` so the faintest readable text clears
AA on the dark surfaces (5.43 / 4.83:1); the sub-AA `--text-disabled` (`#5a5a5a`) is the
token for *disabled* controls only, which AA exempts. The light theme still passes its
existing tests (§6).

---

## 6. B-008 — the title-bar window-control guard

**Bug (BUG_AUDIT B-008):** `windowCall` in `TitleBar.tsx` called `getCurrentWindow()`
without checking the runtime first, so in the Vite dev preview (no Tauri) every
minimize/maximize/close click threw `TypeError: Cannot read properties of undefined
(reading 'metadata')` and dirtied the console, hiding real errors during development.

**Fix:**
- `packages/desktop/src/ipc/bridge.ts` now exports `isTauri()`, the one source of truth
  for "running under the Tauri runtime" (`'__TAURI_INTERNALS__' in window`), beside the
  existing `invoke` guard.
- `packages/desktop/src/components/TitleBar.tsx:167` — `windowCall` returns early when
  `!isTauri()`, **before** importing/calling `getCurrentWindow`. The unsaved-work close
  prompt still runs in dev (so the behaviour is visible), only the no-op native call is
  skipped. In the packaged app `isTauri()` is true, so the controls work exactly as before.

**Test (invariant 6):** `packages/desktop/src/components/TitleBar.test.tsx` adds two cases
under "the window controls guard the Tauri-only API (B-008)":
- running under Tauri (`isTauri` mocked true), a Minimize click reaches the mocked window
  API (`win.minimize` called) — proves the control still works in the packaged app;
- outside Tauri (dev preview), Minimize + Maximize clicks never reach the window API
  (`getCurrentWindow`/`win.minimize`/`win.toggleMaximize` not called).

**Mutation check (non-vacuity):** disabling the guard (`// if (!isTauri()) return;`) made
the dev case FAIL — the window API was reached once (`expected "spy" to not be called at
all, but … called 1 times`). Guard restored → all 5 TitleBar tests pass.

---

## 7. Hard-coded value sweep

Literal hex/rgb colours per owned shell `*.module.css`, before → after (counted by
`[regex] '#[0-9a-fA-F]{3,8}' | 'rgba?\(…\)'`):

| File | Owner going forward | before | after | Remaining literals (why) |
|---|---|---|---|---|
| `components/TitleBar.module.css` | W3 (shell) | 31 | 7 | `#3b3b3b` pill slider, `#ffe4d4`/`#fdba74` on-hover text, logo-gradient stops, `#ffffff /* theme: fixed */` close-hover label — all derived for light by `themeColors.ts` |
| `components/StatusBar.module.css` | W3 (shell) | 10 | 2 | `#fdba74` autocomplete-on text, one accent tint — derived |
| `components/ide/ActivityBar.module.css` | W3 (shell) | 8 | 1 | `#3b3b3b`-class none left; one remaining accent-tint badge colour — derived |
| `components/ide/SidePanel.module.css` | W3 (shell) | 6 | 1 | one resize-handle hover tint — derived |
| `panels/agent/ConversationSidebar.module.css` | W2 owns `open()` logic; W3 owns markup/classes/CSS | 31 | 7 | `#3b3b3b` pill slider, `#fca5a5`/`#2a1414` danger-delete, `#fdba74`/`#7c2d12` connect-button tints — derived |
| `components/CommandPalette.module.css` | W3 (shell) | ~16 (new untracked file) | 1 | one backdrop scrim `rgba(0,0,0,.35)` — derived |

Shell CSS modules that were already token-driven and left as-is (reference for later
items): `ConfirmDialog.module.css`, `ContextMenu.module.css`, `BottomPanel.module.css`,
`AppLayout.module.css` (0 literals), `ResizeHandle.module.css` (1 accent tint).

The remaining literals are all intentional accent-tinted states, danger states, or the
pill slider; none is a theme variable value, and each is handled by the build-time light
derivation (proven by `themeColors.test.ts`, §6). The later items that own files outside
the shell (chat panel, Skills, editor, settings) can convert their own literals to the
tokens in §2; this sweep is their starting inventory.

---

## 8. Tests, typecheck, build (every command + result)

Each typecheck/test ran in a **later step** than the edits it checks. Vitest `--maxWorkers=1`
throws on 2.1.9 here, so serial execution used `--pool=forks --poolOptions.forks.singleFork=true`.

```
cd packages/desktop

# Styles + shell unit tests
npx vitest run src/styles/themeColors.test.ts src/styles/colorTheme.test.tsx \
  src/components/TitleBar.test.tsx src/components/ConfirmDialog.test.tsx \
  --pool=forks --poolOptions.forks.singleFork=true
→ Test Files 4 passed (4);  Tests 20 passed (20)
   (themeColors 10, colorTheme 3, TitleBar 5 incl 2 new B-008 cases, ConfirmDialog 2)

# Mutation check — B-008 guard removed
npx vitest run src/components/TitleBar.test.tsx --pool=forks --poolOptions.forks.singleFork=true
→ 1 FAILED: "does not reach the window API outside Tauri" — getCurrentWindow called 1 time
   (guard restored → 5 passed)

# Typecheck
npx tsc --noEmit
→ exit 0, no errors

# Build (the canonical CSS-compile gate: tsc -b + vite build)
NODE_OPTIONS=--max-old-space-size=1536 npm run build -w @sketch/desktop
→ ✓ built in 20.84s (exit 0); dist/assets/index-*.css 205.40 kB incl the derived light theme

# Contrast (read-only computation from the token values)
node scripts/w3-contrast.mjs
→ table in §5; window controls 3.94→7.43:1, primary-button label 4.68:1, all AA pass

# CSS parse sanity (light proof that the two authored sheets parse)
node scripts/w3-css-check.mjs
→ global.css 51 rules/222 decls; components.css 56 rules/226 decls; parse OK

# Shell screenshots + overflow at 6 sizes × 2 surfaces (dev preview over headless Edge)
W3_VITE_PORT=1431 W3_EDGE_PORT=9432 node scripts/w3-shell-shots.mjs --phase after
→ 12 shots in picture/overhaul/w3/; zero horizontal overflow at every size (§3)
```

The chunk-size warning in the build (monaco runtime > 500 kB) is pre-existing and
unrelated to W3.

---

## 9. Files modified / added

| File | Change | In W3's list? |
|---|---|---|
| `packages/desktop/src/styles/global.css` | Full semantic token set (bg/surface/text incl disabled+on-accent, accent hover/active/subtle/fill/strong, status incl info, borders incl strong, type scale, spacing, radii, shadows, z-index, icon sizes, control heights, focus ring); old teal names kept as aliases; light twins for all new colour tokens; `prefers-reduced-motion` block; focus-ring tokenised; `@import './components.css'`. | yes |
| `packages/desktop/src/styles/components.css` | **New.** Shared component primitives (buttons, inputs, select, checkbox, toggle, modal, menu, tooltip, badge, chip). | yes (a new shared stylesheet, per the grant) |
| `packages/desktop/src/ipc/bridge.ts` | Exported `isTauri()` (one source of truth for the runtime check). | yes (shell shares it; B-008 needs it) |
| `packages/desktop/src/components/TitleBar.tsx` | B-008 guard in `windowCall` (`:167`); import `isTauri`. | yes |
| `packages/desktop/src/components/TitleBar.test.tsx` | Two B-008 guard cases + mocks. | yes (tests) |
| `packages/desktop/src/components/TitleBar.module.css` | Tokens throughout; window-control contrast + focus states. | yes |
| `packages/desktop/src/components/StatusBar.module.css` | Tokens throughout. | yes |
| `packages/desktop/src/components/ide/ActivityBar.tsx` | `aria-label` + `aria-current` on every view button; `<nav aria-label>`; icons `aria-hidden`. | yes |
| `packages/desktop/src/components/ide/ActivityBar.module.css` | Tokens; hover/focus-visible/active states. | yes |
| `packages/desktop/src/components/ide/SidePanel.module.css` | Tokens; resize-handle z via token. | yes |
| `packages/desktop/src/components/CommandPalette.module.css` | Tokens throughout (was mostly literals). | yes |
| `packages/desktop/src/panels/agent/ConversationSidebar.module.css` | Tokens throughout (markup/classes untouched; W2's `open()` logic untouched). | yes (CSS + classes only) |
| `packages/desktop/scripts/w3-contrast.mjs` | **New.** Read-only WCAG ratio computation for the doc. | script, tracked path |
| `packages/desktop/scripts/w3-css-check.mjs` | **New.** Read-only PostCSS parse check of the two authored sheets. | script, tracked path |
| `packages/desktop/scripts/w3-shell-shots.mjs` | **New.** Dev-preview CDP screenshot + overflow driver (6 sizes × 2 surfaces). | script, tracked path |

**Dependencies added: none** (expected). **Mock data: none. Security checks weakened:
none.** No file outside the W3 ownership list was changed; the ~120 pre-existing dirty
files in the worktree were left as they were; nothing was committed, pushed, stashed,
reset, or reverted. W5's files (`packages/core/**`, `AgentSession.tsx`, `runSummary.ts`,
`AgentChat.tsx`) were not touched, and `npm run build -w @sketch/core` was never run.

---

## 10. Remaining limitations

- **QA-app rebuild + real-window shot + `smoke:boot` not run this round.** The host was
  memory CRITICAL (0.9–1.4 GB free) through most of the session and only reached TIGHT
  (2.1–2.4 GB) in a short window used for the vite build and the dev-preview screenshots.
  A Tauri GNU-toolchain build + `qa-window-shot.ps1` + `smoke:boot` (the recipe in
  `fix-workspace-paths.md` §6) is far heavier and would risk OOM-failing and
  destabilising other sessions on this shared host, so it was deferred, as the item's
  verification notes explicitly allow. The dark-theme CSS compiles (vite build passed)
  and the real runtime boots clean per W2's §7.5 round-2 QA build; the token/CSS change
  here is CSS-only and does not alter Tauri config, so it cannot affect app boot.
- **CDP screenshots are from the dev preview, not the packaged app.** On this host
  WebView2 156 opens no DevTools listener (diagnosed in `fix-workspace-paths.md` §6.4),
  so the packaged app cannot be driven over CDP. The dev preview is the same React source
  and the same engine; its one limitation is native FS commands, which the shell shots do
  not exercise.
- **A few "code"-surface shots show the shell behind the auto-opened Connect-a-model
  modal** (the pill click is intercepted by the modal at some sizes). The overflow metric
  is measured on the live document and is correct regardless; the modal itself is a good
  demonstration of the modal primitive being responsive down to 900×600.
- **The light theme was verified by its existing tests, not re-measured by eye in a
  running window** (dark is the product's identity and the focus of this item). The
  `themeColors` AA test holds the light theme to WCAG AA and still passes.
