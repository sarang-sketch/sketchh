// Validates: Requirements 13.1, 13.6, 27.2

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { SketchClientProvider, useEngineStatus, useSketchEvents } from './ClientProvider'
import { MockSketchClient } from './mockClient'
import { AgentTimeline } from '../ui/panels/AgentTimeline'

afterEach(cleanup)

function Probe() {
  const events = useSketchEvents()
  const status = useEngineStatus()
  return (
    <div>
      <span>{`state:${status.state}`}</span>
      <span>{`transport:${status.ping?.transport ?? 'none'}`}</span>
      <AgentTimeline events={events} />
    </div>
  )
}

describe('SketchClientProvider', () => {
  it('pings on startup and accumulates the run event log for panels', async () => {
    const client = new MockSketchClient({ stepDelayMs: 0 })
    render(
      <SketchClientProvider client={client}>
        <Probe />
      </SketchClientProvider>,
    )

    // Before any run the Timeline is empty and says so.
    expect(screen.getByText('No events yet')).toBeDefined()

    await act(async () => {
      await client.ping()
    })
    expect(screen.getByText('state:ready')).toBeDefined()
    expect(screen.getByText('transport:mock')).toBeDefined()

    await act(async () => {
      await client.run({
        id: 'task-1',
        prompt: 'Ship it',
        verify: [{ name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] }],
      })
    })

    // The panel saw the events through the seam, not through a prop drill.
    // Nine events: one per step of the run, verify included.
    expect(screen.getAllByRole('listitem')).toHaveLength(9)
    expect(screen.getByText('run_completed')).toBeDefined()
  })

  it('refuses to hand out a client outside the provider', () => {
    expect(() => render(<Probe />)).toThrow(/SketchClientProvider/)
  })
})
