// The Explorer's file operations: new file, new folder, rename/move, delete.
//
// The window could read, write and list files (through the Tauri commands, contained in
// Rust) but could not create a folder, rename anything or delete anything, so the
// Explorer's New File button was disabled with "not implemented yet". These four live in
// the engine so they work on both transports and are tested here, with the same rule the
// Rust layer enforces: every path is resolved by its REAL location, and nothing outside the
// open project — not through `..`, not through a symlink or a junction — is touched.
//
// DELETE GOES TO THE TRASH FIRST. A deleted file should be recoverable the way it is in
// every file manager, so `deleteEntry(..., { trash: true })` asks the operating system to
// move it to the Recycle Bin / Trash. When there is no trash to move it to, it refuses
// with `TrashUnavailable` rather than deleting for good, and the window asks the user
// whether to delete permanently instead.
//
// None of these overwrites: a create or rename onto an existing name is refused, so a
// slip of the keyboard cannot replace a file.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** A refusal for the person at the Explorer, as a sentence. */
export class FsRefusal extends Error {
  override readonly name: string = 'FsRefusal'
}

/** The trash could not be used; deleting permanently is the caller's decision. */
export class TrashUnavailable extends FsRefusal {
  override readonly name: string = 'TrashUnavailable'
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function realRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new FsRefusal('The project folder must be an absolute path.')
  try {
    const real = await realpath(root)
    if (!(await lstat(real)).isDirectory()) throw new FsRefusal('The project folder is not a folder.')
    return real
  } catch (err) {
    if (err instanceof FsRefusal) throw err
    throw new FsRefusal(`The project folder does not exist: ${root}`)
  }
}

/** A name a user typed for one path segment, refused when it cannot be one. */
export function validateName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new FsRefusal('A name is required.')
  if (trimmed === '.' || trimmed === '..') throw new FsRefusal(`"${trimmed}" is not a usable name.`)
  if (/[\0<>:"|?*\u0001-\u001f]/.test(trimmed)) {
    throw new FsRefusal('A name cannot contain < > : " | ? * or control characters.')
  }
  if (/[. ]$/.test(trimmed)) throw new FsRefusal('A name cannot end with a dot or a space.')
  const stem = trimmed.split('.')[0]!.toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new FsRefusal(`"${trimmed}" is a reserved name on Windows.`)
  }
  return trimmed
}

/**
 * The absolute path for `raw` (absolute, or relative to the root), checked against the
 * root by the real path of its deepest EXISTING ancestor — the target itself may not
 * exist yet. Every segment of a relative path is validated as a name.
 */
async function containedTarget(root: string, raw: string): Promise<string> {
  if (typeof raw !== 'string' || raw.trim() === '') throw new FsRefusal('A path is required.')
  if (raw.includes('\0')) throw new FsRefusal('The path contains a NUL byte.')
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
  if (!isInside(root, candidate)) throw new FsRefusal(`${raw} is outside the open project.`)
  const rel = relative(root, candidate)
  if (rel !== '') for (const segment of rel.split(sep)) validateName(segment)

  let probe = candidate
  for (;;) {
    try {
      const real = await realpath(probe)
      if (!isInside(root, real)) {
        throw new FsRefusal(`${raw} resolves outside the open project (a link pointing elsewhere is not followed).`)
      }
      return candidate
    } catch (err) {
      if (err instanceof FsRefusal) throw err
      const parent = dirname(probe)
      if (parent === probe) throw new FsRefusal(`${raw} is outside the open project.`)
      probe = parent
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Create an empty (or given) file. Parent folders are created; an existing name is refused. */
export async function createFile(root: string, path: string, content = ''): Promise<{ path: string }> {
  const base = await realRoot(root)
  const target = await containedTarget(base, path)
  if (target === base) throw new FsRefusal('The project folder itself cannot be a file.')
  if (await exists(target)) throw new FsRefusal(`${basename(target)} already exists.`)
  await mkdir(dirname(target), { recursive: true })
  // `wx`: fails if something appeared in between, instead of overwriting it.
  await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
  return { path: target }
}

/** Create a folder (and any missing parents). An existing name is refused. */
export async function createFolder(root: string, path: string): Promise<{ path: string }> {
  const base = await realRoot(root)
  const target = await containedTarget(base, path)
  if (target === base) throw new FsRefusal('The project folder already exists.')
  if (await exists(target)) throw new FsRefusal(`${basename(target)} already exists.`)
  await mkdir(target, { recursive: true })
  return { path: target }
}

/**
 * Rename or move inside the project. The destination must not exist — except a change of
 * letter case only (`readme.md` → `README.md`), which case-insensitive file systems see
 * as the same name and which therefore goes through a temporary name.
 */
export async function renameEntry(root: string, from: string, to: string): Promise<{ from: string; to: string }> {
  const base = await realRoot(root)
  const source = await containedTarget(base, from)
  const target = await containedTarget(base, to)
  if (source === base) throw new FsRefusal('The project folder itself cannot be renamed here.')
  if (!(await exists(source))) throw new FsRefusal(`${basename(source)} no longer exists.`)
  if (source === target) return { from: source, to: target }
  // Strictly inside: on Windows `relative` compares case-insensitively, so a case-only
  // rename (`readme.md` → `README.md`) relates as '' and is not "into itself".
  if (relative(source, target) !== '' && isInside(source, target)) {
    throw new FsRefusal('A folder cannot be moved into itself.')
  }

  // A destination that exists is refused — unless it IS the source under another
  // spelling, which is what a case-only rename looks like on a case-insensitive file
  // system (Windows, macOS). There the rename goes through a temporary name; on Linux
  // `a.txt` and `A.txt` are two files, the real paths differ, and it is refused.
  let sameEntry = false
  if (await exists(target)) {
    sameEntry = (await realpath(source)) === (await realpath(target))
    if (!sameEntry) throw new FsRefusal(`${basename(target)} already exists.`)
  }
  await mkdir(dirname(target), { recursive: true })
  if (sameEntry) {
    // Through a temporary name, since the file system sees one entry under both
    // spellings. If the second step fails (on Windows, another program can hold the
    // entry for a moment), the entry goes back to its own name: left under the
    // temporary one it would vanish from the Explorer, which hides dot-names.
    const temp = join(dirname(source), `.sketch-rename-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`)
    await rename(source, temp)
    try {
      await rename(temp, target)
    } catch (err) {
      await rename(temp, source).catch(() => {})
      throw err
    }
  } else {
    await rename(source, target)
  }
  return { from: source, to: target }
}

/** How this platform moves a path to its trash, or null when it has no way to. */
export function trashCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv } | null {
  if (platform === 'win32') {
    const systemRoot = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    // The path travels in an environment variable, never inside the script text, so no
    // file name can be read as PowerShell.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      '$p = $env:SKETCH_TRASH_PATH',
      "if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
      "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    ].join('\n')
    return {
      cmd: powershell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      env: { ...env, SKETCH_TRASH_PATH: path },
    }
  }
  if (platform === 'darwin') {
    return {
      cmd: '/usr/bin/osascript',
      args: ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv))', '-e', 'end run', path],
    }
  }
  for (const dir of (env['PATH'] ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, 'gio'))) return { cmd: join(dir, 'gio'), args: ['trash', '--', path] }
  }
  for (const dir of (env['PATH'] ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, 'trash-put'))) return { cmd: join(dir, 'trash-put'), args: ['--', path] }
  }
  return null
}

function runTrash(command: NonNullable<ReturnType<typeof trashCommand>>): Promise<string | null> {
  return new Promise((resolveRun) => {
    let stderr = ''
    const child = spawn(command.cmd, command.args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(command.env !== undefined ? { env: command.env } : {}),
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    const timer = setTimeout(() => child.kill(), 30_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolveRun(err.message)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun(code === 0 ? null : stderr.trim() || `exit ${code}`)
    })
  })
}

/**
 * Delete a file or folder inside the project. `trash: true` moves it to the operating
 * system's trash and refuses with {@link TrashUnavailable} when it cannot; `trash: false`
 * deletes it for good, which only an explicit user choice should ask for.
 */
export async function deleteEntry(
  root: string,
  path: string,
  options: { trash: boolean },
): Promise<{ path: string; trashed: boolean }> {
  const base = await realRoot(root)
  const target = await containedTarget(base, path)
  if (target === base) throw new FsRefusal('The project folder itself cannot be deleted from here.')
  if (!(await exists(target))) throw new FsRefusal(`${basename(target)} no longer exists.`)
  // A link is removed as a link: its target, which may be outside the project, is not.
  const info = await lstat(target)

  if (options.trash) {
    const command = trashCommand(target)
    if (command === null) throw new TrashUnavailable('This system has no trash to move it to.')
    const failure = await runTrash(command)
    if (failure !== null || (await exists(target))) {
      throw new TrashUnavailable(`It could not be moved to the trash${failure === null ? '' : `: ${failure}`}`)
    }
    return { path: target, trashed: true }
  }

  await rm(target, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: false })
  return { path: target, trashed: false }
}
