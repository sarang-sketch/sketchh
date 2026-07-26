// Tests for memory + orchestrator

import { describe, it, expect, vi } from 'vitest'
import { MemoryProjectMemory } from '../src/memory/project-memory.js'
import { extractJson } from '../src/orchestrator/json.js'
import { topoSort, Orchestrator, type ContextProvider } from '../src/orchestrator/orchestrator.js'
import { isWithin, type FileWriter } from '../src/orchestrator/file-writer.js'
import type { Plan, FileEdit } from '../src/orchestrator/types.js'
import type { VerifyLoopResult } from '../src/verifier/index.js'

// ── MemoryProjectMemory ──────────────────────────────────────────────────────

describe('MemoryProjectMemory', () => {
  let clock: number
  const mk = () => new MemoryProjectMemory(() => clock)

  it('stores and lists decisions', async () => {
    clock = 100
    const m = mk()
    await m.addDecision({ id: 'd1', summary: 'use Tauri', rationale: 'small binary' })
    const decisions = await m.listDecisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0].createdAt).toBe(100)
  })

  it('sets and gets standards', async () => {
    const m = mk()
    clock = 1
    await m.setStandard('indent', '2 spaces')
    expect(await m.getStandard('indent')).toBe('2 spaces')
    expect(await m.getStandard('missing')).toBeNull()
  })

  it('finds bugs by file', async () => {
    const m = mk()
    clock = 1
    await m.addBug({ id: 'b1', description: 'null deref', fix: 'guard', files: ['a.ts'] })
    await m.addBug({ id: 'b2', description: 'off by one', fix: 'use <=', files: ['b.ts'] })
    const found = await m.findBugsByFile('a.ts')
    expect(found).toHaveLength(1)
    expect(found[0].id).toBe('b1')
  })

  it('lists test records most-recent-first with limit', async () => {
    const m = mk()
    clock = 1; await m.addTestRecord({ id: 't1', checkName: 'lint', passed: true, output: '' })
    clock = 2; await m.addTestRecord({ id: 't2', checkName: 'test', passed: false, output: 'x' })
    const recent = await m.listTestRecords(1)
    expect(recent).toHaveLength(1)
    expect(recent[0].id).toBe('t2')
  })

  it('digest summarises standards, decisions, and bugs', async () => {
    const m = mk()
    clock = 1
    await m.setStandard('lang', 'TypeScript')
    await m.addDecision({ id: 'd1', summary: 'no consensus engine', rationale: 'too costly' })
    await m.addBug({ id: 'b1', description: 'race condition', fix: 'add lock', files: ['x.ts'] })
    const digest = await m.digest()
    expect(digest).toContain('TypeScript')
    expect(digest).toContain('no consensus engine')
    expect(digest).toContain('race condition')
  })

  it('digest is empty for a fresh project', async () => {
    expect(await mk().digest()).toBe('')
  })
})

// ── extractJson ──────────────────────────────────────────────────────────────

describe('extractJson', () => {
  it('parses raw JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses fenced json block', () => {
    const text = 'Here is the plan:\n```json\n{"a":2}\n```\nDone.'
    expect(extractJson(text)).toEqual({ a: 2 })
  })

  it('parses fenced block without json tag', () => {
    expect(extractJson('```\n{"b":3}\n```')).toEqual({ b: 3 })
  })

  it('recovers JSON embedded in prose', () => {
    expect(extractJson('blah blah {"c":4} trailing')).toEqual({ c: 4 })
  })

  it('handles nested braces and strings with braces', () => {
    const text = 'x {"msg":"a {nested} brace","n":{"deep":1}} y'
    expect(extractJson(text)).toEqual({ msg: 'a {nested} brace', n: { deep: 1 } })
  })

  it('returns null when no JSON present', () => {
    expect(extractJson('just prose, no json')).toBeNull()
  })
})

// ── topoSort ─────────────────────────────────────────────────────────────────

describe('topoSort', () => {
  const plan = (steps: Plan['steps']): Plan => ({
    taskId: 't', summary: '', steps, estimatedFiles: [],
  })

  it('orders dependencies before dependents', () => {
    const p = plan([
      { id: 's2', description: '', files: [], dependsOn: ['s1'] },
      { id: 's1', description: '', files: [], dependsOn: [] },
    ])
    const order = topoSort(p).map(s => s.id)
    expect(order.indexOf('s1')).toBeLessThan(order.indexOf('s2'))
  })

  it('handles independent steps', () => {
    const p = plan([
      { id: 'a', description: '', files: [], dependsOn: [] },
      { id: 'b', description: '', files: [], dependsOn: [] },
    ])
    expect(topoSort(p)).toHaveLength(2)
  })

  it('does not loop forever on cycles', () => {
    const p = plan([
      { id: 'a', description: '', files: [], dependsOn: ['b'] },
      { id: 'b', description: '', files: [], dependsOn: ['a'] },
    ])
    expect(topoSort(p)).toHaveLength(2)
  })
})

// ── isWithin ─────────────────────────────────────────────────────────────────

describe('isWithin', () => {
  it('accepts paths inside root', () => {
    expect(isWithin('/project', '/project/src/a.ts')).toBe(true)
  })
  it('accepts root itself', () => {
    expect(isWithin('/project', '/project')).toBe(true)
  })
  it('rejects paths outside root', () => {
    expect(isWithin('/project', '/etc/passwd')).toBe(false)
  })
  it('rejects parent traversal', () => {
    expect(isWithin('/project/sub', '/project/secret.ts')).toBe(false)
  })
})

// ── Orchestrator (full flow with fakes) ─────────────────────────────────────

describe('Orchestrator', () => {
  // Fakes for every dependency.
  const fakeContext: ContextProvider = {
    retrieve: async () => ({ chunks: [{ path: 'a.ts', content: 'existing code' }] }),
  }

  const fakePlan: Plan = {
    taskId: 't', summary: 'do the thing',
    steps: [{ id: 's1', description: 'write a.ts', files: ['a.ts'], dependsOn: [] }],
    estimatedFiles: ['a.ts'],
  }

  const fakePlanner = { plan: vi.fn().mockResolvedValue(fakePlan) }
  const fakeRunner = {
    runStep: vi.fn().mockResolvedValue({
      stepId: 's1',
      edits: [{ path: 'a.ts', content: 'new code' } as FileEdit],
      notes: 'done',
    }),
  }

  const captureWriter = (): { writer: FileWriter; written: string[] } => {
    const written: string[] = []
    return {
      written,
      writer: { apply: async (_root, edits) => { written.push(...edits.map(e => e.path)); return edits.map(e => e.path) } },
    }
  }

  const passingLoop = (result: Partial<VerifyLoopResult> = {}) => ({
    run: vi.fn().mockResolvedValue({
      status: 'passed',
      attempts: 0,
      finalResult: { passed: true, checks: [{ name: 'test', passed: true, output: '', durationMs: 1, skipped: false }] },
      history: [],
      ...result,
    } as VerifyLoopResult),
  })

  it('runs plan → execute → verify → done on success', async () => {
    const { writer, written } = captureWriter()
    const memory = new MemoryProjectMemory(() => 1)
    const events: string[] = []

    const orch = new Orchestrator({
      planner: fakePlanner as never,
      runner: fakeRunner as never,
      verifyLoop: passingLoop() as never,
      context: fakeContext,
      memory,
      fileWriter: writer,
    })

    const result = await orch.run('/project', 'build a feature', {
      onEvent: e => events.push(e.type),
    })

    expect(result.status).toBe('done')
    expect(written).toContain('a.ts')
    expect(events).toContain('plan')
    expect(events).toContain('file_edit')
    expect(events).toContain('done')
    // test history recorded in memory
    expect(await memory.listTestRecords()).toHaveLength(1)
  })

  it('returns needs_human when verification cannot pass', async () => {
    const { writer } = captureWriter()
    const failingLoop = {
      run: vi.fn().mockResolvedValue({
        status: 'exhausted',
        attempts: 3,
        finalResult: { passed: false, checks: [{ name: 'test', passed: false, output: 'boom', durationMs: 1, skipped: false }] },
        history: [],
      } as VerifyLoopResult),
    }

    const orch = new Orchestrator({
      planner: fakePlanner as never,
      runner: fakeRunner as never,
      verifyLoop: failingLoop as never,
      context: fakeContext,
      memory: new MemoryProjectMemory(() => 1),
      fileWriter: writer,
    })

    const result = await orch.run('/project', 'build a feature')
    expect(result.status).toBe('needs_human')
  })

  it('respects plan approval rejection', async () => {
    const { writer } = captureWriter()
    // Fresh runner so the assertion is not polluted by other tests' calls.
    const localRunner = { runStep: vi.fn().mockResolvedValue({ stepId: 's1', edits: [], notes: '' }) }
    const orch = new Orchestrator({
      planner: fakePlanner as never,
      runner: localRunner as never,
      verifyLoop: passingLoop() as never,
      context: fakeContext,
      memory: new MemoryProjectMemory(() => 1),
      fileWriter: writer,
      requireApproval: true,
    })

    const result = await orch.run('/project', 'build', {
      approvePlan: async () => false,
    })
    expect(result.status).toBe('cancelled')
    // runner should never have executed
    expect(localRunner.runStep).not.toHaveBeenCalled()
  })

  it('emits an error event when a dependency throws', async () => {
    const throwingPlanner = { plan: vi.fn().mockRejectedValue(new Error('planner down')) }
    const { writer } = captureWriter()
    const events: Array<{ type: string }> = []

    const orch = new Orchestrator({
      planner: throwingPlanner as never,
      runner: fakeRunner as never,
      verifyLoop: passingLoop() as never,
      context: fakeContext,
      memory: new MemoryProjectMemory(() => 1),
      fileWriter: writer,
    })

    const result = await orch.run('/project', 'build', { onEvent: e => events.push(e) })
    expect(result.status).toBe('error')
    expect(result.summary).toContain('planner down')
    expect(events.some(e => e.type === 'error')).toBe(true)
  })
})
