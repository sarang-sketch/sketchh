// Capture-as-eval tests (Requirements 8.1, 8.2, 8.4).
//
// Uses REAL: the filesystem, a real MemoryEventStore, a real PlanWriter, the real
// DiskFileWriter, and REAL SUBPROCESSES for verify (`process.execPath -e …`) on
// BOTH legs of the round trip. The only substituted collaborator is the model.
//
// That matters: the previous version of this file injected a `verify` stub that
// returned a passing result, so its "re-scores 1.0" assertion held even though
// the captured commands (`cmd: "unit"`) could not be spawned at all. Requirement
// 8.2 is about the captured ARTIFACT working on replay, so nothing here fakes the
// verify seam.
//
// Validates: Requirements 8.1, 8.2, 8.4

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureRunAsEval, CaptureNotReplayableError } from '../src/evals/capture.js'
import { runEval } from '../src/evals/runner.js'
import { MemoryEventStore } from '../src/events/index.js'
import { runTask } from '../src/loop/index.js'
import type { RunTaskDeps } from '../src/loop/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { PlanWriter } from '../src/plan/index.js'
import { FakeChatAdapter } from '../src/providers/fake.js'
import type { RunResult, Task, VerifyCommand } from '../src/types.js'

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-capture-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** A verify command that really passes, in a real child process. */
const PASSING: VerifyCommand = {
  name: 'unit',
  cmd: process.execPath,
  args: ['-e', 'process.exit(0)'],
}

/** A verify command that really fails, in a real child process. */
const FAILING: VerifyCommand = {
  name: 'unit',
  cmd: process.execPath,
  args: ['-e', 'console.error("BOOM"); process.exit(1)'],
}

/** Run a task for real: real plan writer, real file writer, real verify runner. */
async function reallyRun(task: Task, root: string): Promise<RunResult> {
  const events = new MemoryEventStore({ secrets: [] })
  const deps: RunTaskDeps = {
    adapter: new FakeChatAdapter(),
    events,
    plan: new PlanWriter({ baseDir: root, events }),
    files: new DiskFileWriter(),
    root,
    maxIterations: 6,
  }
  return runTask(task, deps)
}

function fakeRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run_test_123',
    ok: true,
    finalText: 'Task completed cleanly',
    iterations: 2,
    verify: [],
    events: [],
    ...overrides,
  }
}

describe('captureRunAsEval — the real round trip (Requirements 8.1, 8.2)', () => {
  it('captures a real run and the captured case re-scores 1.0 with NO fakes on the verify seam', async () => {
    const root = await makeTmp()
    const evalsPath = join(root, '.sketch', 'evals', 'evals.jsonl')

    const task: Task = {
      id: 'task_round_trip',
      prompt: 'Build the project',
      verify: [PASSING],
    }

    // Leg 1: a real run, verified by a real subprocess.
    const run = await reallyRun(task, root)
    expect(run.ok).toBe(true)
    expect(run.verify.map((r) => r.ok)).toEqual([true])

    const captured = await captureRunAsEval(run, task, { evalsPath })

    expect(captured.id).toMatch(/^eval_/)
    expect(captured.checks).toEqual([{ kind: 'verify-pass' }])
    // THE regression guard: the stored command must be the executable that ran,
    // never the result's name. `cmd: 'unit'` cannot be spawned.
    expect(captured.task.verify).toEqual([PASSING])
    expect(captured.task.verify[0]!.cmd).toBe(process.execPath)

    const onDisk = await readFile(evalsPath, 'utf8')
    expect(JSON.parse(onDisk.trim())).toEqual(captured)

    // Leg 2: replay the captured artifact. No verify stub, no injected root — the
    // harness makes its own workspace and spawns the captured command for real.
    const events = new MemoryEventStore({ secrets: [] })
    const result = await runEval(captured, {
      adapter: new FakeChatAdapter(),
      events,
      maxIterations: 6,
    })

    expect(result.score).toBe(1)
    expect(result.passed).toBe(true)
    expect(result.detail).toBe('1/1 checks passed')
  }, 30_000)

  it('appends, so a second capture does not clobber the first', async () => {
    const root = await makeTmp()
    const evalsPath = join(root, 'evals.jsonl')
    const task: Task = { id: 't', prompt: 'go', verify: [PASSING] }
    const run = fakeRun({ verify: [{ name: 'unit', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }] })

    const first = await captureRunAsEval(run, task, { evalsPath })
    const second = await captureRunAsEval(run, task, { evalsPath })

    const lines = (await readFile(evalsPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual([first.id, second.id])
  })
})

describe('captureRunAsEval refuses to claim what it cannot verify (Requirement 8.2)', () => {
  it('drops verify-pass when there is no Task to take verify commands from', async () => {
    const root = await makeTmp()
    const evalsPath = join(root, 'evals.jsonl')
    const run = fakeRun({
      verify: [{ name: 'unit', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }],
    })

    // Only verify-pass was asked for, and it cannot be honoured: nothing is written.
    await expect(
      captureRunAsEval(run, null, { evalsPath, checks: [{ kind: 'verify-pass' }] }),
    ).rejects.toBeInstanceOf(CaptureNotReplayableError)
    await expect(readFile(evalsPath, 'utf8')).rejects.toThrow()

    // With another check to carry, the case is written — minus verify-pass.
    const captured = await captureRunAsEval(run, null, {
      evalsPath,
      checks: [{ kind: 'verify-pass' }, { kind: 'not-contains', text: 'ZZZ-NEVER-SAID' }],
    })
    expect(captured.checks).toEqual([{ kind: 'not-contains', text: 'ZZZ-NEVER-SAID' }])
    expect(captured.task.verify).toEqual([])

    // And the honest case really does behave as captured: no invented command
    // means no verify stage, so nothing pretends to have been verified.
    const events = new MemoryEventStore({ secrets: [] })
    const result = await runEval(captured, {
      adapter: new FakeChatAdapter(),
      events,
      maxIterations: 6,
    })
    expect(result.score).toBe(1)
    expect(result.passed).toBe(true)
  }, 30_000)

  it('drops verify-pass when the captured run FAILED verification', async () => {
    const root = await makeTmp()
    const evalsPath = join(root, 'evals.jsonl')
    const task: Task = { id: 'task_failing', prompt: 'Build the project', verify: [FAILING] }

    const run = await reallyRun(task, root)
    expect(run.verify.some((r) => !r.ok)).toBe(true)

    // Nothing else to assert → loud refusal, no junk appended.
    const refused = await captureRunAsEval(run, task, { evalsPath }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(CaptureNotReplayableError)
    expect((refused as CaptureNotReplayableError).reasons.join(' ')).toContain(
      "run's verification failed",
    )

    // With an explicit assertion the run does satisfy, the case is written and
    // verify-pass is not smuggled in alongside it.
    const captured = await captureRunAsEval(run, task, {
      evalsPath,
      checks: [{ kind: 'verify-pass' }, { kind: 'not-contains', text: 'ZZZ-NEVER-SAID' }],
    })
    expect(captured.checks).toEqual([{ kind: 'not-contains', text: 'ZZZ-NEVER-SAID' }])
    // The commands are still captured faithfully — they are what ran.
    expect(captured.task.verify).toEqual([FAILING])
  }, 30_000)
})

describe('captured files carry no key material (Requirement 8.4)', () => {
  it('redacts secrets from the RAW BYTES on disk, not just the returned object', async () => {
    const root = await makeTmp()
    const secretKey = 'sk-proj-1234567890abcdef1234567890'
    process.env.TEST_SECRET_KEY = secretKey

    try {
      const run = fakeRun({
        runId: 'run_secret_123',
        finalText: `Done using key ${secretKey}`,
        verify: [{ name: 'unit', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }],
      })
      const task: Task = {
        id: 'task_secret',
        prompt: `Run with key ${secretKey}`,
        verify: [{ ...PASSING, args: ['-e', `void '${secretKey}'`] }],
      }

      const evalsPath = join(root, 'evals.jsonl')
      const captured = await captureRunAsEval(run, task, { evalsPath })

      // Raw bytes: the assertion that actually protects the artifact.
      const bytes = await readFile(evalsPath)
      expect(bytes.includes(secretKey)).toBe(false)
      expect(bytes.toString('utf8')).toContain('[redacted]')
      // ...and the returned object agrees with the file.
      expect(JSON.stringify(captured)).not.toContain(secretKey)
      expect(captured.task.prompt).not.toContain(secretKey)
    } finally {
      delete process.env.TEST_SECRET_KEY
    }
  })
})
