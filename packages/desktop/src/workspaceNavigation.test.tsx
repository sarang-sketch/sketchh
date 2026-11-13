import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppLayout } from './components/AppLayout'
import { Shortcuts } from './App'
import { ConfirmProvider } from './components/ConfirmDialog'
import { AppStateProvider, initialAppState, makeFileEntry, useAppDispatch, useAppState, type AppState } from './state/AppState'
import { SketchClientProvider } from './lib/ClientProvider'
import { AgentSessionProvider } from './lib/AgentSession'
import { TerminalRunnerProvider } from './terminal/TerminalRunner'
import type { SketchClient } from './lib/client'
import { FileIoProvider } from './editor/FileIoProvider'
import { createFakeDisk } from './editor/fakeDisk'
import { createMonacoDouble } from './editor/monacoDouble'

let monaco: ReturnType<typeof createMonacoDouble>
vi.mock('./editor/monacoSetup', () => ({ loadMonaco: () => Promise.resolve({ api: monaco.api, theme: 'sketch-dark' }) }))
vi.mock('./lib/secrets', () => ({ resolveApiKeyForRun: async () => null }))

const ROOT = 'C:/work/project'
const FILE = ROOT + '/src/main.ts'
let state: AppState = initialAppState
let dispatch: ReturnType<typeof useAppDispatch>
const StateProbe = () => { state = useAppState(); dispatch = useAppDispatch(); return null }

beforeEach(() => { monaco = createMonacoDouble(); localStorage.clear(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); localStorage.clear() })

function mount(initial: Partial<AppState> = {}, onlyShortcuts = false) {
  const run = vi.fn()
  const client = { transport: 'mock', ping: async () => ({ ok: true, version: 'test', transport: 'mock' }), subscribe: () => () => {}, run } as unknown as SketchClient
  const disk = createFakeDisk({ [FILE]: 'export const answer = 42' })
  const result = render(<FileIoProvider io={disk.io}><SketchClientProvider client={client}>
    <AppStateProvider initial={{ providerSettingsPath: '/test/providers.json', ...initial }}><ConfirmProvider><AgentSessionProvider><TerminalRunnerProvider>
      <Shortcuts /><StateProbe />{!onlyShortcuts && <AppLayout />}
      {onlyShortcuts && <><div className="monaco-editor"><textarea aria-label="Editor keyboard target" /></div><div className="xterm"><textarea aria-label="Terminal keyboard target" /></div><button>Outside editor</button></>}
    </TerminalRunnerProvider></AgentSessionProvider></ConfirmProvider></AppStateProvider>
  </SketchClientProvider></FileIoProvider>)
  return { ...result, run, disk }
}

describe('the Code and Cowork workspaces', () => {
  it('loads Code on first visit, makes inactive surfaces inert, and shares unsent work', async () => {
    const user = userEvent.setup()
    const { run } = mount()
    const welcome = await screen.findByRole('heading', { name: 'What will you work on today?' })
    expect(document.querySelector('[aria-label="Code agent"]')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'An unfinished idea' } })
    await user.click(screen.getByRole('button', { name: 'Code' }))
    // Code's first visit imports the real workbench; allow for cold transforms.
    await screen.findByRole('complementary', { name: 'Code agent' }, { timeout: 10000 })
    expect(welcome.closest('[aria-hidden="true"]')?.hasAttribute('inert')).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('An unfinished idea')
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Refined in Code' } })
    await user.click(screen.getByRole('button', { name: 'Cowork' }))
    expect((screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('Refined in Code')
    expect(screen.queryByRole('complementary', { name: 'Code agent' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Workflows/ }))
    await screen.findByRole('region', { name: 'Workflow library' })
    act(() => dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' }))
    expect((screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('Refined in Code')
    expect(run).not.toHaveBeenCalled()
  })

  it('attaches real files without replacing the draft, and restores it after hiding the agent', async () => {
    const user = userEvent.setup()
    mount({ mode: 'ide', projectRoot: ROOT, openFiles: [FILE], activeFile: FILE, files: { [FILE]: { ...makeFileEntry(FILE, 'unsaved work'), isDirty: true } }, bottomPanelOpen: false })
    const agent = await screen.findByRole('complementary', { name: 'Code agent' })
    fireEvent.change(within(agent).getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Explain this function' } })
    await user.click(within(agent).getByRole('tab', { name: 'Context' }))
    expect(within(agent).getByRole('tabpanel', { name: 'Context' }).textContent).toContain(ROOT)
    await user.click(within(agent).getByRole('button', { name: 'Attach src/main.ts' }))
    expect(within(agent).getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('true')
    expect((within(agent).getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('Explain this function')
    expect(within(agent).getByRole('button', { name: 'Remove src/main.ts' })).toBeTruthy()
    await user.click(within(agent).getByRole('button', { name: 'Close panel' }))
    expect(screen.queryByRole('complementary', { name: 'Code agent' })).toBeNull()
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    const restored = await screen.findByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
    expect(restored.value).toBe('Explain this function')
    expect(screen.getByRole('button', { name: 'Remove src/main.ts' })).toBeTruthy()
    expect(state.files[FILE]?.content).toBe('unsaved work')
    expect(state.files[FILE]?.isDirty).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Customize layout' }))
    await user.click(screen.getByRole('menuitem', { name: /Enter focus mode/ }))
    expect(screen.queryByRole('complementary', { name: 'Code agent' })).toBeNull()
    fireEvent.keyDown(window, { key: 'L', ctrlKey: true, shiftKey: true })
    expect((await screen.findByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('Explain this function')
    expect(state.focusMode).toBe(false)
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    expect((screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByRole('button', { name: 'Remove src/main.ts' })).toBeNull()
  })

  it('opens Appearance and applies layouts through the actual command palette', async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByRole('heading', { name: 'What will you work on today?' })
    await user.click(screen.getByRole('button', { name: 'Customize layout' }))
    await user.click(screen.getByRole('menuitem', { name: 'Appearance & customization' }))
    await screen.findByRole('region', { name: 'Appearance preferences' })
    await user.selectOptions(screen.getByLabelText('Agent panel position'), 'left')
    await user.selectOptions(screen.getByLabelText('Project sidebar position'), 'right')
    await user.selectOptions(screen.getByLabelText('Activity bar position'), 'top')
    act(() => dispatch({ type: 'CLOSE_SETTINGS' }))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(state.paletteOpen).toBe('commands'))
    expect(await screen.findByRole('dialog', { name: /command/i })).toBeTruthy()
    act(() => { dispatch({ type: 'CLOSE_PALETTE' }); dispatch({ type: 'APPLY_LAYOUT_PRESET', payload: 'write' }) })
    await screen.findByRole('heading', { name: 'Build with Sketch' })
    expect(state.mode).toBe('ide')
    expect(state.rightPanelCollapsed).toBe(true)
    expect(state.ideActivePanel).toBeNull()
    expect(document.querySelector('[data-agent="left"][data-sidebar="right"][data-activity="top"]')).toBeTruthy()
  })
})

describe('shortcut ownership', () => {
  it('leaves Ctrl+L with Monaco and the terminal, and focuses the agent elsewhere', () => {
    mount({ mode: 'ide' }, true)
    for (const name of ['Editor keyboard target', 'Terminal keyboard target']) {
      const event = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true })
      fireEvent(screen.getByLabelText(name), event)
      expect(event.defaultPrevented).toBe(false)
      expect(state.composerFocusNonce).toBe(0)
    }
    fireEvent.keyDown(screen.getByRole('button', { name: 'Outside editor' }), { key: 'l', ctrlKey: true })
    expect(state.composerFocusNonce).toBe(1)
    expect(state.rightPanelCollapsed).toBe(false)
  })
})

