import { describe, it, expect } from 'vitest'
import { createSketchClient, resolveTransport } from './factory'
import { HttpSketchClient } from './httpClient'
import { StdioSketchClient } from './stdioClient'

describe('Phase 2 — Real Bridge and Transports Gate (Tasks 2.1 - 2.4)', () => {
  it('instantiates StdioSketchClient when bridge is stdio', async () => {
    const client = createSketchClient({ bridge: 'stdio' })
    expect(client).toBeInstanceOf(StdioSketchClient)
    expect(client.transport).toBe('stdio')
  })

  it('fails the stdio ping honestly when there is no sidecar to talk to', async () => {
    // Under vitest there is no Tauri webview, so no sidecar can be spawned. The
    // client must say so. It used to answer ok: true here with no engine behind
    // it, which made a broken engine look healthy (Requirement 13.7).
    const client = createSketchClient({ bridge: 'stdio' })
    await expect(client.ping()).rejects.toThrow(/sidecar unavailable/)
  })

  it('instantiates HttpSketchClient when bridge is http', async () => {
    const client = createSketchClient({ bridge: 'http' })
    expect(client).toBeInstanceOf(HttpSketchClient)
    expect(client.transport).toBe('http')
  })

  it('resolves auto mode correctly based on hasTauri environment', () => {
    expect(resolveTransport({ bridge: 'auto', hasTauri: true })).toBe('stdio')
    expect(resolveTransport({ bridge: 'auto', hasTauri: false })).toBe('http')
  })

  it('proves no mock client is instantiated when real transport is requested', () => {
    const clientStdio = createSketchClient({ bridge: 'stdio' })
    const clientHttp = createSketchClient({ bridge: 'http' })

    expect(clientStdio.transport).not.toBe('mock')
    expect(clientHttp.transport).not.toBe('mock')
  })
})
