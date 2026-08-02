// The thirteen roles, and the verification signal each one is checked by.
//
// ── THE RULE THAT SHAPES THIS FILE ──────────────────────────────────────────
//
// Requirement 24.6: NO ROLE WITHOUT A DISTINCT VERIFICATION SIGNAL. A role that cannot be
// checked is a costume — it produces output nobody can grade, and thirteen of those is
// thirteen times the cost for none of the benefit. So the signal is not documentation
// here, it is a REQUIRED field of the role, and the dispatcher grades every role by it.
//
// ── WHAT "DISTINCT" CANNOT MEAN ─────────────────────────────────────────────
//
// It cannot mean pairwise-unique. There are thirteen roles and the verification contract
// has nine stages, so thirteen unique stages is arithmetically impossible. An earlier
// draft of this file claimed uniqueness anyway and paid for it by grading the Planner with
// `typecheck` and the Research role with `lint` — stages that say nothing whatever about a
// document. That is the "green for the wrong reason" this project keeps finding: the check
// runs, it passes, and it was never looking at the role's output.
//
// So `distinct` means each role has a signal OF ITS OWN, specific to what it produces, and
// {@link RoleSignal} is a union of the three kinds of thing a role's output actually is:
//
//   `verify-stage`  — the role writes or measures code, so the PROJECT'S OWN tooling
//                     grades it, and the sub-run pays for that one stage rather than the
//                     whole gauntlet.
//   `plan-artifact` — the role produces a decision or a plan, so the signal is that the
//                     plan artifact landed on disk with something in it.
//   `citations`     — the role produces findings, so the signal is that the findings are
//                     ANCHORED: every path it cites exists in this repository, or it
//                     explicitly reports none.
//
// ── THE LIMIT OF THE `citations` SIGNAL, STATED RATHER THAN HIDDEN ──────────
//
// A citation check proves a finding is anchored in this repository. It does NOT prove the
// finding is correct, and nothing mechanical can — a reviewer's judgement is not
// compilable. What it does catch is the failure mode review models actually have:
// confident prose about files that do not exist. The alternative on offer was a model
// grading a model, which is not a verification signal at all, so this is the honest
// ceiling and it is written down rather than implied.
//
// A role that finds nothing must say {@link NO_FINDINGS_TOKEN}. Without that, "no
// citations" and "waffle with no anchors" are the same bytes, and a clean security review
// would be punished while an empty one passed.
//
// ── WHAT A ROLE IS NOT ─────────────────────────────────────────────────────
//
// Not a persona, a personality, or a system-prompt costume. It is: a narrowed instruction,
// a narrowed capability grant, and a named signal that decides whether it succeeded.
// Everything else about a role is the same `runTask` the single-agent path uses.
//
// Validates: Requirements 24.4, 24.5, 24.6

import type { VerifyStage } from '../verify/policy.js'
import type { Capability } from '../capabilities/index.js'

/**
 * The thirteen Requirement 24.4 names, in the order it names them.
 *
 * Closed union: an unrecognised role is a typo, and a dispatcher that accepted one would
 * spawn a sub-run with no verification signal.
 */
export const ROLES = [
  'ceo',
  'planner',
  'research',
  'architect',
  'backend',
  'frontend',
  'database',
  'security',
  'testing',
  'reviewer',
  'performance',
  'deployment',
  'documentation',
] as const

export type Role = (typeof ROLES)[number]

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * The token a findings role must emit when it has nothing to report.
 *
 * Exported because the prompt states it and the grader looks for it, and a token those two
 * disagree about would fail every clean review.
 */
export const NO_FINDINGS_TOKEN = 'NO FINDINGS'

/**
 * What grades a role's work. See the header for why there are three kinds and not one.
 *
 * `verify-stage` carries the stage so the dispatcher can narrow the sub-run's policy to
 * exactly it: the Backend role should not pay for the Frontend's build.
 */
export type RoleSignal =
  | { kind: 'verify-stage'; stage: VerifyStage }
  | { kind: 'plan-artifact' }
  | { kind: 'citations' }

/** One-line rendering of a signal, for a panel or a log line. */
export function describeSignal(signal: RoleSignal): string {
  switch (signal.kind) {
    case 'verify-stage':
      return `the project\u2019s "${signal.stage}" verification stage`
    case 'plan-artifact':
      return 'a plan artifact written to disk with at least one document in it'
    case 'citations':
      return `every cited path resolving in this repository, or an explicit "${NO_FINDINGS_TOKEN}"`
  }
}

/** One role's definition. */
export interface RoleDefinition {
  role: Role
  /** Human label, for a panel. */
  title: string
  /**
   * What decides whether this role succeeded.
   *
   * Requirement 24.6 in one required field. A role whose signal cannot be resolved in this
   * project is SKIPPED — never passed by default, because "we could not check it" and "it
   * is fine" are different facts.
   */
  signal: RoleSignal
  /**
   * What this role is told to do. Narrow on purpose: the point of a role is that it does
   * one thing that can be graded, not that it sounds like a job title.
   */
  instruction: string
  /**
   * The capabilities this role's sub-run may hold, AT MOST.
   *
   * Least privilege per role: `research` needs to read, not to write; `deployment` is the
   * only one that would ever want `proc:spawn`. {@link roleCapabilities} intersects this
   * with the grant the RUN actually holds, so a role can never widen what the caller was
   * given — `capabilities/guard.ts` remains the one authorisation point.
   */
  capabilities: readonly Capability[]
  /**
   * True when this role proposes file edits.
   *
   * A role that does not edit contributes findings, and its output reaches the merge as
   * nothing. Stated per role so the merge never has to guess whether an empty edit set
   * means "nothing to do" or "the sub-run failed".
   */
  edits: boolean
  /**
   * True when this role's findings can STOP the swarm.
   *
   * Only Security and Reviewer. A blocking role that reports anchored findings means the
   * merged change is not shipped and a follow-up task carries the findings out. Biased
   * towards stopping on purpose: a false stop costs a human a minute, and a false ship
   * costs whatever the finding was about.
   */
  blocking: boolean
}

/**
 * The table.
 *
 * Signals were assigned by asking, per role, "what artifact does this produce, and what
 * would actually look at it" — not by dealing out the nine stages until they ran out.
 * That is why two roles share `unit` (Backend and Testing both produce code the unit
 * suite runs) and why the Planner is graded by its plan rather than by a compiler that
 * never sees it.
 */
export const ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> = Object.freeze({
  ceo: {
    role: 'ceo',
    title: 'CEO',
    // The decision to do the thing, written down. Graded by the artifact existing.
    signal: { kind: 'plan-artifact' },
    instruction:
      'Decide whether the task as stated is worth doing, and what "done" means for it. ' +
      'Write that decision into the plan artifacts. Do not write code.',
    capabilities: ['fs:read:project'],
    edits: false,
    blocking: false,
  },
  planner: {
    role: 'planner',
    title: 'Planner',
    signal: { kind: 'plan-artifact' },
    instruction:
      'Break the task into ordered steps, each one independently verifiable, and name the ' +
      'files each step touches. Write it into the plan artifacts. Do not write code.',
    capabilities: ['fs:read:project'],
    edits: false,
    blocking: false,
  },
  research: {
    role: 'research',
    title: 'Research',
    signal: { kind: 'citations' },
    instruction:
      'Find how this codebase already solves adjacent problems. Cite every claim with the ' +
      'path it came from. Report what exists; change nothing.',
    capabilities: ['fs:read:project', 'git:read'],
    edits: false,
    blocking: false,
  },
  architect: {
    role: 'architect',
    title: 'Architect',
    // Interfaces and types, so the type checker is exactly the right grader.
    signal: { kind: 'verify-stage', stage: 'typecheck' },
    instruction:
      'Decide where the change belongs and what the seams are. Write interfaces and types ' +
      'only; leave the implementations to the specialist roles.',
    capabilities: ['fs:read:project', 'fs:write:project'],
    edits: true,
    blocking: false,
  },
  backend: {
    role: 'backend',
    title: 'Backend',
    signal: { kind: 'verify-stage', stage: 'unit' },
    instruction: 'Implement the server-side behaviour the plan describes, with its tests.',
    capabilities: ['fs:read:project', 'fs:write:project'],
    edits: true,
    blocking: false,
  },
  frontend: {
    role: 'frontend',
    title: 'Frontend',
    // `build` rather than `unit`: a frontend that does not compile is broken in a way unit
    // tests routinely miss.
    signal: { kind: 'verify-stage', stage: 'build' },
    instruction: 'Implement the user-facing behaviour the plan describes, with its tests.',
    capabilities: ['fs:read:project', 'fs:write:project'],
    edits: true,
    blocking: false,
  },
  database: {
    role: 'database',
    title: 'Database',
    // A schema change is graded by something that talks to a real database, which is the
    // integration stage and not the unit one.
    signal: { kind: 'verify-stage', stage: 'integration' },
    instruction:
      'Design or change the schema and its migrations. A migration that cannot roll back ' +
      'is not finished.',
    capabilities: ['fs:read:project', 'fs:write:project'],
    edits: true,
    blocking: false,
  },
  security: {
    role: 'security',
    title: 'Security',
    // Findings, anchored. The project's own `security` stage is a different check and it
    // still runs — as part of the merged change's full gauntlet, not as this role's grade.
    signal: { kind: 'citations' },
    instruction:
      'Look for injection, missing authorisation, leaked credentials, and unsafe defaults ' +
      `in what the other roles produced. Cite path and line for every finding, or say ${NO_FINDINGS_TOKEN}.`,
    capabilities: ['fs:read:project'],
    edits: false,
    blocking: true,
  },
  testing: {
    role: 'testing',
    title: 'Testing',
    signal: { kind: 'verify-stage', stage: 'unit' },
    instruction:
      'Write the tests the change needs, including the failing case that proves the bug ' +
      'existed. A test that has never failed has not been shown to test anything.',
    capabilities: ['fs:read:project', 'fs:write:project'],
    edits: true,
    blocking: false,
  },
  reviewer: {
    role: 'reviewer',
    title: 'Reviewer',
    signal: { kind: 'citations' },
    instruction:
      'Review the proposed change for correctness and for anything it breaks. Say what is ' +
      `wrong and where, with path and line, or say ${NO_FINDINGS_TOKEN}. Do not rewrite it.`,
    capabilities: ['fs:read:project', 'git:read'],
    edits: false,
    blocking: true,
  },
  performance: {
    role: 'performance',
    title: 'Performance',
    // Measured, by the project's own benchmark stage. This role proposes no edits: it
    // reports numbers, and the numbers come from the same runner everything else uses.
    signal: { kind: 'verify-stage', stage: 'performance' },
    instruction:
      'Measure the change\u2019s cost in time and memory using the project\u2019s own ' +
      'benchmarks. Report numbers, or say that nothing measurable changed.',
    capabilities: ['fs:read:project'],
    edits: false,
    blocking: false,
  },
  deployment: {
    role: 'deployment',
    title: 'Deployment',
    signal: { kind: 'verify-stage', stage: 'dependency-audit' },
    instruction:
      'Check that the change can actually ship: dependencies, configuration, and anything ' +
      'that differs between this machine and production.',
    // The only role that would ever want to start a process, and it still only gets it
    // when the RUN holds it — `roleCapabilities` intersects, never widens.
    capabilities: ['fs:read:project', 'proc:spawn'],
    edits: false,
    blocking: false,
  },
  documentation: {
    role: 'documentation',
    title: 'Documentation',
    signal: { kind: 'verify-stage', stage: 'format' },
    instruction:
      'Update the documentation the change makes wrong. Do not describe intentions; ' +
      'describe what the code now does.',
    capabilities: ['fs:read:project', 'fs:write:project'],
    edits: true,
    blocking: false,
  },
})

/** Every role definition, in contract order. */
export function allRoles(): readonly RoleDefinition[] {
  return ROLES.map((role) => ROLE_DEFINITIONS[role])
}

/** Roles that propose edits — the ones whose output reaches the merge. */
export function editingRoles(): readonly RoleDefinition[] {
  return allRoles().filter((definition) => definition.edits)
}

/**
 * The capabilities a role's sub-run may hold: its own list INTERSECTED with the grant the
 * run holds.
 *
 * Intersection, never union. A role table is a narrowing device; if it could add a
 * capability the caller was not granted, thirteen roles would be thirteen ways around the
 * one authorisation point. The Deployment role asks for `proc:spawn` and gets it only from
 * a run that already had it.
 */
export function roleCapabilities(
  role: Role,
  granted: readonly Capability[],
): readonly Capability[] {
  const wanted = ROLE_DEFINITIONS[role].capabilities
  return wanted.filter((capability) => granted.includes(capability))
}

/** What a role's signal resolved to for one project. */
export interface RoleVerification {
  role: Role
  signal: RoleSignal
  /** True when this project can actually check this role. */
  available: boolean
  /** Why it cannot be checked, when it cannot. Null when it can. */
  reason: string | null
}

/**
 * Whether a role can be verified in this project, and why not when it cannot.
 *
 * ── THIS IS THE ENFORCEMENT POINT FOR REQUIREMENT 24.6 ─────────────────────
 *
 * The dispatcher calls this BEFORE spending a token. A `verify-stage` role whose stage the
 * project does not configure is skipped with a reason, not run and then reported as
 * passing — because `runTask` returns `ok: true` for a task with no verification
 * configured (Requirement 5.8, correct for the single-agent case), so an unchecked role
 * would produce a confident, meaningless success. A consensus built from thirteen of those
 * would be thirteen confident nothings and would look exactly like a working swarm. That
 * failure mode is invisible from outside, which is why it is refused here rather than
 * warned about.
 *
 * `plan-artifact` and `citations` roles are always verifiable: their signals are properties
 * of their own output, and every project has a filesystem.
 */
export function roleVerification(
  role: Role,
  configuredStages: readonly VerifyStage[],
): RoleVerification {
  const definition = ROLE_DEFINITIONS[role]
  const signal = definition.signal
  if (signal.kind !== 'verify-stage') {
    return { role, signal, available: true, reason: null }
  }
  const available = configuredStages.includes(signal.stage)
  return {
    role,
    signal,
    available,
    reason: available
      ? null
      : `this project configures no "${signal.stage}" stage, and the ${definition.title} role ` +
        'is graded by it. Running the role anyway would report success having verified ' +
        'nothing, so it is skipped',
  }
}

/** Roles this project can actually verify, and the ones it cannot. */
export function partitionRoles(
  roles: readonly Role[],
  configuredStages: readonly VerifyStage[],
): { verifiable: RoleVerification[]; unverifiable: RoleVerification[] } {
  const verifiable: RoleVerification[] = []
  const unverifiable: RoleVerification[] = []
  for (const role of roles) {
    const verification = roleVerification(role, configuredStages)
    if (verification.available) verifiable.push(verification)
    else unverifiable.push(verification)
  }
  return { verifiable, unverifiable }
}

/**
 * Throw unless a role's signal resolves in this project.
 *
 * The dispatcher does NOT call this — it partitions and skips instead, because refusing a
 * whole swarm because one role's stage is missing would be worse than running twelve. This
 * is for a caller that wants the strict contract, and for the test that proves the table
 * is complete.
 */
export function assertRoleVerifiable(
  role: Role,
  configuredStages: readonly VerifyStage[],
): void {
  const verification = roleVerification(role, configuredStages)
  if (!verification.available) throw new Error(verification.reason!)
}

/**
 * The narrowed instruction a role's sub-run is given.
 *
 * Built here rather than in the dispatcher so a role's prompt is one thing in one place,
 * and so a test can assert the role's own instruction actually reaches the model.
 */
export function rolePrompt(role: Role, taskPrompt: string, context?: string): string {
  const definition = ROLE_DEFINITIONS[role]
  const lines = [
    `You are acting as the ${definition.title} role on a larger task.`,
    '',
    `YOUR SCOPE: ${definition.instruction}`,
    '',
    `YOU WILL BE GRADED BY: ${describeSignal(definition.signal)}.`,
    'Nothing else you produce counts, and work outside your scope is discarded by the merge step.',
  ]

  if (!definition.edits) {
    lines.push(
      '',
      'You do NOT write files in this role. Report your findings in the final message.',
    )
  }
  if (definition.signal.kind === 'citations') {
    lines.push(
      '',
      'Every claim must name the path it came from, written as `path/to/file.ts` or ' +
        '`path/to/file.ts:42`. A path that does not exist in this repository fails this role. ' +
        `If you find nothing, say exactly ${NO_FINDINGS_TOKEN} and stop.`,
    )
  }
  if (definition.signal.kind === 'plan-artifact') {
    lines.push(
      '',
      'Your output is the plan artifact itself: send a "plan" action whose artifacts carry ' +
        'your work. A run that writes no plan document fails this role.',
    )
  }
  if (context !== undefined && context.trim() !== '') {
    lines.push('', '# What other roles have produced so far', '', context.trim())
  }
  lines.push('', '# The overall task', '', taskPrompt)
  return lines.join('\n')
}
