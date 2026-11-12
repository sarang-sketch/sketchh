// Reading and writing the files the editor has open — through the OS bridge, with
// every failure turned into something a user can act on.
//
// The bridge (src/ipc/bridge.ts) is a Tauri-native capability and takes a
// `projectRoot` on every call; Rust refuses anything outside it. That refusal is
// LOAD-BEARING and is never worked around here (Requirement 15.6). What this module
// adds is honesty about the outcome: a refused read, a deleted file, a binary file
// and a file too large to open each produce a distinct message, because the failure
// mode this replaces was an empty editor that looked like an empty file.
//
// `FileIo` is an interface for the same reason `SketchClient` is: a test drives real
// state transitions through a real reducer without a Tauri webview in sight.
//
// Validates: Requirements 15.4, 15.6, 27.3

import { openProject, readDir, readFileContent, writeFileContent, type FsEntry } from '../ipc/bridge'
import { isNoProjectRootRefusal, isOutsideProjectRefusal } from '../ipc/policyMessages'
import { basename, canonicalPath } from './paths'

/** One directory entry, as the backend reports it. Re-exported so no panel imports the bridge. */
export type { FsEntry }

export interface FileIo {
  /** UTF-8 text of a file inside `root`. Rejects for anything outside it. */
  readFile(root: string, path: string): Promise<string>
  /** Writes UTF-8 text to a file inside `root`. Rejects for anything outside it. */
  writeFile(root: string, path: string, content: string): Promise<void>
  /**
   * One directory's immediate children, inside `root`. Rejects for anything
   * outside it, and does NOT recurse — the tree is expanded one directory at a
   * time, because an eager walk of this repository's own `node_modules` would
   * hang the window (Requirement 14.4).
   */
  readDir(root: string, path: string): Promise<FsEntry[]>
  /** The native folder picker. Resolves null when the user cancels. */
  pickFolder(): Promise<string | null>
}

/** The real one. Nothing but a rename of the bridge functions onto the interface. */
export const bridgeFileIo: FileIo = {
  readFile: (root, path) => readFileContent(root, path),
  writeFile: (root, path, content) => writeFileContent(root, path, content),
  readDir: (root, path) => readDir(root, path),
  pickFolder: () => openProject(),
}

/**
 * The largest file the editor will open, in bytes.
 *
 * Monaco degrades badly past a few megabytes (it disables tokenization above 20 MB
 * and gets sluggish long before that), and the whole text also lands in the state
 * tree. Refusing with a number in the message beats opening something unusable.
 */
export const MAX_OPEN_BYTES = 2_000_000

/** A NUL byte in UTF-8 text means this is not text we should pretend to edit. */
export function looksBinary(content: string): boolean {
  return content.includes('\u0000')
}

export function byteLength(content: string): number {
  // Cheap and exact for UTF-8, and available in both the webview and jsdom.
  return new TextEncoder().encode(content).length
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function saysNotFound(lower: string): boolean {
  return (
    lower.includes('no such file') ||
    lower.includes('cannot find the file') ||
    lower.includes('cannot find the path') ||
    lower.includes('os error 2') ||
    lower.includes('os error 3') ||
    lower.includes('enoent')
  )
}

/** True when a read failed because the file is not there (deleted, renamed, moved). */
export function isMissingFileError(err: unknown): boolean {
  return saysNotFound(messageOf(err).toLowerCase())
}

// ── saves in flight ─────────────────────────────────────────────────────────
//
// A disk check (editor/diskSync.ts) reads open files to see whether something else
// changed them. A read that lands while the editor's own save is half-written would
// see a truncated file and report it as "changed on disk". So a save registers the
// path for its whole duration — formatting, writing and recording the result — and a
// check skips any path being saved. The save itself then establishes the new baseline.

const savesInFlight = new Map<string, number>()

/** Mark `path` as being saved. Call the returned function exactly once, in a `finally`. */
export function beginEditorSave(path: string): () => void {
  const key = canonicalPath(path)
  savesInFlight.set(key, (savesInFlight.get(key) ?? 0) + 1)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    const left = (savesInFlight.get(key) ?? 1) - 1
    if (left <= 0) savesInFlight.delete(key)
    else savesInFlight.set(key, left)
  }
}

/** True while the editor is saving `path`. */
export function isEditorSaveInFlight(path: string): boolean {
  return savesInFlight.has(canonicalPath(path))
}

/**
 * Turn a bridge rejection into a sentence about this file.
 *
 * The Rust messages are already specific; the point here is to name the operation
 * and the file, and to keep the backend's own words at the end rather than
 * replacing them with something vaguer.
 */
export function describeFileFailure(
  operation: 'open' | 'save' | 'list',
  path: string,
  err: unknown,
): string {
  const raw = messageOf(err)
  const name = basename(path) || path
  const lower = raw.toLowerCase()

  if (lower.includes('not a directory')) {
    return `Cannot list ${name}: that path is a file, not a directory.`
  }

  // Containment refusal. The exact Rust wording lives in ipc/policyMessages.ts (it
  // changed in W2 and is matched there in both the current and the legacy form), so
  // this branch cannot silently stop matching when the backend message is reworded.
  if (isOutsideProjectRefusal(raw)) {
    return `Cannot ${operation} ${name}: it is outside the folder open in Sketch. To work with it, open the folder that contains it (File → Open Folder).`
  }
  if (isNoProjectRootRefusal(raw)) {
    return `Cannot ${operation} ${name}: no project folder is open. Open a folder first.`
  }
  if (lower.includes('not a file')) {
    return `Cannot ${operation} ${name}: that path is a directory, not a file.`
  }
  if (lower.includes('cannot write to a directory')) {
    return `Cannot save ${name}: that path is a directory.`
  }
  if (saysNotFound(lower)) {
    return `Cannot ${operation} ${name}: it no longer exists on disk. It may have been deleted or renamed.`
  }
  if (lower.includes('utf-8')) {
    return `Cannot open ${name}: it is not UTF-8 text, so it cannot be edited here.`
  }
  if (lower.includes('permission') || lower.includes('os error 5')) {
    return `Cannot ${operation} ${name}: permission denied by the operating system.`
  }
  if (lower.includes('not running under tauri')) {
    return `Cannot ${operation} ${name}: file access needs the desktop app. The browser dev bridge reaches the engine but not the filesystem.`
  }
  return `Cannot ${operation} ${name}: ${raw}`
}

export type ReadOutcome =
  | { ok: true; content: string }
  | { ok: false; message: string }

/**
 * Read a file for the editor, refusing the cases where an editor buffer would be a
 * lie. Never throws: a refusal is data, so the caller can put it on screen.
 */
export async function readForEditor(
  io: FileIo,
  root: string,
  path: string,
): Promise<ReadOutcome> {
  let content: string
  try {
    content = await io.readFile(root, path)
  } catch (err) {
    return { ok: false, message: describeFileFailure('open', path, err) }
  }

  const size = byteLength(content)
  if (size > MAX_OPEN_BYTES) {
    return {
      ok: false,
      message: `Cannot open ${basename(path)}: it is ${formatBytes(size)}, above the ${formatBytes(
        MAX_OPEN_BYTES,
      )} editor limit.`,
    }
  }
  if (looksBinary(content)) {
    return {
      ok: false,
      message: `Cannot open ${basename(path)}: it looks like a binary file, not text.`,
    }
  }
  return { ok: true, content }
}

export type WriteOutcome = { ok: true } | { ok: false; message: string }

/** Write a file for the editor. Never throws, for the same reason. */
export async function writeFromEditor(
  io: FileIo,
  root: string,
  path: string,
  content: string,
): Promise<WriteOutcome> {
  try {
    await io.writeFile(root, path, content)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: describeFileFailure('save', path, err) }
  }
}

export type ListOutcome =
  | { ok: true; entries: FsEntry[] }
  | { ok: false; message: string }

/**
 * List one directory for the file tree. Never throws, for the same reason
 * `readForEditor` does not: a refusal has to reach the screen as a sentence, and
 * the failure mode being replaced is a folder that reads as EMPTY when the real
 * answer was "permission denied" (Requirement 27.5).
 *
 * The backend decides what a directory contains — it already skips dotfiles,
 * `node_modules`, `target` and `dist` (see src-tauri/src/main.rs) and sorts folders
 * before files. None of that is second-guessed here, because two filters that can
 * disagree is how one of them ends up wrong.
 */
export async function listForExplorer(
  io: FileIo,
  root: string,
  path: string,
): Promise<ListOutcome> {
  try {
    return { ok: true, entries: await io.readDir(root, path) }
  } catch (err) {
    return { ok: false, message: describeFileFailure('list', path, err) }
  }
}
