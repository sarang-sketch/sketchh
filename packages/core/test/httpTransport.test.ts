// Remote MCP (Streamable HTTP), against a REAL local HTTP server.
//
// Every server below is a real `node:http` listener on loopback: one that
// works, one that answers tools/call as SSE, one that hangs on tools/call, one
// that expires its session once (401), and one that fails the handshake. No
// fetch is mocked, because the failures this layer exists to survive — a hang,
// a dead session, an SSE body — only happen over a real socket.

import { describe, expect, it, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { once } from 'node:events'

import { RemoteMcpServer, parseSseMessages } from '../src/mcp/httpTransport.js'
import { McpHost } from '../src/mcp/host.js'

interface RunningServer {
  url: string
  close: () => Promise<void>
}

const servers: RunningServer[] = []

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!
    await server.close().catch(() => {})
  }
})

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void

async function startServer(handler: Handler): Promise<RunningServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      } catch {
        body = null
      }
      handler(req, res, body)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not listen')
  const running: RunningServer = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      server.close()
      await once(server, 'close').catch(() => {})
    },
  }
  servers.push(running)
  return running
}

function sendJson(res: ServerResponse, status: number, value: unknown, sessionId?: string): void {
  if (sessionId !== undefined) res.setHeader('Mcp-Session-Id', sessionId)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: value }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function methodOf(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const method = (body as Record<string, unknown>)['method']
  return typeof method === 'string' ? method : null
}

function idOf(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return null
  return (body as Record<string, unknown>)['id'] ?? null
}

/** A working server: handshakes, lists tools, answers calls, no prompts/resources. */
function workingHandler(options: { sseCalls?: boolean; expireOnce?: boolean } = {}): Handler {
  let sessions = 0
  let expired = false
  return (_req, res, body) => {
    const method = methodOf(body)
    const id = idOf(body)
    if (method === 'notifications/initialized') {
      sendJson(res, 202, {})
      return
    }
    if (method === 'initialize') {
      sessions++
      sendJson(res, 200, result(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'fake-remote', version: '1' },
        capabilities: { tools: {} },
      }), `sess-${sessions}`)
      return
    }
    if (options.expireOnce === true && !expired && method === 'tools/list') {
      expired = true
      sendJson(res, 401, { error: 'session expired' })
      return
    }
    if (method === 'tools/list') {
      sendJson(res, 200, result(id, {
        tools: [
          { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object' } },
          { name: 'boom', description: 'Always fails' },
        ],
      }))
      return
    }
    if (method === 'tools/call') {
      const params = (body as Record<string, unknown>)['params'] as Record<string, unknown>
      const name = params['name']
      const args = (params['arguments'] ?? {}) as Record<string, unknown>
      const outcome =
        name === 'echo'
          ? result(id, { content: [{ type: 'text', text: `echo: ${String(args['text'] ?? '')}` }] })
          : name === 'boom'
            ? result(id, { isError: true, content: [{ type: 'text', text: 'the tool refused' }] })
            : rpcError(id, -32602, `no such tool: ${String(name)}`)
      if (options.sseCalls === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(`: a server comment\n\nevent: message\ndata: ${JSON.stringify(outcome)}\n\n`)
        return
      }
      sendJson(res, 200, outcome)
      return
    }
    if (method === 'ping') {
      sendJson(res, 200, result(id, {}))
      return
    }
    if (method === 'resources/list') {
      sendJson(res, 200, rpcError(id, -32601, 'Method not found'))
      return
    }
    if (method === 'prompts/list') {
      sendJson(res, 200, result(id, {
        prompts: [{ name: 'greet', description: 'Say hello' }],
      }))
      return
    }
    sendJson(res, 200, rpcError(id, -32601, 'Method not found'))
  }
}

describe('parseSseMessages', () => {
  it('ignores comments and event lines, parses data lines', () => {
    const messages = parseSseMessages(
      ': keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n' +
        'data: not json\n\n' +
        'data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n',
    )
    expect(messages).toHaveLength(2)
    expect((messages[0] as Record<string, unknown>)['id']).toBe(1)
    expect((messages[1] as Record<string, unknown>)['id']).toBe(2)
  })

  it('returns nothing for a body with no data', () => {
    expect(parseSseMessages(': only a comment\n\n')).toEqual([])
  })
})

describe('RemoteMcpServer', () => {
  it('happy path: initialize, list, call, ping, resources/prompts', async () => {
    const server = await startServer(workingHandler())
    const remote = new RemoteMcpServer({ id: 'remote-echo', url: server.url })
    try {
      const started = await remote.start()
      expect(started.ok).toBe(true)
      expect(remote.tools.map((t) => t.name)).toEqual(['boom', 'echo'])
      expect(remote.unavailable).toBeNull()

      const called = await remote.callTool('echo', { text: 'hi' })
      expect(called.ok).toBe(true)
      expect(called.text).toBe('echo: hi')

      const failed = await remote.callTool('boom', {})
      expect(failed.ok).toBe(false)
      expect(failed.toolError).toBe(true)
      expect(failed.text).toBe('the tool refused')

      const pinged = await remote.ping()
      expect(pinged.ok).toBe(true)

      const resources = await remote.listResources()
      expect(resources.ok).toBe(true)
      expect(resources.items).toEqual([])
      expect(resources.note).toMatch(/does not support resources\/list/)

      const prompts = await remote.listPrompts()
      expect(prompts.ok).toBe(true)
      expect(prompts.items).toEqual([{ name: 'greet', description: 'Say hello' }])
    } finally {
      await remote.close()
    }
  })

  it('parses an SSE tools/call response', async () => {
    const server = await startServer(workingHandler({ sseCalls: true }))
    const remote = new RemoteMcpServer({ id: 'remote-sse', url: server.url })
    try {
      expect((await remote.start()).ok).toBe(true)
      const called = await remote.callTool('echo', { text: 'via sse' })
      expect(called.ok).toBe(true)
      expect(called.text).toBe('echo: via sse')
    } finally {
      await remote.close()
    }
  })

  it('a hanging call times out, latches, and the next call fails immediately', async () => {
    const server = await startServer((_req, res, body) => {
      const method = methodOf(body)
      const id = idOf(body)
      if (method === 'notifications/initialized') {
        sendJson(res, 202, {})
        return
      }
      if (method === 'initialize') {
        sendJson(res, 200, result(id, { protocolVersion: '2024-11-05' }), 'sess-1')
        return
      }
      if (method === 'tools/list') {
        sendJson(res, 200, result(id, { tools: [{ name: 'slow', description: 'Never answers' }] }))
        return
      }
      // tools/call: deliberate silence. The connection stays open.
    })
    const remote = new RemoteMcpServer({
      id: 'remote-hang',
      url: server.url,
      requestTimeoutMs: 150,
      handshakeTimeoutMs: 1000,
    })
    try {
      expect((await remote.start()).ok).toBe(true)
      const started = Date.now()
      const first = await remote.callTool('slow', {})
      const firstMs = Date.now() - started
      expect(first.ok).toBe(false)
      expect(first.transportError).toBe('timeout')
      expect(firstMs).toBeLessThan(3000)
      expect(remote.unavailable?.reason).toBe('timeout')

      const secondStart = Date.now()
      const second = await remote.callTool('slow', {})
      expect(second.ok).toBe(false)
      expect(second.durationMs).toBe(0)
      expect(Date.now() - secondStart).toBeLessThan(500)
      expect(second.text).toMatch(/unavailable for the rest of this run/)
    } finally {
      await remote.close()
    }
  })

  it('a 401 re-initializes once and the call succeeds', async () => {
    const server = await startServer(workingHandler({ expireOnce: true }))
    const remote = new RemoteMcpServer({ id: 'remote-401', url: server.url })
    try {
      // tools/list inside start() gets the 401, re-initializes, and succeeds.
      const started = await remote.start()
      expect(started.ok).toBe(true)
      expect(remote.tools.map((t) => t.name)).toEqual(['boom', 'echo'])
      const called = await remote.callTool('echo', { text: 'after re-init' })
      expect(called.ok).toBe(true)
      expect(called.text).toBe('echo: after re-init')
    } finally {
      await remote.close()
    }
  })

  it('a handshake failure is a verdict, never a throw', async () => {
    const server = await startServer((_req, res) => {
      sendJson(res, 500, { error: 'boom' })
    })
    const remote = new RemoteMcpServer({ id: 'remote-bad', url: server.url })
    const started = await remote.start()
    expect(started.ok).toBe(false)
    expect(started.detail).toMatch(/handshake failed/)
    expect(remote.unavailable?.reason).toBe('handshake-failed')
    const called = await remote.callTool('echo', {})
    expect(called.ok).toBe(false)
    await remote.close()
  })

  it('an invalid URL fails start without a request', async () => {
    const remote = new RemoteMcpServer({ id: 'remote-url', url: 'not a url' })
    const started = await remote.start()
    expect(started.ok).toBe(false)
    expect(started.detail).toMatch(/invalid URL/)
    await remote.close()
  })

  it('methods are safe before start', async () => {
    const remote = new RemoteMcpServer({ id: 'remote-early', url: 'http://127.0.0.1:1/mcp' })
    expect((await remote.callTool('echo', {})).ok).toBe(false)
    expect((await remote.ping()).ok).toBe(false)
    expect((await remote.listResources()).ok).toBe(false)
    await remote.close()
  })
})

describe('McpHost with remote servers', () => {
  it('opens a remote server and names its tools <server>.<tool>', async () => {
    const server = await startServer(workingHandler())
    const host = new McpHost({
      root: '/tmp',
      remoteOverrides: {
        'remote-echo': { id: 'remote-echo', url: server.url },
      },
    })
    try {
      const opened = await host.open('remote-echo')
      expect(opened.ok).toBe(true)
      expect(opened.tools).toEqual(['remote-echo.boom', 'remote-echo.echo'])

      const descriptors = host.descriptors()
      expect(descriptors.map((d) => d.name)).toEqual(['remote-echo.boom', 'remote-echo.echo'])
      expect(descriptors[1]?.requires).toBe('net:http')

      const outcome = await descriptors[1]!.run(
        { text: 'hi' },
        { root: '/tmp', runId: 'run-1', granted: ['net:http'] },
      )
      expect(outcome.ok).toBe(true)
      expect(outcome.output).toContain('echo: hi')
      expect(outcome.output).toContain('TOOL RESULT from remote-echo/echo')
    } finally {
      await host.close()
    }
  })

  it('an unknown remote id is refused, like an unknown catalog id', async () => {
    const host = new McpHost({ root: '/tmp', remoteOverrides: {} })
    try {
      const opened = await host.open('no-such-server')
      expect(opened.ok).toBe(false)
      expect(opened.detail).toMatch(/no MCP server named/)
    } finally {
      await host.close()
    }
  })
})
