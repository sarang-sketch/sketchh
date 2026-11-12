// The local model manager's Ollama client: what the server has installed and loaded,
// and the download / remove / load / unload actions, through Ollama's own HTTP API
// (https://github.com/ollama/ollama/blob/main/docs/api.md).
//
// ── WHY THE ENGINE, NOT THE WINDOW ───────────────────────────────────────────
//
// The agent never talks to Ollama through this file: runs reach models only through
// provider adapters (`/v1` OpenAI-compatible). This is management, and it lives in the
// engine so both transports and the CLI share it, and so its requests pass the same
// network guard as everything else (Offline Mode allows this machine).
//
// ── NOTHING LARGE STARTS ON ITS OWN ──────────────────────────────────────────
//
// A pull is started only by `startPull`, which the RPC method calls only with
// `confirmed: true` — the window asks the user first and shows the download size.

/** Where Ollama listens unless the user moved it. */
export const OLLAMA_DEFAULT_URL = 'http://localhost:11434'

/** Model names as Ollama spells them: `name[:tag]`, optionally `namespace/name`. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,150}(:[A-Za-z0-9._-]{1,80})?$/

export function isModelName(value: string): boolean {
  return MODEL_NAME.test(value) && !value.includes('..')
}

/** The server root from a configured provider URL: `http://host:11434/v1/` → `http://host:11434`. */
export function ollamaBase(raw?: string | null): string {
  const value = (raw ?? '').trim()
  if (value === '') return OLLAMA_DEFAULT_URL
  return value.replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/api$/, '')
}

export interface OllamaOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

async function call(base: string, path: string, init: RequestInit, options: OllamaOptions = {}): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  try {
    return await doFetch(`${base}${path}`, { ...init, signal: controller.signal })
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`Ollama at ${base} did not answer in time`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function json(base: string, path: string, init: RequestInit, options?: OllamaOptions): Promise<unknown> {
  const response = await call(base, path, init, options)
  const text = await response.text()
  if (!response.ok) throw new Error(ollamaError(response.status, text))
  return text === '' ? {} : (JSON.parse(text) as unknown)
}

function ollamaError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error !== '') return `Ollama: ${parsed.error}`
  } catch {
    // not JSON
  }
  return `Ollama answered HTTP ${status}${body.trim() !== '' ? `: ${body.trim().slice(0, 200)}` : ''}`
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

// ── reading ──────────────────────────────────────────────────────────────────

export interface OllamaServer {
  baseUrl: string
  reachable: boolean
  version?: string
  error?: string
}

export async function ollamaServer(base: string, options: OllamaOptions = {}): Promise<OllamaServer> {
  try {
    const body = record(await json(base, '/api/version', { method: 'GET' }, { timeoutMs: 2_500, ...options }))
    const version = str(body['version'])
    return { baseUrl: base, reachable: true, ...(version !== undefined ? { version } : {}) }
  } catch (err) {
    return { baseUrl: base, reachable: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface LocalModel {
  name: string
  /** Bytes on disk. */
  size: number
  modifiedAt?: string
  family?: string
  parameterSize?: string
  quantization?: string
  /** What Ollama says the model can do (`completion`, `tools`, `vision`, `embedding`, `thinking`...). Null when it did not say. */
  capabilities: string[] | null
  /** The model's trained context length, from its metadata. Null when unknown. */
  contextLength: number | null
  /** Loaded in memory right now (`/api/ps`). */
  loaded: boolean
  /** Bytes of it in GPU memory, when loaded. */
  vram?: number
  /** When Ollama will unload it, when loaded. */
  expiresAt?: string
}

/** `<architecture>.context_length` from `/api/show`'s `model_info`. */
export function contextLengthOf(modelInfo: Record<string, unknown>): number | null {
  const arch = str(modelInfo['general.architecture'])
  const direct = arch !== undefined ? num(modelInfo[`${arch}.context_length`]) : undefined
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && num(value) !== undefined) return value as number
  }
  return null
}

/** Installed models, with what each can do and whether it is loaded. One `/api/show` per model. */
export async function listLocalModels(base: string, options: OllamaOptions = {}): Promise<LocalModel[]> {
  const tags = record(await json(base, '/api/tags', { method: 'GET' }, options))
  let running: Record<string, unknown>[] = []
  try {
    const ps = record(await json(base, '/api/ps', { method: 'GET' }, options))
    running = Array.isArray(ps['models']) ? ps['models'].map(record) : []
  } catch {
    // Older servers: no loaded-state, everything else still works.
  }
  const entries = Array.isArray(tags['models']) ? tags['models'].map(record) : []
  return Promise.all(
    entries
      .filter((entry) => str(entry['name']) !== undefined)
      .map(async (entry): Promise<LocalModel> => {
        const name = str(entry['name'])!
        const details = record(entry['details'])
        const live = running.find((r) => str(r['name']) === name || str(r['model']) === name)
        let capabilities: string[] | null = null
        let contextLength: number | null = null
        try {
          const shown = record(await json(base, '/api/show', post({ model: name }), options))
          if (Array.isArray(shown['capabilities'])) {
            capabilities = shown['capabilities'].filter((c): c is string => typeof c === 'string')
          }
          contextLength = contextLengthOf(record(shown['model_info']))
        } catch {
          // A model whose details cannot be read is still listed.
        }
        const modifiedAt = str(entry['modified_at'])
        const family = str(details['family'])
        const parameterSize = str(details['parameter_size'])
        const quantization = str(details['quantization_level'])
        const vram = live !== undefined ? num(live['size_vram']) : undefined
        const expiresAt = live !== undefined ? str(live['expires_at']) : undefined
        return {
          name,
          size: num(entry['size']) ?? 0,
          ...(modifiedAt !== undefined ? { modifiedAt } : {}),
          ...(family !== undefined ? { family } : {}),
          ...(parameterSize !== undefined ? { parameterSize } : {}),
          ...(quantization !== undefined ? { quantization } : {}),
          capabilities,
          contextLength,
          loaded: live !== undefined,
          ...(vram !== undefined ? { vram } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        }
      }),
  )
}

// ── acting ───────────────────────────────────────────────────────────────────

export async function deleteLocalModel(base: string, model: string, options: OllamaOptions = {}): Promise<void> {
  await json(base, '/api/delete', { ...post({ model }), method: 'DELETE' }, options)
}

/** Load into memory and keep it there for `keepAlive` (Ollama duration syntax). An empty prompt only loads. */
export async function loadLocalModel(base: string, model: string, keepAlive = '30m', options: OllamaOptions = {}): Promise<void> {
  await json(base, '/api/generate', post({ model, prompt: '', stream: false, keep_alive: keepAlive }), { timeoutMs: 180_000, ...options })
}

/** Free its memory now (`keep_alive: 0`). */
export async function unloadLocalModel(base: string, model: string, options: OllamaOptions = {}): Promise<void> {
  await json(base, '/api/generate', post({ model, prompt: '', stream: false, keep_alive: 0 }), { timeoutMs: 30_000, ...options })
}

// ── downloading ──────────────────────────────────────────────────────────────

export interface PullState {
  id: string
  model: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  /** Ollama's own words for the current step ("pulling manifest", "verifying sha256 digest"...). */
  status: string
  /** Bytes, summed over every layer Ollama has reported so far. */
  completed: number
  total: number
  error?: string
  startedAt: number
  endedAt?: number
}

interface PullJob {
  state: PullState
  controller: AbortController
}

const pulls = new Map<string, PullJob>()
/** Finished jobs are forgotten after this long; the window has long since read them. */
const KEEP_FINISHED_MS = 10 * 60_000

function prune(now: number): void {
  for (const [id, job] of pulls) {
    if (job.state.endedAt !== undefined && now - job.state.endedAt > KEEP_FINISHED_MS) pulls.delete(id)
  }
}

/** Fold one line of the pull stream into the job's state. Exported for tests. */
export function applyPullLine(state: PullState, layers: Map<string, { total: number; completed: number }>, line: string): void {
  if (line.trim() === '') return
  let parsed: Record<string, unknown>
  try {
    parsed = record(JSON.parse(line))
  } catch {
    return
  }
  const error = str(parsed['error'])
  if (error !== undefined) {
    state.state = 'failed'
    state.error = `Ollama: ${error}`
    return
  }
  const status = str(parsed['status'])
  if (status !== undefined) state.status = status
  const digest = str(parsed['digest'])
  const total = num(parsed['total'])
  if (digest !== undefined && total !== undefined) {
    layers.set(digest, { total, completed: num(parsed['completed']) ?? layers.get(digest)?.completed ?? 0 })
    state.total = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0)
    state.completed = [...layers.values()].reduce((sum, layer) => sum + Math.min(layer.completed, layer.total), 0)
  }
  if (status === 'success') state.state = 'done'
}

/** Start downloading `model` in the background. Returns at once; poll {@link pullStatus}. */
export function startPull(base: string, model: string, options: { fetchImpl?: typeof fetch } = {}): PullState {
  const now = Date.now()
  prune(now)
  for (const job of pulls.values()) {
    if (job.state.model === model && job.state.state === 'running') return { ...job.state }
  }
  const id = `pull-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const job: PullJob = {
    state: { id, model, state: 'running', status: 'starting', completed: 0, total: 0, startedAt: now },
    controller: new AbortController(),
  }
  pulls.set(id, job)
  void runPull(base, job, options.fetchImpl ?? fetch)
  return { ...job.state }
}

async function runPull(base: string, job: PullJob, doFetch: typeof fetch): Promise<void> {
  const layers = new Map<string, { total: number; completed: number }>()
  try {
    const response = await doFetch(`${base}/api/pull`, { ...post({ model: job.state.model, stream: true }), signal: job.controller.signal })
    if (!response.ok || response.body === null) {
      throw new Error(ollamaError(response.status, response.body === null ? '' : await response.text()))
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        applyPullLine(job.state, layers, buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (job.state.state === 'failed') break
    }
    applyPullLine(job.state, layers, buffer)
    if (job.state.state === 'running') {
      job.state.state = 'failed'
      job.state.error = 'The download stream ended before Ollama reported success.'
    }
  } catch (err) {
    if (job.controller.signal.aborted) {
      job.state.state = 'cancelled'
    } else if (job.state.state === 'running') {
      job.state.state = 'failed'
      job.state.error = err instanceof Error ? err.message : String(err)
    }
  } finally {
    job.state.endedAt = Date.now()
  }
}

export function pullStatus(id: string): PullState | null {
  const job = pulls.get(id)
  return job === undefined ? null : { ...job.state }
}

/** Stop a download. Ollama keeps what it fetched and resumes from there next time. */
export function cancelPull(id: string): boolean {
  const job = pulls.get(id)
  if (job === undefined || job.state.state !== 'running') return false
  job.controller.abort()
  return true
}
