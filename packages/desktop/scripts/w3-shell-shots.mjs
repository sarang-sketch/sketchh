#!/usr/bin/env node
// W3 shell screenshots + overflow measurements over the Vite dev preview.
//
// On this host the packaged app cannot be driven over CDP (WebView2 156 opens no
// listener — see the W2 fix doc §6.4), so the shell is verified in the Vite dev
// preview driven by headless Edge over CDP, which is the method W1 used for the audit.
//
//   node scripts/w3-shell-shots.mjs --port 1430 --edge-port 9431 --phase after
//
// For each window size and each surface (Cowork / Code) it sets the viewport via
// CDP Emulation, screenshots into picture/overhaul/w3/, and records
// document.scrollWidth vs clientWidth (horizontal overflow iff scrollWidth > clientWidth).
//
// Isolation: a throwaway HOME/USERPROFILE under %TEMP%, SKETCH_FAKE_PROVIDER=1, and a
// fresh Edge --user-data-dir per run. It stops the dev server and Edge (by the PIDs it
// launched) when done. No dependency added — Node's built-in WebSocket + fetch only.

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

const vitePort = Number(flag('port', process.env.W3_VITE_PORT || '1430'))
const edgePort = Number(flag('edge-port', process.env.W3_EDGE_PORT || '9431'))
const phase = flag('phase', 'after') // 'before' | 'after'
const shotDir = resolve(flag('shot-dir', join(here, '..', '..', '..', 'picture', 'overhaul', 'w3')))
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

const home = mkdtempSync(join(tmpdir(), 'sketch-w3-home-'))
const edgeProfile = mkdtempSync(join(tmpdir(), 'sketch-w3-edge-'))
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
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
  return (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++
    pending.set(id, { res, rej })
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
  // 1) Vite dev server. In this npm-workspaces repo vite is hoisted to the repo-root
  // node_modules, so resolve it there (packages/desktop → repo root is two levels up).
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
  // Wait for the first real paint, not just a fixed delay: poll until the shell's
  // title bar is in the DOM, then give the mode transition a beat. This avoids the
  // blank first frame at the largest viewport.
  {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const r = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: `!!document.querySelector('[data-tauri-drag-region]') && document.body.innerText.length > 50`,
      })
      if (r.result.value === true) break
      await sleep(400)
    }
    await sleep(1500)
  }

  const surfaces = [
    { id: 'cowork', label: 'Cowork' },
    { id: 'code', label: 'Code' },
  ]
  for (const size of sizes) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false,
    })
    for (const surface of surfaces) {
      // Switch surface by clicking the mode-pill button with the matching label.
      await send('Runtime.evaluate', {
        expression: `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(surface.label)}); if(b){b.click();return 'clicked';} return 'not-found'; })()`,
        returnByValue: true,
      })
      await sleep(900)
      const metrics = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: `({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight })`,
      })
      const m = metrics.result.value
      const overflow = m.scrollWidth > m.clientWidth
      results.push({ size: `${size.w}x${size.h}`, surface: surface.id, ...m, overflow })
      const name = `${phase}-${surface.id}-${size.w}x${size.h}.png`
      const shot = isAbsolute(name) ? name : join(shotDir, name)
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(shot, Buffer.from(data, 'base64'))
      console.log(`shot ${name}  scrollW=${m.scrollWidth} clientW=${m.clientWidth} overflow=${overflow}`)
    }
  }
  ws.close()
  writeFileSync(join(shotDir, `${phase}-overflow.json`), JSON.stringify(results, null, 2))
} catch (err) {
  failure = err instanceof Error ? err.message : String(err)
} finally {
  killPid(edge && edge.pid)
  killPid(vite && vite.pid)
  await sleep(1200)
  try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }) } catch { /* */ }
  try { rmSync(edgeProfile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* */ }
}

if (failure) { console.error(`w3-shell-shots: FAIL — ${failure}`); process.exit(1) }
console.log('w3-shell-shots: done.')
console.table(results.map((r) => ({ size: r.size, surface: r.surface, scrollW: r.scrollWidth, clientW: r.clientWidth, overflow: r.overflow })))
