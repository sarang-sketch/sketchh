// API Lab: pure helpers with a mocked fetch (no network), plus the panel
// sending through that mock. History never carries header values or bodies.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  clearHistory,
  executeRequest,
  HISTORY_KEY,
  parseHeaders,
  pushHistory,
  readHistory,
  scrubHeaders,
  truncateBody,
} from './apiLab'
import { ApiLab } from './ApiLab'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

beforeEach(() => {
  window.localStorage.clear()
})

describe('parseHeaders', () => {
  it('parses Key: value lines and reports unparseable ones', () => {
    const { headers, errors } = parseHeaders('Content-Type: application/json\nX-Custom:  42  \n\nno-colon-here')
    expect(headers).toEqual({ 'Content-Type': 'application/json', 'X-Custom': '42' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('no-colon-here')
  })
})

describe('scrubHeaders', () => {
  it('redacts authorization, cookie and x-api-key values, case-insensitively', () => {
    const scrubbed = scrubHeaders({
      Authorization: 'Bearer secret',
      'X-Api-Key': 'key-123',
      Cookie: 'session=abc',
      'Content-Type': 'application/json',
    })
    expect(scrubbed.Authorization).toBe('[redacted]')
    expect(scrubbed['X-Api-Key']).toBe('[redacted]')
    expect(scrubbed.Cookie).toBe('[redacted]')
    expect(scrubbed['Content-Type']).toBe('application/json')
    expect(JSON.stringify(scrubbed)).not.toContain('secret')
    expect(JSON.stringify(scrubbed)).not.toContain('key-123')
  })
})

describe('truncateBody', () => {
  it('passes short bodies through and marks long ones truncated', () => {
    expect(truncateBody('hello')).toEqual({ text: 'hello', truncated: false })
    const long = 'x'.repeat(60_000)
    const cut = truncateBody(long)
    expect(cut.truncated).toBe(true)
    expect(cut.text.length).toBe(50_000)
  })
})

describe('history storage', () => {
  it('keeps method, URL and status only, capped at 20', () => {
    for (let i = 0; i < 25; i++) {
      pushHistory({ method: 'GET', url: `https://example.com/${i}`, status: 200, at: i })
    }
    const history = readHistory()
    expect(history).toHaveLength(20)
    expect(history[0].url).toBe('https://example.com/24')
    expect(Object.keys(history[0]).sort()).toEqual(['at', 'method', 'status', 'url'])
  })

  it('returns [] for corrupt stored data and clearHistory empties it', () => {
    window.localStorage.setItem(HISTORY_KEY, '{not json')
    expect(readHistory()).toEqual([])
    pushHistory({ method: 'GET', url: 'https://example.com', status: 200, at: 1 })
    expect(readHistory()).toHaveLength(1)
    clearHistory()
    expect(readHistory()).toEqual([])
  })
})

describe('executeRequest', () => {
  it('returns status, headers, body and elapsed time from a mocked fetch', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('{"ok":true}', {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
      }),
    )
    const result = await executeRequest(
      { method: 'POST', url: 'https://example.com/items', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      fetchMock as unknown as typeof fetch,
    )
    expect(result.status).toBe(201)
    expect(result.statusText).toBe('Created')
    expect(result.body).toBe('{"ok":true}')
    expect(result.headers['content-type']).toBe('application/json')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{}')
  })

  it('rejects with a timeout error when fetch never resolves', async () => {
    // A mock that honours the abort signal, as a real fetch does: the abort
    // rejects the pending request, and executeRequest turns that into a
    // timeout error rather than reporting it as a server error.
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        }),
    )
    await expect(
      executeRequest(
        { method: 'GET', url: 'https://example.com/slow', timeoutMs: 20 },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow('timed out after 20 ms')
  })

  it('does not send a body for GET', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok', { status: 200 }))
    await executeRequest(
      { method: 'GET', url: 'https://example.com/', body: 'should-not-send' },
      fetchMock as unknown as typeof fetch,
    )
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined()
  })
})

describe('ApiLab panel', () => {
  it('sends a real (mocked-fetch) request and shows status, elapsed and body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"hello":"world"}', { status: 200, headers: { 'x-test': '1' } })),
    )
    render(<ApiLab />)
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.com/api' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('200'))
    expect(screen.getByRole('status').textContent).toMatch(/ms/)
    expect(screen.getByText(/{"hello":"world"}/)).toBeTruthy()
    // History recorded method + URL + status, with no header value or body.
    await waitFor(() => expect(screen.getByText(/status 200/)).toBeTruthy())
    const stored = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown[]
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain('hello')
  })

  it('refuses an invalid URL without calling fetch', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<ApiLab />)
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'not a url' } })
    fireEvent.click(screen.getByText('Send'))
    expect(screen.getByText(/not a valid URL/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows a failure and still records it in history with a null status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    render(<ApiLab />)
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.com/api' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(screen.getByText(/Request failed: network down/)).toBeTruthy())
    expect(screen.getByLabelText('Request history').textContent).toContain('failed')
  })
})
