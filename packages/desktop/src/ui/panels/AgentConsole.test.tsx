// Validates: Requirements 27.1, 27.3

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentConsole, pairTurns } from './AgentConsole'
import { MockSketchClient } from '../../lib/mockClient'
import type { SketchEvent } from '../../lib/contracts'

afterEach(cleanup)

async function realEvents(): Promise<SketchEvent[]> {
  const run = await new MockSketchClient({ stepDelayMs: 0 }).run({
    id: 'task-1',
    prompt: 'Add a health endpoint',
    verify: [],
  })
  return run.events
}

describe('AgentConsole', () => {
  it('shows an honest empty state with no model traffic', () => {
    render(<AgentConsole events={[]} />)

    expect(screen.getByText('No model traffic yet')).toBeDefined()
    expect(screen.getByText('0 turns')).toBeDefined()
  })

  it('pairs each request with the response that answered it', async () => {
    const events = await realEvents()
    const turns = pairTurns(events)

    expect(turns).toHaveLength(2)
    expect(turns.every((t) => t.response !== null)).toBe(true)
    expect(turns[0]!.iteration).toBe(1)
    expect(turns[1]!.iteration).toBe(2)
    expect(turns[0]!.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(turns[1]!.response!.text).toContain('Add a health endpoint')
    expect(turns[1]!.response!.usage!.out).toBeGreaterThan(0)
  })

  it('renders the messages sent, the text returned, and the usage', async () => {
    const events = await realEvents()
    render(<AgentConsole events={events} />)

    expect(screen.getAllByText('Request')).toHaveLength(2)
    expect(screen.getAllByText('Response')).toHaveLength(2)
    // The prompt is carried by the user message of both turns.
    expect(screen.getAllByText('Add a health endpoint')).toHaveLength(2)
    expect(screen.getAllByText(/tokens in · \d+ tokens out/)).toHaveLength(2)
    expect(screen.queryByText('Awaiting response…')).toBeNull()
  })

  it('leaves an unanswered request pending instead of borrowing another answer', () => {
    const request = (id: string, runId: string, iteration: number): SketchEvent => ({
      id,
      ts: 1,
      runId,
      kind: 'llm_request',
      payload: { model: 'm', iteration, messages: [{ role: 'user', content: 'hi' }] },
    })

    const turns = pairTurns([
      request('a', 'run-1', 1),
      request('b', 'run-2', 1),
      {
        id: 'c',
        ts: 2,
        runId: 'run-2',
        kind: 'llm_response',
        payload: { model: 'm', iteration: 1, text: 'answer for run-2', usage: { in: 3, out: 4 } },
      },
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]!.response).toBeNull()
    expect(turns[1]!.response!.text).toBe('answer for run-2')
  })

  it('renders the pending state for an in-flight request', () => {
    render(
      <AgentConsole
        events={[
          {
            id: 'a',
            ts: 1,
            runId: 'run-1',
            kind: 'llm_request',
            payload: { model: 'm', iteration: 1, messages: [{ role: 'user', content: 'hi' }] },
          },
        ]}
      />,
    )

    expect(screen.getByText('Awaiting response…')).toBeDefined()
    expect(screen.getByText(/^1 turn/)).toBeDefined()
  })
})
