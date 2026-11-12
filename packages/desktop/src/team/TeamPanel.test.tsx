import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SketchClientProvider } from '../lib/ClientProvider'
import type { SketchClient } from '../lib/client'
import { AppStateProvider } from '../state/AppState'
import { MAX_HANDOFFS } from './handoff'
import { TeamPanel } from './TeamPanel'

vi.mock('../lib/secrets', () => ({ resolveApiKeyForRun: vi.fn(async () => null) }))

afterEach(() => cleanup())

const OLLAMA = { id: 'ollama', kind: 'openai-compatible' as const, baseUrl: 'http://localhost:11434/v1', model: 'qwen', label: 'Ollama' }

/** A fake engine: `reply` decides each run's final text from the prompt it received. */
function fakeClient(reply: (prompt: string) => string) {
  const run = vi.fn(async (task: { prompt: string }, _options?: unknown) => ({ ok: true, finalText: reply(task.prompt), events: [] }))
  const client = {
    transport: 'mock',
    ping: async () => ({ ok: true, version: 'test', transport: 'mock' }),
    subscribe: () => () => {},
    run,
  } as unknown as SketchClient
  return { client, run }
}

function renderPanel(client: SketchClient, configured = true) {
  render(
    <SketchClientProvider client={client}>
      <AppStateProvider
        initial={{ mode: 'ide', projectRoot: '/proj', ...(configured ? { providers: [OLLAMA], selectedProvider: 'ollama' } : {}) }}
      >
        <TeamPanel />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

function send(text: string) {
  fireEvent.change(screen.getByLabelText(/Message the Frontend agent/), { target: { value: text } })
  fireEvent.click(screen.getByText('Send'))
}

describe('Build Team', () => {
  it('forwards a request from one role to another and runs it there', async () => {
    const { client, run } = fakeClient((prompt) =>
      prompt.startsWith('You are the Frontend agent')
        ? 'Built the todo page.\n@backend: add GET /api/todos returning a list'
        : 'Added GET /api/todos.',
    )
    renderPanel(client)
    send('Build a todo app')

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    const backendPrompt = (run.mock.calls[1]![0] as { prompt: string }).prompt
    expect(backendPrompt).toMatch(/^You are the Backend agent/)
    expect(backendPrompt).toContain('The Frontend agent says:\nadd GET /api/todos returning a list')
    // Both runs work in the open project with the selected model.
    expect(run.mock.calls[1]![1]).toMatchObject({ root: '/proj', provider: { id: 'ollama' } })

    fireEvent.click(screen.getByRole('tab', { name: /Backend/ }))
    expect(await screen.findByText('Added GET /api/todos.')).toBeTruthy()
    expect(screen.getByText('From Frontend')).toBeTruthy()
  })

  it('stops two roles that keep handing work back to each other', async () => {
    const { client, run } = fakeClient((prompt) =>
      prompt.startsWith('You are the Frontend agent') ? '@backend: your turn' : '@frontend: no, yours',
    )
    renderPanel(client)
    send('Start')

    await screen.findByText(/reached 6 hand-offs/, {}, { timeout: 3000 })
    expect(run).toHaveBeenCalledTimes(1 + MAX_HANDOFFS)
    expect(screen.getByText('0 hand-offs left for this message')).toBeTruthy()
  })

  it('says how to connect a model instead of failing silently', async () => {
    const { client, run } = fakeClient(() => 'unused')
    renderPanel(client, false)
    send('Build a todo app')
    expect(await screen.findByText(/Connect a model first/)).toBeTruthy()
    expect(run).not.toHaveBeenCalled()
  })
})
