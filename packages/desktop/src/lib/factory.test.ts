// Validates: Requirements 13.2, 13.3

import { describe, it, expect } from 'vitest'
import { createSketchClient, resolveTransport } from './factory'

describe('client factory', () => {
  it('returns the mock client under the default environment', () => {
    const client = createSketchClient({ bridge: undefined, hasTauri: false })
    expect(client.transport).toBe('mock')
  })

  it('resolves the transport from VITE_BRIDGE', () => {
    expect(resolveTransport({ bridge: undefined, hasTauri: false })).toBe('mock')
    expect(resolveTransport({ bridge: '', hasTauri: true })).toBe('mock')
    expect(resolveTransport({ bridge: 'mock', hasTauri: true })).toBe('mock')
    expect(resolveTransport({ bridge: 'stdio', hasTauri: false })).toBe('stdio')
    expect(resolveTransport({ bridge: 'http', hasTauri: false })).toBe('http')
    // 'auto' is the phase-2 shape: real transport for the host it runs on.
    expect(resolveTransport({ bridge: 'auto', hasTauri: true })).toBe('stdio')
    expect(resolveTransport({ bridge: 'auto', hasTauri: false })).toBe('http')
  })

  it('rejects an unknown transport instead of silently falling back to the mock', () => {
    expect(() => resolveTransport({ bridge: 'grpc', hasTauri: false })).toThrow(/not a transport/)
  })

  it('names the task that will implement each unbuilt transport', () => {
    expect(() => createSketchClient({ bridge: 'stdio', hasTauri: true })).toThrow(/task 2\.1/)
    expect(() => createSketchClient({ bridge: 'http', hasTauri: false })).toThrow(/task 2\.2/)
  })
})
