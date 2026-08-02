// Deterministic OFFLINE benchmark executor used only by the internal CI gate.
// It is synthetic evidence for the harness, never a public provider benchmark.
import type { ChatAdapter, Message, Usage } from '../types.js'
import { MemoryEventStore } from '../events/index.js'
import { runEvalDetailed } from '../evals/index.js'
import { ledgerFor } from '../cost/index.js'
import { resolveVerifyPolicy, runVerifyPolicy } from '../verify/index.js'
import type { BenchExecutor, HarnessIdentity } from './types.js'

const PLAN = JSON.stringify({ action: 'plan', artifacts: { prd: 'repair fixture', tests: 'run contract' } })
const VERIFY = '{"action":"verify"}'
const DONE = '{"action":"done","text":"fixture evaluated"}'

class OfflineBenchAdapter implements ChatAdapter {
  readonly id = 'offline-scripted'
  readonly model = 'offline-scripted-v1'
  #turn = 0

  constructor(private readonly responses: readonly string[]) {}

  async chat(_messages: Message[]): Promise<{ text: string; usage?: Usage }> {
    const text = this.responses[Math.min(this.#turn++, this.responses.length - 1)] ?? DONE
    return { text, usage: { in: 8, out: 8 } }
  }
}

function repair(caseId: string): string {
  const edit = caseId === 'repair-addition'
    ? { path: 'src/math.mjs', search: 'return left - right', replace: 'return left + right' }
    : { path: 'src/greet.mjs', search: 'return `Hello, ${name}`', replace: 'return `Hello, ${name}!`' }
  return JSON.stringify({ action: 'edit', edits: [edit] })
}

/**
 * Current versioned offline gate harnesses. `naive` intentionally performs one unassisted
 * attempt; `sketch` gets the plan/edit/verify loop. Both use the same scripted model id and
 * are kept out of public reports by their `synthetic` script metadata.
 */
export function createOfflineBenchExecutor(harness: HarnessIdentity): BenchExecutor {
  return {
    async execute(context) {
      const events = new MemoryEventStore({ secrets: [] })
      const responses = harness.id === 'sketch'
        ? [PLAN, repair(context.benchCase.id), VERIFY, DONE]
        : [PLAN, VERIFY, DONE]
      const evaluatedCase = {
        ...context.benchCase.eval,
        task: {
          ...context.benchCase.eval.task,
          verify: context.benchCase.eval.task.verify.map((command) => ({
            ...command,
            cwd: command.cwd ?? context.workspace,
          })),
        },
      }
      const detailed = await runEvalDetailed(evaluatedCase, {
        adapter: new OfflineBenchAdapter(responses),
        events,
        root: context.workspace,
        maxIterations: 6,
        signal: context.signal,
      })

      const resolved = await resolveVerifyPolicy(context.workspace)
      const policy = Object.fromEntries(
        Object.entries(resolved.policy).map(([stage, commands]) => [
          stage,
          Array.isArray(commands)
            ? commands.map((command) => ({ ...command, cwd: command.cwd ?? context.workspace }))
            : commands,
        ]),
      )
      const verification = await runVerifyPolicy(policy, {
        root: context.workspace,
        sink: events,
        runId: detailed.run?.runId ?? `${context.benchCase.id}-${context.attempt}`,
        signal: context.signal,
        continueOnFailure: true,
      })
      const ledger = ledgerFor(await events.readAll())
      for (const entry of ledger.entries) {
        context.recordCall({
          tokensIn: entry.usage.in,
          tokensOut: entry.usage.out,
          costUsd: entry.usd,
        })
      }
      return {
        evalResult: detailed.result,
        verifyStages: verification.stages.map(({ stage, status }) => ({ stage, status })),
        // No human observation occurs in this automated run. Unknown is not zero.
        manualEdits: null,
      }
    },
  }
}