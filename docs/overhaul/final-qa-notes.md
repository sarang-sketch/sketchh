# W11 — Final QA running notes

Scratchpad so a context compaction loses nothing. Facts only, with file:line anchors and
command results. Repo root: `C:\Users\saran\Downloads\sketch`.

## My item (work_brief)
- it_13a5a8b6. Title: W11 Final QA: rebuild + boot the QA app, real-app UIA pass, full
  suites, consolidated walkthrough; write FIXES_IMPLEMENTED, FINAL_QA_REPORT and audit status
  updates.
- Acceptance: the FILE `docs/FINAL_QA_REPORT.md` exists, written LAST, fully evidenced.

## Inputs read (all 9 fix docs + 3 audit docs + audit-notes) — DONE
Key load-bearing claims per item (to re-verify statically in step 1):
- W2 (workspace/paths): `command_policy.rs` `display_root()` strips `\\?\`; `outside()` plain
  multi-line message; `editor/paths.ts` `conversationRootRelation()`; ConversationSidebar
  `open()` never moves workspace root; AgentSession runRoot = conv root if inside else
  workspace. Added qa.conf.json + qa-window-shot.ps1 + qa-drive.mjs.
- W3 (design system): `styles/global.css` full token set + teal aliases; `styles/components.css`
  new; `ipc/bridge.ts` `isTauri()`; `TitleBar.tsx` B-008 guard at windowCall. Deferred QA boot.
- W5 (agent engine): `loop/agent.ts` appliedPaths/failedEdits, `ok = verifyOk() && editsOk`,
  edits_failed/edits_partial reasons; `capabilities/vocabulary.ts` READ_ONLY_CAPABILITIES +
  readOnlyGrant; `rpc/methods.ts` run() narrows Ask grant + openToolLayerFor readOnly flag.
  Scripts: w5-e2e-rpc.mjs (A-E).
- W7 (skills/mcp): `registry/grants.ts` uninstallSkill; `rpc/methods.ts` skill-uninstall in
  METHODS; client seam skillUninstall; SkillsMarketplace uninstall + responsive grid.
  Scripts: w7-e2e-rpc.mjs (S1-S3). Deferred QA boot.
- W4 (ai providers): `types.ts` chat() returns model? + attempts?; adapters read data.model;
  `loop/agent.ts` responseModel/usageKnown/usageEstimated/attempts; `cost/ledger.ts` priced by
  answered model + usageUnknown; `cost/usage-log.ts` new (cost-usage RPC); connectionTest 403
  forbidden / 429 rate-limited. Scripts: w4-recording-server.mjs, w4-e2e-rpc.mjs (S1-S4),
  w4-ui-proof.mjs.
- W6 (chat panel): Markdown XSS test; AgentSession retry/promptBehind/stoppedRuns/wasStopped;
  AgentChat MessageActions (Copy/Retry) + neutral Stopped chip; AppState RENAME_CONVERSATION;
  ConversationSidebar rename + destructive delete. Script: w6-chat-shots.mjs.
- W8 (editor workbench): B-010 removed main.rs git_status/git_diff + GitStatus struct +
  handler entries; bridge.ts removed gitStatus/gitDiff wrappers; new ipc/policyMessages.ts;
  fileIo.ts/commandLine.ts use policy predicates. Script: w8-code-shots.mjs. Deferred QA boot +
  UIA.
- W9 (settings): SettingsDialog TABS six tabs (B-009); new shortcuts.ts, whatsNew.ts,
  settingsIo.ts, conversationMarkdown.ts; AppState SettingsTab += 'shortcuts' + IMPORT_SETTINGS;
  Shortcuts grid shrink fix at 900x600 (post-fix re-run NOT completed — I must re-measure).
  Script: w9-settings-shots.mjs.
- W10 (stability): new ErrorBoundary.tsx + installGlobalErrorReporter in main.tsx; cli.ts
  process.on unhandledRejection/uncaughtException + SKETCH_TEST_UNHANDLED; backupCorruptConfig;
  FileExplorer CLEAR_PROJECT_ROOT vanished-root. Full suites: core 85 files / 1411 tests (main
  83/1386 + 3 network files 27), desktop 99 files / 932 tests. (Doc §1.1 says final core 1413;
  §1 body says 85/1411 — note the slight internal discrepancy; I will record my own counts.)

## Lead facts (given, re-check if cheap)
- HEAD dc44ef8, nothing committed, no stash. Worktree has owner's earlier dirty files.
- Deps: root+core package.json match HEAD; desktop has @xterm/xterm 6.0.0, @xterm/addon-fit
  0.11.0, postcss 8.5.23 that HEAD lacks, but package-lock.json last written 2026-10-23 (pre
  overhaul) => from earlier work, every item reports adding none.
- Owner's installed Sketch C:\Users\saran\AppData\Local\Sketch is the 12:15 build, no fixes.
  Never touch it or target/release/bundle.

## Progress log
- 18:57 UTC start. resource_status CRITICAL (1.5 GB). Read all inputs (light). Deferring heavy
  steps. Beginning step 1: static re-verification of load-bearing claims.

## STEP 1 — static re-verification of load-bearing claims (DONE, light)
All verified against current source via Select-String (repo is outside crew workspace):
- W2: command_policy.rs `fn display_root` @146, `fn outside` @229 with "This {label} is
  outside the folder you have open in Sketch" @231; paths.ts `conversationRootRelation` @149. OK.
- W5: vocabulary.ts READ_ONLY_CAPABILITIES @133 + readOnlyGrant @144/147/148; agent.ts
  editsOk @571/574/577, done verdict @1189-1211 with edits_failed/edits_partial. OK.
- W7: grants.ts `export function uninstallSkill` @47 + isSafeSkillName; methods.ts
  skill-uninstall handler + 'skill-uninstall': skillUninstall @4112 in METHODS; name
  'skill-uninstall' @3464. OK.
- W4: types.ts chat() return `Promise<{ text; usage?; model?; attempts? }>` @93 (model? @76 on
  ChatAdapter? no — on return); cost/usage-log.ts EXISTS; 'cost-usage': costUsage @4127 in
  METHODS. OK.
- W6: AppState.tsx RENAME_CONVERSATION @652/@1353; AgentSession.tsx wasStopped/stoppedRuns/
  promptBehind/retry @100-234. OK.
- W8/B-010: main.rs has NO `fn git_status`/`fn git_diff`/`struct GitStatus` (all removed);
  generate_handler! lists 15 commands (read_dir, read_file, write_file, open_project_dialog,
  run_command, allowed_programs, list_providers, set_api_key, resolve_api_key, remove_api_key,
  terminal_ipc::{profiles,open,write,resize,close}). NOTHING in packages/desktop/src invokes
  git_status/git_diff (the 5 string matches are all comments + tests asserting removal).
  ipc/policyMessages.ts EXISTS. **Registered Tauri command count = 15 (was 17).** OK.
- W9: shortcuts.ts, whatsNew.ts, settingsIo.ts, conversationMarkdown.ts all EXIST. OK.
- W10: ErrorBoundary.tsx EXISTS; cli.ts process.on('unhandledRejection') @30 + ('uncaughtException')
  @33 + SKETCH_TEST_UNHANDLED gate @40; AppState CLEAR_PROJECT_ROOT @583/@1073. OK.

CONCLUSION step 1: every load-bearing claim is backed by current source. No static discrepancy.
New RPC methods confirmed: skill-uninstall, cost-usage. Registered native commands: 15 (two
git commands removed by B-010).

## STEP 2 — e2e proofs against a fresh engine build (DONE)
Memory went TIGHT (2.0 GB) after a 5-min wait; ran at that level (as W3/W4/W7 did).
- `npm run build -w @sketch/core` (NODE_OPTIONS=--max-old-space-size=1536) → EXIT 0 (tsc -p
  tsconfig.build.json). Fresh dist/cli.js with ALL overhaul changes.
- `node packages/core/scripts/w5-e2e-rpc.mjs` → "W5 E2E: ALL PASS" (EXIT 0). A edits_failed,
  B approval deny, C Ask read-only edit refused, D cancel+process-tree-gone+restart, E Ask
  cannot reach write MCP tool (tool_denied, granted=[]).
- `node packages/core/scripts/w7-e2e-rpc.mjs` → "W7 E2E: ALL PASS" (EXIT 0). S1 lifecycle
  incl uninstall (dir+grant gone, skill-uninstall event, run no longer loads, idempotent,
  traversing name refused), S2 tamper refused w/ hash, S3 MCP live connect+list+call+broken.
- `node packages/core/scripts/w4-e2e-rpc.mjs` → "W4 E2E: ALL PASS" (EXIT 0). S1 three-number
  3=3=3 + answered/requested model + ledger priced by answered, S2 401/403/429(+Retry-After)/
  500 mapped, S3 inline-edit one wire call, S4 retry counted server=6/events=3/attempts=2.
All three still print ALL PASS after later items' changes landed. No regression.

## STEP 3 — both full suites serially (DONE) — matches W10
All with NODE_OPTIONS=--max-old-space-size=1536, --pool=forks --poolOptions.forks.singleFork=true.
- core `npx tsc --noEmit` → EXIT 0. desktop `npx tsc --noEmit` → EXIT 0.
- core MAIN batch (exclude no-egress/local-models/phase4-gate):
  `npx vitest run --pool=forks --poolOptions.forks.singleFork=true --exclude '**/no-egress.test.ts'
   --exclude '**/local-models.test.ts' --exclude '**/phase4-gate.test.ts'`
   → Test Files 83 passed (83); Tests 1386 passed (1386). Duration 75s.
- core NETWORK files own invocation:
  `npx vitest run test/no-egress.test.ts test/local-models.test.ts test/phase4-gate.test.ts ...`
   → Test Files 3 passed (3); Tests 27 passed (27).
  => core TOTAL 86 files / 1413 tests, all pass. MATCHES W10 §1.1 (core 1413).
- desktop single-fork full run:
  `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
   → Test Files 99 passed (99); Tests 932 passed (932). Duration 64s. MATCHES W10 (99/932).
- vite build: `npm run build -w @sketch/desktop` → "✓ built in 18.99s" EXIT 0. Only the
  pre-existing monaco >500kB chunk-size warning (emitted to stderr; PowerShell renders it as a
  NativeCommandError banner but it is the known warning, not a failure).
No regression vs W10's recorded counts. Both suites fully green on the current (all-items) code.

## STEP 4 — rebuild the QA app and BOOT it (DONE — this was deferred by W3/W7/W8/W10)
Memory TIGHT 2.8-2.9 GB during the build window. GNU toolchain present
(stable-x86_64-pc-windows-gnu), rustup default is msvc; built with RUSTUP_TOOLCHAIN override.
- `build:sidecar` (SKETCH_TARGET_TRIPLE=x86_64-pc-windows-gnu) → EXIT 0; wrote
  resources\sketch-engine.mjs (808 KiB) + binaries\sketch-engine-x86_64-pc-windows-gnu.exe (87 MiB).
- vite dist was fresh from step 3 (same build); not rebuilt.
- `npx tauri build --debug --no-bundle --config src-tauri/qa.conf.json`
  (CARGO_BUILD_JOBS=2, RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu) → EXIT 0,
  "Built application at ...target\debug\sketch-desktop.exe", finished dev profile in 1m53s.
  Two warnings, both expected/documented: `resolve_pathspec_within is never used` (its only
  caller git_diff was removed by B-010) and the benign GNU `.rsrc merge failure: multiple
  non-default manifests`. target\release\bundle NOT touched (--no-bundle, debug).
- Identifier check: exe contains ASCII "dev.sketch.desktop.qa" and "Sketch QA" (both encodings);
  NO bare production identifier. QA-isolated build confirmed. exe LastWrite 2026-11-02 00:45.
- `npm run smoke:boot -w @sketch/desktop -- --exe <abs path> --seconds 20` → PASS, still
  running after 20s, no panic. (First try failed only because -w doubled the relative path;
  absolute path fixed it.) The smoke script gives a fresh throwaway HOME/USERPROFILE AND a
  fresh WEBVIEW2_USER_DATA_FOLDER under it, and stops by PID with taskkill /T /F.
- Window capture: qa-window-shot.ps1 (PrintWindow PW_RENDERFULLCONTENT, window-only, isolated
  home, SKETCH_FAKE_PROVIDER=1, stops by PID) → wrote
  picture/overhaul/w11/01-qa-app-firstrun.png (1294x808, PrintWindow ok=True). Visual: the real
  running app's first-run "Connect a model" wizard over the Cowork shell, dark theme + orange
  accent, provider grid (ChatGPT/OpenRouter/OpenAI/Anthropic/Gemini/Groq/...), left nav, titlebar
  Cowork|Code pills. Confirms the packaged build with ALL overhaul changes boots and paints.

CONCLUSION step 4: the built QA app with every overhaul change (incl B-010's removed Rust
commands and the compiled Tauri config) BOOTS CLEAN and paints its UI. No plugins.* unknown-field
panic. This closes the deferred boot check.
