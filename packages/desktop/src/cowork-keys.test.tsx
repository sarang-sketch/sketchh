// Cowork, by keyboard and while reading.
//
//   * Enter that confirms a word in a Japanese/Chinese/Korean input method does not
//     send a half-typed message.
//   * Suggestion cards and Recents are buttons: Space works as well as Enter, and the
//     keyboard opens a conversation exactly as a click does.
//   * Reading an earlier answer while a run streams: the chat no longer drags the
//     reader back down; a "Jump to latest" button waits instead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { SketchClient } from './lib/client'
import { SketchClientProvider } from './lib/ClientProvider'
import type { ProviderSettingsEntry, RunResult, SketchEvent } from './lib/contracts'
import { AppStateProvider, useAppDispatch, useAppState, type Conversation } from './state/AppState'
import { AgentChat, MessageList } from './panels/agent/AgentChat'
import { ConversationSidebar } from './panels/agent/ConversationSidebar'
import { AgentSessionProvider } from './lib/AgentSession'
import { isActivationKey, isComposing } from './lib/keys'

const resolveApiKeyForRun = vi.hoisted(() => vi.fn(async () => null as string | null))
vi.mock('./lib/secrets', () => ({ resolveApiKeyForRun }))

const provider: ProviderSettingsEntry = { id: 'p', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', label: 'P' }
const base = { projectRoot: 'C:\\workspace', providers: [provider], selectedProvider: 'p', selectedModel: 'm' }

function client(run = vi.fn(async (_task: unknown, _options?: unknown): Promise<RunResult> => ({ runId: 'r', ok: true, finalText: 'done', iterations: 1, verify: [], events: [] }))) {
  const handlers = new Set<(event: SketchEvent) => void>()
  return {
    run,
    client: {
      transport: 'mock',
      ping: async () => ({ ok: true, version: 'test', transport: 'mock' }),
      run,
      reply: vi.fn(async (runId: string) => ({ runId, answered: true })),
      cancel: vi.fn(async (runId: string) => ({ runId, cancelled: true })),
      subscribe: (handler: (event: SketchEvent) => void) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    } as unknown as SketchClient,
  }
}

const scrolled = vi.fn()
beforeEach(() => {
  scrolled.mockReset()
  Element.prototype.scrollIntoView = scrolled
})
afterEach(() => cleanup())

describe('keyboard helpers', () => {
  it('recognise a composition however the webview reports it', () => {
    expect(isComposing({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(true)
    expect(isComposing({ key: 'Enter', keyCode: 229 })).toBe(true)
    expect(isComposing({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } })).toBe(false)
    expect(isActivationKey({ key: ' ' })).toBe(true)
    expect(isActivationKey({ key: 'Enter' })).toBe(true)
    expect(isActivationKey({ key: 'a' })).toBe(false)
  })
})

describe('the composer and an input method', () => {
  it('Enter that confirms a composed word does not send; the next Enter does', async () => {
    const { client: c, run } = client()
    render(
      <SketchClientProvider client={c}>
        <AppStateProvider initial={base}>
          <AgentSessionProvider>
            <AgentChat />
          </AgentSessionProvider>
        </AppStateProvider>
      </SketchClientProvider>,
    )
    const box = screen.getByLabelText('Message the agent') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'にほんご', selectionStart: 4 } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    // A send is asynchronous (the key is resolved first): give one the time to happen.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(run).not.toHaveBeenCalled()
    expect(box.value).toBe('にほんご')

    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![0]).toMatchObject({ prompt: expect.stringContaining('にほんご') })
  })
})

describe('keyboard navigation', () => {
  it('a native task starter answers Space without starting a model run', async () => {
    const user = userEvent.setup()
    const { client: c, run } = client()
    render(
      <SketchClientProvider client={c}>
        <AppStateProvider initial={base}>
          <AgentSessionProvider>
            <AgentChat />
          </AgentSessionProvider>
        </AppStateProvider>
      </SketchClientProvider>,
    )
    const card = screen.getByRole('button', { name: /Find & fix a bug/ })
    card.focus()
    await user.keyboard(' ')
    expect((screen.getByLabelText('Message the agent') as HTMLTextAreaElement).value).toContain('bug')
    expect(run).not.toHaveBeenCalled()
  })

  it('opening a conversation by keyboard does what a click does', () => {
    const conversation: Conversation = {
      id: 'c1',
      title: 'Fix the login form',
      messages: [{ id: 'm1', role: 'user', content: 'Fix the login form', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 2,
      root: 'C:/elsewhere/app',
    }
    function Probe() {
      const state = useAppState()
      return <div data-testid="probe">{`${state.agentView}|${state.activeConversationId}|${state.projectRoot}`}</div>
    }
    const { client: c } = client()
    render(
      <SketchClientProvider client={c}>
        <AppStateProvider initial={{ ...base, agentView: 'projects', conversations: [conversation] }}>
          <AgentSessionProvider>
            <ConversationSidebar />
            <Probe />
          </AgentSessionProvider>
        </AppStateProvider>
      </SketchClientProvider>,
    )
    const row = screen.getByText('Fix the login form').closest('[role="button"]') as HTMLElement
    fireEvent.keyDown(row, { key: ' ' })
    const [view, active, root] = screen.getByTestId('probe').textContent!.split('|')
    expect(view).toBe('new_task')
    expect(active).toBe('c1')
    // W2 (fix-workspace-paths.md §4.2): selecting a conversation NEVER moves the
    // workspace boundary when a folder is already open. The keyboard path must do
    // exactly what the click does — select the conversation and leave projectRoot at the
    // already-open 'C:\\workspace', NOT narrow it to the conversation's own root. (This
    // assertion was stale on the pre-W2 contract; W10 invariant 1 un-stales it.)
    expect(root?.replace(/\\/g, '/').toLowerCase()).toBe('c:/workspace')
  })
})

describe('following a streaming conversation', () => {
  function AddMessage() {
    const dispatch = useAppDispatch()
    return (
      <button
        onClick={() =>
          dispatch({ type: 'ADD_MESSAGE', payload: { id: `a${Math.random()}`, role: 'agent', content: 'more output', timestamp: Date.now() } })
        }
      >
        add
      </button>
    )
  }

  function mountList() {
    const { client: c } = client()
    render(
      <SketchClientProvider client={c}>
        <AppStateProvider
          initial={{ ...base, chatMessages: [{ id: 'u1', role: 'user', content: 'start', timestamp: 1 }] }}
        >
          <AgentSessionProvider>
            <div data-testid="scroller" style={{ overflowY: 'auto', height: 200 }}>
              <MessageList compact />
            </div>
            <AddMessage />
          </AgentSessionProvider>
        </AppStateProvider>
      </SketchClientProvider>,
    )
    const scroller = screen.getByTestId('scroller')
    // jsdom has no layout: give the scroller the geometry of a long conversation.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })
    return scroller
  }

  function scrollTo(scroller: HTMLElement, top: number) {
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: top })
    fireEvent.scroll(scroller)
  }

  it('follows new output while the reader is at the end', () => {
    const scroller = mountList()
    scrollTo(scroller, 1800)
    scrolled.mockClear()
    fireEvent.click(screen.getByText('add'))
    expect(scrolled).toHaveBeenCalled()
    expect(screen.queryByText(/Jump to latest/)).toBeNull()
  })

  it('leaves a reader who scrolled up where they are, and offers the way back', async () => {
    const scroller = mountList()
    scrollTo(scroller, 300)
    scrolled.mockClear()
    fireEvent.click(screen.getByText('add'))
    expect(scrolled).not.toHaveBeenCalled()
    const jump = await screen.findByText(/Jump to latest/)

    fireEvent.click(jump)
    expect(scrolled).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText(/Jump to latest/)).toBeNull())
    // Following again: the next output scrolls.
    scrolled.mockClear()
    act(() => {
      fireEvent.click(screen.getByText('add'))
    })
    expect(scrolled).toHaveBeenCalled()
  })
})
