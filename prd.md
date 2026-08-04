# Product Requirements Document (PRD)

**Product**: Sketch  
**Version**: 1.0  
**Status**: Implemented substrate; native, clean-machine, release, third-party, and real-provider evidence gates remain open

---

## Product Thesis

Sketch is one local-first desktop window with two surfaces—**Cowork** and **Code**—over one shared
engineering substrate. It is not a general chatbot and it does not try to be a model provider.
Models are replaceable inputs; Sketch owns the plan, context, tools, verification, event history,
skills, memory, cost controls, and eval loop around them.

The product is optimized for three outcomes:

1. **Lift** — for the same model and budget, `M + Sketch` improves over `M + naive`.
2. **Reliability** — pass@k and its full distribution improve under fixed call, token, cost, and
   time budgets; the best isolated attempt is not the metric.
3. **Compounding** — captured evals, validated skill training, memory hygiene, and ecosystem
   contributions improve the harness on Sketch's clock rather than a provider's release schedule.

No public real-provider model matrix has been run. Current committed benchmark lift is deterministic
synthetic offline regression evidence only and must not be presented as model-capability evidence.

---

## Problem Statement

Developers using AI coding tools face four linked problems:

1. **Lock-in** — one provider, subscription, account, or hosted workflow becomes the product.
2. **Control and privacy** — users cannot reliably choose what context leaves the machine or run
   fully local paths.
3. **Reliability** — generated code is often declared done without a plan, real checks, runtime
   feedback, or inspectable evidence.
4. **Non-compounding workflows** — successful runs, failures, skills, and decisions do not become a
   measured local improvement loop.

Sketch addresses these with provider-neutral adapters, local project state, scoped context/tools,
a hard plan-before-edit gate, event-sourced observability, fixed-budget verification/evals, and
strict held-out training acceptance.

---

## Target Users

### Primary: The Independent Developer
- Works solo or in a small team and wants one local engineering workspace.
- Chooses local, hosted, or custom provider endpoints per task.
- Wants autonomous task execution without surrendering diff review, budgets, or verification.

### Secondary: The Privacy-Conscious Developer
- Needs explicit control over provider and tool egress.
- Can use key-free local endpoints and project-local state.
- Requires secrets, logs, and generated artifacts to stay inspectable and scoped.

A configured local path is not yet clean-machine proof: no native installed-app Ollama run with
process-attributed no-egress evidence has been retained.

### Tertiary: The Cost and Quality Optimizer
- Routes mechanical work to local/inexpensive models and reserves costly models for harder work.
- Needs token/cost/time budgets, cache evidence, and event-derived accounting.
- Compares harness lift using the same model on both sides instead of claiming Sketch beats a model.

---

## Two Surfaces, One Substrate

The title bar exposes a `Cowork | Code` toggle. It changes presentation, not the engine, project,
provider selection, event stream, skills, memory contracts, budgets, or verification results. Both
surfaces remain mounted under one `SketchClient`, application state owner, and event subscription,
so a run's evidence is available across the window without restarting.

### Cowork

Cowork is the task-oriented surface for describing work, selecting the project/provider, running the
agent, and inspecting artifacts, Timeline, Agent Console, tasks, team/strategy outcomes, costs,
benchmarks, memory, skills, and settings. It is optimized for delegating and reviewing a complete
engineering task rather than editing one file at a time.

### Code

Code is the IDE-oriented surface: real file explorer, Monaco models over one authoritative file
state, inline/diff review, Git status and diffs, scoped terminal, search, Test Results, and an honest
Debugger entry point. It is optimized for direct inspection and intervention over the same run and
project state.

No shipped real panel may render fabricated fixture data. A subsystem with no evidence shows a
named empty state.

---

## User Goals

| Goal | How Sketch addresses it |
|---|---|
| Delegate a complete task | Cowork drives the plan/action/verify loop and reconstructs it from events |
| Inspect or intervene directly | Code exposes real project files, diffs, checks, terminal, and Git state |
| Ship code that works | A fixed nine-stage policy and live integration feedback gate completion |
| Use replaceable model endpoints | Local, hosted, and custom adapters resolve through one registry |
| Control what leaves the machine | Project-local state, explicit provider/tool configuration, capability grants |
| Understand and reproduce changes | Append-only events, plan artifacts, diff review, Timeline, and Git integration |
| Bound spend and latency | Per-task budgets, event-derived usage/cost, routing, and response cache |
| Improve the harness | Capture-as-eval, strict held-out skill training, memory hygiene, benchmark gates |
| Avoid another platform account | No Sketch server or account; users bring endpoints/credentials |

---

## Core Product Capabilities

### F1 — Provider Management
- Configure supported or custom endpoints with key-free settings persisted separately from secrets.
- Store credentials only through the native host in the operating system credential store.
- Select the exact persisted provider/model entry for a run; no silent provider fallback.
- Test endpoint connectivity with explicit failure reasons.
- Keep provider keys out of files, events, logs, errors, responses, commits, and console output.

The local key-free provider route reaches both production transports. Real hosted-provider execution
has not been performed, and stored hosted-key invocation remains subject to the host/invocation
credential channel rather than a browser-readable key API.

### F2 — Project Workspace
- Open a local folder and use the same project root in both surfaces.
- Browse real directories lazily and edit real files through one authoritative file state.
- Review proposed changes per hunk and refuse stale/conflicting writes.
- Inspect real terminal, search, Git, and verification output.
- Keep engine state under an on-demand, self-ignored `.sketch/` directory.

### F3 — Plan, Task Execution, and Review
- Persist twelve canonical plan documents before any file edit; core refuses edit-before-plan.
- Parse and execute bounded model actions while emitting each event before the action runs.
- Apply all file and tool side effects through contained, capability-scoped paths.
- Present model edits as reviewable proposals; changed bytes remain observable in Git.
- Support `single`, `plan-then-code`, and eval-gated `swarm`; `single` is the default and `swarm`
  remains off without measured strategy pass@k lift.
- Resolve multi-proposer conflicts by leaving bytes untouched and creating follow-up work, never by
  guessing a merge.

### F4 — Verification Contract

Run configured stages in this fixed order:

```
format → lint → typecheck → build → unit → integration → security → performance → dependency-audit
```

- Project-root `verify.yaml` takes precedence over stack auto-detection.
- Commands run shell-less with timeouts and captured exit code/stdout/stderr/duration.
- Missing stages are reported `skipped`; stages after a failure are `not-run`.
- Every configured non-skipped stage must pass for verified completion.
- Live application/browser feedback participates in integration rather than bypassing the policy.
- An eval's `verify-pass` check fails if nothing was actually verified.

### F5 — Context and Architecture
- Persist an incremental content-hashed repository graph.
- Combine lexical and local/provider vector retrieval, reranking, and one-hop dependency expansion.
- Assemble labelled evidence under a token budget, preserving signatures before bodies.
- Generate system, API, database, component, dependency, folder-tree, and call-graph views from
  repository evidence; unavailable views state why.

These contracts exist, but retrieval is still opt-in on the run wire and the desktop does not enable
it by default. The current vector default is in memory; `.sketch/index/graph.json` persists graph
metadata, not a sqlite-vec database.

### F6 — Versioned Project Memory
- Store decisions, architecture, summarized conversations, standards, preferences, style, bugs,
  performance history, and test history as versioned append-only JSONL.
- Supersede/expire entries without rewriting historical bytes and report contradictions.
- Retrieve with relevance, recency, and explicit `memory_retrieved` evidence.
- Let users inspect memory through the real panel.

The store and panel are real. Memory does not yet automatically ingest every live run or reach every
default desktop prompt, so the product must not claim automatic learning from all work.

### F7 — Cost, Budgets, Cache, and Benchmarks
- Derive session usage/cost only from `llm_response` events; unknown values remain unknown, not zero.
- Stop or downgrade deterministically at configured task budgets.
- Cache identical provider/model/message/options requests by content hash.
- Report task completion, build/test success, manual edits when observed, duration, cost, pass@1,
  pass@k, and the full `0..k` distribution under a fixed budget.
- Compare `M + Sketch` with the same `M + naive`; fail CI on internal lift regression.
- Render only validated benchmark artifacts in the read-only panel.

### F8 — Skills and Compounding
- Load native `SKILL.md` and community-format `skill.json` layouts.
- Install from a curated pinned registry only after content-hash verification.
- Persist a separately reviewed, digest-bound capability grant that may be narrower than requested.
- Capture successful runs as evals and accept a trained candidate only on strict held-out improvement.
- Keep training and activation separate; promotion refuses changed identity/capabilities.

The production flywheel has been exercised with a locally authored community-format fixture. It is
not genuine third-party community-skill evidence, so that external gate remains open.

### F9 — Tool and MCP Layer
- Route side-effecting model actions through capability scopes and emit `tool_called`/`tool_denied`.
- Provide contained first-party filesystem, terminal, Git, browser, and host operations.
- Launch curated MCP entries as isolated JSON-RPC-over-stdio processes with per-run grants/timeouts.
- Surface unavailable, failed, denied, and timed-out tools by name and reason.

Catalog entries are pinned launch descriptions; local contract tests are not audits or execution
evidence for every third-party MCP server.

### F10 — Event-sourced Observability
- Append one sanitized `SketchEvent` per line under `.sketch/events/<date>.jsonl`.
- Use that stream as the single source of run truth for Timeline/replay, costs, eval capture, and
  benchmark projections.
- Expose real panels for Explorer, AI Team, Live Architecture, Memory, Tasks, Agent Console,
  Terminal, Timeline, Cost, Benchmarks, Git, Debugger, Test Results, Provider Settings, Skills, and
  MCP status.

---

## Non-Functional Requirements and Evidence Status

| Requirement | Target / current evidence boundary |
|---|---|
| Startup time | Target < 3 seconds on modern hardware; native installed-app measurement pending |
| Indexing speed | Target < 10 seconds for a 10,000-file repo; do not infer from small fixtures |
| Memory usage | Target < 500 MB idle; installed native measurement pending |
| Offline capability | Fake/scripted gates pass offline; real installed-app Ollama/no-egress proof pending |
| Platform support | Windows/NSIS, macOS/DMG, Linux/DEB jobs configured; three retained native artifacts pending |
| Installer size | Strict `<100,000,000-byte` artifact gate configured; no installer artifact produced on this host |
| Core portability | `@sketch/core` has zero runtime dependencies and a bundleable JSON-line CLI |
| Privacy | No Sketch telemetry/account backend; outbound provider/tool paths are explicit and scoped |

Workflow configuration and source tests are preparation, not native/release/clean-machine evidence.

---

## Out of Scope and Gated Scope

See [what-not-we-are-building.md](what-not-we-are-building.md) for the complete boundaries.

- No Sketch cloud backend, account, cloud sync, telemetry, model hosting, or remote IDE.
- No arbitrary executable plugin loader or claim that code-registration contracts are a plugin store.
- No multi-agent default: consensus exists only inside eval-gated `swarm`, which remains off without
  measured strategy lift.
- No open skill-publishing marketplace before tested integrity/capability scopes, a review queue,
  exact-digest approvals, and digest-bound installed grants. The curated registry is allowed.
- No claim of native installers, signed releases, clean-machine no-egress, genuine third-party skill
  provenance, audited third-party MCP execution, or real-provider product capability without retained
  external evidence.

---

## Success Metrics

These three product metrics govern optimization and release claims:

| Metric | Required measurement |
|---|---|
| Lift | Same-model, same-budget `M + Sketch` minus `M + naive`, repeated across models when authorized |
| Reliability | Pass@1, pass@k, and full outcome distribution under fixed call/token/cost/time budgets |
| Compounding | Strict held-out eval improvement from captured cases and reviewed skill/harness changes |

Task completion rate, build success, test pass rate, observed manual edits, duration, and cost are
reported inputs to those metrics. GitHub stars, install counts, provider count, and contribution
volume may describe adoption; they are not evidence that the engineering harness improved.

---

## Delivery Milestones

| Milestone | Deliverable |
|---|---|
| M1 — Engine | Dependency-free core, adapters, event store, plan gate, verify/eval loop, CLI |
| M2 — Shared window | Real engine behind Cowork and Code through one client/event substrate |
| M3 — Code surface | Monaco, real files, diff review, Git, terminal/search, verification panels |
| M4 — Local control | Provider settings, host OS credentials, zero-telemetry guards, local endpoint path |
| M5 — Intelligence | Hybrid context, architecture, versioned memory, cost/budget/cache, skills/training |
| M6 — Measured orchestration | Eval-gated strategies, honest fixed-budget benchmarks, regression protection |
| M7 — Distribution | Native artifacts, clean-machine Ollama proof, verified release, third-party flywheel evidence |

M7 remains evidence-gated. Configured workflows and local fixtures do not complete it.
