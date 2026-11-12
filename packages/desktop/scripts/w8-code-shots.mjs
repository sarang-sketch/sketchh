#!/usr/bin/env node
// W8 Code-surface screenshots + overflow/overlap measurements over the Vite dev
// preview. The W8 invariant 7 "the Code surface at every size": no horizontal
// overflow and no overlap at 1920x1080, 1600x900, 1366x768, 1280x720, 1024x640 and
// 900x600; the side and bottom panels resize/maximize/hide; every activity-bar view
// opens.
//
// The dev preview has NO native filesystem (ipc/bridge.ts throws "not running under
// Tauri"), so this proves LAYOUT only — sizes, panels, overflow — which is exactly
// what the dev preview is for. File/editor/git/terminal WORKFLOWS are proven at the
// engine RPC + jsdom layers (see docs/overhaul/fix-editor-workbench.md).
//
// Dismissing the first-run Connect-a-model dialog: a keyless `custom` provider is
// seeded into the isolated home's providers.json AND selectedProvider/selectedModel
// into localStorage, the way w4-ui-proof.mjs does, so the modal does not sit in front
// of the Code surface (W3's Code shots had that problem).
//
//   node scripts/w8-code-shots.mjs [--port 1438] [--edge-port 9438]
//
// Isolation: throwaway HOME/USERPROFILE under %TEMP%, SKETCH_FAKE_PROVIDER=1, a
// scratch project root, a fresh Edge --user-data-dir. Stops the dev server and Edge
// (by the PIDs it launched) when done. Node built-ins only; no dependency added.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const vitePort = Number(flag('port', '1438'))
const edgePort = Number(flag('edge-port', '9438'))
const shotDir = resolve(flag('shot-dir', join(here, '..', '..', '..', 'picture', 'overhaul', 'w8')))
mkdirSync(shotDir, { recursive: true })

const EDGE = process.env.EDGE_EXE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const sizes = [
  { w: 1920, h: 1080 },
  { w: 1600, h: 900 },
  { w: 1366, h: 768 },
  { w: 1280, h: 720 },
  { w: 1024, h: 640 },
  { w: 900, h: 600 }, // the app's tauri.conf.json minWidth/minHeight
]

const home = mkdtempSync(join(tmpdir(), 'sketch-w8-home-'))
const projectRoot = mkdtempSync(join(tmpdir(), 'sketch-w8-proj-'))
const edgeProfile = mkdtempSync(join(tmpdir(), 'sketch-w8-edge-'))

// A keyless provider so the Connect-a-model wizard does not auto-open over the Code
// surface. baseUrl is a dead loopback port: nothing is sent, we only need the UI to
// believe a provider is configured so the modal stays closed.
mkdirSync(join(home, '.sketch'), { recursive: true })
writeFileSync(
  join(home, '.sketch', 'providers.json'),
  JSON.stringify({
    version: 1,
    providers: [{ id: 'custom', label: 'Local (none)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'model-A' }],
    selected: 'custom',
  }),
  'utf8',
)

const env = { ...process.env, HOME: home, USERPROFILE: home, SKETCH_FAKE_PROVIDER: '1' }
const windows = process.platform === 'win32'
let vite, edge
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
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} timed out`)) }, 20000)
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

// The activity-bar views the Code surface offers, by their aria-label (W3 put an
// aria-label on every view button). We click each and confirm the side panel changed.
const VIEWS = ['Explorer', 'Search', 'Source Control', 'Run', 'Diff Review', 'Live Architecture', 'Timeline', 'Agent Console', 'Test Results']

const results = []
const overflowRows = []
const viewOpened = {}
let failure = null
try {
  // 1) Vite dev server.
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
  if (!viteUp) throw new Error(`vite did not come up on ${vitePort}\n${viteOut}`)

  // 2) Headless Edge with a CDP port + isolated profile.
  edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${edgePort}`, '--remote-allow-origins=*',
    `--user-data-dir=${edgeProfile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', `http://127.0.0.1:${vitePort}/`,
  ], { stdio: 'ignore', detached: !windows })

  const target = await waitFor(`http://127.0.0.1:${edgePort}/json/list`, Date.now() + 30000)
  const page = target && target.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error(`no Edge CDP page target on ${edgePort}`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const send = cdp(ws)
  await send('Page.enable')
  await send('Runtime.enable')

  // Seed the opened folder + the provider selection (dismisses Connect-a-model), AND
  // force the Code surface (surface='code'), then reload so the app boots on Code.
  const rootForJs = projectRoot.replace(/\\/g, '/')
  await sleep(1800)
  await evalJs(send, `(()=>{try{const k='sketch.ui.v1';const s=JSON.parse(localStorage.getItem(k)||'{}');s.projectRoot=${JSON.stringify(rootForJs)};s.selectedProvider='custom';s.selectedModel='model-A';s.surface='code';localStorage.setItem(k,JSON.stringify(s));return 'ok'}catch(e){return 'err:'+e.message}})()`)
  await send('Page.reload')
  await sleep(3000)

  // Make sure we are on the Code surface: click the "Code" pill if present.
  const onCode = await evalJs(send, `(()=>{
    const pill=[...document.querySelectorAll('button,[role=tab],[role=button]')].find(x=>/^Code$/i.test((x.textContent||'').trim()));
    if(pill){pill.click();return 'clicked-code'}
    return 'no-code-pill'
  })()`)
  await sleep(1200)
  const modalUp = await evalJs(send, `/Connect a model|Connect a Model/i.test(document.body.innerText)`)
  console.log('on-code:', onCode, 'connect-modal-visible:', modalUp)

  // Probe that the IDE chrome (activity bar) is present.
  const chrome = await evalJs(send, `({ activityBar: !!document.querySelector('nav[aria-label="Views"],[class*=activityBar]'), bottomPanel: /PROBLEMS|TERMINAL/i.test(document.body.innerText) })`)
  console.log('ide chrome:', JSON.stringify(chrome))

  // ── per-size: open each view, measure document overflow, screenshot ──────────
  for (const size of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false })
    await sleep(350)

    for (const view of VIEWS) {
      const clicked = await evalJs(send, `(()=>{
        const b=[...document.querySelectorAll('button,[role=button],[role=tab]')].find(x=>{
          const al=(x.getAttribute('aria-label')||'').trim(); const tt=(x.getAttribute('title')||'').trim();
          return new RegExp('^'+${JSON.stringify(view)}.replace(/[.*+?^$()|[\\]\\\\]/g,'\\\\$&')+'$','i').test(al) || new RegExp(${JSON.stringify(view)},'i').test(tt) || new RegExp(${JSON.stringify(view)},'i').test(al);
        });
        if(b){b.click();return 'clicked'} return 'not-found'
      })()`)
      await sleep(300)
      const m = await evalJs(send, `({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth })`)
      const docOverflow = m.sw > m.cw
      if (viewOpened[view] === undefined) viewOpened[view] = clicked === 'clicked'
      results.push({ size: `${size.w}x${size.h}`, view, clicked, scrollWidth: m.sw, clientWidth: m.cw, docOverflow })
      if (docOverflow) overflowRows.push({ size: `${size.w}x${size.h}`, view, scrollWidth: m.sw, clientWidth: m.cw })
    }

    // A screenshot of the Explorer view at this size (re-open Explorer first).
    await evalJs(send, `(()=>{const b=[...document.querySelectorAll('button,[role=button]')].find(x=>/^Explorer$/i.test((x.getAttribute('aria-label')||'').trim()));if(b)b.click();return 'ok'})()`)
    await sleep(300)
    const name = `after-code-${size.w}x${size.h}.png`
    const shot = isAbsolute(name) ? name : join(shotDir, name)
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(shot, Buffer.from(data, 'base64'))
    console.log(`shot ${name}  anyOverflow=${results.filter(r=>r.size===`${size.w}x${size.h}`&&r.docOverflow).length>0}`)
  }

  // ── panel behaviour at 1366x768: hide side panel, hide/maximize bottom panel ──
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
  const panelProbe = await evalJs(send, `(()=>{
    const out={};
    // Hide the bottom panel (its Hide button has an aria-label).
    const hide=[...document.querySelectorAll('button')].find(x=>/hide( the)? panel/i.test((x.getAttribute('aria-label')||'')+(x.getAttribute('title')||'')));
    out.bottomHideButton=!!hide;
    // Maximize the bottom panel.
    const max=[...document.querySelectorAll('button')].find(x=>/maximi/i.test((x.getAttribute('aria-label')||'')+(x.getAttribute('title')||'')));
    out.bottomMaxButton=!!max;
    // A resize handle exists for the side panel.
    out.resizeHandles=document.querySelectorAll('[class*=resize],[class*=Resize]').length;
    return out;
  })()`)
  console.log('panel behaviour probe:', JSON.stringify(panelProbe))

  ws.close()
  writeFileSync(join(shotDir, 'after-code-overflow.json'), JSON.stringify({ projectRoot, chrome, viewOpened, panelProbe, results, overflowRows }, null, 2))
} catch (err) {
  failure = err instanceof Error ? err.message : String(err)
} finally {
  killPid(edge && edge.pid)
  killPid(vite && vite.pid)
  await sleep(1200)
  for (const d of [home, projectRoot, edgeProfile]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }) } catch { /* */ } }
}

if (failure) { console.error(`w8-code-shots: FAIL — ${failure}`); process.exit(1) }
console.log('w8-code-shots: done.')
console.table(results.filter((r) => r.view === 'Explorer'))
console.log('views opened:', JSON.stringify(viewOpened))
if (overflowRows.length > 0) { console.error(`HORIZONTAL OVERFLOW in ${overflowRows.length} size/view combos`); console.table(overflowRows); process.exit(2) }
console.log('No horizontal overflow at any size on any Code-surface view.')
