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
  SkillUninstallResult,
  SkillTrainResult,
  SkillPromoteResult,
  VerifyContractResult,
  McpCatalogResult,
  PrivacyStatus,
  LocalModelsResult,
  LocalModelPull,
  UserMcpServersResult,
  UserMcpTestResult,
  StrategyCatalogResult,
  CostReport,
  UsageSummary,
  MemoryListResult,
  MemorySearchResult,
  MemoryRememberResult,
  MemorySupersedeResult,
  BenchmarkReportResult,
  ProviderCatalogResult,
  ProviderTestRequest,
  ProviderModelsResult,
  OAuthStartResult,
  OAuthWaitResult,
  ChatGPTLoginOutcome,
  ChatGPTLoginStart,
  ChatGPTModelsResult,
  ChatGPTStatus,
  UndoRunResult,
  FindInFilesParams,
  FindInFilesResult,
  ReplaceInFilesParams,
  ReplaceInFilesResult,
  CompletionResult,
  InlineEditResult,
  ProjectFilesResult,
  CommandsListResult,
  TerminalStartResult,
  TerminalReadResult,
  FsDeleteResult,
  FsWatchBatch,
  GitBranchesResult,
  GitCommitSummary,
} from './client'
import { completionRequestId, createEventBus } from './client'
import type {
  Task,
  RunResult,
  EvalCase,
  EvalResult,
  GitStatusResult,
  ProjectSearchResult,
  ProviderSettingsEntry,
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
      ...(options.rememberRun !== undefined ? { rememberRun: options.rememberRun } : {}),
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
      ...(options.projectTools !== undefined ? { projectTools: options.projectTools } : {}),
      ...(options.autoIndex !== undefined ? { autoIndex: options.autoIndex } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.verifyPolicy === true ? { verifyPolicy: true } : {}),
      ...(options.history !== undefined && options.history.length > 0 ? { history: options.history } : {}),
      ...(options.readOnly === true ? { readOnly: true } : {}),
      ...(options.commands !== undefined ? { commands: options.commands } : {}),
      ...(options.autonomous === true ? { autonomous: true } : {}),
      ...(options.autoSkills === true ? { autoSkills: true } : {}),
      ...(options.userMcpServers !== undefined && options.userMcpServers.length > 0 ? { userMcpServers: options.userMcpServers } : {}),
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

  async skillUninstall(params: { root: string; name: string }): Promise<SkillUninstallResult> {
    return this.callMethod<SkillUninstallResult>('skill-uninstall', {
      root: params.root,
      name: params.name,
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
    mode?: 'rewrite' | 'edits'
    maxEdits?: number
  }): Promise<SkillTrainResult> {
    return this.callMethod<SkillTrainResult>('skill-train', {
      root: params.root,
      name: params.name,
      ...(params.epochs !== undefined ? { epochs: params.epochs } : {}),
      ...(params.guidance !== undefined ? { guidance: params.guidance } : {}),
      ...(params.write === true ? { write: true } : {}),
      ...(params.maxCalls !== undefined ? { maxCalls: params.maxCalls } : {}),
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.maxEdits !== undefined ? { maxEdits: params.maxEdits } : {}),
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

  async privacyStatus(options: { root?: string } = {}): Promise<PrivacyStatus> {
    return this.callMethod<PrivacyStatus>('privacy-status', { ...(options.root !== undefined ? { root: options.root } : {}) })
  }

  async privacySet(offline: boolean, options: { root?: string } = {}): Promise<PrivacyStatus> {
    return this.callMethod<PrivacyStatus>('privacy-set', { offline, ...(options.root !== undefined ? { root: options.root } : {}) })
  }

  async localModels(options: { baseUrl?: string } = {}): Promise<LocalModelsResult> {
    return this.callMethod<LocalModelsResult>('local-models', { ...options })
  }

  async mcpServers(options: { root?: string } = {}): Promise<UserMcpServersResult> {
    return this.callMethod<UserMcpServersResult>('mcp-servers', { ...options })
  }

  async mcpServerSave(params: { scope: 'global' | 'project'; name: string; command: string; args?: string[]; env?: Record<string, string>; root?: string }): Promise<UserMcpServersResult & { saved: string }> {
    return this.callMethod<UserMcpServersResult & { saved: string }>('mcp-server-save', { ...params })
  }

  async mcpServerRemove(params: { scope: 'global' | 'project'; name: string; root?: string }): Promise<UserMcpServersResult & { removed: boolean }> {
    return this.callMethod<UserMcpServersResult & { removed: boolean }>('mcp-server-remove', { ...params })
  }

  async mcpServerTrust(params: { name: string; trusted: boolean; root?: string }): Promise<UserMcpServersResult> {
    return this.callMethod<UserMcpServersResult>('mcp-server-trust', { ...params })
  }

  async mcpServerTest(params: { name: string; root?: string }): Promise<UserMcpTestResult> {
    return this.callMethod<UserMcpTestResult>('mcp-server-test', { ...params })
  }

  async localModelPull(params: { model: string; baseUrl?: string; confirmed: true }): Promise<LocalModelPull> {
    return this.callMethod<LocalModelPull>('local-model-pull', { ...params })
  }

  async localModelPullStatus(id: string): Promise<LocalModelPull> {
    return this.callMethod<LocalModelPull>('local-model-pull-status', { id })
  }

  async localModelPullCancel(id: string): Promise<{ id: string; cancelled: boolean }> {
    return this.callMethod<{ id: string; cancelled: boolean }>('local-model-pull-cancel', { id })
  }

  async localModelDelete(params: { model: string; baseUrl?: string; confirmed: true }): Promise<{ ok: boolean; model: string }> {
    return this.callMethod<{ ok: boolean; model: string }>('local-model-delete', { ...params })
  }

  async localModelLoad(params: { model: string; baseUrl?: string; unload?: boolean }): Promise<{ ok: boolean; model: string; loaded: boolean }> {
    return this.callMethod<{ ok: boolean; model: string; loaded: boolean }>('local-model-load', { ...params })
  }

  async cost(params: { root: string; runId?: string }): Promise<CostReport> {
    return this.callMethod<CostReport>('cost', {
      root: params.root,
      ...(params.runId !== undefined ? { runId: params.runId } : {}),
    })
  }

  async costUsage(params: { home?: string } = {}): Promise<UsageSummary> {
    return this.callMethod<UsageSummary>('cost-usage', { ...(params.home !== undefined ? { home: params.home } : {}) })
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

  // ── connecting a model ────────────────────────────────────────────────────

  async providerModels(params: {
    provider: { id: string; kind: ProviderSettingsFile['providers'][number]['kind']; baseUrl: string; apiKey?: string }
    timeoutMs?: number
  }): Promise<ProviderModelsResult> {
    return this.callMethod<ProviderModelsResult>('provider-models', {
      provider: params.provider,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    })
  }

  async oauthStart(params: { timeoutMs?: number } = {}): Promise<OAuthStartResult> {
    return this.callMethod<OAuthStartResult>('oauth-start', { ...params })
  }

  async oauthWait(params: { id: string }): Promise<OAuthWaitResult> {
    return this.callMethod<OAuthWaitResult>('oauth-wait', { id: params.id })
  }

  async oauthCancel(params: { id: string }): Promise<{ id: string; cancelled: boolean }> {
    return this.callMethod<{ id: string; cancelled: boolean }>('oauth-cancel', { id: params.id })
  }

  async chatgptStatus(): Promise<ChatGPTStatus> {
    return this.callMethod<ChatGPTStatus>('chatgpt-status', {})
  }

  async chatgptLoginStart(params: { mode: 'browser' | 'device' }): Promise<ChatGPTLoginStart> {
    return this.callMethod<ChatGPTLoginStart>('chatgpt-login-start', { mode: params.mode })
  }

  async chatgptLoginWait(params: { id: string }): Promise<ChatGPTLoginOutcome> {
    return this.callMethod<ChatGPTLoginOutcome>('chatgpt-login-wait', { id: params.id })
  }

  async chatgptLoginCancel(params: { id: string }): Promise<{ id: string; cancelled: boolean }> {
    return this.callMethod<{ id: string; cancelled: boolean }>('chatgpt-login-cancel', { id: params.id })
  }

  async chatgptLogout(): Promise<{ signedOut: boolean; revoked: boolean }> {
    return this.callMethod<{ signedOut: boolean; revoked: boolean }>('chatgpt-logout', {})
  }

  async chatgptModels(): Promise<ChatGPTModelsResult> {
    return this.callMethod<ChatGPTModelsResult>('chatgpt-models', {})
  }

  async undoRun(params: { root: string; runId: string }): Promise<UndoRunResult> {
    return this.callMethod<UndoRunResult>('undo-run', { root: params.root, runId: params.runId })
  }

  async findInFiles(params: FindInFilesParams): Promise<FindInFilesResult> {
    return this.callMethod<FindInFilesResult>('find-in-files', { ...params })
  }

  async replaceInFiles(params: ReplaceInFilesParams): Promise<ReplaceInFilesResult> {
    return this.callMethod<ReplaceInFilesResult>('replace-in-files', { ...params })
  }

  async gitClone(params: { url: string; parent: string; name?: string }): Promise<{ path: string; name: string }> {
    return this.callMethod<{ path: string; name: string }>('git-clone', { ...params })
  }

  async complete(
    params: Parameters<NonNullable<SketchClient['complete']>>[0],
    options: { signal?: AbortSignal } = {},
  ): Promise<CompletionResult> {
    const requestId = completionRequestId()
    const { apiKey, provider, ...rest } = params
    const onAbort = () => {
      void this.cancel(requestId).catch(() => {})
    }
    if (options.signal?.aborted) return { text: '', cancelled: true }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.callMethod<CompletionResult>('complete', {
        ...rest,
        requestId,
        provider: { ...provider, ...(apiKey !== undefined ? { apiKey } : {}) },
      })
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async inlineEdit(
    params: Parameters<NonNullable<SketchClient['inlineEdit']>>[0],
    options: { signal?: AbortSignal } = {},
  ): Promise<InlineEditResult> {
    const requestId = completionRequestId()
    const { apiKey, provider, ...rest } = params
    const onAbort = () => {
      void this.cancel(requestId).catch(() => {})
    }
    if (options.signal?.aborted) return { text: '', cancelled: true }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.callMethod<InlineEditResult>('inline-edit', {
        ...rest,
        requestId,
        provider: { ...provider, ...(apiKey !== undefined ? { apiKey } : {}) },
      })
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async projectFiles(params: { root: string }): Promise<ProjectFilesResult> {
    return this.callMethod<ProjectFilesResult>('project-files', { root: params.root })
  }

  async commandsList(params: { root?: string } = {}): Promise<CommandsListResult> {
    return this.callMethod<CommandsListResult>('commands-list', params.root !== undefined ? { root: params.root } : {})
  }

  async gitDiscard(params: { root: string; paths: string[] }): Promise<GitStatusResult> {
    return this.callMethod<GitStatusResult>('git-discard', { root: params.root, paths: params.paths })
  }

  async gitBranches(params: { root: string }): Promise<GitBranchesResult> {
    return this.callMethod<GitBranchesResult>('git-branches', { root: params.root })
  }

  async gitSwitch(params: { root: string; branch: string; create?: boolean }): Promise<GitStatusResult> {
    return this.callMethod<GitStatusResult>('git-switch', { ...params })
  }

  async gitPush(params: { root: string }): Promise<{ output: string; status: GitStatusResult }> {
    return this.callMethod<{ output: string; status: GitStatusResult }>('git-push', { root: params.root })
  }

  async gitPull(params: { root: string }): Promise<{ output: string; status: GitStatusResult }> {
    return this.callMethod<{ output: string; status: GitStatusResult }>('git-pull', { root: params.root })
  }

  async gitFetch(params: { root: string }): Promise<GitStatusResult> {
    return this.callMethod<GitStatusResult>('git-fetch', { root: params.root })
  }

  async gitLog(params: { root: string; limit?: number }): Promise<{ commits: GitCommitSummary[] }> {
    return this.callMethod<{ commits: GitCommitSummary[] }>('git-log', { ...params })
  }

  async gitShow(params: { root: string; path: string; ref?: 'HEAD' | 'index' }): Promise<{ content: string | null }> {
    return this.callMethod<{ content: string | null }>('git-show', {
      root: params.root,
      path: params.path,
      ...(params.ref !== undefined ? { ref: params.ref } : {}),
    })
  }

  async gitCommitMessage(params: {
    root: string
    provider: ProviderSettingsEntry
    apiKey?: string
  }): Promise<{ message: string; source: 'staged' | 'unstaged'; model?: string }> {
    return this.callMethod<{ message: string; source: 'staged' | 'unstaged'; model?: string }>('git-commit-message', { ...params })
  }

  async termStart(params: { root: string; cwd?: string; line: string; confirmed: true }): Promise<TerminalStartResult> {
    return this.callMethod<TerminalStartResult>('term-start', { ...params })
  }

  async termRead(params: { id: string; since?: number }): Promise<TerminalReadResult> {
    return this.callMethod<TerminalReadResult>('term-read', { ...params })
  }

  async termWrite(params: { id: string; data?: string; end?: boolean }): Promise<{ ok: boolean }> {
    return this.callMethod<{ ok: boolean }>('term-write', { ...params })
  }

  async termKill(params: { id: string }): Promise<{ stopped: boolean }> {
    return this.callMethod<{ stopped: boolean }>('term-kill', { ...params })
  }

  async fsWatch(params: { root: string; since?: number; timeoutMs?: number }, signal?: AbortSignal): Promise<FsWatchBatch> {
    return this.callMethod<FsWatchBatch>('fs-watch', { ...params }, signal)
  }

  async osReveal(params: { root: string; path: string }): Promise<{ label: string }> {
    return this.callMethod<{ label: string }>('os-reveal', { ...params })
  }

  async osOpenTerminal(params: { root: string; path?: string }): Promise<{ label: string }> {
    return this.callMethod<{ label: string }>('os-open-terminal', { ...params })
  }

  async fsCreateFile(params: { root: string; path: string; content?: string }): Promise<{ path: string }> {
    return this.callMethod<{ path: string }>('fs-create-file', { ...params })
  }

  async fsCreateFolder(params: { root: string; path: string }): Promise<{ path: string }> {
    return this.callMethod<{ path: string }>('fs-create-folder', { ...params })
  }

  async fsRename(params: { root: string; from: string; to: string }): Promise<{ from: string; to: string }> {
    return this.callMethod<{ from: string; to: string }>('fs-rename', { root: params.root, source: params.from, target: params.to })
  }

  async fsDelete(params: { root: string; path: string; trash?: boolean }): Promise<FsDeleteResult> {
    return this.callMethod<FsDeleteResult>('fs-delete', { ...params })
  }

  subscribe(handler: EventHandler): Unsubscribe {
    return this.bus.subscribe(handler)
  }
}
