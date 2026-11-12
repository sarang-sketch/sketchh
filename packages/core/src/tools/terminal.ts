// The integrated terminal's process host.
//
// ── WHY THE TERMINAL RUNS HERE AND NOT IN RUST ──────────────────────────────
//
// The terminal used to call the Tauri command `run_command`, which runs
// `std::process::Command::output()` — a blocking call — inside a synchronous
// `#[tauri::command]`. Tauri runs synchronous commands on the MAIN thread, so the whole
// window stopped responding for as long as the program ran: `npm install` froze the app
// for a minute, and `npm run dev`, which never exits, froze it for good. `.output()` also
// buffers everything until exit, so nothing appeared while a command ran, and there was
// no way to stop one.
//
// The engine is a long-lived Node process that already spawns the project's
// verification commands, so the terminal's processes live here: started asynchronously,
// streamed as they print, stoppable, answerable on stdin, and reachable from both
// transports (the packaged sidecar and the browser dev bridge) through the one method
// table.
//
// ── WHAT A COMMAND LINE IS ──────────────────────────────────────────────────
//
// A real shell — Windows PowerShell on Windows, the user's $SHELL elsewhere — one
// process per line, which is how an IDE terminal is used: pipes, `&&`, globbing,
// `npm run dev`. `cd` is the one builtin handled here, because a per-line process cannot
// change the directory of the next one: the terminal keeps the directory, and it stays
// inside the open project.
//
// THE ENGINE'S NO-SHELL RULE STILL HOLDS. Every spawn in this package passes
// `shell: false` with an argument vector, and this one does too: the shell is the
// PROGRAM, started directly, and the line reaches it as one argument (PowerShell's
// `-EncodedCommand`, `bash -c`). The rule exists so that text a MODEL wrote is never
// re-parsed by a shell; here the line is what the PERSON typed into their terminal,
// and the agent's own command tool (tools/command.ts) stays shell-less and gated.
//
// ── WHAT DID NOT CHANGE ─────────────────────────────────────────────────────
//
//   * CONSENT. `start` refuses without `confirmed: true`, exactly like the Rust command
//     did. The window asks before the first command in a folder.
//   * CONTAINMENT. The working directory is resolved through its REAL path and must be
//     inside the project root, so a symlink or a junction cannot walk it out.
//   * NOT A SANDBOX. A shell runs arbitrary code by design, as every terminal does.
//
// Output is kept per session in a bounded buffer and read by sequence number, so a
// window that polls late misses nothing still retained, and a runaway program cannot
// grow the engine's memory without bound.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** One piece of output, in arrival order. `seq` is per session and never reused. */
export interface TerminalChunk {
  seq: number
  stream: 'stdout' | 'stderr'
  text: string
}

export interface TerminalStartOptions {
  /** The open project. Must exist and be a directory. */
  root: string
  /** Absolute or project-relative. Defaults to the root. Must stay inside it. */
  cwd?: string
  /** What the user typed. One line. */
  line: string
  /** The user asked for this command. Refused without it. */
  confirmed: boolean
}

export type TerminalStartResult =
  /** A process is running; poll `read(id)` for its output. */
  | { kind: 'run'; id: string; cwd: string; shellName: string }
  /** `cd` changed the terminal's directory. Nothing was spawned. */
  | { kind: 'cd'; cwd: string }

export interface TerminalReadResult {
  id: string
  /** Chunks with `seq >= since`, oldest first. */
  chunks: TerminalChunk[]
  /** Pass this as `since` on the next read. */
  next: number
  running: boolean
  exitCode: number | null
  signal: string | null
  /** Why the program could not start, when it could not. */
  error: string | null
  /** True when output between `since` and the first retained chunk was dropped by the cap. */
  truncated: boolean
  durationMs: number
}

/** A refusal meant for the person at the terminal, in a sentence they can act on. */
export class TerminalRefusal extends Error {
  override readonly name = 'TerminalRefusal'
}

/** How one line is handed to a shell. */
export interface ShellSpec {
  /** Shown to the user: "PowerShell", "bash". */
  name: string
  program: string
  args(line: string): string[]
  /** Windows only: pass `args` without Node's quoting (cmd.exe needs this). */
  verbatim?: boolean
}

/** Characters retained per session before the oldest output is dropped. */
export const MAX_RETAINED_CHARS = 1_000_000
/** Programs running at once, across every terminal tab. */
export const MAX_RUNNING_COMMANDS = 12
/** A finished session stays readable this long, so a late poll still gets its tail. */
export const RETAIN_AFTER_EXIT_MS = 5 * 60_000
/** One stdin write. A paste, not a file. */
export const MAX_INPUT_CHARS = 64_000

/**
 * Split a line at top-level `&&` / `||`, outside quotes. Null when it has neither.
 *
 * Windows PowerShell 5.1 — the PowerShell every Windows machine has — rejects `&&` and
 * `||` as statement separators ("not a valid statement separator in this version"),
 * yet `npm install && npm run dev` is how half the internet writes a command. So the
 * chain is rewritten into the equivalent statements instead of failing.
 */
export function splitChain(line: string): Array<{ op: '&&' | '||' | null; text: string }> | null {
  const parts: Array<{ op: '&&' | '||' | null; text: string }> = []
  let quote: '"' | "'" | null = null
  let current = ''
  let op: '&&' | '||' | null = null
  let found = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quote !== null) {
      current += ch
      // A backtick escapes the next character inside PowerShell's double quotes.
      if (quote === '"' && ch === '`' && i + 1 < line.length) {
        current += line[i + 1]!
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    const pair = line.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      parts.push({ op, text: current.trim() })
      op = pair
      current = ''
      found = true
      i += 1
      continue
    }
    current += ch
  }
  parts.push({ op, text: current.trim() })
  if (!found || parts.some((part) => part.text === '')) return null
  return parts
}

/**
 * PowerShell needs three things set before the user's line runs: UTF-8 on the pipe (the
 * default is the OEM code page, which turns every non-ASCII character into `?`), no
 * progress records (they render as noise outside a console), and a defined exit code —
 * a native program's `$LASTEXITCODE` when it set one, else 1 when the line failed.
 */
export function wrapPowerShell(line: string): string {
  const chain = splitChain(line)
  const body =
    chain === null
      ? [line, '$__sketchOk = $?']
      : chain.map((part, index) => {
          // One statement per line: a `# comment` in the user's text then ends at its
          // own line instead of swallowing the bookkeeping after it.
          const run = ['$global:LASTEXITCODE = 0', part.text, '$__sketchOk = $?'].join('\n')
          if (index === 0) return run
          return part.op === '&&' ? `if ($__sketchOk) {\n${run}\n}` : `if (-not $__sketchOk) {\n${run}\n}`
        })
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    '$global:LASTEXITCODE = 0',
    ...body,
    'if ($global:LASTEXITCODE -ne 0) { exit $global:LASTEXITCODE }',
    'if (-not $__sketchOk) { exit 1 }',
    'exit 0',
  ].join('\n')
}

/** `-EncodedCommand` takes UTF-16LE base64, which sidesteps every quoting rule at once. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** The shell this machine's terminal uses. */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ShellSpec {
  if (platform === 'win32') {
    const systemRoot = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(powershell)) {
      return {
        name: 'PowerShell',
        program: powershell,
        args: (line) => [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          // Process-scoped: lets `npm` resolve to npm.ps1 on machines whose policy is
          // Restricted, which otherwise fails every Node command with a policy error.
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodePowerShell(wrapPowerShell(line)),
        ],
      }
    }
    const cmd = env['ComSpec'] ?? join(systemRoot, 'System32', 'cmd.exe')
    return { name: 'Command Prompt', program: cmd, args: (line) => ['/d', '/s', '/c', `"${line}"`], verbatim: true }
  }
  const configured = env['SHELL']
  const shell =
    configured !== undefined && isAbsolute(configured) && existsSync(configured)
      ? configured
      : existsSync('/bin/bash')
        ? '/bin/bash'
        : '/bin/sh'
  // A login shell reads the profile that puts nvm, pyenv and Homebrew on PATH.
  const login = /(^|\/)(bash|zsh|fish)$/.test(shell)
  return { name: basename(shell), program: shell, args: (line) => [login ? '-lc' : '-c', line] }
}

/**
 * The target of a `cd` line, or `undefined` when the line is not one.
 *
 * `null` is a bare `cd` (back to the project root). A line with shell syntax after the
 * `cd` (`cd src && npm test`) is NOT a builtin: it runs in the shell, where the `cd`
 * applies to that one command, as it would in any terminal.
 */
export function parseCd(line: string): string | null | undefined {
  // `cd..` with no space is how cmd.exe users type it, so it counts too.
  const match = /^\s*(?:cd|chdir|set-location|sl|pushd)(?:\s+([\s\S]*?)|(\.\.[\\/]?))?\s*$/i.exec(line)
  if (match === null) return undefined
  let target = (match[1] ?? match[2] ?? '').trim()
  if (/[;&|<>`]|\$\(|\$\{|\$env:/i.test(target)) return undefined
  target = target.replace(/^\/d\s+/i, '').replace(/^-Path\s+/i, '').trim()
  if (target.length >= 2 && /^(["']).*\1$/.test(target)) target = target.slice(1, -1)
  if (target === '' || target === '~') return null
  return target
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function realDirectory(path: string, label: string): string {
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    throw new TerminalRefusal(`${label} does not exist: ${path}`)
  }
  if (!statSync(real).isDirectory()) throw new TerminalRefusal(`${label} is not a folder: ${path}`)
  return real
}

/** `target` resolved against `base`, by real path, refused unless it is a folder inside `root`. */
export function resolveTerminalDir(root: string, base: string, target: string): string {
  const candidate = resolve(base, target)
  let real: string
  try {
    real = realpathSync.native(candidate)
  } catch {
    throw new TerminalRefusal(`cd: no such folder: ${target}`)
  }
  if (!statSync(real).isDirectory()) throw new TerminalRefusal(`cd: not a folder: ${target}`)
  if (!isInside(root, real)) {
    throw new TerminalRefusal(`cd: ${target} is outside the open project. The terminal stays inside ${root}.`)
  }
  return real
}

interface Session {
  id: string
  child: ChildProcess
  cwd: string
  startedAt: number
  endedAt: number | null
  chunks: TerminalChunk[]
  nextSeq: number
  retained: number
  exitCode: number | null
  signal: string | null
  error: string | null
  stopTimer: ReturnType<typeof setTimeout> | null
}

function noop(): void {}

/** End a process and everything it started. Never throws. */
export function killTree(child: ChildProcess, hard: boolean): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      })
      killer.unref()
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    return
  }
  // The child leads its own process group (spawned detached), so the group goes too:
  // a dev server's watcher and its workers stop with it.
  try {
    process.kill(-pid, hard ? 'SIGKILL' : 'SIGTERM')
  } catch {
    try {
      child.kill(hard ? 'SIGKILL' : 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

export interface TerminalHostOptions {
  /** Override the shell program, for tests. Defaults to {@link defaultShell}. */
  shellSpec?: ShellSpec
  /** Environment for spawned programs. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export class TerminalHost {
  readonly #sessions = new Map<string, Session>()
  readonly #shellSpec: ShellSpec
  readonly #env: NodeJS.ProcessEnv
  readonly #now: () => number
  #counter = 0

  constructor(options: TerminalHostOptions = {}) {
    this.#env = options.env ?? process.env
    this.#shellSpec = options.shellSpec ?? defaultShell(this.#env)
    this.#now = options.now ?? Date.now
  }

  get shellName(): string {
    return this.#shellSpec.name
  }

  /** Programs still running. */
  running(): number {
    let count = 0
    for (const session of this.#sessions.values()) if (session.endedAt === null) count += 1
    return count
  }

  start(options: TerminalStartOptions): TerminalStartResult {
    if (options.confirmed !== true) {
      throw new TerminalRefusal('A terminal command runs only when the user asks for it (confirmed: true).')
    }
    if (typeof options.root !== 'string' || !isAbsolute(options.root)) {
      throw new TerminalRefusal('The project folder must be an absolute path.')
    }
    const root = realDirectory(options.root, 'The project folder')
    let base = root
    if (options.cwd !== undefined && options.cwd !== '') {
      try {
        base = resolveTerminalDir(root, root, options.cwd)
      } catch (err) {
        const reason = err instanceof Error ? err.message.replace(/^cd: /, '') : String(err)
        throw new TerminalRefusal(`The terminal's folder is not usable (${reason}). Type cd to go back to the project root.`)
      }
    }

    const line = options.line.replace(/\r?\n+$/, '')
    if (line.trim() === '') throw new TerminalRefusal('Type a command to run.')
    if (/[\r\n]/.test(line)) throw new TerminalRefusal('Run one line at a time.')

    const cd = parseCd(line)
    if (cd !== undefined) {
      if (cd === null) return { kind: 'cd', cwd: root }
      if (cd === '-') throw new TerminalRefusal('cd -: the previous folder is not tracked here.')
      return { kind: 'cd', cwd: resolveTerminalDir(root, base, cd) }
    }

    if (this.running() >= MAX_RUNNING_COMMANDS) {
      throw new TerminalRefusal(
        `${MAX_RUNNING_COMMANDS} commands are already running. Stop one before starting another.`,
      )
    }

    const env: NodeJS.ProcessEnv = { ...this.#env }
    // Colour and unbuffered output, as a terminal would get. A user who exported
    // NO_COLOR keeps their choice.
    if (env['NO_COLOR'] === undefined) env['FORCE_COLOR'] = env['FORCE_COLOR'] ?? '1'
    env['PYTHONUNBUFFERED'] = '1'
    env['PYTHONIOENCODING'] = env['PYTHONIOENCODING'] ?? 'utf-8'

    this.#counter += 1
    const id = `term-${this.#now().toString(36)}-${this.#counter}`
    const shell = this.#shellSpec
    const child = spawn(shell.program, shell.args(line), {
      cwd: base,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // POSIX: its own process group, so Stop ends the whole tree.
      detached: process.platform !== 'win32',
      ...(shell.verbatim === true ? { windowsVerbatimArguments: true } : {}),
    })

    const session: Session = {
      id,
      child,
      cwd: base,
      startedAt: this.#now(),
      endedAt: null,
      chunks: [],
      nextSeq: 0,
      retained: 0,
      exitCode: null,
      signal: null,
      error: null,
      stopTimer: null,
    }
    this.#sessions.set(id, session)

    // An unhandled 'error' on any stdio stream would crash the engine — EPIPE when a
    // program exits while the user is still typing at it, for instance.
    child.stdin?.on('error', noop)
    for (const stream of ['stdout', 'stderr'] as const) {
      const source = child[stream]
      if (source === null) continue
      source.setEncoding('utf8')
      source.on('error', noop)
      source.on('data', (text: string) => this.#append(session, stream, text))
    }
    child.on('error', (err) => {
      session.error = `could not start ${shell.name}: ${err.message}`
      this.#finish(session, null, null)
    })
    child.on('close', (code, signal) => this.#finish(session, code, signal))

    return { kind: 'run', id, cwd: base, shellName: shell.name }
  }

  read(id: string, since = 0): TerminalReadResult {
    const session = this.#require(id)
    const from = Math.max(0, Math.floor(since))
    const chunks = session.chunks.filter((chunk) => chunk.seq >= from)
    const first = session.chunks[0]?.seq ?? session.nextSeq
    return {
      id,
      chunks,
      next: session.nextSeq,
      running: session.endedAt === null,
      exitCode: session.exitCode,
      signal: session.signal,
      error: session.error,
      truncated: from < first && from < session.nextSeq,
      durationMs: (session.endedAt ?? this.#now()) - session.startedAt,
    }
  }

  /** Send text to the program's stdin, e.g. an answer to a prompt. */
  write(id: string, data: string): void {
    const session = this.#require(id)
    if (session.endedAt !== null) throw new TerminalRefusal('That command has already finished.')
    if (data.length > MAX_INPUT_CHARS) throw new TerminalRefusal('That input is too long to send in one go.')
    const stdin = session.child.stdin
    if (stdin === null || stdin.destroyed || !stdin.writable) {
      throw new TerminalRefusal('That program is not reading input any more.')
    }
    stdin.write(data)
  }

  /** Close the program's stdin (Ctrl+D). */
  endInput(id: string): void {
    const session = this.#require(id)
    session.child.stdin?.end()
  }

  /** Stop a running command and everything it started. Stopping a finished one is a no-op. */
  kill(id: string): { stopped: boolean } {
    const session = this.#require(id)
    if (session.endedAt !== null) return { stopped: false }
    killTree(session.child, false)
    // A program that ignores the polite signal is ended for it.
    if (session.stopTimer === null) {
      session.stopTimer = setTimeout(() => {
        if (session.endedAt === null) killTree(session.child, true)
      }, 1500)
      session.stopTimer.unref?.()
    }
    return { stopped: true }
  }

  /** Synchronously end every running program. For process exit. */
  disposeAll(): void {
    for (const session of this.#sessions.values()) {
      if (session.endedAt !== null) continue
      const pid = session.child.pid
      if (pid === undefined) continue
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 3000 })
        } else {
          process.kill(-pid, 'SIGKILL')
        }
      } catch {
        try {
          session.child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  }

  #require(id: string): Session {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new TerminalRefusal(`No terminal command with id ${id} (it may have expired).`)
    return session
  }

  #append(session: Session, stream: 'stdout' | 'stderr', text: string): void {
    if (text === '') return
    const kept = text.length > MAX_RETAINED_CHARS ? text.slice(-MAX_RETAINED_CHARS) : text
    session.chunks.push({ seq: session.nextSeq, stream, text: kept })
    session.nextSeq += 1
    session.retained += kept.length
    while (session.retained > MAX_RETAINED_CHARS && session.chunks.length > 1) {
      const dropped = session.chunks.shift()!
      session.retained -= dropped.text.length
    }
  }

  #finish(session: Session, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.endedAt !== null) return
    session.endedAt = this.#now()
    session.exitCode = code
    session.signal = signal
    if (session.stopTimer !== null) clearTimeout(session.stopTimer)
    const reaper = setTimeout(() => this.#sessions.delete(session.id), RETAIN_AFTER_EXIT_MS)
    reaper.unref?.()
  }
}
