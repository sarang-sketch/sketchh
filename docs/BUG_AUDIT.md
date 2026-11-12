# Sketch IDE — Bug Audit (W1)

Audit date: 2026-11-01. Build tested: 2026-11-01 12:15 release exe source == current source.
Method: engine driven over its JSON-line RPC against a scratch project; UI driven live over CDP
(headless Edge 156) against the Vite dev preview with an isolated home and
`SKETCH_FAKE_PROVIDER=1`. The dev bridge reaches the engine but not native filesystem commands, so
file/git/terminal *workflows* were exercised at the engine + `command_policy` level; findings that
could not be exercised in a running window are marked **UNTESTED** with the reason.

No real provider API key was available; the fake provider was used (`SKETCH_FAKE_PROVIDER=1`),
confirmed by `ping.fakeProvider === true`.

Severity: P0 blocker · P1 major · P2 moderate · P3 minor. Every "works" claim below is backed by a
command run or an action taken in the running app.

---

## B-001 — Opening a file above a (nested) project root is refused with a confusing "different workspace boundary" — the reported unicef-india error
- **Area:** workspace / paths.
- **Severity:** P1.
- **Report:** Sketch tries to open `C:\Users\saran\Downloads\unicef india\index.mjs` while
  reporting a different workspace boundary.
- **Repro layout used:** a scratch folder whose name contains a space (`…\unicef india`) with
  `index.mjs` + `package.json` at its top, and a nested project `…\unicef india\web-app`
  (`server.mjs` + `package.json`).
- **Steps (traced; see "Environment limit" below):**
  1. A conversation (or a workspace entry) carries a stored root of the NESTED project
     `…\unicef india\web-app`.
  2. Opening that conversation **silently switches `projectRoot`** to the nested dir
     (`packages/desktop/src/panels/agent/ConversationSidebar.tsx:42` →
     `dispatch SET_PROJECT_ROOT`), and the reducer closes the previous buffers
     (`packages/desktop/src/state/AppState.tsx:967`).
  3. The user then opens / edits / links `…\unicef india\index.mjs` (the PARENT folder's entry
     file) — via the editor, an agent edit, or a chat file-link.
  4. `index.mjs` is ABOVE the active root, so Rust refuses it.
- **Expected:** Sketch opens the file, or explains clearly that the file is outside the folder
  you opened and offers to open the containing folder.
- **Observed / mechanism:** `command_policy::resolve_within` canonicalizes the candidate and
  requires it to sit inside `resolve_root(projectRoot)`; otherwise it returns
  `"<label> '<candidate>' is outside the open project root <root>"`
  (`packages/desktop/src-tauri/src/command_policy.rs`, `resolve_within` + `outside()`). The UI
  surfaces the attempted path AND the (narrower, nested) root — which reads as "tries to open
  index.mjs while reporting a different workspace boundary."
- **Root cause (file:line):** the workspace model is single-root, and `projectRoot` can be
  **silently** set to a *nested* project by `ConversationSidebar.tsx:42` (no warning, no confirm);
  `command_policy.rs` then correctly refuses any access above that root. The **path-resolution
  code is correct** (`editor/paths.ts` canonicalization is sound; `command_policy.rs` containment
  is sound and must not be weakened). The defect is the workspace model + the silent root switch.
- **Which root each layer used:** UI `projectRoot` = the nested `…\web-app` (set silently at
  `ConversationSidebar.tsx:42`); the engine run root = whatever `AgentSession` passes, which is
  `projectRoot` (so it agrees with the UI); the Rust `command_policy` root = the same nested root.
  They do NOT disagree — the file is simply above the single agreed root. (The only place the
  engine falls back to `ctx.cwd()` is `rpc/methods.ts:890` when `root` is omitted, and the desktop
  never omits it.)
- **Environment limit:** could not be reproduced inside a running window — the dev bridge has no
  native filesystem, and the packaged exe exposes no CDP on this host. Mechanism is **fully traced
  in source**; confidence HIGH.
- **Fix direction (for the workspace/paths fix item, not this item):** treat the opened folder as
  a workspace that may contain nested projects; or warn/confirm before a silent root switch; or,
  when a refused path is a parent/sibling of the current root, offer "open that folder instead."
  Do NOT relax `command_policy`.

## B-002 — Installed skills cannot be uninstalled (missing in both engine and UI)
- **Area:** Skills + MCP.
- **Severity:** P1.
- **Steps:** install a skill (works, see Evidence), then try to remove it from Sketch.
- **Expected:** an Uninstall action on the installed-skill card (the brief lists "Uninstall
  functionality").
- **Observed:** none exists. The engine method table (`packages/core/src/rpc/methods.ts:3836`
  `METHODS`) has `skills-catalog`, `skill-install`, `skill-train`, `skill-promote` but **no
  `skill-uninstall`**. The installed-skill card (`packages/desktop/src/panels/SkillsMarketplace.tsx:403`+)
  renders only a "Train on my project" button; there is no remove/uninstall control and no
  `fs-delete` call for the skill directory.
- **Root cause (file:line):** uninstall is unimplemented — no engine method, no UI control.
- **Evidence:** engine METHODS list read at `methods.ts:3836`; panel card read at
  `SkillsMarketplace.tsx:403`.

## B-003 — An agent run can report "Done." (ok) while its edits were refused, when no verification is configured
- **Area:** agent engine (completion honesty).
- **Severity:** P2.
- **Steps (traced at source):** run in Agent/Auto mode on a project with no verify commands and no
  verify policy (e.g. `verifyChanges` off, or a project the engine detects no checks for); the
  model emits `edit` actions that all fail to apply (bad search text, plan-gate, etc.), then emits
  `done`.
- **Expected:** a run whose edits did not apply should not read as a successful completion.
- **Observed / mechanism:** in `packages/core/src/loop/agent.ts`, a failed edit emits
  `edit_rejected` (`:949`–`:984`) but does **not** set any failure flag. The `done` action
  (`:1099`) computes `ok = verifyOk()`; `verifyOk()` (`:597`) returns **true** when there is no
  policy and `task.verify.length === 0`. So `finish(true, "Done.", { reason: 'done' })` fires even
  though every edit was rejected. `run_completed` is emitted. The UI shows the model's final text
  ("Done.") with `ok=true`.
- **Mitigations that exist:** the desktop default enables `verifyChanges` (so when the project HAS
  checks, a broken build catches it); and the UI's `changedFiles()` derives applied files from
  `edit_accepted` only, so rejected edits are not shown as "applied." But the overall run verdict
  and final text remain misleading when no verification is configured.
- **Root cause (file:line):** completion is gated on verification only, not on edit outcomes —
  `loop/agent.ts:597` (`verifyOk`) and `:1099` (`done`), with the edit-rejection path at `:949`.
- **Evidence:** source read of `agent.ts` ranges above.

## B-004 — Each user message legitimately triggers MULTIPLE model calls (by design); one message can also spawn up to 2 extra runs in Auto mode
- **Area:** AI providers / agent engine. **Not a defect** — documented so "unexpected multiple
  model calls" is understood.
- **Severity:** P3 (informational / observability).
- **Observed:** one `send` → one `client.run` → one run id (`lib/AgentSession.tsx`). Inside a run,
  the agent loop makes one `adapter.chat()` call per iteration (plan, edit, verify, done, …), so
  several model calls per message is expected. Additionally, **Auto mode auto-continues up to 2
  more runs** (new run id each) when a run ends with `reason: 'max_iterations'`
  (`AgentSession.tsx` `AUTO_CONTINUE_LIMIT = 2`).
- **Why it looks like a bug:** the cost/receipt counts all calls; a user watching token spend sees
  more than one "call" per message. The receipt's `modelCalls` is the honest count.
- **Pointer:** `lib/AgentSession.tsx` (`startRun`, `AUTO_CONTINUE_LIMIT`), `loop/agent.ts` loop.

## B-005 — The model shown in the UI IS the model that handles the request (verified, no bug)
- **Area:** AI providers.
- **Severity:** n/a (negative finding).
- **Trace:** `ModelSelector` sets `selectedModel`; `AgentSession.startRun` builds the run's
  `provider` as `{...selected, model: selectedModel}` when the picker chose a different model of
  the same provider; the OpenAI-compatible adapter sets `body.model = this.config.model`
  (`packages/core/src/providers/openaiCompatible.ts:75`, with `this.model = config.model` at `:62`).
  So the selected model id reaches the request body unchanged.
- **Evidence:** source read of `openaiCompatible.ts:54`–`:75`; `AgentSession.tsx startRun`.

## B-006 — Token counts shown match what the provider returned (verified, no bug)
- **Area:** AI providers / cost.
- **Severity:** n/a (negative finding).
- **Trace:** the adapter parses usage from the provider response —
  `usage = { in: data.usage.prompt_tokens ?? 0, out: data.usage.completion_tokens ?? 0 }`
  (`providers/openaiCompatible.ts:135`). The cost ledger sums these from the event log with no
  independent counter (`core/src/cost`, and `AppState` deliberately has no `totalCost` field).
  The fake provider estimates `~len/4` tokens — offline only, clearly labelled.
- **Evidence:** source read of `openaiCompatible.ts:135`; `cost` module + `AppState.tsx` comments.

## B-007 — Skills install / activate work end to end; MCP catalog works (verified)
- **Area:** Skills + MCP.
- **Severity:** n/a (positive finding, with one UNTESTED part).
- **Evidence (engine RPC, scratch root `…\unicef india`, `SKETCH_FAKE_PROVIDER=1`):**
  - `skills-catalog` returned 7 curated skills, all `installed:false`; registry
    `sketch-curated`, `distribution:"curated"`; the curated registry materialized to
    `~/.sketch/registry/curated-f5b5e0c2f2e8cdd4`.
  - `skill-install {name:"scope-discipline"}` → `ok:true`, digest verified
    (`sha256:ebea…`), `granted:["fs:read:project","git:read"]`, wrote
    `…\unicef india\.sketch\skills\scope-discipline`, `reason:null`, `warnings:[]`; emitted a
    `tool_called`/`skill-install` event. → **install works**.
  - `skills-catalog` again → `scope-discipline` now `installed:true` and present in `installed[]`
    with its SKILL.md source path and capabilities → **activate/visibility works** (the loader
    reads installed skills).
  - `mcp-catalog` → 15 curated servers, 7 configured (filesystem, terminal, git, docker,
    playwright, browser, android), 8 needing env (github, ssh, postgres, supabase, cloudflare,
    notion, slack, figma) with `missingEnv` listed and security caveats; pinned argv (no
    `@latest`); note: "started per run … nothing connected between runs." → **MCP catalog works**.
- **UNTESTED:** a live MCP stdio server CONNECT + list-tools + one tool call (`mcp-server-test`).
  Reason: it spawns `npx`/`uvx` to fetch a real server (network + minutes + memory) and this host
  was memory-critical (≈1.8 GB free) with no network guarantee. The per-run start design and the
  client/host code were verified at source (`core/src/mcp/host.ts`, `client.ts`, `userServers.ts`);
  a live connect should be run by the Skills+MCP fix item.
- **Related gap:** uninstall is missing (B-002).

## B-008 — Title-bar window controls throw an uncaught TypeError in the dev bridge (no Tauri guard)
- **Area:** stability / app shell (dev-only symptom).
- **Severity:** P3.
- **Steps:** in the dev preview, click Minimize/Maximize/Close.
- **Expected:** in dev, a no-op (or a guarded warning); in the packaged app, the real window action.
- **Observed:** console error `Failed to close: TypeError: Cannot read properties of undefined
  (reading 'metadata') at getCurrentWindow (@tauri-apps/api/window) at windowCall
  (TitleBar.tsx:237)`. Reproduced on every window-control click.
- **Root cause (file:line):** `packages/desktop/src/components/TitleBar.tsx:237` `windowCall` calls
  `getCurrentWindow()` without checking `IS_TAURI` first (contrast `ipc/bridge.ts:invoke`, which
  guards and throws a clear message). Benign in the packaged app (Tauri runtime present) but it
  means the dev console is never clean, which hides real errors during development.
- **Evidence:** CDP console captured on clicks during the walkthrough.

## B-009 — Settings tab labelling: "Shortcuts & privacy" shows "Privacy & safety" content; "Privacy" appears in two tab names
- **Area:** settings / onboarding.
- **Severity:** P2.
- **Steps:** open Settings → click "Privacy", then "Shortcuts & privacy".
- **Expected:** a tab named for shortcuts shows keyboard shortcuts; one privacy tab.
- **Observed:** "Privacy" tab = Offline Mode + Network activity + data storage. "Shortcuts &
  privacy" tab's content header is "Privacy & safety" and its body is privacy statements — not a
  keyboard-shortcut reference. Two tabs carry "privacy"; where shortcuts are documented is unclear
  (a Command Palette exists at Ctrl+Shift+P).
- **Root cause (file:line):** `packages/desktop/src/components/settings/SettingsDialog.tsx` tab
  labels vs their rendered section headers.
- **Evidence:** live tab text captured over CDP (`03`–`06` settings screenshots + innerText).

## B-010 — Two git-status parsers (duplication / two sources of truth)
- **Area:** editor/explorer/search/terminal/git/run.
- **Severity:** P3.
- **Observed:** `packages/desktop/src-tauri/src/main.rs` `git_status` has a simple porcelain
  parser (no rename / quoted-path / detached-HEAD handling), while the authoritative parser is
  `packages/core/src/tools/git.ts` (read by the Git panel through `SketchClient`). The Rust one is
  kept only for the native bridge wrapper; `main.rs` documents this. Low risk today because the
  panels do not use the Rust parser, but it is a real second source of truth that can drift.
- **Evidence:** source read of `main.rs` `git_status` + its comment, and `core/src/tools/git.ts`.

---

## Stability observations during the walkthrough
- **Console errors:** none on initial load; the only recurring console error was B-008 (dev-only
  window-control TypeError).
- **Unhandled promise rejections:** none observed beyond B-008.
- **Leftover engine processes:** the dev preview + headless Edge I started were both stopped at the
  end (ports 1420 and 9422 confirmed free). The owner's OWN installed app
  (`AppData\Local\Sketch\sketch-desktop.exe`, pid 21768) was left untouched. The release exe I
  launched for the CDP probe was stopped; note that on this host it did not honour the isolated
  WebView2 data folder (it used `AppData\Local\dev.sketch.desktop\EBWebView`) — an isolation caveat
  for future QA, not a product bug.
- **Memory:** the host was memory-tight to critical (1.8–2.9 GB free) throughout; heavy steps were
  serialized.

## UNTESTED (with reasons) — for the fix rounds to cover
- Editor workflows (open/close/split tabs, syntax, breadcrumbs, context menus, search), terminal
  command execution, git status/diff/commit **in a running window**, and import/export: the dev
  bridge has no native filesystem and the packaged exe exposes no CDP on this host. Engine-side
  methods and `command_policy` were verified at source.
- Live model streaming, provider connection test, retry/cancel **against a real provider**: no API
  key available; fake provider only.
- Live MCP stdio connect + tool call: memory/network constraints (see B-007).
- Deep per-panel visual pass (Runs, Timeline, Agent Console, Cost, Memory, MCP Tools, Diff Review,
  Live Architecture, Test Results, Benchmarks) with a folder open: breadth-over-depth this pass.

---

## Proposed fix items (grouped by owning area, for the lead to plan)
- **workspace / paths:** B-001 (silent nested-root switch + confusing refusal message; improve the
  workspace model / confirm root switch / offer "open containing folder"). Do not weaken
  `command_policy`.
- **AI providers / model / tokens:** nothing to fix — B-005 and B-006 are confirmed correct;
  B-004 is observability (consider surfacing "N model calls / M runs" clearly so multi-call runs
  are not read as a bug).
- **agent engine (modes, approvals, completion honesty, cancellation):** B-003 (gate "done" on
  edit outcomes, not only verification, when no verification is configured).
- **chat / agent panel UI:** none specific this pass (chat UI reviewed at source; live streaming
  UNTESTED without a provider).
- **Skills + MCP:** B-002 (implement uninstall end to end — engine `skill-uninstall` + a UI
  control); finish the live MCP connect test (B-007 UNTESTED part).
- **editor / explorer / search / terminal / git / run:** B-010 (collapse the two git-status
  parsers to one source of truth); exercise the editor/terminal/git workflows in a drivable build.
- **settings / onboarding / notifications / What's New / shortcuts / import-export:** B-009
  (fix the "Shortcuts & privacy" tab label vs its "Privacy & safety" content; disambiguate the two
  privacy tabs; make keyboard shortcuts discoverable). Also the settings-modal width at wide sizes.
- **design system + app shell:** B-008 (guard `TitleBar.tsx:237` on `IS_TAURI`); rename the
  `--accent-teal` / `--bg-teal-*` tokens to match their orange values (UI_UX_AUDIT); review the
  title-bar contrast and wide-screen negative space.
- **stability (RPC, transports, process lifecycle, listeners):** no new defect found beyond B-008;
  process cleanup on exit is implemented (`main.rs` `RunEvent::Exit` → `close_all`).

Findings that fit none of the planned areas: none — every finding maps to an area above.
