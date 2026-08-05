// The sidecar transport: the engine as a child process, one JSON object per line.
//
// This client OWNS a real process. It spawns the `externalBin` sidecar registered
// in src-tauri/tauri.conf.json, writes newline-delimited request frames to its
// stdin, reassembles frames off its stdout, correlates responses by `id`, and
// routes event frames onto the bus (Requirements 13.4, 12.1, 12.6).
//
// IT IS HONEST WHEN IT CANNOT WORK. If the sidecar is not registered, not
// bundled, fails to spawn, or the app is running outside the Tauri webview, every
// method REJECTS with the reason. Nothing here fabricates a result: a client that
// answered `ok: true` without an engine behind it would make a dead engine look
// healthy, which is strictly worse than a mock (Requirement 13.7). `ClientProvider`
// turns a rejected `ping` into an `error` status carrying that message.
//
// FRAMING. stdout is a byte stream, not a sequence of frames. One `run` response
// embeds a whole `RunResult` and can be far larger than a chunk, and the protocol
// is sequential server-side, so partial lines are buffered until a terminator
// arrives. Tauri's shell plugin happens to emit one `data` event per line with the
// terminator already stripped, so a chunk that parses as a complete JSON value is
// also accepted as a whole frame — otherwise the last frame would sit in the
// buffer forever. A genuinely partial chunk does not parse, so it keeps buffering.
//
// stderr is DIAGNOSTIC, never protocol (Requirement 12.5). It is surfaced through
// `onDiagnostic` and quoted back in failure messages, never parsed as a frame.
//
// Validates: Requirements 13.2, 13.4, 13.6, 13.7, 12.1, 12.5, 12.6

import type {
  SketchClient,
  CancelResult,
  ReplyResult,
  PingResult,
  EventHandler,
  Unsubscribe,
  TransportKind,
  RunOptions,
  ArchitectureResult,
  SkillsCatalogResult,
  SkillInstallResult,
  SkillTrainResult,
  SkillPromoteResult,
  VerifyContractResult,
  McpCatalogResult,
  StrategyCatalogResult,
  CostReport,
  MemoryListResult,
  MemorySearchResult,
  MemoryRememberResult,
  MemorySupersedeResult,
  BenchmarkReportResult,
  ProviderCatalogResult,
  ProviderTestRequest,
} from './client'
import { createEventBus } from './client'
import type {
  Task,
  RunResult,
  EvalCase,
  EvalResult,
  GitStatusResult,
  ProjectSearchResult,
  ProviderSettingsFile,
  ProviderTestResult,
  SketchEvent,
} from './contracts'

/**
 * The `externalBin` entry, exactly as written in tauri.conf.json. Tauri resolves
 * it to `binaries/sketch-engine-<target-triple>[.exe]` at bundle time.
 */
export const SIDECAR_BIN = 'binaries/sketch-engine'

/**
 * The esbuild bundle of `packages/core/src/cli.ts`, shipped as a Tauri resource.
 * The sidecar binary is a Node runtime, so the engine arrives as its first
 * argument. See packages/desktop/scripts/build-sidecar.mjs.
 */
export const SIDECAR_SCRIPT_RESOURCE = 'resources/sketch-engine.mjs'

/** A live child process, reduced to what this client needs. */
export interface SidecarProcess {
  /** Write raw bytes to the child's stdin. The caller adds the terminator. */
  write(data: string): Promise<void>
  /** Terminate the child. */
  kill(): Promise<void>
}

/** Callbacks a spawner wires to the child's streams and lifetime. */
export interface SidecarHandlers {
  stdout(chunk: string): void
  stderr(chunk: string): void
  exit(info: { code: number | null; message?: string }): void
}

/**
 * How a process gets started. The default talks to the Tauri shell plugin; tests
 * supply their own so the framing can be driven without a webview.
 */
export type SidecarSpawner = (handlers: SidecarHandlers) => Promise<SidecarProcess>

export interface StdioSketchClientOptions {
  /** `externalBin` name. Defaults to {@link SIDECAR_BIN}. */
  bin?: string
  /** Extra CLI arguments, after the engine script path. */
  args?: string[]
  /** Absolute path to the engine bundle. Defaults to the resolved resource. */
  script?: string
  /** Project root sent with `run`/`eval`. Absent means the sidecar's own cwd. */
  root?: string
  /** Injected in tests. Production leaves this unset and gets the real sidecar. */
  spawn?: SidecarSpawner
  /** Where stderr lines go. Defaults to `console.warn`. */
  onDiagnostic?: (line: string) => void
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function parseJson(text: string): { parsed: unknown } | null {
  try {
    return { parsed: JSON.parse(text) as unknown }
  } catch {
    return null
  }
}

function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Spawn the registered sidecar through the Tauri shell plugin.
 *
 * Throws — loudly and with the reason — outside Tauri, when the plugin is not
 * present, when the resource is missing, or when the spawn is denied by the
 * capability. Those are the four ways this can be misconfigured and all four must
 * be visible.
 */
function tauriSpawner(options: StdioSketchClientOptions): SidecarSpawner {
  return async (handlers) => {
    if (!hasTauriRuntime()) {
      throw new Error(
        'no Tauri runtime in this window, so the engine sidecar cannot be spawned. ' +
          'Use VITE_BRIDGE=http for browser development.',
      )
    }

    const [shell, path] = await Promise.all([
      import('@tauri-apps/plugin-shell'),
      import('@tauri-apps/api/path'),
    ])

    const bin = options.bin ?? SIDECAR_BIN
    const script = options.script ?? (await path.resolveResource(SIDECAR_SCRIPT_RESOURCE))
    const command = shell.Command.sidecar(bin, [script, ...(options.args ?? [])])

    command.stdout.on('data', (chunk) => {
      handlers.stdout(typeof chunk === 'string' ? chunk : String(chunk))
    })
    command.stderr.on('data', (chunk) => {
      handlers.stderr(typeof chunk === 'string' ? chunk : String(chunk))
    })
    command.on('error', (error) => {
      handlers.exit({ code: null, message: String(error) })
    })
    command.on('close', (payload) => {
      handlers.exit({ code: payload.code })
    })

    const child = await command.spawn()
    return {
      write: (data) => child.write(data),
      kill: () => child.kill(),
    }
  }
}

export class StdioSketchClient implements SketchClient {
  readonly transport: TransportKind = 'stdio'

  private readonly bus = createEventBus()
  private readonly pendingRequests = new Map<string, Pending>()
  private readonly spawner: SidecarSpawner
  private readonly onDiagnostic: (line: string) => void
  private readonly root: string | undefined

  private child: SidecarProcess | null = null
  private starting: Promise<SidecarProcess> | null = null
  private stdoutBuffer = ''
  private recentStderr: string[] = []
  private seq = 0

  constructor(options: StdioSketchClientOptions = {}) {
    this.spawner = options.spawn ?? tauriSpawner(options)
    this.onDiagnostic =
      options.onDiagnostic ?? ((line: string) => console.warn('[sketch sidecar]', line))
    this.root = options.root
  }

  // ── process lifetime ──────────────────────────────────────────────────────

  /**
   * The child, spawning it on first use. A failed spawn is not cached: the reason
   * is reported to this caller and the next call is free to try again, which is
   * what makes a retry after a fixed install work without reloading the window.
   */
  private ensureStarted(): Promise<SidecarProcess> {
    if (this.child) return Promise.resolve(this.child)
    if (this.starting) return this.starting

    const attempt = this.spawner({
      stdout: (chunk) => this.handleStdout(chunk),
      stderr: (chunk) => this.handleStderr(chunk),
      exit: (info) => this.handleExit(info),
    }).then(
      (child) => {
        this.starting = null
        this.child = child
        return child
      },
      (err: unknown) => {
        this.starting = null
        throw new Error(`sketch engine sidecar unavailable: ${messageOf(err)}`)
      },
    )

    this.starting = attempt
    return attempt
  }

  /** Stop the sidecar and fail anything still in flight. Idempotent. */
  async close(): Promise<void> {
    const child = this.child
    this.child = null
    this.starting = null
    this.failPending('the sketch engine sidecar was closed')
    if (!child) return
    try {
      await child.kill()
    } catch (err) {
      this.onDiagnostic(`failed to stop sidecar: ${messageOf(err)}`)
    }
  }

  private handleExit(info: { code: number | null; message?: string }) {
    this.child = null
    this.starting = null
    this.stdoutBuffer = ''
    const detail = info.message ?? `exit code ${info.code ?? 'unknown'}`
    const stderr = this.recentStderr.join('\n').trim()
    this.failPending(
      `the sketch engine sidecar stopped (${detail})${stderr === '' ? '' : `: ${stderr}`}`,
    )
  }

  private failPending(reason: string) {
    if (this.pendingRequests.size === 0) return
    const inflight = [...this.pendingRequests.entries()]
    this.pendingRequests.clear()
    for (const [id, pending] of inflight) {
      pending.reject(new Error(`${pending.method} (${id}) failed: ${reason}`))
    }
  }

  // ── stream handling ───────────────────────────────────────────────────────

  private handleStderr(chunk: string) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      this.recentStderr.push(trimmed)
      if (this.recentStderr.length > 20) this.recentStderr.shift()
      this.onDiagnostic(trimmed)
    }
  }

  /** Reassemble lines from an arbitrarily chunked stdout stream. */
  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk

    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.handleStdoutLine(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }

    // A terminator-less remainder is a frame only if it is complete JSON.
    const rest = this.stdoutBuffer.trim()
    if (rest !== '' && parseJson(rest) !== null) {
      this.stdoutBuffer = ''
      this.handleStdoutLine(rest)
    }
  }

  protected handleStdoutLine(line: string) {
    const trimmed = line.trim()
    if (trimmed === '') return

    const decoded = parseJson(trimmed)
    if (decoded === null) {
      // Not protocol. The CLI writes only frames to stdout, so this is noise from
      // the runtime — a diagnostic, not a failure.
      this.onDiagnostic(`ignored non-JSON stdout line: ${trimmed.slice(0, 200)}`)
      return
    }

    const frame = decoded.parsed
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return
    const record = frame as Record<string, unknown>

    if (record['kind'] === 'event' && record['ok'] === undefined) {
      const event = record['event']
      if (event !== null && typeof event === 'object') this.bus.emit(event as SketchEvent)
      return
    }

    if (typeof record['ok'] !== 'boolean' || !('id' in record)) return

    const id = record['id']
    const key = typeof id === 'string' || typeof id === 'number' ? String(id) : ''
    const pending = this.pendingRequests.get(key)
    if (!pending) {
      this.onDiagnostic(`response for unknown request id: ${key === '' ? 'null' : key}`)
      return
    }

    this.pendingRequests.delete(key)
    if (record['ok'] === true) {
      pending.resolve(record['result'])
      return
    }

    const error = typeof record['error'] === 'string' ? record['error'] : undefined
    const code = typeof record['code'] === 'string' ? record['code'] : undefined
    pending.reject(new Error(error ?? code ?? `${pending.method} failed`))
  }

  // ── requests ──────────────────────────────────────────────────────────────

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const child = await this.ensureStarted()
    const id = `req-${++this.seq}`

    const settled = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      })
      if (signal) {
        const abort = () => {
          // Forget the request so a late frame cannot resolve it. There is no
          // cancel verb on the wire; see `testProvider` for what that means.
          this.pendingRequests.delete(id)
          const error = new Error(`${method} was cancelled`)
          error.name = 'AbortError'
          reject(error)
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }
    })

    try {
      await child.write(`${JSON.stringify({ id, method, params })}\n`)
    } catch (err) {
      this.pendingRequests.delete(id)
      throw new Error(`failed to send '${method}' to the sketch engine sidecar: ${messageOf(err)}`)
    }

    return settled
  }

  private withRoot(params: Record<string, unknown>): Record<string, unknown> {
    return this.root === undefined ? params : { ...params, root: this.root }
  }

  /**
   * Liveness against the real engine. REJECTS when the sidecar cannot be reached,
   * so the failure reaches the UI with its cause attached.
   */
  async ping(): Promise<PingResult> {
    const result = (await this.call<unknown>('ping', {})) as
      | { ok?: unknown; version?: unknown }
      | undefined

    const version = typeof result?.version === 'string' ? result.version : 'unknown'
    return {
      ok: result?.ok !== false,
      version,
      transport: 'stdio',
    }
  }

  async run(task: Task, options: RunOptions = {}): Promise<RunResult> {
    return this.call<RunResult>('run', {
      task,
      // The invocation-time credential is merged HERE and only here, so the persisted
      // settings entry stays key-free. No provider means no key on the wire either:
      // an apiKey with nothing to authenticate against is a secret with no purpose.
      ...(options.provider !== undefined
        ? {
            provider: {
              ...options.provider,
              ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
            },
          }
        : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
      ...(options.rememberRun !== undefined ? { rememberRun: options.rememberRun } : {}),
      ...(options.root !== undefined ? { root: options.root } : this.root !== undefined ? { root: this.root } : {}),
      ...(options.reviewEdits !== undefined ? { reviewEdits: options.reviewEdits } : {}),
      // Omitted means the single-agent path, byte for byte what this transport sent before
      // Phase 10. Sending `strategy: 'single'` by default would put a dispatcher ladder in
      // every log for a decision nobody made.
      ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
      ...(options.escalate !== undefined ? { escalate: options.escalate } : {}),
      // Retrieval and the spend ceiling are both opt-in on the wire. Forwarding them
      // exactly as given keeps the engine's "absent means off" contract intact while
      // letting the surface that spends the money choose (see runDefaults.ts).
      ...(options.contextBudgetTokens !== undefined
        ? { contextBudgetTokens: options.contextBudgetTokens }
        : {}),
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
    })
  }

  async cancel(runId: string): Promise<CancelResult> {
    // No root: a run id is not a path, and the registry it addresses is per-engine.
    return this.call<CancelResult>('cancel', { runId })
  }

  async reply(runId: string, answer: string): Promise<ReplyResult> {
    return this.call<ReplyResult>('reply', { runId, answer })
  }

  async eval(cases: EvalCase[]): Promise<EvalResult[]> {
    // The engine answers `{ results, mean }`; the seam is the array.
    const result = await this.call<unknown>('eval', this.withRoot({ cases }))

    if (Array.isArray(result)) return result as EvalResult[]
    if (result !== null && typeof result === 'object') {
      const results = (result as { results?: unknown }).results
      if (Array.isArray(results)) return results as EvalResult[]
    }
    throw new Error("the sketch engine returned no 'results' for eval")
  }

  async captureEval(params: {
    run: Partial<RunResult>
    want?: { checks?: unknown[] }
    evalsPath?: string
  }): Promise<EvalCase> {
    return this.call<EvalCase>('capture-eval', { ...params })
  }

  // ── git ───────────────────────────────────────────────────────────────────
  //
  // Straight pass-through to the five `git-*` methods. The root travels in every
  // frame because the engine requires it: this client's own `root` option is the
  // sidecar's default for runs, not a substitute for the repository the panel is
  // looking at.

  async gitStatus(params: { root: string }): Promise<GitStatusResult> {
    return this.call<GitStatusResult>('git-status', { root: params.root })
  }

  async gitDiff(params: { root: string; path?: string; staged?: boolean }): Promise<string> {
    const result = await this.call<{ diff?: unknown }>('git-diff', {
      root: params.root,
      ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.staged === true ? { staged: true } : {}),
    })
    return typeof result?.diff === 'string' ? result.diff : ''
  }

  async gitStage(params: { root: string; paths: string[] }): Promise<GitStatusResult> {
    return this.call<GitStatusResult>('git-stage', { root: params.root, paths: params.paths })
  }

  async gitUnstage(params: { root: string; paths: string[] }): Promise<GitStatusResult> {
    return this.call<GitStatusResult>('git-unstage', { root: params.root, paths: params.paths })
  }

  async gitCommit(params: {
    root: string
    message: string
  }): Promise<{ output: string; status: GitStatusResult }> {
    return this.call<{ output: string; status: GitStatusResult }>('git-commit', {
      root: params.root,
      message: params.message,
    })
  }

  // ── provider settings ─────────────────────────────────────────────────────

  async providerCatalog(): Promise<ProviderCatalogResult> {
    return this.call<ProviderCatalogResult>('provider-catalog', {})
  }

  async saveProviderSettings(params: {
    settings: ProviderSettingsFile
  }): Promise<{ settings: ProviderSettingsFile; path: string }> {
    return this.call<{ settings: ProviderSettingsFile; path: string }>('provider-config-save', {
      settings: params.settings,
    })
  }

  /**
   * CANCELLATION IS LOCAL, AND THIS IS THE HONEST DESCRIPTION OF IT. The protocol
   * has no cancel verb (recorded as a spec gap), so aborting drops the pending
   * request here: the caller stops waiting immediately and a late response frame is
   * discarded by request id rather than resolving a promise nobody wants. The
   * engine's own request keeps running until its timeout — it is one GET, and the
   * engine already bounds it.
   */
  async testProvider(
    params: ProviderTestRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderTestResult> {
    return this.call<ProviderTestResult>(
      'provider-test',
      {
        provider: params.provider,
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      },
      options.signal,
    )
  }

  // ── architecture ──────────────────────────────────────────────────────────
  //
  // Pass-through to the one `architecture` method. The root travels in the frame
  // for the same reason it does for git: this client's own `root` is the sidecar's
  // default for runs, not a substitute for the project the panel has open.

  async architecture(params: {
    root: string
    index?: boolean
    maxNodes?: number
    maxEdges?: number
  }): Promise<ArchitectureResult> {
    return this.call<ArchitectureResult>('architecture', {
      root: params.root,
      ...(params.index === true ? { index: true } : {}),
      ...(params.maxNodes !== undefined ? { maxNodes: params.maxNodes } : {}),
      ...(params.maxEdges !== undefined ? { maxEdges: params.maxEdges } : {}),
    })
  }

  // ── project search ────────────────────────────────────────────────────────
  //
  // Pass-through to the one `project-search` method, which is the one lexical
  // channel. The panel no longer spawns anything itself, so `rg` stayed off the Rust
  // `command_policy` allowlist while search got faster.

  async projectSearch(params: {
    root: string
    query: string
    matchCase?: boolean
    wholeWord?: boolean
    maxHits?: number
  }): Promise<ProjectSearchResult> {
    return this.call<ProjectSearchResult>('project-search', {
      root: params.root,
      query: params.query,
      ...(params.matchCase === true ? { matchCase: true } : {}),
      ...(params.wholeWord === true ? { wholeWord: true } : {}),
      ...(params.maxHits !== undefined ? { maxHits: params.maxHits } : {}),
    })
  }

  // ── skills ────────────────────────────────────────────────────────────────
  //
  // Pass-through to the three skills methods. `registryDir` is forwarded only when
  // the caller supplied one: the engine has no path-relative default (a bundled
  // sidecar has no package layout to be relative to), so it answers honestly that
  // no registry is configured rather than guessing at one.

  async skillsCatalog(params: { root: string; registryDir?: string }): Promise<SkillsCatalogResult> {
    return this.call<SkillsCatalogResult>('skills-catalog', {
      root: params.root,
      ...(params.registryDir !== undefined ? { registryDir: params.registryDir } : {}),
    })
  }

  async skillInstall(params: {
    root: string
    name: string
    registryDir?: string
  }): Promise<SkillInstallResult> {
    return this.call<SkillInstallResult>('skill-install', {
      root: params.root,
      name: params.name,
      ...(params.registryDir !== undefined ? { registryDir: params.registryDir } : {}),
    })
  }

  async skillTrain(params: {
    root: string
    name: string
    epochs?: number
    guidance?: string
    write?: boolean
    maxCalls?: number
    maxTokens?: number
  }): Promise<SkillTrainResult> {
    return this.call<SkillTrainResult>('skill-train', {
      root: params.root,
      name: params.name,
      ...(params.epochs !== undefined ? { epochs: params.epochs } : {}),
      ...(params.guidance !== undefined ? { guidance: params.guidance } : {}),
      ...(params.write === true ? { write: true } : {}),
      ...(params.maxCalls !== undefined ? { maxCalls: params.maxCalls } : {}),
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    })
  }

  async skillPromote(params: { root: string; name: string }): Promise<SkillPromoteResult> {
    return this.call<SkillPromoteResult>('skill-promote', params)
  }

  // ── verification contract and MCP ─────────────────────────────────────────
  //
  // `run` is forwarded only when true, so the wire carries the deliberate act and not
  // an explicit `false` that reads like a decision the caller made about running.

  async verify(params: {
    root: string
    run?: boolean
    continueOnFailure?: boolean
    runId?: string
  }): Promise<VerifyContractResult> {
    return this.call<VerifyContractResult>('verify', {
      root: params.root,
      ...(params.run === true ? { run: true } : {}),
      ...(params.continueOnFailure !== undefined
        ? { continueOnFailure: params.continueOnFailure }
        : {}),
      ...(params.runId !== undefined ? { runId: params.runId } : {}),
    })
  }

  async strategyCatalog(options: { root?: string } = {}): Promise<StrategyCatalogResult> {
    return this.call<StrategyCatalogResult>('strategy-catalog', this.withRoot({ ...options }))
  }

  async mcpCatalog(): Promise<McpCatalogResult> {
    return this.call<McpCatalogResult>('mcp-catalog', {})
  }

  async cost(params: { root: string; runId?: string }): Promise<CostReport> {
    return this.call<CostReport>('cost', {
      root: params.root,
      ...(params.runId !== undefined ? { runId: params.runId } : {}),
    })
  }

  async benchmarkReport(params: { root: string }): Promise<BenchmarkReportResult> {
    return this.call<BenchmarkReportResult>('benchmark-report', { root: params.root })
  }

  // ── memory ────────────────────────────────────────────────────────────────

  async memoryList(params: { root: string; kind?: string }): Promise<MemoryListResult> {
    return this.call<MemoryListResult>('memory-list', {
      root: params.root,
      ...(params.kind !== undefined ? { kind: params.kind } : {}),
    })
  }

  async memorySearch(params: {
    root: string
    query: string
    topK?: number
    includeSuperseded?: boolean
  }): Promise<MemorySearchResult> {
    return this.call<MemorySearchResult>('memory-search', {
      root: params.root,
      query: params.query,
      ...(params.topK !== undefined ? { topK: params.topK } : {}),
      ...(params.includeSuperseded === true ? { includeSuperseded: true } : {}),
    })
  }

  async memoryRemember(params: {
    root: string
    kind: string
    text: string
    key?: string
    subject?: string
    tags?: string[]
    reason?: string
    source?: string
  }): Promise<MemoryRememberResult> {
    return this.call<MemoryRememberResult>('memory-remember', {
      root: params.root,
      kind: params.kind,
      text: params.text,
      ...(params.key !== undefined ? { key: params.key } : {}),
      ...(params.subject !== undefined ? { subject: params.subject } : {}),
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(params.source !== undefined ? { source: params.source } : {}),
    })
  }

  async memorySupersede(params: {
    root: string
    id: string
    reason: string
    replacementText?: string
  }): Promise<MemorySupersedeResult> {
    return this.call<MemorySupersedeResult>('memory-supersede', {
      root: params.root,
      id: params.id,
      reason: params.reason,
      ...(params.replacementText !== undefined ? { replacementText: params.replacementText } : {}),
    })
  }

  subscribe(handler: EventHandler): Unsubscribe {
    return this.bus.subscribe(handler)
  }
}
