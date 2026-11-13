// Cost grouping: pure rollups over CostEntry fixtures. Unknown cost stays
// unknown (totalCost null), never $0.

import { describe, expect, it } from 'vitest'

import type { CostEntry } from '../lib/client'
import { groupByModel, groupByModelAndDay } from './costGrouping'

function entry(partial: Partial<CostEntry> = {}): CostEntry {
  return {
    runId: 'run-1',
    eventId: 'evt-1',
    ts: 0,
    iteration: 1,
    model: 'gpt-4o',
    provider: 'openai',
    usage: { in: 10, out: 5 },
    usd: 0.01,
    matched: 'gpt-4o',
    local: false,
    ...partial,
  }
}

describe('groupByModel', () => {
  it('sums priced calls per model and sorts by total cost descending', () => {
    const groups = groupByModel([
      entry({ eventId: 'e1', model: 'gpt-4o', usd: 0.02 }),
      entry({ eventId: 'e2', model: 'gpt-4o', usd: 0.03 }),
      entry({ eventId: 'e3', model: 'claude-3-5-sonnet', usd: 0.10 }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].model).toBe('claude-3-5-sonnet')
    expect(groups[0].totalCost).toBeCloseTo(0.1)
    expect(groups[0].calls).toBe(1)
    expect(groups[1].model).toBe('gpt-4o')
    expect(groups[1].totalCost).toBeCloseTo(0.05)
    expect(groups[1].calls).toBe(2)
    expect(groups[1].unknownCostCalls).toBe(0)
  })

  it('counts unpriced calls and reports totalCost null when nothing was priced', () => {
    const groups = groupByModel([
      entry({ eventId: 'e1', model: 'mystery-model', usd: null }),
      entry({ eventId: 'e2', model: 'mystery-model', usd: null }),
      entry({ eventId: 'e3', model: 'gpt-4o', usd: 0.01 }),
    ])
    expect(groups[0].model).toBe('gpt-4o')
    const mystery = groups[1]
    expect(mystery.model).toBe('mystery-model')
    expect(mystery.totalCost).toBeNull()
    expect(mystery.unknownCostCalls).toBe(2)
    expect(mystery.calls).toBe(2)
  })

  it('mixes priced and unpriced calls in one group without zeroing the unknown half', () => {
    const [group] = groupByModel([
      entry({ eventId: 'e1', model: 'gpt-4o', usd: 0.04 }),
      entry({ eventId: 'e2', model: 'gpt-4o', usd: null }),
    ])
    expect(group.totalCost).toBeCloseTo(0.04)
    expect(group.unknownCostCalls).toBe(1)
    expect(group.calls).toBe(2)
  })

  it('labels a null model instead of dropping the calls', () => {
    const [group] = groupByModel([entry({ eventId: 'e1', model: null, usd: 0.01 })])
    expect(group.model).toBe('model not recorded')
    expect(group.calls).toBe(1)
  })

  it('returns an empty list for no entries', () => {
    expect(groupByModel([])).toEqual([])
  })
})

describe('groupByModelAndDay', () => {
  it('groups by UTC day from ts and sorts newest day first', () => {
    const groups = groupByModelAndDay([
      entry({ eventId: 'e1', ts: Date.parse('2026-11-12T10:00:00Z'), model: 'gpt-4o', usd: 0.02 }),
      entry({ eventId: 'e2', ts: Date.parse('2026-11-13T10:00:00Z'), model: 'gpt-4o', usd: 0.05 }),
      entry({ eventId: 'e3', ts: Date.parse('2026-11-13T11:00:00Z'), model: 'gpt-4o', usd: 0.01 }),
      entry({ eventId: 'e4', ts: Date.parse('2026-11-13T11:00:00Z'), model: 'other-model', usd: null }),
    ])
    expect(groups).toHaveLength(3)
    expect(groups[0].day).toBe('2026-11-13')
    expect(groups[0].model).toBe('gpt-4o')
    expect(groups[0].totalCost).toBeCloseTo(0.06)
    expect(groups[0].calls).toBe(2)
    // The unpriced model on the same day sorts after the priced one.
    expect(groups[1].day).toBe('2026-11-13')
    expect(groups[1].model).toBe('other-model')
    expect(groups[1].totalCost).toBeNull()
    expect(groups[2].day).toBe('2026-11-12')
  })
})
