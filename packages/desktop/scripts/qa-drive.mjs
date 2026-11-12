#!/usr/bin/env node
// Drive a QA build of the desktop app over the Chrome DevTools Protocol, so a
// later overhaul item can reproduce a UI bug in the REAL runtime (the Tauri plugin
// init, the engine sidecar, the WebView2 webview) that vitest/jsdom cannot boot.
//
//   npm run qa:drive -w @sketch/desktop -- --exe <qa-exe> --port 9333 \
//       --shot 00-before.png --seconds 20
//
// WHY A SEPARATE SCRIPT FROM smoke-boot.mjs. smoke-boot only checks the app stays
// up; this one ATTACHES to it and reads/screenshots the webview. It follows the
// same conventions: a throwaway HOME/USERPROFILE under the OS temp dir, a fresh
// WebView2 profile, and it stops the app (and its children) when done, so it never
// reads or writes the real ~/.sketch and leaves nothing running.
//
// WHY THE DEBUGGING PORT IS NOT SET HERE. On this host the packaged exe ignores
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (W1 notes), so --remote-debugging-port must
// be baked into the QA build's window `additionalBrowserArgs` at build time (see
// the W2 fix doc's recipe). This script only CONNECTS to the port the QA build
// already opened; it never launches the production-identifier exe.
//
// It uses only Node's built-in WebSocket (Node >= 22) and fetch — no dependency is
// added (Requirement: never add a dependency).

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
const has = (name) => args.includes(`--${name}`)

const windows = process.platform === 'win32'
const exe = resolve(flag('exe', join(here, '..', 'src-tauri', 'target', 'debug', windows ? 'sketch-desktop.exe' : 'sketch-desktop')))
const port = Number(flag('port', '9333'))
const seconds = Number(flag('seconds', '25'))
const shotArg = flag('shot', 'qa-shot.png')
const shotDir = resolve(flag('shot-dir', join(here, '..', '..', '..', 'picture', 'overhaul', 'w2')))
const shotPath = isAbsolute(shotArg) ? shotArg : join(shotDir, shotArg)
// Optional: a project root to seed so the webview's localStorage opens a folder.
const seedRoot = flag('seed-root', null)

mkdirSync(shotDir, { recursive: true })

const home = mkdtempSync(join(tmpdir(), 'sketch-qa-home-'))
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_CACHE_HOME: join(home, '.cache'),
  WEBVIEW2_USER_DATA_FOLDER: join(home, 'webview'),
  SKETCH_FAKE_PROVIDER: '1',
  RUST_BACKTRACE: '1',
}

console.log(`qa:drive: launching ${exe}`)
console.log(`qa:drive: throwaway home ${home}, CDP port ${port}, shot ${shotPath}`)

const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows })
let out = ''
const keep = (c) => { out = (out + c.toString()).slice(-20_000) }
child.stdout.on('data', keep)
child.stderr.on('data', keep)

function stop() {
  if (child.exitCode !== null && child.exitCode !== undefined) return
  if (child.pid === undefined) return
  if (windows) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
}

/** Poll the DevTools endpoint until a page target appears (or give up). */
async function waitForTarget(deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) {
        const targets = await res.json()
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) return page
      }
    } catch {
      // not up yet
    }
    await sleep(500)
  }
  return null
}

/** A tiny CDP client over one WebSocket: send a method, await its id. */
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
  return (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

let failure = null
try {
  const target = await waitForTarget(Date.now() + seconds * 1000)
  if (!target) {
    failure = `no CDP page target on port ${port} within ${seconds}s (is the debug port baked into the QA build's additionalBrowserArgs?)`
  } else {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
    const send = cdp(ws)
    await send('Page.enable')
    await send('Runtime.enable')

    // Optionally seed an opened folder into localStorage, then reload, so the
    // webview comes up with a project root without a native folder picker.
    if (seedRoot) {
      const root = seedRoot.replace(/\\/g, '/')
      await send('Runtime.evaluate', {
        expression: `(() => { try { const k='sketch.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}'); s.projectRoot=${JSON.stringify(root)}; localStorage.setItem(k, JSON.stringify(s)); return 'seeded'; } catch(e){ return 'seed-failed:'+e.message; } })()`,
      })
      await send('Page.reload')
      await sleep(2500)
    }

    // Let the shell settle, then screenshot.
    await sleep(1500)
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(shotPath, Buffer.from(data, 'base64'))
    console.log(`qa:drive: wrote ${shotPath}`)

    // Report the title and whether the connect wizard / an editor notice is showing,
    // so the caller has text evidence alongside the screenshot.
    const probe = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `({ title: document.title, text: (document.body.innerText||'').slice(0, 4000) })`,
    })
    console.log('qa:drive: PAGE PROBE', JSON.stringify(probe.result.value).slice(0, 2000))
    ws.close()
  }
} catch (err) {
  failure = `driving the app failed: ${err instanceof Error ? err.message : String(err)}`
}

stop()
await sleep(1500)
try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }) } catch { /* webview may hold a file briefly */ }

if (failure) {
  console.error(`qa:drive: FAIL — ${failure}`)
  if (out.trim() !== '') console.error(`--- last app output ---\n${out.trim().split(/\r?\n/).slice(-30).join('\n')}`)
  process.exit(1)
}
console.log('qa:drive: done; app stopped.')
