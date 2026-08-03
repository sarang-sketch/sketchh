# Session Handoff — Sketch

Everything needed to resume. Rewritten at the Phase 5 gate; the previous version described
Phase 3 and had gone four phases stale.

## Where to start reading

1. This file.
2. `.kiro/specs/sketch-engineering-os/tasks.md` — the plan and current checkbox state.
3. `.kiro/specs/sketch-engineering-os/requirements.md` and `design.md` — 28 requirements, the
   resolved-conflicts table, and the canonical contracts.
4. `tasks-executed.md` at the repo root — the project's living log (Rule 9 makes it the single
   source of truth for what is built). It now carries per-phase gate results and a decision log
   through Phase 5.
5. `NEED-TO-DO.md` — the working plan on top of the spec. Where it and the spec disagree, the spec
   wins and `NEED-TO-DO.md` is what gets fixed.

---

## IMMEDIATE NEXT ACTION

**Tasks 12.1–12.4 are the only remaining actionable leaves, and all are external
evidence gates. Run the native package matrix first. Then run the no-fallback Ollama preflight and
retained installed-app clean-machine procedure against those exact installer bytes. For 12.3, push
a package-version-matching semantic tag only after the matrix is green, retain every release
asset/hash/attestation verification result, and do not call GitHub provenance Authenticode or Apple
Developer ID signing/notarization. For 12.4, retain a genuine third-party community skill's source
and license provenance and run its exact bytes through the existing gate. Source tests, workflow
configuration, local fixtures, and documentation complete none of those claims.**

**78 of 82 actionable leaves are complete.** `tasks.md` has 96 raw checkbox rows: 83 leaves and 13
phase summaries. Excluding superseded leaf 4.3 leaves 82 actionable leaves. The normalized raw state
is 90 complete, four evidence-gated leaves, one superseded row, and one open Phase 12 summary.
Phases 1–11 and 13 are complete; Phase 12 remains open only for 12.1–12.4.

Task 13.5 reconciled the living ledger: Milestones 1–5 are labelled historical snapshots, phase-gate
sections remain immutable checkpoint evidence, all ten design conflicts and all five design-authority
decisions are represented in the Decision Log, and old `/96` figures are explicitly legacy counters.
No production behavior changed. Current source verification remains **core 1,036 tests / 54 files,
desktop 503 tests / 54 files**, with build and typecheck green and both suites passing with
`SKETCH_FAKE_PROVIDER` unset and set to `1`. Tasks 12.1–12.4 remain blocked on native artifacts,
installed-app no-egress/Ollama evidence, a verified real tag release, and genuine third-party skill
provenance respectively.

Task 12.1 now has native Windows/NSIS, macOS/DMG, and Ubuntu 22.04/AppImage jobs. Each rebuilds and
smoke-tests its own host-native sidecar, packages with Tauri, enforces a strict `<100,000,000-byte`
installer budget, writes a SHA-256 size manifest, and uploads both. `PACKAGING.md` defines the
measurement and states the unsigned pre-release status. A configured workflow is not build evidence:
12.1 stays open until all three jobs have successful uploaded artifacts.

Task 12.3 now has a deterministic assembler that accepts exactly one passing installer/size manifest
per platform, re-hashes before and after copying, binds package version, tag, commit, and repository,
and atomically emits `release-manifest.json` plus `SHA256SUMS`. The tag-only release job depends on
the complete native matrix, obtains GitHub OIDC build-provenance attestations, verifies every asset,
and only then calls `gh release create --verify-tag`. `RELEASES.md` documents maintainer and consumer
checks. No tag workflow has run, no release exists, and no Authenticode/Developer ID identity exists;
12.3 therefore stays open.

Task 12.4 now has a production in-process gate over a locally authored community-format `skill.json`
fixture. Open-registry digest review precedes install; the approved grant is persisted separately and
bound to active bytes; four successful runs become captured evals; the trainer accepts only a strict
held-out improvement; and promotion is a separate action that refuses capability changes and updates
the active digest. The desktop writes only the candidate artifact during training, renders its real
body, and requires “Use trained version” before activation over either transport. The gate forbids
`fetch` and starts no Sketch HTTP/stdio server. This remains preparation, not completion: no retained
third-party community skill, source provenance, or license evidence has been exercised.

Task 12.5 is complete. `EXTENSIBILITY.md` maps all nine categories to production-consumed
configuration, filesystem-discovery, or host code-registration contracts. Core host registries cover
canonical providers, validated MCP catalog entries, memory stores, registered agents, and explicit
versioned workflows through both transports. Desktop production consumes theme, extension mapping,
new-language, and declarative Monarch tokenizer registrations. The behavioral gate and required
mutations pass. These are host code-registration contracts, not a plugin store or arbitrary
executable package loader. The local MCP script proves the contract path, not actual third-party
server execution or audit evidence.

Task 12.6 is complete. `packages/core/test/phase12-acceptance-gate.test.ts` drives scripted offline
model turns over a fresh real filesystem project and real Node child processes. It proves the engine
plan gate, twelve persisted plan documents, correct-code success and wrong-code unit failure, six
verified swarm roles, deterministic non-conflicting merge, conflict refusal with untouched bytes and
a follow-up task, deterministic budget stop with no heavier-strategy escalation, and seven final
checks over five modules. Dispatcher outcome events now persist bounded consensus, merge, and
verification summaries. `packages/desktop/src/phase12-acceptance-gate.test.tsx` generates events
through the real core and proves the Timeline reconstructs plan, verification, swarm, and budget
evidence plus terminal outcomes from the event log alone. Every model turn is scripted: this is
contract/harness evidence, not evidence that a real provider can build a booking product. `swarm`
remains off by default.

The Phase 11 gate proof is `packages/core/test/phase11-gate.test.ts`. The internal suite has two
content-pinned repair cases, fresh workspaces per attempt, mandatory `verify-pass`, the canonical
verification contract, fixed aggregate call/token/time budgets, pass@1/pass@k plus the full
`0..k` distribution, and strict same-model comparison over the entire budget identity. Reports are
validated and atomically written; the Benchmarks panel only reads the latest validated artifact.

**Phase 11 in one paragraph.** The committed CI result compares `offline-scripted-v1 + Sketch`
with the same scripted model plus `naive`, producing pass@2 lift **1.000** and distribution
`{0:0, 1:0, 2:2}`. This is deterministic **synthetic offline CI evidence** for harness regression,
not evidence about any real provider model. No several-model public matrix has been run. Unknown
cost and unobserved manual edits remain `null`, never zero. Public runs, when deliberately executed,
must remain `M + Sketch` versus the same `M + naive`; no report may say Sketch beats a model.

**Phase 11 limits worth knowing.** The report schema supports one same-model pair at a time and can
be repeated across models, but the public several-model execution remains unperformed. The fixture
suite has two intentionally small repair tasks, so its synthetic lift is a regression sentinel, not
a general capability claim. `npm install` reported five dependency-audit findings (3 moderate,
1 high, 1 critical); no breaking `npm audit fix --force` was run.

The Phase 9 gate proof is `packages/core/test/phase9-gate.test.ts`: record a decision, record the
contradicting one, and prove a RELATED query returns the newer while the older is marked superseded
— plus the join that matters most, that the prompt digest carries the newer and not the older. Four
guards were mutation-verified.

**Two Phase 9 gaps worth knowing.** Memory does **not reach a live run**: `memoryDigest` fills the
`assembleContext({ memory })` seam that has existed since Phase 5 and the `run` RPC does not pass it,
the same shape as retrieval being opt-in behind `contextBudgetTokens`. And **nothing writes memory
during a run** — the loop records no decisions, so the store fills only from the panel or the legacy
orchestrator through `legacyProjectMemory`.

**Previously recurring Windows timing issue, now stabilized.** `verify-live.test.ts`'s
"starts, answers its probe, survives the settle window" check binds a real port. Under full-suite
process pressure, Windows twice retained the listener beyond the old 300 ms post-kill allowance.
Commit `012e109` increases only that allowance to 1,000 ms; the exact assertion that the port is no
longer listening remains unchanged. The test passed 28/28 three consecutive focused runs and both
final full core suites. If it fails again, investigate process cleanup rather than weakening the
closed-port assertion.

The Phase 8 gate proof is `packages/core/test/phase8-gate.test.ts`: an overrun stops
deterministically, a cache hit avoids the second call, and the dashboard equals the log — the
last of those with `toBe`, not `toBeCloseTo`, because both sides are the same function over the
same bytes. Four guards were mutation-verified.

**The bug that gate found**, same green-for-the-wrong-reason shape as Phase 7's two: the pre-call
budget projection compared a ~1 500-token prompt estimate against calls that really cost 250 000
each, so a 600 000-token ceiling was overshot to 750 000 *while the guard reported success*. The
projection now uses the largest call observed in the run. The residual limitation is real and
documented rather than hidden: no pre-flight check can bound the FIRST call, so the guaranteed
bound is the ceiling plus one call.

**Two Phase 8 gaps worth knowing.** The budget is **opt-in** — a run with no `budget` is unbounded
and the desktop does not set one yet. And the prices are a table transcribed on `cost.PRICED_AT`;
what is proved is the arithmetic and that the date travels with every figure, not that any number
is currently right.

**Run `build` BEFORE `typecheck` on a cold tree.** The desktop typecheck resolves `@sketch/core`
through its emitted `.d.ts`, so with `packages/core/dist` deleted it fails with ~43 phantom errors
that have nothing to do with the code. Correct cold order: `install → build → typecheck → test`.

**Run the test suites per workspace** (`npm test -w @sketch/core`, `npm test -w @sketch/desktop`),
not `npx vitest run --root packages/<x>` from the repo root. Several guard tests read source files
relative to the process cwd, so the `--root` form reports ~58 phantom failures that vanish when run
in-workspace. This cost time in this session; it is not a regression.

The Phase 7 gate proof is `packages/core/test/phase7-gate.test.ts`. It proves the three ways this
product can lie about having finished — the model asserting success, the *suite* asserting success
while the app crashes on boot, and the run never finishing at all — against real `node` processes, a
real HTTP server that answers once and then dies, and a real MCP child that handshakes and then goes
silent. The first two share one policy on purpose, because testing them apart misses the bug that
actually shipped in 7.2. Five guards were mutation-verified; see the Phase 7 gate result in
`tasks-executed.md` for failing-test counts.

**Two bugs that gate found**, both worth knowing about because both were "green for the wrong
reason": `McpHost`'s timeouts were dropped when a `launchOverride` was supplied (a hang cost 20 s
instead of 500 ms while the hang assertion passed), and the MCP latch's `tool_denied` was logged
under the host's run id rather than the loop's, making it invisible to `forRun(runId)`.

**The tool layer now exists** (7.3), so the Phase 6 caveat is retired: the capability gate has real
descriptors behind it. What is still *not* proved is anything about the catalogued servers — they are
launch descriptions for third-party packages this project has **not audited**, pinned by version
only. The hang proof uses a server written here to hang.

The Phase 6 gate proof is `packages/core/test/phase6-gate.test.ts`, which runs install → enforce →
train as ONE chain over the shipped registry (the joins are where the failures live). Four guards
were mutation-verified: the digest check, the capability authorisation, the trainer's strict `>`,
and the optimizer's frontmatter strip.

The Phase 5 gate proof is two files:
`packages/core/test/phase5-gate.test.ts` (the fifty-file fixture, the smaller/more-relevant
measurement, the held-out eval comparison, generator determinism) and
`packages/desktop/src/phase5-gate.test.tsx` (a second fifty-file fixture driven through the real
`METHODS` table into real SVG, `<rect>` boxes counted against the generator's own node counts).
Seven guards were mutation-verified at this gate — see the Phase 5 gate result in
`tasks-executed.md` for the failing-test counts.

---

## Git state

```
(Current task 13.5 completion commit containing this file)                       <- HEAD
437d004  sketch: phase 13 task 13.4 - reconcile product metrics
8d45899  sketch: phase 13 task 13.3 - reconcile architecture contracts
27f1e2f  sketch: phase 13 task 13.2 - reconcile marketplace scope
012e109  test: stabilize live app port release check
aa8b274  sketch: phase 13 task 13.1 - reconcile contributor rules
cbd1de5  sketch: phase 12 task 12.6 - canonical acceptance gate
4488ba7  sketch: phase 12 task 12.5 - complete extension registries
87a5889  sketch: phase 12 task 12.5 - add editor extension registries
64f626a  sketch: phase 12 task 12.5 - audit production extensibility honestly
c9947b7  sketch: phase 12 task 12.4 - persist grants and prove local skill flywheel
6df4756  sketch: phase 12 task 12.3 - assemble and attest release provenance
18ede90  sketch: phase 12 task 12.2 - forward provider and add Ollama preflight
4a5de13  sketch: phase 12 task 12.1 - add native packaging matrix
172568e  sketch: phase 11 complete - gate and documentation
c13967d  sketch: phase 11 task 11.6 - read-only benchmark report panel
2a5f0f9  sketch: phase 11 task 11.5 - artifact script and lift regression gate
fc51f5e  sketch: phase 11 tasks 11.1-11.4 - fixed-budget honest benchmark substrate
f7c15aa  sketch: phase 10 complete - tasks ticked, gate result and decisions logged
511df18  sketch: phase 10 task 10.5 - phase 10 gate, swarm stays off with no measured pass@k lift
9d6a9c7  sketch: phase 10 task 10.4 - AI Team and Tasks panels over real dispatcher events
56aa748  sketch: phase 10 tasks 10.1-10.3 - strategy dispatcher, thirteen verifiable roles, merge, pass@k
```

The implementation commits are protected and this file is part of the final gate/docs commit.
**Commit at every green point** — git was initialised 16 tasks late in this project, and in that gap a cancelled sub-agent silently deleted the `sanitizePayload()`
call from `JsonlEventStore.emit`, writing API keys to disk unredacted for an unknown number of
commits. Only a cold rebuild caught it. Uncommitted work is unprotected work.

**One task per commit**, not one phase. The worst incident in this project was invisible precisely
because there was nothing to bisect.

---

## Phase status

| Phase | State |
|---|---|
| 1 — Engine baseline (1.1–1.15) | **DONE**, gate green cold |
| 1.5 — Tauri hardening (1.16, 1.17) | **DONE** — pulled forward from task 4.3 by user decision. Task 4.3 is marked SUPERSEDED in tasks.md |
| 2 — Transports + capture-as-eval (2.1–2.4) | **DONE**, then audited; four defects found and fixed |
| 3 — Code surface (3.1–3.7) | **DONE**, gate green cold |
| 4 — Settings, secrets, zero telemetry (4.1–4.5) | **DONE**, gate green cold. 4.3 superseded |
| 5 — Intelligent context + architecture generator (5.1–5.6) | **DONE**, gate green cold |
| 6 — Skills registry, capability scopes, real optimizer (6.1–6.7) | **DONE**, gate green cold |
| 7 — Verification contract, live feedback, curated MCP (7.1–7.5) | **DONE**, gate green cold |
| 8 — Cost accounting, budget guard, router, cache (8.1–8.5) | **DONE**, gate green cold |
| 9 — Versioned memory with hygiene (9.1–9.5) | **DONE**, gate green cold |
| 10 — Eval-gated multi-agent (10.1–10.5) | **DONE**, gate green. `swarm` ships **off**: no measured strategy lift |
| 11 — Honest benchmarks (11.1–11.6) | **DONE**, gate green cold. CI result is synthetic only; real-provider public matrix unperformed |
| 12 — Packaging and open flywheel | **IN PROGRESS** — 12.1 native artifacts required; 12.2 forwarding/preflight built with installed-app clean-machine evidence required; 12.3 deterministic release/provenance path built with real tag-release evidence and native signing identities absent; 12.4 production flywheel proved with a local community-format fixture, with genuine third-party source/license evidence absent; **12.5 DONE** with production-consumed contracts for all nine categories and behavioral/mutation evidence; **12.6 DONE** with scripted offline canonical acceptance and Timeline evidence, not real-provider capability evidence |
| 13 — Documentation reconciliation | **DONE** — 13.1–13.5 reconciled contributor rules, marketplace scope, architecture contracts, product metrics, and the living-log/decision/counting conventions |

Task counts: **78 of 82 actionable leaves complete**. Raw checkbox state: 90 complete, four
evidence-gated, one superseded, and one open Phase 12 summary.

---

## What is real vs. seam (do not overstate this to the user)

**Real:** the dependency-free core engine; event-sourced JSONL log with write-path redaction; the
seven-action agent loop with the plan gate enforced *in the engine*; shell-less verify runner; eval
harness; SkillOpt trainer with a strict `>` validation gate; stdio JSON-line CLI; `StdioSketchClient`
and `HttpSketchClient` with a Vite dev bridge; capture-as-eval that re-scores 1.0; Monaco editor with
one authoritative file cache; real Explorer, Terminal, Search, Git panel and per-hunk Diff Review;
Tauri hardening; provider settings with a key-free `providers.json` and a real connection test; the
selected key-free provider is forwarded by AgentChat through both production transports into `run`;
OS credential storage in Rust with a presence-only read surface; vendored fonts and a zero-egress guard;
persisted incremental repo graph; hybrid lexical+vector retrieval with RRF and rerank; offline-first
embeddings; budgeted context assembly that degrades detail before coverage; the seven-view
architecture generator and the Live Architecture panel.

**Current limitations / unclosed evidence, with no implied completion:**
- `ask` still terminates a run; the CLI wire still has no cancellation verb even though `runTask`
  accepts an `AbortSignal`.
- Repository retrieval is opt-in through `contextBudgetTokens`, and the desktop does not enable it
  by default. Versioned memory likewise is not automatically ingested from or injected into every
  live run.
- Budgets are enforced when configured, but the desktop does not yet supply a default budget.
- Ghost completions are implemented but off by default.
- Hosted credentials can be persisted by the Rust host and presence can be reported, but no read
  command returns a key; the hosted-key invocation crossing remains intentionally half-wired.
- The curated MCP catalog and local hang/contract scripts are not execution or audit evidence for
  the named third-party MCP packages.
- The legacy `ProviderAdapter`/canonical `ChatAdapter` and legacy `verifier/`/canonical `verify/`
  pairs still coexist; convergence has no owning task.
- Native installers, installed-app Ollama/no-egress proof, a real verified release tag, and genuine
  third-party community-skill provenance remain evidence-gated under 12.1–12.4.

**Nothing has ever run against a real provider.** The production local-provider route is now wired,
but this host has no Ollama installation; every executed adapter test/run still used
`FakeChatAdapter`, synthetic responses, or explicitly labelled loopback stubs.

**That claim is now structural, not conventional.** `packages/core/test/setup/noEgress.ts` is a
vitest setup file wired in `packages/core/vitest.config.ts`, so it is installed for EVERY core test
file. It wraps `fetch` and `net.Socket.prototype.connect` and refuses any destination that is not
loopback, naming the URL/host and the test that attempted it. Loopback stays open on purpose — the
suite depends on it (`verify-live.test.ts`'s real servers, `providerSettings.test.ts`'s real
`node:http` servers and the Ollama-shaped `11434` endpoint shape, the dev bridge). The same guard
file also supplies `isSyntheticProviderIdentity`, which `test/no-egress.test.ts` runs over every
`.sketch/bench` artifact on the machine: a benchmark artifact whose `provider` is not a
synthetic/offline identity fails the suite, so the day a real benchmark is run the documentation
cannot silently go stale. Mocked-`fetch` and injected-`fetchImpl` provider tests are unaffected and
were not touched: replacing `global.fetch` replaces the wrapper, and a mock opens no socket.

---

## Architecture decisions that must not be silently reversed

- `packages/core` has **zero runtime dependencies**. `test/deps.test.ts` enforces it and also
  enforces a `.js` extension on every relative import (NodeNext). It scans source for
  `from '<specifier>'` **literally**, which is why the stopword list in `hybrid-search.ts` is one
  space-separated string rather than an array of quoted words — a list containing `'from', 'into'`
  reads as a bare import and fails the build. Move the data, never the guard.
- The **event log is the single source of truth**. No subsystem gets a private log.
- The **plan gate lives in the engine**: `edit` asks `PlanWriter.hasPlan(runId)` — the filesystem,
  not an in-memory flag — inside `runTask`. The UI mirror is defence in depth only.
- **Strict `>` in the trainer.** A tie keeps the incumbent. No epsilon, no `>=`, no force-accept.
- **`AppState.files[path].content` is authoritative**; the Monaco model is a projection. Exactly two
  functions cross that boundary.
- **Unsupplied plan documents are omitted, not stubbed**, so `hasPlan` never sniffs file bodies.
- **`verify-pass` fails when nothing was verified.**
- Containment lives in **one** place: `src-tauri/src/command_policy.rs`, with `resolve_within` as the
  single primitive.
- **The core suite cannot reach a non-loopback host.** `test/setup/noEgress.ts`, wired as a setup
  file in `packages/core/vitest.config.ts`, is the tripwire under the project's strongest claim. Do
  not remove it, do not add a host to its allowlist, and do not widen it past loopback. A test that
  needs a remote host is a finding to report, not a hole to punch. `test/no-egress.test.ts` asserts
  the wiring itself, so deleting the `setupFiles` line fails the suite.
- **Core cannot persist a secret.** No persisting `SecretStore` implementation exists in core, and
  `MemorySecretStore` has no `node:fs` import. Real storage is Rust-side, with no file fallback.
- **The budget is enforced at one point, before the context text is joined.** Assembling first and
  discovering the overrun afterwards means the request already went out.
- **Retrieved context is separate from `projectContext`.** `AGENTS.md` is a standing instruction the
  user wrote; retrieved text is a retriever's guess for one query, and it is labelled as evidence to
  check rather than as instruction.
- **`termsMatched` is the first lexical sort key.** Coverage of the question beats repetition of one
  word, and without it a sentence-shaped prompt cannot find anything.
- **A view with no evidence gets a reason, not a diagram.** The API view is never inferred from
  import edges; the database view needs a schema file, not a string containing `CREATE TABLE`.
- **No HTML is built from diagram, terminal, search, git or model output.** Every panel renders those
  as text nodes; the CSP still carries `script-src 'unsafe-inline'`, so an injection is an execution.
- Two deliberate duplications, both documented in-code and **neither with an owning phase**:
  `providers/`'s legacy `ProviderAdapter` alongside the canonical `ChatAdapter`, and `verifier/`
  (legacy, `shell: true`) alongside `verify/` (new, `shell: false`). Propose a convergence task
  before touching either.

---

## Spec gaps found and recorded, not absorbed

- No `ask` EventKind — the loop records a question as `think` with an `action: "ask"` discriminator.
- No `skill_trained` EventKind — the trainer uses `think` with `component: "skillopt"`.
- No indexing / retrieval / embedding EventKinds — `repo-graph`, `hybrid-search`, `assembly`,
  `agent-loop`, `embedder` and `architecture` all reuse `context_loaded` / `context_assembled` /
  `diagram_updated` with a `component` discriminator in the payload.
- No CLI cancellation verb — `runTask` accepts an `AbortSignal` the wire cannot reach.

Do not add an EventKind without a spec update; use an existing kind with a payload discriminator and
report the gap.

---

## Open risks

1. **Retrieval reaches no default desktop run yet.** The engine and RPC can assemble it when
   `contextBudgetTokens` is supplied, and the Phase 8 spend guard exists, but the desktop still does
   not opt in. Enabling it needs an explicit product/default-budget decision rather than an old phase
   dependency.
2. **The token estimate is `chars/4`**, stated as such in the payload. It is not a tokenizer count,
   and a provider's real count will differ. Anything that bills off this number is wrong.
3. **The hashing embedder is not semantic search** and says so. Retrieval quality currently rests on
   the lexical channel; a weak vector channel plus a strong lexical one is the honest shape of it.
4. **CSP is permissive**: `script-src 'unsafe-inline'`, `connect-src http: https:`. The egress guard
   fails the build if source starts using that latitude, but the policy itself would not stop it.
5. **Sidecar is 91 MB** (gitignored, rebuilt by `npm run build:sidecar`); `prd.md` targets a <100 MB
   installer.
6. **`cli.test.ts` uses `describe.skip`** when `dist/cli.js` is absent, so 20 tests vanish silently
   if someone tests without building.
7. **`os_credentials.rs` unit tests are unverified on this machine** — the module cannot be compiled
   standalone. Only source-level guards cover it.
8. **26.3 asks for signed releases.** The deterministic GitHub OIDC provenance path is implemented, but no version-tag workflow has run and no release/attestation verifier output exists. Authenticode and Apple Developer ID/notarization identities are not configured.
9. Two competing verify directories and two provider surfaces (see above).
10. ~~**`GitTool` sits outside the capability dispatcher.**~~ **CLOSED 2026-08-03.**
    `packages/core/src/tools/gitDescriptors.ts` exposes the same `GitTool` as six real
    `ToolDescriptor`s behind the one authorisation point: `git-status`, `git-branch` and `git-diff`
    cost `git:read`; `git-stage`, `git-unstage` and `git-commit` cost `git:write`. They are
    registered alongside the MCP descriptors in the run dispatcher (`rpc/methods.ts`,
    `openToolLayerFor`), so there is still exactly one `grants(this.granted, …)` consultation and no
    second dispatcher.

    **What the adversarial suite now covers.** `capabilities.test.ts` §6 drives a REAL repository
    built by `git init` and asserts on the repository, not on the log: a run granted only `git:read`
    calls `git-stage` and `git-commit`, both are refused, and afterwards the commit count is
    unchanged, `git status --porcelain -b` is byte-identical, and the forbidden message is absent
    from `git log`. A positive control with `git:write` granted commits for real, so the denial is
    not a blanket refusal. Mutation-verified: setting `git-stage`/`git-commit` to `requires:
    'git:read'` fails the effect assertion with `0705832 this commit must never exist` in the log.

    **What is still synthetic.** §3's six escalations (network ×2, subprocess, `fs:read:home`,
    `fs:write:home`, `secrets:read`) remain descriptors defined inside the test file; only
    `fs:write:home` leaves evidence on disk there. So the population behind the gate is now: one
    audited real tool with an effect-level denial proof (git), plus `mcp/host.ts` descriptors that
    wrap third-party servers this project has neither audited nor executed. The remaining
    capabilities have no shipped tool behind them because no such tool exists yet.

    **What deliberately did NOT change.** `GitTool`'s public methods stay ungated, and the `git-*`
    RPC methods, `GitPanel`, `phase3-gate` and `phase12-acceptance-gate` were not touched — the
    Source Control panel is a human pressing Stage, and a capability grant describes what a *skill*
    was permitted to do autonomously. Two doors, one implementation, a lock only on the agent's.
    `DEFAULT_CAPABILITIES` was NOT widened to include `git:read`: four existing assertions pin it to
    exactly `['fs:read:project']`, so `git:read` is granted the way it always was — by a skill
    declaring it (`commit-context` does).

---

## Environment quirks that cost time

- **Cold order is `install → build → typecheck → test`.** Typecheck before build fails on missing
  `@sketch/core` types.
- **`cargo test` cannot link here** — missing GNU `dlltool`. Run Rust tests with
  `rustc --test src/command_policy.rs -o <tmp>/policy` and execute. **Do not claim `cargo test`
  passes.**
- **The symlink containment test skips on Windows** without Developer Mode or elevation. It prints
  `SKIPPED …`. A skip is not a pass.
- **PowerShell:** `&&` is not a separator, use `;`. `` `n `` inside single quotes is a literal, not a
  newline — it corrupted `package.json` during a mutation run this session. Interleaved
  `Write-Output` piped through `Select-String` gets swallowed; run each check as its own invocation
  and read each exit code.
- **Sub-agent dispatch fails on large prompts.** Keep briefs compact, and after any failed dispatch
  run `git status` — partial work has landed before.
- **Task-tool quirks:** task IDs must be numeric dotted (`1.16`, not `1.5h`), and a child of an
  already-completed parent cannot be marked `in_progress`.
- Tests must pass with `SKETCH_FAKE_PROVIDER` **both set and unset**.

---

## Verification ritual before declaring anything done

```powershell
npm run build
npm run typecheck
npm test -w @sketch/core
npm test -w @sketch/desktop
```

Run the two workspace suites again with `SKETCH_FAKE_PROVIDER=1`; the unset environment is the first
pass. For a phase gate, delete `node_modules` and `packages/core/dist`, then run `npm install` and the
same canonical sequence from cold. The Phase 1 gate found a real security regression that a warm
tree hid.

**Green output alone is not evidence.** Break each guard, watch it fail, restore it, watch it pass,
and record both. Run the `sanitizePayload` mutation at **every** gate — that is the regression that
actually happened.
