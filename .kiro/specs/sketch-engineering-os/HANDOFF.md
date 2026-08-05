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

**Tasks 12.2 and 12.3 are the only remaining actionable leaves, and both are external evidence gates.
The native matrix is done: run `30936156941` supplies verified Windows/NSIS, macOS/DMG, and
Linux/DEB installers whose bytes and SHA-256 match their size manifests. Next, run the no-fallback
Ollama preflight and the retained installed-app clean-machine procedure against those exact
installer bytes. For 12.3, push a
package-version-matching semantic tag only after the matrix is green, retain every release
asset/hash/attestation verification result, and do not call GitHub provenance Authenticode or Apple
Developer ID signing/notarization. Source tests, workflow configuration, local fixtures, and
documentation complete none of those claims.**

**80 of 82 actionable leaves are complete.** `tasks.md` has 96 raw checkbox rows: 83 leaves and 13
phase summaries. Excluding superseded leaf 4.3 leaves 82 actionable leaves. The normalized raw state
is 92 complete, two evidence-gated leaves, one superseded row, and one open Phase 12 summary.
Phases 1–11 and 13 are complete; Phase 12 remains open only for 12.2 and 12.3.

Task 13.5 reconciled the living ledger at its historical checkpoint: Milestones 1–5 are labelled
historical snapshots, phase-gate sections remain immutable checkpoint evidence, all ten design
conflicts and all five design-authority decisions are represented in the Decision Log, and old
`/96` figures are explicitly legacy counters. Task 12.4 subsequently completed at `ff99c43`; the
latest validated implementation checkpoint is `d815196`. Current independent source verification is
**build 0, typecheck 0, core 1,059 tests / 55 files, and desktop 511 tests / 55 files**, with both
suites passing with `SKETCH_FAKE_PROVIDER` unset and set to `1`. The Windows symlink branch printed
`SKIPPED` and is not claimed. Tasks 12.2 and 12.3 remain blocked on installed-app no-egress/Ollama
evidence and a verified real tag release respectively.

Task 12.1 is complete. Native Windows/NSIS, macOS/DMG, and Ubuntu 22.04/DEB jobs each rebuild and
smoke-test their own host-native sidecar, package with Tauri, enforce a strict `<100,000,000-byte`
installer budget, write a SHA-256 size manifest, and upload both. Run `30936156941` at
`642b70ae8d9a360e8bbdb3940907df2a0aa9955f` concluded `success`, and its three uploaded installers
were re-measured to 25,236,326, 40,239,845, and 48,572,918 bytes with digests equal to their
manifests. `PACKAGING.md` records those measurements and the unsigned pre-release status.

Task 12.2's source-sidecar preflight now refuses hostname aliases such as `localhost` and accepts
only numeric IPv4/IPv6 loopback endpoints before contacting Ollama. Re-allowing `localhost` made the
focused endpoint guard fall through to a real network attempt and fail 1/2; restoration passed 2/2.
This remains preflight hardening, not installed-app or no-egress evidence, so 12.2 stays open.

Task 12.3 now has a deterministic assembler that accepts exactly one passing installer/size manifest
per platform, binds parsing, hashing, and emission to one captured manifest buffer, re-hashes
installer bytes before and after copying, and binds root npm, desktop npm, Tauri, Cargo, tag, commit,
and repository identity. The tag-only release job depends on both the complete native matrix and the
canonical build/typecheck/provider-environment/benchmark/marketplace gates, obtains GitHub OIDC
build-provenance attestations, verifies every asset, and only then calls
`gh release create --verify-tag`. `RELEASES.md` documents maintainer and consumer checks. No tag
workflow has run, no release exists, and no Authenticode/Developer ID identity exists; 12.3 therefore
stays open.

Task 12.4 is complete at `ff99c43`. The retained input is the exact canonical Git blob bytes from
third-party [`dotcomjack/parallel-agents-skill`](https://github.com/dotcomjack/parallel-agents-skill)
commit `f26435da141df656eaed219dc23da776f46d9320`, including the complete MIT license. The open review
binds `sha256:af752a5b04e93791b1635d04fd3ab4272facc2d2ae5aea1fe84411ce9331fb3e` and grants zero
capabilities. The production path installs and runs those bytes, captures and replays four evals,
accepts only a strict held-out scripted 0→1 training improvement, refuses a capability-widening
candidate, requires explicit promotion, and performs the final replay with `fetch=0` and no listening
Sketch HTTP/stdio server.

Candidate selection was fail-closed: `last30days` was rejected because it required network,
subprocess, secrets, and home-directory capabilities; the Vercel React skill was rejected because no
complete retained license text accompanied it. A Windows CRLF checkout initially produced a
nonportable digest, so the committed proof retains raw Git blobs and uses narrow `eol=lf`
`.gitattributes` rules. Appending ` MUTATION` to the retained LICENSE copyright made the focused gate
fail with `LICENSE: expected 1076 to be 1067`; restoring the byte passed 1/1. This is genuine
third-party-byte flywheel evidence, not evidence of organic skill quality or any real provider.

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

The list below starts at the latest validated implementation checkpoint. Later documentation-only
ledger commits are intentionally omitted so this handoff does not embed a self-invalidating `HEAD`
claim.

```
d815196  fix: require numeric loopback for Ollama preflight
06944cf  fix: bind releases to native package versions
0c76131  fix: bind release manifests to validated bytes
ce366dd  ci: gate release publication on canonical checks
03a1ab3  test: fail loudly when CLI build artifact is missing
ff99c43  sketch: phase 12 task 12.4 - prove third-party skill flywheel
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
| 12 — Packaging and open flywheel | **IN PROGRESS** — **12.1 DONE** with run `30936156941` native Windows/macOS/Linux installers re-measured against their size manifests, unsigned; 12.2 forwarding/preflight built with installed-app clean-machine evidence required; 12.3 deterministic release/provenance path built with real tag-release evidence and native signing identities absent; **12.4 DONE** with exact licensed third-party Git blob bytes, digest-bound zero-capability review, production flywheel, and mutation evidence, not organic-quality or real-provider evidence; **12.5 DONE** with production-consumed contracts for all nine categories and behavioral/mutation evidence; **12.6 DONE** with scripted offline canonical acceptance and Timeline evidence, not real-provider capability evidence |
| 13 — Documentation reconciliation | **DONE** — 13.1–13.5 reconciled contributor rules, marketplace scope, architecture contracts, product metrics, and the living-log/decision/counting conventions |

Task counts: **80 of 82 actionable leaves complete**. Raw checkbox state: 92 complete, two
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
- `ask` now has a reply channel. It is OPT-IN (`params.interactive`): absent, a question still ends
  the run with `reason: "awaiting_human_input"`, which is what the eval harness and every CLI caller
  need. With it, the run pauses, `reply` delivers the answer, `ask_answered` records it, and the loop
  continues. The wait is bounded at ten minutes and an abort ends it, so an abandoned question cannot
  hold the engine open. `ask_answered` was added to `EventKind` with the requirements and design
  amendments in the same change; the union is now thirty-one kinds.
- Cancellation IS now wired: the `cancel` method aborts an in-flight run by id, the caller may supply
  that id so a Stop control works before `run_started` arrives, and the run emits its own
  `run_failed{reason:"aborted"}`. The chat panel's send control becomes Stop while a run is live.
- Repository retrieval stays opt-in through `contextBudgetTokens` in the engine; the desktop now
  supplies a default from `DESKTOP_RUN_DEFAULTS`.
- Memory can now be WRITTEN from a finished run through `params.rememberRun`, which files the run's
  verification outcome and its on-disk plan, both `source: 'run'` and both keyed so a later run
  supersedes rather than accumulating. Deliberately narrow: no model call, no summarising, no `bug`
  or `architecture` entries, because those would require judgement this path is not entitled to make.
  Still open: nothing INJECTS memory into a live run (the `assembleContext({ memory })` seam is still
  unpassed by the `run` method), the desktop does not yet set `rememberRun`, and the dispatcher path
  does not ingest because a `DispatchResult` carries a dispatch id rather than a run id.
- Budgets are enforced when configured, the `run` method now carries a strictly validated `budget`,
  and the desktop supplies a default ceiling. There is no UI yet for changing that ceiling.
- Ghost completions are implemented but off by default.
- Hosted credentials are persisted by the Rust host, and `resolve_api_key` now resolves ONE stored
  key per run so a saved key reaches the engine at invocation time (Requirement 17.4). That value
  crosses the IPC boundary into the webview, which is a deliberate, documented concession over
  presence-only: it is one validated id per call, stateless, non-enumerating, redacted by the engine
  on arrival, and never placed in application state. Spawning the sidecar from Rust so the value
  never enters the webview remains the better end state and is unowned.
- The curated MCP catalog and local hang/contract scripts are not execution or audit evidence for
  the named third-party MCP packages.
- The legacy `ProviderAdapter`/canonical `ChatAdapter` pair still coexists; convergence has no owning
  task. The legacy `verifier/`/canonical `verify/` pair does NOT — `verifier/` was deleted
  2026-08-03 and a source-level guard now forbids `shell: true` anywhere in `packages/core/src/`.
- Installed-app Ollama/no-egress proof and a real verified release tag remain evidence-gated under
  12.2 and 12.3; native installers are now retained and verified. Task 12.4's licensed third-party bytes close the community
  provenance gate, but do not establish organic skill quality or real-provider performance.

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
- **There is exactly ONE verify path, and it never spawns through a shell.** The legacy
  `packages/core/src/verifier/` — a four-check aggregate over a `shell: true` command runner — was
  **DELETED 2026-08-03**, along with the legacy orchestrator state machine (`orchestrator.ts`,
  `planner.ts`, `agent-runner.ts`) that was its only production caller and was itself unreachable
  from the agent loop, the RPC methods, the CLI and the desktop. `verify/` is the whole surface:
  `shell: false`, per-command timeout, SIGKILL on expiry. `verify-runner.test.ts` now asserts that
  **no `shell: true` exists anywhere under `packages/core/src/`** and that every `shell` option is
  spelled `false` out loud. Do not reintroduce one; if a Windows shim needs resolving, resolve the
  shim. What survives of `orchestrator/` is `file-writer.ts`, `json.ts` and the `FileEdit` type,
  all genuinely shared with `loop/`, `strategy/` and `rpc/`.
- One deliberate duplication remains, documented in-code and with **no owning phase**: `providers/`'s
  legacy `ProviderAdapter` alongside the canonical `ChatAdapter`. Propose a convergence task before
  touching it. `ProjectMemory`/`legacyProjectMemory` also survives as published API with no in-repo
  caller now that the legacy orchestrator is gone — retiring it is a breaking-change decision.

---

## Spec gaps found and recorded, not absorbed

- ~~No `ask` EventKind~~ — **CLOSED** by the `EventKind` amendment (see design.md, "Core contracts").
- ~~No `skill_trained` EventKind~~ — **CLOSED** by the same amendment.
- ~~No indexing / retrieval / embedding EventKinds~~ — **CLOSED** for indexing (`repo_indexed`),
  retrieval (`context_retrieved`) and embedding (`embedder_degraded`). The cost router also moved off
  `strategy_selected` onto `model_selected`. `assembly` and `agent-loop` deliberately still share
  `context_assembled` behind `component`, `mcp` and `registry` still share `tool_called` /
  `tool_denied`, and `architecture` keeps its `component` key on `diagram_updated` — those are one
  fact from more than one place, which is what a discriminator is for.
- No CLI cancellation verb — `runTask` accepts an `AbortSignal` the wire cannot reach.

The rule is unchanged: **do not add an EventKind without a spec update.** Use an existing kind with a
payload discriminator and report the gap. When the accumulated gap is worth fixing, amend
requirements.md 3.1 and design.md's "Core contracts" section IN THE SAME CHANGE as types.ts, migrate
every emitter and every consumer, and add a consumer-side test per new kind — a UI that silently stops
matching fails nothing on its own (`packages/desktop/src/eventKinds-gate.test.tsx`).

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
6. ~~**`cli.test.ts` uses `describe.skip` when `dist/cli.js` is absent, so 20 tests vanish
   silently.**~~ **CLOSED at `03a1ab3`.** Missing `dist/cli.js` now aborts the suite with
   `CLI BUILD PRECONDITION FAILED: ... real-pipe protocol coverage must not be skipped.` The
   precondition mutation (delete generated `packages/core/dist`) failed the focused CLI run as
   1 suite / 0 tests with that named cause; rebuilding restored 38/38. Build before test remains a
   requirement because these are real-pipe tests over the generated CLI, not source-only tests.
7. **`os_credentials.rs` unit tests are unverified on this machine** — the module cannot be compiled
   standalone. Only source-level guards cover it.
8. **26.3 asks for signed releases.** The deterministic GitHub OIDC provenance path is implemented, but no version-tag workflow has run and no release/attestation verifier output exists. Authenticode and Apple Developer ID/notarization identities are not configured.
9. ~~**Two competing verify directories** (`verifier/` with `shell: true` beside `verify/` with
   `shell: false`).~~ **CLOSED 2026-08-03.** `packages/core/src/verifier/` is deleted, together with
   the legacy orchestrator state machine that was its only production caller and was itself
   unreachable from every shipped path. `verify/` is the sole verify surface, and
   `verify-runner.test.ts` asserts no `shell: true` exists anywhere under `packages/core/src/`.
   **Still open:** two provider surfaces (`ProviderAdapter` beside `ChatAdapter`), and the
   `ProjectMemory` legacy surface that now has no in-repo caller.
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

    **`DEFAULT_CAPABILITIES` DOES include `git:read` — decided 2026-08-03.** The earlier note here
    said it did not, and that was accurate at the time: five assertions pinned the default to exactly
    `['fs:read:project']`, and moving them so the descriptor commit could pass would have been editing
    tests to make code green. The user then asked for the widening on its own merits, so it landed as
    its own change with its own rationale. `DEFAULT_CAPABILITIES` is now
    `['fs:read:project', 'git:read']`. Reading a repository is part of reading a project — the files
    are one revision of the same bytes. The default remains read-only in both halves:
    `fs:write:project` and `git:write` are absent, and `capabilities: []` still means nothing.

    **The adversarial suite still bites.** §3's six escalations cost `net:http` ×2, `proc:spawn`,
    `fs:read:home`, `fs:write:home` and `secrets:read`; not one costs `git:read`, so widening the
    default permits none of them and all six remain denied. §6 gained an effect-level proof of the new
    boundary: a dispatcher whose grant comes from `capabilitiesForSkill(undefined)` — the real default
    path — reads a real repository (`git-status`, `git-branch` succeed) and is still refused
    `git-stage` and `git-commit`, with commit count and `git status --porcelain -b` byte-identical
    afterwards. Mutation-verified: adding `git:write` to the default fails it with
    `8ca4562 this commit must never exist` in `git log`.

    **The five assertions that moved**, each carrying an in-test comment saying why so nobody reads
    them as loosened: the `DEFAULT_CAPABILITIES` equality and the hostile-skill default-grant equality
    in `capabilities.test.ts`, and three copies of the run-dispatcher log line, which went from
    `mcp: 0 server(s) open, 0 tool(s) reachable with fs:read:project` to
    `mcp: 0 server(s) open, 3 tool(s) reachable with fs:read:project, git:read` — two in `mcp.test.ts`
    and one in `phase12-extensibility-gate.test.ts`. The three tools are the engine's own read-only
    git descriptors; `0 server(s) open`, which is what those tests exist to assert, did not move.

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
---

## Mutation ledger — proven vs. assumed (current as of `d815196`)

This is the running record of every guard that has been broken, watched to fail, restored, and
watched to pass green — **twenty-five** of them. It says which guards are **mutation-proven** and
whether they assert on an **EFFECT** (state on disk, a call count, a computed boolean, a process
outcome, rendered DOM) or only on **STRUCTURE** (source/workflow shape). Anything not in the table
has not been mutation-tested; treat it as assumed. Structural guards prove fail-closed wiring but do
not substitute for the external execution they describe. Read with `NEED-TO-DO.md` §7 (traps) and
the verification ritual above.

**How to keep this current.** Append new guards as new numbered rows and never renumber existing
ones — the numbers are cited from `NEED-TO-DO.md` §7 and from in-test comments. If a commit widens an
existing guard rather than adding one, extend that row instead of adding a duplicate. Then move the
hash in this heading, the tree line below, and the count in the paragraph above. Rows 1–16 come from
the dedicated verification session that ended at `f2e2fd4`; rows 17–25 landed with the commits named
in their rows.

Tree at the time: `d815196`, clean — build and typecheck exit 0; core 1,059 tests / 55 files and
desktop 511 / 55 pass with `SKETCH_FAKE_PROVIDER` unset and set to `1`. The Windows symlink branch
printed `SKIPPED` and is not claimed as passing coverage.

### Mutation-proven guards

| # | Guard | Mutation | What broke | Asserts on |
|---|---|---|---|---|
| 1 | Zero runtime dependencies in core | add a dependency | `test/deps.test.ts`: `expected ['left-pad'] to deeply equal []` | **EFFECT** (package manifest bytes) |
| 2 | Plan gate in the engine | bypass `PlanWriter.hasPlan(runId)` in `runTask` | `test/loop.test.ts`, 2 tests: `edit_rejected` absent **and** the file was written | **EFFECT** (event absence + filesystem) |
| 3 | Plan-gate UI mirror is run-scoped | make it unconditional | 6 tests across 3 desktop files | **EFFECT** |
| 4 | Trainer's strict `>` validation gate | `>` → `>=` | 5 tests / 2 files, **plus all three degenerate-input tests** — `meanScore([]) === 0` together with strict `>` is what makes an empty validation split safe. One of the failures asserts on the **deployed artifact's bytes**. | **EFFECT** |
| 5 | Capability scoping | neuter the single `grants()` consultation | 12 tests / 5 files | **EFFECT** |
| 6 | Budget guard | remove the pre-call projection stop | 3 tests / 2 files; the Phase 8 gate failure bills a real third model call | **EFFECT** (call actually made) |
| 7 | Secret redaction on the event **write** path | drop `sanitizePayload()` from `emit` | `test/store.test.ts`, 3 tests; `sk-live-…` lands on disk verbatim in four places inside one JSONL line | **EFFECT** (bytes on disk) |
| 8 | Hunk subset offsets | `oldStart` → `newStart` | `test/diff.test.ts`, 7 tests | **EFFECT** (resulting file content) |
| 9 | Memory supersession | `supersedeSameKey ?? false` | 6 tests / 2 files; live entry **sets** compared by deep equality | **EFFECT** |
| 10 | A merge conflict is never guessed | off-by-one in the overlap check | 4 tests / 3 files; the collided file's bytes on disk are asserted unchanged and the follow-up task object is asserted | **EFFECT** |
| 11 | Bench lift comparison | `> 0` → `>= 0` | 2 tests | **EFFECT** (computed comparison) |
| 12 | Nine-stage verify policy | invert the ok-computation / the skip logic | 4 tests on the ok-computation, 9 on the skip logic; assertions are on `result.ok` and `verifiedAnything` | **EFFECT** (computed booleans) |
| 13 | MCP hang-and-continue | remove the request deadline | 6 tests, driven by **real child processes that genuinely never answer** | **EFFECT** — see caveat |
| 14 | Live environment feedback | `ok: false` → `ok: true` | 4 tests / 2 files against **real HTTP servers on real ports** | **EFFECT** — see caveat, the `status` strings are not the guard |
| 15 | Response cache makes no second call | disable the cache hit | 8 tests / 2 files asserting the **adapter call count** (`expected 3 to be 1`); `phase8-gate` additionally uses an adapter whose `chat` throws if reached | **EFFECT** (call count) |
| 16 | `GitTool` behind the capability gate, **and the widened `DEFAULT_CAPABILITIES`** (`f2e2fd4`, extended by `e355bff`) | (a) `git-stage`/`git-commit` → `requires: 'git:read'`; (b) add `git:write` to `DEFAULT_CAPABILITIES` | (a) 2 tests; (b) the §6 default-path test. Both fail with a commit that must not exist in `git log` — `0705832 …` for (a), `8ca4562 …` for (b) | **EFFECT** (real repository state) |
| 17 | No `shell: true` anywhere under `packages/core/src`, and every `shell` spawn option spelled literally `false` (`e122bea`, deleting the legacy `verifier/`) | a **NEW** file `src/mutation-probe.ts` containing `spawn(cmd, { shell: true })` | `test/verify-runner.test.ts`: `… Offending sites: mutation-probe.ts: shell: true` | **EFFECT** (source text of the shipped package) |
| 18 | One lexical match dialect, two callers (`e4e8b34`, converging the two search implementations) | shift `matchSpans`'s span offset by one | 4 tests in **both packages at once** — 3 in `packages/core/test/project-search.test.ts`, 1 in `packages/desktop/src/panels/ide/SearchPanel.test.tsx` | **EFFECT** (rendered highlight offsets and ranked hits) |
| 19 | Consumer-side rendering of every `EventKind` (`6eced6d`, six explicit kinds) | revert the repo-graph emitter to `context_loaded` | `packages/desktop/src/eventKinds-gate.test.tsx`: `Unable to find an element with the text: repo_indexed` | **EFFECT** (rendered DOM) |
| 20 | Exact retained third-party Git blob bytes and complete MIT license (`ff99c43`) | append ` MUTATION` to the retained LICENSE copyright | focused third-party flywheel gate failed: `LICENSE: expected 1076 to be 1067`; restore passed 1/1 | **EFFECT** (retained vendor/license bytes) |
| 21 | Real-pipe CLI coverage requires the generated CLI artifact (`03a1ab3`) | delete generated `packages/core/dist` before the focused CLI suite | focused suite exited nonzero before collection: 1 suite failed / 0 tests, caused by `CLI BUILD PRECONDITION FAILED: ... real-pipe protocol coverage must not be skipped.`; rebuild restored 38/38 | **EFFECT** (suite exit nonzero / missing artifact) |
| 22 | Release publication depends on canonical release gates (`ce366dd`) | restore the real defect, `needs: package`, while retaining the new policy test | focused packaging/release run failed 1/9 on the missing `needs: [package, release-gates]`; repair passed 9/9 | **STRUCTURE** (workflow job graph; no GitHub run claimed) |
| 23 | Size-manifest policy fields, digest, and emitted bytes share one captured buffer (`0c76131`) | replace the captured-buffer write with `copyFile(row.manifestPath, ...)` | focused release suite failed 1/7 on the forbidden mutable-path reread; restoration passed 7/7 | **STRUCTURE + normal-path EFFECT** (emitted bytes equal captured bytes; the concurrent race itself was not dynamically induced) |
| 24 | Release tag identity includes root npm, desktop npm, Tauri, and Cargo versions (`06944cf`) | change only `tauri.conf.json` from `0.1.0` to `9.9.9` | focused release suite failed 6/7 with `root version 0.1.0 does not match Tauri package version 9.9.9`; restoration passed 7/7 | **EFFECT** (assembler process refuses before output) |
| 25 | Real-Ollama preflight accepts only numeric loopback (`d815196`) | re-allow the unresolved `localhost` alias | focused endpoint guard failed 1/2 because validation reached `fetch` and reported `real Ollama is unavailable`; restoration passed 2/2 with refusal before provider I/O | **EFFECT** (provider request reached vs refused) |

Guard 5's subtleties, both load-bearing: the *coarse* mutation fails 12 tests, but the subtler one
(an empty grant treated as unrestricted) fails only **2**, and the structural "exactly one
enforcement point" test does **not** catch a semantic weakening that keeps the call shape intact.
Do not read that structural test as protection against a weakened check.

Guard 16's second half proves the *default*, not a hand-written grant: the §6 test takes its grant
from `capabilitiesForSkill(undefined)`, so it exercises the real default path. A skill declaring
nothing reads a real `git init` repository and is still refused `git-stage`/`git-commit`, with commit
count unchanged and `git status --porcelain -b` byte-identical afterwards. The rationale for widening
the default, and the five (not four) assertions it moved — `mcp.test.ts` held two copies of the
log-shape assertion — are in open risk 10 above.

Guard 17 is worded as "every `shell` option is `false`", not "never `true`", because a computed value
is how `true` gets back in without the word appearing. The guard strips comments first so prose about
the invariant does not self-trip. The mutation is deliberately a **new** file: a guard that only
watched the known spawn sites would have missed it.

Guard 18 has a second mutation, kept because it proves the *ranking* reads the same dialect and not
just the panel: breaking the identifier-boundary rule fails the retrieval ranking test. Also record
what `e4e8b34` **removed**: regex search is gone as a user-facing feature. Matching is literal per
term with the engine's smart case, and the Search panel has no regex mode, because a second match
dialect was the defect that commit closed.

Guard 19 exists because nothing else would have caught it. `AgentTimeline`'s `summarize` ends in
`default: return ''`, so a kind nobody teaches it renders a **blank cell** and no test fails — that is
how a UI silently stops matching. The gate drives the real core emitters into a real store, renders
the real Timeline, and asserts each kind's summary text.

**A live trap, not a footnote.** The guard-19 mutation initially **PASSED**, because desktop resolves
`@sketch/core` through `dist/`. Build before test is load-bearing for the desktop suite, not a
formality — a stale artifact will show you a green consumer-side gate over a broken contract. This is
trap **T2** (warm artifact hides breakage) resurfacing in a new place; it is cross-referenced there in
`NEED-TO-DO.md` §7.

### Three holes found and closed in the `f2e2fd4` session

- **`7ce5a58`** — "nothing has ever run against a real provider" was **conventional**, not enforced.
  It is now a core-suite egress tripwire (`test/setup/noEgress.ts`; see the architecture-decisions
  entry above). The subtlety that makes a naive guard useless: `net.connect` and `http`'s agent call
  `Socket.prototype.connect` with a **single array** `[options, listener]`, not the caller's
  arguments. A guard written against the documented public signature therefore lets every
  `node:http` request and Node's own `fetch` straight through while looking correct.
- **`17608ce`** — the CI lift-regression gate had **no executing test**. Inverting its `<` to `>`
  left all 1,050 tests green. It now runs as a child process with its exit code asserted.
- **`02ee9c4`** — the MCP hang guard failed by causeless vitest timeout (`Test timed out in
  5000ms`, with files going 1.5 s → 20.7 s and 3 s → 61.5 s) and never mentioned MCP. It is now
  bounded and fails by name.

### Caveats a reader must know

- **Guard 14's `status` strings are decoration, not the guard.**
  `expect(result.status).toBe('runtime-error')` survives the mutation untouched; only the `ok`
  assertion on the next line catches it. Those `ok` lines are **load-bearing** — deleting them as
  redundant turns the guard string-only in a single edit.
- **Guard 5 is mostly proved by absence.** Five of the six adversarial denial paths are proved by
  "the function was not entered", against descriptors defined inside the test file; only
  `fs:write:home` leaves real evidence on disk. Git (guard 16) is the one real shipped tool behind
  the gate — see open risk 10.
- **Guard 13 is bounded, but the in-process egress tripwire does not cover child processes**, by
  design. An MCP child's own network behaviour is outside it.

### Not verified — state plainly

**Re-checked at `ff99c43`.** Task 12.4's licensed third-party-byte flywheel evidence is now closed;
the provider, installer, native-signing, Rust-toolchain, Monaco-double, and Tauri-IPC limitations
below remain unchanged.

- **No run has ever touched a real hosted provider.** Every `.sketch/bench` artifact carries
  `provider: "synthetic-offline"`, and the tripwire now fails the suite if one does not.
- **Tasks 12.2 and 12.3 remain deliberately blocked** (see Phase status): no fresh-machine run with
  process-attributed DNS/socket evidence, and no verified real tag
  release or native signing identity. **GitHub provenance is not Authenticode or Apple Developer ID
  signing/notarization.** Task 12.4's scripted flywheel does not establish organic quality or
  real-provider performance.
- **`cargo test` cannot link on this machine**; Rust modules are verified with `rustc --test` only,
  and the macOS keychain path is not compiled here at all.
- **Monaco is doubled in tests**, and **the Tauri IPC layer is absent from the Phase 3 gate chain**.
  Editor behaviour is proved against the double, not against Monaco, and nothing in that chain
  crosses the real IPC boundary.
