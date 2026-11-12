# W9 — Settings and app chrome: fix

Item W9 of the Sketch IDE overhaul. It owns Settings (grouping, labels, persistence,
reset, settings that take effect, protected secrets) and the app chrome around it: the
keyboard-shortcuts reference, the What's New popover, the notification inventory, and
import/export. Inputs read first as leads, not facts: `docs/BUG_AUDIT.md` B-009,
`docs/UI_UX_AUDIT.md` (Settings), and the earlier fix docs `fix-editor-workbench.md` §6
(W8's verified shortcuts), `fix-design-system.md` (W3 tokens), `fix-ai-providers.md`
(W4), `fix-chat-panel.md` (W6), `fix-workspace-paths.md` (W2 — including the QA build
recipe §6).

Repo root: `C:\Users\saran\Downloads\sketch`. Anchors are `file:line` at that root. No
provider API key was used or requested; onboarding was dismissed with a keyless `custom`
provider over the dev preview. No tracked file outside the W9 list was changed except the
three lead-approved call-site repoints in §1. The pre-existing dirty worktree was left
as-is; nothing was committed, pushed, stashed, reset, or reverted. Every dev-preview
launch used a throwaway `%TEMP%` home and stopped the vite/Edge processes it started by
the PIDs it launched.

---

## 1. What the owner asked, as it applies to W9

Settings must be grouped so each tab's name matches its content and nothing appears under
two names (B-009); every input must have a visible label and work by mouse and keyboard;
every setting must persist AND take effect, or be fixed/removed; Restore defaults must
reset exactly its section and ask before discarding non-default values; API keys must
stay masked and never leak to storage, logs or an export; the shortcuts reference must
list exactly what works; What's New must be true; notifications must be consistent; and
import/export must exist and be real. The owner named one defect here: **B-009**.

### Lead-approved cross-item call-site repoints (round 8)

Splitting the mislabelled `about` tab moved its two kinds of content to two tabs, so the
navigation that pointed at `'about'` had to be repointed. With the lead's explicit
approval, three one-line `OPEN_SETTINGS` payload changes were made outside the W9 list:

- `components/CommandPalette.tsx:121` — "Help: Keyboard Shortcuts" → `'shortcuts'`.
- `components/TitleBar.tsx:298` — Help menu "Keyboard Shortcuts" → `'shortcuts'`.
- `panels/agent/AgentChat.tsx:331` — "How Sketch keeps your code and keys safe" →
  `'privacy'` (its content, the Privacy & safety statements, now lives in Privacy).

A grep of both packages for `OPEN_SETTINGS`, `settingsTab` and `'about'` found no other
consumer and no test asserting the old labels. A persisted `settingsTab: 'about'` still
opens a valid tab (About still exists).

---

## 2. Invariant 1 — settings grouped clearly (B-009), labelled, keyboard-usable

### Before (evidence)
`components/settings/SettingsDialog.tsx` `TABS` had five tabs; the last had `id: 'about'`
but `label: 'Shortcuts & privacy'`, and its body rendered an `<h2>Privacy & safety</h2>`
block AND an `<h2>Keyboard shortcuts</h2>` table. So "privacy" appeared under both the
`privacy` tab and the `about` tab's body, and the shortcuts reference was buried under a
tab named for privacy — exactly B-009. The dialog's only keyboard affordance was Escape;
there was no focus trap and no focus return.

### Root cause (file:line)
`SettingsDialog.tsx` `TABS` (the `{ id: 'about', label: 'Shortcuts & privacy' }` entry)
and the `state.settingsTab === 'about'` body that mixed privacy text with the shortcut
table. `SHORTCUTS` was also exported from `SettingsDialog.tsx`, coupling the display list
to the dialog file.

### The fix
- `TABS` is now **Models, Agent, Editor, Privacy, Shortcuts, About** (six distinct names,
  each matching its body). `SettingsTab` in `state/AppState.tsx:378` gained `'shortcuts'`.
- **Privacy** owns all privacy: Offline Mode + network activity + data storage
  (PrivacySettings) **plus** the "Privacy & safety" statements moved in from the old tab.
- **Shortcuts** owns the keyboard reference only, rendered from the new shared table
  module `src/shortcuts.ts` (not the dialog file).
- **About** (new `AboutPane`) owns version, engine status, where data lives, settings
  export/import and the project links.
- Every input keeps a visible label or `aria-label`; the Shortcuts table keeps
  `role="table"`/`row`/`cell`. Added `:focus-visible` rings to nav items, the close
  button, selects, number inputs and buttons.
- **Keyboard**: on open the dialog moves focus inside itself, traps Tab/Shift+Tab within
  the dialog, returns focus to the opener on close, and closes on Escape
  (`SettingsDialog` `useEffect`).

### Proof after (jsdom)
`components/settings/SettingsDialog.test.tsx` (10): six distinct tab buttons, no
"Shortcuts & privacy"; Shortcuts holds the table (not privacy text); Privacy holds the
statements; About holds version/export-import (not the table); every editor input has an
accessible name; Escape closes. §10.

---

## 3. Invariant 2 — settings persist and take effect

Store: UI settings in `localStorage 'sketch.ui.v1'`
(`state/AppState.tsx` `savePersistedState`/`loadPersistedState`); Offline Mode via
`privacy-set` in the engine home (W2/PrivacySettings). Takes-effect is proven at the code
seam and by tests:

| Setting | Store | Persists? | Takes effect (how proven) |
|---|---|---|---|
| Editor: font size | sketch.ui.v1 | yes (round-trip test) | `editor/CodeEditor.tsx:148` → Monaco `fontSize`/`lineHeight` |
| Editor: indentation (tabSize, insertSpaces) | sketch.ui.v1 | yes | `CodeEditor.tsx:150-151`; status bar `StatusBar.tsx:77` |
| Editor: auto save | sketch.ui.v1 | yes | `EditorArea.tsx:108` drives the save-on-delay / on-blur behaviour |
| Editor: colour theme | sketch.ui.v1 | yes | `styles/colorTheme.ts:54`, read pre-render by `persistedColorTheme()` |
| Editor: word wrap / minimap / line numbers / whitespace / sticky / bracket colours / language features | sketch.ui.v1 | yes | `CodeEditor.tsx:152-158`, `:468`/`:672` (language services) |
| Agent: Apply edits automatically (autoApply) | sketch.ui.v1 | yes (round-trip test) | `lib/AgentSession.tsx:148` → `reviewEdits: !autoApply` |
| Agent: Check with project's tests (verifyChanges) | sketch.ui.v1 | yes | `AgentSession.tsx:141,152` → `verifyPolicy: true` |
| Agent: max steps / spend ceiling | sketch.ui.v1 | yes | bounded in reducer; sent on the next run |
| Privacy: Offline Mode | engine `privacy-set` (home) | yes (engine-owned) | blocks network providers (W2/PrivacySettings; proven in `PrivacySettings.test.tsx`) |

No setting was found to be dead; none had to be removed. Proof:
`state/settingsPersistence.test.ts` (8) for round-trips and reset; the seam anchors above
are W4/W8's already-verified consumers (`fix-ai-providers.md`, `fix-editor-workbench.md`).

---

## 4. Invariant 3 — Restore defaults asks first, never touches keys

### Before
Both "Restore defaults" buttons dispatched the full defaults object unconditionally — no
prompt even when the user had non-default values to lose.

### The fix
`useResetSection(section, isDefault, apply)` in `SettingsDialog.tsx`: if the section is
already at defaults it is a no-op (nothing to discard, no prompt); otherwise it asks via
`ConfirmDialog` with a danger button, and the message states plainly that it does **not**
touch API keys or providers. The Editor and Agent resets both go through it
(`sameSettings` / `agentIsDefault` decide `isDefault`). No reset touches
`settings/keyStore.ts` or provider config — these sections hold only UI preferences.

### Proof after (jsdom + mutation)
`SettingsDialog.test.tsx`: does not ask when already at defaults; asks (with the
"does not touch your API keys" wording) when the editor settings differ. **Mutation:**
forcing `useResetSection` to apply without confirming made the "asks for confirmation"
case FAIL (1 failed) → restored → pass.

---

## 5. Invariant 4 — sensitive information is protected

- **Masking**: key inputs live in `panels/ProviderSettings` / `ConnectWizard` (W4's,
  unchanged by W9); they show a stored / not-stored state, never the key. W9 does not add
  any surface that renders a key.
- **No key in local storage / logs / export**: `state/AppState.tsx` `scrubSecrets`
  rewrites credential-shaped strings before persisting conversations; the settings export
  (`settingsIo.ts`) has **no** key or provider field by construction, and the importer
  **refuses** any blob containing a key-shaped field.
- **Removing a key** needs a confirmation (W4's ProviderSettings flow; W9's reset never
  removes one and says so).

### Proof after (jsdom + mutation)
`state/settingsPersistence.test.ts`: a key-shaped string pasted into a conversation is
`[redacted]` in `sketch.ui.v1`; an imported settings object leaves no `apiKey`/`providers`
in state or storage. `settingsIo.test.ts`: the export JSON matches none of
`apiKey|providers|baseUrl|mcpServers|token`; an import carrying `apiKey: 'sk-…'` is
refused with a specific error. **Mutation:** disabling the importer's key-shape check made
"refuses a blob carrying a key-shaped field" FAIL (1 failed) → restored → pass. No real
Credential Manager write was exercised.

---

## 6. Invariant 5 — keyboard shortcuts: one source of truth

### Before
`SHORTCUTS` was a bare `[keys, what]` array inside `SettingsDialog.tsx`, maintained by
hand with no link to the handlers in `App.tsx` / `EditorArea.tsx` / `CommandPalette.tsx`.
It also listed chords that are not bound (`Ctrl+C` "stop terminal", `Ctrl+Tab` only).

### The fix
New `src/shortcuts.ts` is the one table the Shortcuts tab renders. It is W8's VERIFIED
list (`fix-editor-workbench.md` §6) plus the window-wide chords `App.tsx` binds, each row
tagged by the layer that binds it (`global` / `editor` / `monaco` / `chat`). A
`GLOBAL_CHORDS` mirror lists exactly the chords `App.tsx` globally binds. The contract
test `shortcuts.contract.test.ts` fails if a `global` row names a chord `App.tsx` does not
bind (listing without handler) or a bound chord is unlisted (handler without listing), AND
asserts each `GLOBAL_CHORDS` entry is provably handled in `App.tsx` by reading the source
for the branch that recognises it — so the mirror cannot silently drift.

The shortcut table (as displayed):

| Layer | Shortcuts |
|---|---|
| global (App.tsx) | Ctrl+, Settings · Ctrl+O Open folder · Ctrl+P Go to file · Ctrl+Shift+P Commands · Ctrl+` Terminal · Ctrl+Shift+` New terminal · Ctrl+J Bottom panel · Ctrl+B Side bar · Ctrl+Shift+E/F/H/G/M Explorer/Search/Replace/SCM/Problems · Ctrl+N New file · Ctrl+=/− zoom · Ctrl+0 reset zoom · Alt+Z word wrap · Shift+Alt+R reveal file |
| editor (EditorArea.tsx) | Ctrl+S save · Ctrl+Alt+S save all · Ctrl+W close tab · Ctrl+Tab/PageDown/PageUp switch tab |
| monaco | Ctrl+F/H find/replace · Ctrl+G go to line · Ctrl+Shift+O symbol · F12 definition · F2 rename · Shift+Alt+F format · Ctrl+/ comment · F8/Shift+F8 problem · Alt+F5/Shift+Alt+F5 change · Ctrl+L ask · Ctrl+K edit with AI · Alt+\\ autocomplete · F5 run |
| chat | Shift+Tab cycle agent mode |

### Proof after (static + mutation)
`shortcuts.contract.test.ts` (3). **Mutation:** removing `'ctrl+,'` from `GLOBAL_CHORDS`
made the listing↔handler case FAIL (1 failed) → restored → pass.

---

## 7. Invariant 6 — What's New is true

### Before
`TitleBar.tsx` rendered a hard-coded `<ul>` of five generic claims, inline in the chrome.

### The fix
New `src/whatsNew.ts` holds the entries, each with a `source` pointing at the overhaul fix
doc that shipped the change (W2–W8, plus W9). `TitleBar.tsx` maps over it. The popover
still opens by mouse and keyboard and closes on Escape or outside-click (unchanged
handler). Entries are short, plain, and each names a feature that exists:

| Entry (abridged) | Source |
|---|---|
| Opening a past conversation no longer changes the workspace | fix-workspace-paths.md |
| A run says done only when edits applied; Stopped when stopped | fix-agent-engine.md |
| Each reply shows the model that answered and its cost | fix-ai-providers.md |
| Ask mode is read-only | fix-agent-engine.md |
| Copy/retry a reply; rename or delete a conversation | fix-chat-panel.md |
| Install/uninstall a skill; add and test MCP servers | fix-skills-mcp.md |
| Source Control/Run/terminal share one engine; no orphans | fix-editor-workbench.md |
| Settings grouped; keys masked; export/import preferences | fix-settings-misc.md |

### Proof after (static)
`whatsNew.test.ts` (3): entries exist and are short; every `source` is a `fix-*.md` that
EXISTS in `docs/overhaul`; no entry claims a split editor (which W8 recorded as absent).

---

## 8. Invariant 7 — notifications are consistent

W9 inventoried every in-app notice. There is **no central toast system**; notices are
rendered per-component with ARIA roles. The inventory (role already correct unless noted):

| Notice | File | Role | Dismiss |
|---|---|---|---|
| Editor notice bar | `components/EditorArea.tsx:223` | `alert` | explicit X (`dismissNotice`) |
| Editor conflict | `EditorArea.tsx:519,535` | `alert` | action buttons |
| Editor load failure | `editor/CodeEditor.tsx:757` | `alert` | — (persistent state) |
| Terminal shell failed | `panels/ide/ShellTerminal.tsx:217` | `alert` | "Try again" |
| Terminal toast | `ShellTerminal.tsx:225` | `status` | auto (pure info) |
| Terminal output error | `panels/ide/Terminal.tsx` | `alert` | inline |
| Connect/provider errors | `ConnectWizard.tsx:622`, `LocalModels.tsx:218`, `PrivacySettings.tsx:130` | `alert` | inline |
| Run error | `panels/ide/RunPanel.tsx:133` | `alert` | state |
| Search replace done / error | `SearchPanel.tsx:471/502` | `status`/`alert` | state |
| Chat blocker | `AgentChat.tsx` | `status` | state |
| Settings import error / preview / applied (new) | `SettingsDialog.tsx` AboutPane | `alert` / `status` / `status` | clears on edit |

Finding: the roles are already consistent across the app (errors `alert`, info `status`),
so the correct engineering call (owner rule 1) was to match that convention in the new
W9 surfaces rather than rebuild a system. The new settings-import notices use `alert` for
the error and `status` for the preview/applied lines; the Copy-as-Markdown failure path
reuses the shared editor-notice channel (`SET_EDITOR_NOTICE`, role `alert`, dismissible).
No duplicate stacking was introduced. Visual style uses W3 tokens (§11).

---

## 9. Invariant 8 — import and export exist and are real

An exhaustive search confirmed the lead's lead: the only prior import/export was
`UserMcpServers`' "Import JSON". W9 built two small, real features on the same pattern
(clipboard + validated paste; no new native permission; no dependency).

### 9a. Export a conversation as Markdown
`src/conversationMarkdown.ts` + a "Copy as Markdown" button in
`panels/agent/ConversationSidebar.tsx` (clipboard icon, alongside rename/delete). It
copies a transcript — title, per-message role+time, fenced code preserved (fence widened
to avoid collisions), and a compact files-changed note. It only READS the conversation; it
never changes selection, the root (W2's `open()`), or the title (W6's rename/delete). A
clipboard failure reports via the shared editor notice.

Proof: `conversationMarkdown.test.ts` (4: title/messages/code block, files note, empty +
default-title fallback, fence widening); `ConversationSidebar.test.tsx` new case — copies
the transcript to the clipboard and leaves selection+title untouched.

### 9b. Settings export / import (About tab)
`src/settingsIo.ts`:
- **Export** copies a versioned, KEY-FREE JSON `{ kind:'sketch-settings', version:1,
  editor, agent }` (the five agent preference fields only — no keys, no provider, no MCP
  list).
- **Import** parses + validates against the schema, rejects a non-object, a wrong `kind`,
  a future `version`, and anything containing a key-shaped field, each with a specific
  error; normalises/clamps every value so an out-of-range number cannot break the app;
  shows exactly what will change (section · label · from → to); and applies only on a
  second explicit click (`IMPORT_SETTINGS` reducer). It never contains or accepts a key
  and never touches provider config.

Format example:
```json
{ "kind": "sketch-settings", "version": 1,
  "editor": { "fontSize": 13, "tabSize": 2, "colorTheme": "dark", ... },
  "agent":  { "mode": "agent", "autoApply": true, "maxIterations": 30, "maxUsd": 2, "verifyChanges": true } }
```

Proof: `settingsIo.test.ts` (9); `state/settingsPersistence.test.ts` IMPORT_SETTINGS
cases (applies values, keeps the user's MCP list, clamps out-of-range, no key leaks);
`SettingsDialog.test.tsx` (rejects non-settings paste with a specific error; shows the
preview before applying).

---

## 10. Invariant 9 — layout, states and tokens

### Width + overflow (dev preview, headless Edge, keyless provider, isolated home)
`packages/desktop/scripts/w9-settings-shots.mjs` opened Settings and, for each of
1920×1080, 1600×900, 1366×768, 1280×720, 1024×640 and 900×600 (the app's min) × all six
tabs (36 combos), recorded `document.scrollWidth` vs `clientWidth`, the dialog width, and
whether the content pane overflows horizontally. The first-run Connect modal did not cover
the dialog (`connect-modal-over-dialog: false`).

- The dialog width now ADAPTS: 1080 at ≥1152-wide windows, 952 at 1024, 828 at 900 — so
  the 1920 "large empty gutter" is gone and it still fits at 900×600 with the content pane
  scrolling inside (`.content { overflow-y: auto }`). Was `min(920px, 100vw-48px)` (a
  fixed 920 centred).
- **No document overflow at any of the 36 combos.** One content x-overflow was found
  (Shortcuts tab at 900×600) and FIXED: the shortcut grid's fixed `minmax(260px, 1fr)`
  track could not shrink below 260 in the narrow content pane, so a long row pushed past
  the edge. Changed to `minmax(min(100%, 240px), 1fr)` with `min-width: 0` on the row and
  `overflow-wrap: anywhere` on the label and kbd, the canonical fix for a grid track
  exceeding its container. Data: `picture/overhaul/w9/after-settings-overflow.json`;
  screenshots `after-settings-{tab}-{WxH}.png` (one capture under memory pressure was
  best-effort and recorded as such). **Limitation:** the post-fix dev-preview re-run was
  not completed because the host dropped to CRITICAL memory (≈1.3 GB) and a dev
  server + browser would risk OOM and disturb the owner's other work; the fix is a
  standard CSS-grid shrink fix, the `vite build` confirms the CSS compiles, and the
  overflow it addresses was measured on the unfixed build. §12.

### States
Every W9 surface carries its states: the settings import box has default, error
(`role=alert`), preview (`role=status`), applied (`role=status`) and disabled (Review
disabled when empty, Apply disabled when nothing changes); the Copy button shows a
transient "Copied"; the dialog nav shows an active tab; About shows engine
ready/starting/not-running.

### Tokens (invariant 9 + design system)
`SettingsDialog.module.css` was converted to W3 tokens. **Before:** ~40 colour hex
literals + 1 rgba. **After:** 5 hex + 1 rgb, all intentional —
`.always` status-green pill (`#86efac`/`#14532d`), the theme-fixed switch knob
(`#f5f5f5`, documented `theme: fixed`), and two `var(--token, #fallback)` fallbacks
(`--error`/`--success`), plus the backdrop's `rgba(0,0,0,.55)` scrim. Added `:focus-visible`
rings. The new import-box classes use tokens only. Brace balance 66/66; `vite build`
compiled the CSS (§11).

---

## 11. Tests, typecheck, build, mutation checks (every command + result)

Each typecheck/test ran in a **later step** than the edits it checks. Vitest 2.1.9 here
rejects `--maxWorkers=1`, so serial runs used
`--pool=forks --poolOptions.forks.singleFork=true`, `NODE_OPTIONS=--max-old-space-size=1536`.

```
# desktop jsdom + static (packages/desktop)
npx vitest run src/shortcuts.contract.test.ts src/settingsIo.test.ts \
  src/conversationMarkdown.test.ts src/whatsNew.test.ts \
  src/state/settingsPersistence.test.ts src/components/settings/SettingsDialog.test.tsx \
  src/panels/agent/ConversationSidebar.test.tsx src/components/TitleBar.test.tsx \
  src/components/settings/PrivacySettings.test.tsx \
  --pool=forks --poolOptions.forks.singleFork=true
→ Test Files 9 passed (9);  Tests 58 passed (58)
   (shortcuts.contract 3, settingsIo 9, conversationMarkdown 4, whatsNew 3,
    settingsPersistence 8, SettingsDialog 10, ConversationSidebar 12, TitleBar 5,
    PrivacySettings 4)

# typecheck
cd packages/desktop && npx tsc --noEmit        → exit 0, no errors

# build (canonical CSS-compile gate)
NODE_OPTIONS=--max-old-space-size=1536 npm run build -w @sketch/desktop
→ ✓ built in 19.56s (exit 0); the tokenised CSS compiles.
   (the monaco chunk-size warning is pre-existing, unrelated to W9.)

# dev-preview overflow (headless Edge, isolated home, keyless provider)
node packages/desktop/scripts/w9-settings-shots.mjs
→ connect-modal-over-dialog: false; 36 size/tab combos measured;
   dialog width 1080/952/828 by size; no document overflow anywhere;
   one content x-overflow (Shortcuts @ 900x600) found → fixed in CSS (§10).
```

Mutation checks (non-vacuity), each reverted after:
- **Shortcut contract**: removed `'ctrl+,'` from `GLOBAL_CHORDS` → listing↔handler case
  FAILED (1 failed) → restored → pass.
- **Key rejection**: disabled the importer's key-shape guard → "refuses a blob carrying a
  key-shaped field" FAILED (1 failed) → restored → pass.
- **Reset confirmation**: forced `useResetSection` to apply without asking → "asks for
  confirmation" case FAILED (1 failed) → restored → pass.

---

## 12. Files modified / added

| File | Change | In W9's list? |
|---|---|---|
| `packages/desktop/src/components/settings/SettingsDialog.tsx` | B-009 tab split; focus trap+return; reset-confirm; new AboutPane with settings export/import; renders shared SHORTCUTS | yes |
| `packages/desktop/src/components/settings/SettingsDialog.module.css` | tokenised (~40→5 hex); import-box classes; shortcut-grid shrink fix; adaptive dialog width; focus rings | yes |
| `packages/desktop/src/state/AppState.tsx` | `SettingsTab` += `'shortcuts'`; `IMPORT_SETTINGS` action + reducer case (bounded) | yes (settings persistence/import) |
| `packages/desktop/src/components/TitleBar.tsx` | What's New sourced from `whatsNew.ts`; Help "Keyboard Shortcuts" → `'shortcuts'` | yes (What's New; call-site repoint is lead-approved) |
| `packages/desktop/src/panels/agent/ConversationSidebar.tsx` | "Copy as Markdown" menu item only (open/rename/delete untouched) | yes |
| `packages/desktop/src/shortcuts.ts` | **New.** The one shortcut table + global-chord mirror + contract helpers | yes (new module) |
| `packages/desktop/src/whatsNew.ts` | **New.** What's New entries with their source doc | yes (new data module) |
| `packages/desktop/src/settingsIo.ts` | **New.** Settings export/import (key-free, validated, diffed) | yes (new module) |
| `packages/desktop/src/conversationMarkdown.ts` | **New.** Conversation → Markdown transcript | yes (new module) |
| `packages/desktop/src/shortcuts.contract.test.ts` | **New.** Shortcut listing↔handler contract | yes (tests) |
| `packages/desktop/src/settingsIo.test.ts` | **New.** | yes |
| `packages/desktop/src/conversationMarkdown.test.ts` | **New.** | yes |
| `packages/desktop/src/whatsNew.test.ts` | **New.** | yes |
| `packages/desktop/src/state/settingsPersistence.test.ts` | **New.** persistence/reset/import/no-key-leak | yes |
| `packages/desktop/src/components/settings/SettingsDialog.test.tsx` | **New.** B-009 grouping, labels, reset, import flow, Escape | yes |
| `packages/desktop/src/panels/agent/ConversationSidebar.test.tsx` | Added the Copy-as-Markdown case | yes (tests) |
| `packages/desktop/scripts/w9-settings-shots.mjs` | **New.** dev-preview overflow driver (6 sizes × 6 tabs) | yes (script) |
| `packages/desktop/src/components/CommandPalette.tsx` | 1 line: "Keyboard Shortcuts" → `'shortcuts'` | **lead-approved** (§1) |
| `packages/desktop/src/panels/agent/AgentChat.tsx` | 1 line: safety link → `'privacy'` | **lead-approved** (§1) |

**Dependencies added: none.** **Mock data introduced: none.** **Security checks
weakened: none** (keys stay masked; the importer refuses key-shaped blobs; no reset
touches keys/providers).

---

## 13. Remaining limitations

- **Post-fix dev-preview re-run for the Shortcuts/900×600 overflow was not completed** —
  the host dropped to CRITICAL memory (≈1.3 GB) and running a dev server + headless Edge
  would risk OOM and disturb the owner's other work. The overflow was MEASURED on the
  unfixed build, the fix is a standard CSS-grid shrink fix (`minmax(min(100%, 240px),
  1fr)` + `min-width: 0` + `overflow-wrap`), and `vite build` confirms the CSS compiles.
  The other 35 combos (and the pre-fix Shortcuts/900×600) were measured with zero document
  overflow.
- **Real packaged-app (UIA/CDP) walkthrough not run**: WebView2 156 on this host opens no
  CDP listener (recorded across W2/W8), so Settings was verified in the dev preview + jsdom
  rather than the packaged QA app. The behaviour layers (persistence, reducer, import) are
  proven in jsdom against the real reducer.
- **One screenshot capture** under memory pressure was best-effort (recorded `shot:false`
  in the JSON); its overflow measurement was still captured.
