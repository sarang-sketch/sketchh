// Editor integration for optional ghost text. The provider is deterministic and
// local; suggestions remain view state and stale responses never render.
// **Validates: Requirements 15.5**

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { AppStateProvider, makeFileEntry, useAppState } from '../state/AppState'
import CodeEditor from './CodeEditor'
import { createMonacoDouble, doubleLoader } from './monacoDouble'
import { GHOST_COMPLETION_DEBOUNCE_MS, type GhostCompletionRequest } from './ghostCompletion'

const FILE = 'C:/app/a.ts'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function Probe() {
  const state = useAppState()
  return <span data-testid="content">{state.files[FILE]?.content}</span>
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('CodeEditor ghost completion integration', () => {
  it('renders only the newest suggestion without adding it to AppState content', async () => {
    vi.useFakeTimers()
    const monaco = createMonacoDouble()
    const old = deferred<string | null>()
    const fresh = deferred<string | null>()
    const requests: GhostCompletionRequest[] = []
    const provider = (request: GhostCompletionRequest) => {
      requests.push(request)
      return requests.length === 1 ? old.promise : fresh.promise
    }
    render(
      <AppStateProvider initial={{
        mode: 'ide',
        projectRoot: 'C:/app',
        openFiles: [FILE],
        activeFile: FILE,
        files: { [FILE]: makeFileEntry(FILE, 'a') },
        ghostCompletionsEnabled: true,
      }}>
        <CodeEditor loader={doubleLoader(monaco)} completionProvider={provider} />
        <Probe />
      </AppStateProvider>,
    )
    await act(async () => { await Promise.resolve() })

    act(() => monaco.model(FILE).typeText('old input'))
    await act(async () => { await vi.advanceTimersByTimeAsync(GHOST_COMPLETION_DEBOUNCE_MS) })
    act(() => monaco.model(FILE).typeText('new input'))
    expect(requests[0]!.signal.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(GHOST_COMPLETION_DEBOUNCE_MS) })

    await act(async () => { fresh.resolve(' fresh suggestion'); await Promise.resolve() })
    expect(screen.getByLabelText('Ghost completion').textContent).toBe(' fresh suggestion')
    expect(screen.getByTestId('content').textContent).toBe('new input')

    await act(async () => { old.resolve(' stale suggestion'); await Promise.resolve() })
    expect(screen.getByLabelText('Ghost completion').textContent).toBe(' fresh suggestion')
    expect(screen.getByTestId('content').textContent).not.toContain('suggestion')
  })
})
