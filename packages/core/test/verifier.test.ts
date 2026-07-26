// Tests for the verify loop

import { describe, it, expect, vi } from 'vitest'
import { Verifier } from '../src/verifier/verifier.js'
import { VerifyLoop, type Fixer } from '../src/verifier/verify-loop.js'
import type {
  CommandRunner,
  CommandOutput,
  DetectedProject,
} from '../src/verifier/types.js'

// A programmable fake runner. Maps a check command to a queued result.
class FakeRunner implements CommandRunner {
  public calls: Array<{ command: string; args: string[] }> = []
  constructor(private results: Map<string, CommandOutput[]>) {}

  async run(command: string, args: string[]): Promise<CommandOutput> {
    this.calls.push({ command, args })
    const key = `${command} ${args.join(' ')}`.trim()
    const queue = this.results.get(key)
    if (queue && queue.length > 0) return queue.shift()!
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

const nodeProject = (): DetectedProject => ({
  root: '/fake/project',
  language: 'node',
  checks: [
    { name: 'lint', command: 'npm', args: ['run', 'lint'] },
    { name: 'typecheck', command: 'npx', args: ['tsc', '--noEmit'] },
    { name: 'test', command: 'npm', args: ['test'] },
  ],
})

describe('Verifier', () => {
  it('passes when all checks exit 0', async () => {
    const runner = new FakeRunner(new Map())
    const verifier = new Verifier(runner)
    const result = await verifier.verifyDetected(nodeProject())
    expect(result.passed).toBe(true)
    expect(result.checks.filter(c => !c.skipped)).toHaveLength(3)
  })

  it('fails when a check exits non-zero', async () => {
    const runner = new FakeRunner(new Map([
      ['npx tsc --noEmit', [{ exitCode: 2, stdout: '', stderr: 'type error' }]],
    ]))
    const verifier = new Verifier(runner)
    const result = await verifier.verifyDetected(nodeProject())
    expect(result.passed).toBe(false)
    const tc = result.checks.find(c => c.name === 'typecheck')
    expect(tc?.passed).toBe(false)
    expect(tc?.output).toContain('type error')
  })

  it('runs checks in canonical order', async () => {
    const runner = new FakeRunner(new Map())
    const verifier = new Verifier(runner)
    // Provide checks out of order
    await verifier.verifyDetected({
      root: '/x',
      language: 'node',
      checks: [
        { name: 'test', command: 'npm', args: ['test'] },
        { name: 'lint', command: 'npm', args: ['run', 'lint'] },
      ],
    })
    // lint should have run before test
    const lintIdx = runner.calls.findIndex(c => c.args.includes('lint'))
    const testIdx = runner.calls.findIndex(c => c.args.includes('test'))
    expect(lintIdx).toBeLessThan(testIdx)
  })

  it('failFast stops at first failure', async () => {
    const runner = new FakeRunner(new Map([
      ['npm run lint', [{ exitCode: 1, stdout: '', stderr: 'lint failed' }]],
    ]))
    const verifier = new Verifier(runner)
    const result = await verifier.verifyDetected(nodeProject(), { failFast: true })
    expect(result.passed).toBe(false)
    // Only lint ran (plus skipped placeholders); typecheck/test not executed
    expect(runner.calls).toHaveLength(1)
  })

  it('marks absent checks as skipped', async () => {
    const runner = new FakeRunner(new Map())
    const verifier = new Verifier(runner)
    const result = await verifier.verifyDetected({
      root: '/x', language: 'node',
      checks: [{ name: 'lint', command: 'npm', args: ['run', 'lint'] }],
    })
    const build = result.checks.find(c => c.name === 'build')
    expect(build?.skipped).toBe(true)
    expect(result.passed).toBe(true)
  })

  it('only option runs a subset', async () => {
    const runner = new FakeRunner(new Map())
    const verifier = new Verifier(runner)
    await verifier.verifyDetected(nodeProject(), { only: ['lint'] })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].args).toContain('lint')
  })
})

describe('VerifyLoop', () => {
  it('returns passed immediately when checks pass', async () => {
    const runner = new FakeRunner(new Map())
    const loop = new VerifyLoop(new Verifier(runner))
    const fixer: Fixer = { fix: vi.fn().mockResolvedValue(true) }
    const result = await loop.run('/fake', fixer, { runner, project: nodeProject() })
    expect(result.status).toBe('passed')
    expect(result.attempts).toBe(0)
    expect(fixer.fix).not.toHaveBeenCalled()
  })

  it('fixes a failing check and passes on retry', async () => {
    // typecheck fails first call, passes second call
    const runner = new FakeRunner(new Map([
      ['npx tsc --noEmit', [
        { exitCode: 2, stdout: '', stderr: 'type error' },
        { exitCode: 0, stdout: '', stderr: '' },
      ]],
    ]))
    const loop = new VerifyLoop(new Verifier(runner))
    const fixer: Fixer = { fix: vi.fn().mockResolvedValue(true) }
    const result = await loop.run('/fake', fixer, { runner, project: nodeProject() })
    expect(result.status).toBe('passed')
    expect(result.attempts).toBe(1)
    expect(fixer.fix).toHaveBeenCalledOnce()
  })

  it('exhausts after maxAttempts if never fixed', async () => {
    const runner = new FakeRunner(new Map([
      ['npm run lint', Array(10).fill({ exitCode: 1, stdout: '', stderr: 'lint failed' })],
    ]))
    const loop = new VerifyLoop(new Verifier(runner))
    const fixer: Fixer = { fix: vi.fn().mockResolvedValue(true) }
    const result = await loop.run('/fake', fixer, { runner, maxAttempts: 3, project: nodeProject() })
    expect(result.status).toBe('exhausted')
    expect(result.attempts).toBe(3)
    expect(fixer.fix).toHaveBeenCalledTimes(3)
  })

  it('gives up when fixer returns false', async () => {
    const runner = new FakeRunner(new Map([
      ['npm run lint', Array(10).fill({ exitCode: 1, stdout: '', stderr: 'lint failed' })],
    ]))
    const loop = new VerifyLoop(new Verifier(runner))
    const fixer: Fixer = { fix: vi.fn().mockResolvedValue(false) }
    const result = await loop.run('/fake', fixer, { runner, maxAttempts: 3, project: nodeProject() })
    expect(result.status).toBe('gave_up')
    expect(result.attempts).toBe(1)
  })

  it('passes failing checks to the fixer', async () => {
    const runner = new FakeRunner(new Map([
      ['npm run lint', [
        { exitCode: 1, stdout: '', stderr: 'lint failed' },
        { exitCode: 0, stdout: '', stderr: '' },
      ]],
    ]))
    const loop = new VerifyLoop(new Verifier(runner))
    let seen: string[] = []
    const fixer: Fixer = {
      fix: async ctx => { seen = ctx.failingChecks.map(c => c.name); return true },
    }
    await loop.run('/fake', fixer, { runner, project: nodeProject() })
    expect(seen).toContain('lint')
  })

  it('records history of every verify pass', async () => {
    const runner = new FakeRunner(new Map([
      ['npm run lint', [
        { exitCode: 1, stdout: '', stderr: 'fail' },
        { exitCode: 0, stdout: '', stderr: '' },
      ]],
    ]))
    const loop = new VerifyLoop(new Verifier(runner))
    const fixer: Fixer = { fix: vi.fn().mockResolvedValue(true) }
    const result = await loop.run('/fake', fixer, { runner, project: nodeProject() })
    expect(result.history).toHaveLength(2) // initial fail + post-fix pass
  })
})
