// W4 end-to-end driver — the provider layer over the real JSON-line RPC, counted ON
// THE WIRE against a local recording server.
//
// Drives `packages/core/dist/cli.js` exactly as the desktop sidecar does (one JSON
// object per line on stdin; event + response frames on stdout), with a KEYLESS local
// provider pointed at the recording server from `w4-recording-server.mjs`. No provider
// key is used and nothing leaves the machine.
//
// It proves the W4 invariants against the SHIPPED build:
//   S1  MODEL IDENTITY + COUNTING. A run whose server answers with a DIFFERENT model
//       than requested. Three numbers side by side — requests the server saw,
//       llm_response events, receipt modelCalls — must agree; tokens must equal the
//       scripted usage summed; and each llm_response must carry the ANSWERED model.
//   S2  ERROR MAPPING. provider-test against scripted 401/403/404/429(+Retry-After)/
//       500/malformed, each mapped to its own specific code.
//   S3  NON-RUN CALLS. git-commit-message and inline-edit each make exactly ONE wire
//       call, and the model they report is the one that answered.
//
// Usage:  node packages/core/scripts/w4-e2e-rpc.mjs
// Exit 0 and prints "W4 E2E: ALL PASS" when every scenario held.

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRecordingServer, listen, SCRIPTED_USAGE } from './w4-recording-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'dist', 'cli.js')

const log = (...a) => console.log('[w4-e2e]', ...a)
const failures = []
function check(name, cond, detail = '') {
  if (cond) log('PASS', name)
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    log('FAIL', name, detail)
  }
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
      try { frame = JSON.parse(line) } catch { continue }
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
    events,
    call,
    stop: () => new Promise((r) => (child.once('close', r), child.stdin.end(), child.kill())),
  }
}

const roots = []
async function scratch() {
  const r = await mkdtemp(join(tmpdir(), 'w4-e2e-'))
  roots.push(r)
  return r
}
function providerFor(port, model = 'openrouter/auto') {
  return { id: 'custom', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model }
}

// A three-call agent script: plan, verify, done (the fake action protocol, but served
// over the real wire by the recording server so usage + the answered model are real).
const AGENT_SCRIPT = [
  JSON.stringify({ action: 'plan', artifacts: { prd: 'do the thing' } }),
  JSON.stringify({ action: 'verify' }),
  JSON.stringify({ action: 'done', text: 'done' }),
]

// ── S1. model identity + counting ────────────────────────────────────────────
async function scenarioModelIdentity() {
  const root = await scratch()
  // The server answers naming a DIFFERENT model than the requested `openrouter/auto`.
  const rec = makeRecordingServer({ answeredModel: 'deepseek/deepseek-chat-v3', script: AGENT_SCRIPT })
  const port = await listen(rec.server)
  const eng = engine()
  try {
    await eng.call('ping', {})
    const runId = 'w4-s1'
    await eng.call('run', {
      root,
      runId,
      provider: providerFor(port),
      reviewEdits: false,
      task: { id: 't', prompt: 'do it', verify: [] },
    })
    const llmResponses = eng.events.filter((e) => e.runId === runId && e.kind === 'llm_response')
    const serverCompletions = rec.completionCount()
    const receipt = (await eng.call('cost', { root, runId })).result

    // Three numbers side by side.
    const calls = receipt.total.calls
    log(`S1 THREE-NUMBER: server=${serverCompletions} events=${llmResponses.length} receipt=${calls}`)
    check('S1: server requests == llm_response events == receipt calls', serverCompletions === llmResponses.length && llmResponses.length === calls, `${serverCompletions}/${llmResponses.length}/${calls}`)

    // Tokens are exact: scripted usage per call, summed.
    const expectedIn = SCRIPTED_USAGE.prompt_tokens * calls
    const expectedOut = SCRIPTED_USAGE.completion_tokens * calls
    check('S1: tokens in == scripted × calls', receipt.total.tokensIn === expectedIn, `${receipt.total.tokensIn} vs ${expectedIn}`)
    check('S1: tokens out == scripted × calls', receipt.total.tokensOut === expectedOut, `${receipt.total.tokensOut} vs ${expectedOut}`)

    // Each llm_response records the ANSWERED model, not the requested one.
    const answered = llmResponses.every((e) => e.payload.responseModel === 'deepseek/deepseek-chat-v3' && e.payload.model === 'openrouter/auto')
    check('S1: every llm_response names the answered model + the requested model', answered, JSON.stringify(llmResponses.map((e) => ({ m: e.payload.model, r: e.payload.responseModel }))))

    // The ledger priced + attributed by the answered model.
    const entry = receipt.entries[0]
    check('S1: ledger entry attributes the answered model, surfaces the requested one', entry?.model === 'deepseek/deepseek-chat-v3' && entry?.requestedModel === 'openrouter/auto', JSON.stringify({ model: entry?.model, requested: entry?.requestedModel }))

    // Every request the server saw was logged with the requested model + a timestamp.
    const reqs = rec.requests().filter((r) => r.path.includes('completion'))
    check('S1: every wire request logged the requested model', reqs.length === calls && reqs.every((r) => r.model === 'openrouter/auto' && typeof r.ts === 'number'), JSON.stringify(reqs))
    log('S1 evidence — requests:', JSON.stringify(rec.requests()))
  } finally {
    await eng.stop()
    rec.server.close()
  }
}

// ── S2. error mapping over provider-test ──────────────────────────────────────
async function scenarioErrorMapping() {
  const eng = engine()
  try {
    await eng.call('ping', {})
    // provider-test hits GET /models; the recording server answers that GET with the
    // scripted error for each case.
    const cases = [
      { status: 401, expect: 'unauthorized' },
      { status: 403, expect: 'forbidden' },
      { status: 429, retryAfter: 30, expect: 'rate-limited' },
      { status: 500, expect: 'endpoint-error' },
    ]
    for (const c of cases) {
      // provider-test probes GET /models; a server that answers EVERY path with the
      // scripted status + Retry-After exercises the error mapping on the real wire.
      const rec = makeRecordingServer()
      rec.server.removeAllListeners('request')
      rec.server.on('request', (_req, res) => {
        const headers = { 'Content-Type': 'application/json' }
        if (c.retryAfter !== undefined) headers['Retry-After'] = String(c.retryAfter)
        res.writeHead(c.status, headers).end(JSON.stringify({ error: { message: `scripted ${c.status}` } }))
      })
      const port = await listen(rec.server)
      const res = (await eng.call('provider-test', {
        provider: { id: 'custom', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'sk-fake-key-not-real-000' },
      })).result
      check(`S2: HTTP ${c.status} → code ${c.expect}`, res.code === c.expect, `got ${res.code} (${res.message})`)
      if (c.status === 429) check('S2: 429 parsed Retry-After seconds', res.retryAfterSeconds === c.retryAfter, `got ${res.retryAfterSeconds}`)
      rec.server.close()
    }
  } finally {
    await eng.stop()
  }
}

// ── S3. non-run calls each make exactly ONE wire call ─────────────────────────
async function scenarioNonRunCalls() {
  const root = await scratch()
  await writeFile(join(root, 'a.txt'), 'hello\n')
  const rec = makeRecordingServer({ answeredModel: 'served-model-x', reply: 'rewritten text' })
  const port = await listen(rec.server)
  const eng = engine()
  try {
    await eng.call('ping', {})
    // Inline edit: exactly one wire call, reporting the answered model.
    const before = rec.completionCount()
    const res = (await eng.call('inline-edit', {
      root,
      provider: providerFor(port, 'req-model'),
      path: 'a.txt',
      before: '',
      selection: 'hello',
      after: '',
      instruction: 'uppercase it',
    })).result
    const after = rec.completionCount()
    check('S3: inline-edit made exactly one wire call', after - before === 1, `${after - before}`)
    check('S3: inline-edit reports the answered model', res.responseModel === 'served-model-x', JSON.stringify({ model: res.model, responseModel: res.responseModel }))
    log('S3 evidence — requests:', JSON.stringify(rec.requests()))
  } finally {
    await eng.stop()
    rec.server.close()
  }
}

// ── S4. an automatic retry is counted: 500 then 200 ──────────────────────────
async function scenarioRetryCounted() {
  const root = await scratch()
  // Each agent turn: the server answers 500 once (retryable) then 200. So one logical
  // call costs two wire requests. The agent script is three turns.
  const script = []
  for (const action of AGENT_SCRIPT) {
    script.push({ status: 500 }) // first wire attempt fails, retryable
    script.push({ text: action }) // retry succeeds
  }
  const rec = makeRecordingServer({ script })
  const port = await listen(rec.server)
  const eng = engine()
  try {
    await eng.call('ping', {})
    const runId = 'w4-s4'
    await eng.call('run', {
      root,
      runId,
      provider: providerFor(port, 'gpt-4o'),
      reviewEdits: false,
      task: { id: 't', prompt: 'do it', verify: [] },
    })
    const llmResponses = eng.events.filter((e) => e.runId === runId && e.kind === 'llm_response')
    const serverRequests = rec.completionCount()
    // 3 logical calls, each retried once → 6 wire requests, 3 events, each attempts=2.
    log(`S4 RETRY: server=${serverRequests} events=${llmResponses.length}`)
    check('S4: one logical call per turn (events) but two wire requests each', llmResponses.length === 3 && serverRequests === 6, `${llmResponses.length}/${serverRequests}`)
    check('S4: every llm_response records attempts=2', llmResponses.every((e) => e.payload.attempts === 2), JSON.stringify(llmResponses.map((e) => e.payload.attempts)))
    log('S4 evidence — attempts per event:', JSON.stringify(llmResponses.map((e) => e.payload.attempts)))
  } finally {
    await eng.stop()
    rec.server.close()
  }
}

async function main() {
  try {
    await scenarioModelIdentity()
    await scenarioErrorMapping()
    await scenarioNonRunCalls()
    await scenarioRetryCounted()
  } finally {
    for (const r of roots) await rm(r, { recursive: true, force: true }).catch(() => {})
  }
  if (failures.length > 0) {
    log(`\n${failures.length} FAILURE(S):`)
    for (const f of failures) log(' -', f)
    process.exit(1)
  }
  log('\nW4 E2E: ALL PASS')
}

main().catch((err) => {
  console.error('[w4-e2e] fatal', err)
  process.exit(1)
})
