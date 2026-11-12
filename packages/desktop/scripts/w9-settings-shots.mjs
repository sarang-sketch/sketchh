#!/usr/bin/env node
// W9 Settings-dialog screenshots + overflow measurements over the Vite dev preview.
//
// The owner's Settings concern (UI_UX_AUDIT): a fixed-width modal with a large empty
// gutter at 1920, and the B-009 double-privacy tab. This driver seeds a KEYLESS custom
// provider so the first-run Connect modal does not cover the dialog (the method
// w4-ui-proof.mjs uses), opens Settings, and for each window size and each of the six
// tabs it:
//   * screenshots into picture/overhaul/w9/,
//   * records document.scrollWidth vs clientWidth (horizontal overflow),
//   * records the dialog's own clientWidth and whether the content pane scrolls inside
//     the dialog rather than overflowing the window.
//
//   node scripts/w9-settings-shots.mjs --port 1436 --edge-port 9436
//
// Isolation: throwaway HOME/USERPROFILE under %TEMP%, a scratch project, a fresh Edge
// --user-data-dir; stops the dev server and Edge by the PIDs it launched. Node built-ins.

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

const vitePort = Number(flag('port', '1436'))
const edgePort = Number(flag('edge-port', '9436'))
const shotDir = resolve(flag('shot-dir', join(here, '..', '..', '..', 'picture', 'overhaul', 'w9')))
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
// Each tab, by its nav-button label. Models needs no key to render (ProviderSettings
// lists the keyless provider), so all six are measured.
const TABS = ['Models', 'Agent', 'Editor', 'Privacy', 'Shortcuts', 'About']

const home = mkdtempSync(join(tmpdir(), 'sketch-w9-home-'))
const projectRoot = mkdtempSync(join(tmpdir(), 'sketch-w9-proj-'))
const edgeProfile = mkdtempSync(join(tmpdir(), 'sketch-w9-edge-'))
const env = { ...process.env, HOME: home, USERPROFILE: home }
delete env.SKETCH_FAKE_PROVIDER

// A keyless custom provider so onboarding is satisfied and the Connect modal stays shut.
mkdirSync(join(home, '.sketch'), { recursive: true })
writeFileSync(
  join(home, '.sketch', 'providers.json'),
  JSON.stringify({
    version: 1,
    providers: [{ id: 'custom', label: 'Local (keyless)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }],
    selected: 'custom',
  }),
  'utf8',
)

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
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} timed out`)) }, 45000)
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

const results = []
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

  // 2) Headless Edge + CDP.
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
  await sleep(1800)

  // Seed the opened folder + provider selection, then reload so the app boots with them.
  const rootForJs = projectRoot.replace(/\\/g, '/')
  await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(()=>{try{const k='sketch.ui.v1';const s=JSON.parse(localStorage.getItem(k)||'{}');s.projectRoot=${JSON.stringify(rootForJs)};s.selectedProvider='custom';s.selectedModel='m';localStorage.setItem(k,JSON.stringify(s));return 'ok'}catch(e){return 'err:'+e.message}})()`,
  })
  await send('Page.reload')
  await sleep(2800)

  // Open Settings: click a control whose accessible name is "Settings".
  const opened = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Settings$/.test((x.getAttribute('aria-label')||x.getAttribute('title')||x.textContent||'').trim())||/Settings \\(/.test((x.getAttribute('title')||'')));if(b){b.click();return 'clicked'}return 'no-settings-button'})()`,
  })
  console.log('open settings:', opened.result.value)
  await sleep(900)
  const dialogThere = await send('Runtime.evaluate', { returnByValue: true, expression: `!!document.querySelector('[role=dialog][aria-label=Settings]')` })
  if (!dialogThere.result.value) throw new Error('Settings dialog did not open')
  const modalCheck = await send('Runtime.evaluate', { returnByValue: true, expression: `/Connect a model/i.test(document.body.innerText) && !!document.querySelector('[class*=connectBackdrop],[class*=wizard]')` })
  console.log('connect-modal-over-dialog:', modalCheck.result.value)

  // Switch to a settings tab by clicking the nav button of that label.
  const clickTab = (label) => `(()=>{const nav=document.querySelector('[role=dialog][aria-label=Settings]');if(!nav)return 'no-dialog';const b=[...nav.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(b){b.click();return 'ok'}return 'no-tab'})()`

  for (const size of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    for (const tab of TABS) {
      const clicked = await send('Runtime.evaluate', { returnByValue: true, expression: clickTab(tab) })
      await sleep(450)
      const metrics = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(()=>{
          const docSW=document.documentElement.scrollWidth, docCW=document.documentElement.clientWidth;
          const dialog=document.querySelector('[role=dialog][aria-label=Settings]');
          const content=dialog&&dialog.querySelector('[class*=content]');
          const dr=dialog?dialog.getBoundingClientRect():null;
          return {
            docScrollWidth:docSW, docClientWidth:docCW, docOverflow:docSW>docCW,
            dialogWidth:dr?Math.round(dr.width):null,
            dialogRightInView:dr?dr.right<=docCW+1:null,
            contentScrolls: content? content.scrollHeight>content.clientHeight : null,
            contentOverflowX: content? content.scrollWidth>content.clientWidth : null,
            activeTab: tab
          };
        })()`.replace('tab', JSON.stringify(tab)),
      })
      const m = metrics.result.value
      results.push({ size: `${size.w}x${size.h}`, tab, clicked: clicked.result.value, ...m })
      const name = `after-settings-${tab.toLowerCase()}-${size.w}x${size.h}.png`
      const shot = isAbsolute(name) ? name : join(shotDir, name)
      // Best-effort capture: the measurement above is the invariant's proof. A flaky
      // screenshot under memory pressure must not lose the whole run's data, so a capture
      // failure is recorded and the loop continues.
      let shotOk = false
      try {
        const { data } = await send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(shot, Buffer.from(data, 'base64'))
        shotOk = true
      } catch (e) {
        console.warn(`shot ${name} capture failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      results[results.length - 1].shot = shotOk
      console.log(`shot ${name}  docOverflow=${m.docOverflow} dialogW=${m.dialogWidth} contentOverflowX=${m.contentOverflowX} captured=${shotOk}`)
    }
  }
  ws.close()
  writeFileSync(join(shotDir, 'after-settings-overflow.json'), JSON.stringify({ projectRoot, results }, null, 2))
} catch (err) {
  failure = err instanceof Error ? err.message : String(err)
} finally {
  killPid(edge && edge.pid)
  killPid(vite && vite.pid)
  await sleep(1200)
  for (const d of [home, projectRoot, edgeProfile]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }) } catch { /* */ } }
}

if (failure) { console.error(`w9-settings-shots: FAIL — ${failure}`); process.exit(1) }
console.table(results.map((r) => ({ size: r.size, tab: r.tab, docOverflow: r.docOverflow, dialogW: r.dialogWidth, contentOverflowX: r.contentOverflowX })))
const docOverflows = results.filter((r) => r.docOverflow)
const contentOverflows = results.filter((r) => r.contentOverflowX)
if (docOverflows.length > 0) { console.error(`DOC OVERFLOW in ${docOverflows.length} size/tab combos`); process.exit(2) }
if (contentOverflows.length > 0) { console.error(`CONTENT X-OVERFLOW in ${contentOverflows.length} size/tab combos`); process.exit(3) }
console.log('No horizontal overflow at any size on any settings tab.')
