# NEED TO DO — Sketch, from here to done

**Audience:** the developer who is going to write this code.
**Status date:** task 13.5 complete; the living log now distinguishes historical snapshots from current phase truth, covers every spec decision, and reports reproducible actionable-leaf progress. **78 of 82 actionable leaves are complete; only evidence-gated 12.1–12.4 remain open.**
**Authority:** `.kiro/specs/sketch-engineering-os/{requirements,design,tasks}.md` are the contract.
This file is the working plan on top of them. Where this file and the spec disagree, the spec wins
and you should fix this file.

---

## 0. Read this section before you touch anything

This project has already been bitten four times by the same class of mistake. Every rule below
exists because something broke. None of them are style preferences.

### 0.1 The five non-negotiables

1. **`packages/core` has zero runtime dependencies.** Not one. `packages/core/test/deps.test.ts`
   fails the build if `dependencies` is non-empty or if any file under `src/` imports a specifier
   that is not relative or `node:`. If you think you need a library, you need a hand-rolled 80-line
   module instead. This is what makes the engine embeddable, auditable, and offline.
2. **Never weaken a gate, guard, or redaction to make a test pass.** If a test is red, the cause is
   in the code until you have proven otherwise *out loud*. Deleting an assertion, loosening a
   matcher, adding `.skip`, or introducing an `epsilon` to the trainer comparison are all the same
   act: destroying the only evidence the system works.
3. **No mock or fixture data in a shipped panel.** A panel with no data shows an honest empty state
   naming *why* it is empty. `MOCK_TASKS`, `MOCK_SKILLS`, `mockResults`, `MOCK_TREE` are each a lie
   with a phase number attached (see §3).
4. **Green output is not evidence.** For every guard you touch: break it, watch the test fail,
   restore it, watch it pass. Paste both. A test that has never failed has never been verified to
   test anything.
5. **Commit at every green point.** Git was initialised 16 tasks late in this project. In that gap,
   a cancelled sub-agent silently deleted the `sanitizePayload()` call from `JsonlEventStore.emit`,
   and **API keys were written to disk unredacted** for an unknown number of commits. It was found
   only by a cold rebuild. Uncommitted work is unprotected work.

### 0.2 The verification ritual

Run all four, from the repository root, in this order, every time, before you claim anything:

```powershell
npm run build                         # must exit 0 — FIRST: desktop needs core's emitted .d.ts
npm run typecheck                     # must exit 0
npm test -w @sketch/core              # must exit 0 — offline, with NO hosted-provider key
npm test -w @sketch/desktop           # must exit 0 — offline, with NO hosted-provider key
```

**Build precedes typecheck.** This order is a correction made at the Phase 5 gate: `@sketch/core` is
consumed by name, so with `packages/core/dist` absent the desktop typecheck fails with ~43 errors
about a missing module and implicit `any`s — none of them real. An earlier version of this section had
typecheck first, which is fine on a warm tree and misleading on a cold one.

For a **phase gate**, that is not enough. Do it cold:

```powershell
Remove-Item -Recurse -Force node_modules, packages/core/dist
npm install
npm run build
npm run typecheck
npm test -w @sketch/core
npm test -w @sketch/desktop
```

The Phase 1 gate found a real security regression that a warm `dist` had been hiding. A warm tree
can pass while the shipped artifact is broken.

Also run the test suite **twice**: once with `SKETCH_FAKE_PROVIDER=1` and once with it unset. Four
provider tests once asserted against an ambient environment variable they never set, which made the
whole suite order-dependent.

### 0.3 Environment quirks that will cost you an hour each

| Quirk | What to do |
|---|---|
| `cargo test` cannot link on this machine — missing GNU `dlltool` | Run Rust tests with `rustc --test src/command_policy.rs -o <tmp>/policy` and execute the binary. `command_policy.rs` is deliberately std-only so this works. **Do not claim `cargo test` passes.** |
| The symlink containment test skips on Windows without Developer Mode | It prints `SKIPPED …` and returns. It does not pass vacuously. Do not read a skip as a pass. |
| PowerShell swallows interleaved `Write-Output` when piped through `Select-String` | Run each check as its own invocation. Read each exit code. Do not trust a combined transcript. |
| PowerShell: `&&` is not a command separator, and `` `n `` inside **single** quotes is a literal backtick-n | Use `;`. For inserted newlines use a double-quoted string or `fs` tooling — a literal `` `n `` written into `packages/core/package.json` during a Phase 5 mutation run made it unparseable, and the failure surfaced as "Failed to load PostCSS config", which points nowhere near the cause. |
| `packages/core/test/cli.test.ts` uses `describe.skip` when `dist/cli.js` is absent | 20 tests vanish silently if you test without building. **Always `npm run build` before `npm test`.** |
| Sub-agent dispatch fails on large prompts | Keep briefs compact. After any failed dispatch, run `git status` — partial work has landed twice. |

### 0.4 Talk about the work accurately

Say "seam" where it is a seam. Say "stub" where it is a stub. **Nothing in this project has ever
run against a real model provider** — both adapters are exercised only against `FakeChatAdapter`
and synthetic responses. That will remain true until someone deliberately does it with a key and
writes down what happened. Do not describe a wired interface as a working feature.

That sentence is now **enforced, not just asserted**. `packages/core/test/setup/noEgress.ts` is a
vitest setup file (wired in `packages/core/vitest.config.ts`) installed for every core test file. It
wraps `fetch` and `net.Socket.prototype.connect`, refuses any non-loopback destination, and names the
URL/host plus the offending test. Loopback stays allowed because the suite genuinely needs it. The
same guard checks that every `.sketch/bench` artifact's `provider` is a synthetic/offline identity,
so a real benchmark run fails the suite instead of quietly outdating this paragraph. **Do not widen
the allowlist.** A test that needs a remote host is a finding to report.

---

## 1. Where the project actually stands

**Status date: Phase 13 complete; only evidence-gated tasks 12.1–12.4 remain open. 78 of 82
actionable leaves are complete.** `tasks.md` has 96 raw checkbox rows: 83 leaves and 13 phase
summaries. Superseded leaf 4.3 is excluded, leaving 82 actionable leaves; the normalized raw state is
90 complete, four evidence-gated leaves, one superseded row, and one open Phase 12 summary. Core
1,036 tests / 54 files and desktop 503 tests / 54 files pass with build and typecheck green and
`SKETCH_FAKE_PROVIDER` both unset and set to `1`. Task 13.5 is documentation-only: it labels the old
milestones as historical snapshots, preserves phase-gate text as checkpoint evidence, maps every
spec conflict and design-authority decision into the living log, and replaces manually maintained
`/96` progress with the reproducible actionable-leaf count. The recurring Windows `verify-live`
port-release flake was stabilized separately in `012e109` without weakening the exact closed-port
assertion. Task 12.6 remains scripted offline harness evidence, not real-provider capability
evidence. Cross-platform package jobs and the strict `<100,000,000-byte` size gate are implemented,
but 12.1 remains open until native Windows, macOS, and Linux workflow jobs produce uploaded
installers and passing size manifests.

**Packaging evidence is honest.** The local Windows Tauri attempt reached Rust compilation but this
host's Application Control blocked Cargo build scripts (OS error 4551) and `dlltool.exe` is absent.
No Windows installer was produced or measured, and macOS/Linux were not run here. `PACKAGING.md`
defines the release matrix, measurement basis, unsigned status, and exact blocker.

**Benchmark evidence is deliberately narrow.** The internal CI result compares
`offline-scripted-v1 + Sketch` with the same scripted model plus `naive`. It is deterministic
synthetic regression evidence, not evidence about a real provider. No several-model public matrix
has been run, no provider claim is made, unknown cost remains `null`, and unobserved manual edits
remain `null`. The reporting mechanism is ready for repeated same-model pairs when real-provider
runs are deliberately authorized and recorded.

**`swarm` still ships OFF.** Phase 10's strategy gate found no strategy-level lift over `single`.
Phase 11's synthetic harness lift does not change that verdict and is not a license to enable swarm.

The detailed task expansions below are retained as historical implementation guidance from earlier
phase vantage points. They are not a current backlog. Current status comes from this section,
`tasks.md`, `tasks-executed.md`, and `HANDOFF.md`; only evidence-gated 12.1–12.4 remain open.

```
c13967d  phase 11 task 11.6 — read-only benchmark report panel
2a5f0f9  phase 11 task 11.5 — artifact script and lift regression gate
fc51f5e  phase 11 tasks 11.1-11.4 — fixed-budget honest benchmark substrate
511df18  phase 10 task 10.5 — Phase 10 gate, swarm stays off with no measured pass@k lift
9d6a9c7  phase 10 task 10.4 — AI Team and Tasks panels over real dispatcher events
56aa748  phase 10 tasks 10.1-10.3 — dispatcher, thirteen verifiable roles, merge, pass@k
54dbb20  phase 9 task 9.5 — Phase 9 gate, the contradiction chain end to end
adf1505  phase 9 task 9.4 — Memory panel, and four memory RPC methods
f864e9a  phase 9 tasks 9.1-9.3 — versioned memory, hygiene, reranked retrieval
287a767  phase 8 complete — gate green cold, gate result and eight decisions logged
c58dcf9  phase 8 task 8.5 — Phase 8 gate, plus a real overshoot the gate found
3decd9c  phase 8 task 8.4 — Cost Dashboard, three fake cost numbers deleted
3ab3a59  phase 8 tasks 8.2/8.3 — cost guard before the call, router, response cache
f89bc67  phase 8 task 8.1 — usage accounting, one price table, nine duplicates deleted
94aa773  phase 7 complete — gate green cold, gate result and eight decisions logged
d759311  phase 4 complete — self-hosted fonts, README zero-dollar recipe, gate green cold
```

**Historical cold-gate checkpoint:** an earlier cold reinstall recorded core 1,028 tests / 51
files and desktop 481 tests / 48 files, with build, typecheck, and `bench:check` green in both
provider environments. Later documentation-task validation records the current 1,036 / 54 core and
503 / 54 desktop counts above. The cold install's cache/network conditions were not instrumented, so
neither checkpoint is proof of an offline install.

**Previously recurring Windows timing issue, now stabilized:** `verify-live.test.ts` binds a real
port. Commit `012e109` increased only the post-kill settle allowance from 300 ms to 1,000 ms; the
exact assertion that the port is closed remains. If it recurs, investigate process cleanup rather
than weakening that assertion.

**Run the suites per workspace** — `npm test -w @sketch/core`, `npm test -w @sketch/desktop`. Not
`npx vitest run --root packages/<x>` from the repo root: several guard tests read source relative to
the process cwd, so that form reports ~58 phantom failures which vanish when run in-workspace.

**Cold order matters: `install → build → typecheck → test`.** The desktop typecheck resolves
`@sketch/core` through its emitted `.d.ts`, so running it before `build` on a cold tree produces ~43
phantom errors. §0.2's ordering was written before this bit, and this is the correction.

### 1.0 Two things Phase 5 changed that everything after it depends on

1. **The loop can be handed retrieved context** (`RunTaskDeps.retrievedContext`), rendered as its own
   system message and kept distinct from `AGENTS.md`. The `run` RPC assembles it **only** when given
   `contextBudgetTokens`, and the desktop does not pass it yet — so a default desktop run still sends
   no repository context. That stays true until Phase 8's cost guard exists.
2. **The lexical channel searches query terms, not the whole prompt.** It used to search for the
   entire task prompt as one fixed string, which matched nothing, which made hybrid retrieval
   silently vector-only for every natural-language task. If you touch `queryTerms`, `termsMatched` or
   `smartCase`, read the header of `hybrid-search.ts` first.
3. **There is one lexical search implementation, and the Search panel is a UI over it.** The panel
   used to have its own — `git grep` through the Tauri command policy, a folder walk behind it, and a
   matcher built on JavaScript regular expressions — so the same query over the same file could
   highlight one thing in the panel and score another in retrieval. `packages/desktop/src/search/`
   is deleted; the panel calls the `project-search` RPC method
   (`packages/core/src/context/project-search.ts`), which calls the same `lexicalSearch` the
   retriever calls. **What the panel lost:** its regex mode. The engine's dialect is literal by
   construction (`matchSpans`, `--fixed-strings`), and a regex mode in the panel would be a second
   dialect again — the exact defect this closed. `rg` still is **not** on
   `command_policy::ALLOWED_PROGRAMS`, and did not need to be: the engine spawns it through the
   verify runner, on the engine side of the seam.

### 1.1 What is genuinely real

- **Dependency-free core engine** (`packages/core`), NodeNext, enforced by test.
- **Event-sourced JSONL log** — append-only, one JSON object per line, `.sketch/events/<date>.jsonl`,
  with redaction on the **write path** (not the read path, so a leak cannot be un-leaked later).
- **Seven-action agent loop** with the plan gate enforced **in the engine**: `edit` calls
  `PlanWriter.hasPlan(runId)`, which asks the filesystem, not an in-memory flag.
- **Shell-less verify runner** — `spawn` with `shell: false`, per-command timeout, SIGKILL, no
  string interpolation anywhere near a command line.
- **Eval harness** with `verify-pass` / `contains` / `not-contains`, and the rule that `verify-pass`
  *fails* when nothing was verified.
- **SkillOpt trainer** with a **strict `>`** acceptance gate. A tie keeps the incumbent.
- **stdio JSON-line CLI** — 5 methods, event frames on stdout only, diagnostics on stderr,
  esbuild-bundleable to a single file.
- **Two real transports** — `StdioSketchClient` (Tauri sidecar) and `HttpSketchClient` (Vite dev
  bridge, hand-rolled `node:http`, SSE for events). The factory defaults to a real transport.
- **Capture-as-eval** — a finished run becomes an `EvalCase` that re-scores exactly 1.0.
- **Monaco editor with a single file-state owner.** `AppState.files[path].content` is authoritative;
  the Monaco model is a projection. Exactly two functions cross that boundary.
- **Tauri hardening** — capabilities file, real CSP, scoped fs plugin, allowlisted shell-less
  terminal with a confirmation gate, and every custom fs/git command routed through one containment
  primitive in `src-tauri/src/command_policy.rs`.
- **Real Git panel** — `packages/core/src/tools/git.ts` via the verify runner's `runCommand`; correct
  porcelain parsing for renames, quoted and non-ASCII paths, detached HEAD, no upstream; real
  stage/unstage/commit; a diff pane; two distinct empty states (clean repo vs not-a-repo).

### 1.2 Current seams, limits, and evidence gaps

| Thing | Current reality | Status |
|---|---|---|
| `proposeEdit` trainer path | Provider-backed body-only rewrites behind strict held-out `>` acceptance | implemented (6.6); no real-provider run |
| Tool/MCP layer | Curated exact-version catalog, per-run host, capability gate, timeout latch | implemented (7.3); named third-party packages unaudited/unexecuted here |
| `ask` action | Terminates the run; there is no interactive reply channel | unowned |
| Run cancellation | `runTask` accepts an `AbortSignal` the CLI wire cannot reach | unowned |
| Ghost completions | Implemented and off by default | no default provider path |
| Monaco widget | Doubled in jsdom; `ModelRegistry` owns tested state synchronization | test-environment limit |
| Provider settings / selector | Real key-free persisted entries and selection; local provider forwarding works | hosted stored-key invocation remains half-wired |
| Cost guard | Enforced before calls when configured; no default desktop budget | desktop default open |
| Retrieval | Graph/search/assembly are real, but desktop does not send `contextBudgetTokens` by default | default wiring open |
| Versioned memory | Persistence, hygiene, retrieval, and panel are real | automatic live-run ingestion/injection open |
| Native/release/offline/community evidence | Workflows and deterministic gates exist | evidence-gated 12.1–12.4 |
| Legacy compatibility paths | `ProviderAdapter` coexists with `ChatAdapter` | convergence unowned |

### 1.3 One deliberate duplication (was two)

It is documented in-code and has **no owning phase**. Do not "clean it up" on a whim; propose a
convergence task first.

1. `providers/` has a legacy `ProviderAdapter` surface alongside the canonical `ChatAdapter`.

~~2. `verifier/` (legacy, `shell: true`) exists alongside `verify/` (new, `shell: false`).~~
**RESOLVED 2026-08-03 by deletion, not convergence.** See §4.2. `verify/` is the only verify path,
and a source-level guard in `verify-runner.test.ts` forbids `shell: true` anywhere under
`packages/core/src/`.

One legacy surface without an owning phase is left behind by that deletion: `ProjectMemory` /
`legacyProjectMemory` in `memory/`. It is published API from `@sketch/core` and its bridge tests
still pass, but the legacy orchestrator was its only in-repo caller. Retiring it is a breaking
change to published API, so it is a spec decision rather than a cleanup.

---

## 2. Your daily loop

```bash
# 1. Pick the next task. It is the lowest-numbered unchecked leaf in tasks.md.
#    Do not skip ahead. Phase gates are hard: no phase starts until the previous gate is green.

# 2. Read the requirement IDs on that task in requirements.md. They are the acceptance criteria.
#    A task is not done because the code runs. It is done when those criteria are provably met.

# 3. Write the test first where you can. For a panel, the test that matters most is the one that
#    asserts the fixture is GONE:
#        expect(source).not.toMatch(/const MOCK_/)
#    See packages/desktop/src/panels/GitPanel.test.tsx for the pattern to copy.

# 4. Implement.

# 5. Verify (§0.2), including the break-it-restore-it pass on any guard you touched.

# 6. Commit. One task per commit. Message: "sketch: phase N task N.M - <what changed>"

# 7. Tick the checkbox in tasks.md and add a row to tasks-executed.md.
#    tasks-executed.md is the project's living log (Rule 9) and it has been wrong before —
#    its Milestone 4 claims were false and had to be reconciled. Keep it honest.
```

**One task per commit.** Not one phase. When something goes wrong you want a bisectable history,
and this project's worst incident was invisible precisely because there was nothing to bisect.

---

## 3. Historical implementation expansion (written from the Phase 3 vantage point)

At this checkpoint, 73 tasks remained. The prose below is retained for rationale and failure traps,
not as a current backlog. Current progress is 78/82 actionable leaves with only 12.1–12.4 open.
Requirement IDs in `_italics_` remain useful historical acceptance references.

### Phase 3 — Code surface (4 tasks left)

This phase's goal is that the Code surface stops lying. When it is gated, a user can open a real
file, watch the agent propose a real edit, accept it hunk by hunk, and see it in real git status.

---

#### 3.2 — Diff review with per-hunk accept and reject
_Requirements: 16.1, 16.2, 16.3, 16.5_

**What to build.** Render `edit_proposed` event payloads as a reviewable diff. Each hunk gets its
own accept and reject control. Accept emits `edit_accepted`; reject emits `edit_rejected` **with a
reason string**. Rejecting every hunk must leave the file on disk byte-identical.

**How to do it without making a mess.**

1. Write the hunk parser in **core**, not in the UI: `packages/core/src/diff/hunks.ts`. It takes a
   unified diff string and returns `Hunk[]` with `{ header, oldStart, oldLines, newStart, newLines, lines }`.
   Pure function, no I/O, no dependencies. This is the piece that must be exhaustively tested, and it
   is far easier to test in core than through React.
2. Write the **applier** in core too: `applyHunks(original: string, hunks: Hunk[], accepted: Set<number>): string`.
   It must be a pure function of its inputs. **This is the function that guarantees 16.5** — feed it
   an empty `accepted` set and assert the output is `=== original`, not merely equal-ignoring-whitespace.
3. Only then build the React surface. It reads hunks from state and dispatches accept/reject.
   Reuse Monaco's diff editor for rendering if it is cheap to do so, but **do not** let Monaco own
   the accept/reject decision — the authoritative accepted-hunk set lives in `AppState`, same
   discipline as 3.1.
4. Write the file through the existing single owner. Do **not** add a second write path.

**Traps.**

- **CRLF.** This is a Windows machine and the repo has mixed line endings (git already warns about
  LF→CRLF on several files). A hunk applier that assumes `\n` will corrupt files. Detect the
  original's dominant ending, split on `/\r?\n/`, and re-join with what you found. Write a test with
  a CRLF fixture. This is the single most likely way to ship a data-loss bug in this task.
- **No trailing newline.** A file that does not end in a newline must not gain one.
- **Overlapping / out-of-order hunks.** Apply in descending `oldStart` order, or compute offsets
  explicitly. Never mutate a string you are still indexing into by original coordinates.
- **Stale diff.** If the file changed on disk since `edit_proposed`, accepting is unsafe. Compare a
  content hash and refuse with a named reason rather than applying blind.

**Done when.** A test proves: (a) accept-all produces exactly the proposed content; (b) reject-all
leaves the file byte-identical, asserted by re-reading from disk; (c) accepting hunk 2 but not 1
produces the correct interleaving; (d) `edit_rejected` carries a non-empty reason; (e) a CRLF file
round-trips unchanged.

---

#### 3.4 — Make Explorer, Terminal, and Search real
_Requirements: 14.4, 14.6, 27.1, 27.3, 27.4_

**Do this one before 3.5 and 3.6.** It unblocks everything: right now **nothing in the shipped UI can
open a file**. `useFileActions.openPath` exists and works but has no caller, because `FileExplorer`
renders `MOCK_TREE`. Until this lands, the Code surface can only reach "project open, no file open",
and 3.7's end-to-end gate is impossible.

**Three separate pieces. Commit them separately.**

**(a) FileExplorer.** Replace `MOCK_TREE` with real `read_dir` data through the client seam. Wire a
click to `openPath`.
- Lazy-load children on expand. Do not walk the whole tree on mount — this project's own
  `node_modules` would hang it.
- Respect `.gitignore`. There is already ignore handling in `src/context/walker.ts`; reuse it rather
  than writing a second matcher. (Note 5.1 also asks for `walkProject` test coverage — if you touch
  the walker here, write those tests here and cite it in 5.1.)
- The tree state must not become a second file cache. It holds *names and expansion state only*.
  Content belongs to `AppState.files`, per 3.1.
- Two honest empty states: no project open, and an empty directory.

**(b) Terminal.** Replace the static markup with a real input and real output from state.
- Route every command through the **existing** scoped terminal tool (`run_command` in
  `src-tauri/src/main.rs` → `command_policy`). Do **not** add a second spawn path, and do **not**
  reintroduce a shell.
- Be honest in the UI about what the allowlist does. It restricts *which program* starts. It does
  **not** prevent arbitrary code execution — `node -e`, `python -c`, and `npm test` all run
  arbitrary code by design. The real boundaries are the confirmation gate, the contained cwd, and
  the absence of a shell. Do not write a tooltip that claims more than that.
- Surface the confirmation gate visibly. A command that requires confirmation must show the exact
  argv the user is approving, not a re-joined string (re-joining is how you lose the quoting that
  made it safe).
- Output is append-only state, capped with a ring buffer. A `npm test` on a big repo will otherwise
  render tens of thousands of nodes and freeze the window.

**(c) SearchPanel.** Replace the function-local `mockResults`; bind the currently-uncontrolled input
to state.
- Search runs in core, through the verify runner's shell-less spawn, with the query passed as an
  **argv element** — never interpolated. Prefer `rg --json` if ripgrep is present (5.2 wants a
  ripgrep channel anyway, so this is shared groundwork); fall back to a Node walk when it is not.
- Debounce, and cancel the in-flight search on a new keystroke. An `AbortController` per query.
- Cap results and say so in the UI ("first 200 matches") rather than silently truncating.

**(d) Debugger entry point.** _Requirement 27.4_ asks for an entry point, not a debugger. Add the
ActivityBar item and a panel that states plainly what is not implemented yet. An honest
"not built yet" panel is in scope; a fake stack trace is not.

**Done when.** Clicking a real file in the Explorer opens it in Monaco with real content. Typing
`git --version` in the Terminal shows real output after a confirmation. Searching a string finds real
occurrences. A source-level test asserts `MOCK_TREE` and `mockResults` no longer exist.

---

#### 3.5 — Optional debounced ghost completions
_Requirement: 15.5_

**Off by default.** A setting, defaulting to false, that the user turns on.

- Keystroke-to-UI under **16 ms** for the local path — that is one frame. Measure it in a test with
  a fake clock; do not eyeball it.
- Every in-flight request cancellable. When the user types again, the previous request is aborted,
  and a late response is **discarded by request id**, not merely ignored — a stale completion
  arriving after a newer one is a visible bug.
- Ghost text must never enter `AppState.files[path].content`. It is a Monaco decoration until
  accepted. If it leaks into the authoritative cache, the file becomes dirty from a suggestion the
  user never took.
- This is the one place in the app where latency is user-visible per keystroke. It is also the one
  place a cost bug can quietly cost real money. Route it through the Phase 8 cost guard when that
  exists, and until then keep it behind the default-off flag.

**Done when.** A test proves the feature is off unless enabled, that the debounce coalesces bursts,
that an aborted request's response never renders, and that ghost text is not in the file cache.

---

#### 3.6 — Mirror the plan gate in the UI
_Requirements: 16.4, 6.5_

Disable apply-edit controls until `plan_written` has been observed for that `runId`.

**This is defence in depth only.** The real gate is in the engine and it asks the filesystem. Do not
move it, do not duplicate its logic, and above all do not let the UI's in-memory belief become the
thing that authorises a write. If the UI says yes and the engine says no, the engine wins and the UI
shows the engine's refusal.

Key it by `runId`. A `plan_written` from a previous run must not unlock the current one.

**Done when.** A test drives events for a run with no `plan_written` and asserts the apply control is
disabled; then feeds `plan_written` for a *different* runId and asserts it is still disabled; then
feeds it for the right runId and asserts it enables.

---

#### 3.7 — Phase 3 gate
_Requirements: 15.2, 16.4_

Prove, offline, in one recorded sequence: **open a file → the agent runs → a diff is proposed →
review it hunk by hunk → accept → the change appears in real `git status`**, with the plan gate
enforced in both the engine and the UI.

Cold-run the whole ritual (§0.2). Then mutation-verify, pasting failing-then-passing output for each:

1. Remove the plan-gate check from the engine → an edit-without-plan test must fail.
2. Remove the UI mirror → the 3.6 test must fail.
3. Point the hunk applier at the wrong offset (`oldStart` → `newStart`) → **seven tests in
   `packages/core/test/diff.test.ts` must fail** (subset offset, order-indifference, apply-all, pure
   insertion, empty-file creation, and both round-trip properties).
   *Corrected at the Phase 3 gate: an earlier version of this line claimed the reject-all
   byte-identity test would fail. It cannot. Reject-all never calls the applier — its guard is that
   the writer is called zero times — so that test passes under this mutation and proves nothing
   about offsets.*
4. Remove `sanitizePayload` from the event store → the redaction test must fail. *(Run this one
   every gate. It is the regression that actually happened.)*
5. Add a dependency to `packages/core/package.json` → `deps.test.ts` must fail.

Update `tasks-executed.md` with a decision-log row per architectural decision made in the phase.

---

### Phase 4 — Settings, secrets, provable zero telemetry (4 tasks)

This is the phase that makes v1 shippable. After it, a user can bring their own key safely.

---

#### 4.1 — Provider Settings surface
_Requirements: 17.1, 17.2, 27.1_

List the full provider matrix. Allow a custom endpoint. Offer a per-provider connection test.
Persist **key-free** configuration to `~/.sketch/providers.json`. Delete the `ModelSelector` fixture
and render the real `state.providers` array (which currently exists and is never read).

- `providers.json` holds `{ kind, baseUrl, model, label }`. **It must never hold a key.** Write a
  test that round-trips a config with a key set and asserts the key is absent from the file bytes.
- The connection test must work against `http://localhost:11434/v1` (Ollama) with no internet. That
  is the 4.5 gate condition; build toward it now.
- Registry entries already exist for OpenAI, Anthropic, Gemini, openai-compatible, GitHub Models,
  Azure OpenAI, Cloudflare Workers AI, and llama.cpp. Each is flagged for whether it is a serverless
  inference endpoint — surface that flag, because it changes the cost and latency story.
- A custom endpoint is the extensibility point for everything we do not ship. Treat its validation
  seriously: reject a non-http(s) scheme, and show the resolved URL you will actually call.

---

#### 4.2 — SecretStore seam and OS credential storage
_Requirements: 17.3, 17.4_

**The single most security-sensitive task remaining.**

- `SecretStore` (`get`/`set`/`del`) stays in core **with no implementation that persists**. Core must
  not be able to write a secret to disk. That is not a convention, it is the architecture: a
  zero-dependency engine that cannot touch a keychain cannot leak one.
- Real storage goes on the **Rust side**, against the OS credential store (macOS Keychain, Windows
  Credential Manager, libsecret on Linux).
- Expose `list_providers`, `set_api_key`, `remove_api_key` as Tauri commands. **These are already
  called by `bridge.ts` and do not exist.** That is a live broken call path today.
- Delete the keytar-shaped `KeychainCredentialStore` in favour of the seam.
- The resolved key is supplied to the engine **at invocation time only**. It is a function argument.
  It is never a field on a long-lived config object, never in an env var the child inherits by
  accident, never in an event payload.
- Add the Tauri commands to `capabilities/default.json` — and to nothing else. Grant the minimum.
- `list_providers` returns provider **identifiers and whether a key is present**. It never returns a
  key, not even truncated. A four-character prefix is still four characters of a secret.

---

#### 4.4 — Prove zero telemetry and secret redaction
_Requirements: 17.5, 17.6, 17.8_

- Write `PRIVACY.md` stating exactly what leaves the machine. The honest answer today is: nothing,
  except the model API call the user configured. Say it that plainly, and keep it true.
- A grep test asserting `analytics`, `telemetry`, `sentry`, `posthog` are absent from
  `packages/**/src`. Make it check `package.json` and `package-lock.json` too — a dependency can
  phone home without the string ever appearing in your source.
- A test asserting a thrown provider error never contains the configured key value. There is already
  a `redact()` helper applied to every provider error; this test is what stops someone removing it.
- Extend it: assert the key is absent from the **event log on disk** after a failing run, not just
  from the thrown error. That is the path that actually regressed once.

---

#### 4.5 — Phase 4 gate — v1 complete
_Requirements: 17.7, 26.3, 1.6_

Prove: keys live only in the OS store; `providers.json` is key-free; the grep test is clean; a
connection test against local Ollama succeeds with **no internet**.

Write the `README.md` **$0 stack recipe**: `FakeChatAdapter` for tests, local Ollama or a free tier
for demos, never a paid-only path. Someone must be able to evaluate this project for zero dollars.

Mutation-verify: put a key into `providers.json` by hand → the key-free test must fail. Add
`posthog` to a source file → the grep test must fail.

---

### Phase 5 — Intelligent context (6 tasks) — **DONE, gated at `90e6c57`**

Kept below as the record of what was asked for and which traps were real. Gate outcome, measured on
the fifty-file fixture and printed on every run: whole repository 7 226 tokens; targeted context
832–1 492 tokens; the answering file present in **5/5** targeted contexts vs **1/5** baseline; mean
in-domain precision **0.668** vs **0.100**; held-out eval score **1.000** vs **0.333**; **7/7**
architecture views drawn as real SVG. Full result and the seven mutation checks are in
`tasks-executed.md`.

Two traps below were understated, and both cost real time — they are worth reading before Phase 9
touches retrieval again:

- **The lexical channel searched the whole prompt as one literal string.** 5.2 as written did not
  mention that `assembleContext` is called with `task.prompt`, so the shipped hybrid retriever
  returned zero lexical hits for every sentence-shaped task and quietly degraded to the weak hashing
  vector channel. Fixed in 5.6 with query terms, coverage-first ranking and per-term smart case.
- **Nothing consumed the assembled context.** 5.4 built the assembler and no task wired it to a run,
  so Phase 5 would have shipped a retriever with no caller. Fixed in 5.6 with
  `RunTaskDeps.retrievedContext` and an opt-in `contextBudgetTokens` on the `run` method.

This is where Sketch starts being *better* rather than merely honest. Everything here already had
pre-existing, unwired code in `packages/core/src/context/` — walker, chunker, dependency-graph,
embedder, vector-store, context-engine. The job was largely to wire, correct, and test it, not to
write it from scratch.

---

#### 5.1 — Persist the repository graph
_Requirement: 18.1_

Build the graph from the existing walker, chunker, and dependency-graph modules. Persist to
`.sketch/index/graph.json`. Rebuild **incrementally by content hash**.

- Add the missing test coverage for `walkProject`, **including `.gitignore` handling**. It is
  currently untested and it is the foundation of everything in this phase.
- Incremental means: hash each file's content, keep the hash in the persisted graph, and on rebuild
  only re-chunk files whose hash changed. Also handle deletions — a file that vanished must leave the
  graph, or search will return dead paths forever.
- `graph.json` must be deterministic for a fixed repo: sort every array. A non-deterministic index
  makes every downstream test flaky and every diff unreadable.
- Cap it. A 100k-file repo must degrade gracefully with a stated limit, not exhaust memory.

---

#### 5.2 — Hybrid search with reranking
_Requirement: 18.2_

Add a **ripgrep-backed lexical channel**. Fuse it with the existing vector channel by **reciprocal
rank fusion**. Add a rerank pass. **Vector-only retrieval must not be the shipped default.**

- Why this matters: vector-only search is the single most common reason AI coding tools retrieve
  plausible-but-wrong context. Exact identifiers, error strings, and config keys are lexical
  problems. RRF is ten lines and it fixes most of it.
- `rg` may be absent. Detect once, cache the answer, fall back to the Node walk, and **say which
  channel ran** in the `context_assembled` payload. Silent degradation to a worse retriever is the
  failure mode to avoid.
- Share the spawn path with 3.4(c). One search implementation, two callers.
- RRF: `score(d) = Σ 1/(k + rank_i(d))` with `k = 60`. Write the test with a hand-computed expected
  ordering so the constant cannot drift unnoticed.

---

#### 5.3 — Embeddings offline
_Requirement: 18.3_

A local embedding path with **no network**. Provider embeddings cached locally as a documented
fallback.

- Zero dependencies applies here too. A local embedder without a model library means either a
  hash/n-gram vectoriser (weak but real, honest, and instant) or reading a small ONNX/GGUF model via
  a *sidecar process* rather than a core dependency. **Pick one, write down the tradeoff, and do not
  pretend a hashing vectoriser is semantic search.** The lexical channel from 5.2 is what carries
  quality when the embedder is weak — which is exactly why 5.2 comes first.
- Cache by content hash under `.sketch/index/embeddings/`. A cache hit must be free and offline.

---

#### 5.4 — Context assembly under a token budget
_Requirements: 18.4, 18.5, 18.6, 18.8_

Combine memory, skills, top-k chunks, and **one-hop graph neighbours** under a token budget. When
truncating, **preserve signatures over bodies**. Emit `context_assembled` with the selected paths and
the token estimate.

- `ContextEngine.retrieve` currently computes `expandWithDependencies` **and throws the result away**.
  Consume it. That is a real, existing bug.
- Signature-over-body is the highest-leverage idea in this phase: twenty function signatures beat one
  function body at the same token cost, almost always. Implement it as a per-chunk degradation ladder
  — full body → signature + doc comment → signature → path only — and degrade the lowest-scoring
  chunks first.
- The token estimate must be a **stated** estimate with a named method, not a magic number. If it is
  `chars/4`, say `chars/4` in the payload.
- Budget enforcement must be pre-flight. Assembling and then discovering you are over budget means
  the model call already went out.

---

#### 5.5 — Architecture generator
_Requirements: 19.1–19.5, 27.1_

Derive system, API, database, component, dependency, folder-tree, and call-graph views from the
graph. **Deterministic for a fixed graph. No network.** Emit `diagram_updated`; render in a Live
Architecture panel.

- Emit Mermaid text, not images. It is diffable, testable by string comparison, renderable anywhere,
  and needs no dependency in core. Rendering is the desktop package's problem.
- Deterministic means: sort nodes and edges, and never let `Map` iteration order leak into output.
  The test is `generate(graph) === generate(graph)` across processes, plus a committed snapshot.
- There is a root `architecture.md` already. 13.3 asks you to amend it. Consider generating a section
  of it from this generator so the doc cannot rot.

---

#### 5.6 — Phase 5 gate — **DONE**
_Requirement: 18.7_

On a **fixed fifty-file fixture**, prove two things at once: targeted context is smaller *and* more
relevant than the whole-repo baseline, **and** the held-out eval score rises. Prove diagrams render.

**How it was actually built, and where this brief was wrong.**

- *"Build the fixture as a committed directory."* It is **generated by code** instead
  (`packages/core/test/phase5-gate.test.ts`), because fifty committed files cannot be audited at a
  glance and the property that matters — each fact appears in exactly one file — has to be readable
  in one screen. That property is also asserted per fact against every file, so the generator cannot
  drift into overlap unnoticed.
- *"precision@k against hand-labelled expected files."* Labels are **derived from paths**, not
  hand-written: relevant = the domain the question is about. Hand labels in a fixture are a second
  source of truth that rots against the fixture. Two numbers are reported — whether the answering
  file is present at all (recall on a set of one), and the in-domain share of everything selected.
- **The baseline must be allowed to win a case.** `auth` sorts first of the ten domains, so a
  budget-truncated dump answers its question, and `auth` is deliberately in the **held-out** split:
  the rise is 0.333 → 1.000, not 0 → 1. A baseline that scores zero measures the fixture's
  construction, not the retriever.
- **"Held-out" means not tuned on**, since nothing here trains. The budget and topK were chosen on
  two dev cases; the assertion is made on the other three; both splits' numbers are printed.
- **The eval half needs an instrument, and the instrument needs its own test.**
  `ContextFaithfulAdapter` answers only from the text it was handed and refuses otherwise. A test
  proves it refuses on an empty context and on another domain's files. It is **not a model** and the
  gate claims nothing about model reasoning.
- **"Prove diagrams render" cannot be done in core** — core has no renderer.
  `packages/desktop/src/phase5-gate.test.tsx` drives a second fifty-file fixture through the real
  `METHODS` table into real SVG and counts `<rect>` boxes against the generator's own node counts.
  That fixture carries route registrations, a `.sql` schema and one cross-module import so that all
  seven views have evidence and none has to be excused.
- **The new UI gate does not cover the honesty rule.** Because all seven of its views are available,
  the "unavailable draws nothing" branch is never exercised there — the older
  `LiveArchitecture.test.tsx` is what holds that line, and the mutation run confirmed it is the only
  thing that does.

---

### Phase 6 — Skills registry and trainer (7 tasks) — **DONE, gated**

Kept below as the record of what was asked for. What shipped, and where it differs from this brief:

- **§5.4 steps 1–2 were not done as written.** Community skills were **not** cloned or vendored, and
  skill discovery was **not** widened to `.agents/skills/`. Instead all six packs are skills written
  for this project — prose only, so the whole seed set installs before the tool layer exists without
  running a stranger's Python. Vendoring needs a license review and a recorded commit SHA, which is
  a deliberate act with its own step, not something to do implicitly while seeding a registry. The
  format stays compatible, so `loadSkillsFromRoots` and vendoring remain cheap follow-ups.
- **6.3 built the enforcement point; there are still no tools.** The adversarial suite proves the
  gate denies an ungranted call. It does **not** prove a hostile skill cannot reach the network,
  because nothing in this build can reach the network on a skill's behalf. That is 7.3. The
  `last30days` install test in step 5 is therefore still outstanding and belongs after 7.3.
- **The registry is a content pin, not an author signature.** It proves what you install matches the
  manifest, never who wrote the manifest. The 12.3 release path adds repository/workflow provenance
  for assembled release bytes, but no real tag release has run and that provenance does not replace
  marketplace hashing, capability scope, or digest-bound review.
- **Requirement 9.7's cost guard is satisfied for training only.** `TrainingBudget` bounds the
  optimizer's own calls and tokens, checked pre-flight. The loop-wide guard is 8.2.
- **A shipped-app defect was caught by the sidecar hazard guard**: locating the registry relative to
  `import.meta.url` works in tests and points at nothing in the bundled sidecar. There is now no
  path-relative default — `params.registryDir` or `SKETCH_REGISTRY_DIR`, and an honest refusal
  otherwise. Pointing the app at the shipped registry is packaging, task 12.1.

Full gate result, numbers and the four mutation checks are in `tasks-executed.md`.

**This is the phase that makes Sketch worth adopting.** See §5 for the concrete skill strategy and
the community ecosystem to plug into — read that section *before* designing 6.1, because the manifest
format decision there determines whether thousands of existing skills install into Sketch or none of
them do.

---

#### 6.1 — Signed curated registry
_Requirements: 11.1, 11.2_

A pinned manifest with a **content hash per skill**. Reject installation on hash mismatch with a
tamper diagnostic that names the expected and actual hash.

- Hash the **whole skill directory**, not just `SKILL.md`. A skill is scripts plus prose; hashing only
  the prose leaves the executable part unprotected. Canonical form: sort relative paths, hash
  `path + "\0" + bytes` for each, then hash the concatenation. Write that algorithm down in the
  manifest format itself so a third party can reproduce it.
- Use `node:crypto` — it is a `node:` builtin, so it does not violate the zero-dependency rule.
- The diagnostic must be actionable: which file differs, not just "hash mismatch".
- Store the manifest as a committed JSON file with a version field. You will change this format.

---

#### 6.2 — Seed the registry
_Requirement: 11.3_

Ship packs: context packing, web/data, general engineering, frontend design, research-stage,
finance/quant. §5.3 lists the specific skills to build and adapt, with reasoning.

---

#### 6.3 — Enforce capability scopes
_Requirements: 11.4, 11.5_

Enforce `capabilities:` **at the tool and filesystem layer**. A skill without a network capability
cannot fetch, and the attempt emits `tool_denied`.

- **Enforcement must not live in the prompt.** "You are not allowed to use the network" in a system
  prompt is a suggestion. The check belongs at the point of execution, in the tool layer, where a
  capability set is consulted before the call is made. If the tool layer does not exist yet (7.3),
  then 6.3 builds the *enforcement point* and 7.3 populates it — sequence them that way and say so.
- The loader already normalises `capabilities` from both `SKILL.md` frontmatter and `skill.json`
  (comma string or list, trimmed, empties dropped). Read `packages/core/src/skills/loader.ts` —
  `normalizeCapabilities` is done and tested. You are building the consumer.
- Define the capability vocabulary explicitly and **fail closed on an unknown one**. A skill
  declaring `capabilities: [netwrok]` must be refused, not silently granted nothing and then behave
  confusingly. A typo that fails open is a vulnerability.
- Suggested vocabulary: `read`, `write`, `network`, `shell`, `git`, `env`. Deny-by-default: a skill
  with no `capabilities:` key gets `read` only.
- `tool_denied` must name the skill, the capability it lacked, and the call it attempted.

---

#### 6.4 — The real Skills surface
_Requirements: 14.6, 27.1, 27.3_

Replace `MOCK_SKILLS`, and the duplicate never-read `state.installedSkills` and
`state.skillMarketplace` fixtures, with registry data. Wire the dead `TOGGLE_SKILL` and
`INSTALL_SKILL` reducers.

- There are currently **three** places skill state pretends to live. Collapse to one, the way 3.1
  collapsed file state. Same discipline, same reasoning.
- The install flow must show capabilities **before** the user confirms, and the content hash it
  verified. This is the UI surface of the security model — if it does not show the scopes, the
  security model is invisible and users learn nothing from it.

---

#### 6.5 — Open the marketplace behind the gate
_Requirement: 11.6_

Ship the open marketplace with a review queue **only after** signing (6.1) and capability scoping
(6.3) are both tested. Not before. This ordering is the whole point.

---

#### 6.6 — Wire the real optimizer into `proposeEdit`
_Requirements: 9.5, 9.6, 9.7_

Replace the stub with the real optimizer, **keeping the strict validation gate unchanged**. Add a
"Train this skill on my project" action running `trainSkill` on captured evals over a
train/validation split, behind the cost guard, off the hot path.

- The strict `>` gate is the anti-rot mechanism. No epsilon. No `>=`. No force-accept flag. A tie
  keeps the incumbent. If you find yourself wanting to relax it because a training run produced no
  improvement, the correct conclusion is that there was no improvement.
- Never train on the validation split. Assert the split is disjoint in a test.
- This is the **one documented exception** in the whole plan that may require an API key (per 6.7).
  Everything else stays offline.
- This closes the compounding loop: a real run becomes an eval (2.3, done), evals train a skill
  (here), the trained skill improves the next run. That loop is the product's actual thesis.

---

#### 6.7 — Phase 6 gate
_Requirements: 11.2, 11.5, 9.8_

Prove signed install and scope enforcement **offline**. Prove the stub-optimizer trainer improves a
seed skill and rejects a regression. Mutation-verify the gate by flipping `>` to `>=` and watching
the regression test fail.

---

### Phase 7 — Verification contract and MCP (5 tasks) — **DONE, gated**

The verification contract is what separates "the model said it was done" from "it is done".

Kept below as the record of what was asked for. What shipped, and where it differs from this brief:

- **`skipped` and `not-run` are different words**, all the way to the panel. Nothing ran in either
  case, but one means "configure something" and the other means "an earlier stage failed and we
  stopped". `verifiedAnything` exists for the same reason: `ok` is true for a project that
  configures nothing, and that must never read as evidence.
- **Live feedback is folded into the `integration` stage**, not added as a tenth. Requirement 4.3
  fixes the nine; a tenth would have meant editing the contract or putting a check outside the `ok`
  rule, and a runtime error that does not count is one nobody acts on.
- **The MCP catalog has 15 entries** — the 14 that Requirement 22.2 names, plus `git`. Pinned by
  exact version, `@latest` forbidden and asserted. They are **launch descriptions for third-party
  packages this project has not audited**; the content pin that protects skills cannot reach them
  without vendoring, and that is recorded as an open gap.
- **A server the run's grant cannot reach is not started at all**, which is stronger than starting
  it and refusing its calls. The grant comes from the loaded skills and there is deliberately no
  `params.capabilities` — consent is recorded at install time and a wire parameter that could add
  `proc:spawn` would make it decorative.
- **The MCP badge was deleted, not replaced with a real count.** Servers start per run, so between
  runs nothing is connected and there is no number. `mcp-catalog` reports `configured` — could
  start, credentials present — and the panel says so in words.
- **The `verify` RPC method resolves by default and runs only when asked**, but when it runs it
  defaults to a *full* report rather than fail-fast: a user reading a report wants both failures at
  once, whereas the loop wants the first one only.
- **The gate found two bugs that were "green for the wrong reason"** — host timeouts dropped when a
  launch override was supplied, and the hang latch's event logged under the wrong run id. Details in
  the Phase 7 gate result in `tasks-executed.md`.

---

#### 7.1 — The verify policy
_Requirements: 4.3, 4.4, 4.5, 4.7, 4.8_

Nine **ordered** stages: format, lint, typecheck, build, unit, integration, security, performance,
dependency-audit. A `verify.yaml` at the project root takes precedence; auto-detect per stack when
absent, extending the existing node/python/rust/go detector. Unconfigured stages report **skipped**
without failing. A task is `ok` only when every non-skipped stage passed, **or none were configured**.

- Ordered matters: a lint failure should not wait behind a slow test suite. Fail fast, report the
  first failing stage prominently, and still record what ran.
- `verify.yaml` needs a parser and you have no YAML library. The existing hand-rolled frontmatter
  parser in `packages/core/src/skills/frontmatter.ts` covers the subset you need. Extend it or accept
  JSON as well. **Do not add `js-yaml`.**
- "Skipped without failing" plus "`ok` when none configured" combine into a real trap: a project with
  zero stages configured passes everything. That is intentional per 4.8 — but the eval harness must
  not treat it as a signal, which is exactly why `verify-pass` **fails when nothing was verified**.
  Keep those two rules straight; they look contradictory and are not.
- Reuse `verify/runner.ts`. Do not spawn from the policy layer.

---

#### 7.2 — Live environment feedback
_Requirements: 23.1–23.4_

A browser tool plus an application runner that captures console output and runtime errors. A runtime
error means **not done**. A failure to start is a **verification failure with captured output**. The
stage is skippable where it does not apply.

- This is the highest-value verification stage for real-world work and the hardest to keep honest.
  "It compiles" is not "it runs".
- Everything here is a long-lived child process. Time-box it, kill the process group (not just the
  parent), and always capture output before killing — output-after-kill is empty and useless.
- Port collisions and already-running dev servers are the common failure. Detect and report rather
  than hanging.

---

#### 7.3 — Curated isolated MCP registry
_Requirements: 22.1–22.5, 27.5_

Hand-rolled JSON-RPC over stdio, **no SDK dependency**. Curated and pinned coverage of GitHub,
Docker, Figma, Notion, Slack, terminal, browser, filesystem, SSH, Cloudflare, Supabase, databases,
Android emulator, Playwright. Route **all** side-effecting model actions through the tool layer,
emitting `tool_called` or `tool_denied`. Per-run and per-capability scoped grants. A hanging server
times out, is marked unavailable for the run, and **the run continues**.

- You already have a working hand-rolled JSON-line protocol in `packages/core/src/rpc/`. MCP is
  JSON-RPC over stdio. Reuse the framing discipline: protocol on stdout, diagnostics on stderr,
  one object per line, correlate by id.
- "The run continues" is the requirement most likely to be missed. Write the hanging-server test
  first: a fake server that accepts a connection and never answers. Assert the run completes with the
  tool marked unavailable.
- Every MCP server is an untrusted third-party process with your file access. Pin versions. Verify
  hashes as in 6.1. Grant capabilities per run, and default to none.
- **Tool output is untrusted input.** A tool result containing "ignore previous instructions" must be
  treated as data. Frame tool results as data in the prompt, and never let a tool result be parsed as
  an action.
- Replace the hardcoded MCP badge and tooltip with real status (27.5). Surface failures, reasons, and
  retries. A tool that failed silently is worse than one that never ran.

---

#### 7.4 — Test Results panel
_Requirement: 27.1_

Render the nine stages with real per-stage status, duration, and captured output. Failures expand to
the actual stderr. No fixture.

---

#### 7.5 — Phase 7 gate
_Requirements: 4.7, 23.2, 22.3_

Prove broken tests mean not done. Prove a broken running app means not done. Prove a hanging tool
cannot hang a run.

---

### Phase 8 — Cost and budget (5 tasks) — **DONE, gated**

Nothing here is optional. A tool that can spend money without a ceiling is a tool nobody can safely
leave running.

Kept below as the record of what was asked for. What shipped, and where it differs from this brief:

- **An unpriced model costs `null`, never `0`.** The brief did not say what to do about a model with
  no price. Showing unknown as `$0.00` is how a user finds out from an invoice, so `null` propagates
  and the unpriced calls are counted beside the total, which is reported as a lower bound.
- **Nine price tables became one**, carrying `PRICED_AT`. Three private `COSTS` tables and six
  `estimateCost` overrides returning `0` are deleted — for Groq, OpenRouter, Grok, Kimi and a custom
  endpoint that last one read as *free for a paid run*.
- **The projection learns from the run.** The gate caught a 600 000-token ceiling being overshot to
  750 000 because a prompt estimate was being compared against far larger real calls. It now
  projects using the largest call observed. The residual limit — no pre-flight check can bound the
  *first* call — is stated in `describeBudget`, not buried.
- **`onBreach` is required, with no default.** A default would have made the user's decision for
  them invisibly, which is the outcome Requirement 20.4 exists to prevent.
- **A `downgrade` with nowhere cheaper to go stops** and records that it could not downgrade.
- **The response cache stores the response but only the HASH of the prompt.** It is an adapter
  decorator, so the eval harness and trainer get it without the loop learning about caching.
- **The status bar shows a button, not a figure.** A live total there would be a second cost source.
  Three neighbouring `StatusBar` fixtures went with it: a hardcoded provider, `14.2k tokens`, and
  `0 errors / 2 warnings` with no diagnostics pipeline behind it.
- **Still open**: the budget is opt-in and the desktop does not set one; OpenRouter's real
  per-request cost is ignored in favour of the static table.

- **8.1 Usage accounting** _(20.1, 20.2)_ — every `llm_response` carries usage; the session total is
  the **sum over events with no independent source**. One source of truth, same as everything else. A
  separate running counter will drift and then you will not know which number is wrong.
- **8.2 Cost guard and router** _(20.3–20.6, 5.10)_ — enforce per-task token and currency budgets
  **inside the loop**. On breach, either downgrade or stop with `run_failed{reason:"budget"}`,
  **deterministically by configuration** — never a heuristic, never a coin flip. Emit
  `budget_exceeded`. Route cheap or mechanical calls to a local or inexpensive model; reserve a
  frontier model for hard calls. Check the budget **before** the call, not after.
- **8.3 Response cache** _(20.7)_ — content-addressed on provider + model + messages + options, stored
  under `.sketch/cache/`. A repeated identical request emits `cache_hit` and issues **no** second
  network call. Include temperature and every option in the key: a cache that ignores an option
  returns wrong answers. This also makes the eval suite and the trainer dramatically cheaper.
- **8.4 Cost Dashboard** _(20.8, 27.1, 14.6)_ — must reconcile **exactly** with the event log. Replace
  the hardcoded `$1.4025` in `StatusBar` and `TaskLog`, and the never-rendered `state.totalCost`. Write
  the reconciliation as a test: dashboard total === sum over events. Not approximately.
- **8.5 Phase 8 gate** — prove an overrun stops or downgrades deterministically, a cache hit avoids the
  second call, and the dashboard equals the log.

Pricing tables go stale. Keep them in one data file with a `pricedAt` date, and show that date in the
UI rather than implying live pricing.

---

### Phase 9 — Memory and hygiene (5 tasks) — **DONE, gated**

The differentiator that compounds. An IDE that remembers *why* a decision was made is a different
product from one that re-derives it every session.

Kept below as the record of what was asked for. What shipped, and where it differs from this brief:

- **Superseding appends a close op.** The brief said "never edits in place"; the consequence is that
  closing a window cannot rewrite the row, so the store appends `{op:'close', …}` and the reader
  folds. Asserted on the bytes, not just through the API.
- **Nine kinds with a `text` payload**, not nine record shapes. Nine shapes would need nine
  retrievers and nine renderers; anything genuinely structured goes in `data`, which nothing indexes.
- **The lint pass reports and supersedes nothing**, and that limit is asserted in the gate rather
  than left implicit. Automatic superseding happens on kind AND key only.
- **Expiry has no default ages** and never touches `source: 'user'`.
- **Retrieval reuses the Phase 5 primitives** via a new `fuseRankedIds`, rather than either copying
  the scoring rule or writing memory out as files to fit `hybridSearch`'s `RepoGraph` signature.
- **The panel shows retracted rows.** Retrieval hides them from a prompt; the panel is the opposite
  case, because a history you cannot see is a history you cannot correct. The control says
  **Retract**, not Delete, and requires a reason.
- **The legacy `ProjectMemory` is bridged, not rewritten**, so the legacy orchestrator gains
  versioning without being modified.
- **Still open**: memory does not reach a live run (the `assembleContext({ memory })` seam is
  unwired, like retrieval's), and nothing writes memory during a run.

- **9.1 Versioned memory store** _(21.1, 21.2, 21.7)_ — persist decisions, architecture, summarised
  conversations, standards, preferences, style, bugs, performance history, test history. **Every row
  carries `valid_from` and `valid_to`.** Keep the existing in-memory implementation as the test double
  behind the same interface. JSONL, append-only, same discipline as the event store — superseding
  writes a new row and closes the old one's `valid_to`; it never edits in place.
- **9.2 Hygiene** _(21.3, 21.4)_ — newer entries supersede older **with a recorded reason** and a
  `memory_superseded` event. Support expiration and a memory-lint pass for contradictions. Without
  this, memory becomes a pile of stale contradictions and actively degrades output — which is worse
  than having no memory, because the model trusts it.
- **9.3 Reranked retrieval** _(21.5)_ — reuse the Phase 5 hybrid path with reranking plus a
  **recency prior**. Emit `memory_retrieved`. Do not build a second retriever.
- **9.4 Memory panel** _(27.1)_ — show entries, their validity window, and what superseded what. Let
  the user delete. Memory the user cannot inspect or correct is memory they cannot trust.
- **9.5 Phase 9 gate** — insert a decision, insert a contradicting decision, prove a related query
  returns the newer one while the older is marked superseded.

---

### Phase 10 — Eval-gated multi-agent (5 tasks)

**Single-agent stays the default.** This is the phase where most products lie, shipping a swarm
because it demos well. The plan forbids that.

- **10.1 Dispatcher** _(24.1–24.3)_ — support `single`, `plan-then-code`, `swarm`. Emit
  `strategy_selected`. Record which strategy succeeded. Escalate **only after** the lighter strategy
  fails within its eval and verify budget.
- **10.2 The thirteen roles as constrained sub-runs** _(24.4–24.6)_ — CEO, Planner, Research,
  Architect, Backend, Frontend, Database, Security, Testing, Reviewer, Performance, Deployment,
  Documentation. Each with **its own verification signal** and the inner loop: goal → memory →
  thinking → action → verification → feedback → retry → consensus. **No role without a distinct
  verification signal.** A role that cannot be checked is a costume, and thirteen costumes is thirteen
  times the cost for none of the benefit.
- **10.3 Deterministic merge and consensus** _(24.7, 24.9)_ — union of verified non-conflicting edits.
  A conflict **creates a new task and is never guessed**. Consensus runs only inside `swarm`.
- **10.4 AI Team and Tasks panels** _(27.1, 27.3, 27.4, 14.6)_ — render real dispatcher events. Replace
  `AgentTeamPanel`'s four function-local fixtures and the twelve never-rendered `state.agentTeam`
  entries, **and make the panel reachable** — no ActivityBar button currently dispatches `agents`.
  Replace `TaskLog`'s `MOCK_TASKS` and its non-functional filter with real task state.
- **10.5 Phase 10 gate** _(24.8)_ — `swarm` becomes the default for a task class **only after measured
  pass@k lift** over `single` on the internal suite. Otherwise it stays off. Write the measurement
  down. If there is no lift, ship it off by default and say so in the README. That honesty is a
  feature.

---

### Phase 11 — Honest benchmarks (6 tasks)

- **11.1** Internal eval suite, scored by the eval harness and the verification contract.
- **11.2** Report task completion rate, build success rate, test pass rate, **manual edits required**,
  time to completion, and cost. Manual-edits-required is the metric users actually feel; do not drop
  it because it is unflattering.
- **11.3** pass@k under a **fixed budget**, including the **distribution**, not only the best case.
  Best-of-k without a budget is not a result, it is a purchase.
- **11.4** Frame public benchmarks as **lift**: `M + Sketch` versus `M + naive`, across several models.
  **Never claim to beat a model.** We are a harness. The claim is that the same model does better
  inside Sketch, and that claim is falsifiable — which is why it is worth making.
- **11.5** A `bench` script producing a report artifact; CI fails on internal-suite **lift
  regression**. This is the mechanism that stops slow decay.
- **11.6** Benchmarks panel, real numbers only.

---

### Phase 12 — Packaging and the open flywheel (6 tasks)

- **12.1 Cross-platform builds** _(26.1)_ — macOS, Windows, Linux, with a documented size budget.
  **Known problem:** the bundled sidecar is **91 MB** and `prd.md` states an installer target under
  100 MB. Those two facts do not fit. Either shrink the sidecar (it is an esbuild bundle of a
  zero-dependency engine — 91 MB is the embedded Node runtime, not our code), ship Node as a
  requirement, or amend the target. Decide explicitly and record it.
- **12.2 Local-first proof** _(26.2)_ — provider forwarding is implemented through both production
  transports, and the source-sidecar preflight requires real loopback Ollama, indexes a fresh
  fixture, runs an edit, and verifies exact bytes with no stub/fake fallback. `OFFLINE-PROOF.md`
  defines the evidence procedure. **Still open:** run the matching native installer on a clean
  offline snapshot, index through the installed UI, review/apply a real Ollama edit, and retain raw
  process-attributed packet/DNS/socket evidence proving no non-loopback attempt.
- **12.3 Open-source scaffolding** _(26.3)_ — `CONTRIBUTING.md` exists. Deterministic three-platform
  release assembly and a tag-only GitHub OIDC provenance path now re-hash installers, bind tag,
  package version, commit, and repository, verify attestations before publication, and preserve the
  marketplace's independent hash, scope, and digest-bound review controls. **Still open:** retain a
  successful real version-tag release and independent verifier output. GitHub provenance is not
  Authenticode or Apple Developer ID signing/notarization; no project-owned native signing identity
  is configured.
- **12.4 Prove the flywheel turns server-less** _(26.4)_ — the production path is now proved with
  a locally authored community-format `skill.json` fixture: digest-bound open-registry review,
  persisted narrower authority, production run, four captured/replayed evals, strict held-out
  improvement, candidate review, explicit promotion, and rerun all work in process with `fetch`
  forbidden and no HTTP/stdio Sketch server. Training writes outside the active skill directory and
  cannot replace it silently. **Still open:** retain a genuine third-party community skill with
  source/license provenance and run those bytes through the same gate; the local fixture is format
  and integration evidence, not community provenance.
- **12.5 Extensibility audit** _(26.5)_ — **complete.** `EXTENSIBILITY.md` maps all nine
  categories to production-consumed contracts. Skills are filesystem-discovered and model ids are
  runtime configuration. Core accepts host-scoped canonical provider, validated MCP catalog,
  memory-store, registered-agent, and explicit versioned-workflow registrations through both
  production transports. Desktop production consumes theme, extension mapping, new-language, and
  declarative Monarch tokenizer registrations. The behavioral gate and guard mutations pass.
  These are host code-registration contracts, not a plugin store or arbitrary executable package
  loader; memory lifetime belongs to the host factory, built-in `single` remains the default, and
  the local MCP script is not evidence for an actual third-party server.
- **12.6 Canonical end-to-end acceptance** _(24.7, 6.4, 4.7, 20.4)_ — **complete.**
  Scripted offline adapters drive a fresh booking project through the engine plan gate, twelve real
  plan documents, real child-process verification, correct-code success and wrong-code unit
  failure, six-role consensus, deterministic non-conflicting merge, conflict refusal with untouched
  bytes and a follow-up task, deterministic budget stop without escalation, and seven final checks
  over five modules. Dispatcher outcome events persist bounded consensus/merge/verify summaries,
  and the Timeline reconstructs plan, verification, swarm, merge, and budget evidence plus terminal
  state from the real event log. This is contract/harness evidence, not proof that a real provider
  can build a booking product; `swarm` remains off by default.

---

### Phase 13 — Documentation reconciliation (5 tasks, runs alongside)

The prior-generation documents contradict the current build in ten places, resolved in `design.md`'s
conflicts table. These tasks make the docs match reality. Do them **at the phase gate that makes each
true**, not in a batch at the end — a doc amended before the code is just a different lie.

- **13.1 `rules.md`** — **complete.** Rule 4 permits roles and consensus only through the
  eval-gated `swarm` strategy, keeps `single` as the default, and keeps `swarm` off without measured
  pass@k lift. Rule 6 now requires the OS credential store through a host outside core, limits key
  transit to purpose-bound credential/invocation channels, and preserves no-log/no-event/no-return
  guarantees.
- **13.2 `what-not-we-are-building.md`** — **complete.** The v1-family curated registry,
  delivered in the v1.5 implementation phase, is explicitly allowed as pinned content-hash
  integrity plus registry-backed discovery/install. Open community publishing remains v2-only
  behind tested integrity and capability scopes, a review queue, exact-digest approvals, and
  separately persisted digest-bound grants. The wording does not claim public-key author signing.
- **13.3 `trd.md` and `architecture.md`** — **complete.** Both documents now record the
  npm workspace, zero-runtime-dependency core, seam-plus-implementation storage/vector/credential/MCP
  boundaries, append-only event and memory JSONL, on-demand `.sketch/` layout, and fixed nine-stage
  verification policy. They preserve the in-memory vector default, date-sharded memory files,
  absent automatic live-run memory ingestion, and lack of third-party/real-provider evidence.
- **13.4 `prd.md`** — **complete.** Cowork and Code are documented as two presentations over one
  client/event/project substrate. Same-model lift, fixed-budget pass@k reliability distributions,
  and strict held-out compounding replace adoption counts as product optimization metrics, with
  external evidence limits stated explicitly.
- **13.5 `tasks-executed.md`** — **complete.** The ledger labels Milestones 1–5 as historical
  snapshots, preserves phase-gate sections as checkpoint evidence, covers all ten design conflicts
  and all five design-authority decisions, and reports reproducible 78/82 actionable-leaf progress.
  Earlier `/96` figures are retained only as explicitly legacy checkpoint counters.

---

## 3. Historical per-task expansion (retained for rationale)

At the time this duplicate planning section was written, 73 tasks remained. It is not current
status; use `tasks.md` and the status section above. The detail remains because it records files,
decisions, and known traps from the implementation checkpoint.

### Phase 3 — Code surface (4 tasks left)

The Code surface currently reaches "project open, **no file open**". That is the headline. Read
§3.1 trap before you plan your order.

---

#### 3.4 — Make Explorer, Terminal, and Search real  ← **DO THIS ONE FIRST**

**Requirements:** 14.4, 14.6, 27.1, 27.3, 27.4

The spec lists 3.2 before 3.4. **Do 3.4 first anyway**, and write down that you did. Reason:
`useFileActions.openPath` has no shipped caller. Nothing in the running application can open a file.
Until `FileExplorer` can open a file, you cannot manually exercise 3.1's editor, and you cannot
manually exercise 3.2's diff review either, because there is no file to diff. Building 3.2 before
3.4 means building a reviewer for a document the user cannot reach.

**Files:**
- `packages/desktop/src/panels/FileExplorer.tsx` — delete `MOCK_TREE`, delete the
  `useState(MOCK_TREE)`, delete `useState('FileExplorer.tsx')` as the fake active file.
- `packages/desktop/src/panels/ide/SearchPanel.tsx` — delete the function-local `mockResults`; the
  search input is currently **uncontrolled**, so wire it to state.
- `packages/desktop/src/panels/ide/Terminal.tsx` — replace static markup with a real input and real
  output from state.
- `packages/desktop/src-tauri/src/main.rs` — `read_dir` already exists and is already contained. Use it.

**How to build the tree, specifically:**

1. **Lazy, not eager.** Call `read_dir` per expanded directory. Do not walk the whole repo on mount.
   A `node_modules` in the project root will hang the UI if you recurse eagerly.
2. **The tree is derived state, not owned state.** Keep a `Map<dirPath, FsEntry[]>` cache plus a
   `Set<dirPath>` of expanded paths. Render the tree from those two. Do not build a mutable nested
   node object and mutate it in place — that is the second-cache mistake 3.1 was written to prevent.
3. **The active file comes from `AppState.activeFile`.** The Explorer does not hold its own idea of
   which file is active. It reads the one owner. This is the same rule as 3.1, applied again.
4. **Clicking a file calls `useFileActions.openPath`.** That function already exists and already
   works. Your job is to give it its first caller, not to reimplement file loading.
5. **Empty states, plural.** "No project open" and "this folder is empty" are different states and
   must read differently. A directory that failed to read is a **third** state and must name the
   error — never render a read failure as an empty folder.

**Terminal, specifically:** it must go through the existing scoped terminal tool
(`run_command` in `main.rs`). That means: program from the allowlist, arguments as a **vector**, cwd
contained in the project root, and the confirmation gate honoured. Be honest in the UI about what
this is — see §4.3 on why the allowlist is not a sandbox.

**Search, specifically:** shell out to `ripgrep` if present, and fall back to a hand-rolled walker if
not. Do **not** add a search library to core. Debounce the input. Cancel the in-flight search when
the query changes, or you will render results for a query the user has already replaced.

**Trap:** the terminal's output area is the most likely place in this whole application to introduce
an XSS-to-RCE chain, because the CSP still carries `script-src 'unsafe-inline'` (§4.4). Render
command output as **text nodes only**. No `dangerouslySetInnerHTML`, not even for ANSI colour. If you
want colour, parse ANSI into styled spans yourself and assert in a test that the parser cannot emit
a tag.

**Done when:** you can click a file in the Explorer and see it in Monaco; type a command and see its
real output; search and get real hits; and three greps come back empty:
`MOCK_TREE`, `mockResults`, `dangerouslySetInnerHTML`.

---

#### 3.2 — Diff review with per-hunk accept and reject

**Requirements:** 16.1, 16.2, 16.3, 16.5

**Files:** a new `packages/desktop/src/diff/` module, plus wherever `edit_proposed` events surface.

1. **The hunk parser belongs in `packages/core`, not the UI.** It is pure, deterministic string work
   and it needs unit tests that do not boot React. Put it in `packages/core/src/diff/hunks.ts`.
2. **Per-hunk accept means you must be able to apply a subset.** Design the data structure for that
   from the start: a hunk is `{ oldStart, oldLines, newStart, newLines, lines }`, and applying a
   selected subset means recomputing offsets as you go. Get this wrong and accepted hunk #3 lands at
   the wrong line because #2 was rejected. **Write the test for "accept hunks 1 and 3, reject 2"
   before you write the applier.**
3. **`edit_accepted` and `edit_rejected` are the only outputs.** Reject carries a reason string. The
   event log is the record of what the human decided — that is what makes the whole system auditable.
4. **Rejecting every hunk must leave the file byte-identical on disk.** Not "rewritten with the same
   content" — untouched. Assert on mtime or on not having called the writer at all.
5. Round-trip property: for any file and any diff, `apply(all hunks) === proposed content` and
   `apply(no hunks) === original content`. Two assertions, enormous coverage.

**Trap:** CRLF. This repo is on Windows and git is converting line endings (you will see the warnings
on commit). A hunk applier that assumes `\n` will corrupt every CRLF file it touches. Detect the
file's dominant line ending, preserve it, and put a CRLF file in the fixtures.

---

#### 3.6 — Mirror the plan gate in the UI

**Requirements:** 16.4, 6.5

Small task, one paragraph of code, but read this: **the UI mirror is defence in depth only.** The
real gate lives in the engine and must stay there. Disable the apply-edit controls until a
`plan_written` event has been observed for that `runId`. Do not add a second source of truth about
whether a plan exists, and do not let the UI's opinion ever be consulted by the engine.

Test it by driving the UI into the enabled state and then asserting the **engine** still refuses
when the plan directory is deleted underneath it. That is the test that proves the mirror is a
mirror.

---

#### 3.7 — Phase 3 gate

Prove, offline: open a file → edit it → run a task → review the diff → accept a hunk → see the
change in `git status`. Plan gate enforced in **both** engine and UI. Cold install (§0.2). Then
commit, update `tasks-executed.md`, and only then start Phase 4.

---

### Phase 4 — Settings, secrets, zero telemetry (4 tasks)

This phase is what makes the product shippable to a stranger. Note task **4.3 is SUPERSEDED** — the
Tauri hardening was pulled forward and completed as 1.16. Do not redo it. The row is kept only so
`4.3` citations elsewhere still resolve.

#### 4.1 — Provider Settings surface
**Requirements:** 17.1, 17.2, 27.1

- Render the **full** provider matrix from the registry, not a hardcoded list. `ModelSelector`'s
  fixture and the never-rendered `state.providers` array both go.
- Allow a custom endpoint. This is the Ollama / llama.cpp / LM Studio path and it is the reason the
  product can be used for $0.
- Per-provider connection test. It must report a **useful** failure: unreachable host, bad key, and
  wrong model name are three different messages.
- Persist to `~/.sketch/providers.json`, **key-free**. Write a test that reads the file back and
  asserts no value in it matches the secret patterns in `packages/core/src/secrets/patterns.ts`.

#### 4.2 — SecretStore and OS credential storage
**Requirements:** 17.3, 17.4

- `SecretStore` (`get`/`set`/`del`) stays in core **with no persisting implementation**. Core must
  not know how secrets are stored. This is what keeps core dependency-free and testable.
- The real implementation is Rust, against the OS credential store. The bridge already *calls*
  `list_providers`, `set_api_key`, `remove_api_key` — **these commands do not exist yet.** That is
  the work.
- Delete the keytar-shaped `KeychainCredentialStore`. It is a dependency-shaped hole in a
  dependency-free package.
- **The key is supplied to the engine at invocation time only.** It never lands in config, never
  lands in an event, never lands in a log line. The redaction path in
  `packages/core/src/events/store.ts` is your safety net, not your policy.

**Trap, and this is the big one for the whole project:** this is the phase where real secrets enter
the system for the first time. Before you write a single line, re-read `events/store.ts` and confirm
`sanitizePayload()` is still called on the **write** path in `emit`. It was silently deleted once.
Add the mutation test to your evidence: remove the call, watch a key hit disk in a test, put it back.

#### 4.4 — Prove zero telemetry
**Requirements:** 17.5, 17.6, 17.8

- `PRIVACY.md` stating exactly what leaves the machine. Exactly. Including the model provider call,
  which *is* network egress and must be named as such.
- A grep test asserting `analytics`, `telemetry`, `sentry`, `posthog` are absent from `packages/**/src`.
- A test asserting a thrown provider error never contains the configured key value. Note the redact
  helper already exists — this test proves it is still wired.

#### 4.5 — Phase 4 gate, v1 complete
Keys only in the OS store. `providers.json` key-free. Grep test clean. A connection test against
`http://localhost:11434/v1` succeeds **with no internet**. Write the `README.md` $0 recipe: fake
adapter for tests, local Ollama for demos, never a paid-only path.

---

### Phase 5 — Intelligent context (6 tasks)

`src/context/` already exists — walker, chunker, dependency-graph, embedder, vector-store,
context-engine — and is **not wired into the loop**. Phase 5 is mostly wiring plus the missing
retrieval quality.

#### 5.1 — Persist the repository graph
Build from the existing modules, persist to `.sketch/index/graph.json`, rebuild **incrementally by
content hash**. `walkProject` has no test coverage today, including for `.gitignore` handling — add
it. An indexer that walks `node_modules` is not a performance problem, it is a broken product.

#### 5.2 — Hybrid search with reranking
**Vector-only retrieval must not be the shipped default.** Add a ripgrep-backed lexical channel,
fuse with reciprocal rank, then rerank. Reason: for code, exact identifier match beats embedding
similarity most of the time, and pure-vector retrieval is the single most common reason an AI coding
tool "can't find" a symbol that is right there.

#### 5.3 — Offline embeddings
Local path, no network. Provider embeddings cached locally as a documented fallback. If you cannot
find a way to do local embeddings without a dependency, the cache-plus-lexical path still has to
work offline — degrade, never fail.

#### 5.4 — Context assembly under a token budget
- Combine memory + skills + top-k chunks + one-hop graph neighbours under a budget.
- **When truncating, keep signatures over bodies.** A model given 40 function signatures does better
  than one given 3 whole functions.
- `ContextEngine.retrieve` currently **computes `expandWithDependencies` and throws the result away.**
  Consume it.
- Emit `context_assembled` with the selected paths and the token estimate. This is what makes context
  debuggable instead of magic.

#### 5.5 — Architecture generator
Seven views (system, API, database, component, dependency, folder tree, call graph) derived from the
graph. **Deterministic for a fixed graph, no network.** Emit `diagram_updated`, render in a Live
Architecture panel. Determinism is the requirement that matters — sort every collection before you
render it, or the diagram churns on every rebuild and the diff is unreadable.

#### 5.6 — Phase 5 gate
On a fixed fifty-file fixture, prove targeted context is **smaller** and **more relevant** than the
whole-repo baseline **and** that the held-out eval score rises. Both. A smaller context that scores
worse is a regression, not an optimisation.

---

### Phase 6 — Skills registry and trainer (7 tasks)

**This is the phase that makes §5 of this document possible.** Read §5 before designing 6.1 and 6.3
— the community skills you will want to install are exactly the adversarial test case for the
registry and the capability scoping.

#### 6.1 — Signed curated registry
Pinned manifest, **content hash per skill**, reject install on mismatch with a tamper diagnostic.
Hash the whole skill directory, not just `SKILL.md` — the scripts are the dangerous part.

#### 6.2 — Seed the registry
Context packing, web/data, general engineering, frontend design, research-stage, finance/quant.

#### 6.3 — Enforce capability scopes
**This is the most security-critical task in the entire remaining plan.** Enforce `capabilities:` at
the tool *and* filesystem layer. A skill without a network capability **cannot** fetch, and the
attempt emits `tool_denied`. Enforcement must be at the boundary, not a check the skill can decline
to make. Test it with a skill that actively tries: `fetch`, `node:https`, a subprocess that curls,
and a file write outside the project.

#### 6.4 — Real Skills surface
Replace `MOCK_SKILLS`, plus the duplicate never-read `state.installedSkills` and
`state.skillMarketplace`. Wire the dead `TOGGLE_SKILL` and `INSTALL_SKILL` reducers.

#### 6.5 — Open marketplace behind the gate
Ships **only after** 6.1 signing and 6.3 scoping are both tested. Not before. This ordering is a
requirement, not a preference.

#### 6.6 — Real optimizer into `proposeEdit`
Replace the stub. **Keep the strict validation gate unchanged.** Add "Train this skill on my
project" running `trainSkill` over captured evals with a train/validation split, behind the cost
guard, off the hot path.

#### 6.7 — Phase 6 gate
Signed install and scope enforcement proven offline. The stub-optimizer trainer improves a seed skill
and rejects a regression. The real-optimizer run in 6.6 is **the one documented exception** in the
entire project that may require an API key.

---

### Phase 7 — Verification contract and MCP (5 tasks)

#### 7.1 — Verify policy, nine ordered stages
format → lint → typecheck → build → unit → integration → security → performance → dependency-audit.
`verify.yaml` at the project root takes precedence; auto-detect per stack when absent (the
node/python/rust/go detector exists — extend it). **Unconfigured stages report skipped without
failing.** A task is `ok` only when every non-skipped stage passed, or none were configured.

#### 7.2 — Live environment feedback
Browser tool plus an application runner capturing console output and runtime errors. **A runtime
error means not done.** A failure to start is a verification failure *with captured output* — never
a silent pass. This is the difference between "the code compiles" and "the app works", and it is one
of the few places a tool like this can be meaningfully better than the competition.

#### 7.3 — Curated isolated MCP registry
**Hand-rolled JSON-RPC over stdio. No SDK dependency.** You have already built a JSON-line protocol
in `src/rpc/` — reuse its shape. Curated, pinned coverage: GitHub, Docker, Figma, Notion, Slack,
terminal, browser, filesystem, SSH, Cloudflare, Supabase, databases, Android emulator, Playwright.

- **Every side-effecting model action routes through the tool layer**, emitting `tool_called` or
  `tool_denied`. No exceptions, no direct calls.
- Per-run and per-capability scoped grants.
- **A hanging server times out, is marked unavailable for the run, and the run continues.** Write
  this test with a server that deliberately never responds. A hang is the most common real-world MCP
  failure and the easiest to get wrong.
- Replace the hardcoded MCP badge and tooltip with real status. Surface failures and retries; do not
  hide them.

#### 7.4 / 7.5 — Test Results panel, then the gate
Gate: broken tests mean not done. A broken running app means not done. A hanging tool cannot hang a run.

---

### Phase 8 — Cost and budget (5 tasks)

#### 8.1 — Usage accounting
Every `llm_response` carries usage. **The session total equals the sum over events, with no
independent source.** One number, one derivation. The moment there are two ways to compute cost, they
will disagree and neither will be trustworthy.

#### 8.2 — Cost guard and router
Enforce per-task token and currency budgets **inside the loop**. On breach: downgrade or stop with
`run_failed{reason:"budget"}`, deterministically by configuration — the same overrun must always
produce the same outcome. Emit `budget_exceeded`. Route mechanical calls to a cheap or local model
and reserve the frontier model for hard calls.

#### 8.3 — Content-addressed response cache
Key on provider + model + messages + options. Store under `.sketch/cache/`. A repeated identical
request emits `cache_hit` and issues **no** second network call. Assert the no-call, not just the hit.

#### 8.4 — Cost Dashboard
Must reconcile **exactly** with the event log. Replace the hardcoded `$1.4025` in `StatusBar` and
`TaskLog`, and the never-rendered `state.totalCost`.

---

### Phase 9 — Memory and hygiene (5 tasks)

#### 9.1 — Versioned memory store
Decisions, architecture, summarized conversations, standards, preferences, style, bugs, performance
history, test history. **Every row carries `valid_from` and `valid_to`.** Keep the existing
in-memory implementation as the test double behind the same interface.

#### 9.2 — Hygiene
Newer supersedes older **with a recorded reason** and a `memory_superseded` event. Expiration.
A memory-lint pass for contradictions. This is the anti-rot mechanism for memory, and it is the
reason this feature is worth building at all — an append-only memory that never retires anything
gets worse over time, not better.

#### 9.3 / 9.4 / 9.5
Reranked retrieval reusing the Phase 5 hybrid path plus a recency prior; emit `memory_retrieved`.
Memory panel. Gate: insert a decision, insert a contradicting decision, prove a related query
returns the newer one and the older is marked superseded.

---

### Phase 10 — Eval-gated multi-agent (5 tasks)

**Single-agent stays the default.** That is the spec's position and it is the right one.

#### 10.1 — Dispatcher
`single`, `plan-then-code`, `swarm`. Emit `strategy_selected`. Record which strategy succeeded.
**Escalate only after the lighter strategy fails within its eval and verify budget.**

#### 10.2 — Thirteen roles as constrained sub-runs
CEO, Planner, Research, Architect, Backend, Frontend, Database, Security, Testing, Reviewer,
Performance, Deployment, Documentation. **No role without a distinct verification signal.** A role
that cannot be checked is theatre, and thirteen of those is thirteen times the cost for none of the
benefit.

#### 10.3 — Deterministic merge and consensus
Union of verified non-conflicting edits. **A conflict creates a new task and is never guessed.**
Consensus runs only inside `swarm`.

#### 10.4 — AI Team and Tasks panels
Real dispatcher events. Replace `AgentTeamPanel`'s four fixtures and the twelve never-rendered
`state.agentTeam` entries, **and make the panel reachable** — no ActivityBar button dispatches
`agents` today. Replace `TaskLog`'s `MOCK_TASKS` and its non-functional filter.

#### 10.5 — Phase 10 gate
`swarm` becomes a default for a task class **only** after measured pass@k lift over `single` on the
internal suite. Otherwise it stays off. Measured, not assumed.

---

### Phase 11 — Honest benchmarks (6 tasks)

11.1 internal eval suite · 11.2 completion rate, build success, test pass, manual edits, time, cost ·
11.3 pass@k under fixed budget **with the distribution, not just best case** · 11.4 frame results as
**lift** (`M + Sketch` vs `M + naive`, across several models — **never claim to beat a model**) ·
11.5 `bench` script producing a report artifact, CI fails on internal-suite lift regression ·
11.6 Benchmarks panel.

§11.4 is a positioning decision as much as a technical one. "We make your model better" is defensible
and verifiable. "We beat GPT-X" is neither.

---

### Phase 12 — Packaging and the open flywheel (6 tasks)

12.1 macOS/Windows/Linux builds with a documented size budget — **note the sidecar is already 91 MB
against a stated <100 MB installer target (§4.5)** · 12.2 prove local-first on a clean offline
machine with Ollama · 12.3 `CONTRIBUTING.md` plus a real version-tag release whose GitHub build
provenance is retained and independently verified (native OS code signing remains a separate,
unconfigured identity) · 12.4 prove a community skill
installs, runs, and trains **with no Sketch server involved** · 12.5 extensibility audit across
providers, agents, skills, tools, models, memory, workflows, themes, languages · 12.6 the canonical
"build an Airbnb clone" end-to-end acceptance with plan gate, verification contract, consensus, and
cost guard all observable in the Timeline.

---

### Phase 13 — Documentation reconciliation (5 tasks, runs alongside)

The prior-generation documents (`rules.md`, `what-not-we-are-building.md`, `trd.md`,
`architecture.md`, `prd.md`) conflicted with this build in ten known places. Tasks 13.1–13.4
reconciled those documents, and **13.5 completed the living-log audit**, including every design
conflict and design-authority decision plus the reproducible actionable-leaf count.

Phase 13 is complete. Continue keeping the ledger current at future evidence gates; do not rewrite
historical checkpoint evidence as if it were current behavior.

---

## 4. Known debts the plan does not own

These are real, they are recorded, and **no task currently covers them**. Each one needs a decision:
adopt it into a phase, or write down why it stays. Do not let them stay invisible.

### 4.1 Two protocol gaps

| Gap | Consequence | Suggested home |
|---|---|---|
| **No `ask` channel.** The loop's `ask` action terminates the run. There is no way for the model to ask the human a question and continue. | The agent cannot ever say "which database are you using?" — it must guess. For a tool whose whole pitch is verified correctness, forced guessing is a design hole. | New task **7.6**, or fold into 3.x as an interactive prompt in the Timeline |
| **No cancellation verb on the wire.** `runTask` accepts an `AbortSignal` the CLI cannot reach. | A user cannot stop a runaway run. Combined with the Phase 8 cost guard being the only backstop, an expensive mistake has no manual brake. | New task, do it **before** Phase 8 |

Both need an `EventKind` decision. **Do not invent an `EventKind` without a spec update.** The
established workaround is to reuse an existing kind with a payload discriminator — the loop already
records a question as `think` with `action: "ask"`, and the trainer records training as `think` with
`component: "skillopt"`. Follow that pattern and report the gap.

### 4.2 ~~The legacy `verifier/` runs with `shell: true`~~ — CLOSED 2026-08-03

`packages/core/src/verifier/` was pre-existing code that spawned with `shell: true`, sitting
alongside `verify/` which correctly uses `shell: false`. Nothing routed untrusted input into it, but
"no caller does that yet" is a fact about a call graph, not a property of the code.

**Resolved by deletion, not by a comment.** The whole directory is gone
(`command-runner.ts`, `detector.ts`, `verifier.ts`, `verify-loop.ts`, `types.ts`, `index.ts`), and so
is the legacy orchestrator state machine that was its only production caller — `orchestrator.ts`,
`planner.ts`, `agent-runner.ts`. That machine was reachable from nothing shipped: not the agent loop,
not the RPC methods, not the CLI, not the desktop, all of which use only
`orchestrator/file-writer.ts` and `orchestrator/json.ts`. `verifier/detector.ts` needed no migration:
`verify/policy.ts` had already reimplemented its node/python/rust/go answers verbatim as part of the
nine-stage extension and never imported it, only cited it in a comment.

**The invariant this established, and how it is held:** `verify-runner.test.ts` walks every `.ts`
file under `packages/core/src/`, strips comments, and fails if any `shell` spawn option is anything
other than the literal `false`. It also asserts the `verifier/` directory no longer exists. A future
Windows-shim problem must be solved by resolving the shim, not by handing a string to a shell.

### 4.3 The terminal allowlist is not a sandbox

`node -e`, `python -c`, and `npm test` all execute arbitrary code **by design**. The allowlist stops
a typo, not an attacker. The real boundaries are: the confirmation gate, the contained cwd, and the
absence of a shell. The code comment was already corrected once to stop claiming a guarantee it does
not provide. **Keep that framing honest in the UI too** when you build 3.4 — do not label it
"sandboxed".

### 4.4 CSP is permissive

`script-src 'unsafe-inline'` and `connect-src http: https:`. Vite dev needs some of this. Production
does not. **Add a task:** separate dev and production CSP, drop `unsafe-inline` in production, and
narrow `connect-src` to the configured provider endpoints plus localhost. Until that lands, treat
every place you render untrusted text as an RCE surface (§3.4 trap).

### 4.5 Installer size

The sidecar alone is 91 MB, gitignored, rebuilt by `npm run build:sidecar`. `prd.md` states an
installer target under 100 MB. **The sidecar nearly exhausts the entire budget before Tauri and the
webview assets are counted.** Decide in 12.1: raise the stated target, or replace the bundled Node
runtime with a smaller one. Do not discover this at release.

### 4.6 Desktop test coverage is thin relative to surface

Every remaining fixture panel is untested, which means replacing a fixture with real data has no
safety net. The `GitPanel.test.tsx` pattern — real repo in a temp dir, real git, plus a source-level
assertion that the fixture is gone — is the pattern to copy. Apply it to every panel you convert.

### 4.7 `GitTool` sits outside the capability dispatcher — **CLOSED 2026-08-03**

**Done.** `packages/core/src/tools/gitDescriptors.ts` exposes the same `GitTool` as six real
`ToolDescriptor`s, from the vocabulary that already existed (`git:read` and `git:write` were both
already in `CAPABILITIES`, both already described, and `commit-context` already declares `git:read` —
nothing was invented):

| Tool | `requires` |
|---|---|
| `git-status`, `git-branch`, `git-diff` | `git:read` |
| `git-stage`, `git-unstage`, `git-commit` | `git:write` |

They are registered alongside the MCP descriptors in the run dispatcher (`rpc/methods.ts`,
`openToolLayerFor`). There is **no second dispatcher and no second grant check**: nothing in
`gitDescriptors.ts` reads `context.granted`, and `guard.ts` still contains exactly one
`grants(this.granted, …)` call, which its own test pins.

**The adversarial suite now bites on a shipped tool.** `capabilities.test.ts` §6 builds a real
repository with `git init`, grants only `git:read`, calls `git-stage` and `git-commit`, and asserts on
the REPOSITORY: commit count unchanged, `git status --porcelain -b` byte-identical, forbidden message
absent from `git log`, `a.ts` still only modified on disk. A positive control granted `git:write`
commits for real, so the denial is not a blanket refusal. Mutation evidence: with
`git-stage`/`git-commit` set to `requires: 'git:read'`, the effect assertion fails with
`0705832 this commit must never exist` in the log.

**What is still synthetic, stated plainly.** §3's six escalations (network ×2, subprocess,
`fs:read:home`, `fs:write:home`, `secrets:read`) are still `ToolDescriptor`s defined inside the test
file, and only `fs:write:home` leaves evidence on disk there. The population behind the gate is now
one audited real tool with an effect-level denial proof, plus `mcp/host.ts` descriptors wrapping
third-party servers this project has neither audited nor executed. Those capabilities have no shipped
tool behind them because no such tool exists yet — `browser`, `terminal` and the rest are later
phases.

**What was deliberately left alone.** `GitTool`'s public methods are unchanged and ungated, so the
`git-*` RPC methods, `GitPanel`, `phase3-gate` and `phase12-acceptance-gate` needed no change at all:
the Source Control panel is a human pressing Stage, and a capability grant describes what a *skill*
was permitted to do autonomously. Two doors, one implementation, a lock only on the agent's.

**`DEFAULT_CAPABILITIES` now includes `git:read` — decided 2026-08-03, one commit later.** The
closing note above said it had *not* been widened, because five assertions pinned the default to
exactly `['fs:read:project']` and moving them to make new code pass would have been the wrong reason
to touch a test. That reason is gone: the user asked for the widening on its own merits, so it is a
product decision with its own change, not a side effect of the descriptor work. `git:read` sits in
the default because a repository's history is the same bytes as the files, one revision back, and a
skill permitted to read `a.ts` but not to ask when `a.ts` last changed is drawing a line users do not
recognise. The default stays read-only in both halves: `fs:write:project` and `git:write` are both
still absent.

What it costs, stated plainly: a skill declaring nothing can now run `git-status`, `git-branch` and
`git-diff` autonomously, so commit messages, author names and branch names are inside the default
grant. The five updated assertions each carry an in-test comment saying why the expected value moved,
so a future reader cannot mistake them for tests loosened to accommodate code. The adversarial suite
still bites: none of §3's six escalations costs `git:read`, so all six are still denied, and a new §6
test takes its grant from `capabilitiesForSkill(undefined)` — the real default path — reads the
repository successfully and is still refused `git-stage` and `git-commit`, with the commit count and
`git status --porcelain -b` unchanged afterwards. Mutation evidence: adding `git:write` to the
default fails that test with `8ca4562 this commit must never exist` in `git log`.

---

## 5. Skills: what to adopt, and exactly how

You asked about [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) and
[last30days-skill](https://github.com/mvanhorn/last30days-skill). Here is the useful finding.

### 5.1 The strategic point

**Sketch already speaks the ecosystem's format.** `packages/core/src/skills/loader.ts` parses
`SKILL.md` with YAML-subset frontmatter (`name`, `description`, `capabilities`) plus a markdown body,
and normalizes a `skill.json` folder layout to the identical `Skill` shape. That is the same
`SKILL.md` convention used by [agentskills.io](https://agentskills.io), Claude Code, Codex, Cursor,
Copilot, and roughly 50 other hosts.

This is a significant, mostly accidental advantage, and it changes the Phase 6 plan:

> **Sketch does not need to invent a skill ecosystem. It needs to be a better host for the one that
> already exists.**

Every skill in `awesome-llm-apps/agent_skills/` is a directory with a `SKILL.md` and scripts. Your
loader can already read them. What is missing is 6.1 (verify what you install), 6.3 (constrain what
it can do), and 6.4 (a real UI). Those three tasks turn an existing loader into a real skill host.

And here is the part no other host has: **Sketch has an eval harness and a trainer with a strict `>`
gate.** Other hosts install a skill and hope. Sketch can install a skill, capture your real runs as
eval cases, and then *measure* whether the skill helps on your project — refusing any change that
does not strictly improve the score. That is the compounding loop the whole product is built around,
and skills are the most natural thing to point it at.

### 5.2 What each reference repo is actually good for

**`awesome-llm-apps/agent_skills/`** — six skills, and its published bar is worth stealing verbatim:
real scripts over token generation, researched references, evidence over vibes, local and private by
default with declared network use, tested before shipped. That list is almost exactly Sketch's own
rules. Adopt it as the acceptance criteria for task **6.2** (seeding the registry).

The individual skills, and why they matter to an IDE:

| Skill | What it does | Why it fits Sketch |
|---|---|---|
| `commit-archaeologist` | Reconstructs *why* a file or region exists from git history: introducing commit, later edits, co-changed files, authorship, intent clues | **Highest value, lowest risk.** Reads local git only — no network capability needed, so it is installable before 6.3 lands. `tools/git.ts` already gives it everything it needs. This is the answer to "why is this code like this", which is the single most expensive question in an unfamiliar repo. |
| `scope-creep-detector` | Checks a diff against its stated intent; flags unrelated files; recommends keep / split / justify | **Pairs directly with 3.2's diff review.** Run it on the agent's own proposed diff before the human reviews it, and the reviewer starts with "this touches 4 files it did not need to". Local-only. |
| `advisor-orchestrator-worker` | Three-tier model team: cheap parallel workers, expensive advisor consulted only at commitment boundaries, verification gates between steps, budgeted | **This is Phase 8.2's router and Phase 10.1's dispatcher, already designed.** Read it before you build either. It is prior art for the exact problem, from someone who has shipped it. |
| `self-improving-agent-skills` | Optimizes skills automatically | **Direct prior art for 6.6.** Compare its acceptance criteria against our strict `>` gate. Ours is stricter; make sure you understand why theirs differs before changing ours. |
| `project-graveyard` | Autopsies abandoned projects from git history | Lower priority, but a genuinely good demo of what a local-git-plus-reasoning skill can do. |
| `thinking-out-loud` | Echoes back what the agent believes it heard, with its guesses quarantined | Relevant to §4.1's missing `ask` channel — a cheap way to surface assumptions without a round trip. |

**`last30days-skill`** — do not treat this as a skill to bundle. Treat it as **the adversarial test
case that proves 6.3 works.** It is the most demanding skill you will find:

- ~20 network sources, browser cookie extraction, OS keychain reads, Python and Node subprocesses,
  writes to `~/Documents/`, an optional SQLite store, and a local HTTP probe on `localhost:18060`.
- Its own README says the right thing out loud: *skills run with your agent's permissions — your
  shell, your files, your credentials. Treat them like software, not documents.*

If Sketch's capability scoping can install that skill and **deny** it network access, **deny** it the
keychain, and **confine** its writes to the project — with each denial emitting `tool_denied` and the
skill degrading rather than crashing — then 6.3 is genuinely done. Nothing weaker proves it.

It is also a working reference for two things Sketch needs anyway: reading credentials from the OS
keychain (Phase 4.2) and degrading gracefully when a source is unavailable (Phase 7.3's
timeout-and-continue rule).

### 5.3 Six more sources worth mining

| Source | Take from it |
|---|---|
| [`vercel-labs/skills`](https://github.com/vercel-labs/skills) — the `npx skills` CLI | The cross-host install convention and the per-host directory map. If Sketch reads `.agents/skills/` and `~/.agents/skills/` in addition to its own dir, every skill in the ecosystem installs into Sketch with **zero** extra work. Cheapest win available. |
| [`anthropics/skills`](https://github.com/anthropics/skills) | The reference `SKILL.md` shape and progressive-disclosure pattern (frontmatter loads always, body loads on demand). Check our loader against it. |
| [`punkpeye/awesome-mcp-servers`](https://github.com/punkpeye/awesome-mcp-servers) | The curated MCP server list for **7.3**. Pin versions and hashes; do not track `latest`. |
| [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers) | Reference implementations for the 7.3 pinned set. Read their stdio framing before you write ours — but still **hand-roll** it, no SDK. |
| [`stanfordnlp/dspy`](https://github.com/stanfordnlp/dspy) | Prompt-optimization prior art for **6.6**. Its train/validation discipline is the same idea as our trainer. Take the ideas; take no dependency. |
| [`openai/evals`](https://github.com/openai/evals), [`princeton-nlp/SWE-bench`](https://github.com/princeton-nlp/SWE-bench) | Eval structure for **11.1**, and SWE-bench harness conventions for **11.4**. Report lift, never a beat-the-model claim. |

### 5.4 Integration: the exact steps

Do these **in order**. Steps 1–2 are safe now. Steps 3 onward need Phase 6 machinery, and installing
a third-party skill before step 5 means running a stranger's scripts with your own permissions.

---

**Step 1 — Widen skill discovery (safe now, ~1 hour)**

Nothing new to design; the loader already handles both formats.

1. In `packages/core/src/skills/loader.ts`, keep `loadSkills(dir)` exactly as it is. Do not touch it.
2. Add a new function beside it:
   ```ts
   export async function loadSkillsFromRoots(roots: string[]): Promise<SkillLoadResult>
   ```
   It calls `loadSkills` per root, concatenates, and **deduplicates by `name`, first root wins**.
   Later roots do not silently shadow earlier ones — record a diagnostic when a name is dropped.
3. Default root order, project-local before global so a repo can pin its own version:
   `<project>/.sketch/skills/`, `<project>/.agents/skills/`, `~/.agents/skills/`, `~/.sketch/skills/`.
4. Tests: two roots each holding a skill → both load. Same name in both → first wins **and** a
   diagnostic names the shadowed file. A missing root → not an error.

**Do not** add `~/.claude/skills/` or `~/.codex/skills/`. Reading another tool's directory silently is
surprising behaviour. Make it opt-in configuration if anyone asks for it.

---

**Step 2 — Vendor two local-only skills as fixtures (safe now, ~2 hours)**

Purpose: give 6.1 and 6.3 something real to be tested against, and give 6.2 two seeds you have
actually read.

1. `git clone` awesome-llm-apps **outside** this repository. Do not add a submodule.
2. **Read every line** of `agent_skills/commit-archaeologist/` and
   `agent_skills/scope-creep-detector/` — `SKILL.md` and every script. You are about to vendor code
   that will run with the user's permissions. Both are local-git-only, which is why these two and not
   the others.
3. Copy each into `packages/core/test/fixtures/skills/<name>/`. **Fixtures, not shipped skills, yet.**
4. Add a test asserting `loadSkills` reads both into the `Skill` shape, that `capabilities` parses,
   and that neither body is empty.
5. Record provenance in `tasks-executed.md`: source repo, commit SHA, license (Apache-2.0), date.
   A vendored file with no recorded origin is a license problem waiting to happen.

**Trap:** these skills' scripts are Python. `packages/core` must not gain a Python dependency. At the
fixture stage nothing executes them — that is the point. Execution waits for the tool layer in 7.3.

---

**Step 3 — Content-hash the registry (task 6.1)**

1. Manifest entry per skill: `{ name, version, source, sha256, capabilities }`.
2. Hash the **whole skill directory**, not just `SKILL.md`. Canonical algorithm, and write it down:
   sort file paths, `sha256` each file's bytes, then `sha256` the concatenation of
   `<relative-path>\0<file-hash>\n`. Path separators normalized to `/`. Text read as **bytes**, never
   as a string — a CRLF conversion must not change the hash.
3. On install: recompute, compare, and on mismatch **refuse** with a diagnostic naming the file whose
   hash differs. Not a warning. A refusal.
4. Test: install succeeds; flip one byte in one script; install fails and names that script.

---

**Step 4 — Declare capabilities honestly (task 6.3, part one)**

Define the vocabulary before you enforce it. Suggested minimum, and keep it small enough that a user
can actually read a grant dialog:

`fs:read:project` · `fs:write:project` · `fs:read:home` · `fs:write:home` · `net:http` ·
`net:localhost` · `proc:spawn` · `secrets:read` · `git:read` · `git:write`

**As built, the default grant is `fs:read:project` + `git:read`** — what a skill gets when its
frontmatter has no `capabilities:` key at all. Read-only on both halves; `fs:write:project` and
`git:write` are never in the default. `capabilities: []`, written deliberately, still means *nothing*.
`git:read` was added to the default on 2026-08-03 by explicit decision (see §4.7 and the decision-log
row in `tasks-executed.md`); before that the default was `fs:read:project` alone.

For each community skill, write down the set it *actually* needs by reading its code, and compare
that to what its frontmatter *claims*. Where they differ, that discrepancy is your best test case —
and worth reporting upstream.

- `commit-archaeologist` → `git:read`, `fs:read:project`. Nothing else.
- `scope-creep-detector` → `git:read`, `fs:read:project`.
- `last30days` → nearly everything, including `secrets:read` and `net:http`. Which is the point.

---

**Step 5 — Enforce at the boundary (task 6.3, part two) — the critical step**

Enforcement must be **structurally impossible to bypass**, not a check the skill can decline to make.

1. A skill's tool calls go through **one** dispatch function. Grants are checked there. There is no
   second path. This mirrors the plan gate (one `hasPlan` call inside `runTask`) and the containment
   primitive (one `resolve_within` in `command_policy.rs`) — the pattern is proven in this codebase
   twice. Follow it a third time.
2. A denied call emits `tool_denied` with the skill name and the capability it lacked, then returns a
   **normal error to the skill**. It does not throw through to kill the run. Skills must be able to
   degrade.
3. Filesystem capabilities route through the existing Rust containment. Do not write a second path
   resolver in TypeScript. There is exactly one `is_within` and one `has_parent_escape` in this
   codebase, and a test asserts that. Keep it that way.
4. **The adversarial test suite.** Write a deliberately hostile fixture skill declaring *no*
   capabilities, which then attempts, each as its own test:
   - `fetch('https://example.com')`
   - `require('node:https').get(...)`
   - `spawn('curl', [...])`
   - `readFile('~/.ssh/id_rsa')`
   - `writeFile('../../escape.txt')`
   - reading `process.env` for anything matching `secrets/patterns.ts`

   All six must be denied, each must emit exactly one `tool_denied`, and the skill must survive all
   six and return a result. **Then break the dispatch check and watch all six pass — that is your
   evidence the tests test something.** Restore it.
5. Only then attempt the `last30days` install. If it installs, runs, and every denial is clean and
   logged, 6.3 is done.

---

**Step 6 — Point the trainer at the skills (task 6.6)**

This is where Sketch stops being another skill host and starts being the only one that measures.

1. Use captured evals (`.sketch/evals/evals.jsonl`) from the user's **own** runs as the training set.
   The capture path already works and already re-scores 1.0.
2. Train/validation split. `proposeEdit` rewrites the skill body.
3. **Strict `>` on the validation score. A tie keeps the incumbent.** No epsilon, no `>=` mode, no
   force-accept flag, no "the user asked for it" override. This is the anti-rot mechanism and it is
   the reason the loop compounds instead of drifting. If you are tempted to relax it, that temptation
   is the failure mode it was built to stop.
4. Behind the cost guard, off the hot path, explicit user action only.
5. Record every accept and reject with both scores. A trainer that cannot show its work is not
   trustworthy.

---

**Step 7 — Ship the surface (task 6.4), then open the market (6.5)**

Real registry data in `SkillsMarketplace`, `MOCK_SKILLS` deleted, `TOGGLE_SKILL` and `INSTALL_SKILL`
wired. The install dialog shows the **declared capabilities and the hash** — a user who cannot see
what a skill is allowed to do cannot consent to it. 6.5 opens the market only after 6.1 and 6.3 are
both tested.

### 5.5 What not to do

- **Do not bundle `last30days` as a shipped skill.** ~20 network sources, browser cookie extraction,
  keychain reads. It is a superb test case and a poor default.
- **Do not add a skill that needs a paid API to the seed set.** It breaks the $0 promise in 4.5.
- **Do not install any skill before step 5.** Skills run with your agent's permissions. Their own
  authors say so.
- **Do not take a dependency to read a skill.** The loader is 300 lines of `node:fs` and it is
  finished. Keep it that way.
- **Do not relax the trainer gate to make a community skill look good.** If a skill does not improve
  the score, the honest outcome is that it does not get adopted.

---

## 6. How this becomes genuinely better than the alternatives

The spec gets Sketch to feature parity with a good AI IDE. This section is about the difference
between parity and a reason to switch. Each item is a proposal, not a committed task — take it to the
spec before you build it.

### 6.1 The three things that are actually differentiated

Everything else in this project is table stakes. These three are not, and they should get
disproportionate care.

**1. Verified-not-plausible.** The nine-stage verification contract (7.1) plus live environment
feedback (7.2) means `done` has a definition. Almost every competitor's `done` means "the model
stopped talking". A runtime error meaning *not done* is a stronger claim than anyone else makes.
→ *Do not compromise 7.2.* It is harder than it looks and it is the most valuable single task left.

**2. It compounds.** Capture-as-eval (done) → the trainer with a strict `>` gate (done) → the real
optimizer (6.6). A tool that measurably gets better on **your** codebase, and provably never worse,
is a category nobody is shipping. The strict `>` is the whole thing. Guard it.

**3. Local-first and auditable.** Zero-dependency core, event-sourced JSONL you can read with `cat`,
keys in the OS store, works offline against Ollama. For anyone with a compliance department this is
not a feature, it is the entry requirement. The `.sketch/` directory being plain text you can inspect
and diff is worth more than it sounds.

The honest framing for all three: **"we make your model better on your code, and we can prove it."**
Not "our agent is smarter."

### 6.2 High-leverage additions, ranked

**A. Cost and latency observability in the Timeline (extends 8.4)**
Every event already carries timing. Show a per-run waterfall: which stage took the time, which call
cost the money, which retry was wasted. Nobody instrument this well, and it is nearly free given the
event log already exists. It also makes 11.2's metrics trivially derivable.

**B. `.sketch/` as a committable team artifact (extends 12.4)**
Plan documents, eval cases, and trained skills are plain files. Commit them and a team shares its
accumulated engineering knowledge through git — no server, no account, no vendor. This is the
flywheel turning across people instead of just across runs, and it is a genuinely novel distribution
model for this category. Requires: a documented merge story for `evals.jsonl` (append-only, so
union-merge; add a `.gitattributes` entry) and a decision about whether the event log is committed
(recommendation: no — it is per-machine and noisy).

**C. Diff review as the primary interaction (extends 3.2)**
Per-hunk accept/reject with the reason recorded in the event log means the human's judgment becomes
training data. Feed rejected hunks and their reasons back into 6.6. The reviewer teaches the tool by
doing the review they were going to do anyway. This may be the single highest-leverage idea in this
document.

**D. Explain-this-code from the graph plus git (needs 5.1, 5.5, and `tools/git.ts`)**
`commit-archaeologist` as a first-class panel rather than a skill: select a region, get its
introducing commit, its co-changed files, its dependency neighbours, and its intent. Every piece is
either built or planned. The assembly is the product.

**E. A real determinism story (extends 5.5, 8.3)**
Fixed seed plus the response cache means a run can be **replayed**. Replayable runs make bug reports
actionable and make 11.x benchmarks credible. Add `sketch replay <runId>` reconstructing a run from
the event log and the cache with no network. Cheap given 8.3, and it is the feature that makes the
event log worth having.

**F. Honest failure surfaces (extends 7.3, 27.5)**
When a tool fails, a server hangs, or a stage is skipped, say so in the UI with the reason. The
industry default is a spinner and then a confident wrong answer. Being the tool that says "the
integration stage was skipped because no command is configured" builds more trust than any benchmark.

### 6.3 Two things to deliberately not build

- **A chat panel as the primary surface.** The spec is right to make the Timeline and the diff review
  primary. Chat is where verification goes to die: it has no structure to attach a gate to. Resist
  the pull.
- **More agents before 10.5's measurement.** Thirteen roles is thirteen times the cost. The gate says
  `swarm` ships for a task class only on measured pass@k lift. Honour it. A swarm that is not measured
  is a bill, not a feature.

---

## 7. The trap list

Every one of these has already happened here, or is one commit away. Read it before each phase.

| # | Trap | How it bites | Defence |
|---|---|---|---|
| T1 | A cancelled or failed agent leaves partial work | A guard call gets deleted and nobody notices. **This happened**: `sanitizePayload` vanished from `emit` and keys hit disk. | `git status` after every interruption. Commit at every green point. |
| T2 | Warm `dist` hides a broken build | Tests pass against a stale artifact. **This happened** at the Phase 1 gate, and **again at `6eced6d`**: the `EventKind` mutation (reverting the repo-graph emitter to `context_loaded`) *passed* the desktop consumer-side gate, because desktop resolves `@sketch/core` through `dist/`. A stale artifact shows you a green gate over a broken contract. | Cold rebuild at every phase gate. Build before **every** desktop run, not just at gates — for that suite `npm run build` is load-bearing, not a formality. |
| T3 | A test asserts against ambient environment it never set | Suite becomes order-dependent and passes for the wrong reason. **This happened** to four provider tests. | Every test sets the env it depends on. Run with `SKETCH_FAKE_PROVIDER` set **and** unset. |
| T4 | `describe.skip` when a precondition is missing | 20 CLI tests vanish silently if you forget to build. | Always build before test. Consider failing loudly instead of skipping. |
| T5 | A second cache for file content | Two sources of truth for what a file contains diverge, and the user loses work. | `AppState.files[path].content` is the only owner. Two functions cross the Monaco boundary. Do not add a third. |
| T6 | Containment logic copied to a second place | One copy gets fixed, the other stays vulnerable. | One `resolve_within` in `command_policy.rs`. A test asserts exactly one `is_within` and one `has_parent_escape`. |
| T7 | A caller-supplied path becomes a CLI flag | `git diff --output=/tmp/pwned` writes anywhere; a `file` starting with `-` becomes an option. **This was a real finding.** | Contain the path, then `--` to terminate option parsing. Both. |
| T8 | Plugin scope mistaken for command scope | `fs.scope` in `tauri.conf.json` constrains `tauri-plugin-fs` only, **not** custom `#[tauri::command]` functions. **This was a real finding** — three fs commands had no validation at all. | Every custom command validates its own paths through `command_policy`. |
| T9 | Redaction moved to the read path | A leak already on disk cannot be un-leaked. | Redact on **write**, in `emit`. Test that the file on disk contains no key. |
| T10 | Trainer gate relaxed | Skills drift and quality rots invisibly. | Strict `>`. A tie keeps the incumbent. No epsilon. No override. |
| T11 | Fixture data left in a shipped panel | The product lies to the user. | A source-level test per panel: `expect(code).not.toMatch(/const MOCK_/)`. |
| T12 | An `EventKind` invented on the spot | The log schema forks and old logs become unreadable. | Reuse an existing kind with a payload discriminator. Report the gap. Update the spec first. |
| T13 | `verify-pass` scoring 1.0 when nothing ran | Every candidate ties, and the trainer gate becomes a coin flip. | `verify-pass` **fails** when nothing was verified. Already implemented — do not "fix" it. |
| T14 | CRLF in a hunk applier or a hash | Corrupted files, or hashes that change on checkout. | Detect and preserve line endings. Hash bytes, never strings. |
| T15 | Recursive eager directory walk | `node_modules` freezes the UI or the indexer. | Lazy expansion. Respect `.gitignore`. |
| T16 | Rendering untrusted output as HTML | With `script-src 'unsafe-inline'`, XSS becomes RCE. | Text nodes only. No `dangerouslySetInnerHTML` in terminal, diff, search, or git output. |
| T17 | Claiming `cargo test` passes | It cannot link on this machine. A false claim hides untested policy code. | `rustc --test src/command_policy.rs`. Say which tool you used. |
| T18 | Reading a skip as a pass | The symlink containment test skips on Windows without Developer Mode. | Count skips separately. Never report a skip as coverage. |
| T19 | A guard with no executing test | The CI lift gate had none: inverting its `<` to `>` left all 1,050 tests green. **This happened** — closed by `17608ce`. | Every guard has a test that fails when the guard is inverted. Run the script as a child process and assert its exit code. |
| T20 | A guard that asserts on a string, not an effect | The mutation changes behaviour while the status label stays identical. Live-feedback's `expect(result.status).toBe('runtime-error')` survives the `ok: false → true` mutation; only the `ok` line catches it. | Assert on effects — bytes on disk, call counts, computed booleans, process outcomes. Treat the effect assertions as load-bearing; never delete them as "redundant" next to a string check. |
| T21 | A guard written against a documented signature the runtime does not use | `net.connect` and `http`'s agent call `Socket.prototype.connect` with a single array `[options, listener]`, so a signature-correct egress guard passes every `node:http` request and Node's `fetch`. **This happened** — closed by `7ce5a58`. | Prove the guard by breaking it against the real call path, not by reading the docs. A convention is not an enforcement. |

**Which of these are actually proven.** Nineteen guards have been broken, watched to fail, restored,
and watched to pass, and every one of them asserts on an effect. The ledger — the per-guard failing
test counts, the exact failure signatures, the three holes closed (`7ce5a58`, `17608ce`, `02ee9c4`),
the caveats, and the explicit not-verified list — lives in
`.kiro/specs/sketch-engineering-os/HANDOFF.md` § "Mutation ledger — proven vs. assumed", current as of
`6eced6d`. Anything absent from that table is assumed, not proven.

---

## 8. Definition of done

### Per task
- [ ] The requirement IDs on the task row are each provably met, not just addressed.
- [ ] `npm run typecheck`, `npm run build`, `npm test` all exit 0, offline, with no API key.
- [ ] Any guard touched was broken, watched to fail, restored, watched to pass — with both outputs pasted.
- [ ] No fixture data remains in any panel the task touched, and a source-level test asserts it.
- [ ] `packages/core/package.json` `dependencies` is still absent or empty.
- [ ] Committed, one task per commit.
- [ ] `tasks.md` checkbox ticked; `tasks-executed.md` row added.

### Per phase gate
- [ ] Everything above, for every task in the phase.
- [ ] Cold install: `node_modules` and `packages/core/dist` deleted, then `npm install && npm run build && npm test`.
- [ ] Suite run twice: `SKETCH_FAKE_PROVIDER=1` and unset.
- [ ] The gate task's specific proof performed and its output recorded.
- [ ] Real-versus-seam status updated for every subsystem the phase touched — §1.2 of this file kept current.
- [ ] Any new debt added to §4 rather than left in someone's head.

### Whole project
- [ ] 82 of 82 actionable leaves. Current state: 78 complete; evidence-gated 12.1–12.4 remain.
- [x] 12.6 canonical scripted acceptance is green: plan gate, verification contract, consensus, and
      cost guard are observable in the Timeline. This is harness evidence, not real-provider proof.
- [ ] Native Windows, macOS, and Linux installers retained within the strict
      **`<100,000,000-byte` per-deliverable** budget (§4.5).
- [ ] Installed-app clean-machine Ollama run retained with process-attributed DNS/socket/packet
      evidence showing no non-loopback attempt.
- [ ] A package-version-matching release tag publishes and independently verifies all native assets
      and GitHub attestations; do not conflate provenance with Authenticode or Apple notarization.
- [x] `PRIVACY.md`, `CONTRIBUTING.md`, the `README.md` $0 recipe, and all five prior-generation
      documents are reconciled.
- [ ] A genuine third-party community skill with retained source/license provenance installs, runs,
      captures evals, trains, and promotes with no Sketch server involved.

---

## 9. Start here

```powershell
# 1. Confirm the committed task-13.5 checkpoint and clean tree.
git status --short
git log --oneline -3

# 2. Read current authority in this order:
#    .kiro/specs/sketch-engineering-os/tasks.md
#    .kiro/specs/sketch-engineering-os/HANDOFF.md
#    tasks-executed.md
#    PACKAGING.md, OFFLINE-PROOF.md, RELEASES.md

# 3. The next actionable work is external evidence-gated task 12.1.
#    Run the native package matrix; do not mark it complete from workflow source alone.
#    After retaining all three installer artifacts and passing size manifests, proceed to 12.2,
#    12.3, and 12.4 using those exact bytes and the documented evidence procedures.

# 4. Before recording a green checkpoint, validate in canonical order in both environments.
npm run build
npm run typecheck
npm test -w @sketch/core
npm test -w @sketch/desktop
$env:SKETCH_FAKE_PROVIDER = "1"
npm test -w @sketch/core
npm test -w @sketch/desktop
Remove-Item Env:SKETCH_FAKE_PROVIDER
```

**If you are ever unsure whether to weaken a check to make progress: don't.** Stop, write down what
is blocking you, and ask. Every serious defect this project has had came from something being
loosened, deleted, or assumed rather than verified. The gates are slow on purpose, and they have
already caught two real security bugs that would otherwise have shipped.
