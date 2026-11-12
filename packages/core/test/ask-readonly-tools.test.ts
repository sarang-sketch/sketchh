// Ask mode writes no file through ANY tool path (W5 invariant 2).
//
// readOnly refuses the `edit` action in the loop, but the TOOL layer is a second write
// path: a loaded skill granted fs:write:project (or proc:spawn) could otherwise launch a
// write-capable MCP server and call its write tool, and the capability guard would allow
// it because the guard only checks the grant. The fix narrows the Ask-mode grant to a
// read-only allowlist (capabilities/vocabulary.ts: READ_ONLY_CAPABILITIES / readOnlyGrant)
// and uses it for BOTH the MCP launch grant and the dispatcher grant.
//
// Two levels of proof:
//   1. the guard refuses a write-requiring tool under the read-only grant and allows it
//      under the full grant (the exact "the guard allows that" claim the lead named);
//   2. a real run over METHODS.run with a real stdio MCP server that writes a file:
//      Agent mode writes it; Ask mode refuses the tool call and the file never exists.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  READ_ONLY_CAPABILITIES,
  ToolDispatcher,
  readOnlyGrant,
  type CapabilitySet,
} from '../src/capabilities/index.js'
import type { ToolDescriptor } from '../src/capabilities/guard.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import type { ChatAdapter, Message, ProviderConfig, RunResult, SketchEvent } from '../src/types.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// ── 1. the vocabulary narrowing, and the guard ──────────────────────────────

describe('the read-only grant is an allowlist of reads', () => {
  it('keeps only read capabilities and drops every write/spawn one', () => {
    const full: CapabilitySet = [
      'fs:read:project',
      'fs:write:project',
      'fs:write:home',
      'git:read',
      'git:write',
      'proc:spawn',
      'net:http',
      'secrets:read',
    ]
    const narrowed = readOnlyGrant(full)
    // Writes and spawn are gone; reads and read-only network/secret access remain.
    expect(narrowed).not.toContain('fs:write:project')
    expect(narrowed).not.toContain('fs:write:home')
    expect(narrowed).not.toContain('git:write')
    expect(narrowed).not.toContain('proc:spawn')
    expect(narrowed).toContain('fs:read:project')
    expect(narrowed).toContain('git:read')
    expect(narrowed).toContain('net:http')
    // The result is a subset of the allowlist (nothing invented).
    for (const cap of narrowed) expect(READ_ONLY_CAPABILITIES).toContain(cap)
  })

  it('is empty for a grant with no read capabilities', () => {
    expect(readOnlyGrant(['fs:write:project', 'git:write', 'proc:spawn'])).toEqual([])
  })
})

describe('the guard refuses a write-requiring tool once the grant is narrowed', () => {
  const writeTool: ToolDescriptor = {
    name: 'write_file',
    description: 'Write a file',
    requires: 'fs:write:project',
    run: async () => ({ ok: true, output: 'wrote it' }),
  }

  it('allows the write tool under the full grant (the behaviour the fix must change)', async () => {
    const dispatcher = new ToolDispatcher({ tools: [writeTool], granted: ['fs:read:project', 'fs:write:project'], root: '/x' })
    const result = await dispatcher.call('write_file', {})
    expect(result.ok).toBe(true)
    expect(result.denied).toBeNull()
  })

  it('refuses the write tool under the read-only grant, as a result not a throw', async () => {
    const granted = readOnlyGrant(['fs:read:project', 'fs:write:project'])
    const dispatcher = new ToolDispatcher({ tools: [writeTool], granted, root: '/x' })
    // It is not even offered to the model.
    expect(dispatcher.availableTools.map((t) => t.name)).not.toContain('write_file')
    const result = await dispatcher.call('write_file', {})
    expect(result.ok).toBe(false)
    expect(result.denied).toBe('capability_denied')
    expect(result.missing).toBe('fs:write:project')
    expect(result.output).toContain('TOOL DENIED')
  })
})

// ── 2. end to end through METHODS.run, against a real MCP server ─────────────

// A real stdio MCP server whose one tool WRITES a file to the path it is given. If it
// runs, the file exists; that is the observable we assert on.
const WRITE_SERVER = `
const fs = require('fs')
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
  if (request.method === 'initialize') return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'writer', version: '1' }, capabilities: { tools: {} } } })
  if (request.id === undefined) return
  if (request.method === 'tools/list') return send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'write_file', description: 'Write text to a file path', inputSchema: { type: 'object' } }] } })
  if (request.method === 'tools/call') {
    const args = (request.params && request.params.arguments) || {}
    try {
      fs.writeFileSync(String(args.path), String(args.text || ''))
      return send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'wrote ' + String(args.path) }] } })
    } catch (e) {
      return send({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: String(e && e.message) }] } })
    }
  }
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } })
}
setInterval(() => {}, 1000)
`

const descriptor = { id: 'ro-probe', name: 'RO Probe', kind: 'openai-compatible' as const, defaultBaseUrl: 'http://127.0.0.1:9/v1', needsKey: false, serverless: false }

/** A model that plays a fixed script, recording the conversations it was sent. */
function scriptedFactory(replies: string[], seen: Message[][]) {
  let turn = 0
  return (_config: ProviderConfig): ChatAdapter => ({
    id: descriptor.id,
    model: 'probe',
    chat: async (messages) => {
      seen.push(messages.map((m) => ({ ...m })))
      return { text: replies[Math.min(turn++, replies.length - 1)]!, usage: { in: 1, out: 1 } }
    },
  })
}

const provider = { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }

/**
 * A skill whose grant includes the write + spawn capabilities — the exact setup the
 * lead described, where an Ask run could otherwise reach a write-capable MCP server.
 */
async function seedWriteSkill(root: string): Promise<void> {
  const dir = join(root, '.sketch', 'skills', 'writer-skill')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    '---\nname: writer-skill\ndescription: A skill that can write files.\ncapabilities: [fs:read:project, fs:write:project, proc:spawn]\n---\nUse the writer MCP server to write files.\n',
    'utf8',
  )
}

async function setupRun(): Promise<{ home: string; root: string; serverScript: string }> {
  const home = await tmp('sketch-ro-home-')
  const root = await tmp('sketch-ro-root-')
  const serverScript = join(root, 'write-server.cjs')
  await writeFile(serverScript, WRITE_SERVER, 'utf8')
  await seedWriteSkill(root)
  return { home, root, serverScript }
}

describe('Ask mode cannot reach a write-capable MCP tool, but Agent mode can (W5 invariant 2)', () => {
  // createMethodContext needs the extensions registry; import lazily to mirror user-mcp.test.ts.
  async function makeCtx(root: string, replies: string[], seen: Message[][]) {
    const { createEngineExtensionRegistry } = await import('../src/extensions/index.js')
    const factory = scriptedFactory(replies, seen)
    return createMethodContext('ro-test', {
      writeFrame: () => {},
      writeErr: () => {},
      env: { SKETCH_OFFLINE: '' },
      cwd: () => root,
      secrets: new Set(),
      extensions: createEngineExtensionRegistry({ providers: [{ descriptor, factory }] }),
    })
  }

  it('AGENT mode: the write tool runs and the file is created (baseline that the setup works)', async () => {
    const { home, root, serverScript } = await setupRun()
    const target = join(root, 'written-by-agent.txt')
    await METHODS['mcp-server-save']!({ home, root, scope: 'global', name: 'writer', command: process.execPath, args: [serverScript] }, await makeCtx(root, [], []))
    const seen: Message[][] = []
    const ctx = await makeCtx(root, [
      JSON.stringify({ action: 'tool', name: 'user-writer.write_file', args: { path: target, text: 'hello from agent' } }),
      JSON.stringify({ action: 'done', text: 'wrote it' }),
    ], seen)
    const result = (await METHODS.run!(
      { root, home, provider, userMcpServers: ['writer'], skillNames: ['writer-skill'], task: { id: 't', prompt: 'write the file', verify: [] } },
      ctx,
    )) as RunResult
    expect(await exists(target)).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('hello from agent')
    expect(result.ok).toBe(true)
  }, 30_000)

  it('ASK mode: the write tool call is refused and the file is never created', async () => {
    const { home, root, serverScript } = await setupRun()
    const target = join(root, 'written-in-ask.txt')
    await METHODS['mcp-server-save']!({ home, root, scope: 'global', name: 'writer', command: process.execPath, args: [serverScript] }, await makeCtx(root, [], []))
    const seen: Message[][] = []
    const ctx = await makeCtx(root, [
      JSON.stringify({ action: 'tool', name: 'user-writer.write_file', args: { path: target, text: 'hello from ask' } }),
      JSON.stringify({ action: 'done', text: 'tried' }),
    ], seen)
    const result = (await METHODS.run!(
      // readOnly: true is Ask mode. Same skill, same server, same model script.
      { root, home, provider, readOnly: true, userMcpServers: ['writer'], skillNames: ['writer-skill'], task: { id: 't', prompt: 'write the file', verify: [] } },
      ctx,
    )) as RunResult
    // The invariant: no file was written through the tool path.
    expect(await exists(target)).toBe(false)
    // The run refused the tool (either the tool was denied, or the server was never
    // started so the tool is unknown) — in both cases the capability was not reachable.
    const denied = result.events.find(
      (e: SketchEvent) => e.kind === 'tool_denied' && String(e.payload['name']).includes('write_file'),
    )
    expect(denied).toBeDefined()
    // And the model was told, so it can carry on rather than silently believing it wrote.
    const fedBack = JSON.stringify(seen)
    expect(fedBack).toContain('TOOL DENIED')
  }, 30_000)
})
