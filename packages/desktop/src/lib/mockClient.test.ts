// Validates: Requirements 13.1, 13.2

import { describe, it, expect } from 'vitest'
import { MockSketchClient } from './mockClient'
import type { SketchEvent, Task } from './contracts'

const task: Task = {
  id: 'task-1',
  prompt: 'Add a health endpoint',
  verify: [{ name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] }],
}

function client() {
  // Zero delay keeps the suite fast; the sequence is unchanged.
  return new MockSketchClient({ stepDelayMs: 0 })
}

describe('MockSketchClient', () => {
  it('emits the full event sequence in order', async () => {
    const c = client()
    const seen: SketchEvent[] = []
    c.subscribe((e) => seen.push(e))

    const result = await c.run(task)

    expect(seen.map((e) => e.kind)).toEqual([
      'run_started',
      'llm_request',
      'llm_response',
      'plan_written',
      'llm_request',
      'llm_response',
      'verify_started',
      'verify_result',
      'run_completed',
    ])
    // The promise result replays the same log, so a caller that never subscribed
    // still gets the whole run.
    expect(result.events).toEqual(seen)
    expect(new Set(seen.map((e) => e.id)).size).toBe(seen.length)
    expect(seen.every((e) => e.runId === result.runId)).toBe(true)
  })

  it('streams events during the run rather than only at completion', async () => {
    // A gated sleep makes the timing deterministic: each release advances the run
    // by exactly one step, so we can observe the log filling in mid-run.
    const gates: Array<() => void> = []
    const c = new MockSketchClient({
      stepDelayMs: 1,
      sleep: () => new Promise<void>((resolve) => gates.push(resolve)),
    })

    const seen: SketchEvent[] = []
    c.subscribe((e) => seen.push(e))

    let resolved = false
    const pending = c.run(task).then((r) => {
      resolved = true
      return r
    })

    const step = async () => {
      gates.shift()!()
      await Promise.resolve()
    }

    await step()
    expect(seen.map((e) => e.kind)).toEqual(['run_started'])
    expect(resolved).toBe(false)

    await step()
    expect(seen).toHaveLength(2)
    expect(resolved).toBe(false)

    while (gates.length > 0) await step()
    const result = await pending

    expect(resolved).toBe(true)
    expect(seen).toHaveLength(result.events.length)
  })

  it('reports usage on every llm_response', async () => {
    const c = client()
    const result = await c.run(task)
    const responses = result.events.filter((e) => e.kind === 'llm_response')

    expect(responses).toHaveLength(2)
    for (const response of responses) {
      const usage = response.payload.usage as { in: number; out: number }
      expect(usage.in).toBeGreaterThan(0)
      expect(usage.out).toBeGreaterThan(0)
    }
  })

  it('answers ping offline and names itself as the mock transport', async () => {
    const ping = await client().ping()
    expect(ping.ok).toBe(true)
    expect(ping.transport).toBe('mock')
  })

  it('stops delivering events after unsubscribe', async () => {
    const c = client()
    const seen: SketchEvent[] = []
    const unsubscribe = c.subscribe((e) => seen.push(e))
    unsubscribe()

    await c.run(task)
    expect(seen).toEqual([])
  })

  it('scores eval cases against the run it just performed', async () => {
    const [result] = await client().eval([
      {
        id: 'case-1',
        task,
        checks: [{ kind: 'verify-pass' }, { kind: 'contains', text: 'health endpoint' }],
      },
    ])

    expect(result).toBeDefined()
    expect(result!.caseId).toBe('case-1')
    expect(result!.passedChecks).toBe(2)
    expect(result!.totalChecks).toBe(2)
    expect(result!.score).toBe(1)
    expect(result!.passed).toBe(true)
  })
})
