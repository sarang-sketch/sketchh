// Handing a path to the operating system: "Reveal in File Explorer / Finder" and
// "Open in External Terminal" — the two things every desktop IDE's file tree can do
// that a web page cannot.
//
// ── NO SHELL PARSES A PATH ──────────────────────────────────────────────────
//
// Each launch is a PLAN — program, argument vector, working directory — built by a
// pure function, so the tests pin exactly what would run on each platform, and spawned
// with `shell: false`. The one place a command interpreter appears is Windows' `start`
// (the documented way to open a NEW console window), and there the folder travels as
// the working directory, never on the command line: nothing a folder can be named
// reaches cmd.exe's parser. The same trick VS Code's external terminal uses.
//
// The path must be inside the open project, by real path, like every other path the
// engine touches for the window.

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { resolveProjectPath } from './project.js'

/** What to start. `verbatim`: Windows only, pass `args` exactly as written. */
export interface LaunchPlan {
  program: string
  args: string[]
  cwd?: string
  verbatim?: boolean
  /** For the message when it cannot start: "Windows Terminal", "Finder". */
  label: string
}

export interface PlanEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows'
}

/** The first `names` found on PATH (Unix), as an absolute path. */
function onPath(names: readonly string[], context: PlanEnvironment): string | null {
  const dirs = (context.env['PATH'] ?? '').split(context.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = context.platform === 'win32' ? `${dir.replace(/[\\/]+$/, '')}\\${name}` : `${dir.replace(/\/+$/, '')}/${name}`
      if (context.exists(candidate)) return candidate
    }
  }
  return null
}

/** Show `path` in the system's file manager, selected. */
export function revealPlan(path: string, isDirectory: boolean, context: PlanEnvironment): LaunchPlan {
  if (context.platform === 'win32') {
    // `/select,"<path>"` must reach Explorer exactly so: Explorer parses its own
    // command line and does not accept the whole switch in quotes. A Windows path
    // cannot contain a double quote, so it cannot break out of these.
    return { program: `${systemRoot(context.env)}\\explorer.exe`, args: [`/select,"${path}"`], verbatim: true, label: 'File Explorer' }
  }
  if (context.platform === 'darwin') {
    return { program: '/usr/bin/open', args: ['-R', path], label: 'Finder' }
  }
  // No standard "select this file" on Linux desktops: open the folder it is in.
  const opener = onPath(['xdg-open', 'gio'], context)
  const folder = isDirectory ? path : dirname(path)
  if (opener !== null && opener.endsWith('gio')) return { program: opener, args: ['open', folder], label: 'the file manager' }
  return { program: opener ?? 'xdg-open', args: [folder], label: 'the file manager' }
}

/** Open the system's own terminal app in `dir`. */
export function externalTerminalPlan(dir: string, context: PlanEnvironment): LaunchPlan {
  if (context.platform === 'win32') {
    const local = context.env['LOCALAPPDATA']
    const wt = local !== undefined ? `${local}\\Microsoft\\WindowsApps\\wt.exe` : null
    if (wt !== null && context.exists(wt)) {
      return { program: wt, args: ['-d', dir], cwd: dir, label: 'Windows Terminal' }
    }
    // `start` opens a new console window; the folder is the working directory, never
    // part of this command line.
    const root = systemRoot(context.env)
    return {
      program: context.env['ComSpec'] ?? `${root}\\System32\\cmd.exe`,
      args: ['/d', '/c', 'start', '""', `"${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"`, '-NoLogo', '-ExecutionPolicy', 'Bypass'],
      cwd: dir,
      verbatim: true,
      label: 'PowerShell',
    }
  }
  if (context.platform === 'darwin') {
    return { program: '/usr/bin/open', args: ['-a', 'Terminal', dir], cwd: dir, label: 'Terminal' }
  }
  const candidates: Array<{ name: string; args: (d: string) => string[]; label: string }> = [
    { name: 'x-terminal-emulator', args: () => [], label: 'the terminal' },
    { name: 'gnome-terminal', args: (d) => [`--working-directory=${d}`], label: 'GNOME Terminal' },
    { name: 'konsole', args: (d) => ['--workdir', d], label: 'Konsole' },
    { name: 'xfce4-terminal', args: (d) => [`--working-directory=${d}`], label: 'Xfce Terminal' },
    { name: 'kitty', args: (d) => ['--directory', d], label: 'kitty' },
    { name: 'alacritty', args: (d) => ['--working-directory', d], label: 'Alacritty' },
    { name: 'wezterm', args: (d) => ['start', '--cwd', d], label: 'WezTerm' },
    { name: 'xterm', args: () => [], label: 'xterm' },
  ]
  for (const candidate of candidates) {
    const program = onPath([candidate.name], context)
    if (program !== null) return { program, args: candidate.args(dir), cwd: dir, label: candidate.label }
  }
  return { program: 'x-terminal-emulator', args: [], cwd: dir, label: 'a terminal (none was found on PATH)' }
}

export class OsOpenRefusal extends Error {
  override readonly name = 'OsOpenRefusal'
}

/** Start `plan` detached and report whether it started. Never waits for it to finish. */
export function launch(plan: LaunchPlan): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(plan.program, plan.args, {
        ...(plan.cwd !== undefined ? { cwd: plan.cwd } : {}),
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false,
        ...(plan.verbatim === true ? { windowsVerbatimArguments: true } : {}),
      })
    } catch (err) {
      reject(new OsOpenRefusal(`Could not open ${plan.label}: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    child.once('error', (err) => reject(new OsOpenRefusal(`Could not open ${plan.label}: ${err.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function realContext(): PlanEnvironment {
  return { platform: process.platform, env: process.env, exists: (path) => existsSync(path) }
}

async function inside(root: string, path: string): Promise<{ absolute: string; isDirectory: boolean }> {
  let absolute: string
  try {
    absolute = await resolveProjectPath(root, path)
  } catch (err) {
    throw new OsOpenRefusal(err instanceof Error ? err.message : String(err))
  }
  return { absolute, isDirectory: statSync(absolute).isDirectory() }
}

/** Reveal a file or folder of the project in the system's file manager. */
export async function revealInFileManager(root: string, path: string, context = realContext()): Promise<{ label: string }> {
  const target = await inside(root, path)
  const plan = revealPlan(target.absolute, target.isDirectory, context)
  await launch(plan)
  return { label: plan.label }
}

/** Open the system's terminal app in a folder of the project (a file: its folder). */
export async function openExternalTerminal(root: string, path: string, context = realContext()): Promise<{ label: string }> {
  const target = await inside(root, path)
  const dir = target.isDirectory ? target.absolute : dirname(target.absolute)
  const plan = externalTerminalPlan(dir, context)
  await launch(plan)
  return { label: plan.label }
}
