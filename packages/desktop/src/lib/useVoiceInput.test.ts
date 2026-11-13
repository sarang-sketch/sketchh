// useVoiceInput, driven against a mocked SpeechRecognition on window.
// The mock records the instance so the test can fire result/error/end
// events exactly as a browser would.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useVoiceInput, VOICE_UNSUPPORTED_ERROR } from './useVoiceInput'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
})

type Handler = (event: unknown) => void

class MockRecognition {
  static instances: MockRecognition[] = []
  lang = ''
  continuous = false
  interimResults = false
  onresult: Handler | null = null
  onerror: Handler | null = null
  onend: Handler | null = null
  started = false
  stopped = false

  constructor() {
    MockRecognition.instances.push(this)
  }

  start() {
    this.started = true
  }

  stop() {
    this.stopped = true
    this.onend?.(undefined)
  }

  emitResult(results: Array<{ transcript: string; isFinal: boolean }>) {
    const list = results.map((r) => ({
      isFinal: r.isFinal,
      length: 1,
      item: () => ({ transcript: r.transcript, isFinal: r.isFinal }),
      0: { transcript: r.transcript, isFinal: r.isFinal },
    }))
    this.onresult?.({ resultIndex: 0, results: list })
  }

  emitError(error: string) {
    this.onerror?.({ error })
  }
}

function installMock() {
  MockRecognition.instances = []
  ;(window as unknown as Record<string, unknown>).SpeechRecognition = MockRecognition
}

describe('useVoiceInput', () => {
  it('reports unsupported and start() is a no-op that sets the error, never throws', () => {
    const { result } = renderHook(() => useVoiceInput())
    expect(result.current.supported).toBe(false)
    expect(result.current.listening).toBe(false)
    expect(() => act(() => result.current.start())).not.toThrow()
    expect(result.current.error).toBe(VOICE_UNSUPPORTED_ERROR)
    expect(result.current.listening).toBe(false)
  })

  it('starts listening, shows interim results, and delivers final text via onFinal', () => {
    installMock()
    const onFinal = vi.fn()
    const { result } = renderHook(() => useVoiceInput({ onFinal }))
    expect(result.current.supported).toBe(true)

    act(() => result.current.start())
    expect(result.current.listening).toBe(true)
    expect(MockRecognition.instances).toHaveLength(1)
    expect(MockRecognition.instances[0]!.started).toBe(true)
    expect(MockRecognition.instances[0]!.interimResults).toBe(true)

    act(() => MockRecognition.instances[0]!.emitResult([{ transcript: 'hello ', isFinal: false }]))
    expect(result.current.transcript).toContain('hello')
    expect(onFinal).not.toHaveBeenCalled()

    act(() => MockRecognition.instances[0]!.emitResult([{ transcript: 'hello world', isFinal: true }]))
    expect(result.current.transcript).toContain('hello world')
    expect(onFinal).toHaveBeenCalledWith('hello world')

    // A second final result appends rather than replacing the first.
    act(() => MockRecognition.instances[0]!.emitResult([{ transcript: 'and more', isFinal: true }]))
    expect(result.current.transcript).toContain('hello world')
    expect(result.current.transcript).toContain('and more')
    expect(onFinal).toHaveBeenCalledWith('and more')
  })

  it('stop() ends listening, and an error surfaces as an error string', () => {
    installMock()
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())
    expect(result.current.listening).toBe(true)

    act(() => result.current.stop())
    expect(result.current.listening).toBe(false)
    expect(MockRecognition.instances[0]!.stopped).toBe(true)

    act(() => result.current.start())
    act(() => MockRecognition.instances[1]!.emitError('not-allowed'))
    expect(result.current.error).toMatch(/not-allowed/)
    expect(result.current.listening).toBe(false)
  })

  it('falls back to webkitSpeechRecognition when SpeechRecognition is absent', () => {
    ;(window as unknown as Record<string, unknown>).webkitSpeechRecognition = MockRecognition
    const { result } = renderHook(() => useVoiceInput())
    expect(result.current.supported).toBe(true)
    act(() => result.current.start())
    expect(result.current.listening).toBe(true)
  })
})
