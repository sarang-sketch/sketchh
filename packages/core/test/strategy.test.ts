// Phase 10 unit tests: the thirteen roles, grading, deterministic merge, the dispatcher,
// and pass@k.
//
// Uses REAL: the filesystem (temp dirs), a real MemoryEventStore, a real DiskFileWriter, the
// real unified-diff parser and hunk applier, the real `runTask` for the end-to-end cases.
// The substituted collaborators are the model (a scripted adapter) and, where the test is
// about the LADDER rather than the loop, `runTask` itself through the `runner` seam.
//
// Validates: Requirements 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9, 25.3

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryEventStore } from '../src/events/index.js'
import { PlanWriter } from '../src/plan/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { unifiedDiff } from '../src/loop/edits.js'
import { runTask, type RunTaskDeps } from '../src/loop/agent.js'
import type {
  ChatAdapter,
  EvalCase,
  Message,
  RunResult,
  SketchEvent,
  Task,
  Usage,
  VerifyResult,
} from '../src/types.js'
import {
  ROLES,
  ROLE_DEFINITIONS,
  NO_FINDINGS_TOKEN,
  allRoles,
  editingRoles,
  isRole,
  partitionRoles,
  roleCapabilities,
  rolePrompt,
  roleVerification,
  type Role,
} from '../src/strategy/roles.js'
import { extractCitations, gradeRole, type PathExists } from '../src/strategy/grade.js'
import {
  collectProposals,
  consensus,
  mergeProposals,
  proposedPaths,
} from '../src/strategy/merge.js'
import {
  dispatch,
  configuredStages,
  planTextFrom,
  terminalReason,
  ESCALATABLE_REASONS,
  SWARM_ORDER,
  type DispatchDeps,
  type RunTaskFn,
} from '../src/strategy/dispatcher.js'
import {
  DEFAULT_STRATEGY,
  ESCALATION_LADDER,
  STRATEGIES,
  heavierThan,
  isStrategy,
} from '../src/strategy/strategies.js'
import {
  emptyReport,
  liftOver,
  passAtK,
  passAtKSet,
  shouldDefaultToSwarm,
  type PassAtKReport,
} from '../src/strategy/passk.js'

// ── harness ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-strategy-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

function task(overrides: Partial<Task> = {}): Task {
  return { id: 't1', prompt: 'Build the thing.', verify: [], ...overrides }
}

let eventSeq = 0
function event(runId: string, kind: SketchEvent['kind'], payload: Record<string, unknown> = {}): SketchEvent {
  eventSeq++
  return { id: `e${eventSeq}`, ts: eventSeq, runId, kind, payload }
}

function verifyResult(name: string, ok: boolean): VerifyResult {
  return { name, ok, exitCode: ok ? 0 : 1, stdout: '', stderr: '', durationMs: 1 }
}

/** A RunResult fixture, for the grader and the merge which both read one. */
function fakeRun(overrides: Partial<RunResult> = {}): RunResult {
  const runId = overrides.runId ?? 'r-fixture'
  return {
    runId,
    ok: true,
    finalText: 'done',
    iterations: 1,
    verify: [],
    events: [event(runId, 'run_started', { taskId: 't1' })],
    ...overrides,
  }
}

interface RunnerCall {
  task: Task
  deps: RunTaskDeps
  runId: string
}

interface RunnerReply {
  ok: boolean
  reason: string
  finalText?: string
  verify?: VerifyResult[]
  extraEvents?: (runId: string) => SketchEvent[]
}

/**
 * A `runTask` seam that answers from a script.
 *
 * Used for the tests about the LADDER: escalation, event shape, role partitioning. Those are
 * decisions the dispatcher makes about runs, and driving them through a real loop would mean
 * every assertion depended on a model script as well.
 */
function makeRunner(
  respond: (call: RunnerCall, index: number) => RunnerReply,
): { runner: RunTaskFn; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const runner: RunTaskFn = async (t, deps) => {
    const runId = deps.ids ? deps.ids() : 'r-unset'
    const call: RunnerCall = { task: t, deps, runId }
    calls.push(call)
    const reply = respond(call, calls.length - 1)
    const events: SketchEvent[] = [
      event(runId, 'run_started', { taskId: t.id }),
      ...(reply.extraEvents?.(runId) ?? []),
      event(runId, reply.ok ? 'run_completed' : 'run_failed', { ok: reply.ok, reason: reply.reason }),
    ]
    return {
      runId,
      ok: reply.ok,
      finalText: reply.finalText ?? (reply.ok ? 'done' : 'failed'),
      iterations: 1,
      verify: reply.verify ?? [],
      events,
    }
  }
  return { runner, calls }
}

/** Every path exists. */
const allExist: PathExists = async () => true
/** Nothing exists — the fabrication case. */
const noneExist: PathExists = async () => false

async function dispatchDeps(extra: Partial<DispatchDeps> = {}): Promise<DispatchDeps> {
  const root = await makeTmp()
  const events = new MemoryEventStore({ secrets: [] })
  return {
    adapter: { id: 'unused', chat: async () => ({ text: '{"action":"done","text":"x"}' }) },
    events,
    plan: new PlanWriter({ baseDir: root, events }),
    files: new DiskFileWriter(),
    root,
    pathExists: allExist,
    dispatchId: 'd1',
    ...extra,
  }
}

// ── the thirteen roles ──────────────────────────────────────────────────────

describe('the thirteen roles (24.4, 24.6)', () => {
  it('names exactly the thirteen roles Requirement 24.4 names, in its order', () => {
    expect([...ROLES]).toEqual([
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
    ])
    expect(ROLES).toHaveLength(13)
    expect(isRole('backend')).toBe(true)
    expect(isRole('bakend')).toBe(false)
  })

  it('gives every role a signal and a non-empty instruction — no role is a costume', () => {
    for (const definition of allRoles()) {
      expect(definition.signal).toBeTruthy()
      expect(['verify-stage', 'plan-artifact', 'citations']).toContain(definition.signal.kind)
      expect(definition.instruction.trim().length).toBeGreaterThan(20)
      expect(definition.capabilities.length).toBeGreaterThan(0)
    }
  })

  it('does NOT claim pairwise-unique signals, which 13 roles over 9 stages cannot have', () => {
    // The point of this test is that the CONTRADICTION is gone. An earlier draft asserted
    // uniqueness and bought it by grading the Planner with `typecheck`, which never looks at
    // a plan. Two roles sharing `unit` is correct: Backend and Testing both produce code the
    // unit suite runs.
    const stages = allRoles()
      .map((definition) => definition.signal)
      .filter((signal) => signal.kind === 'verify-stage')
      .map((signal) => (signal as { stage: string }).stage)
    expect(new Set(stages).size).toBeLessThan(stages.length)
    expect(stages.filter((stage) => stage === 'unit')).toHaveLength(2)
  })

  it('grades a role by something that actually looks at its output', () => {
    // Documents are graded by the document landing, findings by their anchors, and code by
    // the project's own tooling. Nothing is graded by a stage that never sees it.
    expect(ROLE_DEFINITIONS.planner.signal.kind).toBe('plan-artifact')
    expect(ROLE_DEFINITIONS.ceo.signal.kind).toBe('plan-artifact')
    expect(ROLE_DEFINITIONS.research.signal.kind).toBe('citations')
    expect(ROLE_DEFINITIONS.reviewer.signal.kind).toBe('citations')
    expect(ROLE_DEFINITIONS.security.signal.kind).toBe('citations')
    expect(ROLE_DEFINITIONS.backend.signal).toEqual({ kind: 'verify-stage', stage: 'unit' })
    expect(ROLE_DEFINITIONS.frontend.signal).toEqual({ kind: 'verify-stage', stage: 'build' })
  })

  it('only Security and Reviewer can block', () => {
    const blocking = allRoles().filter((definition) => definition.blocking).map((d) => d.role)
    expect(blocking.sort()).toEqual(['reviewer', 'security'])
  })

  it('marks exactly the editing roles as editing', () => {
    expect(editingRoles().map((definition) => definition.role)).toEqual([
      'architect',
      'backend',
      'frontend',
      'database',
      'testing',
      'documentation',
    ])
  })

  it('intersects a role capability list with the run grant and never widens it', () => {
    // Deployment is the only role that asks for proc:spawn, and it gets it only when the run
    // already holds it. A role table is a narrowing device.
    expect(roleCapabilities('deployment', ['fs:read:project'])).toEqual(['fs:read:project'])
    expect(roleCapabilities('deployment', ['fs:read:project', 'proc:spawn'])).toEqual([
      'fs:read:project',
      'proc:spawn',
    ])
    expect(roleCapabilities('deployment', [])).toEqual([])
    // And a grant holding something the role never asked for does not leak into the role.
    expect(roleCapabilities('research', ['fs:read:project', 'secrets:read'])).toEqual([
      'fs:read:project',
    ])
  })

  it('skips a verify-stage role the project cannot check, with a reason', () => {
    const verification = roleVerification('frontend', ['unit'])
    expect(verification.available).toBe(false)
    expect(verification.reason).toContain('configures no "build" stage')
    expect(verification.reason).toContain('skipped')
    expect(roleVerification('frontend', ['unit', 'build']).available).toBe(true)
  })

  it('never skips a plan-artifact or citations role: every project has a filesystem', () => {
    for (const role of ['ceo', 'planner', 'research', 'security', 'reviewer'] as const) {
      expect(roleVerification(role, []).available).toBe(true)
    }
  })

  it('partitions so a caller can skip before spending a token', () => {
    const { verifiable, unverifiable } = partitionRoles([...ROLES], ['unit'])
    expect(verifiable.map((entry) => entry.role)).toEqual([
      'ceo',
      'planner',
      'research',
      'backend',
      'security',
      'testing',
      'reviewer',
    ])
    expect(unverifiable.map((entry) => entry.role)).toEqual([
      'architect',
      'frontend',
      'database',
      'performance',
      'deployment',
      'documentation',
    ])
    for (const entry of unverifiable) expect(entry.reason).toBeTruthy()
  })

  it('puts the role own instruction and its grading signal in the prompt', () => {
    const prompt = rolePrompt('security', 'Add a login form.')
    expect(prompt).toContain(ROLE_DEFINITIONS.security.instruction.slice(0, 40))
    expect(prompt).toContain('You do NOT write files')
    expect(prompt).toContain(NO_FINDINGS_TOKEN)
    expect(prompt).toContain('Add a login form.')

    const backend = rolePrompt('backend', 'Add a login form.')
    expect(backend).toContain('"unit" verification stage')
    expect(backend).not.toContain('You do NOT write files')
  })

  it('passes accumulated context through, and omits the heading when there is none', () => {
    expect(rolePrompt('reviewer', 'x', '  ')).not.toContain('other roles have produced')
    expect(rolePrompt('reviewer', 'x', 'Backend wrote a file')).toContain('Backend wrote a file')
  })
})

// ── grading ─────────────────────────────────────────────────────────────────

describe('role grading (24.5, 24.6)', () => {
  it('FAILS a verify-stage role that verified nothing, even when the run reported ok', async () => {
    // THE HAZARD THIS WHOLE MECHANISM EXISTS FOR. `runTask` returns ok for a task with no
    // verification configured (Requirement 5.8), so an unchecked role reports confident,
    // meaningless success and thirteen of those look like a working swarm.
    const grade = await gradeRole('backend', fakeRun({ ok: true, verify: [] }), {
      pathExists: allExist,
    })
    expect(grade.passed).toBe(false)
    expect(grade.reason).toContain('no verify command ran')
    expect(grade.reason).toContain('has not passed')
  })

  it('passes a verify-stage role whose stage really passed', async () => {
    const grade = await gradeRole(
      'backend',
      fakeRun({ ok: true, verify: [verifyResult('unit', true)] }),
      { pathExists: allExist },
    )
    expect(grade.passed).toBe(true)
    expect(grade.reason).toContain('"unit" stage passed')
  })

  it('fails a verify-stage role whose stage failed', async () => {
    const grade = await gradeRole(
      'backend',
      fakeRun({ ok: false, verify: [verifyResult('unit', false)] }),
      { pathExists: allExist },
    )
    expect(grade.passed).toBe(false)
    expect(grade.reason).toContain('failed')
  })

  it('fails a verify-stage role whose stage passed but whose run did not complete', async () => {
    const grade = await gradeRole(
      'backend',
      fakeRun({ ok: false, verify: [verifyResult('unit', true)], finalText: 'Run aborted.' }),
      { pathExists: allExist },
    )
    expect(grade.passed).toBe(false)
    expect(grade.reason).toContain('did not complete')
  })

  it('grades a plan-artifact role by the plan document actually landing', async () => {
    const empty = await gradeRole('planner', fakeRun(), { pathExists: allExist })
    expect(empty.passed).toBe(false)
    expect(empty.reason).toContain('wrote no plan document')

    const withPlan = fakeRun({ runId: 'r-plan' })
    withPlan.events.push(event('r-plan', 'plan_written', { files: ['prd.md', 'arch.md'] }))
    const graded = await gradeRole('planner', withPlan, { pathExists: allExist })
    expect(graded.passed).toBe(true)
    expect(graded.reason).toContain('prd.md')
  })

  it('does not accept a plan_written event that wrote no files', async () => {
    const run = fakeRun({ runId: 'r-empty-plan' })
    run.events.push(event('r-empty-plan', 'plan_written', { files: [] }))
    expect((await gradeRole('ceo', run, { pathExists: allExist })).passed).toBe(false)
  })

  it('fails a findings role whose citations do not resolve — the fabrication signal', async () => {
    const run = fakeRun({ finalText: 'Injection risk in src/api/login.ts:42' })
    const grade = await gradeRole('security', run, { pathExists: noneExist })
    expect(grade.passed).toBe(false)
    expect(grade.fabricated).toEqual(['src/api/login.ts'])
    expect(grade.reason).toContain('do not exist in this repository')
  })

  it('passes a findings role whose citations resolve', async () => {
    const run = fakeRun({ finalText: 'Injection risk in src/api/login.ts:42' })
    const grade = await gradeRole('security', run, { pathExists: allExist })
    expect(grade.passed).toBe(true)
    expect(grade.citations).toEqual([{ path: 'src/api/login.ts', line: 42 }])
    expect(grade.noFindings).toBe(false)
  })

  it('passes a clean review that says so, and fails unanchored prose', async () => {
    const clean = await gradeRole('reviewer', fakeRun({ finalText: `Looks fine. ${NO_FINDINGS_TOKEN}` }), {
      pathExists: allExist,
    })
    expect(clean.passed).toBe(true)
    expect(clean.noFindings).toBe(true)

    const waffle = await gradeRole(
      'reviewer',
      fakeRun({ finalText: 'I have some concerns about the general approach here.' }),
      { pathExists: allExist },
    )
    expect(waffle.passed).toBe(false)
    expect(waffle.reason).toContain('cites none')
  })

  it('does not turn prose into a citation', () => {
    // A looser matcher would let a role satisfy its signal by writing `e.g.` — which is the
    // fabrication the check exists to catch.
    expect(extractCitations('This is fine, e.g. mostly. See i.e. above.')).toEqual([])
    expect(extractCitations('No paths here at all.')).toEqual([])
    expect(extractCitations('README.md is stale')).toEqual([{ path: 'README.md' }])
    expect(extractCitations('see `src/a/b.ts:7` and src/a/b.ts')).toEqual([
      { path: 'src/a/b.ts', line: 7 },
    ])
    // Windows separators normalise, because a model on Windows will emit them.
    expect(extractCitations('src\\a\\b.ts')).toEqual([{ path: 'src/a/b.ts' }])
  })
})

// ── deterministic merge ─────────────────────────────────────────────────────

describe('deterministic merge (24.7)', () => {
  function proposalRun(runId: string, entries: { path: string; original: string; content: string }[]): RunResult {
    const run = fakeRun({ runId })
    run.events.push(
      event(runId, 'edit_proposed', {
        reviewRequired: true,
        edits: entries.map((entry) => ({
          path: entry.path,
          wholeFile: true,
          searchBytes: 0,
          replaceBytes: Buffer.byteLength(entry.content),
          diff: unifiedDiff(entry.path, entry.original, entry.content),
        })),
      }),
    )
    return run
  }

  it('collects only entries that really became proposals', () => {
    const run = fakeRun({ runId: 'r-c' })
    run.events.push(
      event('r-c', 'edit_proposed', {
        edits: [
          { path: 'a.ts', wholeFile: true, diff: unifiedDiff('a.ts', '', 'x\n') },
          // Refused by prepareEdit — outside the root, or the search string was absent. It
          // never became a proposal and is not merge input.
          { path: 'b.ts', wholeFile: false },
        ],
      }),
    )
    expect(collectProposals('backend', run).map((p) => p.path)).toEqual(['a.ts'])
    expect(proposedPaths(run.events)).toEqual(['a.ts', 'b.ts'])
  })

  it('applies the union of non-conflicting edits', async () => {
    const root = await makeTmp()
    await writeFile(join(root, 'a.ts'), 'const a = 1\n', 'utf8')
    await writeFile(join(root, 'b.ts'), 'const b = 1\n', 'utf8')

    const backend = collectProposals(
      'backend',
      proposalRun('r-be', [{ path: 'a.ts', original: 'const a = 1\n', content: 'const a = 2\n' }]),
    )
    const frontend = collectProposals(
      'frontend',
      proposalRun('r-fe', [{ path: 'b.ts', original: 'const b = 1\n', content: 'const b = 2\n' }]),
    )

    const merged = await mergeProposals([...backend, ...frontend], {
      root,
      files: new DiskFileWriter(),
      taskId: 't1',
    })

    expect(merged.ok).toBe(true)
    expect(merged.conflicts).toEqual([])
    expect(merged.applied.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts'])
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 2\n')
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('const b = 2\n')
  })

  it('NEVER guesses a conflict: two roles on one path write nothing and create a task', async () => {
    const root = await makeTmp()
    await writeFile(join(root, 'a.ts'), 'const a = 1\n', 'utf8')

    const backend = collectProposals(
      'backend',
      proposalRun('r-be', [{ path: 'a.ts', original: 'const a = 1\n', content: 'const a = 2\n' }]),
    )
    const testing = collectProposals(
      'testing',
      proposalRun('r-te', [{ path: 'a.ts', original: 'const a = 1\n', content: 'const a = 3\n' }]),
    )

    const merged = await mergeProposals([...backend, ...testing], {
      root,
      files: new DiskFileWriter(),
      taskId: 't1',
    })

    expect(merged.ok).toBe(false)
    expect(merged.applied).toEqual([])
    // The bytes on disk are the ORIGINAL bytes. Neither proposal won, because picking one
    // would be a guess.
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1\n')

    expect(merged.conflicts).toHaveLength(1)
    expect(merged.conflicts[0]!.code).toBe('multiple-proposers')
    expect(merged.conflicts[0]!.roles.sort()).toEqual(['backend', 'testing'])

    expect(merged.followUps).toHaveLength(1)
    expect(merged.followUps[0]!.id).toBe('t1-conflict-1')
    expect(merged.followUps[0]!.origin).toBe('merge-conflict')
    expect(merged.followUps[0]!.prompt).toContain('a.ts')
    expect(merged.followUps[0]!.prompt).toContain('Nothing was written')
  })

  it('treats one role proposing the same path twice as a conflict too', async () => {
    const root = await makeTmp()
    await writeFile(join(root, 'a.ts'), 'const a = 1\n', 'utf8')
    const twice = collectProposals(
      'backend',
      proposalRun('r-be', [
        { path: 'a.ts', original: 'const a = 1\n', content: 'const a = 2\n' },
        { path: 'a.ts', original: 'const a = 1\n', content: 'const a = 3\n' },
      ]),
    )
    const merged = await mergeProposals(twice, { root, files: new DiskFileWriter(), taskId: 't1' })
    expect(merged.ok).toBe(false)
    expect(merged.conflicts[0]!.code).toBe('multiple-proposers')
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1\n')
  })

  it('refuses a stale proposal with the hunk parser own diagnostic', async () => {
    const root = await makeTmp()
    // The role saw `const a = 1`; something else changed the file before the merge ran.
    const proposals = collectProposals(
      'backend',
      proposalRun('r-be', [{ path: 'a.ts', original: 'const a = 1\n', content: 'const a = 2\n' }]),
    )
    await writeFile(join(root, 'a.ts'), 'const a = 99\n', 'utf8')

    const merged = await mergeProposals(proposals, {
      root,
      files: new DiskFileWriter(),
      taskId: 't1',
    })
    expect(merged.ok).toBe(false)
    expect(merged.conflicts[0]!.code).toBe('context-mismatch')
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 99\n')
    expect(merged.followUps[0]!.prompt).toContain('stale')
  })

  it('is deterministic: arrival order does not change the bytes or the conflicts', async () => {
    const rootA = await makeTmp()
    const rootB = await makeTmp()
    for (const root of [rootA, rootB]) {
      await writeFile(join(root, 'a.ts'), 'a\n', 'utf8')
      await writeFile(join(root, 'b.ts'), 'b\n', 'utf8')
    }
    const one = collectProposals('backend', proposalRun('r1', [{ path: 'a.ts', original: 'a\n', content: 'A\n' }]))
    const two = collectProposals('frontend', proposalRun('r2', [{ path: 'b.ts', original: 'b\n', content: 'B\n' }]))

    const forward = await mergeProposals([...one, ...two], { root: rootA, files: new DiskFileWriter(), taskId: 't' })
    const backward = await mergeProposals([...two, ...one], { root: rootB, files: new DiskFileWriter(), taskId: 't' })
    expect(forward.applied.map((entry) => entry.path)).toEqual(backward.applied.map((entry) => entry.path))
    expect(await readFile(join(rootA, 'a.ts'), 'utf8')).toBe(await readFile(join(rootB, 'a.ts'), 'utf8'))
  })

  it('creates files a proposal creates', async () => {
    const root = await makeTmp()
    const proposals = collectProposals(
      'backend',
      proposalRun('r-be', [{ path: 'sub/new.ts', original: '', content: 'export const x = 1\n' }]),
    )
    const merged = await mergeProposals(proposals, { root, files: new DiskFileWriter(), taskId: 't1' })
    expect(merged.ok).toBe(true)
    expect(merged.applied[0]!.created).toBe(true)
    expect(await readFile(join(root, 'sub/new.ts'), 'utf8')).toBe('export const x = 1\n')
  })
})

// ── consensus ───────────────────────────────────────────────────────────────

describe('consensus (24.9)', () => {
  const grade = (role: Parameters<typeof consensus>[1][number]['role'], passed: boolean, citations: string[] = []) => ({
    role,
    signal: ROLE_DEFINITIONS[role].signal,
    passed,
    reason: 'fixture',
    citations: citations.map((path) => ({ path })),
    fabricated: [],
    noFindings: citations.length === 0,
  })

  it('runs only inside swarm', () => {
    expect(consensus('single', [grade('backend', true)])).toBeNull()
    expect(consensus('plan-then-code', [grade('backend', true)])).toBeNull()
    expect(consensus('swarm', [grade('backend', true)])).not.toBeNull()
  })

  it('reaches consensus when every role passed and nothing blocked', () => {
    const result = consensus('swarm', [grade('backend', true), grade('reviewer', true)])!
    expect(result.reached).toBe(true)
    expect(result.agreeing.sort()).toEqual(['backend', 'reviewer'])
    expect(result.blockers).toEqual([])
  })

  it('does not read an empty swarm as unanimity', () => {
    const result = consensus('swarm', [])!
    expect(result.reached).toBe(false)
    expect(result.reason).toContain('not unanimity')
  })

  it('does not reach consensus when a role failed its own signal', () => {
    const result = consensus('swarm', [grade('backend', true), grade('testing', false)])!
    expect(result.reached).toBe(false)
    expect(result.dissenting).toEqual(['testing'])
  })

  it('lets a blocking role with anchored findings stop the swarm', () => {
    const result = consensus('swarm', [
      grade('backend', true),
      grade('security', true, ['src/api/login.ts']),
    ])!
    expect(result.reached).toBe(false)
    expect(result.blockers).toEqual([{ role: 'security', findings: ['src/api/login.ts'] }])
    expect(result.reason).toContain('Security')
  })

  it('does not treat a non-blocking role citing a file as a blocker', () => {
    const result = consensus('swarm', [grade('research', true, ['src/a.ts'])])!
    expect(result.reached).toBe(true)
    expect(result.blockers).toEqual([])
  })
})

// ── the dispatcher ──────────────────────────────────────────────────────────

describe('the strategy dispatcher (24.1, 24.2, 24.3)', () => {
  it('keeps single as the default and runs exactly one run for it', async () => {
    expect(DEFAULT_STRATEGY).toBe('single')
    expect([...STRATEGIES]).toEqual(['single', 'plan-then-code', 'swarm'])
    expect([...ESCALATION_LADDER]).toEqual([...STRATEGIES])
    expect(isStrategy('swarm')).toBe(true)
    expect(isStrategy('mob')).toBe(false)
    expect(heavierThan('swarm')).toEqual([])

    const { runner, calls } = makeRunner(() => ({ ok: true, reason: 'done' }))
    const result = await dispatch(task(), await dispatchDeps({ runner }))

    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe('single')
    expect(result.attempts.map((attempt) => attempt.strategy)).toEqual(['single'])
    expect(result.attempts[0]!.consensus).toBeNull()
  })

  it('emits under component dispatcher, never the router policy key, in its own slice', async () => {
    // `strategy_selected` already has two emitters, both the Phase 8 cost router INSIDE a
    // run, both using `component: 'router'` and a `policy` key. `budget.test.ts` finds them
    // with a bare `.find(e => e.kind === 'strategy_selected')`, so a dispatcher event in a
    // sub-run slice would be picked up instead of the router's.
    const { runner, calls } = makeRunner(() => ({ ok: true, reason: 'done' }))
    const deps = await dispatchDeps({ runner })
    const result = await dispatch(task(), deps)

    const selected = result.events.filter((entry) => entry.kind === 'strategy_selected')
    expect(selected.length).toBeGreaterThanOrEqual(2)
    for (const entry of selected) {
      expect(entry.payload['component']).toBe('dispatcher')
      expect(entry.payload).not.toHaveProperty('policy')
      expect(entry.runId).toBe('d1')
    }
    // And nothing landed in the sub-run's slice.
    const subSlice = await deps.events.forRun(calls[0]!.runId)
    expect(subSlice.filter((entry) => entry.kind === 'strategy_selected')).toEqual([])
  })

  it('records which strategy succeeded on an outcome event', async () => {
    const { runner } = makeRunner(() => ({ ok: true, reason: 'done' }))
    const result = await dispatch(task(), await dispatchDeps({ runner }))
    const outcome = result.events.find((entry) => entry.payload['phase'] === 'outcome')!
    expect(outcome.payload['succeeded']).toBe('single')
    expect(outcome.payload['ok']).toBe(true)
  })

  it('does not escalate unless asked', async () => {
    const { runner, calls } = makeRunner(() => ({ ok: false, reason: 'verify_failed' }))
    const result = await dispatch(task(), await dispatchDeps({ runner }))
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(false)
    expect(result.succeeded).toBeNull()
    expect(result.attempts).toHaveLength(1)
  })

  it('escalates after a failure WITHIN the budget, and records the reason', async () => {
    const { runner, calls } = makeRunner((_call, index) => {
      // Attempt 1: single fails on verify. Attempt 2: the planner sub-run, then the coder.
      if (index === 0) return { ok: false, reason: 'verify_failed' }
      return {
        ok: true,
        reason: 'done',
        extraEvents: (runId) => [event(runId, 'plan_written', { files: ['prd.md'] })],
      }
    })
    const result = await dispatch(task(), await dispatchDeps({ runner, escalate: true }))
    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe('plan-then-code')
    expect(result.attempts.map((attempt) => attempt.strategy)).toEqual(['single', 'plan-then-code'])
    expect(calls).toHaveLength(3) // single, planner, coder
    const second = result.events.filter((entry) => entry.payload['phase'] === 'attempt')[1]!
    expect(String(second.payload['reason'])).toContain('failed within its budget')
  })

  it('does NOT escalate after a budget breach — that is a money bug, not a strategy', async () => {
    // The attempt never got its budget; escalating spends more on a task whose ceiling was
    // already hit. One ceiling would become thirteen bills.
    expect(ESCALATABLE_REASONS).not.toContain('budget')
    expect(ESCALATABLE_REASONS).not.toContain('aborted')
    expect(ESCALATABLE_REASONS).not.toContain('provider_error')

    const { runner, calls } = makeRunner(() => ({ ok: false, reason: 'budget' }))
    const result = await dispatch(task(), await dispatchDeps({ runner, escalate: true }))
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(false)
    expect(result.finalText).toContain('did not fail within its budget')
  })

  it('does not escalate after an abort or a provider error either', async () => {
    for (const reason of ['aborted', 'provider_error', 'awaiting_human_input']) {
      const { runner, calls } = makeRunner(() => ({ ok: false, reason }))
      const result = await dispatch(task(), await dispatchDeps({ runner, escalate: true }))
      expect(calls, reason).toHaveLength(1)
      expect(result.succeeded).toBeNull()
    }
  })

  it('mints distinct sub-run ids even with a frozen clock', async () => {
    // `newRunId(clock())` with a fixed clock repeats, which would collapse every sub-run onto
    // one slice of the log and make `forRun` mix them.
    const { runner, calls } = makeRunner((_call, index) =>
      index === 0
        ? { ok: false, reason: 'verify_failed' }
        : { ok: true, reason: 'done', extraEvents: (runId) => [event(runId, 'plan_written', { files: ['prd.md'] })] },
    )
    const result = await dispatch(
      task(),
      await dispatchDeps({ runner, escalate: true, clock: () => 1_700_000_000_000 }),
    )
    const ids = calls.map((call) => call.runId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.startsWith('d1-r')).toBe(true)
    expect(result.dispatchId).toBe('d1')
  })

  it('plan-then-code runs the planner first and puts its plan in the coder prompt', async () => {
    const planAction = JSON.stringify({
      action: 'plan',
      artifacts: { prd: 'THE-PRD-BODY', arch: 'THE-ARCH-BODY' },
    })
    const { runner, calls } = makeRunner((_call, index) => {
      if (index === 0) {
        return {
          ok: true,
          reason: 'done',
          extraEvents: (runId) => [
            event(runId, 'llm_response', { text: planAction }),
            event(runId, 'plan_written', { files: ['prd.md', 'arch.md'] }),
          ],
        }
      }
      return { ok: true, reason: 'done' }
    })

    const result = await dispatch(
      task(),
      await dispatchDeps({ runner, strategy: 'plan-then-code' }),
    )
    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe('plan-then-code')
    expect(calls[0]!.task.prompt).toContain('Planner role')
    // The role sub-run is graded by its own signal, not by the parent task's commands.
    expect(calls[0]!.task.verify).toEqual([])
    expect(calls[0]!.deps.reviewEdits).toBe(true)
    expect(calls[1]!.task.prompt).toContain('THE-PRD-BODY')
    expect(calls[1]!.task.prompt).toContain('THE-ARCH-BODY')
    expect(result.attempts[0]!.roles[0]!.role).toBe('planner')
    expect(result.attempts[0]!.roles[0]!.grade!.passed).toBe(true)
  })

  it('plan-then-code stops when the planner wrote no plan, and says so', async () => {
    const { runner, calls } = makeRunner(() => ({ ok: true, reason: 'done' }))
    const result = await dispatch(task(), await dispatchDeps({ runner, strategy: 'plan-then-code' }))
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(false)
    expect(result.attempts[0]!.reason).toBe('plan_missing')
  })

  it('extracts the plan text a run actually sent, not its sign-off line', () => {
    const run = fakeRun({ runId: 'r-p', finalText: 'All done!' })
    run.events.push(
      event('r-p', 'llm_response', { text: '{"action":"think","text":"hmm"}' }),
      event('r-p', 'llm_response', {
        text: JSON.stringify({ action: 'plan', artifacts: { prd: 'body-one' } }),
      }),
    )
    expect(planTextFrom(run)).toContain('body-one')
    expect(planTextFrom(fakeRun())).toBe('')
  })

  it('reads the terminal reason out of the log, and falls back honestly', () => {
    expect(terminalReason(fakeRun())).toBe('done')
    const failed = fakeRun({ ok: false, runId: 'r-f' })
    failed.events.push(event('r-f', 'run_failed', { reason: 'verify_failed' }))
    expect(terminalReason(failed)).toBe('verify_failed')
  })

  it('reports the stages a project configures', () => {
    expect(configuredStages(undefined)).toEqual([])
    expect(configuredStages({})).toEqual([])
    expect(configuredStages({ unit: [], build: [{ name: 'build', cmd: 'x' }] })).toEqual(['build'])
    expect(
      configuredStages({ unit: [{ name: 'unit', cmd: 'x' }], lint: [{ name: 'lint', cmd: 'y' }] }),
    ).toEqual(['lint', 'unit'])
  })
})

describe('the swarm (24.5, 24.6, 24.7, 24.9)', () => {
  it('partitions roles BEFORE spending a token, and refuses a swarm it cannot check', async () => {
    let called = 0
    const { runner } = makeRunner(() => {
      called++
      return { ok: true, reason: 'done' }
    })
    const result = await dispatch(
      task(),
      await dispatchDeps({
        runner,
        strategy: 'swarm',
        // Only Frontend was asked for, and this project has no `build` stage.
        roles: ['frontend'],
      }),
    )
    expect(called).toBe(0)
    expect(result.ok).toBe(false)
    expect(result.attempts[0]!.reason).toBe('no_verifiable_role')
    expect(result.attempts[0]!.roles[0]!.ran).toBe(false)
    expect(result.attempts[0]!.roles[0]!.skipped).toContain('build')

    const partition = result.events.find((entry) => entry.payload['phase'] === 'roles')!
    expect(partition.payload['verifiable']).toEqual([])
    expect(partition.payload['skipped']).toEqual([
      { role: 'frontend', reason: expect.stringContaining('build') },
    ])
  })

  it('records a follow-up task for the roles it could not check', async () => {
    const { runner } = makeRunner(() => ({
      ok: true,
      reason: 'done',
      finalText: `nothing to report. ${NO_FINDINGS_TOKEN}`,
    }))
    const result = await dispatch(
      task(),
      await dispatchDeps({ runner, strategy: 'swarm', roles: ['research', 'frontend'] }),
    )
    const skipped = result.followUps.find((entry) => entry.origin === 'unverifiable-role')!
    expect(skipped.id).toBe('t1-unverifiable-roles')
    expect(skipped.prompt).toContain('Frontend')
    expect(skipped.prompt).toContain('reports success having proved nothing')
  })

  it('runs the blocking roles last, so they can see what they review', async () => {
    const order: string[] = []
    const { runner } = makeRunner((call) => {
      const first = call.task.prompt.split('\n')[0] ?? ''
      order.push(first)
      return { ok: true, reason: 'done', finalText: `ok. ${NO_FINDINGS_TOKEN}` }
    })
    await dispatch(
      task(),
      await dispatchDeps({
        runner,
        strategy: 'swarm',
        roles: ['reviewer', 'research', 'security'],
      }),
    )
    expect(order.map((line) => line.match(/as the (\w+)/)?.[1])).toEqual([
      'Research',
      'Security',
      'Reviewer',
    ])
    expect(SWARM_ORDER.indexOf('security')).toBeGreaterThan(SWARM_ORDER.indexOf('backend'))
    expect(SWARM_ORDER.indexOf('reviewer')).toBe(SWARM_ORDER.length - 1)
  })

  it('narrows a role capability grant and hands it to the caller factory', async () => {
    const seen: { role: Role; capabilities: readonly string[] }[] = []
    const { runner } = makeRunner(() => ({
      ok: true,
      reason: 'done',
      finalText: `ok. ${NO_FINDINGS_TOKEN}`,
    }))
    await dispatch(
      task(),
      await dispatchDeps({
        runner,
        strategy: 'swarm',
        roles: ['research', 'deployment'],
        verifyPolicy: { 'dependency-audit': [{ name: 'audit', cmd: 'x' }] },
        grant: ['fs:read:project', 'fs:write:project'],
        toolsForRole: (role, capabilities) => {
          seen.push({ role, capabilities })
          return undefined
        },
      }),
    )
    // Neither role gets fs:write:project (neither asked for it) and Deployment does not get
    // proc:spawn (the run never held it).
    expect(seen).toEqual([
      { role: 'research', capabilities: ['fs:read:project'] },
      { role: 'deployment', capabilities: ['fs:read:project'] },
    ])
  })

  it('narrows each role verify policy to the one stage that grades it', async () => {
    const policies: unknown[] = []
    const { runner } = makeRunner((call) => {
      policies.push(call.deps.verifyPolicy)
      return { ok: true, reason: 'done', verify: [verifyResult('unit', true)] }
    })
    await dispatch(
      task(),
      await dispatchDeps({
        runner,
        strategy: 'swarm',
        roles: ['backend'],
        verifyPolicy: {
          unit: [{ name: 'unit', cmd: 'u' }],
          build: [{ name: 'build', cmd: 'b' }],
        },
        runPolicy: async () => ({
          ok: true,
          stages: [],
          failedStage: null,
          ranStages: ['unit'],
          verifiedAnything: true,
          results: [verifyResult('unit', true)],
          totalDurationMs: 1,
        }),
      }),
    )
    // The Backend role pays for `unit`, not for the Frontend's build.
    expect(policies[0]).toEqual({ unit: [{ name: 'unit', cmd: 'u' }] })
  })

  it('lets consensus gate the merge: a blocked review writes nothing', async () => {
    const root = await makeTmp()
    await writeFile(join(root, 'a.ts'), 'const a = 1\n', 'utf8')
    const events = new MemoryEventStore({ secrets: [] })

    const { runner } = makeRunner((call) => {
      if (call.task.prompt.includes('as the Security role')) {
        // An anchored finding. `a.ts` exists, so the role passes its own signal AND blocks.
        return { ok: true, reason: 'done', finalText: 'Credential leak in a.ts:1' }
      }
      return {
        ok: true,
        reason: 'done',
        verify: [verifyResult('unit', true)],
        extraEvents: (runId) => [
          event(runId, 'edit_proposed', {
            edits: [
              {
                path: 'a.ts',
                wholeFile: true,
                diff: unifiedDiff('a.ts', 'const a = 1\n', 'const a = 2\n'),
              },
            ],
          }),
        ],
      }
    })

    const result = await dispatch(task(), {
      adapter: { id: 'unused', chat: async () => ({ text: '' }) },
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
      root,
      dispatchId: 'd2',
      pathExists: async (path) => path === 'a.ts',
      runner,
      strategy: 'swarm',
      roles: ['backend', 'security'],
      verifyPolicy: { unit: [{ name: 'unit', cmd: 'u' }] },
    })

    expect(result.ok).toBe(false)
    expect(result.attempts[0]!.reason).toBe('consensus_failed')
    expect(result.attempts[0]!.consensus!.blockers).toEqual([
      { role: 'security', findings: ['a.ts:1'] },
    ])
    // The objection arrived BEFORE the bytes did.
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1\n')
    expect(result.followUps.some((entry) => entry.origin === 'blocked-review')).toBe(true)
  })

  it('merges the union and verifies it once with the whole contract', async () => {
    const root = await makeTmp()
    await writeFile(join(root, 'a.ts'), 'const a = 1\n', 'utf8')
    const events = new MemoryEventStore({ secrets: [] })
    let fullPolicyRuns = 0

    const { runner } = makeRunner((call) => {
      if (call.task.prompt.includes('as the Backend role')) {
        return {
          ok: true,
          reason: 'done',
          verify: [verifyResult('unit', true)],
          extraEvents: (runId) => [
            event(runId, 'edit_proposed', {
              edits: [
                {
                  path: 'a.ts',
                  wholeFile: true,
                  diff: unifiedDiff('a.ts', 'const a = 1\n', 'const a = 2\n'),
                },
              ],
            }),
          ],
        }
      }
      return { ok: true, reason: 'done', finalText: `clean. ${NO_FINDINGS_TOKEN}` }
    })

    const result = await dispatch(task(), {
      adapter: { id: 'unused', chat: async () => ({ text: '' }) },
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
      root,
      dispatchId: 'd3',
      pathExists: async () => true,
      runner,
      strategy: 'swarm',
      roles: ['backend', 'reviewer'],
      verifyPolicy: { unit: [{ name: 'unit', cmd: 'u' }] },
      runPolicy: async () => {
        fullPolicyRuns++
        return {
          ok: true,
          stages: [],
          failedStage: null,
          ranStages: ['unit'],
          verifiedAnything: true,
          results: [verifyResult('unit', true)],
          totalDurationMs: 1,
        }
      },
    })

    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe('swarm')
    expect(result.attempts[0]!.consensus!.reached).toBe(true)
    expect(result.attempts[0]!.merge!.applied.map((entry) => entry.path)).toEqual(['a.ts'])
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 2\n')
    // Once. Each role already passed its own narrow stage; whether the union holds together
    // is a different question and it is asked exactly one time.
    expect(fullPolicyRuns).toBe(1)
  })

  it('discards a non-editing role proposals rather than merging them', async () => {
    const root = await makeTmp()
    await writeFile(join(root, 'a.ts'), 'const a = 1\n', 'utf8')
    const events = new MemoryEventStore({ secrets: [] })

    const { runner } = makeRunner(() => ({
      ok: true,
      reason: 'done',
      finalText: `clean. ${NO_FINDINGS_TOKEN}`,
      extraEvents: (runId) => [
        event(runId, 'edit_proposed', {
          edits: [
            { path: 'a.ts', wholeFile: true, diff: unifiedDiff('a.ts', 'const a = 1\n', 'HACKED\n') },
          ],
        }),
      ],
    }))

    const result = await dispatch(task(), {
      adapter: { id: 'unused', chat: async () => ({ text: '' }) },
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
      root,
      dispatchId: 'd4',
      pathExists: async () => true,
      runner,
      strategy: 'swarm',
      roles: ['reviewer'],
    })

    expect(result.attempts[0]!.roles[0]!.proposals).toBe(0)
    expect(result.attempts[0]!.merge!.applied).toEqual([])
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1\n')
  })

  it('forces reviewEdits on for every role, so no role writes its own bytes', async () => {
    const flags: unknown[] = []
    const { runner } = makeRunner((call) => {
      flags.push(call.deps.reviewEdits)
      return { ok: true, reason: 'done', finalText: `ok. ${NO_FINDINGS_TOKEN}` }
    })
    await dispatch(
      task(),
      await dispatchDeps({
        runner,
        strategy: 'swarm',
        roles: ['research', 'reviewer'],
        reviewEdits: false,
      }),
    )
    expect(flags).toEqual([true, true])
  })
})

// ── end to end, through the real loop ───────────────────────────────────────

describe('the dispatcher over the real loop', () => {
  /** Per-run scripts: one adapter instance serves many sub-runs. */
  class RoleAdapter implements ChatAdapter {
    readonly id = 'role-fake'
    readonly model = 'fake'
    readonly seen: string[] = []
    #counts = new Map<string, number>()

    constructor(private readonly scripts: Record<string, readonly string[]>) {}

    async chat(messages: Message[]): Promise<{ text: string; usage?: Usage }> {
      const joined = messages.map((message) => message.content).join('\n')
      const key =
        Object.keys(this.scripts).find((candidate) => candidate !== '*' && joined.includes(candidate)) ??
        '*'
      this.seen.push(key)
      const index = this.#counts.get(key) ?? 0
      this.#counts.set(key, index + 1)
      const script = this.scripts[key] ?? this.scripts['*'] ?? []
      const text = script[Math.min(index, script.length - 1)] ?? '{"action":"done","text":"x"}'
      return { text, usage: { in: 1, out: 1 } }
    }
  }

  const PLAN = JSON.stringify({ action: 'plan', artifacts: { prd: 'REAL-PLAN-BODY' } })
  const DONE = JSON.stringify({ action: 'done', text: 'finished' })

  it('runs single through the real runTask and leaves a complete slice', async () => {
    const root = await makeTmp()
    const events = new MemoryEventStore({ secrets: [] })
    const adapter = new RoleAdapter({ '*': [PLAN, DONE] })

    const result = await dispatch(task(), {
      adapter,
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
      root,
      dispatchId: 'dreal',
      maxIterations: 4,
    })

    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe('single')
    const subSlice = await events.forRun(result.attempts[0]!.runIds[0]!)
    expect(subSlice.map((entry) => entry.kind)).toContain('run_completed')
    expect(subSlice.filter((entry) => entry.kind === 'strategy_selected')).toEqual([])
  })

  it('runs plan-then-code through the real loop and the plan really reaches the coder', async () => {
    const root = await makeTmp()
    const events = new MemoryEventStore({ secrets: [] })
    const adapter = new RoleAdapter({
      'as the Planner role': [PLAN, DONE],
      '*': [PLAN, DONE],
    })

    const result = await dispatch(task(), {
      adapter,
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
      root,
      dispatchId: 'dreal2',
      maxIterations: 4,
      strategy: 'plan-then-code',
    })

    expect(result.ok).toBe(true)
    expect(result.attempts[0]!.roles[0]!.grade!.passed).toBe(true)
    // Two distinct plan directories, because the two sub-runs have distinct ids.
    const written = (await events.readAll()).filter((entry) => entry.kind === 'plan_written')
    expect(new Set(written.map((entry) => entry.runId)).size).toBe(2)
  })

  it('two concurrent runTask calls on one store yield disjoint, complete slices', async () => {
    // Untested ground before Phase 10: `runTask` has no module-level mutable state, but
    // nothing proved two runs sharing one store stay separable. A swarm depends on it.
    const root = await makeTmp()
    const events = new MemoryEventStore({ secrets: [] })
    const adapter = new RoleAdapter({ '*': [PLAN, DONE] })
    const base = (id: string): RunTaskDeps => ({
      adapter,
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
      root,
      maxIterations: 4,
      ids: () => id,
    })

    const [a, b] = await Promise.all([
      runTask(task({ id: 'ta' }), base('conc-a')),
      runTask(task({ id: 'tb' }), base('conc-b')),
    ])

    expect(a.runId).not.toBe(b.runId)
    for (const run of [a, b]) {
      const slice = await events.forRun(run.runId)
      expect(slice.every((entry) => entry.runId === run.runId)).toBe(true)
      expect(slice.filter((entry) => entry.kind === 'run_started')).toHaveLength(1)
      expect(
        slice.filter((entry) => entry.kind === 'run_completed' || entry.kind === 'run_failed'),
      ).toHaveLength(1)
    }
    // Nothing leaked: every event in the store belongs to one of the two slices.
    const all = await events.readAll()
    const ids = new Set(all.map((entry) => entry.runId))
    expect([...ids].sort()).toEqual(['conc-a', 'conc-b'])
  })
})

// ── pass@k ──────────────────────────────────────────────────────────────────

describe('pass@k (24.8, 25.3)', () => {
  function passingCase(id: string): EvalCase {
    return {
      id,
      task: {
        id,
        prompt: 'p',
        verify: [{ name: 'unit', cmd: process.execPath, args: ['-e', 'process.exit(0)'] }],
      },
      checks: [{ kind: 'verify-pass' }],
    }
  }

  function failingCase(id: string): EvalCase {
    return {
      id,
      task: {
        id,
        prompt: 'p',
        verify: [{ name: 'unit', cmd: process.execPath, args: ['-e', 'process.exit(1)'] }],
      },
      checks: [{ kind: 'verify-pass' }],
    }
  }

  function evalDeps(events: MemoryEventStore) {
    return () => ({
      adapter: {
        id: 'fake',
        model: 'fake',
        chat: async () => ({ text: '{"action":"verify"}', usage: { in: 1, out: 1 } }),
      },
      events,
      maxIterations: 3,
    })
  }

  it('reports the distribution, not only the best case', async () => {
    const events = new MemoryEventStore({ secrets: [] })
    const report = await passAtKSet([passingCase('p1'), failingCase('f1')], {
      k: 2,
      deps: evalDeps(events),
    })

    expect(report.k).toBe(2)
    expect(report.attempts).toBe(4)
    expect(report.distribution).toEqual([2, 0])
    expect(report.passAtK).toBe(0.5)
    expect(report.passAt1).toBe(0.5)
    expect(report.cases[0]!.passes).toBe(2)
    expect(report.cases[1]!.passAtK).toBe(0)
  }, 30_000)

  it('clamps k below one rather than reporting an unmeasured zero', async () => {
    const events = new MemoryEventStore({ secrets: [] })
    const one = await passAtK(passingCase('p1'), { k: 0, deps: evalDeps(events) })
    expect(one.k).toBe(1)
    expect(one.results).toHaveLength(1)
  }, 30_000)

  it('an empty report scores 0, so no data can never enable anything', () => {
    const empty = emptyReport(5)
    expect(empty.passAtK).toBe(0)
    expect(empty.passAt1).toBe(0)
    expect(empty.meanScore).toBe(0)
    expect(shouldDefaultToSwarm(empty, empty).enable).toBe(false)
    expect(shouldDefaultToSwarm(empty, empty).reason).toContain('nothing to compare')
  })

  function report(overrides: Partial<PassAtKReport>): PassAtKReport {
    return {
      k: 3,
      cases: [
        { caseId: 'c1', k: 3, passes: 1, passAtK: 1, scores: [1, 0, 0], results: [] },
      ],
      passAtK: 0.5,
      passAt1: 0.3,
      meanScore: 0.4,
      distribution: [1],
      attempts: 3,
      ...overrides,
    }
  }

  it('refuses to call a bigger budget lift', () => {
    const lift = liftOver(report({ k: 1 }), report({ k: 10 }))
    expect(lift.better).toBe(false)
    expect(lift.reason).toContain('larger budget')
  })

  it('refuses to compare reports over different cases', () => {
    const other = report({
      cases: [{ caseId: 'c2', k: 3, passes: 3, passAtK: 1, scores: [1, 1, 1], results: [] }],
      passAtK: 1,
    })
    const lift = liftOver(report({}), other)
    expect(lift.better).toBe(false)
    expect(lift.reason).toContain('different cases')
  })

  it('is strict: a tie retains the cheaper default', () => {
    const lift = liftOver(report({}), report({}))
    expect(lift.passAtK).toBe(0)
    expect(lift.better).toBe(false)
    expect(shouldDefaultToSwarm(report({}), report({})).enable).toBe(false)
  })

  it('enables swarm only on strictly better pass@k, and says what it cost', () => {
    const single = report({ passAtK: 0.4, passAt1: 0.2, attempts: 3 })
    const swarm = report({ passAtK: 0.9, passAt1: 0.6, attempts: 39 })
    const verdict = shouldDefaultToSwarm(single, swarm)
    expect(verdict.enable).toBe(true)
    expect(verdict.lift.passAtK).toBeCloseTo(0.5, 10)
    expect(verdict.reason).toContain('39 attempt(s)')
    expect(verdict.reason).toContain("single's 3")
  })

  it('does not enable swarm on a pass@k regression', () => {
    const verdict = shouldDefaultToSwarm(report({ passAtK: 0.9 }), report({ passAtK: 0.4 }))
    expect(verdict.enable).toBe(false)
    expect(verdict.lift.passAtK).toBeLessThan(0)
  })
})
