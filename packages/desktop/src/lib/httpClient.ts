import type {
  SketchClient,
  PingResult,
  EventHandler,
  Unsubscribe,
  TransportKind,
  RunOptions,
  ArchitectureResult,
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
  ProviderSettingsFile,
  ProviderTestResult,
  SketchEvent,
} from './contracts'

export interface HttpSketchClientOptions {
  baseUrl?: string
}

export class HttpSketchClient implements SketchClient {
  readonly transport: TransportKind = 'http'
  private readonly baseUrl: string
  private readonly bus = createEventBus()
  private eventSource: EventSource | null = null

  constructor(options: HttpSketchClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '')
    this.initSse()
  }

  private initSse() {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return
    try {
      const sseUrl = `${this.baseUrl}/__sketch/events`
      this.eventSource = new EventSource(sseUrl)
      this.eventSource.onmessage = (msg) => {
        try {
          const event: SketchEvent = JSON.parse(msg.data)
          this.bus.emit(event)
        } catch {
          // Skip unparseable event frames
        }
      }
    } catch {
      // SSE connection error fallback
    }
  }

  private async callMethod<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.baseUrl}/__sketch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Math.random().toString(36).substring(2), method, params }),
      ...(signal !== undefined ? { signal } : {}),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    }

    const data = await res.json()
    if (!data.ok) {
      throw new Error(data.error ?? data.code ?? `RPC method '${method}' failed`)
    }
    return data.result as T
  }

  async ping(): Promise<PingResult> {
    const res = await this.callMethod<{ version: string }>('ping')
    return {
      ok: true,
      version: res.version ?? '0.1.0',
      transport: 'http',
    }
  }

  async run(task: Task, options: RunOptions = {}): Promise<RunResult> {
    return this.callMethod<RunResult>('run', {
      task,
      ...(options.root !== undefined ? { root: options.root } : {}),
      ...(options.reviewEdits !== undefined ? { reviewEdits: options.reviewEdits } : {}),
    })
  }

  async eval(cases: EvalCase[]): Promise<EvalResult[]> {
    return this.callMethod<EvalResult[]>('eval', { cases })
  }

  async captureEval(params: { run: Partial<RunResult>; want?: { checks?: unknown[] }; evalsPath?: string }): Promise<EvalCase> {
    return this.callMethod<EvalCase>('capture-eval', params)
  }

  // ── git ───────────────────────────────────────────────────────────────────
  //
  // The dev bridge dispatches the same `git-*` methods the sidecar does, so the
  // Git panel is real in the browser too. Nothing here parses porcelain: the
  // engine already did (see packages/core/src/tools/git.ts).

  async gitStatus(params: { root: string }): Promise<GitStatusResult> {
    return this.callMethod<GitStatusResult>('git-status', { root: params.root })
  }

  async gitDiff(params: { root: string; path?: string; staged?: boolean }): Promise<string> {
    const result = await this.callMethod<{ diff?: unknown }>('git-diff', {
      root: params.root,
      ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.staged === true ? { staged: true } : {}),
    })
    return typeof result?.diff === 'string' ? result.diff : ''
  }

  async gitStage(params: { root: string; paths: string[] }): Promise<GitStatusResult> {
    return this.callMethod<GitStatusResult>('git-stage', params)
  }

  async gitUnstage(params: { root: string; paths: string[] }): Promise<GitStatusResult> {
    return this.callMethod<GitStatusResult>('git-unstage', params)
  }

  async gitCommit(params: {
    root: string
    message: string
  }): Promise<{ output: string; status: GitStatusResult }> {
    return this.callMethod<{ output: string; status: GitStatusResult }>('git-commit', params)
  }

  // ── provider settings ─────────────────────────────────────────────────────
  //
  // The dev bridge dispatches the same `provider-*` methods the sidecar does, so the
  // Provider Settings panel is real in the browser too. The catalog is the engine's
  // registry; nothing here restates it.

  async providerCatalog(): Promise<ProviderCatalogResult> {
    return this.callMethod<ProviderCatalogResult>('provider-catalog', {})
  }

  async saveProviderSettings(params: {
    settings: ProviderSettingsFile
  }): Promise<{ settings: ProviderSettingsFile; path: string }> {
    return this.callMethod<{ settings: ProviderSettingsFile; path: string }>(
      'provider-config-save',
      { settings: params.settings },
    )
  }

  /** Abort ends the wait and the HTTP request; the engine bounds its own GET. */
  async testProvider(
    params: ProviderTestRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderTestResult> {
    return this.callMethod<ProviderTestResult>(
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
  // The dev bridge dispatches the same `architecture` method the sidecar does, so
  // the Live Architecture panel is real in the browser too. Nothing here derives a
  // view: the engine already did (packages/core/src/context/architecture.ts).

  async architecture(params: {
    root: string
    index?: boolean
    maxNodes?: number
    maxEdges?: number
  }): Promise<ArchitectureResult> {
    return this.callMethod<ArchitectureResult>('architecture', {
      root: params.root,
      ...(params.index === true ? { index: true } : {}),
      ...(params.maxNodes !== undefined ? { maxNodes: params.maxNodes } : {}),
      ...(params.maxEdges !== undefined ? { maxEdges: params.maxEdges } : {}),
    })
  }

  subscribe(handler: EventHandler): Unsubscribe {
    return this.bus.subscribe(handler)
  }
}
