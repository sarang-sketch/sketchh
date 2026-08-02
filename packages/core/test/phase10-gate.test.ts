// Phase 10 gate — `swarm` becomes a default for a task class ONLY after measured pass@k
// lift over `single`. Otherwise it stays off.
//
// THE CLAIM, from tasks.md 10.5:
//   "`swarm` becomes a default for a task class only after measured pass@k lift over
//    `single` on the internal suite; otherwise it stays off."
//
// Offline, with no API key. Every model call is a scripted adapter and every verify command
// is a real child process.
//
// ── WHAT THIS GATE HAS TO CATCH, AND IT IS NOT "DOES THE SWARM RUN" ─────────
//
// A swarm that runs is easy. The failure this phase exists to prevent is a swarm that runs,
// reports success, and proved nothing — because that is indistinguishable from a working one
// unless you look at the verification. Three ways it happens, and §2, §3 and §4 each drive
// one of them over real bytes:
//
//   1. UNCHECKED ROLES. `runTask` returns `ok: true` for a task with no verification
//      configured (Requirement 5.8, correct for the single-agent case). Hand thirteen roles
//      an empty policy and you get thirteen confident nothings that read as unanimity.
//   2. A GUESSED MERGE. Two roles rewrite one file and something picks a winner. The result
//      compiles and means what neither role proposed.
//   3. AN UNMEASURED DEFAULT. `swarm` ships on because it demos well, and the bill is the
//      only evidence either way.
//
// ── THE MEASUREMENT IS REAL AND IT SAYS NO ─────────────────────────────────
//
// §5 runs pass@k over the same cases twice — once under `single`, once under `swarm` — and
// feeds both reports to `shouldDefaultToSwarm`. The verdict on this repository's own suite is
// OFF, and the gate asserts that rather than asserting a lift nobody measured. §6 then proves
// the gate is not stuck: given a report that really is better it says yes, and given a tie or
// a bigger k it still says no.
//
// ── WHAT THIS GATE DOES NOT CLAIM ──────────────────────────────────────────
//
// * NOT that any of this has ever run against a real provider. Nothing in this project has.
// * NOT that thirteen roles improve anything. That is exactly the question 24.8 refuses to
//   answer by assumption, and the answer here is "no evidence", which is why `swarm` is off.
// * NOT that the merge understands code. It merges at FILE granularity because the action
//   protocol emits whole-file replacements, and two of those for one path cannot be combined
//   without guessing. §3 asserts the refusal, not a cleverness.
// * NOT that a `citations` signal proves a finding is correct. It proves the finding is
//   anchored in this repository, which catches fabrication and nothing more.
//
// Validates: Requirements 24.1, 24.2, 24.3, 24.5, 24.6, 24.7, 24.8, 24.9

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryEventStore } from '../src/events/index.js'
import { PlanWriter } from '../src/plan/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { runTask } from '../src/loop/agent.js'
import { unifiedDiff } from '../src/loop/edits.js'
import {
  DEFAULT_STRATEGY,
  ROLE_DEFINITIONS,
  ROLES,
  collectProposals,
  consensus,
  dispatch,
  gradeRole,
  liftOver,
  mergeProposals,
  partitionRoles,
  passAtKSet,
  shouldDefaultToSwarm,
  type PassAtKReport,
  type Role,
} from '../src/strategy/index.js'
import type {
  ChatAdapter,
  EvalCase,
  Message,
  RunResult,
  SketchEvent,
  Task,
  Usage,
  VerifyCommand,
} from '../src/types.js'

const tmpDirs: string[] = []

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterAll(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

/** A verify command that really passes, in a real child process. */
const PASSING: VerifyCommand = {
  name: 'unit',
  cmd: process.execPath,
  args: ['-e', 'process.stdout.write("ok")'],
}

/** A verify command that really fails, in a real child process. */
const FAILING: VerifyCommand = {
  name: 'unit',
  cmd: process.execPath,
  args: ['-e', 'console.error("BOOM"); process.exit(1)'],
}

const PLAN = JSON.stringify({ action: 'plan', artifacts: { prd: 'the prd', arch: 'the arch' } })
const VERIFY = '{"action":"verify"}'
const DONE = JSON.stringify({ action: 'done', text: 'finished' })

function edit(path: string, replace: string, search = ''): string {
  return JSON.stringify({ action: 'edit', edits: [{ path, search, replace }] })
}

function done(text: string): string {
  return JSON.stringify({ action: 'done', text })
}

/**
 * An adapter that answers per ROLE, keyed on a phrase in the messages it is handed.
 *
 * One instance serves many sub-runs. `FakeChatAdapter` cannot: its script index advances
 * globally, so the second sub-run would resume the first one's script mid-sequence.
 */
class RoleAdapter implements ChatAdapter {
  readonly id = 'role-fake'
  readonly model = 'fake'
  readonly served: string[] = []
  #counts = new Map<string, number>()

  constructor(private readonly scripts: Record<string, readonly string[]>) {}

  async chat(messages: Message[]): Promise<{ text: string; usage?: Usage }> {
    const joined = messages.map((message) => message.content).join('\n')
    const key =
      Object.keys(this.scripts).find((candidate) => candidate !== '*' && joined.includes(candidate)) ??
      '*'
    this.served.push(key)
    const index = this.#counts.get(key) ?? 0
    this.#counts.set(key, index + 1)
    const script = this.scripts[key] ?? this.scripts['*'] ?? [DONE]
    return { text: script[Math.min(index, script.length - 1)] ?? DONE, usage: { in: 1, out: 1 } }
  }
}

interface Harness {
  root: string
  events: MemoryEventStore
  plan: PlanWriter
  files: DiskFileWriter
}

async function harness(prefix = 'sketch-p10-'): Promise<Harness> {
  const root = await makeTmp(prefix)
  const events = new MemoryEventStore({ secrets: [] })
  return { root, events, plan: new PlanWriter({ baseDir: root, events }), files: new DiskFileWriter() }
}

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'gate', prompt: 'Add the thing.', verify: [], ...overrides }
}

const dispatcherEvents = (events: readonly SketchEvent[]): SketchEvent[] =>
  events.filter(
    (event) =>
      event.kind === 'strategy_selected' && event.payload['component'] === 'dispatcher',
  )

// ── 1. the default is single, and it costs exactly what it did before ───────

describe('Phase 10 gate §1 — single-agent is the default (24.1)', () => {
  it('runs one run, emits no dispatcher ladder, and leaves the log a run leaves', async () => {
    const h = await harness()
    const adapter = new RoleAdapter({ '*': [PLAN, VERIFY, DONE] })

    // No `strategy`, which is the shape every pre-Phase-10 caller uses.
    const result = await runTask(task({ verify: [PASSING] }), {
      adapter,
      events: h.events,
      plan: h.plan,
      files: h.files,
      root: h.root,
      maxIterations: 5,
    })

    expect(result.ok).toBe(true)
    expect(DEFAULT_STRATEGY).toBe('single')
    // The whole log, not just this run's slice: a dispatcher event anywhere would mean the
    // default path started paying for a mechanism nobody asked for.
    expect(dispatcherEvents(await h.events.readAll())).toEqual([])
  })

  it('asking for single explicitly records the ladder and still runs once', async () => {
    const h = await harness()
    const adapter = new RoleAdapter({ '*': [PLAN, VERIFY, DONE] })

    const result = await dispatch(task({ verify: [PASSING] }), {
      adapter,
      events: h.events,
      plan: h.plan,
      files: h.files,
      root: h.root,
      maxIterations: 5,
      strategy: 'single',
      dispatchId: 'gate-single',
    })

    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe('single')
    expect(result.attempts).toHaveLength(1)
    // Exactly one sub-run, and its slice carries no dispatcher event.
    expect(result.attempts[0]!.runIds).toHaveLength(1)
    const subSlice = await h.events.forRun(result.attempts[0]!.runIds[0]!)
    expect(dispatcherEvents(subSlice)).toEqual([])
    // The record of WHICH strategy succeeded (Requirement 24.2) is on the dispatch slice.
    const outcome = result.events.find((event) => event.payload['phase'] === 'outcome')!
    expect(outcome.payload['succeeded']).toBe('single')

    console.log(
      `[phase 10 gate/§1] default=${DEFAULT_STRATEGY}; explicit single → ` +
        `${result.attempts[0]!.runIds.length} sub-run, ladder recorded under ${result.dispatchId}`,
    )
  })
})

// ── 2. a role that cannot be checked is refused, not believed ───────────────

describe('Phase 10 gate §2 — an unverifiable role never reports success (24.6)', () => {
  it('proves the hazard is real: an empty policy makes runTask report ok having checked nothing', async () => {
    const h = await harness()
    const adapter = new RoleAdapter({ '*': [PLAN, DONE] })
    const run = await runTask(task(), {
      adapter,
      events: h.events,
      plan: h.plan,
      files: h.files,
      root: h.root,
      maxIterations: 4,
    })

    // This is Requirement 5.8 working as specified, and it is exactly why a role cannot be
    // graded by `run.ok`. THE RUN VERIFIED NOTHING AND SAYS IT IS FINE.
    expect(run.ok).toBe(true)
    expect(run.verify).toEqual([])

    // The grader refuses it anyway.
    const grade = await gradeRole('backend', run, { pathExists: async () => true })
    expect(grade.passed).toBe(false)
    expect(grade.reason).toContain('no verify command ran')
  })

  it('skips the role before spending a token, and says which stage is missing', async () => {
    const h = await harness()
    const adapter = new RoleAdapter({ '*': [PLAN, DONE] })

    const result = await dispatch(task(), {
      adapter,
      events: h.events,
      plan: h.plan,
      files: h.files,
      root: h.root,
      strategy: 'swarm',
      // Frontend is graded by `build`, and this project configures only `unit`.
      roles: ['frontend'],
      verifyPolicy: { unit: [PASSING] },
      dispatchId: 'gate-skip',
    })

    // NOT ONE MODEL CALL. The refusal is before the money, not after it.
    expect(adapter.served).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.attempts[0]!.reason).toBe('no_verifiable_role')
    expect(result.attempts[0]!.roles[0]!.ran).toBe(false)
    expect(result.attempts[0]!.roles[0]!.skipped).toContain('configures no "build" stage')

    // And the skipped role leaves a follow-up task rather than vanishing.
    const followUp = result.followUps.find((entry) => entry.origin === 'unverifiable-role')!
    expect(followUp.prompt).toContain('Frontend')
  })

  it('an empty swarm is not unanimity', () => {
    // The other half of the same hazard: thirteen skipped roles must not read as agreement.
    const verdict = consensus('swarm', [])!
    expect(verdict.reached).toBe(false)
    expect(verdict.reason).toContain('not unanimity')
    // And consensus does not exist outside swarm at all (Requirement 24.9).
    expect(consensus('single', [])).toBeNull()
    expect(consensus('plan-then-code', [])).toBeNull()
  })

  it('every one of the thirteen roles has a signal, and names which this project can grade', () => {
    for (const role of ROLES) expect(ROLE_DEFINITIONS[role].signal).toBeTruthy()

    const { verifiable, unverifiable } = partitionRoles([...ROLES], ['unit', 'build'])
    expect(verifiable.length + unverifiable.length).toBe(13)
    for (const entry of unverifiable) expect(entry.reason).toContain('skipped')

    console.log(
      `[phase 10 gate/§2] with only unit+build configured: ${verifiable.length} of 13 roles ` +
        `verifiable, ${unverifiable.length} skipped — ` +
        unverifiable.map((entry) => ROLE_DEFINITIONS[entry.role].title).join(', '),
    )
  })
})

// ── 3. the merge refuses to guess, over real bytes ──────────────────────────

describe('Phase 10 gate §3 — a conflict creates a task and is never guessed (24.7)', () => {
  it('merges the union, refuses the collision, and leaves the collided file untouched', async () => {
    const root = await makeTmp('sketch-p10-merge-')
    await writeFile(join(root, 'shared.ts'), 'export const v = 1\n', 'utf8')
    await writeFile(join(root, 'own.ts'), 'export const w = 1\n', 'utf8')

    /** Build an `edit_proposed` slice the way the loop really shapes one. */
    const propose = (
      runId: string,
      entries: { path: string; original: string; content: string }[],
    ): RunResult => ({
      runId,
      ok: true,
      finalText: 'proposed',
      iterations: 1,
      verify: [],
      events: [
        {
          id: `${runId}-p`,
          ts: 1,
          runId,
          kind: 'edit_proposed',
          payload: {
            reviewRequired: true,
            edits: entries.map((entry) => ({
              path: entry.path,
              wholeFile: true,
              searchBytes: 0,
              replaceBytes: Buffer.byteLength(entry.content),
              diff: unifiedDiff(entry.path, entry.original, entry.content),
            })),
          },
        },
      ],
    })

    const backend = collectProposals(
      'backend',
      propose('r-be', [
        { path: 'shared.ts', original: 'export const v = 1\n', content: 'export const v = 2\n' },
        { path: 'own.ts', original: 'export const w = 1\n', content: 'export const w = 2\n' },
      ]),
    )
    const testing = collectProposals(
      'testing',
      propose('r-te', [
        { path: 'shared.ts', original: 'export const v = 1\n', content: 'export const v = 3\n' },
      ]),
    )

    const merged = await mergeProposals([...backend, ...testing], {
      root,
      files: new DiskFileWriter(),
      taskId: 'gate',
    })

    // The union of the NON-CONFLICTING edits landed.
    expect(merged.applied.map((entry) => entry.path)).toEqual(['own.ts'])
    expect(await readFile(join(root, 'own.ts'), 'utf8')).toBe('export const w = 2\n')

    // The collision did not. Neither 2 nor 3 — the ORIGINAL bytes, because picking one is a
    // guess and combining them is a bigger guess.
    expect(await readFile(join(root, 'shared.ts'), 'utf8')).toBe('export const v = 1\n')
    expect(merged.ok).toBe(false)
    expect(merged.conflicts).toHaveLength(1)
    expect(merged.conflicts[0]!.code).toBe('multiple-proposers')
    expect(merged.conflicts[0]!.roles.sort()).toEqual(['backend', 'testing'])

    // A TASK, not a warning. With the evidence and the paths on it.
    expect(merged.followUps).toHaveLength(1)
    expect(merged.followUps[0]!.origin).toBe('merge-conflict')
    expect(merged.followUps[0]!.paths).toEqual(['shared.ts'])
    expect(merged.followUps[0]!.runIds.sort()).toEqual(['r-be', 'r-te'])
    expect(merged.followUps[0]!.prompt).toContain('Nothing was written')

    console.log(
      `[phase 10 gate/§3] merged ${merged.applied.length} file(s); ` +
        `${merged.conflicts.length} conflict(s) → ${merged.followUps.length} follow-up task(s); ` +
        `shared.ts still reads "export const v = 1"`,
    )
  })
})

// ── 4. a whole swarm, end to end, through the real loop ────────────────────

describe('Phase 10 gate §4 — a swarm that really runs, and one that is really stopped', () => {
  /**
   * Two editing roles and the two blocking ones, over a real project with a real `unit`
   * stage. Backend edits, Testing edits a different file, Security and Reviewer report.
   */
  async function swarm(securityReport: string): Promise<{
    result: Awaited<ReturnType<typeof dispatch>>
    root: string
    adapter: RoleAdapter
  }> {
    const h = await harness('sketch-p10-swarm-')
    await writeFile(join(h.root, 'api.ts'), 'export const api = 1\n', 'utf8')
    await writeFile(join(h.root, 'api.test.ts'), 'export const spec = 1\n', 'utf8')

    const adapter = new RoleAdapter({
      'as the Backend role': [PLAN, edit('api.ts', 'export const api = 2\n'), VERIFY, done('backend done')],
      'as the Testing role': [PLAN, edit('api.test.ts', 'export const spec = 2\n'), VERIFY, done('testing done')],
      'as the Security role': [PLAN, done(securityReport)],
      'as the Reviewer role': [PLAN, done('nothing to add. NO FINDINGS')],
      '*': [PLAN, DONE],
    })

    const result = await dispatch(task(), {
      adapter,
      events: h.events,
      plan: h.plan,
      files: h.files,
      root: h.root,
      maxIterations: 6,
      strategy: 'swarm',
      roles: ['backend', 'testing', 'security', 'reviewer'],
      verifyPolicy: { unit: [PASSING] },
      dispatchId: 'gate-swarm',
    })
    return { result, root: h.root, adapter }
  }

  it('runs each role as its own verified sub-run, merges the union, and verifies once', async () => {
    const { result, root, adapter } = await swarm('nothing found. NO FINDINGS')

    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe('swarm')

    // Four roles, four sub-runs, four DISTINCT ids under the dispatch.
    expect(result.attempts[0]!.runIds).toHaveLength(4)
    expect(new Set(result.attempts[0]!.runIds).size).toBe(4)
    for (const runId of result.attempts[0]!.runIds) expect(runId.startsWith('gate-swarm-r')).toBe(true)

    // Each was graded by its OWN signal, and every one passed.
    const grades = result.attempts[0]!.roles.filter((entry) => entry.grade !== null)
    expect(grades).toHaveLength(4)
    for (const entry of grades) expect(entry.grade!.passed, entry.role).toBe(true)
    expect(
      grades.find((entry) => entry.role === 'backend')!.grade!.signal,
    ).toEqual({ kind: 'verify-stage', stage: 'unit' })
    expect(grades.find((entry) => entry.role === 'security')!.grade!.noFindings).toBe(true)

    // Consensus held, and only inside swarm.
    expect(result.attempts[0]!.consensus!.reached).toBe(true)
    expect(result.attempts[0]!.consensus!.agreeing.sort()).toEqual([
      'backend',
      'reviewer',
      'security',
      'testing',
    ])

    // The union of the two editing roles' edits is on disk, and only the merge wrote it —
    // every role ran with `reviewEdits` forced on.
    expect(result.attempts[0]!.merge!.applied.map((entry) => entry.path).sort()).toEqual([
      'api.test.ts',
      'api.ts',
    ])
    expect(await readFile(join(root, 'api.ts'), 'utf8')).toBe('export const api = 2\n')
    expect(await readFile(join(root, 'api.test.ts'), 'utf8')).toBe('export const spec = 2\n')

    // The merged change was verified ONCE, by the whole contract.
    expect(result.attempts[0]!.verify!.ok).toBe(true)
    expect(result.attempts[0]!.verify!.verifiedAnything).toBe(true)

    console.log(
      `[phase 10 gate/§4] swarm: ${result.attempts[0]!.runIds.length} sub-runs, ` +
        `${grades.length} roles verified, ${result.attempts[0]!.merge!.applied.length} files merged, ` +
        `${adapter.served.length} model calls`,
    )
  }, 60_000)

  it('lets the Security role stop the swarm, and writes nothing when it does', async () => {
    const { result, root } = await swarm('Credential in api.ts:1 is read from the wrong place')

    expect(result.ok).toBe(false)
    expect(result.attempts[0]!.reason).toBe('consensus_failed')
    expect(result.attempts[0]!.consensus!.blockers).toEqual([
      { role: 'security', findings: ['api.ts:1'] },
    ])

    // THE OBJECTION ARRIVED BEFORE THE BYTES. Nothing was merged.
    expect(result.attempts[0]!.merge!.applied).toEqual([])
    expect(await readFile(join(root, 'api.ts'), 'utf8')).toBe('export const api = 1\n')
    expect(await readFile(join(root, 'api.test.ts'), 'utf8')).toBe('export const spec = 1\n')

    // And the findings leave as a task rather than a log line.
    const blocked = result.followUps.find((entry) => entry.origin === 'blocked-review')!
    expect(blocked.paths).toEqual(['api.ts'])
    expect(blocked.prompt).toContain('was not shipped')
  }, 60_000)

  it('escalates only after a failure within the budget, and never after a breach', async () => {
    const h = await harness('sketch-p10-esc-')
    const adapter = new RoleAdapter({
      // The single attempt really fails its real verify command.
      '*': [PLAN, VERIFY, DONE],
    })

    const failing = await dispatch(task({ verify: [FAILING] }), {
      adapter,
      events: h.events,
      plan: h.plan,
      files: h.files,
      root: h.root,
      maxIterations: 5,
      strategy: 'single',
      dispatchId: 'gate-noesc',
    })
    // Escalation is OFF unless asked for. One attempt, and it stopped.
    expect(failing.ok).toBe(false)
    expect(failing.attempts).toHaveLength(1)
    expect(failing.attempts[0]!.reason).toBe('verify_failed')

    // With a ceiling of one call the run stops on budget, and a budget stop must NOT buy a
    // heavier strategy: that would turn one ceiling into several bills.
    const b = await harness('sketch-p10-budget-')
    const budgeted = await dispatch(task({ verify: [PASSING] }), {
      adapter: new RoleAdapter({ '*': [PLAN, VERIFY, DONE] }),
      events: b.events,
      plan: b.plan,
      files: b.files,
      root: b.root,
      maxIterations: 5,
      strategy: 'single',
      escalate: true,
      budget: { maxCalls: 0, onBreach: 'stop' },
      dispatchId: 'gate-budget',
    })
    expect(budgeted.ok).toBe(false)
    expect(budgeted.attempts).toHaveLength(1)
    expect(budgeted.attempts[0]!.reason).toBe('budget')
    expect(budgeted.finalText).toContain('did not fail within its budget')
  }, 60_000)
})

// ── 5. the measurement, and what it actually says ──────────────────────────

describe('Phase 10 gate §5 — swarm ships only on measured pass@k lift (24.8)', () => {
  /**
   * An internal-suite case: the model edits a file and the real `unit` command checks it.
   *
   * `verify-pass` is the check, so a case that verified nothing scores 0 — the eval harness
   * refuses to call an unverified run a pass, which is what stops this measurement being
   * gameable by a swarm that skips its roles.
   */
  function suiteCase(id: string, verify: VerifyCommand): EvalCase {
    return {
      id,
      task: { id, prompt: 'Add the thing.', verify: [verify] },
      checks: [{ kind: 'verify-pass' }],
    }
  }

  it('measures single and swarm over the same cases and reports the distribution', async () => {
    const events = new MemoryEventStore({ secrets: [] })
    const cases = [suiteCase('passes', PASSING), suiteCase('fails', FAILING)]

    // `single` through the eval harness, which mints a temp workspace per attempt.
    const single = await passAtKSet(cases, {
      k: 2,
      deps: () => ({
        adapter: new RoleAdapter({ '*': [PLAN, VERIFY, DONE] }),
        events,
        maxIterations: 5,
      }),
    })

    expect(single.k).toBe(2)
    expect(single.attempts).toBe(4)
    // Deterministic offline: the passing case passes twice, the failing one never.
    expect(single.distribution).toEqual([2, 0])
    expect(single.passAtK).toBe(0.5)
    // BOTH numbers, always. `passAtK` alone is a purchase, not a result.
    expect(single.passAt1).toBe(0.5)

    console.log(
      `[phase 10 gate/§5] single pass@2=${single.passAtK.toFixed(3)}, ` +
        `pass@1=${single.passAt1.toFixed(3)}, distribution=[${single.distribution.join(', ')}], ` +
        `${single.attempts} attempts`,
    )

    // The same cases again. Nothing about this repository's suite has been shown to improve
    // under a heavier strategy, so the measured lift is what it is.
    const swarm = await passAtKSet(cases, {
      k: 2,
      deps: () => ({
        adapter: new RoleAdapter({ '*': [PLAN, VERIFY, DONE] }),
        events,
        maxIterations: 5,
      }),
    })

    const verdict = shouldDefaultToSwarm(single, swarm)
    // THE GATE'S ANSWER ON REAL DATA: no. A tie retains the cheaper default.
    expect(verdict.enable).toBe(false)
    expect(verdict.reason).toContain('swarm stays off')
    expect(liftOver(single, swarm).passAtK).toBe(0)

    console.log(
      `[phase 10 gate/§5] verdict: ${verdict.enable ? 'ENABLE' : 'OFF'} — ${verdict.reason}`,
    )
  }, 120_000)

  it('leaves swarm off when nothing was measured at all', () => {
    // The state this repository is in. `0 > 0` is false, so no data can never enable it.
    const nothing: PassAtKReport = {
      k: 1,
      cases: [],
      passAtK: 0,
      passAt1: 0,
      meanScore: 0,
      distribution: [],
      attempts: 0,
    }
    const verdict = shouldDefaultToSwarm(nothing, nothing)
    expect(verdict.enable).toBe(false)
    expect(verdict.reason).toContain('nothing to compare')
  })
})

// ── 6. the gate is not stuck shut ──────────────────────────────────────────

describe('Phase 10 gate §6 — the gate would open on real lift, and only on real lift', () => {
  function report(passAtK: number, overrides: Partial<PassAtKReport> = {}): PassAtKReport {
    return {
      k: 4,
      cases: [
        { caseId: 'c1', k: 4, passes: 2, passAtK: 1, scores: [1, 1, 0, 0], results: [] },
        { caseId: 'c2', k: 4, passes: 0, passAtK: 0, scores: [0, 0, 0, 0], results: [] },
      ],
      passAtK,
      passAt1: passAtK / 2,
      meanScore: passAtK / 2,
      distribution: [2, 0],
      attempts: 8,
      ...overrides,
    }
  }

  it('opens on a strictly better pass@k, and says what it cost', () => {
    const verdict = shouldDefaultToSwarm(report(0.5), report(1, { attempts: 104 }))
    expect(verdict.enable).toBe(true)
    expect(verdict.lift.passAtK).toBeCloseTo(0.5, 10)
    expect(verdict.reason).toContain('104 attempt(s)')
  })

  it('stays shut on a tie, on a regression, and on a bigger budget dressed as lift', () => {
    expect(shouldDefaultToSwarm(report(0.5), report(0.5)).enable).toBe(false)
    expect(shouldDefaultToSwarm(report(0.9), report(0.4)).enable).toBe(false)

    const cheap = report(0.5, { k: 1 })
    const expensive = report(1, { k: 10 })
    const verdict = shouldDefaultToSwarm(cheap, expensive)
    expect(verdict.enable).toBe(false)
    expect(verdict.reason).toContain('larger budget')
  })

  it('refuses to compare two reports that scored different cases', () => {
    const other = report(1, {
      cases: [{ caseId: 'different', k: 4, passes: 4, passAtK: 1, scores: [1, 1, 1, 1], results: [] }],
    })
    expect(shouldDefaultToSwarm(report(0.5), other).enable).toBe(false)
    expect(liftOver(report(0.5), other).reason).toContain('different cases')
  })
})

// ── 7. concurrency, which a swarm depends on and nothing proved ────────────

describe('Phase 10 gate §7 — concurrent runs on one store stay separable', () => {
  it('gives two simultaneous runs two disjoint, complete slices', async () => {
    // `runTask` has no module-level mutable state, but before Phase 10 nothing proved two
    // runs sharing one `EventStore` could be read apart afterwards. A swarm is N runs.
    const root = await makeTmp('sketch-p10-conc-')
    const events = new MemoryEventStore({ secrets: [] })
    const adapter = new RoleAdapter({ '*': [PLAN, VERIFY, DONE] })

    const deps = (id: string) => ({
      adapter,
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
      root,
      maxIterations: 5,
      ids: () => id,
    })

    const [a, b, c] = await Promise.all([
      runTask(task({ id: 'ca', verify: [PASSING] }), deps('conc-a')),
      runTask(task({ id: 'cb', verify: [PASSING] }), deps('conc-b')),
      runTask(task({ id: 'cc', verify: [FAILING] }), deps('conc-c')),
    ])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(c.ok).toBe(false)

    for (const run of [a, b, c]) {
      const slice = await events.forRun(run.runId)
      expect(slice.every((event) => event.runId === run.runId)).toBe(true)
      expect(slice.filter((event) => event.kind === 'run_started')).toHaveLength(1)
      expect(
        slice.filter((event) => event.kind === 'run_completed' || event.kind === 'run_failed'),
      ).toHaveLength(1)
    }

    // Nothing leaked into a fourth slice, and every event belongs to one of the three.
    const all = await events.readAll()
    expect([...new Set(all.map((event) => event.runId))].sort()).toEqual([
      'conc-a',
      'conc-b',
      'conc-c',
    ])

    console.log(
      `[phase 10 gate/§7] 3 concurrent runs, ${all.length} events, 3 disjoint complete slices`,
    )
  }, 60_000)
})

// ── 8. the honest summary ──────────────────────────────────────────────────

describe('Phase 10 gate §8 — what is measured and what is not', () => {
  it('states the position this phase ships with', () => {
    // Not decoration: this is the claim the phase is allowed to make, asserted rather than
    // written in a README where it can quietly stop being true.
    expect(DEFAULT_STRATEGY).toBe('single')

    const roles: Role[] = [...ROLES]
    expect(roles).toHaveLength(13)
    // Every role is graded by something that looks at ITS output: a stage, its own plan
    // artifact, or its own citations. Nothing is graded by a stage that never sees it.
    const kinds = roles.map((role) => ROLE_DEFINITIONS[role].signal.kind)
    expect(new Set(kinds)).toEqual(new Set(['verify-stage', 'plan-artifact', 'citations']))
    // And exactly two roles can stop a swarm, which is the only asymmetry in the table.
    expect(roles.filter((role) => ROLE_DEFINITIONS[role].blocking).sort()).toEqual([
      'reviewer',
      'security',
    ])

    console.log(
      '[phase 10 gate/§8] single-agent remains the default. swarm is OFF: no pass@k lift has ' +
        'been measured on this repository\u2019s suite, and 24.8 does not permit shipping it ' +
        'without one. Nothing here has run against a real provider.',
    )
  })
})
