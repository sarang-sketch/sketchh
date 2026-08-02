import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpSketchClient } from './httpClient'

const provider = {
  id: 'local-ollama',
  kind: 'openai-compatible' as const,
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5-coder:7b',
  label: 'Local Ollama',
}

function response(result: unknown) {
  return {
    ok: true,
    json: async () => ({ ok: true, result }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpSketchClient.run', () => {
  it('forwards the exact key-free provider entry in the run request', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ runId: 'http-run', ok: true, finalText: 'done', iterations: 1, verify: [], events: [] }),
    )
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('EventSource', undefined)
    const client = new HttpSketchClient({ baseUrl: 'http://127.0.0.1:1420' })

    await client.run(
      { id: 'provider-run', prompt: 'edit locally', verify: [] },
      { provider },
    )

    const init = fetch.mock.calls[0]![1] as RequestInit
    const frame = JSON.parse(String(init.body)) as { method: string; params: Record<string, unknown> }
    expect(frame.method).toBe('run')
    expect(frame.params.provider).toEqual(provider)
    expect(JSON.stringify(frame.params.provider)).not.toContain('apiKey')
  })

  it('does not fabricate a provider when none was selected', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ runId: 'http-run', ok: true, finalText: 'done', iterations: 1, verify: [], events: [] }),
    )
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('EventSource', undefined)
    const client = new HttpSketchClient()

    await client.run({ id: 'no-provider', prompt: 'fail honestly', verify: [] })

    const init = fetch.mock.calls[0]![1] as RequestInit
    const frame = JSON.parse(String(init.body)) as { params: Record<string, unknown> }
    expect(frame.params).not.toHaveProperty('provider')
  })

  it('forwards explicit skill promotion with the exact root and name', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ ok: true, name: 'reviewer', path: 'C:/repo/.sketch/skills/reviewer/SKILL.md', reason: null }),
    )
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('EventSource', undefined)
    const client = new HttpSketchClient({ baseUrl: 'http://127.0.0.1:1420' })

    await expect(client.skillPromote({ root: 'C:/repo', name: 'reviewer' })).resolves.toMatchObject({
      ok: true,
      name: 'reviewer',
    })

    const init = fetch.mock.calls[0]![1] as RequestInit
    const frame = JSON.parse(String(init.body)) as { method: string; params: Record<string, unknown> }
    expect(frame).toMatchObject({
      method: 'skill-promote',
      params: { root: 'C:/repo', name: 'reviewer' },
    })
  })
})