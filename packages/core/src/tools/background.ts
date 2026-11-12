// Background processes for the agent: dev servers, watchers, anything that does not exit.
//
// ── THE COMPLAINT THIS ANSWERS ──────────────────────────────────────────────
//
// "When the agent starts a long-running server (npm run dev, Django runserver…), it
// blocks indefinitely and waits for the server to terminate" — openai/codex#6083, and
// the same story in every agent IDE's forum. A server never exits, so a run that
// starts one either hangs or, here, waited out its two-minute timeout and was killed —
// and the agent could not check its own work in a browser-shaped way at all.
//
// So `run_command` takes `background: true`: the program starts, the call returns as
// soon as it prints that it is ready (a local URL, "ready", "listening") or a short
// wait passes, and the agent gets an id. `process_output` reads what it printed since,
// `stop_process` ends it — the program and everything it started.
//
// ── NOTHING IS LEFT BEHIND ──────────────────────────────────────────────────
//
// Every process started here is stopped when the run ends (the run handler calls
// `stopAll` in its `finally`), and when the engine exits. A run cannot leave a server
// holding a port after it has finished.

import { spawn, type ChildProcess } from 'node:child_process'

import { resolveForSpawn } from '../verify/spawnTarget.js'
import { killTree } from './terminal.js'

/** Characters of output kept per process; the newest win. */
export const BACKGROUND_OUTPUT_CHARS = 200_000
/** Processes one run may have running at once. */
export const MAX_BACKGROUND_PROCESSES = 6
/** How long `start` waits for a sign of readiness by default, and at most. */
export const BACKGROUND_WAIT_MS = 15_000
export const BACKGROUND_MAX_WAIT_MS = 60_000

/** "It is up": a local URL, or the words dev servers and watchers print when ready. */
export const READY_PATTERN =
  /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?)|\b(ready in|ready|listening on|listening at|server running|started server|compiled successfully|watching for (?:file )?changes|running on)\b/i

/** A local address a server prints, e.g. http://localhost:5173. */
export const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?/i

export interface BackgroundStart {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** The command as the user is shown it. */
  display: string
  waitMs?: number
}

export type BackgroundStartResult =
  | { state: 'running'; id: string; output: string; ready: boolean; url: string | null; waitedMs: number }
  | { state: 'exited'; id: string; output: string; exitCode: number | null; waitedMs: number }

export interface BackgroundRead {
  id: string
  display: string
  running: boolean
  exitCode: number | null
  /** Output printed since the previous read (or since the start, the first time). */
  output: string
  truncated: boolean
  uptimeMs: number
}

interface Proc {
  id: string
  display: string
  child: ChildProcess
  output: string
  /** Total characters ever printed; `read` remembers where it got to. */
  printed: number
  readTo: number
  running: boolean
  exitCode: number | null
  startedAt: number
  error: string | null
  exited: Promise<void>
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g

function clean(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n')
}

/** The background processes of one run. */
export class BackgroundProcesses {
  #procs = new Map<string, Proc>()
  #counter = 0
  readonly #now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
  }

  running(): number {
    let n = 0
    for (const proc of this.#procs.values()) if (proc.running) n += 1
    return n
  }

  has(id: string): boolean {
    return this.#procs.has(id)
  }

  async start(request: BackgroundStart): Promise<BackgroundStartResult> {
    if (this.running() >= MAX_BACKGROUND_PROCESSES) {
      throw new Error(`${MAX_BACKGROUND_PROCESSES} background processes are already running; stop one with stop_process first.`)
    }
    const [program, ...args] = request.argv
    if (program === undefined) throw new Error('"command" is empty')
    const target = resolveForSpawn(program, args, request.env)
    this.#counter += 1
    const id = `bg-${this.#counter}`
    const child = spawn(target.cmd, target.args, {
      cwd: request.cwd,
      env: request.env,
      // A server must not wait for keyboard input it will never get.
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // POSIX: its own process group, so stopping it stops its workers too.
      detached: process.platform !== 'win32',
    })
    let markExited: () => void = () => {}
    const proc: Proc = {
      id,
      display: request.display,
      child,
      output: '',
      printed: 0,
      readTo: 0,
      running: true,
      exitCode: null,
      startedAt: this.#now(),
      error: null,
      exited: new Promise<void>((resolve) => {
        markExited = resolve
      }),
    }
    this.#procs.set(id, proc)

    let notifyOutput: () => void = () => {}
    const append = (text: string) => {
      const chunk = clean(text)
      proc.output = (proc.output + chunk).slice(-BACKGROUND_OUTPUT_CHARS)
      proc.printed += chunk.length
      notifyOutput()
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8')
      stream?.on('data', append)
      stream?.on('error', () => {})
    }
    child.on('error', (err) => {
      proc.error = err.message
      append(`\n[could not start: ${err.message}]\n`)
      proc.running = false
      markExited()
    })
    child.on('close', (code) => {
      proc.running = false
      proc.exitCode = code
      markExited()
    })

    const wait = Math.max(0, Math.min(BACKGROUND_MAX_WAIT_MS, request.waitMs ?? BACKGROUND_WAIT_MS))
    const began = this.#now()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait)
      timer.unref?.()
      notifyOutput = () => {
        if (READY_PATTERN.test(proc.output)) {
          clearTimeout(timer)
          // A moment more, so the lines after the URL (the network address, a warning)
          // come with it.
          setTimeout(resolve, 300).unref?.()
          notifyOutput = () => {}
        }
      }
      void proc.exited.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    const waitedMs = this.#now() - began
    proc.readTo = proc.printed
    if (!proc.running) {
      return { state: 'exited', id, output: proc.output, exitCode: proc.exitCode, waitedMs }
    }
    // The URL wherever it is: Vite prints "ready in 120 ms" a line before its URL.
    const url = LOCAL_URL.exec(proc.output)?.[0] ?? null
    return { state: 'running', id, output: proc.output, ready: READY_PATTERN.test(proc.output), url, waitedMs }
  }

  /**
   * Wait up to `ms` for `id` to print something new or exit — so a model waiting for a
   * rebuild makes one call instead of polling, which the loop breaker would stop.
   */
  async waitForOutput(id: string, ms: number): Promise<void> {
    const proc = this.#lookup(id)
    const deadline = Math.max(0, Math.min(BACKGROUND_MAX_WAIT_MS, ms))
    if (deadline === 0 || !proc.running || proc.printed > proc.readTo) return
    await new Promise<void>((resolve) => {
      const started = proc.printed
      const timer = setTimeout(done, deadline)
      timer.unref?.()
      const tick = setInterval(() => {
        if (proc.printed > started || !proc.running) done()
      }, 100)
      tick.unref?.()
      function done(): void {
        clearTimeout(timer)
        clearInterval(tick)
        resolve()
      }
      void proc.exited.then(done)
    })
  }

  /** What `id` printed since the last read, and whether it is still running. */
  read(id: string): BackgroundRead {
    const proc = this.#lookup(id)
    const unread = proc.printed - proc.readTo
    const available = Math.min(unread, proc.output.length)
    const output = available > 0 ? proc.output.slice(proc.output.length - available) : ''
    proc.readTo = proc.printed
    return {
      id,
      display: proc.display,
      running: proc.running,
      exitCode: proc.exitCode,
      output,
      truncated: unread > available,
      uptimeMs: this.#now() - proc.startedAt,
    }
  }

  /** Stop `id` and everything it started. Resolves once it has exited (or 5 s pass). */
  async stop(id: string): Promise<{ stopped: boolean; exitCode: number | null }> {
    const proc = this.#lookup(id)
    if (!proc.running) return { stopped: false, exitCode: proc.exitCode }
    killTree(proc.child, false)
    const hard = setTimeout(() => killTree(proc.child, true), 1_500)
    hard.unref?.()
    await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())])
    clearTimeout(hard)
    return { stopped: true, exitCode: proc.exitCode }
  }

  /** Stop everything this run started. For the end of the run. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#procs.values()].filter((p) => p.running).map((p) => this.stop(p.id)))
  }

  #lookup(id: string): Proc {
    const proc = this.#procs.get(id)
    if (proc === undefined) throw new Error(`No background process ${id} in this run.`)
    return proc
  }
}
