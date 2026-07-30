// Tauri-native OS capabilities. NOT a second engine seam.
//
// SCOPE, deliberately narrow: engine RPC — runs, plans, providers, events — goes
// through `SketchClient` (src/lib/client.ts) over stdio in the app and HTTP in dev.
// This module is ONLY for the things the OS can do and the engine cannot reach from
// a webview: a folder picker, reading and writing a file the editor has open, a
// directory listing, git status/diff, and the confirmed terminal command.
//
// Every wrapper here names a command that actually exists in src-tauri/src/main.rs.
// It previously carried wrappers for `run_task`, `approve_plan`, `cancel_task` and
// listeners for `task-event`/`file-changed` — none of which existed in Rust. A typed
// wrapper around a command that is not there is a second source of truth that always
// disagrees with the first, so they are gone rather than left dangling. If a
// capability belongs to the engine, add it to `SketchClient`, not here.
//
// The three credential wrappers at the bottom were in that same list until task 4.2
// implemented them in Rust. They are here now because the commands exist; the guard
// that used to forbid them by name is now the guard in src/lib/security.test.ts that
// requires every wrapper to name a `#[tauri::command]` that is defined AND registered.
//
// NONE OF THEM READS A KEY BACK. There is no `get_api_key`, by design: a key that
// reaches this window is a key that can reach a console log, an error boundary, or a
// crash report (Requirement 17.3).
//
// EVERY PATH TAKES A `projectRoot`. The Rust side refuses any path outside it; the
// `fs.scope` in tauri.conf.json does not cover these custom commands, so this is
// where containment is (Requirement 13.8).

const IS_TAURI = '__TAURI_INTERNALS__' in window

/**
 * There is no fallback. Outside Tauri these commands have no implementation, and
 * returning `null as T` used to make the type signature a lie that surfaced as an
 * unrelated crash later. A browser dev session should reach the engine through
 * `SketchClient`, so failing loudly here points at the real mistake.
 */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) {
    throw new Error(
      `not running under Tauri: the native command '${cmd}' is unavailable. Engine calls go through SketchClient.`,
    )
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

// ── File System ─────────────────────────────────────────────────────────────

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
}

/** Lists a directory inside `projectRoot`. Anything outside it is refused in Rust. */
export async function readDir(projectRoot: string, path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>('read_dir', { projectRoot, path })
}

/** Reads a file inside `projectRoot`. `path` may be absolute or project-relative. */
export async function readFileContent(projectRoot: string, path: string): Promise<string> {
  return invoke<string>('read_file', { projectRoot, path })
}

/**
 * Writes a file inside `projectRoot`, creating missing parent directories beneath
 * it. The target need not exist yet; the backend contains it against the deepest
 * ancestor that does.
 */
export async function writeFileContent(
  projectRoot: string,
  path: string,
  content: string,
): Promise<void> {
  return invoke<void>('write_file', { projectRoot, path, content })
}

/** The native folder picker. Returns null if the user cancelled. */
export async function openProject(): Promise<string | null> {
  return invoke<string | null>('open_project_dialog')
}

// ── Terminal ────────────────────────────────────────────────────────────────

export interface CommandOutput {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunCommandRequest {
  /** The open project. The backend refuses any cwd outside it. */
  projectRoot: string
  /** Absolute or project-relative. Empty means the project root itself. */
  cwd?: string
  /** An allowlisted program name. Not a shell line — see `allowedPrograms()`. */
  program: string
  /** Passed to the child verbatim. There is no shell, so nothing is re-parsed. */
  args?: string[]
  /**
   * Must be true. The UI asks the user first (the terminal panel owns that
   * prompt); the backend refuses an unconfirmed call regardless, so forgetting to
   * ask cannot execute anything (Requirement 22.6).
   */
  confirmed: boolean
}

export async function runCommand(request: RunCommandRequest): Promise<CommandOutput> {
  return invoke<CommandOutput>('run_command', {
    projectRoot: request.projectRoot,
    cwd: request.cwd ?? '',
    program: request.program,
    args: request.args ?? [],
    confirmed: request.confirmed,
  })
}

/** The programs the backend will start. The source of truth is the Rust allowlist. */
export async function allowedPrograms(): Promise<string[]> {
  return invoke<string[]>('allowed_programs')
}

// ── Git ─────────────────────────────────────────────────────────────────────

export interface GitStatus {
  branch: string
  staged: string[]
  modified: string[]
  untracked: string[]
}

export async function gitStatus(projectRoot: string): Promise<GitStatus> {
  return invoke<GitStatus>('git_status', { projectRoot })
}

export async function gitDiff(projectRoot: string, file?: string): Promise<string> {
  return invoke<string>('git_diff', { projectRoot, file })
}

// ── Credentials ─────────────────────────────────────────────────────────────
//
// Storage is the operating system's — Windows Credential Manager, the macOS Keychain,
// or the Secret Service on Linux — reached through Rust. The engine never persists a
// key and this window never holds one for longer than the request it was typed for
// (Requirements 17.3, 17.4).

/** Whether one provider has a stored key, and the name of the store it is in. */
export interface ProviderKeyPresence {
  id: string
  hasKey: boolean
  /** e.g. "Windows Credential Manager". Shown so the UI can say where a key went. */
  store: string
}

/**
 * Which of the given providers have a key stored.
 *
 * PRESENCE ONLY — an id and a boolean. There is no command that returns a key value,
 * not even truncated, so there is no wrapper here that could.
 */
export async function listProviderKeys(providerIds: string[]): Promise<ProviderKeyPresence[]> {
  return invoke<ProviderKeyPresence[]>('list_providers', { providerIds })
}

/**
 * Store a key for one provider. Resolves with the NAME of the store it went into.
 *
 * The value crosses this call and is not kept: the caller drops it, and the Rust side
 * hands it to the OS and wipes its own copy.
 */
export async function setProviderKey(providerId: string, apiKey: string): Promise<string> {
  return invoke<string>('set_api_key', { providerId, apiKey })
}

/** Remove a provider's stored key. Removing one that is not there succeeds. */
export async function removeProviderKey(providerId: string): Promise<string> {
  return invoke<string>('remove_api_key', { providerId })
}
