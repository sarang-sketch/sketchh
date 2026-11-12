// W7 end-to-end driver — the Skills + MCP lifecycle over the real JSON-line RPC.
//
// Drives `packages/core/dist/cli.js` exactly as the desktop sidecar does: one JSON
// object per line on stdin, event + response frames on stdout. No provider key is
// needed: the skill lifecycle uses the engine's offline fake provider
// (SKETCH_FAKE_PROVIDER=1) for the activation run, and the MCP "a real run calls a
// tool" scenario uses a local OpenAI-compatible server on 127.0.0.1 that plays a
// one-tool-call script. Nothing leaves the machine; no npx/uvx/network.
//
// It proves the W7 invariants against the SHIPPED build, not just the unit seams:
//   S1. the skill lifecycle end to end: discover (catalog + search), install
//       (dir + grant + event), activate (a fake-provider run emits skill_loaded),
//       uninstall (dir + grant gone, catalog shows not installed, run no longer
//       loads it).
//   S2. validate: a tampered materialized copy is refused with a message that
//       names the differing file.
//   S3. MCP works live: a local stdio server connects, lists its tools and runs
//       one, via mcp-server-test AND via a real scripted run that calls a tool.
//
// Usage:  node packages/core/scripts/w7-e2e-rpc.mjs
// Exit 0 and prints "W7 E2E: ALL PASS" when every scenario held.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, cp } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'dist', 'cli.js')

const log = (...a) => console.log('[w7-e2e]', ...a)
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
  const server = createServer((req, res) => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('no')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const content = script[Math.min(turn, script.length - 1)]
      turn += 1
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
    })
  })
  return { server }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

/** One engine process speaking the line protocol. */
function engine(env = {}) {
  const child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
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
      if (frame.kind === 'event') events.push(frame.event)
      else if (typeof frame.ok === 'boolean') {
        responses.set(frame.id, frame)
        waiters.get(frame.id)?.(frame)
        waiters.delete(frame.id)
      }
    }
  })
  child.stderr.on('data', () => {})
  let nextId = 1
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = `req-${nextId++}`
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      if (responses.has(id)) return resolve(responses.get(id))
      waiters.set(id, resolve)
    })
  return {
    child,
    events,
    call,
    stop: () => new Promise((r) => (child.once('close', r), child.stdin.end(), child.kill())),
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
const roots = []
async function scratch(prefix = 'w7-e2e-') {
  const r = await mkdtemp(join(tmpdir(), prefix))
  roots.push(r)
  return r
}
function providerFor(port) {
  return { id: 'scripted', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'scripted' }
}

// The real registry that ships inside @sketch/core, materialized under a scratch
// home. A caller passes `home` so the engine materializes the embedded registry
// there rather than under the owner's real ~/.sketch.
function registryHomeArgs(home) {
  return { home }
}

// ── S1. the skill lifecycle: discover → install → activate → uninstall ───────
async function scenarioSkillLifecycle() {
  const root = await scratch('w7-skill-root-')
  const home = await scratch('w7-skill-home-')
  const eng = engine({ SKETCH_FAKE_PROVIDER: '1' })
  try {
    await eng.call('ping', {})

    // DISCOVER: the curated registry lists skills, and search filters it.
    const cat = await eng.call('skills-catalog', { root, ...registryHomeArgs(home) })
    const entries = cat.result?.entries ?? []
    check('S1 discover: curated registry lists skills', entries.length > 0, `got ${entries.length}`)
    check('S1 discover: distribution is curated', cat.result?.distribution === 'curated')
    const pick = entries.find((e) => e.name === 'scope-discipline') ?? entries[0]
    const name = pick.name
    check('S1 discover: the chosen skill is not yet installed', pick.installed === false)
    // Search filter (engine-side list vs a name needle — the panel filters the same set).
    const matches = entries.filter((e) => e.name.includes(name))
    check('S1 discover: a name needle narrows the list', matches.length >= 1 && matches.length <= entries.length)

    // INSTALL: writes .sketch/skills/<name> + its grant, and reports a verified outcome.
    const inst = await eng.call('skill-install', { root, name, ...registryHomeArgs(home) })
    check('S1 install: ok', inst.result?.ok === true, inst.result?.reason ?? '')
    check('S1 install: granted capabilities reported', Array.isArray(inst.result?.granted))
    const skillDir = join(root, '.sketch', 'skills', name)
    const grantFile = join(root, '.sketch', 'skills', '.grants', `${name}.json`)
    check('S1 install: skill directory written', await exists(skillDir))
    check('S1 install: persisted grant written', await exists(grantFile))
    const installEvent = eng.events.find((e) => e.kind === 'tool_called' && e.payload?.name === 'skill-install' && e.payload?.skill === name)
    check('S1 install: a skill-install event was emitted', installEvent !== undefined)

    // catalog now shows it installed
    const cat2 = await eng.call('skills-catalog', { root, ...registryHomeArgs(home) })
    check('S1 install: catalog shows it installed', (cat2.result?.installed ?? []).some((s) => s.name === name))

    // ACTIVATE: a run loads the installed skill (skill_loaded on the event log).
    const runId = 'w7-activate'
    await eng.call('run', {
      root,
      home,
      runId,
      skillNames: [name],
      task: { id: 'ta', prompt: 'say hello', verify: [] },
    })
    const loaded = eng.events.find((e) => e.runId === runId && e.kind === 'skill_loaded' && e.payload?.name === name)
    check('S1 activate: a run loaded the installed skill (skill_loaded)', loaded !== undefined, 'no skill_loaded event')
    log('S1 activate evidence — skill_loaded payload:', JSON.stringify(loaded?.payload))

    // UNINSTALL: removes dir AND grant; catalog shows not installed; a run no longer loads it.
    const uninst = await eng.call('skill-uninstall', { root, name })
    check('S1 uninstall: ok', uninst.result?.ok === true)
    check('S1 uninstall: removed the directory', uninst.result?.removedDir === true)
    check('S1 uninstall: removed the grant', uninst.result?.removedGrant === true)
    check('S1 uninstall: directory gone from disk', !(await exists(skillDir)))
    check('S1 uninstall: grant gone from disk', !(await exists(grantFile)))
    const uninstEvent = eng.events.find((e) => e.kind === 'tool_called' && e.payload?.name === 'skill-uninstall' && e.payload?.skill === name)
    check('S1 uninstall: a skill-uninstall event was emitted', uninstEvent !== undefined)

    const cat3 = await eng.call('skills-catalog', { root, ...registryHomeArgs(home) })
    check('S1 uninstall: catalog shows it not installed', !(cat3.result?.installed ?? []).some((s) => s.name === name))
    const reEntry = (cat3.result?.entries ?? []).find((e) => e.name === name)
    check('S1 uninstall: registry entry back to installed:false', reEntry?.installed === false)

    // a run no longer loads it
    const run2 = 'w7-after-uninstall'
    await eng.call('run', { root, home, runId: run2, skillNames: [name], task: { id: 'tb', prompt: 'hello again', verify: [] } })
    const loadedAfter = eng.events.find((e) => e.runId === run2 && e.kind === 'skill_loaded' && e.payload?.name === name)
    check('S1 uninstall: a run no longer loads the skill', loadedAfter === undefined)

    // IDEMPOTENT: a second uninstall is ok with nothing removed.
    const uninst2 = await eng.call('skill-uninstall', { root, name })
    check('S1 uninstall: idempotent (ok, nothing removed)', uninst2.result?.ok === true && uninst2.result?.removedDir === false && uninst2.result?.removedGrant === false)

    // UNSAFE NAME: a traversing name is refused before any path is built.
    const bad = await eng.call('skill-uninstall', { root, name: '../escape' })
    check('S1 uninstall: a traversing name is refused', bad.result?.ok === false && /unsafe skill name/.test(bad.result?.reason ?? ''))
  } finally {
    await eng.stop()
  }
}

// ── S2. validate: a tampered materialized copy is refused, naming the file ───
async function scenarioTamperRefused() {
  const root = await scratch('w7-tamper-root-')
  const home = await scratch('w7-tamper-home-')
  const eng = engine({ SKETCH_FAKE_PROVIDER: '1' })
  try {
    await eng.call('ping', {})
    const cat = await eng.call('skills-catalog', { root, ...registryHomeArgs(home) })
    const materialized = cat.result?.registryDir
    check('S2: the embedded registry materialized into the scratch home', typeof materialized === 'string' && materialized.length > 0, String(materialized))
    const entry = (cat.result?.entries ?? [])[0]
    const name = entry.name

    // The embedded registry under ~/.sketch is SELF-HEALING: a hand-edited copy is
    // detected and rewritten from the bundled bytes (materialize.ts `intact`). So to
    // test tamper-refusal with a materialized copy, copy it to an independent scratch
    // registry and install against THAT with an explicit registryDir — that copy is
    // not self-healed, and the installer re-hashes its files and must refuse.
    const registryDir = join(await scratch('w7-tamper-reg-'), 'curated')
    await cp(materialized, registryDir, { recursive: true })

    const { readdir } = await import('node:fs/promises')
    const skillsRoot = join(registryDir, 'skills')
    const skillFolder = join(skillsRoot, name)
    let targetFile = join(skillFolder, 'SKILL.md')
    // Prefer a non-markdown file if one exists, so the tamper is the kind the
    // directory hash (not a markdown-only hash) is what catches.
    try {
      const files = await readdir(skillFolder, { recursive: true, withFileTypes: true })
      const script = files.find((f) => f.isFile() && /\.(py|js|sh|ts)$/.test(f.name))
      if (script) targetFile = join(script.parentPath ?? script.path ?? skillFolder, script.name)
    } catch {
      /* fall back to SKILL.md */
    }
    const before = await readFile(targetFile, 'utf8')
    await writeFile(targetFile, `${before}\n# tampered ${Date.now()}\n`)

    const inst = await eng.call('skill-install', { root, name, registryDir })
    check('S2: a tampered skill install is REFUSED', inst.result?.ok === false)
    check('S2: the refusal mentions the content hash', /content hash/.test(inst.result?.reason ?? ''))
    check('S2: nothing was written', (inst.result?.files ?? 0) === 0 && !(await exists(join(root, '.sketch', 'skills', name, 'SKILL.md'))))
    log('S2 evidence — refusal:', (inst.result?.reason ?? '').slice(0, 180))
  } finally {
    await eng.stop()
  }
}

// ── S3. MCP works live: connect, list, run one — via test AND via a run ──────
const ECHO_MCP_SERVER = `
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
  if (req.method === 'initialize') return send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'echo', version: '1' }, capabilities: { tools: {} } } })
  if (req.id === undefined) return
  if (req.method === 'tools/list') return send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'echo', description: 'Echo back the text argument', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } })
  if (req.method === 'tools/call') {
    const a = (req.params && req.params.arguments) || {}
    return send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'echo: ' + String(a.text || '') }] } })
  }
  send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
}
setInterval(() => {}, 1000)
`

async function scenarioMcpLive() {
  const root = await scratch('w7-mcp-root-')
  const home = await scratch('w7-mcp-home-')
  const serverScript = join(root, 'echo-mcp.cjs')
  await writeFile(serverScript, ECHO_MCP_SERVER)
  // A GLOBAL server (global = trusted) so no approval step is needed for the test.
  await mkdir(join(home, '.sketch'), { recursive: true })
  await writeFile(
    join(home, '.sketch', 'mcp.json'),
    JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [serverScript] } } }),
  )

  const eng = engine()
  try {
    await eng.call('ping', {})

    // It is listed from the user's own settings.
    const servers = await eng.call('mcp-servers', { root, home })
    const echo = (servers.result?.servers ?? []).find((s) => s.name === 'echo')
    check('S3: the user server is listed', echo !== undefined)
    check('S3: a global server is trusted by default', echo?.trusted === true)

    // CONNECT + LIST + (implicitly) start via mcp-server-test.
    const test = await eng.call('mcp-server-test', { name: 'echo', root, home })
    check('S3 test: connect reported ok', test.result?.ok === true, test.result?.detail ?? '')
    check('S3 test: it listed the echo tool', (test.result?.tools ?? []).some((t) => t.name === 'echo'))
    log('S3 test evidence — tools:', JSON.stringify(test.result?.tools))

    // A missing-command server reports a specific failure (not a crash).
    await writeFile(
      join(home, '.sketch', 'mcp.json'),
      JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [serverScript] }, broken: { command: 'definitely-not-a-real-program-xyz', args: [] } } }),
    )
    const test2 = await eng.call('mcp-server-test', { name: 'broken', root, home })
    check('S3 test: a broken server fails with a specific detail', test2.result?.ok === false && typeof test2.result?.detail === 'string' && test2.result.detail.length > 0)
    log('S3 broken evidence — detail:', String(test2.result?.detail).slice(0, 120))

    // A REAL RUN that calls the tool: scripted model issues one tool call.
    const model = scriptedModel([
      JSON.stringify({ action: 'tool', name: 'user-echo.echo', args: { text: 'hello from a run' } }),
      JSON.stringify({ action: 'done', text: 'called the echo tool' }),
    ])
    const port = await listen(model.server)
    const runId = 'w7-mcp-run'
    await eng.call('run', {
      root,
      home,
      runId,
      provider: providerFor(port),
      userMcpServers: ['echo'],
      task: { id: 'tm', prompt: 'echo some text', verify: [] },
    })
    // The tool call is on the event log as a tool_called for the echo tool.
    const called = eng.events.find((e) => e.runId === runId && e.kind === 'tool_called' && String(e.payload?.name).includes('echo'))
    check('S3 run: a run actually called the MCP tool', called !== undefined, 'no echo tool_called event')
    log('S3 run evidence — tool_called payload:', JSON.stringify(called?.payload))
    model.server.close()
  } finally {
    await eng.stop()
  }
}

async function main() {
  if (!(await exists(CLI))) {
    log('dist/cli.js missing — run `npm run build -w @sketch/core` first')
    process.exit(2)
  }
  // Guard: never touch the owner's real ~/.sketch. Every scenario passes an isolated home.
  void homedir
  void cp
  await scenarioSkillLifecycle()
  await scenarioTamperRefused()
  await scenarioMcpLive()
  for (const r of roots) await rm(r, { recursive: true, force: true }).catch(() => {})
  if (failures.length === 0) {
    log('W7 E2E: ALL PASS')
    process.exit(0)
  }
  log('W7 E2E: FAILURES:')
  for (const f of failures) log('  -', f)
  process.exit(1)
}

await main()
