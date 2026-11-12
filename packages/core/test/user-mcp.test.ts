// The user's own MCP servers: the config files, project-server approval, the
// connection test, and a run that calls one of their tools — against a REAL stdio
// server process (a small node script speaking MCP's newline-delimited JSON-RPC).
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngineExtensionRegistry } from '../src/extensions/index.js'
import { parseServer, readUserServers } from '../src/mcp/userServers.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import type { ChatAdapter, Message, ProviderConfig } from '../src/types.js'

const dirs: string[] = []
afterEach(async () => {
  // On Windows a folder that is a just-stopped process's working directory stays
  // locked for a moment, so removal retries instead of failing the test.
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let at = buffer.indexOf('\\n'); at !== -1; at = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
    if (line.trim() !== '') handle(JSON.parse(line))
  }
})
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
function handle(request) {
  if (request.method === 'initialize') return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'echo', version: '1' }, capabilities: { tools: {} } } })
  if (request.id === undefined) return
  if (request.method === 'tools/list') return send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: 'Echo text, prefixed with GREETING', inputSchema: { type: 'object' } }] } })
  if (request.method === 'tools/call') {
    const text = String((request.params && request.params.arguments && request.params.arguments.text) || '')
    return send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: (process.env.GREETING || '') + 'echo: ' + text }] } })
  }
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } })
}
setInterval(() => {}, 1000)
`

async function setup() {
  const home = await tmp('sketch-user-mcp-home-')
  const root = await tmp('sketch-user-mcp-root-')
  const script = join(root, 'echo-server.cjs')
  await writeFile(script, SERVER, 'utf8')
  return { home, root, script }
}

function ctx(extras: Partial<Parameters<typeof createMethodContext>[1]> = {}) {
  return createMethodContext('user-mcp', {
    writeFrame: () => {},
    writeErr: () => {},
    env: { SKETCH_OFFLINE: '' },
    cwd: () => process.cwd(),
    secrets: new Set(),
    ...extras,
  })
}

describe('reading the config', () => {
  it('accepts one program with argv, and says why anything else cannot start', () => {
    const where = { scope: 'global' as const, file: 'mcp.json' }
    expect(parseServer('docs', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }, where).problems).toEqual([])
    expect(parseServer('bad', { command: 'node server.js && curl evil' }, where).problems.join(' ')).toMatch(/one program/)
    expect(parseServer('remote', { url: 'https://mcp.example.com/sse' }, where).problems.join(' ')).toMatch(/not supported yet/)
    expect(parseServer('env', { command: 'node', env: { 'BAD NAME': 'x' } }, where).problems.join(' ')).toMatch(/environment entry/)
    expect(parseServer('My Server!', { command: 'node' }, where).id).toBe('user-my-server')
  })

  it('a corrupt mcp.json is set aside (never deleted) and reported, not fatal (W10 invariant 5)', async () => {
    const home = await tmp('sketch-user-mcp-home-')
    await mkdir(join(home, '.sketch'), { recursive: true })
    await writeFile(join(home, '.sketch', 'mcp.json'), '{ broken ]', 'utf8')

    const listed = await readUserServers({ home })

    // No crash: the list is empty and a plain diagnostic names the problem + the backup.
    expect(listed.servers).toEqual([])
    expect(listed.diagnostics.join(' ')).toMatch(/not valid JSON/)
    expect(listed.diagnostics.join(' ')).toMatch(/moved to .*\.corrupt-/)
    // The user's bytes survived: a backup exists and the original is gone.
    const sketchDir = await readdir(join(home, '.sketch'))
    const backup = sketchDir.find((f) => f.startsWith('mcp.json.corrupt-'))
    expect(backup).toBeDefined()
    expect(await readFile(join(home, '.sketch', backup!), 'utf8')).toBe('{ broken ]')
    expect(sketchDir.includes('mcp.json')).toBe(false)
  })

  it('a corrupt mcp-trust.json fails closed: no project server is treated as approved', async () => {
    const { home, root, script } = await setup()
    // Save and approve a project server, so a readable trust file would mark it trusted.
    await METHODS['mcp-server-save']!({ home, root, scope: 'project', name: 'proj', command: process.execPath, args: [script] }, ctx())
    await METHODS['mcp-server-trust']!({ home, root, name: 'proj' }, ctx())
    // Corrupt the trust file.
    await writeFile(join(home, '.sketch', 'mcp-trust.json'), 'not json at all', 'utf8')

    const listed = await readUserServers({ home, root })

    // Fails closed: the previously-approved project server is now untrusted, and the
    // loss of approvals is reported (not silently swallowed).
    expect(listed.servers.find((s) => s.name === 'proj')?.trusted).toBe(false)
    expect(listed.diagnostics.join(' ')).toMatch(/approvals/i)
    // The corrupt trust bytes were preserved under a backup.
    const sketchDir = await readdir(join(home, '.sketch'))
    expect(sketchDir.some((f) => f.startsWith('mcp-trust.json.corrupt-'))).toBe(true)
  })
})

describe('saving, approving and testing', () => {
  it('a global server is trusted; a project server only after approval of that exact launch', async () => {
    const { home, root, script } = await setup()
    await METHODS['mcp-server-save']!({ home, root, scope: 'global', name: 'echo', command: process.execPath, args: [script] }, ctx())
    await METHODS['mcp-server-save']!({ home, root, scope: 'project', name: 'proj', command: process.execPath, args: [script] }, ctx())

    let listed = await readUserServers({ home, root })
    expect(listed.servers.map((s) => [s.name, s.scope, s.trusted])).toEqual([['proj', 'project', false], ['echo', 'global', true]])
    const saved = JSON.parse(await readFile(join(root, '.sketch', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(saved.mcpServers)).toEqual(['proj'])

    await METHODS['mcp-server-trust']!({ home, root, name: 'proj' }, ctx())
    listed = await readUserServers({ home, root })
    expect(listed.servers.find((s) => s.name === 'proj')?.trusted).toBe(true)

    // Anyone who can change the project file changes the launch, which voids the approval.
    await METHODS['mcp-server-save']!({ home, root, scope: 'project', name: 'proj', command: process.execPath, args: [script, '--other'] }, ctx())
    listed = await readUserServers({ home, root })
    expect(listed.servers.find((s) => s.name === 'proj')?.trusted).toBe(false)
  })

  it('the connection test starts the server, lists its tools, and stops it', async () => {
    const { home, root, script } = await setup()
    await METHODS['mcp-server-save']!({ home, root, scope: 'global', name: 'echo', command: process.execPath, args: [script] }, ctx())
    const result = (await METHODS['mcp-server-test']!({ home, root, name: 'echo', timeoutMs: 15_000 }, ctx())) as {
      ok: boolean
      tools: Array<{ name: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.tools.map((t) => t.name)).toEqual(['echo'])
  }, 30_000)

  it('refuses to start an unapproved project server', async () => {
    const { home, root, script } = await setup()
    await mkdir(join(root, '.sketch'), { recursive: true })
    await writeFile(join(root, '.sketch', 'mcp.json'), JSON.stringify({ mcpServers: { cloned: { command: process.execPath, args: [script] } } }), 'utf8')
    const result = (await METHODS['mcp-server-test']!({ home, root, name: 'cloned' }, ctx())) as { ok: boolean; detail: string }
    expect(result).toMatchObject({ ok: false })
    expect(result.detail).toMatch(/Approve/)
  })
})

describe('a run that uses one', () => {
  const descriptor = { id: 'mcp-probe', name: 'MCP Probe', kind: 'openai-compatible' as const, defaultBaseUrl: 'http://127.0.0.1:9/v1', needsKey: false, serverless: false }

  function scripted(replies: string[], seen: Message[][]) {
    let turn = 0
    const factory = (_config: ProviderConfig): ChatAdapter => ({
      id: descriptor.id,
      model: 'probe',
      chat: async (messages) => {
        seen.push(messages)
        return { text: replies[Math.min(turn++, replies.length - 1)]!, usage: { in: 1, out: 1 } }
      },
    })
    return createEngineExtensionRegistry({ providers: [{ descriptor, factory }] })
  }

  it('calls the user server tool and feeds its answer back to the model', async () => {
    const { home, root, script } = await setup()
    await METHODS['mcp-server-save']!({ home, root, scope: 'global', name: 'echo', command: process.execPath, args: [script], env: { GREETING: 'hello, ' } }, ctx())
    const seen: Message[][] = []
    const extensions = scripted(['{"action":"tool","name":"user-echo.echo","args":{"text":"world"}}', '{"action":"done","text":"Used the tool."}'], seen)
    const result = (await METHODS.run!(
      { root, home, provider: { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }, userMcpServers: ['echo'], task: { id: 't', prompt: 'echo world', verify: [] } },
      ctx({ extensions }),
    )) as { ok: boolean }
    expect(result.ok).toBe(true)
    const fed = JSON.stringify(seen[1] ?? [])
    expect(fed).toContain('hello, echo: world')
  }, 30_000)

  it('does not start a project server that was never approved, even when named', async () => {
    const { home, root, script } = await setup()
    await mkdir(join(root, '.sketch'), { recursive: true })
    await writeFile(join(root, '.sketch', 'mcp.json'), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [script] } } }), 'utf8')
    const seen: Message[][] = []
    const extensions = scripted(['{"action":"tool","name":"user-echo.echo","args":{"text":"world"}}', '{"action":"done","text":"ok"}'], seen)
    await METHODS.run!(
      { root, home, provider: { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }, userMcpServers: ['echo'], task: { id: 't', prompt: 'echo world', verify: [] } },
      ctx({ extensions }),
    )
    expect(JSON.stringify(seen[1] ?? [])).not.toContain('echo: world')
  }, 30_000)

  it('does not start a server the run did not name', async () => {
    const { home, root, script } = await setup()
    await METHODS['mcp-server-save']!({ home, root, scope: 'global', name: 'echo', command: process.execPath, args: [script] }, ctx())
    const seen: Message[][] = []
    const extensions = scripted(['{"action":"tool","name":"user-echo.echo","args":{"text":"world"}}', '{"action":"done","text":"ok"}'], seen)
    await METHODS.run!(
      { root, home, provider: { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }, projectTools: true, task: { id: 't', prompt: 'echo world', verify: [] } },
      ctx({ extensions }),
    )
    expect(JSON.stringify(seen[1] ?? [])).not.toContain('echo: world')
  }, 30_000)
})
