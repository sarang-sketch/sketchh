# W7 — Skills + MCP, end to end: fix

Item W7 of the Sketch IDE overhaul. The skill lifecycle working end to end through the
real engine RPC and the real Skills page — discover, validate, install, activate, and a
new **uninstall** (B-002) — the Skills page layout holding at every window size with a
folder open (the owner's reported overlapping install buttons), live local stdio **MCP**
connect / list / call and server management (B-007's untested part), the W3 design system
adopted by the three panels, and every UI state present. This document is the whole record
for the fix.

Repo root: `C:\Users\saran\Downloads\sketch`. All anchors are `file:line` at that root.
Inputs read first (as leads, not facts): `docs/BUG_AUDIT.md` B-002/B-007,
`docs/UI_UX_AUDIT.md` (Skills page), `docs/ARCHITECTURE_REVIEW.md` §5(d)/§5(e),
`docs/overhaul/fix-design-system.md` (W3 tokens + `sk-*` classes),
`docs/overhaul/fix-agent-engine.md` §4 (Ask mode's read-only tool layer, which W7 must not
break), `docs/overhaul/fix-workspace-paths.md` (the dev-preview CDP method / QA recipe).

---

## 1. What the owner asked, as it applies to W7

Skills and MCP should be real, not placeholders: a user can find a skill in the curated
registry, see what it is allowed to do before installing it, install it (with the content
hash verified), have a run actually use it, and **remove it again** — and can add their own
MCP server, approve it, test that it connects and lists its tools, and have a run call one.
The Skills page must stay laid out at every window size with a folder open (the owner saw
install buttons overlapping), the three panels must use one design language, and every
state (loading, empty, error, success, disabled, offline) must be present with no dead
button. W7 owns `packages/core/src/{skills,registry,mcp}`, the `skill-*`/`mcp-*` RPC
handlers, and the `SkillsMarketplace` / `McpTools` / `UserMcpServers` panels + their client
seam. It does not touch the shell, the chat panel, provider adapters, or settings.

---

## 2. Invariant 1 — the skill lifecycle works end to end

### 2.1 What was already correct (verified against the shipped build, not assumed)

W1 confirmed, and W7 re-confirmed over the real RPC against the built `dist/cli.js`, that
**discover, validate, install and activate already worked**:

- **Discover.** `skills-catalog` (`rpc/methods.ts` `skillsCatalog`, ~`:3130`) lists the
  curated registry read from the pinned manifest, and reports `installed` from the project's
  `.sketch/skills` **off disk**, so a skill removed by hand shows as removed. The panel
  (`SkillsMarketplace.tsx`) filters that same set by name/summary/pack.
- **Validate.** `installSkill` (`registry/install.ts`) re-hashes the skill directory against
  the pinned digest *before a byte is written* and refuses on any difference, naming the
  differing file; there is deliberately no `force`.
- **Install.** On a match it writes `.sketch/skills/<name>/…` and a persisted capability
  grant under `.sketch/skills/.grants/<name>.json` (`registry/grants.ts`
  `writeInstalledSkillGrant`), and emits a `tool_called`/`skill-install` event.
- **Activate.** A run loads an installed skill; the agent loop emits `skill_loaded`
  (`loop/agent.ts:705`) for each skill named on the task.
- **Permissions shown in plain words** before install (the confirm dialog) and on the card
  (`<Capabilities>` in `SkillsMarketplace.tsx`), with sensitive grants (`fs:*:home`,
  `proc:spawn`, `secrets:read`) called out; the "open marketplace is not enabled in this
  build" message is shown for a curated registry.

### 2.2 The gap: uninstall did not exist anywhere (B-002)

**Before (evidence).** The engine method table had `skills-catalog`, `skill-install`,
`skill-train`, `skill-promote` and **no `skill-uninstall`** (`rpc/methods.ts` `METHODS`); the
installed-skill card rendered only "Train on my project" and had no remove control
(`SkillsMarketplace.tsx` installed card). A user could install a skill but could not remove
it from within Sketch.

**Root cause (file:line).** Uninstall was unimplemented — no engine function, no RPC method,
no client-seam method, no UI control.

**The fix.**

- **`packages/core/src/registry/grants.ts`** — new `uninstallSkill(projectRoot, name)` and
  its `UninstallSkillResult`. It removes **both** `.sketch/skills/<name>` and the persisted
  grant `.sketch/skills/.grants/<name>.json`. **Confinement is the security property:** the
  only inputs are the project root and a skill *name*; the name is refused by
  `isSafeSkillName` (rejects `..`, `.`, a name with a slash/backslash, or surrounding
  whitespace) **before any path is built**, and the two removed paths are then recomputed
  from `installedSkillsDir(projectRoot)` and each re-checked to resolve to a descendant of
  that directory (belt and suspenders, so a future change to name-safety cannot widen the
  reach). There is no path parameter and no `force`. It is **idempotent** — `rm(..., {force:
  true})` returns quietly when nothing is there — and the result is honest: `removedDir` /
  `removedGrant` are each true only when that thing existed and is now gone, so a second
  call reads as "already gone", not "removed". Exported from `registry/index.js`.
- **`packages/core/src/rpc/methods.ts`** — new `skillUninstall` handler and the
  `'skill-uninstall'` entry in `METHODS`. It emits a `tool_called`/`skill-uninstall` event
  (with `removedDir`/`removedGrant`) only when something was actually removed. No other
  handler was touched; `run`/`cancel`/`reply`/`openToolLayerFor`'s read-only logic are
  unchanged.
- **Client seam** — `skillUninstall?` on `SketchClient` (`lib/client.ts`, with
  `SkillUninstallResult`), implemented on `stdioClient.ts` and `httpClient.ts` (dispatch
  `skill-uninstall`) and stubbed as `noEngine` on `mockClient.ts`, mirroring `skillInstall`.
- **`packages/desktop/src/panels/SkillsMarketplace.tsx`** — an **Uninstall** button on every
  installed card (shown only when `client.skillUninstall` exists), behind a **destructive
  `ConfirmDialog`** (the existing `useConfirm()` API, danger button, keyboard-trapped) that
  names the skill, the `.sketch/skills/<name>` path, and the capability grant being
  withdrawn. The outcome (`UninstallOutcome`) reports honestly, distinguishing "Uninstalled …
  removed its files and its capability grant" from "was already not installed".

**Proof after.**

- Engine unit tests — `packages/core/test/registry.test.ts` `describe('uninstall (B-002)')`
  (4 cases): removes dir **and** grant and a run can no longer load it (the loader finds
  nothing); idempotent (second call `ok` with nothing removed); refuses a traversing/unsafe
  name (`../escape`, `nested/skill`, `nested\skill`, `.`, `..`, ` padded`, ``) before
  touching disk; leaves a sibling skill and its grant untouched. **`registry.test.ts`: 29
  tests pass** (was 25).
- **Mutation check (non-vacuity):** commenting out the grant removal
  (`// await rm(grantPath, { force: true })`) made two uninstall cases FAIL — "removed the
  grant" and the idempotency case. Restored → 29 pass.
- UI tests — `SkillsMarketplace.test.tsx` `describe('uninstall an installed skill (B-002)')`
  (4 cases, driving the **real** engine `METHODS` in process): the Uninstall control is on
  every installed card; a destructive confirmation is required and cancelling removes
  nothing (files still on disk); confirming removes the directory **and** the grant file and
  the Installed tab shows the empty state; no Uninstall control when the transport lacks the
  seam. **`SkillsMarketplace.test.tsx`: 22 tests pass** (was 18).
- **UI mutation check:** ungating the confirm (`if (false && answer !== 'uninstall') return`)
  made the "removes nothing when cancelled" case FAIL (the RPC was called despite Cancel).
  Restored → 22 pass.
- **End to end over the real RPC** — `packages/core/scripts/w7-e2e-rpc.mjs` **scenario S1**
  against the built `dist/cli.js`, fake provider, scratch project + scratch home:
  discover (curated list + name needle filters it), install (dir + grant written +
  `skill-install` event + catalog shows installed), activate (a run emits `skill_loaded`,
  evidence below), uninstall (dir + grant gone, `skill-uninstall` event, catalog back to
  `installed:false`, **a run no longer emits `skill_loaded`**, idempotent, traversing name
  refused). Activation evidence line:
  ```
  skill_loaded payload: {"name":"scope-discipline","source":"…\.sketch\skills\scope-discipline\SKILL.md"}
  ```

---

## 3. Invariant 1 (validate) — a tampered skill is refused with a clear message

**Before.** The installer already refuses a tamper; W7 proves it end to end with a *tampered
materialized copy in a scratch home*, as the item asked.

**Note on the embedded registry.** The curated registry under `~/.sketch/registry` is
**self-healing**: `materializeEmbeddedRegistry` (`registry/materialize.ts`) compares every
file byte-for-byte on each read and rewrites a hand-edited copy from the bundled bytes. So a
tamper to that copy cannot persist across calls (a robustness feature, not a weakness). To
exercise tamper-refusal with a materialized copy, `w7-e2e-rpc.mjs` **scenario S2** copies the
materialized registry to an independent scratch directory, flips one byte of a covered file,
and installs with an explicit `registryDir` — that copy is not self-healed.

**Proof after.** S2 passes: the install is **refused**, the refusal mentions the content
hash, and nothing is written. Evidence:
```
refusing to install "commit-context": content hash does not match the pinned manifest
(expected sha256:b66858aef508e7c479d8262ee01ac8f3c4ab3aa0a84f01ee15efcba4f29a2e34, computed sha256:…)
```
Also covered by `registry.test.ts` "refuses an install when one byte of one script changed,
and names that script" and the UI test "a tampered skill is refused … naming the file that
differs" (`SkillsMarketplace.test.tsx`).

---

## 4. Invariant 2 — the Skills page layout holds at every window size

**Before (the owner's report).** Install buttons overlapping. W1 found no overlap but only
checked **with no folder open**, so no cards were rendered. W7 reproduced first with a folder
open and cards present.

**Root cause (file:line).** `SkillsMarketplace.module.css`:
- the registry install button used `.actionButton { width: 100% }`, and the card header was
  `display:flex; justify-content:space-between`. A full-width button in a space-between row
  fights the title for the same horizontal space — the overlap shape the owner saw, which
  only appears once a card is rendered (folder open);
- the card list was a single vertical column (`.skillList { flex-direction: column }`) with
  no shrink control, so a long name/digest could push width.

**The fix (CSS + markup).**
- `.skillList` is now a **responsive grid**:
  `grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr))` — as many ~260px
  columns as fit, one on a narrow host panel; `minmax(0,1fr)` + `.skillCard { min-width: 0 }`
  lets a column shrink below its content so long text wraps/truncates **inside** the card
  instead of forcing a page scrollbar.
- A new `.actionButtonInline` variant (`width:auto; flex:0 0 auto; white-space:nowrap`) is
  used for the in-row **Install…** / Train / Uninstall buttons, so a button sizes to its
  label and never stretches across or overlaps the title. The card header gained `gap` and
  `.cardTitle { min-width:0; flex-wrap:wrap }`; `.name { overflow-wrap:anywhere }`;
  `.version` / `.installedTag` are `white-space:nowrap; flex:0 0 auto` so the version labels
  align and do not wrap mid-token.
- Long description/source text keeps its 2-line clamp but now carries a `title` attribute, so
  the **full text is still available** on hover (truncate-with-recourse).
- Footer actions on the installed card sit in a `.cardActions` flex-wrap row (Train +
  Uninstall), so neither overlaps nor overflows.

**Proof by measurement, not by eye.** `packages/desktop/scripts/w7-skills-shots.mjs` drives
the Skills page in the Vite dev preview over headless Edge CDP (the method in
`audit-notes.md` / `fix-workspace-paths.md` §6.4 — the packaged app cannot be driven over CDP
on this host), with an **isolated home**, `SKETCH_FAKE_PROVIDER=1`, a **seeded scratch
folder** (so the Registry lists the 7 curated skills) and **two pre-installed skills** (so the
Installed tab renders cards). For each of the six sizes and **both tabs** it measures the
bounding rects of the action button, the name label and the version/installed-tag and asserts
they do **not** intersect, and records `scrollWidth` vs `clientWidth` for the document and
each card. Saved to `picture/overhaul/w7/after-overlap.json`.

| Size | Registry cards | Installed cards | doc scrollW=clientW | card overflow-x | button/label/tag intersect |
|---|---|---|---|---|---|
| 1920×1080 | 7 | 2 | 1920=1920 | none | none |
| 1600×900  | 7 | 2 | 1600=1600 | none | none |
| 1366×768  | 7 | 2 | 1366=1366 | none | none |
| 1280×720  | 7 | 2 | 1280=1280 | none | none |
| 1024×640  | 7 | 2 | 1024=1024 | none | none |
| 900×600 (min) | 7 | 2 | 900=900 | none | none |

**At every size, on both tabs, with a folder open and cards rendered: no document overflow,
no per-card overflow, and no bounding-rect intersection between the button, the name and the
version/tag.** So the owner's overlap does **not** reproduce under the stress conditions it
was looked for — long names, the installed-tag + version + button on one row, narrow widths
down to the app's 900×600 minimum. 12 screenshots in `picture/overhaul/w7/`
(`after-{registry,installed}-{1920x1080,1600x900,1366x768,1280x720,1024x640,900x600}.png`).
(The first-run "Connect a model" onboarding modal auto-opens over the panel because the
isolated home has no provider; it is a `position:fixed` overlay and does not change the card
layout — the grid of install-buttoned cards is visible behind it, and the overflow/overlap
metrics are measured on the live document regardless.)

---

## 5. Invariant 3 — MCP works live (B-007's untested part)

**Before.** W1 verified the catalog (`mcp-catalog`: 15 curated servers, env detection) and
confirmed user-server management exists, but **a live stdio connect + list + call was never
tested**.

**What was already correct (verified).** The user-server engine
(`mcp/userServers.ts`, `mcp/client.ts`, `mcp/host.ts`) and the `mcp-server-*` RPC handlers
are complete: list, save, remove, **approve/trust** (a project server starts only after the
user approved that exact launch; global servers are trusted), and `mcp-server-test` (starts
the server once, lists its tools, stops it). The panel (`UserMcpServers.tsx`) adds, imports,
tests, approves, enables-in-chats and removes servers, with removal behind a `ConfirmDialog`.
Curated servers that need environment variables name the missing ones and never show a
secret value (`McpTools.tsx`). W5's Ask-mode constraint — `openToolLayerFor` does not
re-grant `proc:spawn` and does not start a user MCP server in a read-only run — was **not
touched** and still passes (`ask-readonly-tools.test.ts`, below).

**Proof live (no npx/uvx/network).** `w7-e2e-rpc.mjs` **scenario S3** writes a tiny local
stdio MCP server (one `echo` tool) to a scratch folder and registers it as a **global**
(trusted) server in an isolated-home `mcp.json`, then over the real RPC against `dist/cli.js`:
- lists it from the user's settings (trusted by default as a global server);
- **connects + lists + starts** via `mcp-server-test` — ok, and the `echo` tool is listed:
  ```
  tools: [{"name":"echo","description":"Echo back the text argument"}]
  ```
- a missing-command server reports a **specific** failure, not a crash:
  ```
  user-broken handshake failed: could not write to user-broken: write EPIPE
  ```
- **a real run calls the tool** (a local scripted OpenAI-compatible model issues one tool
  call), and the `echo` tool call is on the event log:
  ```
  tool_called payload: {"granted":["fs:read:project","git:read","proc:spawn"],
  "name":"user-echo.echo","requires":"proc:spawn","phase":"start","argKeys":["text"]}
  ```

Also covered by the existing engine suites: `user-mcp.test.ts` ("the connection test starts
the server, lists its tools, and stops it"; "a run … calls the user server tool and feeds its
answer back to the model") and `mcp.test.ts`. **Server config persists** across an engine
restart because it lives in `~/.sketch/mcp.json` / `<project>/.sketch/mcp.json` (read fresh
each run); **trust** is a hash in `~/.sketch/mcp-trust.json`, outside every repo; **removal**
asks for confirmation (the `ConfirmDialog` in `UserMcpServers.remove`).

---

## 6. Invariant 4 — the design system is adopted

`SkillsMarketplace`, `McpTools` and `UserMcpServers` now use W3's tokens and primitives for
colours, status, borders, radii, focus rings, and the destructive dialog (the existing
`ConfirmDialog`, which W3 notes is already token-driven and the reference for migrating
dialogs). Hard-coded colour literals converted to tokens (counted by
`[regex] '#[0-9a-fA-F]{3,8}'` + `'rgba?\('`; `color-mix(var(--token) …)` carries a token, not
a literal):

| File | before (hex + rgb) | after |
|---|---|---|
| `panels/SkillsMarketplace.module.css` | 2 (`#fff` in `.badge` and `.actionButton`) | 0 |
| `panels/McpTools.module.css` | 28 (24 hex + 4 rgb) | 0 |
| `panels/UserMcpServers.module.css` | 22 | 0 |

Status is still a **word as well as a colour** everywhere (configured / needs setup,
installed, approved / needs approval). The restyle changed no behaviour or markup semantics,
so the UI tests (which assert roles, aria state and visible text, not colour classes) still
pass — `McpTools.test.tsx` + `UserMcpServers.test.tsx`: 17 pass with no change.

---

## 7. Invariant 5 — every state is present, no dead button

- **SkillsMarketplace**: loading ("Reading the registry…"), empty (no folder / nothing
  installed / nothing matches a search / no registry configured), error (`role="alert"` with
  the engine's own refusal), success (install/uninstall/train outcomes), disabled (every
  action button disabled while `busy`), offline (training needs a provider; install/uninstall
  are local). No dead button — Uninstall and Train render only when their client seam exists,
  else nothing.
- **McpTools**: loading→catalog, empty ("No engine behind this transport"), error
  (`role="alert"`), success (per-server configured/needs-setup + missing-env), disabled n/a
  (read-only), offline — the curated note explains per-run start; a server that needs env
  says which and never shows a secret value.
- **UserMcpServers**: empty ("No servers yet."), error (`role="alert"` per server + global),
  success (Test → "Connected: N tools — …"), disabled ("Use in chats" disabled until a server
  is usable; Test disabled while running), the **offline** note ("Offline Mode starts none of
  them"), and destructive confirmations for Remove and for Approve.

---

## 8. Tests, typecheck, build — every command + result

Each typecheck/test ran in a **later step** than the edits it checks. Vitest `--maxWorkers=1`
throws on 2.1.9 here, so serial execution used `--pool=forks --poolOptions.forks.singleFork=true`.
Desktop tests import `@sketch/core` from its built `dist`, so `npm run build -w @sketch/core`
ran before them.

```
# Engine typecheck
cd packages/core && npx tsc --noEmit                         → exit 0

# Engine registry tests (incl. the 4 new uninstall cases)
npx vitest run test/registry.test.ts --pool=forks --poolOptions.forks.singleFork=true
   → Test Files 1 passed; Tests 29 passed (was 25)

# Mutation check — uninstall grant removal disabled
npx vitest run test/registry.test.ts -t "uninstall" …        → 2 FAILED (grant + idempotency); restored → pass

# Engine build (so the e2e + desktop tests see skill-uninstall)
npm run build -w @sketch/core                                → exit 0 (tsc -p tsconfig.build.json)

# Engine regression sweep across every touched area
npx vitest run test/registry.test.ts test/registry.seed.test.ts test/registry.embedded.test.ts \
  test/skills.test.ts test/mcp.test.ts test/user-mcp.test.ts test/capabilities.test.ts \
  test/ask-readonly-tools.test.ts --pool=forks --poolOptions.forks.singleFork=true
   → Test Files 8 passed; Tests 131 passed   (incl. W5's Ask-mode invariant-2 test — not broken)

# End to end over the real JSON-line RPC against dist/cli.js
node packages/core/scripts/w7-e2e-rpc.mjs                    → "W7 E2E: ALL PASS" (S1 lifecycle, S2 tamper, S3 MCP live)

# Desktop typecheck
cd packages/desktop && npx tsc --noEmit                      → exit 0

# Desktop panel tests (Skills incl. 4 new uninstall cases, MCP, UserMcp)
npx vitest run src/panels/SkillsMarketplace.test.tsx src/panels/McpTools.test.tsx \
  src/panels/UserMcpServers.test.tsx --pool=forks --poolOptions.forks.singleFork=true
   → Test Files 3 passed; Tests 39 passed (SkillsMarketplace 22 was 18, McpTools 13, UserMcpServers 4)

# UI mutation check — uninstall confirm ungated
npx vitest run src/panels/SkillsMarketplace.test.tsx -t "removes nothing when cancelled" …
   → 1 FAILED (RPC called despite Cancel); restored → pass

# Skills-page screenshots + overlap measurement, 6 sizes × 2 tabs, folder open
node packages/desktop/scripts/w7-skills-shots.mjs            → exit 0, "No element overlaps at any size on either tab."
   → 12 PNGs + after-overlap.json in picture/overhaul/w7/
```

---

## 9. Files modified / added

| File | Change | In W7's list? |
|---|---|---|
| `packages/core/src/registry/grants.ts` | `uninstallSkill()` + `UninstallSkillResult` (confined, traversal-refusing, idempotent, honest); `stat`/`sep` imports. | yes (`registry/**`) |
| `packages/core/src/registry/index.ts` | Export `uninstallSkill` + `UninstallSkillResult`. | yes |
| `packages/core/src/rpc/methods.ts` | `skillUninstall` handler + `'skill-uninstall'` in `METHODS`; `uninstallSkill` import. Nothing else touched. | yes (skill-* handler only) |
| `packages/core/test/registry.test.ts` | `describe('uninstall (B-002)')` (4 cases) + `uninstallSkill`/`loadSkills` imports. | yes (tests) |
| `packages/core/scripts/w7-e2e-rpc.mjs` | **New.** End-to-end driver over the real RPC: S1 lifecycle, S2 tamper, S3 MCP live. Tracked path, not under `dist/`/`build/`. | yes (a script) |
| `packages/desktop/src/lib/client.ts` | `skillUninstall?` on `SketchClient` + `SkillUninstallResult`. | yes (wiring only) |
| `packages/desktop/src/lib/stdioClient.ts` | `skillUninstall` dispatches `skill-uninstall`; import. | yes |
| `packages/desktop/src/lib/httpClient.ts` | `skillUninstall` dispatches `skill-uninstall`; import. | yes |
| `packages/desktop/src/lib/mockClient.ts` | `skillUninstall` → `noEngine`. | yes |
| `packages/desktop/src/panels/SkillsMarketplace.tsx` | Uninstall button + `ConfirmDialog` + `UninstallOutcome`; responsive-grid markup; inline buttons; `title` on long text. | yes |
| `packages/desktop/src/panels/SkillsMarketplace.module.css` | Responsive grid; `.actionButtonInline`/`.cardActions`/`.dangerButton`; `#fff`→tokens; wrap/nowrap/min-width fixes. | yes |
| `packages/desktop/src/panels/SkillsMarketplace.test.tsx` | `describe('uninstall … (B-002)')` (4 cases); `skillUninstall` on the engine test client; `ConfirmProvider` wrap. | yes (tests) |
| `packages/desktop/src/panels/McpTools.module.css` | All colours → W3 tokens (28 literals → 0). | yes |
| `packages/desktop/src/panels/UserMcpServers.module.css` | All colours → W3 tokens (22 literals → 0); focus/disabled states. | yes |
| `packages/desktop/scripts/w7-skills-shots.mjs` | **New.** Dev-preview CDP screenshot + per-element overlap-measurement driver (6 sizes × 2 tabs, folder open). | yes (a script) |

**Dependencies added: none** (expected). **Mock data introduced: none** (every row is real:
the engine's own catalog, install result, tool list). **Security checks weakened: none** —
the tamper refusal, the capability grant, the MCP trust gate and W5's Ask-mode read-only tool
layer are all intact. No tracked file outside the W7 list was changed; the pre-existing dirty
files in the worktree were left as they were; nothing was committed, pushed, stashed, reset,
or reverted.

---

## 10. Owner-safety confirmation

- Every launch (engine RPC, the dev preview, headless Edge) used a throwaway `%TEMP%`
  home/`USERPROFILE` and a scratch project root, never the owner's real `~/.sketch` or
  installed app. `SKETCH_FAKE_PROVIDER=1` or a local 127.0.0.1 scripted model was used; no
  provider key was requested, read, saved, changed or removed. No npx/uvx/network server —
  the MCP server is a local stdio script in a scratch folder.
- The dev server and every headless Edge process were stopped by the PIDs the driver
  launched (`taskkill /T /F /PID`), matched by their scratch `--user-data-dir`; no
  `sketch-desktop.exe`, `sketch-engine.exe`, `msedgewebview2.exe`, or any process this item
  did not start was touched. A single timed-out run left dev/Edge children behind once; they
  were found by their scratch-folder command lines and killed by PID, and a final check
  confirmed zero remaining.

---

## 11. Remaining limitations

- **The packaged app was not rebuilt or driven for this item.** On this host WebView2 156
  opens no CDP listener (diagnosed in `fix-workspace-paths.md` §6.4), so the Skills page is
  verified in the Vite dev preview — the same React source and the same in-process engine.
  W7 changed only engine TS, panel TS/CSS and the client seam; it did not alter any Tauri
  config, so it cannot affect app boot. A QA-identifier build + `qa-window-shot.ps1` +
  `smoke:boot` (the recipe in `fix-workspace-paths.md` §6) would be the packaged-app check if
  a drivable host is available; it was deferred as the item's verification notes allow.
- **The overlap measurement is from the dev preview**, with the first-run onboarding modal
  open over the panel. The per-element bounding-rect and overflow metrics are measured on the
  live document and are correct regardless of the overlay; the modal itself is onboarding, not
  a Skills defect.
- **MCP live was proven with a local stdio server**, not a real third-party server over
  npx/uvx (no network guarantee, and the host's memory is tight). The connect/list/call path
  and the error path are the same code either way; the curated catalog's packages are fetched
  by the user's own package manager on first run, which this project does not vendor.
