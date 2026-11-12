// MCP panel → "Your servers", through the REAL engine methods (`mcp-servers`,
// `mcp-server-save`, `mcp-server-trust`, `mcp-server-test`) with a temporary home and
// project, and a real stdio MCP server process for the connection test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { METHODS, type MethodContext } from '@sketch/core'

import { engineClient } from '../test/engineHarness'
import { SketchClientProvider } from '../lib/ClientProvider'
import type { SketchClient } from '../lib/client'
import { AppStateProvider, useAppState } from '../state/AppState'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { UserMcpServers, parseEnvLines, parseImport } from './UserMcpServers'

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
  if (request.method === 'tools/list') return send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: 'Echo' }] } })
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } })
}
setInterval(() => {}, 1000)
`

let home: string
let root: string
let script: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sketch-mcp-ui-home-'))
  root = await mkdtemp(join(tmpdir(), 'sketch-mcp-ui-root-'))
  script = join(root, 'echo-server.cjs')
  await writeFile(script, SERVER, 'utf8')
})

afterEach(async () => {
  cleanup()
  for (const dir of [home, root]) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const ctx: MethodContext = { emitEvent: () => {}, log: () => {}, rememberSecret: () => {}, secrets: () => [], env: { SKETCH_OFFLINE: '' }, cwd: () => process.cwd() }
const call = <T,>(method: string, params: object) => METHODS[method]!({ home, ...params } as Record<string, unknown>, ctx) as Promise<T>

function client(): SketchClient {
  return engineClient({
    mcpServers: (o) => call('mcp-servers', o ?? {}),
    mcpServerSave: (p) => call('mcp-server-save', p),
    mcpServerRemove: (p) => call('mcp-server-remove', p),
    mcpServerTrust: (p) => call('mcp-server-trust', p),
    mcpServerTest: (p) => call('mcp-server-test', { ...p, timeoutMs: 15_000 }),
  })
}

function Enabled() {
  return <output aria-label="enabled servers">{(useAppState().agentPrefs.mcpServers ?? []).join(',')}</output>
}

function mount() {
  return render(
    <SketchClientProvider client={client()}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <ConfirmProvider>
          <UserMcpServers />
          <Enabled />
        </ConfirmProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

describe('Your MCP servers', () => {
  it('adds a server for all projects, tests it, and lets chats use it', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Add server/ }))
    const form = screen.getByRole('form', { name: 'Add an MCP server' })
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'echo' } })
    fireEvent.change(within(form).getByLabelText('Command'), { target: { value: process.execPath } })
    fireEvent.change(within(form).getByLabelText('Arguments'), { target: { value: script } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save server' }))

    const row = (await screen.findByText('echo', { selector: 'span' })).closest('li') as HTMLElement
    expect(row.textContent).toContain('All projects')
    fireEvent.click(within(row).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(within(row).getByLabelText('Test of echo').textContent).toContain('Connected: 1 tool — echo'), { timeout: 20_000 })

    fireEvent.click(within(row).getByLabelText('Use echo in chats'))
    expect(screen.getByLabelText('enabled servers').textContent).toBe('echo')
  }, 30_000)

  it("keeps a project's server off until the user approves its exact command", async () => {
    await mkdir(join(root, '.sketch'), { recursive: true })
    await writeFile(join(root, '.sketch', 'mcp.json'), JSON.stringify({ mcpServers: { cloned: { command: process.execPath, args: [script] } } }), 'utf8')
    mount()
    const row = (await screen.findByText('cloned', { selector: 'span' })).closest('li') as HTMLElement
    expect(row.textContent).toContain('Needs your approval')
    expect((within(row).getByLabelText('Use cloned in chats') as HTMLInputElement).disabled).toBe(true)
    expect((within(row).getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain(script)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(row.textContent).toContain('Approved'))
    expect((within(row).getByLabelText('Use cloned in chats') as HTMLInputElement).disabled).toBe(false)
  })

  it('imports servers from a pasted Claude Desktop / Cursor config', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Import JSON' }))
    fireEvent.change(screen.getByLabelText('MCP configuration JSON'), {
      target: { value: JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } } }) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    const row = (await screen.findByText('files', { selector: 'span' })).closest('li') as HTMLElement
    expect(row.textContent).toContain('npx -y @modelcontextprotocol/server-filesystem .')
  })
})

describe('the parsers', () => {
  it('reads NAME=value lines and pasted configs', () => {
    expect(parseEnvLines('A=1\n# comment\nB=two=2\n')).toEqual({ A: '1', B: 'two=2' })
    expect(() => parseEnvLines('nope')).toThrow(/NAME=value/)
    expect(parseImport('{"mcpServers":{"x":{"command":"node","args":["s.js"],"env":{"K":"v"}}}}')).toEqual([
      { name: 'x', command: 'node', args: ['s.js'], env: { K: 'v' } },
    ])
    expect(() => parseImport('{"mcpServers":{"r":{"url":"https://x"}}}')).toThrow(/remote servers/)
  })
})
