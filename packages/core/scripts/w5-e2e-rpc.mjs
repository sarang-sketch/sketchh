// W5 end-to-end driver — the agent engine over its real JSON-line RPC.
//
// Drives `packages/core/dist/cli.js` exactly as the desktop sidecar does: one JSON
// object per line on stdin, event + response frames on stdout. The model is a local
// OpenAI-compatible HTTP server on 127.0.0.1 that plays a per-scenario script, so no
// provider key is needed and nothing leaves the machine.
//
// It proves the W5 invariants against the SHIPPED build, not just the unit seams:
//   A. completion honesty — every edit fails, model says "done" → run_failed
//      {reason: edits_failed}, nothing written, the honest final text;
//   B. command approval — Agent mode, a denied command does not run;
//   C. Ask mode — a write is refused by the engine, file untouched;
//   D. cancellation — a long command is cancelled mid-flight and its process tree
//      is gone, the run ends {reason: aborted}, a new run starts after.
//
// Usage:  node packages/core/scripts/w5-e2e-rpc.mjs
// Exit 0 and prints "W5 E2E: ALL PASS" when every scenario held.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'dist', 'cli.js')

const log = (...a) => console.log('[w5-e2e]', ...a)
const failures = []
function check(name, cond, detail = '') {
  if (cond) log('PASS', name)
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    log('FAIL', name, detail)
  }
}

/** A local OpenAI-compatible server that returns a script, advancing per call. */
function scriptedModel(script) {
  let turn = 0
  const seen = []
  const server = createServer((req, res) => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('no')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push(body)
      const content = script[Math.min(turn, script.length - 1)]
      turn += 1
      const payload = JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      })
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload)
    })
  })
  return { server, seen: () => seen, calls: () => turn }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

/** One engine process speaking the line protocol. Collects event + response frames. */
function engine() {
  const child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []
  const responses = new Map()
  const waiters = new Map()
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim() === '') continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (frame.kind === 'event') {
        events.push(frame.event)
      } else if (typeof frame.ok === 'boolean') {
        responses.set(frame.id, frame)
        waiters.get(frame.id)?.(frame)
        waiters.delete(frame.id)
      }
    }
  })
  child.stderr.on('data', () => {})
  let nextId = 1
  const send = (method, params) => {
    const id = `req-${nextId++}`
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return id
  }
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = send(method, params)
      if (responses.has(id)) return resolve(responses.get(id))
      waiters.set(id, resolve)
    })
  return {
    child,
    events,
    call,
    send,
    stop: () => new Promise((r) => (child.once('close', r), child.stdin.end(), child.kill())),
  }
}

const terminalOf = (events, runId) =>
  events.find((e) => e.runId === runId && (e.kind === 'run_completed' || e.kind === 'run_failed'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
async function waitFor(fn, ms = 15000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return true
    await wait(50)
  }
  return false
}
function providerFor(port) {
  return { id: 'scripted', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'scripted' }
}

const roots = []
async function scratch() {
  const r = await mkdtemp(join(tmpdir(), 'w5-e2e-'))
  roots.push(r)
  return r
}

// ── A. completion honesty: every edit fails, then "done" ─────────────────────
async function scenarioEditsFail() {
  const root = await scratch()
  await writeFile(join(root, 'app.txt'), 'original\n')
  const model = scriptedModel([
    JSON.stringify({ action: 'plan', artifacts: { prd: 'change app.txt' } }),
    JSON.stringify({ action: 'edit', edits: [{ path: 'app.txt', search: 'NOT_PRESENT', replace: 'new' }] }),
    JSON.stringify({ action: 'done', text: 'All set, app.txt updated.' }),
  ])
  const port = await listen(model.server)
  const eng = engine()
  try {
    await eng.call('ping', {})
    const runId = 'e2e-edits-fail'
    const res = await eng.call('run', {
      root,
      runId,
      provider: providerFor(port),
      reviewEdits: false,
      task: { id: 't', prompt: 'update app.txt', verify: [] },
    })
    const term = terminalOf(eng.events, runId)
    check('A: run reported ok=false', res.result?.ok === false)
    check('A: terminal is run_failed{edits_failed}', term?.kind === 'run_failed' && term?.payload?.reason === 'edits_failed', `got ${term?.kind}/${term?.payload?.reason}`)
    check('A: editsApplied=0 editsFailed=1 on the log', term?.payload?.editsApplied === 0 && term?.payload?.editsFailed === 1)
    check('A: file untouched on disk', (await readFile(join(root, 'app.txt'), 'utf8')) === 'original\n')
    check('A: honest final text, not the model "done"', typeof res.result?.finalText === 'string' && res.result.finalText.includes('No changes were applied') && !res.result.finalText.includes('All set'))
    const rejected = eng.events.find((e) => e.runId === runId && e.kind === 'edit_rejected')
    check('A: an edit_rejected line is on the log', rejected !== undefined)
    log('A evidence — terminal payload:', JSON.stringify(term?.payload))
  } finally {
    await eng.stop()
    model.server.close()
  }
}

// ── B. Agent mode: a denied command does not run ─────────────────────────────
async function scenarioApprovalDenied() {
  const root = await scratch()
  const marker = join(root, 'ran.txt')
  const model = scriptedModel([
    JSON.stringify({ action: 'tool', name: 'run_command', args: { command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } }),
    JSON.stringify({ action: 'done', text: 'tried the command' }),
  ])
  const port = await listen(model.server)
  const eng = engine()
  try {
    await eng.call('ping', {})
    const runId = 'e2e-deny'
    const pending = eng.call('run', {
      root,
      runId,
      provider: providerFor(port),
      commands: 'ask',
      interactive: true,
      task: { id: 't', prompt: 'run it', verify: [] },
    })
    // Wait for the approval ask, then deny it.
    const asked = await waitFor(() => eng.events.some((e) => e.runId === runId && e.kind === 'ask' && e.payload?.approval))
    check('B: engine asked for command approval', asked)
    await eng.call('reply', { runId, answer: 'no' })
    const res = await pending
    const answered = eng.events.find((e) => e.runId === runId && e.kind === 'ask_answered')
    check('B: denial recorded on the log', answered?.payload?.approval?.decision === 'deny')
    check('B: the command did not run (no marker file)', !(await exists(marker)))
    check('B: the run still finished', terminalOf(eng.events, runId) !== undefined)
    log('B evidence — ask_answered payload:', JSON.stringify(answered?.payload?.approval))
  } finally {
    await eng.stop()
    model.server.close()
  }
}

// ── C. Ask mode: a write is refused by the engine ───────────────────────────
async function scenarioAskReadOnly() {
  const root = await scratch()
  await writeFile(join(root, 'app.txt'), 'original\n')
  const model = scriptedModel([
    JSON.stringify({ action: 'plan', artifacts: { prd: 'change it' } }),
    JSON.stringify({ action: 'edit', edits: [{ path: 'app.txt', search: 'original', replace: 'changed' }] }),
    JSON.stringify({ action: 'done', text: 'done' }),
  ])
  const port = await listen(model.server)
  const eng = engine()
  try {
    await eng.call('ping', {})
    const runId = 'e2e-ask'
    await eng.call('run', {
      root,
      runId,
      provider: providerFor(port),
      readOnly: true,
      task: { id: 't', prompt: 'change app.txt', verify: [] },
    })
    const rejected = eng.events.find((e) => e.runId === runId && e.kind === 'edit_rejected')
    check('C: Ask-mode edit was refused', rejected !== undefined && String(rejected.payload?.reason).includes('read-only'))
    check('C: the file is untouched', (await readFile(join(root, 'app.txt'), 'utf8')) === 'original\n')
    log('C evidence — edit_rejected reason:', JSON.stringify(rejected?.payload?.reason))
  } finally {
    await eng.stop()
    model.server.close()
  }
}

// ── D. cancellation: a long command is cancelled and its tree is gone ────────
async function scenarioCancelCommand() {
  const root = await scratch()
  const pidFile = join(root, 'child.pid')
  // A child that writes its own pid, then sleeps 60s. Cancelling the run must kill it.
  const longScript = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(()=>{}, 60000)`
  const model = scriptedModel([
    JSON.stringify({ action: 'tool', name: 'run_command', args: { command: [process.execPath, '-e', longScript] } }),
    JSON.stringify({ action: 'done', text: 'finished' }),
  ])
  const port = await listen(model.server)
  const eng = engine()
  try {
    await eng.call('ping', {})
    const runId = 'e2e-cancel'
    const pending = eng.call('run', {
      root,
      runId,
      provider: providerFor(port),
      commands: 'auto',
      task: { id: 't', prompt: 'run the long thing', verify: [] },
    })
    // Wait until the child has actually started (its pid file exists).
    const launched = await waitFor(() => exists(pidFile))
    check('D: the long command started', launched)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    const cancelRes = await eng.call('cancel', { runId })
    check('D: cancel reported it stopped a run', cancelRes.result?.cancelled === true)
    const res = await pending
    const term = terminalOf(eng.events, runId)
    check('D: run ended aborted (not completed/failed-other)', term?.kind === 'run_failed' && term?.payload?.reason === 'aborted', `got ${term?.payload?.reason}`)
    check('D: run result ok=false', res.result?.ok === false)
    // The child's whole process tree must be gone.
    const gone = await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 10000)
    check('D: the command process tree is gone', gone, `pid ${pid} still alive`)
    // A new run can start straight after on the same engine.
    const after = await eng.call('run', {
      root,
      runId: 'e2e-cancel-after',
      provider: providerFor(port),
      commands: 'auto',
      task: { id: 't2', prompt: 'noop', verify: [] },
    })
    check('D: a new run starts after a cancel', after.ok === true || after.result !== undefined)
    log('D evidence — terminal payload:', JSON.stringify(term?.payload))
  } finally {
    await eng.stop()
    model.server.close()
  }
}

// ── E. Ask mode cannot reach a write-capable MCP tool (W5 invariant 2) ───────
// A real stdio MCP server whose one tool WRITES a file, named for the run via a global
// mcp.json, with a skill that grants fs:write:project + proc:spawn. Agent mode writes
// the file; Ask mode refuses the tool and the file never exists.
const WRITE_MCP_SERVER = `
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
const send = (f) => process.stdout.write(JSON.stringify(f) + '\\n')
function handle(req) {
  if (req.method === 'initialize') return send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'writer', version: '1' }, capabilities: { tools: {} } } })
  if (req.id === undefined) return
  if (req.method === 'tools/list') return send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'write_file', description: 'Write text to a path', inputSchema: { type: 'object' } }] } })
  if (req.method === 'tools/call') {
    const a = (req.params && req.params.arguments) || {}
    try { fs.writeFileSync(String(a.path), String(a.text || '')); return send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'wrote' }] } }) }
    catch (e) { return send({ jsonrpc: '2.0', id: req.id, result: { isError: true, content: [{ type: 'text', text: String(e && e.message) }] } }) }
  }
  send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
}
setInterval(() => {}, 1000)
`

async function scenarioAskToolLayer() {
  const root = await scratch()
  const home = await scratch()
  const serverScript = join(root, 'write-mcp.cjs')
  await writeFile(serverScript, WRITE_MCP_SERVER)
  // A global mcp.json naming the writer server (global = trusted).
  await mkdir(join(home, '.sketch'), { recursive: true })
  await writeFile(join(home, '.sketch', 'mcp.json'), JSON.stringify({ mcpServers: { writer: { command: process.execPath, args: [serverScript] } } }))
  // A skill whose grant includes the write + spawn capabilities.
  const skillDir = join(root, '.sketch', 'skills', 'writer-skill')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: writer-skill\ndescription: writes files\ncapabilities: [fs:read:project, fs:write:project, proc:spawn]\n---\nuse the writer server\n')

  const model = scriptedModel([
    JSON.stringify({ action: 'tool', name: 'user-writer.write_file', args: { path: join(root, 'via-mcp.txt'), text: 'written' } }),
    JSON.stringify({ action: 'done', text: 'tried the tool' }),
  ])
  const port = await listen(model.server)
  const eng = engine()
  try {
    await eng.call('ping', {})
    // Agent baseline: the tool runs, the file appears.
    const agentId = 'e2e-ask-agent'
    await eng.call('run', {
      root, home, runId: agentId, provider: providerFor(port),
      userMcpServers: ['writer'], skillNames: ['writer-skill'],
      task: { id: 'ta', prompt: 'write via mcp', verify: [] },
    })
    check('E: Agent mode wrote the file via the MCP tool (setup works)', await exists(join(root, 'via-mcp.txt')))
    await rm(join(root, 'via-mcp.txt'), { force: true })

    // Reset the model script for the Ask run.
    const model2 = scriptedModel([
      JSON.stringify({ action: 'tool', name: 'user-writer.write_file', args: { path: join(root, 'via-mcp.txt'), text: 'written' } }),
      JSON.stringify({ action: 'done', text: 'tried the tool' }),
    ])
    const port2 = await listen(model2.server)
    const askId = 'e2e-ask-ro'
    const res = await eng.call('run', {
      root, home, runId: askId, provider: providerFor(port2), readOnly: true,
      userMcpServers: ['writer'], skillNames: ['writer-skill'],
      task: { id: 'tr', prompt: 'write via mcp', verify: [] },
    })
    check('E: Ask mode did NOT write the file through the MCP tool', !(await exists(join(root, 'via-mcp.txt'))))
    const denied = eng.events.find((e) => e.runId === askId && e.kind === 'tool_denied' && String(e.payload?.name).includes('write_file'))
    check('E: Ask mode refused the write tool (tool_denied on the log)', denied !== undefined)
    check('E: the Ask run still finished', terminalOf(eng.events, askId) !== undefined && res.result !== undefined)
    model2.server.close()
    log('E evidence — tool_denied payload:', JSON.stringify(denied?.payload))
  } finally {
    await eng.stop()
    model.server.close()
  }
}

async function main() {
  if (!(await exists(CLI))) {
    log('dist/cli.js missing — run `npm run build -w @sketch/core` first')
    process.exit(2)
  }
  await scenarioEditsFail()
  await scenarioApprovalDenied()
  await scenarioAskReadOnly()
  await scenarioCancelCommand()
  await scenarioAskToolLayer()
  for (const r of roots) await rm(r, { recursive: true, force: true }).catch(() => {})
  if (failures.length === 0) {
    log('W5 E2E: ALL PASS')
    process.exit(0)
  }
  log('W5 E2E: FAILURES:')
  for (const f of failures) log('  -', f)
  process.exit(1)
}

await main()
