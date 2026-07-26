// Validates: Requirements 27.2, 27.3

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentTimeline, formatOffset, groupByRun } from './AgentTimeline'
import { MockSketchClient } from '../../lib/mockClient'
import type { SketchEvent } from '../../lib/contracts'

afterEach(cleanup)

async function realEvents(): Promise<SketchEvent[]> {
  const run = await new MockSketchClient({ stepDelayMs: 0 }).run({
    id: 'task-1',
    prompt: 'Add a health endpoint',
    verify: [{ name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] }],
  })
  return run.events
}

describe('AgentTimeline', () => {
  it('shows an honest empty state with no events', () => {
    render(<AgentTimeline events={[]} />)

    expect(screen.getByText('No events yet')).toBeDefined()
    expect(screen.getByText('0 events')).toBeDefined()
    // No sample rows of any kind.
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('renders every event of a run from the log alone', async () => {
    const events = await realEvents()
    render(<AgentTimeline events={events} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(events.length)
    expect(screen.getByText('run_started')).toBeDefined()
    expect(screen.getAllByText('llm_request')).toHaveLength(2)
    expect(screen.getByText('run_completed')).toBeDefined()
    // Outcome is derived from the terminal event, not from any side-channel state.
    expect(screen.getByText('completed')).toBeDefined()
    expect(screen.getByLabelText(`Run ${events[0]!.runId}`)).toBeDefined()
  })

  it('groups events by run and keeps first-seen order', () => {
    const event = (runId: string, id: string, ts: number): SketchEvent => ({
      id,
      ts,
      runId,
      kind: 'think',
      payload: {},
    })
    const groups = groupByRun([
      event('run-b', '1', 10),
      event('run-a', '2', 20),
      event('run-b', '3', 30),
    ])

    expect(groups.map((g) => g.runId)).toEqual(['run-b', 'run-a'])
    expect(groups[0]!.events).toHaveLength(2)
    expect(groups[0]!.startedTs).toBe(10)
  })

  it('formats elapsed time relative to the start of the run', () => {
    expect(formatOffset(0)).toBe('+0ms')
    expect(formatOffset(120)).toBe('+120ms')
    expect(formatOffset(1500)).toBe('+1.5s')
  })
})
