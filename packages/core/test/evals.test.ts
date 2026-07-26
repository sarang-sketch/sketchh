// Eval harness tests.
//
// Uses REAL: the filesystem (the harness mkdtemps its own per-case workspace, and
// this file mkdtemps the ones it supplies), a real MemoryEventStore, a real
// PlanWriter, the real DiskFileWriter, and REAL SUBPROCESSES for verify
// (`process.execPath -e …`). The only substituted collaborator is the model, via
// FakeChatAdapter with a per-scenario injected script.
//
// These tests exist to PIN DOWN the harness's judgement calls, each of which is
// load-bearing for the SkillOpt validation gate that stands on top of it:
//   * `verify-pass` with no verify commands configured FAILS (anti-gaming)
//   * `contains` / `not-contains` search all assistant output, not just finalText
//   * a zero-check case scores 0 and does not run the task at all
//   * `meanScore([])` is 0, never NaN
//   * `eval_scored` carries the task run's runId
//   * every case gets its own workspace unless `root` is supplied
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runEval,
  runEvalSet,
  meanScore,
  evaluateCheck,
  checkLabel,
  runOutputText,
  EMPTY_CHECKS_DETAIL,
  UNEVALUABLE_CREDENTIAL_TARGET_REASON,
} from '../src/evals/index.js'
import type { EvalDeps } from '../src/evals/index.js'
import { runTask } from '../src/loop/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import { PlanWriter } from '../src/plan/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { FakeChatAdapter } from '../src/providers/fake.js'
import type {
  ChatAdapter,
  Check,
  EvalCase,
  EventKind,
  RunResult,
  SketchEvent,
  Task,
  VerifyCommand,
  VerifyResult,
} from '../src/types.js'

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-evaltest-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A verify command that really passes, in a real child process. */
const PASSING: VerifyCommand = {
  name: 'unit',
  cmd: process.execPath,
  args: ['-e', 'process.stdout.write("all good")'],
}

/** A verify command that really fails, in a real child process. */
const FAILING: VerifyCommand = {
  name: 'unit',
  cmd: process.execPath,
  args: ['-e', 'console.error("BOOM-FROM-STDERR"); process.exit(1)'],
}

const DONE_ACTION = JSON.stringify({ action: 'done', text: 'finished' })
const PLAN_ACTION = JSON.stringify({
  action: 'plan',
  artifacts: { prd: 'the prd', arch: 'the arch' },
})
const VERIFY_ACTION = '{"action":"verify"}'

function thinkAction(text: string): string {
  return JSON.stringify({ action: 'think', text })
}

function editAction(path: string, replace: string, search = ''): string {
  return JSON.stringify({ action: 'edit', edits: [{ path, search, replace }] })
}

function task(overrides: Partial<Task> = {}): Task {
  return { id: 't1', prompt: 'Build the thing.', verify: [], ...overrides }
}

function evalCase(id: string, checks: Check[], overrides: Partial<Task> = {}): EvalCase {
  return { id, task: task({ id: `task-${id}`, ...overrides }), checks }
}

interface Harness {
  events: MemoryEventStore
  adapter: FakeChatAdapter
  deps: EvalDeps
}

/**
 * Default deps: NO `root`, so the harness supplies (and removes) a fresh
 * workspace per case. That is the path production takes.
 */
function harness(script?: readonly string[], extra: Partial<EvalDeps> = {}): Harness {
  const events = new MemoryEventStore({ secrets: [] })
  const adapter = script ? new FakeChatAdapter({ script }) : new FakeChatAdapter()
  return { events, adapter, deps: { adapter, events, maxIterations: 6, ...extra } }
}

const of = (events: readonly SketchEvent[], kind: EventKind): SketchEvent[] =>
  events.filter((e) => e.kind === kind)

/** A synthetic run, for exercising the pure scoring functions directly. */
function fakeRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run-synthetic',
    ok: true,
    finalText: '',
    iterations: 1,
    verify: [],
    events: [],
    ...overrides,
  }
}

function verifyResult(name: string, ok: boolean, exitCode = ok ? 0 : 1): VerifyResult {
  return { name, ok, exitCode, stdout: '', stderr: '', durationMs: 1 }
}

function llmResponse(text: string): SketchEvent {
  return { id: 'e1', ts: 1, runId: 'run-synthetic', kind: 'llm_response', payload: { text } }
}

describe('scoring is the fraction of passed checks (Requirement 7.4)', () => {
  it('scores 1.0 and passes when every check passes', async () => {
    const h = harness()
    const result = await runEval(
      evalCase(
        'all-pass',
        [
          { kind: 'verify-pass' },
          { kind: 'contains', text: 'Offline fixture run complete.' },
          { kind: 'not-contains', text: 'ZZZ-NEVER-SAID' },
        ],
        { verify: [PASSING] },
      ),
      h.deps,
    )

    expect(result.score).toBe(1)
    expect(result.passed).toBe(true)
    expect(result.passedChecks).toBe(3)
    expect(result.totalChecks).toBe(3)
    expect(result.detail).toBe('3/3 checks passed')
  })

  it('scores exactly 2/3 for one failing check of three and names the failing check', async () => {
    const h = harness()
    const result = await runEval(
      evalCase(
        'two-of-three',
        [
          { kind: 'verify-pass' },
          { kind: 'contains', text: 'Offline fixture' },
          { kind: 'contains', text: 'NOT-PRESENT-TEXT' },
        ],
        { verify: [PASSING] },
      ),
      h.deps,
    )

    expect(result.score).toBeCloseTo(2 / 3, 12)
    expect(result.passed).toBe(false)
    expect(result.passedChecks).toBe(2)
    // The detail must identify WHICH check failed, not merely how many.
    expect(result.detail).toContain('2/3 checks passed')
    expect(result.detail).toContain('contains "NOT-PRESENT-TEXT"')
    expect(result.detail).toContain('not found in')
    // ...and must not implicate the checks that passed.
    expect(result.detail).not.toContain('[1] verify-pass')
  })
})

describe('the verify-pass check (Requirement 7.2)', () => {
  it('passes for a run whose real subprocess verify commands all passed', async () => {
    const h = harness()
    const result = await runEval(
      evalCase('verify-ok', [{ kind: 'verify-pass' }], { verify: [PASSING] }),
      h.deps,
    )

    expect(result.score).toBe(1)
    expect(result.passed).toBe(true)
    // A real child process really ran.
    const verified = of(await h.events.readAll(), 'verify_result')
    expect(verified).toHaveLength(1)
    expect(verified[0]!.payload.ok).toBe(true)
  })

  it('fails for a failing verify command, naming the stage and its exit code', async () => {
    const h = harness([VERIFY_ACTION, DONE_ACTION])
    const result = await runEval(
      evalCase('verify-fail', [{ kind: 'verify-pass' }], { verify: [FAILING] }),
      h.deps,
    )

    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('verify-pass')
    expect(result.detail).toContain('failed stage(s): unit (exit 1)')
  })

  it('FAILS when no verify commands were configured, even though the run itself is ok', async () => {
    // THE ANTI-GAMING GUARD. The loop reports ok for a task with nothing to
    // verify (Requirement 5.8), and this test asserts the CHECK refuses to
    // inherit that reading. If it did, a case with `verify: []` would score 1.0
    // while verifying nothing, and the trainer accepts a candidate on a strictly
    // greater validation mean — so a split of check-free cases would hand every
    // candidate a perfect score and reduce the gate to a coin flip.
    const h = harness([DONE_ACTION])
    const result = await runEval(
      evalCase('verify-nothing', [{ kind: 'verify-pass' }], { verify: [] }),
      h.deps,
    )

    // The run really did succeed: the loop emitted its ok-shaped terminal event.
    const log = await h.events.readAll()
    expect(of(log, 'run_completed')).toHaveLength(1)
    expect(of(log, 'verify_started')).toHaveLength(0)

    // The eval still scores zero, and says why.
    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('nothing was verified')
  })
})

describe('the contains / not-contains checks search all assistant output', () => {
  it('matches text that appears only in an llm_response, never in finalText', async () => {
    // This is what makes the trainer sensitive to skill improvements: a better
    // skill shows up in the plan and edit turns long before it reaches the
    // sign-off line, and the gate can only select on signal it can see.
    const marker = 'MID-RUN-MARKER-8831'
    const script = [thinkAction(marker), DONE_ACTION]

    // First, prove the marker really is absent from finalText, using the same
    // loop the harness drives.
    const root = await makeTmp()
    const events = new MemoryEventStore({ secrets: [] })
    const run = await runTask(task(), {
      adapter: new FakeChatAdapter({ script }),
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
      root,
      maxIterations: 6,
    })
    expect(run.finalText).toBe('finished')
    expect(run.finalText).not.toContain(marker)
    expect(runOutputText(run)).toContain(marker)

    // Now the harness scores it as a pass.
    const h = harness(script)
    const result = await runEval(
      evalCase('mid-run-contains', [{ kind: 'contains', text: marker }]),
      h.deps,
    )
    expect(result.score).toBe(1)
    expect(result.passed).toBe(true)
    // `detail` names FAILING checks only (Requirement 7), so an all-pass case's
    // detail is just the head line. The per-check reason — which is where the
    // located offset legitimately lives — is asserted through `evaluateCheck`.
    expect(result.detail).toBe('1/1 checks passed')
    expect(evaluateCheck({ kind: 'contains', text: marker }, run).reason).toContain(
      'found at offset',
    )
  })

  it('fails not-contains when the forbidden text appears only in a mid-run turn', async () => {
    // The token deliberately has NO credential shape (no `sk-` prefix): it must
    // survive the event log's write-path redaction so the harness can really
    // find it. The credential-shaped case is the next test.
    const forbidden = 'TODO-LEFTOVER-MARKER'
    const h = harness([thinkAction(`I will use ${forbidden} for now`), DONE_ACTION])

    const result = await runEval(
      evalCase('forbidden-mid-run', [{ kind: 'not-contains', text: forbidden }]),
      h.deps,
    )

    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('forbidden text found at offset')
  })

  it('fails a not-contains whose target is credential-shaped instead of silently passing', async () => {
    // REGRESSION PIN. `MemoryEventStore.emit` sanitizes payloads on the write
    // path (Requirement 3.7), and `runOutputText` reads the SANITIZED log — so a
    // secret-shaped token the model really emitted is `[redacted]` before the
    // harness can search for it. Searching anyway made `not-contains` pass for
    // every credential-shaped target: a silent false negative on exactly the
    // safety check a user writes to assert "no secret was ever emitted", and a
    // free point for every trainer candidate. Redaction stays as it is; the
    // harness refuses the question instead.
    const forbidden = 'sk-FORBIDDEN-TOKEN-NAME'
    const h = harness([thinkAction(`I will use ${forbidden} for now`), DONE_ACTION])

    const result = await runEval(
      evalCase('forbidden-credential-shaped', [{ kind: 'not-contains', text: forbidden }]),
      h.deps,
    )

    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('credential-shaped')
    expect(result.detail).toContain('cannot be evaluated')
    expect(result.detail).toContain(UNEVALUABLE_CREDENTIAL_TARGET_REASON)

    // And the log really was scrubbed: the token never reached an event payload.
    const log = await h.events.readAll()
    expect(JSON.stringify(log)).not.toContain(forbidden)
  })

  it('fails a contains whose target is credential-shaped with the same diagnostic', async () => {
    // Mirror image: `contains "sk-…"` would fail anyway (the safe direction) but
    // for the misleading reason "not found in N characters". The user needs to
    // learn that redaction, not the model, is why it can never match.
    const wanted = 'sk-FORBIDDEN-TOKEN-NAME'
    const h = harness([thinkAction(`I will use ${wanted} for now`), DONE_ACTION])

    const result = await runEval(
      evalCase('wanted-credential-shaped', [{ kind: 'contains', text: wanted }]),
      h.deps,
    )

    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain(UNEVALUABLE_CREDENTIAL_TARGET_REASON)
    expect(result.detail).not.toContain('not found in')

    // Pure form, on a synthetic run, so the rule is pinned independent of the loop.
    const outcome = evaluateCheck({ kind: 'contains', text: wanted }, fakeRun())
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe(UNEVALUABLE_CREDENTIAL_TARGET_REASON)
  })

  it('is case-sensitive', async () => {
    const h = harness()
    const exact = await runEval(
      evalCase('case-exact', [{ kind: 'contains', text: 'Offline fixture' }]),
      h.deps,
    )
    expect(exact.score).toBe(1)

    const shouted = await runEval(
      evalCase('case-shouted', [{ kind: 'contains', text: 'OFFLINE FIXTURE' }]),
      h.deps,
    )
    expect(shouted.score).toBe(0)
  })
})

describe('resilience (Requirement 7.6)', () => {
  it('records zero with the error message and does not abort the set', async () => {
    const events = new MemoryEventStore({ secrets: [] })
    const exploding: ChatAdapter = {
      id: 'exploding',
      chat: async () => {
        throw new Error('upstream exploded mid-eval')
      },
    }
    const healthy = new FakeChatAdapter()

    // Two cases, two adapters: the harness deps are per-set, so the broken case
    // gets its own runEval call inside the same set-shaped sequence.
    const broken = evalCase('broken', [{ kind: 'verify-pass' }], { verify: [PASSING] })
    const fine = evalCase('fine', [{ kind: 'verify-pass' }], { verify: [PASSING] })

    const results = [
      ...(await runEvalSet([broken], { adapter: exploding, events, maxIterations: 6 })),
      ...(await runEvalSet([fine], { adapter: healthy, events, maxIterations: 6 })),
    ]

    expect(results).toHaveLength(2)
    expect(results[0]!.caseId).toBe('broken')
    expect(results[0]!.score).toBe(0)
    expect(results[0]!.passed).toBe(false)
    // The error itself reaches `detail`, not just the check verdict.
    expect(results[0]!.detail).toContain('upstream exploded mid-eval')

    // The other case in the same run of the set scored normally.
    expect(results[1]!.caseId).toBe('fine')
    expect(results[1]!.score).toBe(1)
    expect(results[1]!.passed).toBe(true)
  })

  it('keeps scoring the remaining cases when one case in the middle fails', async () => {
    const h = harness()
    const results = await runEvalSet(
      [
        evalCase('a', [{ kind: 'contains', text: 'Offline fixture' }]),
        evalCase('b', []), // zero checks: scores 0, task never runs
        evalCase('c', [{ kind: 'contains', text: 'Offline fixture' }]),
      ],
      h.deps,
    )

    expect(results.map((r) => [r.caseId, r.score])).toEqual([
      ['a', 1],
      ['b', 0],
      ['c', 1],
    ])
  })

  it('rejects only when the event store itself fails, and the set survives it', async () => {
    const inner = new MemoryEventStore({ secrets: [] })
    const brokenStore = {
      emit(input: Parameters<MemoryEventStore['emit']>[0]) {
        if (input.kind === 'eval_scored') throw new Error('log volume is full')
        inner.emit(input)
      },
      readAll: () => inner.readAll(),
      forRun: (runId: string) => inner.forRun(runId),
    }

    const zeroCheck = evalCase('unloggable', [])
    await expect(
      runEval(zeroCheck, { adapter: new FakeChatAdapter(), events: brokenStore }),
    ).rejects.toThrow('log volume is full')

    // The set absorbs it rather than dying.
    const results = await runEvalSet([zeroCheck], {
      adapter: new FakeChatAdapter(),
      events: brokenStore,
    })
    expect(results).toHaveLength(1)
    expect(results[0]!.score).toBe(0)
    expect(results[0]!.detail).toContain('could not be logged')
    expect(results[0]!.detail).toContain('log volume is full')
  })
})

describe('the eval_scored event (Requirement 7.3)', () => {
  it('is emitted exactly once per case, carrying caseId and score', async () => {
    const h = harness()
    await runEvalSet(
      [
        evalCase('one', [{ kind: 'contains', text: 'Offline fixture' }]),
        evalCase('two', [{ kind: 'contains', text: 'nope-not-here' }]),
      ],
      h.deps,
    )

    const scored = of(await h.events.readAll(), 'eval_scored')
    expect(scored).toHaveLength(2)
    expect(scored.map((e) => e.payload.caseId)).toEqual(['one', 'two'])
    expect(scored.map((e) => e.payload.score)).toEqual([1, 0])
    expect(scored.map((e) => e.payload.passed)).toEqual([true, false])
  })

  it('carries the task run own runId, so the score sits in that run slice', async () => {
    const h = harness()
    await runEval(evalCase('correlated', [{ kind: 'verify-pass' }], { verify: [PASSING] }), h.deps)

    const log = await h.events.readAll()
    const scored = of(log, 'eval_scored')
    expect(scored).toHaveLength(1)

    const started = of(log, 'run_started')
    expect(started).toHaveLength(1)
    expect(scored[0]!.runId).toBe(started[0]!.runId)
    expect(scored[0]!.payload.ran).toBe(true)

    // The whole story reads back as one correlated slice, score last.
    const slice = await h.events.forRun(scored[0]!.runId)
    const kinds = slice.map((e) => e.kind)
    expect(kinds[0]).toBe('run_started')
    expect(kinds).toContain('verify_result')
    expect(kinds).toContain('run_completed')
    expect(kinds[kinds.length - 1]).toBe('eval_scored')
  })

  it('flags ran: false for a case that never produced a run', async () => {
    const h = harness()
    await runEval(evalCase('no-checks', []), h.deps)

    const log = await h.events.readAll()
    const scored = of(log, 'eval_scored')
    expect(scored).toHaveLength(1)
    expect(scored[0]!.payload.ran).toBe(false)
    expect(scored[0]!.payload.caseId).toBe('no-checks')
    // A fresh runId, and nothing else in the log under it.
    expect(scored[0]!.runId).not.toBe('')
    expect(await h.events.forRun(scored[0]!.runId)).toHaveLength(1)
  })
})

describe('a case with zero checks', () => {
  it('scores 0 with the documented detail and never runs the task', async () => {
    const h = harness()
    const result = await runEval(evalCase('empty', []), h.deps)

    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.passedChecks).toBe(0)
    expect(result.totalChecks).toBe(0)
    expect(result.detail).toBe(EMPTY_CHECKS_DETAIL)

    // No model calls, no run, no disk work: there is nothing to assert, so
    // spending a paid provider call on it would be waste.
    expect(h.adapter.callCount).toBe(0)
    const log = await h.events.readAll()
    expect(of(log, 'run_started')).toHaveLength(0)
    expect(of(log, 'plan_written')).toHaveLength(0)
    expect(log.map((e) => e.kind)).toEqual(['eval_scored'])
  })
})

describe('meanScore', () => {
  it('averages a multi-result set', () => {
    const results = [
      { caseId: 'a', score: 1, passed: true, passedChecks: 1, totalChecks: 1, detail: '' },
      { caseId: 'b', score: 0, passed: false, passedChecks: 0, totalChecks: 1, detail: '' },
      { caseId: 'c', score: 0.5, passed: false, passedChecks: 1, totalChecks: 2, detail: '' },
    ]
    expect(meanScore(results)).toBeCloseTo(0.5, 12)
  })

  it('returns the single score for one result', () => {
    expect(
      meanScore([
        { caseId: 'a', score: 0.25, passed: false, passedChecks: 1, totalChecks: 4, detail: '' },
      ]),
    ).toBe(0.25)
  })

  it('returns 0 for an empty set, never NaN', () => {
    // NaN would propagate through the trainer gate `candVal > bestVal` as false
    // today and be silently wrong the moment anyone compares the other way.
    const mean = meanScore([])
    expect(mean).toBe(0)
    expect(Number.isNaN(mean)).toBe(false)
  })
})

describe('workspace isolation', () => {
  it('gives each case its own root, so one case cannot pass on another case bytes', async () => {
    const events = new MemoryEventStore({ secrets: [] })

    // Case A creates `shared.txt`. Case B tries to search/replace inside the same
    // path: if A's bytes leaked into B's root the edit would apply, so B's
    // rejection IS the isolation proof.
    const writerAdapter = new FakeChatAdapter({
      script: [PLAN_ACTION, editAction('shared.txt', 'from A'), DONE_ACTION],
    })
    const readerAdapter = new FakeChatAdapter({
      script: [PLAN_ACTION, editAction('shared.txt', 'from B', 'from A'), DONE_ACTION],
    })

    const a = (
      await runEvalSet([evalCase('A', [{ kind: 'contains', text: 'shared.txt' }])], {
        adapter: writerAdapter,
        events,
        maxIterations: 6,
      })
    )[0]!
    const b = (
      await runEvalSet([evalCase('B', [{ kind: 'contains', text: 'shared.txt' }])], {
        adapter: readerAdapter,
        events,
        maxIterations: 6,
      })
    )[0]!

    const log = await events.readAll()
    const roots = of(log, 'run_started').map((e) => String(e.payload.root))
    expect(roots).toHaveLength(2)
    expect(roots[0]).not.toBe(roots[1])
    for (const root of roots) expect(root.startsWith(tmpdir())).toBe(true)

    // Case A really wrote a file.
    const scored = of(log, 'eval_scored')
    const runIdOf = (caseId: string): string =>
      scored.find((e) => e.payload.caseId === caseId)!.runId
    const accepted = of(await events.forRun(runIdOf('A')), 'edit_accepted')
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.payload.path).toBe('shared.txt')

    // Case B could not see it, and scored on its own merits regardless.
    const rejected = of(await events.forRun(runIdOf('B')), 'edit_rejected')
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]!.payload.reason)).toContain('file does not exist')
    expect(of(await events.forRun(runIdOf('B')), 'edit_accepted')).toHaveLength(0)
    expect(a.score).toBe(1)
    expect(b.score).toBe(1)
  })

  it('removes the workspace it created, but honours keepWorkspace', async () => {
    const gone = harness()
    await runEval(evalCase('cleanup', [{ kind: 'contains', text: 'Offline fixture' }]), gone.deps)
    const goneRoot = String(of(await gone.events.readAll(), 'run_started')[0]!.payload.root)
    expect(await exists(goneRoot)).toBe(false)

    const kept = harness(undefined, { keepWorkspace: true })
    await runEval(evalCase('kept', [{ kind: 'contains', text: 'Offline fixture' }]), kept.deps)
    const keptRoot = String(of(await kept.events.readAll(), 'run_started')[0]!.payload.root)
    tmpDirs.push(keptRoot) // this test owns it now
    expect(await exists(keptRoot)).toBe(true)
    expect(await exists(join(keptRoot, '.sketch', 'plan'))).toBe(true)
  })

  it('uses a supplied root as-is, which is how you score against a real repo', async () => {
    const root = await makeTmp()
    const h = harness(undefined, { root })
    await runEval(evalCase('supplied', [{ kind: 'contains', text: 'Offline fixture' }]), h.deps)

    expect(String(of(await h.events.readAll(), 'run_started')[0]!.payload.root)).toBe(root)
    // Opting out means the caller keeps the directory.
    expect(await exists(root)).toBe(true)
  })
})

describe('runEvalSet is sequential', () => {
  it('leaves one ordered log: each case runId occupies a contiguous block', async () => {
    const h = harness()
    await runEvalSet(
      [
        evalCase('s1', [{ kind: 'contains', text: 'Offline fixture' }], { verify: [PASSING] }),
        evalCase('s2', [{ kind: 'contains', text: 'Offline fixture' }], { verify: [PASSING] }),
        evalCase('s3', [{ kind: 'contains', text: 'Offline fixture' }], { verify: [PASSING] }),
      ],
      h.deps,
    )

    const log = await h.events.readAll()
    const blocks: string[] = []
    for (const event of log) {
      if (blocks[blocks.length - 1] !== event.runId) blocks.push(event.runId)
    }
    // Three runs, three blocks: interleaving would produce more.
    expect(blocks).toHaveLength(3)
    expect(new Set(blocks).size).toBe(3)
    expect(of(log, 'eval_scored').map((e) => e.payload.caseId)).toEqual(['s1', 's2', 's3'])
  })
})

describe('no network (Requirement 7.5)', () => {
  it('runs a whole eval set without a single fetch call', async () => {
    const calls: unknown[][] = []
    const original = globalThis.fetch
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args)
      throw new Error('NETWORK TRIPWIRE: the eval harness must never touch the network')
    }) as unknown as typeof fetch

    try {
      const h = harness()
      const results = await runEvalSet(
        [
          evalCase('net1', [{ kind: 'verify-pass' }], { verify: [PASSING] }),
          evalCase('net2', [{ kind: 'contains', text: 'Offline fixture' }]),
          evalCase('net3', [{ kind: 'not-contains', text: 'never-said-this' }]),
        ],
        h.deps,
      )
      expect(results.map((r) => r.score)).toEqual([1, 1, 1])
    } finally {
      globalThis.fetch = original
    }

    expect(calls).toEqual([])
  })
})

describe('the capture round trip task 2.3 depends on', () => {
  it('scores exactly 1.0 for the default fake script with verify-pass and a passing command', async () => {
    // CONTRACT FOR TASK 2.3 (`captureRunAsEval`, Requirement 8.2): a case captured
    // from a successful run must re-score 1.0 against the same recorded
    // conditions. This is that contract, pinned at its simplest: the untouched
    // FakeChatAdapter script, one real passing verify command, one verify-pass
    // check. If this test ever goes red, capture-as-eval is broken too.
    const h = harness()
    const results = await runEvalSet(
      [evalCase('round-trip', [{ kind: 'verify-pass' }], { verify: [PASSING] })],
      h.deps,
    )

    expect(meanScore(results)).toBe(1)
    expect(results[0]!.passed).toBe(true)
    expect(results[0]!.score).toBe(1)
    expect(h.adapter.callCount).toBe(3) // plan → verify → done, exactly as scripted
  })
})

describe('evaluateCheck and checkLabel as pure functions', () => {
  it('labels every check kind, which is what detail quotes', () => {
    expect(checkLabel({ kind: 'verify-pass' })).toBe('verify-pass')
    expect(checkLabel({ kind: 'contains', text: 'hello' })).toBe('contains "hello"')
    expect(checkLabel({ kind: 'not-contains', text: 'hello' })).toBe('not-contains "hello"')
    // Long targets are elided so a label stays readable in a table cell.
    expect(checkLabel({ kind: 'contains', text: 'x'.repeat(80) })).toContain('…')
  })

  it('scores verify-pass from the run verify results alone', () => {
    expect(
      evaluateCheck({ kind: 'verify-pass' }, fakeRun({ verify: [verifyResult('unit', true)] })),
    ).toMatchObject({ ok: true, label: 'verify-pass' })

    const failed = evaluateCheck(
      { kind: 'verify-pass' },
      fakeRun({ ok: false, verify: [verifyResult('unit', true), verifyResult('types', false, 2)] }),
    )
    expect(failed.ok).toBe(false)
    expect(failed.reason).toContain('types (exit 2)')

    // No results at all: a failure, whatever the run said about itself.
    const nothing = evaluateCheck({ kind: 'verify-pass' }, fakeRun({ ok: true, verify: [] }))
    expect(nothing.ok).toBe(false)
    expect(nothing.reason).toContain('nothing was verified')
  })

  it('scores contains and not-contains over finalText plus every llm_response', () => {
    const run = fakeRun({ finalText: 'done here', events: [llmResponse('mid turn text')] })
    expect(runOutputText(run)).toBe('done here\nmid turn text')

    expect(evaluateCheck({ kind: 'contains', text: 'mid turn' }, run).ok).toBe(true)
    expect(evaluateCheck({ kind: 'contains', text: 'done here' }, run).ok).toBe(true)
    expect(evaluateCheck({ kind: 'contains', text: 'Mid Turn' }, run).ok).toBe(false)
    expect(evaluateCheck({ kind: 'not-contains', text: 'mid turn' }, run).ok).toBe(false)
    expect(evaluateCheck({ kind: 'not-contains', text: 'absent' }, run).ok).toBe(true)

    // Empty finalText contributes nothing, so no leading newline.
    expect(runOutputText(fakeRun({ events: [llmResponse('only turn')] }))).toBe('only turn')
  })

  it('treats an unrecognized check kind as a failure rather than a pass or a crash', () => {
    const bogus = { kind: 'sql-injection' } as unknown as Check
    const outcome = evaluateCheck(bogus, fakeRun())
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('unrecognized')
    expect(checkLabel(bogus)).toContain('unknown check')
  })
})
