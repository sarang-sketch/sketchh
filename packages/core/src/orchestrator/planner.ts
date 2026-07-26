// Planner — turns a task description into a structured plan using a provider.

import type { ProviderAdapter, CompletionOptions } from '../providers/index.js'
import type { Plan, PlanStep } from './types.js'
import { extractJson } from './json.js'

const PLANNER_SYSTEM = `You are a senior software engineer planning a coding task.
Break the task into a small number of concrete, ordered steps.
Respond ONLY with JSON matching this shape:
{
  "summary": "one sentence describing the overall approach",
  "steps": [
    { "id": "s1", "description": "what to do", "files": ["path/to/file"], "dependsOn": [] }
  ]
}
Keep steps minimal and focused. Reference real file paths from the provided context.`

interface PlannerRaw {
  summary: string
  steps: Array<{ id?: string; description: string; files?: string[]; dependsOn?: string[] }>
}

export class Planner {
  constructor(
    private provider: ProviderAdapter,
    private model: string
  ) {}

  async plan(taskId: string, task: string, contextText: string, memoryDigest = ''): Promise<Plan> {
    const options: CompletionOptions = {
      model: this.model,
      systemPrompt: PLANNER_SYSTEM,
      temperature: 0.2,
    }
    const userContent = [
      memoryDigest ? `Project memory:\n${memoryDigest}\n` : '',
      contextText ? `Relevant code context:\n${contextText}\n` : '',
      `Task:\n${task}`,
    ].filter(Boolean).join('\n')

    const res = await this.provider.complete([{ role: 'user', content: userContent }], options)
    const raw = extractJson<PlannerRaw>(res.content)

    if (!raw || !Array.isArray(raw.steps)) {
      // Fallback: a single-step plan so execution can still proceed.
      return {
        taskId,
        summary: task,
        steps: [{ id: 's1', description: task, files: [], dependsOn: [] }],
        estimatedFiles: [],
      }
    }

    const steps: PlanStep[] = raw.steps.map((s, i) => ({
      id: s.id ?? `s${i + 1}`,
      description: s.description,
      files: s.files ?? [],
      dependsOn: s.dependsOn ?? [],
    }))

    const estimatedFiles = [...new Set(steps.flatMap(s => s.files))]

    return { taskId, summary: raw.summary ?? task, steps, estimatedFiles }
  }
}
