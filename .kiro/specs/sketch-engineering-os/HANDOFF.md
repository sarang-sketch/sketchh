# Session Handoff — Sketch

Written at the end of a session that hit context limits. Everything needed to resume is here.

## Where to start reading

1. This file.
2. `.kiro/specs/sketch-engineering-os/tasks.md` — the plan and current checkbox state.
3. `.kiro/specs/sketch-engineering-os/requirements.md` and `design.md` — 28 requirements, the resolved-conflicts table, and the canonical contracts.
4. `tasks-executed.md` at the repo root — the project's own living log (Rule 9 calls it the single source of truth for what is built). It was reconciled at the Phase 1 gate and carries 13 Phase 1 decision-log rows.

---

## IMMEDIATE NEXT ACTION

**Phase 3 is gated. Commit the working tree, then start task 4.1 (Provider Settings).**

Cold install (`node_modules` and `packages/core/dist` deleted, then `npm install && npm run build && npm test`):
typecheck 0, build 0, test 0 — **core 441 tests / 22 files, desktop 287 tests / 31 files**, offline,
no API key, and identical with `SKETCH_FAKE_PROVIDER=1` and unset.

The Phase 3 gate proof is `packages/desktop/src/phase3-gate.test.tsx` (one real chain: Explorer →
disk → Monaco/AppState → save → real core run → real `edit_proposed` patch → hunk accept → real bytes
→ real `git status`, plus both plan-gate assertions) and `packages/desktop/src/phase3-guards.test.ts`
(source-level tripwires for the invariants that span packages). Five guards were mutation-verified at
this gate: the engine plan gate, the UI mirror, the hunk applier's coordinate space, write-path event
sanitation, and the zero-dependency rule.

---

## Git state

```
e90861d  sketch: phase 3 task 3.2 part 2 - diff review surface with per-hunk accept and reject   <- HEAD
b676b68  sketch: phase 3 task 3.2 part 1 - unified diff parser and per-hunk subset applier in core
e3b560b  sketch: phase 3 task 3.4 - real Terminal, real Search, honest Debugger entry point
345c0ed  sketch: phase 3 task 3.4 WIP - real Explorer
aad0c8e  sketch: phase 3 task 3.3 - real git panel, core git tool, contained git commands
```

**The working tree is NOT clean.** Tasks 3.5 (ghost completions), 3.6 (UI plan-gate mirror) and 3.7
(this gate) are green but uncommitted — `ghostCompletion*.ts`, `phase3-gate.test.tsx` and
`phase3-guards.test.ts` are untracked. Commit them before anything else (Rule 5 in NEED-TO-DO §0.1).

Git was initialised mid-session. Before that, an unreverted mutation from a cancelled sub-agent silently removed `sanitizePayload` from `JsonlEventStore.emit` — API keys were reaching disk unredacted — and only a cold-state rebuild caught it. **Commit at every green point.**

---

## Phase status

| Phase | State |
|---|---|
| 1 — Engine baseline (1.1–1.15) | **DONE**, gate green from a cold install |
| 1.5 — Tauri hardening (1.16, 1.17) | **DONE** — pulled forward from task 4.3 by user decision, because 2.2 opens a real IPC path and `src-tauri` was unsandboxed. Task 4.3 is marked SUPERSEDED in tasks.md |
| 2 — Transports + capture-as-eval (2.1–2.4) | **DONE**, then audited; four defects found and fixed in `397be09` |
| 3 — Code surface (3.1–3.7) | **DONE**, gate green from a cold install |
| 4–12 | Not started. Note 4.3 is superseded by 1.16 |

Task counts as of this handoff: 96 total, 28 complete.

---

## What is real vs. seam (do not overstate this to the user)

**Real:** the dependency-free core engine; event-sourced JSONL log with write-path redaction; the seven-action agent loop with the plan gate enforced *in the engine*; shell-less verify runner; eval harness; SkillOpt trainer with a strict `>` validation gate; stdio JSON-line CLI (5 methods, event streaming, esbuild-bundleable); `StdioSketchClient` and `HttpSketchClient` with a Vite dev bridge; capture-as-eval that re-scores 1.0; Monaco editor with one authoritative file cache; Tauri hardening (capabilities file, real CSP, scoped fs, allowlisted terminal, contained fs commands).

**Seam / stub / absent, with the phase that makes each real:**
- `proposeEdit` has only the offline scripted stub → **6.6**
- No tool layer at all; `tool` actions emit `tool_denied` → **7.3**
- `ask` terminates the run (no interactive channel); there is no `cancel` verb on the CLI wire
- `FileExplorer`, `Terminal`, `SearchPanel`, `GitPanel`, `DiffReview` are now **real** (3.2–3.4, 3.6);
  ghost completions are real but **off by default** and have no provider behind the client seam yet.
  Monaco's widget is doubled in tests because it cannot run in jsdom — `ModelRegistry` is what is covered
- `SkillsMarketplace` (`MOCK_SKILLS`) → **6.4**
- `TaskLog` (`MOCK_TASKS`), `AgentTeamPanel` (fixture, and unreachable — no ActivityBar item dispatches `agents`) → **10.4**
- `ModelSelector` (hardcoded providers) → **4.1**
- Cost dashboard absent; `StatusBar` hardcodes `$1.4025` → **8.4**
- `SecretStore` is an interface with no persisting implementation → **4.2**
- `src/context/`, `src/memory/`, and the legacy `verifier/` + `orchestrator/` state machine are pre-existing code **not wired into the new loop**. The loop reuses only `orchestrator/file-writer.ts` and `orchestrator/json.ts` → **5, 9, 10**

**Nothing has ever run against a real provider.** Both adapters are exercised only against the fake and synthetic responses.

---

## Architecture decisions that must not be silently reversed

- `packages/core` has **zero runtime dependencies**. `test/deps.test.ts` enforces it and also enforces a `.js` extension on every relative import (NodeNext).
- The **event log is the single source of truth**. No subsystem gets a private log.
- The **plan gate lives in the engine**, not the UI: `edit` asks `PlanWriter.hasPlan(runId)` — the filesystem, not an in-memory flag — inside `runTask`. Every caller goes through that one function. The UI mirror (3.6) is defence in depth only.
- **Strict `>` in the trainer.** A tie keeps the incumbent. No epsilon, no `>=` mode, no force-accept. This is the anti-rot mechanism.
- **`AppState.files[path].content` is authoritative**; the Monaco model is a projection. Two functions cross the boundary: `ModelRegistry.sync()` (state→model, the only `setValue`) and one `onDidChangeContent` (model→state). `sync` suppresses the change callback for its own write, because Monaco fires the same event for `setValue` as for typing.
- **Unsupplied plan documents are omitted, not stubbed**, so `hasPlan` never has to sniff file bodies for a stub marker.
- **`verify-pass` fails when nothing was verified.** Otherwise a split of `verify: []` cases scores 1.0 for every candidate and the trainer gate becomes a coin flip.
- Containment lives in **one** place: `src-tauri/src/command_policy.rs`. `resolve_within` is the single primitive; `resolve_cwd`, `resolve_dir_within`, `resolve_file_within`, `resolve_write_target` are thin wrappers. A test asserts there is exactly one `is_within` and one `has_parent_escape`.
- Two deliberate duplications, both documented in-code: `providers/` legacy `ProviderAdapter` alongside canonical `ChatAdapter`, and `verifier/` (legacy, `shell: true`) alongside `verify/` (new, `shell: false`). Neither has an owning phase for convergence.

---

## Spec gaps found and recorded, not absorbed

- No `ask` EventKind — the loop records a question as `think` with an `action: "ask"` discriminator.
- No `skill_trained` EventKind — the trainer uses `think` with `component: "skillopt"`.
- No CLI cancellation verb — `runTask` accepts an `AbortSignal` the wire cannot reach.

Do not add an EventKind without a spec update; use an existing kind with a payload discriminator and report the gap.

---

## Open risks

1. **Nothing can open a file yet.** `useFileActions.openPath` has no shipped caller until `FileExplorer`'s `MOCK_TREE` is replaced — that is **3.4**. The Code surface currently reaches "project open, no file open".
2. **`git_status` / `git_diff` containment** was carried into task 3.3 and needs verifying as finished: `project_root` must route through `command_policy`, and `git_diff`'s caller-supplied `file` must be a contained path with `--` terminating option parsing (a `file` starting with `-` becomes a git option; `--output=<path>` writes anywhere).
3. **The terminal allowlist cannot prevent arbitrary execution** and no longer claims to — `node -e`, `python -c`, and `npm test` all run arbitrary code by design. The real boundaries are the confirmation gate, the contained cwd, and the absence of a shell. Keep that framing honest.
4. **CSP is permissive**: `script-src 'unsafe-inline'` and `connect-src http: https:`. Vite dev needs some of it; worth tightening for production builds.
5. **Sidecar is 91 MB** (gitignored, rebuilt by `npm run build:sidecar`). `prd.md` states an installer target of <100 MB — the sidecar alone nearly exhausts it.
6. **`cli.test.ts` uses `describe.skip`** when `dist/cli.js` is absent, so 20 tests vanish silently if someone tests without building.
7. **Desktop coverage is thin relative to surface** — every fixture panel is untested, so replacing a fixture with real data has no safety net.
8. Two competing verify directories and two provider surfaces (see above).

---

## Environment quirks that cost time

- **`cargo test` cannot link here** — missing GNU `dlltool` (`parking_lot_core`, `windows-sys`, `getrandom`). Run Rust tests with `rustc --test src/command_policy.rs -o <tmp>/policy` and execute; the module is std-only precisely so this works. **Do not claim `cargo test` passes.**
- **The symlink containment test skips on Windows** without Developer Mode or elevation. It prints `SKIPPED …` and returns rather than passing vacuously.
- **PowerShell truncates or swallows interleaved `Write-Output`** when mixed with `Select-String` in one command. Run checks in separate invocations; verify each result rather than trusting a combined transcript.
- **Sub-agent dispatch failed repeatedly** with network / deserialization errors this session. Large prompts fail more often. Keep briefs compact and split work. When a dispatch fails, **check whether partial work landed** before retrying — twice it had.
- **Task-tool quirks:** task IDs must be numeric dotted (`1.16`, not `1.5h`), and a child of an already-**completed** parent cannot be marked `in_progress`. That is why the Tauri hardening tasks are numbered inside Phase 2's section rather than as a Phase 1.5 child.
- Tests must pass with `SKETCH_FAKE_PROVIDER` **both set and unset** — four provider tests once asserted against ambient env they never set.

---

## Verification ritual before declaring anything done

```
npm run typecheck    # must exit 0
npm run build        # must exit 0
npm test             # must exit 0, offline, with no API key
```

Plus, for a phase gate: delete `node_modules` and `packages/core/dist`, then `npm install && npm run build && npm test` from cold. The Phase 1 gate found a real security regression that a warm tree hid.

**Green output alone is not evidence.** Break each guard, watch it fail, restore it, watch it pass. Five guards were mutation-verified at the Phase 1 gate: the zero-dependency rule, the plan gate, the strict trainer gate, stdout purity, and secret redaction.
