// Orchestrator — drives a task through the full state machine:
// plan → (approval) → execute steps → verify → fix loop → done / needs_human.
//
// It is deliberately dependency-injected: Planner, AgentRunner, Verifier/VerifyLoop,
// ContextEngine, ProjectMemory, and FileWriter are all supplied, so the whole flow
// is unit-testable with fakes and works with any provider.

import type { Planner } from './planner.js'
import type { AgentRunner } from './agent-runner.js'
import type { FileWriter } from './file-writer.js'
import { DiskFileWriter } from './file-writer.js'
import type { ProjectMemory } from '../memory/index.js'
import type { VerifyLoop, Fixer, FixContext } from '../verifier/index.js'
import type {
  Plan,
  TaskStatus,
  OrchestratorEvent,
  StepResult,
} from './types.js'

export interface ContextProvider {
  retrieve(task: string, topK?: number): Promise<{ chunks: Array<{ path: string; content: string }> }>
}

export interface OrchestratorDeps {
  planner: Planner
  runner: AgentRunner
  verifyLoop: VerifyLoop
  context: ContextProvider
  memory: ProjectMemory
  fileWriter?: FileWriter
  maxFixAttempts?: number
  requireApproval?: boolean
}

export interface RunOptions {
  onEvent?: (e: OrchestratorEvent) => void
  approvePlan?: (plan: Plan) => Promise<boolean>
}

// Outcome of a legacy Orchestrator.run(). Named OrchestratorRunResult because the
// canonical agent-loop result type in src/types.ts owns the name `RunResult`.
export interface OrchestratorRunResult {
  status: TaskStatus
  plan: Plan | null
  summary: string
}

let taskCounter = 0

export class Orchestrator {
  private fileWriter: FileWriter

  constructor(private deps: OrchestratorDeps) {
    this.fileWriter = deps.fileWriter ?? new DiskFileWriter()
  }

  async run(root: string, task: string, opts: RunOptions = {}): Promise<OrchestratorRunResult> {
    const taskId = `t${++taskCounter}`
    const emit = (e: OrchestratorEvent) => opts.onEvent?.(e)
    const status = (s: TaskStatus, message?: string) =>
      emit({ type: 'status', taskId, status: s, message })

    try {
      // ── Plan ──────────────────────────────────────────────────────────────
      status('planning')
      const contextText = await this.buildContext(task)
      const digest = await this.deps.memory.digest()
      const plan = await this.deps.planner.plan(taskId, task, contextText, digest)
      emit({ type: 'plan', taskId, plan })

      // ── Approval (optional) ────────────────────────────────────────────────
      if (this.deps.requireApproval) {
        status('awaiting_approval')
        const approved = opts.approvePlan ? await opts.approvePlan(plan) : true
        if (!approved) {
          status('cancelled')
          return { status: 'cancelled', plan, summary: 'Plan rejected by user' }
        }
      }

      // ── Execute steps ──────────────────────────────────────────────────────
      status('executing')
      const orderedSteps = topoSort(plan)
      for (const step of orderedSteps) {
        emit({ type: 'step_start', taskId, step })
        const stepContext = await this.buildContext(step.description)
        const result: StepResult = await this.deps.runner.runStep(step, stepContext)
        const written = await this.fileWriter.apply(root, result.edits)
        for (const path of written) {
          emit({ type: 'file_edit', taskId, path })
          await this.reindex(path)
        }
      }

      // ── Verify + fix loop ──────────────────────────────────────────────────
      status('verifying')
      const fixer = this.makeFixer(root, taskId, emit)
      const loopResult = await this.deps.verifyLoop.run(root, fixer, {
        maxAttempts: this.deps.maxFixAttempts ?? 3,
      })

      const summary = summarise(loopResult.finalResult.checks)
      emit({ type: 'verify', taskId, passed: loopResult.finalResult.passed, summary })

      // Record test history in memory.
      for (const check of loopResult.finalResult.checks) {
        if (check.skipped) continue
        await this.deps.memory.addTestRecord({
          id: `${taskId}-${check.name}`,
          checkName: check.name,
          passed: check.passed,
          output: check.output.slice(0, 2000),
        })
      }

      if (loopResult.finalResult.passed) {
        await this.deps.memory.addConversation({
          id: taskId,
          task,
          messages: JSON.stringify({ plan: plan.summary }),
        })
        status('done')
        emit({ type: 'done', taskId, summary })
        return { status: 'done', plan, summary }
      }

      status('needs_human', summary)
      return { status: 'needs_human', plan, summary }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ type: 'error', taskId, message })
      return { status: 'error', plan: null, summary: message }
    }
  }

  private makeFixer(root: string, taskId: string, emit: (e: OrchestratorEvent) => void): Fixer {
    return {
      fix: async (ctx: FixContext): Promise<boolean> => {
        emit({ type: 'status', taskId, status: 'fixing', message: `attempt ${ctx.attempt}` })
        // Ask the agent to fix the failing checks, feeding the error output as context.
        const failureText = ctx.failingChecks
          .map(c => `Check "${c.name}" failed:\n${c.output}`)
          .join('\n\n')
        const stepContext = await this.buildContext(failureText)
        const result = await this.deps.runner.runStep(
          { id: `fix-${ctx.attempt}`, description: `Fix these failing checks:\n${failureText}`, files: [], dependsOn: [] },
          stepContext
        )
        if (result.edits.length === 0) return false
        const written = await this.fileWriter.apply(root, result.edits)
        for (const path of written) {
          emit({ type: 'file_edit', taskId, path })
          await this.reindex(path)
        }
        return true
      },
    }
  }

  private async buildContext(query: string): Promise<string> {
    const ctx = await this.deps.context.retrieve(query)
    return ctx.chunks
      .map(c => `// ${c.path}\n${c.content}`)
      .join('\n\n')
  }

  // Re-index a written file if the context provider supports it (best-effort).
  private async reindex(_path: string): Promise<void> {
    // ContextProvider only guarantees retrieve(); re-indexing is handled by the
    // ContextEngine's file watcher in the desktop app. No-op here by design.
  }
}

// Topologically sort steps by dependsOn so dependencies run first.
export function topoSort(plan: Plan): Plan['steps'] {
  const byId = new Map(plan.steps.map(s => [s.id, s]))
  const visited = new Set<string>()
  const order: Plan['steps'] = []

  const visit = (id: string, stack: Set<string>) => {
    if (visited.has(id)) return
    if (stack.has(id)) return // cycle: break rather than loop forever
    const step = byId.get(id)
    if (!step) return
    stack.add(id)
    for (const dep of step.dependsOn) visit(dep, stack)
    stack.delete(id)
    visited.add(id)
    order.push(step)
  }

  for (const step of plan.steps) visit(step.id, new Set())
  return order
}

function summarise(checks: Array<{ name: string; passed: boolean; skipped: boolean }>): string {
  const parts = checks
    .filter(c => !c.skipped)
    .map(c => `${c.name}: ${c.passed ? 'pass' : 'FAIL'}`)
  return parts.length ? parts.join(', ') : 'no checks configured'
}
