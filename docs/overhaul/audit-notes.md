# W1 Audit — running notes

Scratchpad so a context compaction loses nothing. Facts only, with file:line anchors.

## Repo shape
- npm workspaces: `packages/core` (@sketch/core, Node/TS engine), `packages/desktop` (Tauri 2 + React 19 + Vite + Monaco + xterm; Rust in `src-tauri`).
- Root version 0.1.0. Node >=20.

## core/src module dirs (purpose TBD per module)
assist, bench, capabilities, context, cost, diff, evals, events, extensions, local, loop, mcp, memory, orchestrator, plan, privacy, providers, registry, rpc, secrets, settings, skills, strategy, tools, verify, workspace. Entry: index.ts, cli.ts, types.ts.

## desktop/src dirs
components (+ ide/, settings/), editor, explorer, git, ipc, lib, panels (+ agent/, ide/), review, run, settings, state, styles, team, terminal, test, testing, ui/panels. Entry App.tsx, main.tsx.

## src-tauri/src
command_policy.rs, main.rs, os_credentials.rs, secret_store.rs, secrets_check.rs, terminal_ipc.rs

## Path containment (command_policy.rs) — WELL DESIGNED
- All #[tauri::command] path access goes through command_policy (NOT tauri fs.scope, which only covers plugin-fs).
- `resolve_root` canonicalizes project_root, must exist + be dir.
- `resolve_within` single containment primitive; canonicalize() resolves symlinks before prefix test.
- `resolve_write_target` walks to nearest existing ancestor for new files; refuses `..`, broken symlinks.
- `resolve_pathspec_within` for git; refuses args starting with `-` (git --output= write primitive).
- ALLOWED_PROGRAMS = git, npm, node, cargo, python. No shell. Explicit confirmation gate.
- Containment is authoritative in Rust; `paths.ts` canonicalPath/isWithinRoot is advisory only (editor model-map keying).

## TODO
- Read AppState.tsx (projectRoot), fileIo.ts, main.rs (bridge commands list), rpc/methods.ts + server.ts, loop/agent.ts, providers, ModelSelector, SkillsMarketplace, McpTools.
- Reproduce unicef-india path bug in scratch layout.
- Launch app over CDP (check memory: WebView2 155 may not start DevTools server — fallback to vite dev at 127.0.0.1:1420).

## IMPORTANT: grep_search/file_search are scoped to the crew workspace, NOT the sketch repo (C:\Users\saran\Downloads\sketch is outside workspace). Use shell Select-String for repo content search.

## Tauri command surface (main.rs) — the ENTIRE native bridge
Registered in generate_handler: read_dir, read_file, write_file, open_project_dialog, git_status, git_diff, run_command, allowed_programs, list_providers, set_api_key, resolve_api_key, remove_api_key, terminal_ipc::{terminal_profiles, terminal_open, terminal_write, terminal_resize, terminal_close}.
- read_dir skips dotfiles, node_modules, target, dist (main.rs:~95). FsEntry serde rename_all camelCase (was a shipped bug: is_dir→isDir).
- git_status parser in Rust is a SIMPLE porcelain parser; authoritative parser is packages/core/src/tools/git.ts (Git panel reads via SketchClient, not this command). Two git parsers = documented duplication/two-sources concern.
- Plugins: shell, fs, dialog, window_state. On RunEvent::Exit closes all terminal shells.

## Engine run root resolution — KEY for unicef-india bug
- rpc/methods.ts `run` (line 890): `root = resolve(optionalString(params,'root') ?? ctx.cwd())`. If UI omits root, engine falls back to ENGINE PROCESS cwd.
- Many other methods same pattern (lines 1359,1415,1461,1524,1586,1668,1792,3098,3160,3208,3313,3398). Some require root (readString) at 2537,2638,2703,...
- AgentSession.tsx startRun DOES pass `root: snapshot.projectRoot` when set. So CHAT runs use projectRoot. Chat path is NOT the obvious cause.
- Editor file read/write go through Tauri read_file/write_file with projectRoot (command_policy contains). command_policy is authoritative + sound.
- HYPOTHESIS for unicef-india: divergence likely between (a) UI projectRoot (AppState, set by open_project_dialog / restoreTabs), (b) engine run root (passed from projectRoot OR ctx.cwd fallback when some non-chat call omits root), (c) a file opened by absolute path that lies in a DIFFERENT root than the opened folder. `index.mjs` suggests a node entry file — maybe Run panel / run scripts using a nested dir, or a chat file-link opening an absolute path outside projectRoot → command_policy refuses with "outside project root" → that's the "different workspace boundary" message. NEED to reproduce.

## Agent modes (AgentSession modeRunOptions)
- ask: readOnly:true, no command tool, reviewEdits:false. Engine refuses edits.
- agent: commands:'ask' (approve each), reviewEdits = !autoApply, verifyPolicy if autoApply+verifyChanges.
- auto: commands:'auto', autonomous:true, reviewEdits:false, maxIterations>=50, verifyPolicy if verifyChanges. Auto-continue up to 2x on max_iterations.

## Model selection trace (partial)
- startRun: picks snapshot.providers.find(id==selectedProvider); if selectedModel != provider.model, overrides model for this run: `{...selected, model: snapshot.selectedModel}`. Passed as `provider` in run options. NEED to trace into client.run → RPC → provider request body to confirm UI model == request model.

## One-message→model-calls
- One send => one client.run => one runId. BUT auto mode auto-continues up to 2 extra runs on max_iterations (new runId each). Within a run, the loop makes multiple model calls (iterations). So "multiple model calls per message" is BY DESIGN in agent loop; need to confirm token accounting (receipt.modelCalls) matches provider usage.

## TODO next
- Read lib/client.ts (run options → RPC params), providers/wire.ts + base.ts (request body model + usage), ModelSelector.tsx.
- Read loop/agent.ts (iterations, completion honesty — can it report done when edits failed?).
- Read SkillsMarketplace.tsx, McpTools.tsx, settings SettingsDialog.
- Launch app (CDP or vite dev) for UI audit + reproduce unicef-india.

## CONFIRMED: Model shown == model requested (good)
- openaiCompatible.ts:75 `body.model = this.config.model`; this.config.model = config.model (:62) from RunOptions.provider.model.
- startRun overrides provider.model with snapshot.selectedModel when the picker chose a different model of same provider. So UI ModelSelector value flows to request body. GOOD — the UI model IS the request model.

## CONFIRMED: Token counts == provider-returned (good)
- openaiCompatible.ts:135-136 usage = {in: data.usage.prompt_tokens??0, out: data.usage.completion_tokens??0}. Parsed from provider response, not estimated. fake.ts estimates ~len/4 (offline only).

## CONFIRMED: one message -> one run, but multiple MODEL CALLS per run by design
- One send -> one client.run -> one runId. Auto mode may auto-continue up to 2 more runs (new runId) on max_iterations (AgentSession AUTO_CONTINUE_LIMIT=2).
- Within a run, loop/agent.ts iterates (plan, edit, verify, done...) each an adapter.chat() call. So "multiple model calls per user message" is BY DESIGN (agentic loop). receipt.modelCalls counts them. NOT a bug per se; audit should explain it so "unexpected multiple model calls" is understood.

## Completion honesty — loop/agent.ts (IMPORTANT finding, candidate bug)
- finish() latches run_completed (ok) vs run_failed (:570). 
- `done` action (:1099): if !verifyRan && hasVerification -> runVerify(); then `ok = verifyOk()`; finish(ok, text, reason: ok?'done':'verify_failed').
- verifyOk() (:597): hasPolicy -> policy.ok; else task.verify.length===0 -> TRUE; else all lastVerify ok.
- EDIT FAILURE PATH (:949-984): a prepared edit that fails applyPreparedEdit emits edit_rejected but DOES NOT set a failure flag. The loop continues; model can send 'done'.
- => If NO verify commands/policy configured (verifyChanges off, or project has no checks), a run where EVERY edit was refused still reports ok:true "Done." That is a completion-honesty gap: "done" is gated on verification, NOT on edits-applied. When verifyPolicy/verify present, a failing build would catch it; when absent, it won't.
- UI side: AgentSession records files from changedFiles(events) -> only edit_accepted produce entries, so filesState 'applied' reflects accepted edits only. Rejected edits don't show as applied (good), but the agent bubble still says result.finalText ("Done.") with ok=true. Need to state this precisely in BUG_AUDIT as "agent can report done while its edits were refused, when no verification is configured."
- Default desktop prefs: verifyChanges:true, autoApply:true (agent mode) => verifyPolicy on IF project has checks. If project has NO checks, verifyOk()=true regardless.

## Skills/MCP shapes (client.ts)
- SkillsCatalogResult.distribution: 'curated' until open marketplace ships (Req 11.6) => marketplace is DISABLED/curated-only in this build. SkillsMarketplace panel reads skills-catalog. Install/uninstall via engine RPC (installSkill etc. in registry/index.ts).
- McpCatalogResult: configured (NOT connected) — servers start per-run. UserMcpServers via mcp userServers. Need to test a stdio server connect+list+run in running app.

## TODO
- Launch app, reproduce unicef-india, UI audit 5 sizes, Skills page, exercise skill install/uninstall/activate + MCP stdio. Check console errors / leftover processes.

## APP LAUNCH — METHOD THAT WORKS (record for QA doc)
- Real exe CDP driving FAILS on this host: WebView2 runtime 156, Tauri exe does NOT honor WEBVIEW2_USER_DATA_FOLDER/WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env (webview used AppData\Local\dev.sketch.desktop\EBWebView, no remote-debugging port listening). exe starts & runs but no CDP target.
- WORKING method: Vite dev preview (node vite.js) at 127.0.0.1:1420 with isolated USERPROFILE/HOME + SKETCH_FAKE_PROVIDER=1, driven by headless Edge (msedge --headless=new --remote-debugging-port=9422 --remote-allow-origins=*) over CDP. Screenshots via Page.captureScreenshot. cdp.mjs driver in scratch.
- Dev bridge reaches ENGINE (in-process) but NOT filesystem native commands (read_file/write_file/run_command/git throw "not running under Tauri"). So file/git/terminal workflows audited at engine+command_policy source level, UI/chat/engine audited live.
- Owner's OWN installed app running at AppData\Local\Sketch\sketch-desktop.exe (pid 21768, started 14:25) — DO NOT TOUCH.
- Build tested: release exe 2026-11-01 12:15:42 newer than newest src 11:25:01 => exe == current source. Dev preview = same src.

## LIVE: Initial load (1920x1080), fresh home
- No console errors on load. Title "Sketch". App shell: TitleBar (Cowork|Code toggle, What's new, Settings, min/max/close custom window controls), left ActivityBar (New task, Projects, Runs, Timeline, Agent Console, Skills, Recents), composer with Ask/Agent/Auto mode toggle, task suggestions, Explorer side panel ("No folder opened / Open Folder"), SidePanel icons (Explorer, Search, Source Control, Diff Review, Live Architecture, Timeline, Agent Console, Run, Test Results).
- Connect-a-model wizard AUTO-OPENS on first run (no provider). Screenshot 00-initial-1920.png. Grid: ChatGPT (NO API KEY), OpenRouter (FREE MODELS), API-key providers (OpenAI, Anthropic, Gemini, Groq, Grok, Kimi, DeepSeek, Mistral, Cerebras, NVIDIA NIM, GitHub Models), local (Ollama, llama.cpp, LM Studio), advanced (Azure, Cloudflare Workers AI, Custom OpenAI-compatible). Clean, well-grouped. P3: top title bar area looks very empty/dark at 1920 wide; window control glyphs faint.

## LIVE: Settings dialog (SettingsDialog.tsx) — 1920
- Left nav: Models, Agent, Editor, Privacy, "Shortcuts & privacy". Engine: ready · v0.1.0 bottom-left.
- Models tab: "On this computer" card (REAL hardware: 16GB/2GB free, 20 CPU, RTX 3060 6GB), Ollama-not-installed state + Get Ollama link + Refresh. Providers list: ChatGPT sign-in, OpenAI/Anthropic/Gemini/... each "Not configured" + Add. "No provider configured" empty state. Screenshot 03-settings-1920.png.
- Agent tab: "Apply edits automatically" toggle, "Check changes with the project's own tests" toggle. Clear copy. 04-settings-agent.png.
- Editor tab: Color theme (Dark/Light/Match system), Font size, Indentation (2/3/4/8, Spaces/Tabs), Auto save. 05-settings-editor.png.
- Privacy tab: Offline Mode toggle + Network activity (Refresh) + data storage. Good, honest copy.
- "Shortcuts & privacy" tab: content HEADER is "Privacy & safety" (no-account/keys-in-OS-store/agent-scoped/.sketch log statements). 06-settings-shortcuts.png.
- UI FINDING (P2): nav label "Shortcuts & privacy" but tab content header is "Privacy & safety" and shows privacy statements, not keyboard shortcuts. Mismatch + "Privacy" appears in TWO tab names. Where keyboard shortcuts are actually listed is unclear (there IS a Command Palette Ctrl+Shift+P per code). Owning area: settings/onboarding.
- UI FINDING (P3): Settings modal fixed width with large empty right gutter at 1920. Responsive check needed at narrow sizes.

## BUG CANDIDATE (dev-only, but note): TitleBar window controls throw in dev
- Clicking a title-bar window control (Minimize/Maximize/Close) in the DEV preview throws: "Failed to close: TypeError: Cannot read properties of undefined (reading 'metadata') at getCurrentWindow (@tauri-apps/api/window) at windowCall (TitleBar.tsx:237)". Expected in dev (no Tauri runtime). In the real app these call the Tauri window API. Not a product bug per se, but TitleBar.tsx:237 windowCall does not guard IS_TAURI before calling getCurrentWindow => in dev it logs an unhandled error to console. Minor: a guard would keep the dev console clean. Owning area: design system + app shell / stability.

## DOM: both surfaces mounted at once (AppLayout CSS-shows one)
- Cowork composer + Code surface composer + file tree toolbar (New file/New folder/Refresh/Collapse all) + terminal (PROBLEMS/TERMINAL tabs, New terminal, Clear scrollback) all present in DOM simultaneously. Confirms AgentSession one-session-for-both design.

## ENGINE RPC FUNCTIONAL TESTS (node rpc.mjs -> dist/cli.js, SKETCH_FAKE_PROVIDER=1, root = scratch "unicef india")
- ping: ok, engine @sketch/core 0.1.0, protocol 1, fakeProvider:true.
- skills-catalog (before): 7 curated skills (commit-context, context-packing, finance-quant, frontend-design, research-stage, scope-discipline, web-data), all installed:false. registry "sketch-curated", distribution "curated". Curated registry MATERIALIZED to ~/.sketch/registry/curated-f5b5e0c2f2e8cdd4.
- skill-install scope-discipline: ok:true, digest verified sha256:ebea..., granted [fs:read:project, git:read], wrote .sketch/skills/scope-discipline, files:1, reason:null, warnings:[]. Emitted event tool_called/skill-install. => INSTALL WORKS E2E.
- skills-catalog (after): scope-discipline installed:true, appears in installed[] with SKILL.md source path + capabilities. => ACTIVATE/visibility WORKS (installed skills loaded by loader).
- mcp-catalog: 15 curated servers, 7 configured (filesystem, terminal, git, docker, playwright, browser, android), 8 need env (github, ssh, postgres, supabase, cloudflare, notion, slack, figma). Each has launch argv (pinned versions, no @latest), requiresEnv/missingEnv, security caveat. note: "started per run... nothing connected between runs". => MCP CATALOG WORKS.

## BUG CANDIDATE: no skill-uninstall RPC method
- METHODS map has skills-catalog, skill-install, skill-train, skill-promote. NO 'skill-uninstall'. Uninstall must be done by the UI deleting .sketch/skills/<name> (likely via fs-delete). MUST verify SkillsMarketplace.tsx uninstall path: does it call fs-delete on the skill dir? If there's an Uninstall button with no working handler => dead button. TO CHECK in SkillsMarketplace.tsx.

## MCP live connect test — decision
- mcp-server-test would spawn npx/uvx to fetch a real server (network + minutes + memory). Host memory TIGHT (~2.6GB), no network guarantee. Will attempt ONE lightweight stdio connect (git server via uvx or filesystem via npx) only if time+memory allow; else mark MCP live-connect UNTESTED (catalog + per-run-start design verified at source), with reason.

## UNICEF-INDIA PATH BUG — traced (not reproduced live in-app: dev bridge has no FS; real exe no CDP)
Layers of "root":
- UI projectRoot: AppState, canonicalPath'd. Set by: open_project_dialog (useFileActions.openFolder -> openFolderPath -> SET_PROJECT_ROOT), FolderPathDialog (dev path via sketch:open-folder-path event), CloneDialog, EditorArea workspace click, AgentChat workspace click, and CRUCIALLY ConversationSidebar.open (:42) which SILENTLY switches projectRoot to a conversation's stored c.root when it differs.
- SET_PROJECT_ROOT reducer (AppState.tsx:967): on switch, CLOSES all openFiles, clears files/activeFile/diagnostics, resets terminal cwds. Adds root to workspaces.
- Engine run root: AgentSession passes root=projectRoot (good). methods.ts run falls back to ctx.cwd() only if root omitted (UI never omits it).
- Rust command_policy.resolve_within: canonicalizes candidate, requires it inside resolve_root(projectRoot); else returns "<label> '<candidate>' is outside the open project root <root>" (command_policy.rs outside()).

MECHANISM (matches the reported symptom exactly): the opened folder (project root) is NARROWER than the file being accessed. Two concrete triggers:
  (a) A conversation stored root = "...\unicef india\web-app" (a nested project). Opening that conversation silently sets projectRoot to the nested dir (ConversationSidebar.tsx:42). The user then opens/edits "...\unicef india\index.mjs" (the PARENT folder's entry file) via editor, agent edit, or a chat file-link. index.mjs is ABOVE the active root => command_policy refuses: "file '...\unicef india\index.mjs' is outside the open project root ...\unicef india\web-app". The UI surfaces the attempted file path AND the (narrower) boundary => "tries to open index.mjs while reporting a different workspace boundary".
  (b) Agent run rooted at nested dir proposes an edit to the parent's index.mjs => edit_rejected outside-root.

ROOT CAUSE (file:line): workspace model is single-root; projectRoot can be silently switched to a NESTED project by ConversationSidebar.tsx:42 (no warning/confirm), and command_policy.rs resolve_within/outside() (authoritatively, correctly) refuses any access above that root. The path CODE is correct; the WORKSPACE MODEL + silent root switch is the defect. Also contributing: read_dir/paths use canonicalPath; no divergence there.
Confidence: HIGH on mechanism; "root cause fully traced in source, not reproduced in a running app (environment: dev bridge lacks FS, real exe lacks CDP on this host)".
Owning area: workspace/paths. Fix direction (for fix item, NOT me): treat the opened folder as a workspace that can contain nested projects, OR warn/confirm on silent root switch, OR when a refused path is a parent/sibling of root offer "open that folder instead". DO NOT weaken command_policy.

## projectRoot management is otherwise SOUND
- Switching root closes buffers to avoid tabs the FS layer must refuse (AppState.tsx comment). canonicalPath everywhere. Containment never bypassed in UI (paths.ts isWithinRoot is advisory; Rust authoritative).
