// IPC bridge — typed wrappers around Tauri invoke commands.
// When running in browser dev mode (no Tauri), these fall back to mock implementations.

const IS_TAURI = '__TAURI_INTERNALS__' in window

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) {
    console.warn(`[IPC] No Tauri runtime, mock invoke: ${cmd}`, args)
    return null as T
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

export async function readDir(path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>('read_dir', { path })
}

export async function readFileContent(path: string): Promise<string> {
  return invoke<string>('read_file', { path })
}

export async function writeFileContent(path: string, content: string): Promise<void> {
  return invoke<void>('write_file', { path, content })
}

export async function openProject(): Promise<string | null> {
  return invoke<string | null>('open_project_dialog')
}

// ── Provider ────────────────────────────────────────────────────────────────

export interface ProviderInfo {
  id: string
  name: string
  configured: boolean
}

export async function listProviders(): Promise<ProviderInfo[]> {
  return invoke<ProviderInfo[]>('list_providers')
}

export async function setApiKey(providerId: string, key: string): Promise<void> {
  return invoke<void>('set_api_key', { providerId, key })
}

export async function removeApiKey(providerId: string): Promise<void> {
  return invoke<void>('remove_api_key', { providerId })
}

// ── Task Execution ──────────────────────────────────────────────────────────

export interface TaskEvent {
  type: string
  taskId: string
  message?: string
  plan?: unknown
  path?: string
  passed?: boolean
  summary?: string
}

export async function runTask(projectRoot: string, task: string, providerId: string, model: string): Promise<void> {
  return invoke<void>('run_task', { projectRoot, task, providerId, model })
}

export async function approvePlan(taskId: string, approved: boolean): Promise<void> {
  return invoke<void>('approve_plan', { taskId, approved })
}

export async function cancelTask(taskId: string): Promise<void> {
  return invoke<void>('cancel_task', { taskId })
}

// ── Terminal ────────────────────────────────────────────────────────────────

export async function runCommand(cwd: string, command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return invoke<{ exitCode: number; stdout: string; stderr: string }>('run_command', { cwd, command })
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

// ── Events (Tauri → Frontend) ───────────────────────────────────────────────

type UnlistenFn = () => void

export async function onTaskEvent(handler: (event: TaskEvent) => void): Promise<UnlistenFn> {
  if (!IS_TAURI) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<TaskEvent>('task-event', e => handler(e.payload))
}

export async function onFileChange(handler: (path: string) => void): Promise<UnlistenFn> {
  if (!IS_TAURI) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<string>('file-changed', e => handler(e.payload))
}
