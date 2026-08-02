// The strategy dispatcher — `dispatch`.
//
// ── SINGLE-AGENT IS THE DEFAULT AND ESCALATION IS OPT-IN ────────────────────
//
// Requirements 24.1–24.3. `dispatch` with no `strategy` runs exactly one `runTask` and is
// therefore indistinguishable in cost from calling `runTask` yourself, which is the point:
// nothing about this file makes the default path more expensive. `escalate` is off unless
// asked for, and even then it only ever moves right along {@link ESCALATION_LADDER}.
//
// ── "ESCALATE ONLY AFTER THE LIGHTER STRATEGY FAILS WITHIN ITS BUDGET" ──────
//
// Requirement 24.3, and the word that does the work is WITHIN. Two failures look the same
// from a distance and must not be treated the same:
//
//   * the attempt was given its full budget and did not solve the task — verify failed, the
//     turn cap was reached, consensus did not hold. It failed WITHIN its budget, so there is
//     a case for spending more, and escalation is allowed.
//   * the attempt was CUT OFF — the money ceiling breached, the user aborted, the provider
//     errored, a question needed answering. It never got its budget, and escalating spends
//     more on a task whose ceiling was already hit. Escalation stops, and the reason says so.
//
// {@link ESCALATABLE_REASONS} is that distinction as data. Getting it wrong is a money bug:
// a budget breach that escalated to `swarm` would turn one ceiling into thirteen bills.
//
// ── `component: 'dispatcher'`, AND NEVER THE ROUTER'S `policy` KEY ──────────
//
// `strategy_selected` already has two emitters, both the Phase 8 cost router inside
// `runTask`, both using `component: 'router'` and a `policy` key whose values are `always`
// and `after-plan`. Those are MODEL-TIER decisions, not strategy decisions, and
// `budget.test.ts` finds them with a bare `.find(e => e.kind === 'strategy_selected')`. So
// this file emits `component: 'dispatcher'`, never writes a `policy` key, and emits under
// its OWN slice — a dispatch id, not a run id — so a dispatcher event can never appear in a
// sub-run's `forRun(runId)` and be mistaken for the router's.
//
// ── WHY THE DISPATCHER HAS ITS OWN SLICE ────────────────────────────────────
//
// A swarm is N runs. There is no single run the ladder belongs to, and putting the ladder in
// the first attempt's slice would make attempt one's log the parent of attempt three's. So
// the dispatcher mints a `dispatchId` and the sub-run ids are derived from it
// (`<dispatchId>-r1`, `-r2`, …) — distinct by construction even under a frozen clock, and
// readable, so a person looking at a log line knows which dispatch a run belonged to.
//
// Validates: Requirements 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.9

import type { Capability } from '../capabilities/index.js'
import { newRunId } from '../events/ids.js'
import { parseAction } from '../loop/actions.js'
import { runTask, type RunTaskDeps, type ToolDispatch } from '../loop/agent.js'
import { runVerifyPolicy, VERIFY_STAGES, type PolicyResult, type VerifyPolicy, type VerifyStage } from '../verify/policy.js'
import type { RunResult, SketchEvent, Task } from '../types.js'
import { diskPathExists, gradeRole, type PathExists, type RoleGrade } from './grade.js'
import {
  blockerFollowUps,
  collectProposals,
  consensus,
  mergeProposals,
  unverifiableFollowUps,
  type ConsensusResult,
  type EditProposal,
  type FollowUpTask,
  type MergeResult,
} from './merge.js'
import { ROLE_DEFINITIONS, rolePrompt, roleCapabilities, partitionRoles, type Role } from './roles.js'
import {
  DEFAULT_STRATEGY,
  ESCALATION_LADDER,
  heavierThan,
  type Strategy,
} from './strategies.js'

/** The `runTask` seam, so a test can dispatch without a model. */
export type RunTaskFn = (task: Task, deps: RunTaskDeps) => Promise<RunResult>

/**
 * Reasons a failed attempt may escalate to a heavier strategy.
 *
 * Everything NOT on this list stops the ladder. See the header: the list is the difference
 * between "failed within its budget" and "never got its budget".
 */
export const ESCALATABLE_REASONS: readonly string[] = [
  'verify_failed',
  'max_iterations',
  'consensus_failed',
  'merge_conflict',
  'plan_missing',
  'no_verifiable_role',
]

/**
 * The order roles run in a swarm.
 *
 * Producers first, then the measurement roles, then the two BLOCKING roles last — Security
 * and Reviewer are reviewing what the others produced, so they must run after it exists.
 * Fixed order rather than a set, because a swarm whose roles ran in a different order each
 * time would produce different context for every role after the first and could not be
 * measured against anything.
 */
export const SWARM_ORDER: readonly Role[] = [
  'ceo',
  'planner',
  'research',
  'architect',
  'backend',
  'frontend',
  'database',
  'testing',
  'documentation',
  'performance',
  'deployment',
  'security',
  'reviewer',
]

export interface DispatchDeps extends RunTaskDeps {
  /** Which strategy to start with. Defaults to {@link DEFAULT_STRATEGY}. */
  strategy?: Strategy
  /**
   * Allow escalation up the ladder when an attempt fails within its budget.
   *
   * Off by default. A caller that wants a swarm gets one by asking for it; nothing here
   * decides on its own that a task deserves thirteen agents.
   */
  escalate?: boolean
  /** Roles a swarm may use. Defaults to {@link SWARM_ORDER}. */
  roles?: readonly Role[]
  /**
   * The capability grant in force for this run.
   *
   * Role capabilities are INTERSECTED with it (`roleCapabilities`), never unioned. Omitted
   * means an empty grant, so every role's intersected set is empty — which is the honest
   * default for a caller that did not say what it holds.
   */
  grant?: readonly Capability[]
  /**
   * Build the tool layer for one role, given the capabilities it may hold.
   *
   * The dispatcher does not construct a `ToolDispatcher` itself, for the same reason the
   * loop does not: resolving a grant means knowing which skill is speaking and what the
   * registry granted it, and that is the caller's knowledge. Omitted means role sub-runs get
   * no tools, and every `tool` action in them is refused — the loop's own honest default.
   */
  toolsForRole?: (role: Role, capabilities: readonly Capability[]) => ToolDispatch | undefined
  /** The loop. Injectable; defaults to `runTask`. */
  runner?: RunTaskFn
  /** Citation existence check. Defaults to the real filesystem under `root`. */
  pathExists?: PathExists
  /** The policy runner used for the merged change. Injectable; defaults to `runVerifyPolicy`. */
  runPolicy?: typeof runVerifyPolicy
  /** The dispatch slice id. Defaults to a fresh `newRunId`. */
  dispatchId?: string
}

/** What one role's sub-run produced. */
export interface RoleOutcome {
  role: Role
  /** False when the role was skipped before it cost anything. */
  ran: boolean
  /** Why it was skipped. Null when it ran. */
  skipped: string | null
  runId: string | null
  grade: RoleGrade | null
  /** File changes it proposed. Zero for a non-editing role, always. */
  proposals: number
}

export interface StrategyAttempt {
  strategy: Strategy
  ok: boolean
  /** The terminal reason, in the same vocabulary the run events use. */
  reason: string
  detail: string
  runIds: string[]
  runs: RunResult[]
  /** Populated for `plan-then-code` and `swarm`. */
  roles: RoleOutcome[]
  /** Null unless a merge ran. */
  merge: MergeResult | null
  /** Null unless the strategy was `swarm` (Requirement 24.9). */
  consensus: ConsensusResult | null
  /** The merged change's full verification, when one ran. */
  verify: PolicyResult | null
}

export interface DispatchResult {
  dispatchId: string
  ok: boolean
  /** Which strategy succeeded. Null when none did (Requirement 24.2). */
  succeeded: Strategy | null
  attempts: StrategyAttempt[]
  followUps: FollowUpTask[]
  finalText: string
  /** The dispatcher's own slice of the log, not any sub-run's. */
  events: SketchEvent[]
}

/** Stages this project actually configures — the input to role partitioning. */
export function configuredStages(policy: VerifyPolicy | undefined): VerifyStage[] {
  if (policy === undefined) return []
  return VERIFY_STAGES.filter((stage) => (policy[stage] ?? []).length > 0)
}

/** The terminal event's `reason`, which is the vocabulary escalation is decided in. */
export function terminalReason(run: RunResult): string {
  for (let index = run.events.length - 1; index >= 0; index--) {
    const event = run.events[index]!
    if (event.kind !== 'run_completed' && event.kind !== 'run_failed') continue
    const reason = event.payload['reason']
    if (typeof reason === 'string') return reason
  }
  return run.ok ? 'done' : 'unknown'
}

/** Keep accumulated role context bounded; a swarm's prompt is paid for per role. */
function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n\u2026 (truncated)`
}

/**
 * The plan text a Planner sub-run produced, read back out of its own log.
 *
 * Re-parses the assistant turns with the loop's own `parseAction`, so the text handed to the
 * coding run is exactly the artifacts the model sent — not a summary of them, and not the
 * `finalText` sign-off line, which is one sentence.
 */
export function planTextFrom(run: RunResult): string {
  let latest = ''
  for (const event of run.events) {
    if (event.kind !== 'llm_response') continue
    const text = event.payload['text']
    if (typeof text !== 'string') continue
    const action = parseAction(text)
    if (action.action !== 'plan') continue
    const parts: string[] = []
    for (const [name, value] of Object.entries(action.artifacts)) {
      if (typeof value === 'string' && value.trim() !== '') parts.push(`## ${name}\n\n${value.trim()}`)
    }
    if (parts.length > 0) latest = parts.join('\n\n')
  }
  return latest
}

/** Dispatcher-only keys, stripped before deps reach `runTask`. */
function subRunDeps(deps: DispatchDeps, overrides: Partial<RunTaskDeps>): RunTaskDeps {
  const {
    strategy: _strategy,
    escalate: _escalate,
    roles: _roles,
    grant: _grant,
    toolsForRole: _toolsForRole,
    runner: _runner,
    pathExists: _pathExists,
    runPolicy: _runPolicy,
    dispatchId: _dispatchId,
    ...rest
  } = deps
  return { ...rest, ...overrides }
}

interface Context {
  dispatchId: string
  runner: RunTaskFn
  pathExists: PathExists
  runPolicy: typeof runVerifyPolicy
  /** Monotonic sub-run ids derived from the dispatch id. Distinct even with a frozen clock. */
  nextRunId: () => string
  emit: (payload: Record<string, unknown>) => Promise<void>
}

/** One `runTask`, with a fresh derived id. */
async function subRun(
  task: Task,
  deps: DispatchDeps,
  context: Context,
  overrides: Partial<RunTaskDeps>,
): Promise<RunResult> {
  const id = context.nextRunId()
  return context.runner(task, subRunDeps(deps, { ...overrides, ids: () => id }))
}

/**
 * Run one role as a constrained sub-run (Requirement 24.5).
 *
 * Three narrowings, all of them structural:
 *   * the PROMPT is the role's own instruction (`rolePrompt`);
 *   * the POLICY is narrowed to the one stage that grades it, so the Backend role does not
 *     pay for the Frontend's build. `live` is deliberately excluded — starting the
 *     application is not how the Database role is graded;
 *   * the GRANT is the role's capability list intersected with the run's.
 *
 * `reviewEdits` is forced ON for every role, including the ones that are allowed to edit.
 * Nothing a role proposes is written by the role: the merge decides, once, after consensus.
 * That is also what makes "this role does not write files" true of the non-editing roles
 * rather than merely instructed.
 */
async function runRole(
  role: Role,
  task: Task,
  deps: DispatchDeps,
  context: Context,
  accumulated: string,
): Promise<{ run: RunResult; grade: RoleGrade; proposals: EditProposal[] }> {
  const definition = ROLE_DEFINITIONS[role]
  const signal = definition.signal

  const narrowedPolicy: VerifyPolicy | undefined =
    signal.kind === 'verify-stage'
      ? { [signal.stage]: deps.verifyPolicy?.[signal.stage] ?? [] }
      : undefined

  const capabilities = roleCapabilities(role, deps.grant ?? [])
  const tools = deps.toolsForRole?.(role, capabilities)

  const run = await subRun(
    {
      ...task,
      prompt: rolePrompt(role, task.prompt, accumulated),
      // The role's grade is its signal, not the parent task's ad-hoc commands. Leaving
      // `task.verify` in place would grade every role by the same thing and make the
      // thirteen signals decorative.
      verify: [],
    },
    deps,
    context,
    {
      ...(narrowedPolicy !== undefined ? { verifyPolicy: narrowedPolicy } : { verifyPolicy: {} }),
      reviewEdits: true,
      ...(tools !== undefined ? { tools } : { tools: undefined }),
    },
  )

  const grade = await gradeRole(role, run, { pathExists: context.pathExists })
  // A non-editing role's proposals are DISCARDED, not merged. `reviewEdits` already stopped
  // them reaching disk; this stops them reaching the merge.
  const proposals =
    definition.edits && grade.passed ? collectProposals(role, run) : []
  return { run, grade, proposals }
}

/** What later roles are told about the ones that already ran. */
function accumulate(
  previous: string,
  role: Role,
  grade: RoleGrade,
  run: RunResult,
  proposals: readonly EditProposal[],
): string {
  const definition = ROLE_DEFINITIONS[role]
  const parts = [
    `## ${definition.title} — ${grade.passed ? 'verified' : 'FAILED its signal'}`,
    grade.reason,
    '',
    clip(run.finalText, 1500),
  ]
  if (proposals.length > 0) {
    parts.push('', 'Proposed changes (not yet written):')
    for (const proposal of proposals) {
      parts.push(`### ${proposal.path}`, '```diff', clip(proposal.diff, 3000), '```')
    }
  }
  return previous === '' ? parts.join('\n') : `${previous}\n\n${parts.join('\n')}`
}

async function attemptSingle(
  task: Task,
  deps: DispatchDeps,
  context: Context,
): Promise<StrategyAttempt> {
  const run = await subRun(task, deps, context, {})
  return {
    strategy: 'single',
    ok: run.ok,
    reason: terminalReason(run),
    detail: run.finalText,
    runIds: [run.runId],
    runs: [run],
    roles: [],
    merge: null,
    consensus: null,
    verify: null,
  }
}

async function attemptPlanThenCode(
  task: Task,
  deps: DispatchDeps,
  context: Context,
): Promise<StrategyAttempt> {
  const planner = await runRole('planner', task, deps, context, '')
  const roles: RoleOutcome[] = [
    {
      role: 'planner',
      ran: true,
      skipped: null,
      runId: planner.run.runId,
      grade: planner.grade,
      proposals: 0,
    },
  ]

  if (!planner.grade.passed) {
    return {
      strategy: 'plan-then-code',
      ok: false,
      // A distinct reason, because "there is no plan to code from" is a different failure
      // than "the code did not verify", and the ladder treats both as escalatable but a
      // reader should not have to guess which happened.
      reason: 'plan_missing',
      detail: planner.grade.reason,
      runIds: [planner.run.runId],
      runs: [planner.run],
      roles,
      merge: null,
      consensus: null,
      verify: null,
    }
  }

  const plan = planTextFrom(planner.run)
  const coder = await subRun(
    {
      ...task,
      prompt:
        `${task.prompt}\n\n# Plan written by the Planner role\n\n${plan}\n\n` +
        'Implement it. The plan is evidence, not gospel: if a step is wrong, say so and do ' +
        'the right thing.',
    },
    deps,
    context,
    {},
  )

  return {
    strategy: 'plan-then-code',
    ok: coder.ok,
    reason: terminalReason(coder),
    detail: coder.finalText,
    runIds: [planner.run.runId, coder.runId],
    runs: [planner.run, coder],
    roles,
    merge: null,
    consensus: null,
    verify: null,
  }
}

async function attemptSwarm(
  task: Task,
  deps: DispatchDeps,
  context: Context,
): Promise<StrategyAttempt> {
  const requested = deps.roles ?? SWARM_ORDER
  const stages = configuredStages(deps.verifyPolicy)
  // BEFORE A TOKEN IS SPENT (Requirement 24.6). A role whose signal this project cannot
  // resolve is skipped with a reason, not run and then believed.
  const { verifiable, unverifiable } = partitionRoles(requested, stages)

  await context.emit({
    phase: 'roles',
    strategy: 'swarm',
    verifiable: verifiable.map((entry) => entry.role),
    skipped: unverifiable.map((entry) => ({ role: entry.role, reason: entry.reason })),
    configuredStages: stages,
  })

  const skippedFollowUps = unverifiableFollowUps(
    task.id,
    unverifiable.map((entry) => ({ role: entry.role, reason: entry.reason! })),
  )
  const roles: RoleOutcome[] = unverifiable.map((entry) => ({
    role: entry.role,
    ran: false,
    skipped: entry.reason,
    runId: null,
    grade: null,
    proposals: 0,
  }))

  if (verifiable.length === 0) {
    return {
      strategy: 'swarm',
      ok: false,
      reason: 'no_verifiable_role',
      detail:
        'no requested role has a verification signal this project can resolve, so the swarm ' +
        'would have produced thirteen unverified opinions',
      runIds: [],
      runs: [],
      roles,
      // The skipped roles' follow-up travels on this path TOO. An earlier version returned an
      // empty list here, so a swarm that skipped every role left nothing behind at all — the
      // one case where the follow-up is the entire output. The Phase 10 gate caught it.
      merge: { ok: true, applied: [], conflicts: [], followUps: skippedFollowUps },
      consensus: consensus('swarm', []),
      verify: null,
    }
  }

  // Contract order, blocking roles last, so Security and Reviewer see what they review.
  const ordered = SWARM_ORDER.filter((role) => verifiable.some((entry) => entry.role === role))
  const runs: RunResult[] = []
  const grades: RoleGrade[] = []
  const proposals: EditProposal[] = []
  let accumulated = ''

  for (const role of ordered) {
    const outcome = await runRole(role, task, deps, context, accumulated)
    runs.push(outcome.run)
    grades.push(outcome.grade)
    proposals.push(...outcome.proposals)
    accumulated = accumulate(accumulated, role, outcome.grade, outcome.run, outcome.proposals)
    roles.push({
      role,
      ran: true,
      skipped: null,
      runId: outcome.run.runId,
      grade: outcome.grade,
      proposals: outcome.proposals.length,
    })
  }

  const runIds = runs.map((run) => run.runId)
  const agreement = consensus('swarm', grades)!

  // CONSENSUS GATES THE MERGE, not the other way round. Merging first and then discovering
  // the Security role objected would mean the objection arrived after the bytes did.
  if (!agreement.reached) {
    const followUps = [
      ...blockerFollowUps(task.id, agreement.blockers, runIds),
      ...skippedFollowUps,
    ]
    return {
      strategy: 'swarm',
      ok: false,
      reason: 'consensus_failed',
      detail: agreement.reason,
      runIds,
      runs,
      roles,
      merge: { ok: true, applied: [], conflicts: [], followUps },
      consensus: agreement,
      verify: null,
    }
  }

  const merge = await mergeProposals(proposals, {
    root: deps.root,
    files: deps.files,
    ...(deps.readText !== undefined ? { readText: deps.readText } : {}),
    taskId: task.id,
  })

  // The merged change is verified ONCE, by the project's whole contract. Each role already
  // passed its own narrow stage; that says nothing about whether the union of their edits
  // holds together, which is the only question that matters at this point.
  const policy = deps.verifyPolicy
  let verify: PolicyResult | null = null
  if (policy !== undefined && Object.keys(policy).length > 0) {
    verify = await context.runPolicy(policy, {
      sink: deps.events,
      runId: context.dispatchId,
      root: deps.root,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    })
  }

  const verifiedOk = verify === null ? true : verify.ok
  const ok = merge.ok && verifiedOk
  const reason = !merge.ok ? 'merge_conflict' : verifiedOk ? 'done' : 'verify_failed'

  return {
    strategy: 'swarm',
    ok,
    reason,
    detail: ok
      ? `${merge.applied.length} file(s) merged from ${agreement.agreeing.length} verified role(s)` +
        (verify === null
          ? '; this project configures no verification stages, so the merged change was not checked'
          : '')
      : !merge.ok
        ? `${merge.conflicts.length} conflict(s) left unmerged and turned into follow-up tasks`
        : `the merged change failed the ${verify?.failedStage ?? 'verification'} stage`,
    runIds,
    runs,
    roles,
    merge: { ...merge, followUps: [...merge.followUps, ...skippedFollowUps] },
    consensus: agreement,
    verify,
  }
}

/**
 * Run a task under a strategy, escalating only when Requirement 24.3 allows it.
 *
 * Always resolves. Every attempt's own failures are already data by the time they get here —
 * `runTask` never throws — and a throw from a merge or a policy run is caught and reported as
 * the last attempt's failure rather than escaping to the caller.
 */
export async function dispatch(task: Task, deps: DispatchDeps): Promise<DispatchResult> {
  const clock = deps.clock ?? (() => Date.now())
  const dispatchId = deps.dispatchId ?? newRunId(clock())
  let counter = 0

  const context: Context = {
    dispatchId,
    runner: deps.runner ?? runTask,
    pathExists: deps.pathExists ?? diskPathExists(deps.root),
    runPolicy: deps.runPolicy ?? runVerifyPolicy,
    nextRunId: () => `${dispatchId}-r${++counter}`,
    emit: async (payload) => {
      await deps.events.emit({
        runId: dispatchId,
        kind: 'strategy_selected',
        // `component` tells this apart from the cost router's two emitters, and there is
        // deliberately no `policy` key here — that is the router's, and reusing it would
        // make one payload shape mean two different decisions.
        payload: { component: 'dispatcher', taskId: task.id, ...payload },
      })
    },
  }

  const start = deps.strategy ?? DEFAULT_STRATEGY
  const ladder: Strategy[] =
    deps.escalate === true
      ? [start, ...heavierThan(start)]
      : [start]

  const attempts: StrategyAttempt[] = []
  const followUps: FollowUpTask[] = []
  let succeeded: Strategy | null = null
  let stopped: string | null = null

  for (const strategy of ladder) {
    await context.emit({
      phase: 'attempt',
      strategy,
      attempt: attempts.length + 1,
      ladder,
      reason:
        attempts.length === 0
          ? deps.strategy === undefined
            ? `no strategy was chosen, so the default (${DEFAULT_STRATEGY}) runs`
            : `the caller chose ${strategy}`
          : `${attempts[attempts.length - 1]!.strategy} failed within its budget ` +
            `(${attempts[attempts.length - 1]!.reason}), escalating`,
    })

    let attempt: StrategyAttempt
    try {
      attempt =
        strategy === 'single'
          ? await attemptSingle(task, deps, context)
          : strategy === 'plan-then-code'
            ? await attemptPlanThenCode(task, deps, context)
            : await attemptSwarm(task, deps, context)
    } catch (err) {
      attempt = {
        strategy,
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
        runIds: [],
        runs: [],
        roles: [],
        merge: null,
        consensus: null,
        verify: null,
      }
    }

    attempts.push(attempt)
    if (attempt.merge !== null) followUps.push(...attempt.merge.followUps)

    if (attempt.ok) {
      succeeded = strategy
      break
    }
    if (!ESCALATABLE_REASONS.includes(attempt.reason)) {
      stopped =
        `${strategy} did not fail within its budget (${attempt.reason}), so escalating would ` +
        'spend more on a task that never got the budget it had. Stopped'
      break
    }
    if (heavierThan(strategy).length === 0) {
      stopped = `${strategy} is the heaviest strategy, so there is nothing to escalate to`
    }
  }

  const last = attempts[attempts.length - 1]
  await context.emit({
    // The RECORD of which strategy succeeded (Requirement 24.2). `strategy_selected` is the
    // only event kind the contract gives for this, and the closed `EventKind` union is a
    // spec-level contract, so `phase` discriminates rather than a new kind being invented.
    phase: 'outcome',
    succeeded,
    ok: succeeded !== null,
    attempts: attempts.map((entry) => ({
      strategy: entry.strategy,
      ok: entry.ok,
      reason: entry.reason,
      runIds: entry.runIds,
    })),
    followUps: followUps.map((entry) => ({ id: entry.id, origin: entry.origin, reason: entry.reason })),
    ...(stopped !== null ? { stopped } : {}),
  })

  return {
    dispatchId,
    ok: succeeded !== null,
    succeeded,
    attempts,
    followUps,
    finalText:
      last === undefined
        ? 'No strategy ran.'
        : succeeded !== null
          ? last.detail
          : `${last.detail}${stopped === null ? '' : ` — ${stopped}`}`,
    events: await deps.events.forRun(dispatchId),
  }
}

/** Every strategy in the ladder, for a caller rendering the choice. */
export { ESCALATION_LADDER }
