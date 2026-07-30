// Ghost completion timing/cancellation with a deterministic fake provider.
// **Validates: Requirements 15.5**

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GHOST_COMPLETIONS_ENABLED,
  GHOST_COMPLETION_DEBOUNCE_MS,
  GhostCompletionController,
  type GhostCompletionRequest,
} from './ghostCompletion'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const input = (content: string) => ({
  path: 'C:/app/a.ts',
  content,
  cursorOffset: content.length,
})

describe('GhostCompletionController', () => {
  it('is off by default and performs no provider work', () => {
    vi.useFakeTimers()
    const provider = vi.fn(async () => 'ghost')
    const seen: Array<string | null> = []
    const controller = new GhostCompletionController({ provider, onSuggestion: (value) => seen.push(value) })

    expect(DEFAULT_GHOST_COMPLETIONS_ENABLED).toBe(false)
    controller.update(input('a'))
    vi.advanceTimersByTime(GHOST_COMPLETION_DEBOUNCE_MS * 2)
    expect(provider).not.toHaveBeenCalled()
    expect(seen).toEqual([])
    vi.useRealTimers()
  })

  it('keeps the synchronous keystroke path below one 16ms frame', () => {
    vi.useFakeTimers()
    const controller = new GhostCompletionController({
      provider: async () => 'ghost',
      enabled: () => true,
      onSuggestion: () => {},
    })
    const started = performance.now()
    for (let i = 0; i < 100; i++) controller.update(input(`text-${i}`))
    expect(performance.now() - started).toBeLessThan(16)
    vi.useRealTimers()
  })

  it('debounces a burst into one request for the newest snapshot', async () => {
    vi.useFakeTimers()
    const requests: GhostCompletionRequest[] = []
    const controller = new GhostCompletionController({
      provider: async (request) => { requests.push(request); return ' newest' },
      enabled: () => true,
      onSuggestion: () => {},
    })

    controller.update(input('a'))
    controller.update(input('ab'))
    controller.update(input('abc'))
    await vi.advanceTimersByTimeAsync(GHOST_COMPLETION_DEBOUNCE_MS)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.content).toBe('abc')
    vi.useRealTimers()
  })

  it('aborts in-flight work and discards a stale provider that ignores abort', async () => {
    vi.useFakeTimers()
    const first = deferred<string | null>()
    const second = deferred<string | null>()
    const requests: GhostCompletionRequest[] = []
    const seen: Array<string | null> = []
    const controller = new GhostCompletionController({
      enabled: () => true,
      provider: (request) => {
        requests.push(request)
        return requests.length === 1 ? first.promise : second.promise
      },
      onSuggestion: (value) => seen.push(value),
    })

    controller.update(input('old'))
    await vi.advanceTimersByTimeAsync(GHOST_COMPLETION_DEBOUNCE_MS)
    controller.update(input('new'))
    expect(requests[0]!.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(GHOST_COMPLETION_DEBOUNCE_MS)

    second.resolve(' fresh')
    await Promise.resolve()
    expect(controller.suggestion).toBe(' fresh')

    // This provider violates cancellation and resolves late. Request-id checking is
    // the independent guard that prevents it replacing the newer decoration.
    first.resolve(' stale')
    await Promise.resolve()
    expect(controller.suggestion).toBe(' fresh')
    expect(seen).not.toContain(' stale')
    vi.useRealTimers()
  })

  it('never mutates the input snapshot when a suggestion arrives', async () => {
    vi.useFakeTimers()
    const snapshot = input('const value = 1')
    const controller = new GhostCompletionController({
      provider: async () => '\n// suggested',
      enabled: () => true,
      onSuggestion: () => {},
    })
    controller.update(snapshot)
    await vi.advanceTimersByTimeAsync(GHOST_COMPLETION_DEBOUNCE_MS)
    expect(snapshot.content).toBe('const value = 1')
    vi.useRealTimers()
  })
})
