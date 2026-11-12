#!/usr/bin/env node
// Boot smoke test: start the BUILT desktop app and fail if it does not stay up.
//
//   npm run smoke:boot -w @sketch/desktop                  # the release build
//   npm run smoke:boot -w @sketch/desktop -- --exe <path> --seconds 20
//
// Why it exists. Every unit test can pass while the real app cannot start: on
// 2026-10-09 an unknown `scope` key under `plugins.shell` in tauri.conf.json made
// Tauri panic at startup ("unknown field `scope`, expected `open`"), and nothing but
// launching the app could see it. This launches it the way a user does — the real
// Rust runtime, its plugins, the webview and the engine sidecar — waits, and reports.
//
// PASS: the process is still running after `--seconds` (default 15), and it printed no
//       Rust panic. FAIL: it exited early (its exit code and last output are printed),
//       or it panicked. Either way the app is then stopped, with its child processes.
//
// It runs against a throwaway home folder and webview profile, so it never reads or
// writes the real ~/.sketch, and it starts no project, no model and no network call of
// its own. On Linux it needs a display; CI runs it under `xvfb-run`.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const windows = process.platform === 'win32'
const exe = resolve(option('exe', join(here, '..', 'src-tauri', 'target', 'release', windows ? 'sketch-desktop.exe' : 'sketch-desktop')))
const seconds = Number(option('seconds', '15'))
if (!existsSync(exe)) {
  console.error(`smoke:boot: no app at ${exe}. Build it first (npm run package:<platform>), or pass --exe.`)
  process.exit(2)
}
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error('smoke:boot: --seconds must be a positive number')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'sketch-smoke-home-'))
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_CACHE_HOME: join(home, '.cache'),
  WEBVIEW2_USER_DATA_FOLDER: join(home, 'webview'),
  RUST_BACKTRACE: '1',
}

console.log(`smoke:boot: starting ${exe} for ${seconds}s (throwaway home ${home})`)
const started = Date.now()
const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows })
let output = ''
const keep = (chunk) => {
  output = (output + chunk.toString()).slice(-20_000)
}
child.stdout.on('data', keep)
child.stderr.on('data', keep)

const exited = new Promise((resolveExit) => {
  child.on('exit', (code, signal) => resolveExit({ code, signal }))
  child.on('error', (error) => resolveExit({ code: null, signal: null, error }))
})
const timeout = new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), seconds * 1000))
const early = await Promise.race([exited, timeout])

function stop() {
  if (child.exitCode !== null || child.pid === undefined) return
  if (windows) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

const panicked = /panicked at|thread '.*' panicked|PluginInitialization/.test(output)
let failure = null
if (early !== null) {
  const ran = ((Date.now() - started) / 1000).toFixed(1)
  failure = early.error
    ? `could not start: ${early.error.message}`
    : `exited after ${ran}s (code ${early.code}${early.signal ? `, signal ${early.signal}` : ''})`
} else if (panicked) {
  failure = 'is running, but printed a Rust panic'
}

stop()
await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
try {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 })
} catch {
  // A webview process can hold a file for a moment after it exits; the folder is temporary.
}

if (failure !== null) {
  console.error(`smoke:boot: FAIL — the app ${failure}.`)
  if (output.trim() !== '') console.error(`--- last output ---\n${output.trim().split(/\r?\n/).slice(-40).join('\n')}`)
  process.exit(1)
}
console.log(`smoke:boot: PASS — still running after ${seconds}s, no panic. Stopped it again.`)
