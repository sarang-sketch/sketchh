import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkflowLibrary } from './WorkflowLibrary'
import { AgentChat } from './AgentChat'
import { ConfirmProvider } from '../../components/ConfirmDialog'
import { AppStateProvider, initialAppState, useAppState, type AppState } from '../../state/AppState'
import { AgentSessionProvider, useAgentSession } from '../../lib/AgentSession'
import { SketchClientProvider } from '../../lib/ClientProvider'
import type { SketchClient } from '../../lib/client'
import type { RunResult } from '../../lib/contracts'
import { WORKFLOWS, WORKFLOWS_STORAGE_KEY } from '../../workflows/catalog'

vi.mock('../../lib/secrets', () => ({ resolveApiKeyForRun: async () => null }))
beforeEach(() => { localStorage.clear(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

let state: AppState = initialAppState
function Pages() {
  state = useAppState()
  return state.agentView === 'workflows' ? <WorkflowLibrary /> : <AgentChat />
}
function StartRun() {
  const session = useAgentSession()
  return <button onClick={() => session.send('An existing task')}>Start test run</button>
}
function mount(run = vi.fn(async (): Promise<RunResult> => ({ runId: 'r', ok: true, finalText: 'done', iterations: 1, verify: [], events: [] }))) {
  const client = { transport: 'mock', ping: async () => ({ ok: true, version: 'test', transport: 'mock' }), subscribe: () => () => {}, run } as unknown as SketchClient
  const result = render(<SketchClientProvider client={client}><AppStateProvider initial={{ agentView: 'workflows', projectRoot: 'C:/project', providerSettingsPath: '/test/providers.json', providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://localhost:1', model: 'test', label: 'Local' }], selectedProvider: 'local', selectedModel: 'test' }}><ConfirmProvider><AgentSessionProvider><Pages /><StartRun /></AgentSessionProvider></ConfirmProvider></AppStateProvider></SketchClientProvider>)
  return { ...result, run }
}

describe('personal workflows', () => {
  it('saves, finds and reuses a personal copy without modifying the built-in or calling a model', async () => {
    const user = userEvent.setup()
    const { run, unmount } = mount()
    await user.click(screen.getByRole('button', { name: /Review my changes/ }))
    fireEvent.change(screen.getByLabelText('Workflow instructions'), { target: { value: 'Review accessibility and keyboard navigation.' } })
    await user.click(screen.getByRole('button', { name: 'Save a personal copy' }))
    const name = screen.getByLabelText('Workflow name')
    await user.clear(name)
    await user.type(name, 'Accessibility review')
    await user.click(screen.getByRole('button', { name: 'Save workflow' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Workflow saved on this device.')
    const stored = JSON.parse(localStorage.getItem(WORKFLOWS_STORAGE_KEY)!)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ title: 'Accessibility review', prompt: 'Review accessibility and keyboard navigation.', mode: 'ask', personal: true })
    expect(WORKFLOWS.find((w) => w.id === 'review')?.prompt).toContain('git status')
    unmount()
    mount(run)
    await user.click(screen.getByRole('button', { name: 'Personal' }))
    await user.type(screen.getByLabelText('Search workflows'), 'accessibility')
    await user.click(screen.getByRole('button', { name: /Accessibility review/ }))
    await user.click(screen.getByRole('button', { name: 'Use workflow' }))
    expect((await screen.findByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('Review accessibility and keyboard navigation.')
    expect(state.agentPrefs.mode).toBe('ask')
    expect(run).not.toHaveBeenCalled()
  })

  it('edits and deletes a personal workflow through its controls', async () => {
    const user = userEvent.setup()
    localStorage.setItem(WORKFLOWS_STORAGE_KEY, JSON.stringify([{ id: 'personal-example', title: 'My review', description: '', prompt: 'Review the API.', mode: 'ask', category: 'Review' }]))
    mount()
    await user.click(screen.getByRole('button', { name: /My review/ }))
    await user.click(screen.getByRole('button', { name: 'Edit workflow' }))
    fireEvent.change(screen.getByLabelText('Workflow instructions'), { target: { value: 'Review the API and its tests.' } })
    await user.click(screen.getByRole('button', { name: 'Save workflow' }))
    expect(JSON.parse(localStorage.getItem(WORKFLOWS_STORAGE_KEY)!)[0].prompt).toBe('Review the API and its tests.')
    await user.click(screen.getByRole('button', { name: 'Delete workflow' }))
    await user.click(within(screen.getByRole('alertdialog', { name: 'Delete workflow?' })).getByRole('button', { name: 'Delete workflow' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(WORKFLOWS_STORAGE_KEY)!)).toEqual([]))
    expect(screen.queryByRole('button', { name: /My review/ })).toBeNull()
  })

  it('keeps unsaved instructions on a storage failure and scrubs key-shaped text before saving', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))
    await user.type(screen.getByLabelText('Workflow name'), 'My checks')
    fireEvent.change(screen.getByLabelText('Workflow instructions'), { target: { value: 'Check config for sk-ABCDEFGHIJKLMNOP' } })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    await user.click(screen.getByRole('button', { name: 'Save workflow' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('could not save'))
    expect((screen.getByLabelText('Workflow instructions') as HTMLTextAreaElement).value).toContain('Check config')
    expect(localStorage.getItem(WORKFLOWS_STORAGE_KEY)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save workflow' }))
    expect(localStorage.getItem(WORKFLOWS_STORAGE_KEY)).toContain('[redacted]')
    expect(localStorage.getItem(WORKFLOWS_STORAGE_KEY)).not.toContain('sk-ABCDEFGHIJKLMNOP')
  })

  it('does not replace an active run when preparing another workflow', async () => {
    const user = userEvent.setup()
    const run = vi.fn(() => new Promise<RunResult>(() => {}))
    mount(run)
    await user.click(screen.getByRole('button', { name: 'Start test run' }))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('button', { name: /Build a feature/ }))
    expect((screen.getByRole('button', { name: 'Use workflow' }) as HTMLButtonElement).disabled).toBe(true)
    expect(state.agentView).toBe('workflows')
    expect(run).toHaveBeenCalledOnce()
  })
})

