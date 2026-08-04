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
      // Merged here only. See the note on the stdio transport.
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
      ...(options.root !== undefined ? { root: options.root } : {}),
      ...(options.reviewEdits !== undefined ? { reviewEdits: options.reviewEdits } : {}),
      // Omitted means the single-agent path, unchanged. See the note on the stdio transport.
      ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
      ...(options.escalate !== undefined ? { escalate: options.escalate } : {}),
      // See the note on the stdio transport: absent still means off on the wire.
      ...(options.contextBudgetTokens !== undefined
        ? { contextBudgetTokens: options.contextBudgetTokens }
        : {}),
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
    })
  }

  async cancel(runId: string): Promise<CancelResult> {
    return this.callMethod<CancelResult>('cancel', { runId })
  }

  async reply(runId: string, answer: string): Promise<ReplyResult> {
    return this.callMethod<ReplyResult>('reply', { runId, answer })
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

  // ── project search ────────────────────────────────────────────────────────
  //
  // The dev bridge dispatches the same `project-search` method the sidecar does, so
  // the Search panel is real in the browser too — which the deleted `git grep` path
  // never was, since it needed the native command bridge to spawn anything.

  async projectSearch(params: {
    root: string
    query: string
    matchCase?: boolean
    wholeWord?: boolean
    maxHits?: number
  }): Promise<ProjectSearchResult> {
    return this.callMethod<ProjectSearchResult>('project-search', {
      root: params.root,
      query: params.query,
      ...(params.matchCase === true ? { matchCase: true } : {}),
      ...(params.wholeWord === true ? { wholeWord: true } : {}),
      ...(params.maxHits !== undefined ? { maxHits: params.maxHits } : {}),
    })
  }

  // ── skills ────────────────────────────────────────────────────────────────
  //
  // The dev bridge dispatches the same three methods the sidecar does, so the
  // Skills surface is real in the browser too. Nothing here verifies a hash or
  // scores an eval: the engine does both.

  async skillsCatalog(params: { root: string; registryDir?: string }): Promise<SkillsCatalogResult> {
    return this.callMethod<SkillsCatalogResult>('skills-catalog', {
      root: params.root,
      ...(params.registryDir !== undefined ? { registryDir: params.registryDir } : {}),
    })
  }

  async skillInstall(params: {
    root: string
    name: string
    registryDir?: string
  }): Promise<SkillInstallResult> {
    return this.callMethod<SkillInstallResult>('skill-install', {
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
    return this.callMethod<SkillTrainResult>('skill-train', {
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
    return this.callMethod<SkillPromoteResult>('skill-promote', params)
  }

  // ── verification contract and MCP ─────────────────────────────────────────

  async verify(params: {
    root: string
    run?: boolean
    continueOnFailure?: boolean
    runId?: string
  }): Promise<VerifyContractResult> {
    return this.callMethod<VerifyContractResult>('verify', {
      root: params.root,
      ...(params.run === true ? { run: true } : {}),
      ...(params.continueOnFailure !== undefined
        ? { continueOnFailure: params.continueOnFailure }
        : {}),
      ...(params.runId !== undefined ? { runId: params.runId } : {}),
    })
  }

  async strategyCatalog(options: { root?: string } = {}): Promise<StrategyCatalogResult> {
    return this.callMethod<StrategyCatalogResult>('strategy-catalog', { ...options })
  }

  async mcpCatalog(): Promise<McpCatalogResult> {
    return this.callMethod<McpCatalogResult>('mcp-catalog', {})
  }

  async cost(params: { root: string; runId?: string }): Promise<CostReport> {
    return this.callMethod<CostReport>('cost', {
      root: params.root,
      ...(params.runId !== undefined ? { runId: params.runId } : {}),
    })
  }

  async benchmarkReport(params: { root: string }): Promise<BenchmarkReportResult> {
    return this.callMethod<BenchmarkReportResult>('benchmark-report', { root: params.root })
  }

  // ── memory ────────────────────────────────────────────────────────────────

  async memoryList(params: { root: string; kind?: string }): Promise<MemoryListResult> {
    return this.callMethod<MemoryListResult>('memory-list', {
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
    return this.callMethod<MemorySearchResult>('memory-search', {
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
    return this.callMethod<MemoryRememberResult>('memory-remember', {
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
    return this.callMethod<MemorySupersedeResult>('memory-supersede', {
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
