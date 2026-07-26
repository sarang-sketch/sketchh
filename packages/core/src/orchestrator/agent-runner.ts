// AgentRunner — executes a single plan step by asking the provider for file edits.

import type { ProviderAdapter, CompletionOptions } from '../providers/index.js'
import type { PlanStep, StepResult, FileEdit } from './types.js'
import { extractJson } from './json.js'

const RUNNER_SYSTEM = `You are a senior software engineer implementing one step of a plan.
Produce the complete new contents of each file you change.
Respond ONLY with JSON matching this shape:
{
  "notes": "brief note on what you did",
  "edits": [
    { "path": "path/to/file", "content": "FULL new file contents" }
  ]
}
Return the entire file content for each edit, not a diff. Only include files you actually change.`

interface RunnerRaw {
  notes?: string
  edits: Array<{ path: string; content: string }>
}

export class AgentRunner {
  constructor(
    private provider: ProviderAdapter,
    private model: string
  ) {}

  async runStep(step: PlanStep, contextText: string): Promise<StepResult> {
    const options: CompletionOptions = {
      model: this.model,
      systemPrompt: RUNNER_SYSTEM,
      temperature: 0.1,
    }
    const userContent = [
      contextText ? `Relevant code context:\n${contextText}\n` : '',
      `Step to implement:\n${step.description}`,
      step.files.length ? `\nExpected files: ${step.files.join(', ')}` : '',
    ].filter(Boolean).join('\n')

    const res = await this.provider.complete([{ role: 'user', content: userContent }], options)
    const raw = extractJson<RunnerRaw>(res.content)

    if (!raw || !Array.isArray(raw.edits)) {
      return { stepId: step.id, edits: [], notes: 'No parseable edits returned' }
    }

    const edits: FileEdit[] = raw.edits
      .filter(e => typeof e.path === 'string' && typeof e.content === 'string')
      .map(e => ({ path: e.path, content: e.content }))

    return { stepId: step.id, edits, notes: raw.notes ?? '' }
  }
}
