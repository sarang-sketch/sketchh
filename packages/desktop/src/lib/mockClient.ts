// MockSketchClient — the seam's first implementation.
//
// It exists so the Timeline and the Agent Console can be built and demoed before
// the sidecar lands (task 2.1). It fabricates NO panel fixtures: everything it
// produces is a real `SketchEvent` on the real stream, shaped exactly like the
// engine's, and every payload is derived from the task it was handed.
//
// It is deliberately honest about being a mock: `transport` is 'mock' and the
// model id it reports is 'mock/echo-1', so nothing on screen can be mistaken for
// a real provider response.
//
// Validates: Requirements 13.1, 13.2

import type {
  EvalCase,
  EvalResult,
  Message,
  RunResult,
  SketchEvent,
  Task,
  VerifyResult,
} from './contracts'
import { createEventBus, type EventHandler, type PingResult, type SketchClient } from './client'

export interface MockClientOptions {
  /** Delay between emitted events. Short by default; 0 in tests. */
  stepDelayMs?: number
  /** Injected for determinism. Defaults to `Date.now`. */
  clock?: () => number
  /** Injected for determinism. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

const MOCK_MODEL = 'mock/echo-1'
const DEFAULT_STEP_DELAY_MS = 120

/** One emitted step: the kind plus the payload the engine would attach. */
interface Step {
  kind: SketchEvent['kind']
  payload: Record<string, unknown>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class MockSketchClient implements SketchClient {
  readonly transport = 'mock' as const

  private readonly bus = createEventBus()
  private readonly stepDelayMs: number
  private readonly clock: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private runCounter = 0

  constructor(options: MockClientOptions = {}) {
    this.stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS
    this.clock = options.clock ?? (() => Date.now())
    this.sleep = options.sleep ?? defaultSleep
  }

  async ping(): Promise<PingResult> {
    return { ok: true, version: '0.1.0-mock', transport: this.transport }
  }

  subscribe(handler: EventHandler) {
    return this.bus.subscribe(handler)
  }

  async run(task: Task): Promise<RunResult> {
    const runId = this.nextRunId()
    const startedAt = this.clock()
    const finalText = `Applied the requested change: ${task.prompt}`

    const verify: VerifyResult[] = task.verify.map((command, index) => ({
      name: command.name,
      ok: true,
      exitCode: 0,
      stdout: `[${MOCK_MODEL}] ${command.cmd} ${(command.args ?? []).join(' ')}`.trim(),
      stderr: '',
      durationMs: 400 + index * 150,
    }))

    const planning: Message[] = [
      { role: 'system', content: 'You are Sketch. Write a plan before touching code.' },
      { role: 'user', content: task.prompt },
    ]
    const coding: Message[] = [
      ...planning,
      { role: 'assistant', content: 'Plan written to .sketch/plan/. Proceeding to edits.' },
      { role: 'user', content: 'Apply the plan.' },
    ]

    // The sequence the real agent loop produces: plan gate first, then the coding
    // turn, then verification, then completion.
    const steps: Step[] = [
      {
        kind: 'run_started',
        payload: {
          taskId: task.id,
          prompt: task.prompt,
          skillNames: task.skillNames ?? [],
          verify: task.verify.map((v) => v.name),
        },
      },
      { kind: 'llm_request', payload: { model: MOCK_MODEL, iteration: 1, messages: planning } },
      {
        kind: 'llm_response',
        payload: {
          model: MOCK_MODEL,
          iteration: 1,
          text: `Plan for "${task.prompt}":\n1. Locate the affected modules.\n2. Make the change.\n3. Verify.`,
          usage: { in: estimateTokens(planning), out: 96 },
        },
      },
      {
        kind: 'plan_written',
        payload: {
          runId,
          dir: `.sketch/plan/${runId}`,
          artifacts: ['prd.md', 'architecture.md', 'components.md', 'tests.md'],
        },
      },
      { kind: 'llm_request', payload: { model: MOCK_MODEL, iteration: 2, messages: coding } },
      {
        kind: 'llm_response',
        payload: {
          model: MOCK_MODEL,
          iteration: 2,
          text: finalText,
          usage: { in: estimateTokens(coding), out: 142 },
        },
      },
      { kind: 'verify_started', payload: { iteration: 2, commands: verify.map((v) => v.name) } },
      ...verify.map((result): Step => ({ kind: 'verify_result', payload: { ...result } })),
      {
        kind: 'run_completed',
        payload: {
          ok: true,
          iterations: 2,
          finalText,
          durationMs: this.clock() - startedAt,
        },
      },
    ]

    const events: SketchEvent[] = []
    for (const [index, step] of steps.entries()) {
      if (this.stepDelayMs > 0) await this.sleep(this.stepDelayMs)
      const event: SketchEvent = {
        id: `${runId}-${String(index + 1).padStart(3, '0')}`,
        ts: this.clock(),
        runId,
        kind: step.kind,
        payload: step.payload,
      }
      events.push(event)
      // Emitted as it happens, not at the end — the Timeline fills in live.
      this.bus.emit(event)
    }

    return { runId, ok: true, finalText, iterations: 2, verify, events }
  }

  async eval(cases: EvalCase[]): Promise<EvalResult[]> {
    const results: EvalResult[] = []

    for (const evalCase of cases) {
      const run = await this.run(evalCase.task)
      const failures: string[] = []
      let passedChecks = 0

      for (const check of evalCase.checks) {
        const ok =
          check.kind === 'verify-pass'
            ? run.ok && run.verify.every((v) => v.ok)
            : check.kind === 'contains'
              ? run.finalText.includes(check.text)
              : !run.finalText.includes(check.text)

        if (ok) passedChecks += 1
        else failures.push(describeCheck(check))
      }

      const totalChecks = evalCase.checks.length
      const score = totalChecks === 0 ? 1 : passedChecks / totalChecks

      results.push({
        caseId: evalCase.id,
        score,
        passed: passedChecks === totalChecks,
        passedChecks,
        totalChecks,
        detail:
          failures.length === 0
            ? `run ${run.runId}: all ${totalChecks} checks passed`
            : `run ${run.runId}: failed ${failures.join(', ')}`,
      })
    }

    return results
  }

  // ── git ───────────────────────────────────────────────────────────────────
  //
  // THE MOCK HAS NO REPOSITORY, AND SAYS SO. A fabricated `GitStatusResult` here
  // would be a `MOCK_*` fixture wearing the seam's clothes: the Git panel cannot
  // tell an invented branch from a real one, and Requirement 14.6 forbids a
  // shipped panel rendering fabricated data. Every git call therefore rejects with
  // the reason, which the panel surfaces as an error state naming the transport
  // (Requirement 27.5). A run's events can be simulated honestly because they are
  // labelled 'mock/echo-1'; a working tree cannot be.

  private noRepository(call: string): Promise<never> {
    return Promise.reject(
      new Error(
        `the mock transport has no repository behind it, so '${call}' cannot answer. ` +
          'Start the app with VITE_BRIDGE=http or run it under Tauri to reach a real engine.',
      ),
    )
  }

  async gitStatus(): Promise<never> {
    return this.noRepository('git-status')
  }

  async gitDiff(): Promise<never> {
    return this.noRepository('git-diff')
  }

  async gitStage(): Promise<never> {
    return this.noRepository('git-stage')
  }

  async gitUnstage(): Promise<never> {
    return this.noRepository('git-unstage')
  }

  async gitCommit(): Promise<never> {
    return this.noRepository('git-commit')
  }

  // ── provider settings ─────────────────────────────────────────────────────
  //
  // Same rule as git: no engine, no answer, and it says so. Returning a fabricated
  // catalog would put a provider list on screen that no registry produced, and a
  // fabricated "connection ok" would be the worst possible lie in this surface.

  private noEngine(call: string): Promise<never> {
    return Promise.reject(
      new Error(
        `the mock transport has no engine behind it, so '${call}' cannot answer. ` +
          'Start the app with VITE_BRIDGE=http or run it under Tauri to reach a real engine.',
      ),
    )
  }

  async providerCatalog(): Promise<never> {
    return this.noEngine('provider-catalog')
  }

  async saveProviderSettings(): Promise<never> {
    return this.noEngine('provider-config-save')
  }

  async testProvider(): Promise<never> {
    return this.noEngine('provider-test')
  }

  // ── architecture ──────────────────────────────────────────────────────────
  //
  // Same rule again, and here it is at its sharpest: a fabricated set of views
  // would be a diagram of a repository that does not exist, which is the exact
  // failure the generator refuses to commit (see the honesty note at the top of
  // packages/core/src/context/architecture.ts). No graph, no answer, and it says so.

  async architecture(): Promise<never> {
    return this.noEngine('architecture')
  }

  // ── skills ────────────────────────────────────────────────────────────────
  //
  // The same rule, and the stakes are highest here. A fabricated catalog would
  // invent skill names, versions and — worst — CONTENT HASHES and CAPABILITY
  // GRANTS. A user reading a made-up grant would be consenting to nothing, and a
  // made-up digest is a security claim with no bytes behind it. So: no engine, no
  // catalog, and the panel says which transport it is talking to.

  async skillsCatalog(): Promise<never> {
    return this.noEngine('skills-catalog')
  }

  async skillInstall(): Promise<never> {
    return this.noEngine('skill-install')
  }

  async skillTrain(): Promise<never> {
    return this.noEngine('skill-train')
  }

  // ── verification contract and MCP ─────────────────────────────────────────
  //
  // The same rule a fourth and fifth time. A fabricated verify report is the worst
  // fixture in this application: nine green badges are a claim that a project's tests
  // pass, and a user who trusts one ships broken code. A fabricated MCP status is a
  // claim that servers are connected, which is what the hardcoded
  // `{ connected: 5, total: 8 }` badge said before this task deleted it.

  async verify(): Promise<never> {
    return this.noEngine('verify')
  }

  async mcpCatalog(): Promise<never> {
    return this.noEngine('mcp-catalog')
  }

  private nextRunId(): string {
    // Time-prefixed so ids sort chronologically, matching the engine's scheme.
    this.runCounter += 1
    return `run-${this.clock().toString(36)}-${String(this.runCounter).padStart(3, '0')}`
  }
}

/** Rough token count so usage numbers move with real message size. */
function estimateTokens(messages: Message[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4)
}

function describeCheck(check: EvalCase['checks'][number]): string {
  return check.kind === 'verify-pass' ? 'verify-pass' : `${check.kind}("${check.text}")`
}
