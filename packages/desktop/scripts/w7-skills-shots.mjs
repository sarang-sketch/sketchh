#!/usr/bin/env node
// W7 Skills-page screenshots + overlap measurements over the Vite dev preview.
//
// The owner reported overlapping install buttons on the Skills page. W1 checked with
// no folder open — so no cards were rendered. This driver opens a scratch folder
// (so the Registry lists the curated skills) AND pre-installs two skills (so the
// Installed tab renders cards), then for each window size and BOTH tabs it:
//   * screenshots into picture/overhaul/w7/,
//   * records document.scrollWidth vs clientWidth (horizontal overflow),
//   * measures per-card bounding rects and asserts the action button, the name
//     label and the version/tag text do NOT intersect — the owner's overlap, proven
//     by measurement rather than by eye.
//
//   node scripts/w7-skills-shots.mjs --port 1433 --edge-port 9434
//
// Isolation: a throwaway HOME/USERPROFILE under %TEMP%, SKETCH_FAKE_PROVIDER=1, a
// scratch project root, and a fresh Edge --user-data-dir. It stops the dev server and
// Edge (by the PIDs it launched) when done. Node built-ins only; no dependency added.

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

const vitePort = Number(flag('port', '1433'))
const edgePort = Number(flag('edge-port', '9434'))
const shotDir = resolve(flag('shot-dir', join(here, '..', '..', '..', 'picture', 'overhaul', 'w7')))
mkdirSync(shotDir, { recursive: true })

const EDGE = process.env.EDGE_EXE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CLI = join(here, '..', '..', 'core', 'dist', 'cli.js')
const sizes = [
  { w: 1920, h: 1080 },
  { w: 1600, h: 900 },
  { w: 1366, h: 768 },
  { w: 1280, h: 720 },
  { w: 1024, h: 640 },
  { w: 900, h: 600 }, // the app's tauri.conf.json minWidth/minHeight
]

const home = mkdtempSync(join(tmpdir(), 'sketch-w7-home-'))
const projectRoot = mkdtempSync(join(tmpdir(), 'sketch-w7-proj-'))
const edgeProfile = mkdtempSync(join(tmpdir(), 'sketch-w7-edge-'))
const env = { ...process.env, HOME: home, USERPROFILE: home, SKETCH_FAKE_PROVIDER: '1' }

const windows = process.platform === 'win32'
let vite, edge
function killPid(pid) {
  if (pid === undefined) return
  if (windows) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
  else { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
}

// ── pre-install two skills into the scratch project, over the real engine RPC ──
// So the Installed tab renders cards (and with a long name, to stress the layout).
function engineInstall(names) {
  return new Promise((resolve_, reject) => {
    const child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let buf = ''
    const want = new Set(names.map((n, i) => `inst-${i}`))
    const done = []
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (line.trim() === '') continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (typeof frame.ok === 'boolean' && want.has(frame.id)) {
          done.push(frame)
          want.delete(frame.id)
          if (want.size === 0) { child.stdin.end(); child.kill() }
        }
      }
    })
    child.on('close', () => resolve_(done))
    child.on('error', reject)
    names.forEach((name, i) => {
      child.stdin.write(`${JSON.stringify({ id: `inst-${i}`, method: 'skill-install', params: { root: projectRoot, name, home } })}\n`)
    })
  })
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

const results = []
const overlaps = []
let failure = null
try {
  // 0) Pre-install two curated skills into the scratch project.
  const installed = await engineInstall(['context-packing', 'scope-discipline'])
  const okCount = installed.filter((f) => f.result && f.result.ok).length
  console.log(`pre-installed ${okCount}/2 skills into the scratch project`)

  // 1) Vite dev server (vite is hoisted to repo-root node_modules).
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

  // Let the first boot settle, then seed an opened folder into localStorage
  // (STORAGE_KEY = 'sketch.ui.v1') and reload so the app boots WITH the folder.
  const rootForJs = projectRoot.replace(/\\/g, '/')
  await sleep(1800)
  await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { try { const k='sketch.ui.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}'); s.projectRoot=${JSON.stringify(rootForJs)}; localStorage.setItem(k, JSON.stringify(s)); return 'seeded'; } catch(e){ return 'seed-failed:'+e.message; } })()`,
  })
  await send('Page.reload')
  await sleep(2800)

  // Confirm the folder seeded (projectRoot present), then navigate to the Skills
  // view. On the Cowork surface that is agentView 'customize', reached by the
  // "Customize with skills" footer link on the chat, or the sidebar Skills item.
  const seededCheck = await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{try{return JSON.parse(localStorage.getItem('sketch.ui.v1')||'{}').projectRoot||'none'}catch(e){return 'err'}})()` })
  console.log('seeded projectRoot:', seededCheck.result.value)
  const nav = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const byText = (re) => [...document.querySelectorAll('button,[role=button],[role=menuitem],a')].find(x=>re.test((x.textContent||'').trim()));
      let b = byText(/customize with skills/i) || byText(/^Skills$/i) || byText(/Extensions & Skills/i) || byText(/skill/i);
      if (b) { b.click(); return 'clicked:'+(b.textContent||'').trim().slice(0,30); }
      return 'no-skills-nav';
    })()`,
  })
  console.log('skills nav:', nav.result.value)
  // Wait until the catalog has rendered cards (the panel fetches over RPC).
  {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const r = await send('Runtime.evaluate', { returnByValue: true, expression: `document.querySelectorAll('[data-skill],[data-installed]').length` })
      if ((r.result.value || 0) > 0) break
      await sleep(500)
    }
  }
  await sleep(800)
  const diag = await send('Runtime.evaluate', { returnByValue: true, expression: `({ cards: document.querySelectorAll('[data-skill],[data-installed]').length, bodyHasNoFolder: /No folder opened/.test(document.body.innerText), bodyHasNoEngine: /No engine behind/.test(document.body.innerText) })` })
  console.log('skills panel diag:', JSON.stringify(diag.result.value))

  // The overlap measurement, run in-page for a given tab. Returns per-card rect
  // intersections between the action button, the name label, and the version/tag.
  const MEASURE = (tabLabel) => `(() => {
    const tab = [...document.querySelectorAll('[role=tab]')].find(t=>/${tabLabel}/i.test(t.textContent));
    if (tab) tab.click();
    return new Promise((resolve) => setTimeout(() => {
      const intersects = (a,b) => !(a.right<=b.left || b.right<=a.left || a.bottom<=b.top || b.bottom<=a.top);
      const cards = [...document.querySelectorAll('[data-skill],[data-installed]')];
      const report = [];
      for (const card of cards) {
        const name = card.querySelector('[class*=name]');
        const btn = card.querySelector('button');
        const ver = card.querySelector('[class*=version],[class*=installedTag]');
        const rects = {};
        if (name) rects.name = name.getBoundingClientRect();
        if (btn) rects.btn = btn.getBoundingClientRect();
        if (ver) rects.ver = ver.getBoundingClientRect();
        const pairs = [];
        if (rects.name && rects.btn) pairs.push(['name-btn', intersects(rects.name, rects.btn)]);
        if (rects.ver && rects.btn) pairs.push(['ver-btn', intersects(rects.ver, rects.btn)]);
        if (rects.name && rects.ver) pairs.push(['name-ver', intersects(rects.name, rects.ver)]);
        report.push({ id: card.getAttribute('data-skill')||card.getAttribute('data-installed'), overflowX: card.scrollWidth>card.clientWidth, pairs });
      }
      resolve({ cards: cards.length, report });
    }, 700));
  })()`

  for (const size of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    for (const tab of ['Registry', 'Installed']) {
      const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: MEASURE(tab) })
      const measured = r.result.value
      await sleep(300)
      const metrics = await send('Runtime.evaluate', { returnByValue: true, expression: `({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })` })
      const m = metrics.result.value
      const docOverflow = m.scrollWidth > m.clientWidth
      let anyIntersect = false
      let anyCardOverflow = false
      for (const card of measured.report) {
        if (card.overflowX) anyCardOverflow = true
        for (const [, hit] of card.pairs) if (hit) anyIntersect = true
      }
      results.push({ size: `${size.w}x${size.h}`, tab, cards: measured.cards, scrollWidth: m.scrollWidth, clientWidth: m.clientWidth, docOverflow, anyIntersect, anyCardOverflow })
      if (anyIntersect) overlaps.push({ size: `${size.w}x${size.h}`, tab, detail: measured.report.filter((c) => c.pairs.some(([, h]) => h)) })
      const name = `after-${tab.toLowerCase()}-${size.w}x${size.h}.png`
      const shot = isAbsolute(name) ? name : join(shotDir, name)
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(shot, Buffer.from(data, 'base64'))
      console.log(`shot ${name}  cards=${measured.cards} docOverflow=${docOverflow} intersect=${anyIntersect} cardOverflowX=${anyCardOverflow}`)
    }
  }
  ws.close()
  writeFileSync(join(shotDir, 'after-overlap.json'), JSON.stringify({ projectRoot, results, overlaps }, null, 2))
} catch (err) {
  failure = err instanceof Error ? err.message : String(err)
} finally {
  killPid(edge && edge.pid)
  killPid(vite && vite.pid)
  await sleep(1200)
  for (const d of [home, projectRoot, edgeProfile]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }) } catch { /* */ } }
}

if (failure) { console.error(`w7-skills-shots: FAIL — ${failure}`); process.exit(1) }
console.log('w7-skills-shots: done.')
console.table(results)
if (overlaps.length > 0) { console.error(`OVERLAP DETECTED in ${overlaps.length} size/tab combos`); process.exit(2) }
console.log('No element overlaps at any size on either tab.')
