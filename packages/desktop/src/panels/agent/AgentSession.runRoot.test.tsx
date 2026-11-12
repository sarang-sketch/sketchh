// A follow-up run uses the ACTIVE CONVERSATION's own root, not the workspace boundary —
// and a conversation that ran OUTSIDE the open workspace cannot start a run at all.
//
// Selecting a conversation never moves the workspace root (W2 invariants 1-2; see
// ConversationSidebar.test.tsx). But a conversation's history and @file references are
// relative to the folder it ran in, so a follow-up must run against THAT root when it is
// inside the open workspace. A conversation rooted outside the workspace must never run
// here (it would execute against the wrong root): the composer blocks send.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunOptions, SketchClient } from '../../lib/client'
import { SketchClientProvider } from '../../lib/ClientProvider'
import type { ProviderSettingsEntry, RunResult, Task } from '../../lib/contracts'
import { AppStateProvider, type AppState } from '../../state/AppState'
import { AgentChat } from './AgentChat'

const resolveApiKeyForRun = vi.hoisted(() =>
  vi.fn<(id: string, onProblem?: (reason: string) => void) => Promise<string | null>>(),
)
vi.mock('../../lib/secrets', () => ({ resolveApiKeyForRun }))

const ollama: ProviderSettingsEntry = {
  id: 'ollama-local',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5-coder:7b',
  label: 'Local Ollama',
}

function clientWith(run: (task: Task, options?: RunOptions) => Promise<RunResult>): SketchClient {
  return {
    transport: 'mock',
    ping: async () => ({ ok: true, version: 'test', transport: 'mock' }),
    run,
    subscribe: () => () => {},
  } as unknown as SketchClient
}

function result(): RunResult {
  return { runId: 'run-root-test', ok: true, finalText: 'done', iterations: 1, verify: [], events: [] }
}

function conversation(id: string, root: string | null): AppState['conversations'][number] {
  return {
    id,
    title: 'prior work',
    root,
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { id: 'u1', role: 'user', content: 'start', timestamp: 1 },
      { id: 'a1', role: 'agent', content: 'done', timestamp: 2 },
    ],
  }
}

function mount(run: (t: Task, o?: RunOptions) => Promise<RunResult>, initial: Partial<AppState>) {
  render(
    <SketchClientProvider client={clientWith(run)}>
      <AppStateProvider
        initial={{
          providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
          providers: [ollama],
          selectedProvider: ollama.id,
          selectedModel: ollama.model,
          ...initial,
        }}
      >
        <AgentChat />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

function type(value: string) {
  const box = screen.getByLabelText('Message the agent')
  fireEvent.change(box, { target: { value } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  resolveApiKeyForRun.mockReset()
  resolveApiKeyForRun.mockResolvedValue(null)
})
afterEach(() => cleanup())

describe('AgentSession — the run root follows the conversation, not the workspace boundary', () => {
  it('runs a follow-up against the conversation\u2019s own root when it is INSIDE the workspace', async () => {
    const run = vi.fn(async (_t: Task, _o?: RunOptions) => result())
    const workspace = 'C:/Users/me/project'
    const nested = 'C:/Users/me/project/web-app'
    mount(run, {
      projectRoot: workspace,
      conversations: [conversation('c-nested', nested)],
      activeConversationId: 'c-nested',
      chatMessages: [
        { id: 'u1', role: 'user', content: 'start', timestamp: 1 },
        { id: 'a1', role: 'agent', content: 'done', timestamp: 2 },
      ],
    })

    type('continue in this nested project')

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    // The run uses the nested conversation root — NOT the workspace root.
    expect(run.mock.calls[0]![1]?.root).toBe(nested)
  })

  it('runs against the workspace root when the active conversation has no root of its own', async () => {
    const run = vi.fn(async (_t: Task, _o?: RunOptions) => result())
    const workspace = 'C:/Users/me/project'
    mount(run, {
      projectRoot: workspace,
      conversations: [conversation('c-none', null)],
      activeConversationId: 'c-none',
      chatMessages: [
        { id: 'u1', role: 'user', content: 'start', timestamp: 1 },
        { id: 'a1', role: 'agent', content: 'done', timestamp: 2 },
      ],
    })

    type('keep going')

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![1]?.root).toBe(workspace)
  })

  it('does NOT start a run for a conversation that ran OUTSIDE the workspace, and says to open that folder', async () => {
    const run = vi.fn(async (_t: Task, _o?: RunOptions) => result())
    const workspace = 'C:/Users/me/project'
    const elsewhere = 'C:/Users/me/other-repo'
    mount(run, {
      projectRoot: workspace,
      conversations: [conversation('c-out', elsewhere)],
      activeConversationId: 'c-out',
      chatMessages: [
        { id: 'u1', role: 'user', content: 'start', timestamp: 1 },
        { id: 'a1', role: 'agent', content: 'done', timestamp: 2 },
      ],
    })

    type('please continue')

    // The send is blocked and a plain notice explains why; no run executes.
    expect(await screen.findAllByText(/Open that folder to continue it|ran in/i)).not.toHaveLength(0)
    expect(run).not.toHaveBeenCalled()
  })
})
