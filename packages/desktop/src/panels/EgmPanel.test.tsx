// EGM panel: the seven skills, the workflow, the honest limit, and the
// reviewer-context preview — with no engine behind it (the client is a stub).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { SketchClient } from '../lib/client'
import { SketchClientProvider } from '../lib/ClientProvider'
import { AppStateProvider } from '../state/AppState'
import { EgmPanel } from './EgmPanel'

afterEach(cleanup)

function clientWith(
  egmGoldfishContext: SketchClient['egmGoldfishContext'],
): SketchClient {
  return {
    transport: 'mock',
    ping: async () => ({ ok: true, version: 'test', transport: 'mock' }),
    run: async () => {
      throw new Error('no run in this test')
    },
    subscribe: () => () => {},
    ...(egmGoldfishContext !== undefined ? { egmGoldfishContext } : {}),
  } as unknown as SketchClient
}

function renderPanel(client: SketchClient) {
  render(
    <SketchClientProvider client={client}>
      <AppStateProvider
        initial={{ projectRoot: '/tmp/sketch-egm-test', activeFile: 'docs/designs/webhooks.md' }}
      >
        <EgmPanel />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

describe('EgmPanel', () => {
  it('lists all seven skills with their commands', () => {
    renderPanel(clientWith(undefined))
    for (const command of [
      'egm-brainstorm',
      'egm-draft',
      'egm-review',
      'egm-resolve',
      'egm-bootstrap',
      'egm-drift-report',
      'egm-review-loop',
    ]) {
      expect(screen.getByText(`/${command}`)).toBeTruthy()
    }
    expect(screen.getAllByText('Brainstorm').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Review loop')).toBeTruthy()
  })

  it('states the fresh-eyes rule and the honest limit', () => {
    renderPanel(clientWith(undefined))
    expect(screen.getByText(/no prior conversation/)).toBeTruthy()
    expect(screen.getByText(/cannot yet spawn isolated subagent contexts/)).toBeTruthy()
    expect(screen.getByText(/github\.com\/google\/elephant-goldfish-model/)).toBeTruthy()
    expect(screen.getByText(/Apache-2\.0/)).toBeTruthy()
  })

  it('marks the review commands as fresh-session', () => {
    renderPanel(clientWith(undefined))
    expect(screen.getAllByText('fresh session')).toHaveLength(2)
  })

  it('prefills the target from the open Markdown file', () => {
    renderPanel(clientWith(undefined))
    const input = screen.getByLabelText('Design document') as HTMLInputElement
    expect(input.value).toBe('docs/designs/webhooks.md')
  })

  it('previews what the reviewers will see — including zero prior turns', async () => {
    const egmGoldfishContext = vi.fn(async () => ({
      ok: true as const,
      target: { path: 'docs/designs/webhooks.md', content: '# Webhooks\n' },
      files: [{ path: 'src/app.ts', content: 'export const app = 1\n' }],
      excluded: [{ link: 'https://example.com/x.md', reason: 'url' as const }],
      priorChatTurns: 0 as const,
      note: 'Goldfish context.',
    }))
    renderPanel(clientWith(egmGoldfishContext))
    fireEvent.click(screen.getByText('Preview reviewer context'))
    await waitFor(() => expect(egmGoldfishContext).toHaveBeenCalledTimes(1))
    expect(egmGoldfishContext).toHaveBeenCalledWith({
      root: '/tmp/sketch-egm-test',
      target: 'docs/designs/webhooks.md',
    })
    await waitFor(() => expect(screen.getByText(/Prior chat turns/)).toBeTruthy())
    expect(screen.getByText(/src\/app\.ts/)).toBeTruthy()
    // The reviewers see zero prior turns: the number is its own element.
    expect(screen.getByText('0')).toBeTruthy()
  })

  it('says so when the transport has no reviewer-context preview', async () => {
    renderPanel(clientWith(undefined))
    fireEvent.click(screen.getByText('Preview reviewer context'))
    await waitFor(() =>
      expect(screen.getByText(/does not offer the reviewer-context preview/)).toBeTruthy(),
    )
  })

  it('starting a fresh review without a live session opens a new conversation', () => {
    renderPanel(clientWith(undefined))
    fireEvent.click(screen.getAllByText('Run fresh review')[0]!)
    expect(screen.getByText(/New conversation started/)).toBeTruthy()
    expect(screen.getByText(/Press Enter to run the review/)).toBeTruthy()
  })

  it('says the project is needed when no folder is open', () => {
    render(
      <SketchClientProvider client={clientWith(undefined)}>
        <AppStateProvider initial={{ projectRoot: null }}>
          <EgmPanel />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    expect(screen.getByText('No folder open')).toBeTruthy()
  })
})
