// Validates: Requirements 13.2, 13.3

import { describe, it, expect } from 'vitest'
import { createSketchClient, resolveTransport } from './factory'

describe('client factory', () => {
  it('defaults to a real transport, never the mock', () => {
    // Requirement 13.7: the mock is reachable only when it is asked for by name.
    expect(createSketchClient({ bridge: undefined, hasTauri: false }).transport).toBe('http')
    expect(createSketchClient({ bridge: undefined, hasTauri: true }).transport).toBe('stdio')
    expect(createSketchClient({ bridge: 'mock', hasTauri: false }).transport).toBe('mock')
  })

  it('resolves the transport from VITE_BRIDGE', () => {
    expect(resolveTransport({ bridge: undefined, hasTauri: false })).toBe('http')
    expect(resolveTransport({ bridge: undefined, hasTauri: true })).toBe('stdio')
    expect(resolveTransport({ bridge: '', hasTauri: true })).toBe('stdio')
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

  it('instantiates real clients for stdio and http transports', () => {
    const stdioClient = createSketchClient({ bridge: 'stdio', hasTauri: true })
    expect(stdioClient.transport).toBe('stdio')

    const httpClient = createSketchClient({ bridge: 'http', hasTauri: false })
    expect(httpClient.transport).toBe('http')
  })
})
