#!/usr/bin/env node
// W6 Chat-panel screenshots + overflow measurements over the Vite dev preview.
//
// The packaged app cannot be driven over CDP on this host (WebView2 156 opens no
// DevTools listener — fix-workspace-paths.md §6.4), so the drivable surface is the Vite
// dev preview over headless Edge, the same React source and the same in-process engine.
//
// It seeds an opened folder, drives one deterministic run with the engine's fake provider
// (SKETCH_FAKE_PROVIDER=1) by typing a message and pressing Enter, waits for the reply,
// then for every window size AND both surfaces (Cowork chat, Code chat sidebar) it:
//   * screenshots into picture/overhaul/w6/,
//   * records document.scrollWidth vs clientWidth (horizontal overflow),
//   * measures every chat bubble / code block / composer rect for horizontal overflow
//     (scrollWidth > clientWidth) and for any pair of sibling bubbles that overlap.
//
//   node scripts/w6-chat-shots.mjs --port 1436 --edge-port 9436
//
// Isolation: throwaway HOME/USERPROFILE under %TEMP%, SKETCH_FAKE_PROVIDER=1, a scratch
// project root, and a fresh Edge --user-data-dir. It stops the dev server and Edge (by the
// PIDs it launched) when done. Node built-ins only; no dependency added.

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

const vitePort = Number(process.env.W6_VITE_PORT || flag('port', '1436'))
const edgePort = Number(process.env.W6_EDGE_PORT || flag('edge-port', '9436'))
const measureOnly = args.includes('--measure-only') || process.env.W6_MEASURE_ONLY === '1'
const shotDir = resolve(flag('shot-dir', join(here, '..', '..', '..', 'picture', 'overhaul', 'w6')))
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

const home = mkdtempSync(join(tmpdir(), 'sketch-w6-home-'))
const projectRoot = mkdtempSync(join(tmpdir(), 'sketch-w6-proj-'))
const edgeProfile = mkdtempSync(join(tmpdir(), 'sketch-w6-edge-'))
const env = { ...process.env, HOME: home, USERPROFILE: home, SKETCH_FAKE_PROVIDER: '1' }

// A configured provider so the first-run "Connect a model" wizard does NOT auto-open
// (W3/W4 saw it cover the shell otherwise). The fake adapter answers regardless, since
// SKETCH_FAKE_PROVIDER=1; this entry only stops the onboarding modal.
mkdirSync(join(home, '.sketch'), { recursive: true })
writeFileSync(
  join(home, '.sketch', 'providers.json'),
  JSON.stringify({ version: 1, selected: 'fake', providers: [{ id: 'fake', label: 'Offline test', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' }] }),
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

  // Seed an opened folder into localStorage (STORAGE_KEY = 'sketch.ui.v1') and reload.
  const rootForJs = projectRoot.replace(/\\/g, '/')
  await sleep(1800)
  await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { try { const k='sketch.ui.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}'); s.projectRoot=${JSON.stringify(rootForJs)}; s.selectedProvider='fake'; s.selectedModel='fake-model'; localStorage.setItem(k, JSON.stringify(s)); return 'seeded'; } catch(e){ return 'seed-failed:'+e.message; } })()`,
  })
  await send('Page.reload')
  await sleep(2800)
  // If the onboarding modal still shows, close it so it does not sit over the chat.
  await send('Runtime.evaluate', { returnByValue: true, expression: `(() => { const x=[...document.querySelectorAll('[role=dialog] button,[aria-label="Close"],button')].find(b=>/close|×|✕/i.test((b.getAttribute('aria-label')||b.textContent||''))); if (x) { x.click(); return 'closed'; } return 'no-modal'; })()` })
  await sleep(500)

  // 3) Drive one run: type a message that asks for markdown + a code block, press Enter,
  // and wait for the reply to render (the fake provider answers deterministically).
  const typeAndSend = `(() => {
    const box = document.querySelector('textarea[aria-label="Message the agent"]');
    if (!box) return 'no-composer';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, 'Show me a heading, a list, a table and a fenced code block with a very-long-single-line-that-should-scroll-inside-the-block-not-widen-the-panel');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`
  const sent = await send('Runtime.evaluate', { returnByValue: true, expression: typeAndSend })
  console.log('compose:', sent.result.value)
  // Wait for an assistant reply bubble (the run to finish).
  {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const r = await send('Runtime.evaluate', { returnByValue: true, expression: `document.querySelectorAll('[class*="assistantBubble"],[class*="assistantRow"]').length` })
      if ((r.result.value || 0) > 0) break
      await sleep(500)
    }
  }
  await sleep(1200)

  // In-page overflow + overlap measurement for whichever surface is visible.
  const MEASURE = (surface) => `(() => {
    // Both chat surfaces (Cowork main + Code sidebar) are mounted at once; the inactive one
    // is laid out off-screen. Scope the measurement to the ACTIVE surface's own root so the
    // hidden surface's bubbles are never compared against the shown ones. Cowork's root is
    // the chat container; Code's is the sidebar. Pick the one actually within the viewport.
    const cw = document.documentElement.clientWidth;
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= -2 && r.right <= cw + 2; };
    const rootSel = ${JSON.stringify(surface)} === 'Code' ? '[class*="sidebar"]' : '[class*="container"],[class*="welcomeContainer"]';
    const roots = [...document.querySelectorAll(rootSel)].filter(inView);
    const root = roots[0] || document.body;
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const bubbles = [...root.querySelectorAll('[class*="messageBubble"],[class*="codeBlock"],[class*="promptInput"]')].filter(vis);
    let anyOverflow = false;
    for (const b of bubbles) if (b.scrollWidth > b.clientWidth + 1) anyOverflow = true;
    // A REAL overlap is two bubbles overlapping by a meaningful area in BOTH axes. A naive
    // intersection test false-flags a user (right-aligned) and assistant (left-aligned)
    // bubble that merely share a vertical band without touching, so require a > 4px overlap
    // on each axis to count.
    // Overlap is measured between MESSAGE BUBBLES only. The composer is a sticky layer
    // that deliberately overlays the scrollback behind a gradient fade, so it is excluded
    // (its own rect over a bubble is by design, not a layout defect). A code block nested
    // in a bubble is skipped (it always "intersects" its container).
    const msgBubbles = bubbles.filter((b) => /messageBubble/.test(b.className));
    const TOL = 4;
    let anyOverlap = false;
    const hits = [];
    for (let i = 0; i < msgBubbles.length; i++) for (let j = i + 1; j < msgBubbles.length; j++) {
      if (msgBubbles[i].contains(msgBubbles[j]) || msgBubbles[j].contains(msgBubbles[i])) continue;
      const a = msgBubbles[i].getBoundingClientRect(), c = msgBubbles[j].getBoundingClientRect();
      const ox = Math.min(a.right, c.right) - Math.max(a.left, c.left);
      const oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      if (ox > TOL && oy > TOL) { anyOverlap = true; hits.push([i, j, Math.round(ox), Math.round(oy)]); }
    }
    const detail = msgBubbles.map((b) => { const r = b.getBoundingClientRect(); return { cls: b.className.replace(/[A-Za-z0-9_]*module__/g,'').slice(0,40), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), text: (b.textContent||'').trim().slice(0,24) }; });
    return { bubbles: bubbles.length, msgBubbles: msgBubbles.length, anyBubbleOverflowX: anyOverflow, anyBubbleOverlap: anyOverlap, hits, detail,
             scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  })()`

  // Click the Cowork / Code pill in the title bar. Returns which surface is now shown.
  const SWITCH = (label) => `(() => {
    const pill = [...document.querySelectorAll('button,[role=button],[role=tab]')].find(x=>new RegExp('^${label}$','i').test((x.textContent||'').trim()));
    if (pill) { pill.click(); return 'clicked:${label}'; }
    return 'no-pill:${label}';
  })()`

  for (const surface of ['Cowork', 'Code']) {
    const sw = await send('Runtime.evaluate', { returnByValue: true, expression: SWITCH(surface) })
    await sleep(700)
    for (const size of sizes) {
      await send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false })
      await sleep(350)
      const r = await send('Runtime.evaluate', { returnByValue: true, expression: MEASURE(surface) })
      const m = r.result.value
      const docOverflow = m.scrollWidth > m.clientWidth
      results.push({ surface, size: `${size.w}x${size.h}`, bubbles: m.bubbles, scrollWidth: m.scrollWidth, clientWidth: m.clientWidth, docOverflow, bubbleOverflowX: m.anyBubbleOverflowX, bubbleOverlap: m.anyBubbleOverlap })
      const name = `after-${surface.toLowerCase()}-${size.w}x${size.h}.png`
      if (!measureOnly) {
        const shot = isAbsolute(name) ? name : join(shotDir, name)
        // Headless Edge occasionally stalls the first capture after a metrics change on a
        // memory-tight host; one retry after a short pause clears it.
        let shotData = null
        for (let attempt = 0; attempt < 2 && shotData === null; attempt++) {
          try { shotData = (await send('Page.captureScreenshot', { format: 'png' })).data }
          catch (e) { if (attempt === 1) throw e; await sleep(800) }
        }
        writeFileSync(shot, Buffer.from(shotData, 'base64'))
      }
      console.log(`${measureOnly ? 'measure' : 'shot'} ${name}  switch=${sw.result.value} bubbles=${m.bubbles} msg=${m.msgBubbles} docOverflow=${docOverflow} bubbleOverflowX=${m.anyBubbleOverflowX} overlap=${m.anyBubbleOverlap} hits=${JSON.stringify(m.hits)}`)
      if (m.anyBubbleOverlap && measureOnly) console.log('   detail:', JSON.stringify(m.detail))
    }
  }
  ws.close()
  writeFileSync(join(shotDir, 'after-overflow.json'), JSON.stringify({ projectRoot, results }, null, 2))
} catch (err) {
  failure = err instanceof Error ? err.message : String(err)
} finally {
  killPid(edge && edge.pid)
  killPid(vite && vite.pid)
  await sleep(1200)
  for (const d of [home, projectRoot, edgeProfile]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }) } catch { /* */ } }
}

if (failure) { console.error(`w6-chat-shots: FAIL — ${failure}`); process.exit(1) }
console.log('w6-chat-shots: done.')
console.table(results)
const bad = results.filter((r) => r.docOverflow || r.bubbleOverflowX || r.bubbleOverlap)
if (bad.length > 0) { console.error(`OVERFLOW/OVERLAP in ${bad.length} size/surface combos`); process.exit(2) }
console.log('No horizontal overflow and no overlap at any size on either surface.')
