# Seed template for overhaul work items (team lead's working note)

Every worker seed is built from three parts, in this order:

1. The owner's ask, verbatim: everything below the line in `docs/overhaul/OWNER_BRIEF.md`, wrapped in
   `<<<OWNER_ASK` ... `OWNER_ASK>>>`.
2. The item: its name, its inputs (audit docs and earlier `docs/overhaul/fix-*.md` notes), the definition
   of done (one file that the worker writes last), the invariants that make the work correct, the leads to verify,
   the files it may change, and what its fix doc must contain.
3. The common rules and the reporting block below, copied unchanged.

## Common rules (every item on this team follows them)

- Repo: C:\Users\saran\Downloads\sketch. npm workspaces: packages/core is the @sketch/core engine (Node/TS);
  packages/desktop is Tauri 2 + React 19 + Vite + Monaco + xterm, with Rust in packages/desktop/src-tauri.
- The worktree holds many modified, uncommitted files from earlier sessions. They are the owner's work. Never
  commit, push, stash, reset, checkout, clean or revert anything, and leave untouched every file outside your list.
- Edit files only with the built-in file tools. Use the shell only for builds, tests and read-only inspection.
- Memory: this Windows host is usually tight on RAM (often under 2.5 GB free). Before every heavy step (vitest,
  tsc, vite build, cargo, launching the app, a dev server or a browser), call resource_status (load
  kirocrew-core::resource_status with tool_load). On CRITICAL, wait a few minutes (kirocrew-core::wait) and
  re-check. Run one heavy process at a time. Stop every app, server, engine and browser you started before you
  report done.
- Isolation: give every launch a fresh USERPROFILE/HOME under %TEMP%, never the owner's real ~/.sketch. Never
  launch a build that carries the production identifier dev.sketch.desktop (it shares the owner's WebView2
  profile and app data); use the QA-identifier build from docs/overhaul/fix-workspace-paths.md section 6. Never
  stop, change or reconfigure the owner's installed app (C:\Users\saran\AppData\Local\Sketch) or its data.
  Never save, change or remove an API key through any build: Windows Credential Manager is shared across
  USERPROFILEs.
- Processes: stop only what you launched, by the PID you got at launch (taskkill /T /F /PID <pid>). Never stop
  processes by name (Stop-Process -Name, taskkill /IM) and never stop a sketch-desktop.exe, sketch-engine.exe,
  msedgewebview2.exe, node.exe or python.exe process you did not launch: the owner's own apps and other
  sessions' work run on this machine.
- Driving the app on this host: WebView2 156 here accepts --remote-debugging-port but opens no listener, so
  the packaged app cannot be driven over CDP. Drive the UI in the Vite dev preview over headless Edge CDP
  (method in docs/overhaul/audit-notes.md), capture the real QA window with
  packages/desktop/scripts/qa-window-shot.ps1, and boot-check with npm run smoke:boot against the QA exe.
- Vitest: --maxWorkers=1 throws on vitest 2.1.9 here; run targeted files serially with
  --pool=forks --poolOptions.forks.singleFork=true.
- No real provider API keys are available to you. Do not ask for any. Use the engine's fake provider
  (SKETCH_FAKE_PROVIDER=1), a local scripted/recording OpenAI-compatible server you start yourself on 127.0.0.1,
  or a local Ollama if one is already running.
- Verification honesty: run a typecheck or test only in a later step than the edits it checks, because parallel
  tool calls can run out of order. Desktop tests import @sketch/core from its built dist, so after changing engine
  code run npm run build -w @sketch/core before desktop tests. Prove each new test is not vacuous by breaking the
  code once, seeing it fail, then restoring it. Report only what you observed, and mark anything untested.
- Tauri 2 config under plugins.* rejects unknown fields; a scope key under plugins.shell or plugins.fs panics the
  app at startup, because scope belongs in capabilities. The config is compiled in, so only booting the built app
  proves it.
- UI tests assert behaviour and semantics (roles, aria state, visible text that matters), not colour classes or
  marketing copy, so a deliberate restyle does not read as a regression.
- If you change a message, error string, event field or wire shape that other code matches on, grep BOTH packages
  (including test doubles such as editor/fakeDisk.ts and test/engineHarness.ts) for the old text and update every
  consumer in the same item, then run every test file that references it. A targeted run of only your own tests
  will not see the break (W2's refusal-message rewrite silently broke fileIo.ts and terminal/commandLine.ts).
- Never add a dependency. Never put mock data in place of real behaviour. Never hide an error or weaken a
  security check.
- Docs: write only your own docs/overhaul/fix-<slug>.md. Do not edit docs/UI_UX_AUDIT.md, docs/BUG_AUDIT.md,
  docs/ARCHITECTURE_REVIEW.md, docs/FIXES_IMPLEMENTED.md or docs/FINAL_QA_REPORT.md; the final QA item owns them.
  Read every existing docs/overhaul/fix-*.md first and do not undo an earlier fix.

## How you report (kirocrew-work tools; load kirocrew-work::work_brief and kirocrew-work::work_report with tool_load if they are deferred)

1. Call work_brief first. Its title and acceptance are your definition of done.
2. Your first work_report is status=progress, and its summary restates in one or two sentences the owner's ask as
   it applies to your item, before you plan.
3. work_report status=progress at each milestone, kept short.
4. If a tool approval times out, report status=blocked with reason=approval at once. If only the owner can unblock
   you, status=blocked with reason=needs_human. If you need a decision from the lead (including touching a file
   outside your list), status=question.
5. status=done only after your fix doc is written as your final step. Put the fix doc, the screenshot folder and
   any script you added in artifacts.

You are a leaf: do not create sessions or spawn sub-agents (memory is tight).
