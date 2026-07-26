import type { SketchClient, PingResult, EventHandler, Unsubscribe, TransportKind } from './client'
import { createEventBus } from './client'
import type { Task, RunResult, EvalCase, EvalResult, SketchEvent } from './contracts'

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

  private async callMethod<T>(method: string, params?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/__sketch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Math.random().toString(36).substring(2), method, params }),
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

  async run(task: Task): Promise<RunResult> {
    return this.callMethod<RunResult>('run', { task })
  }

  async eval(cases: EvalCase[]): Promise<EvalResult[]> {
    return this.callMethod<EvalResult[]>('eval', { cases })
  }

  async captureEval(params: { run: Partial<RunResult>; want?: { checks?: unknown[] }; evalsPath?: string }): Promise<EvalCase> {
    return this.callMethod<EvalCase>('capture-eval', params)
  }

  subscribe(handler: EventHandler): Unsubscribe {
    return this.bus.subscribe(handler)
  }
}
