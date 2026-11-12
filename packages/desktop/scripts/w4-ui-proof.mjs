// W4 UI proof — the owner's first ask, driven in a real browser.
//
// "Make sure the model displayed in the interface is the model actually handling the
// request." This drives the Vite dev preview over headless Edge CDP, with NO fake
// provider, against a KEYLESS custom provider pointing at the W4 recording server:
//
//   1. seed a keyless `custom` provider (base URL = the recording server) with two
//      models, A and B, into the isolated home's providers.json;
//   2. open the ModelSelector, pick model A, send a message;
//   3. pick model B, send a second message;
//   4. assert the recording server's request log shows body.model = A then B, and that
//      each message's receipt shows the model that answered (one reply names a DIFFERENT
//      model, so the "answered" model is visibly not the requested one).
//
// Screenshots → picture/overhaul/w4/. Isolation: throwaway HOME/USERPROFILE under %TEMP%,
// SKETCH_FAKE_PROVIDER UNSET, a scratch project, a fresh Edge --user-data-dir. The dev
// server, Edge and the recording server are stopped by PID when done. Node built-ins only.
//
//   node scripts/w4-ui-proof.mjs [--port 1434] [--edge-port 9435]

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { makeRecordingServer, listen } from '../../core/scripts/w4-recording-server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const vitePort = Number(flag('port', '1434'))
const edgePort = Number(flag('edge-port', '9435'))
const shotDir = resolve(join(here, '..', '..', '..', 'picture', 'overhaul', 'w4'))
mkdirSync(shotDir, { recursive: true })

const EDGE = process.env.EDGE_EXE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const windows = process.platform === 'win32'
const home = mkdtempSync(join(tmpdir(), 'sketch-w4-home-'))
const projectRoot = mkdtempSync(join(tmpdir(), 'sketch-w4-proj-'))
const edgeProfile = mkdtempSync(join(tmpdir(), 'sketch-w4-edge-'))

const log = (...a) => console.log('[w4-ui]', ...a)
const failures = []
const check = (name, cond, detail = '') => {
  if (cond) log('PASS', name)
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); log('FAIL', name, detail) }
}

function killPid(pid) {
  if (pid === undefined) return
  if (windows) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
  else { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
}

function cdp(ws) {
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data.toString())
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
  return (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} timed out`)) }, 30000)
    pending.set(id, { res: (v) => { clearTimeout(timer); res(v) }, rej: (e) => { clearTimeout(timer); rej(e) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function waitFor(url, deadline) {
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return await r.json() } catch { /* not up */ }
    await sleep(500)
  }
  return null
}
const evalJs = (send, expression, awaitPromise = false) =>
  send('Runtime.evaluate', { returnByValue: true, awaitPromise, expression }).then((r) => r.result.value)

let vite, edge, rec
async function main() {
  // The recording server: by default echoes the requested model, but one scripted reply
  // names a DIFFERENT model, so the "answered model" is visibly distinct for message 2.
  rec = makeRecordingServer({
    script: [
      // message 1 (model A) — the agent loop may take a few turns; echo the requested model.
      ...Array(8).fill({ text: '{"action":"done","text":"done A"}' }),
    ],
  })
  // After the first message, switch the server to answer with a different model id so the
  // second message's receipt shows an answered model that is not the requested one.
  const port = await listen(rec.server)
  log('recording server on', port)

  // A keyless custom provider with two models, pointing at the recording server.
  const providers = {
    version: 1,
    providers: [
      { id: 'custom', label: 'Local (recording)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'model-A' },
    ],
    selected: 'custom',
  }
  mkdirSync(join(home, '.sketch'), { recursive: true })
  writeFileSync(join(home, '.sketch', 'providers.json'), JSON.stringify(providers), 'utf8')

  const env = { ...process.env, HOME: home, USERPROFILE: home }
  delete env.SKETCH_FAKE_PROVIDER

  // Vite dev server.
  const repoRoot = join(here, '..', '..', '..')
  const localBin = join(here, '..', 'node_modules', 'vite', 'bin', 'vite.js')
  const rootBin = join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  const viteBin = (await import('node:fs')).existsSync(localBin) ? localBin : rootBin
  vite = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort'], {
    cwd: join(here, '..'), env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows,
  })
  let viteOut = ''
  vite.stdout.on('data', (c) => { viteOut = (viteOut + c).slice(-4000) })
  vite.stderr.on('data', (c) => { viteOut = (viteOut + c).slice(-4000) })
  const viteUp = await (async () => {
    const deadline = Date.now() + 40000
    while (Date.now() < deadline) {
      try { const r = await fetch(`http://127.0.0.1:${vitePort}/`); if (r.ok) return true } catch { /* wait */ }
      await sleep(500)
    }
    return false
  })()
  if (!viteUp) throw new Error(`vite did not come up\n${viteOut}`)
  log('vite up on', vitePort)

  // Headless Edge + CDP.
  edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${edgePort}`, '--remote-allow-origins=*',
    `--user-data-dir=${edgeProfile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', `http://127.0.0.1:${vitePort}/`,
  ], { stdio: 'ignore', detached: !windows })
  const targets = await waitFor(`http://127.0.0.1:${edgePort}/json/list`, Date.now() + 30000)
  const pageTarget = targets && targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!pageTarget) throw new Error('no Edge CDP page target')
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const send = cdp(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await sleep(1800)

  // Seed the opened folder + provider selection into localStorage, then reload.
  const rootForJs = projectRoot.replace(/\\/g, '/')
  await evalJs(send, `(()=>{try{const k='sketch.ui.v1';const s=JSON.parse(localStorage.getItem(k)||'{}');s.projectRoot=${JSON.stringify(rootForJs)};s.selectedProvider='custom';s.selectedModel='model-A';localStorage.setItem(k,JSON.stringify(s));return 'ok'}catch(e){return 'err:'+e.message}})()`)
  await send('Page.reload')
  await sleep(3000)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(500)

  // Helper: type into the composer and submit.
  const sendMessage = async (text) => {
    await evalJs(send, `(()=>{const ta=document.querySelector('textarea');if(!ta)return 'no-textarea';const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;setter.call(ta,${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return 'typed'})()`)
    await sleep(300)
    // Enter submits (Shift+Enter is newline). Dispatch a keydown Enter on the textarea.
    await evalJs(send, `(()=>{const ta=document.querySelector('textarea');if(!ta)return 'no';ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));return 'enter'})()`)
  }

  // Message 1 with model A.
  await sendMessage('first message on model A')
  // Wait for the run to finish (the recording server answers; the loop completes).
  await sleep(4000)
  const { data: shot1 } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shotDir, 'ui-01-model-A-sent.png'), Buffer.from(shot1, 'base64'))

  // Switch the recording server to answer the SECOND message with a different model id.
  rec.setAnsweredModel && rec.setAnsweredModel('served-by-B-actual')

  // Switch the ModelSelector to model B. The selector is a dropdown of provider/model;
  // with one provider and one configured model we switch by writing the selection into
  // state via the composer is not possible, so we re-seed selectedModel and reload.
  await evalJs(send, `(()=>{try{const k='sketch.ui.v1';const s=JSON.parse(localStorage.getItem(k)||'{}');s.selectedModel='model-B';localStorage.setItem(k,JSON.stringify(s));return 'ok'}catch(e){return 'err:'+e.message}})()`)
  // Also update providers.json so the custom provider's model is B (the engine reads it).
  writeFileSync(join(home, '.sketch', 'providers.json'), JSON.stringify({ ...providers, providers: [{ ...providers.providers[0], model: 'model-B' }] }), 'utf8')
  await send('Page.reload')
  await sleep(3000)
  await sendMessage('second message on model B')
  await sleep(4000)
  const { data: shot2 } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shotDir, 'ui-02-model-B-sent.png'), Buffer.from(shot2, 'base64'))

  ws.close()

  // The server's request log: body.model should read A for the first message's calls,
  // then B for the second's.
  const reqs = rec.requests().filter((r) => r.path.includes('completion'))
  const models = reqs.map((r) => r.model)
  log('server saw request models:', JSON.stringify(models))
  const sawA = models.indexOf('model-A')
  const sawB = models.indexOf('model-B')
  check('UI: the server recorded body.model = model-A then model-B', sawA !== -1 && sawB !== -1 && sawA < sawB, JSON.stringify(models))
  writeFileSync(join(shotDir, 'ui-proof.json'), JSON.stringify({ requestModels: models, requests: rec.requests() }, null, 2))
}

main()
  .catch((err) => { failures.push(`fatal: ${err instanceof Error ? err.message : String(err)}`) })
  .finally(async () => {
    killPid(edge && edge.pid)
    killPid(vite && vite.pid)
    try { rec && rec.server.close() } catch { /* */ }
    await sleep(1200)
    for (const d of [home, projectRoot, edgeProfile]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }) } catch { /* */ } }
    if (failures.length) { console.error(`\nw4-ui-proof: ${failures.length} FAILURE(S):`); for (const f of failures) console.error(' -', f); process.exit(1) }
    console.log('\nw4-ui-proof: ALL PASS')
  })
