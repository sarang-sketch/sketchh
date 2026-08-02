import { isCapability, type Capability } from '../capabilities/index.js'
import type { RunTaskDeps } from '../loop/agent.js'
import { runTask } from '../loop/agent.js'
import type { RunResult, Task } from '../types.js'
import type { VerifyPolicy, VerifyStage } from '../verify/index.js'
import { VERIFY_STAGES } from '../verify/index.js'
import { diskPathExists, extractCitations, type Citation, type PathExists } from './grade.js'
import { NO_FINDINGS_TOKEN, describeSignal, type RoleSignal } from './roles.js'

export interface RegisteredAgentDescriptor {
  id: string
  version: string
  title: string
  instruction: string
  signal: RoleSignal
  capabilities: readonly Capability[]
  edits: boolean
  blocking: boolean
}

export interface RegisteredAgentGrade {
  agent: string
  signal: RoleSignal
  passed: boolean
  reason: string
  citations: Citation[]
  fabricated: string[]
  noFindings: boolean
}

export interface RegisteredAgentExecution {
  agent: RegisteredAgentDescriptor
  ran: boolean
  skipped: string | null
  capabilities: readonly Capability[]
  run: RunResult | null
  grade: RegisteredAgentGrade | null
}

export interface RegisteredAgentOptions {
  task?: Task
  context?: string
}

export interface RegisteredWorkflowDescriptor {
  id: string
  version: string
  description: string
}

export interface RegisteredWorkflowContext {
  task: Task
  runAgent(id: string, options?: RegisteredAgentOptions): Promise<RegisteredAgentExecution>
}

export type RegisteredWorkflowExecutor = (context: RegisteredWorkflowContext) => Promise<unknown>

export interface RegisteredWorkflow {
  descriptor: RegisteredWorkflowDescriptor
  execute: RegisteredWorkflowExecutor
}

function validId(id: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)
}

function validVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
}

function assertText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be non-empty`)
}

function descriptorKey(value: unknown): string {
  return JSON.stringify(value)
}

function validateSignal(signal: RoleSignal, id: string): void {
  if (signal.kind === 'verify-stage') {
    if (!VERIFY_STAGES.includes(signal.stage)) throw new Error(`agent ${id} has unknown verify stage`)
    return
  }
  if (signal.kind !== 'plan-artifact' && signal.kind !== 'citations') {
    throw new Error(`agent ${id} has unknown role signal`)
  }
}

function freezeAgent(agent: RegisteredAgentDescriptor): RegisteredAgentDescriptor {
  if (agent === null || typeof agent !== 'object') throw new Error('agent descriptor must be an object')
  if (typeof agent.id !== 'string' || !validId(agent.id)) throw new Error(`invalid agent id ${JSON.stringify(agent.id)}`)
  if (typeof agent.version !== 'string' || !validVersion(agent.version)) throw new Error(`agent ${agent.id} must use an exact version`)
  assertText(agent.title, `agent ${agent.id}.title`)
  assertText(agent.instruction, `agent ${agent.id}.instruction`)
  if (agent.signal === null || typeof agent.signal !== 'object') throw new Error(`agent ${agent.id} needs a verification signal`)
  validateSignal(agent.signal, agent.id)
  if (!Array.isArray(agent.capabilities) || agent.capabilities.some((capability) => !isCapability(capability))) {
    throw new Error(`agent ${agent.id} has an unrecognized capability`)
  }
  if (typeof agent.edits !== 'boolean' || typeof agent.blocking !== 'boolean') {
    throw new Error(`agent ${agent.id} edits and blocking metadata must be booleans`)
  }
  const capabilities = Object.freeze([...new Set(agent.capabilities)])
  return Object.freeze({ ...agent, signal: Object.freeze({ ...agent.signal }), capabilities })
}

export class RegisteredAgentRegistry {
  readonly #agents = new Map<string, RegisteredAgentDescriptor>()

  constructor(agents: readonly RegisteredAgentDescriptor[] = []) {
    for (const candidate of agents) {
      const agent = freezeAgent(candidate)
      const existing = this.#agents.get(agent.id)
      if (existing !== undefined) {
        if (descriptorKey(existing) === descriptorKey(agent)) continue
        throw new Error(`conflicting agent registration: ${agent.id}`)
      }
      this.#agents.set(agent.id, agent)
    }
  }

  get(id: string): RegisteredAgentDescriptor | undefined { return this.#agents.get(id) }
  list(): readonly RegisteredAgentDescriptor[] { return [...this.#agents.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}

export class RegisteredWorkflowRegistry {
  readonly #workflows = new Map<string, RegisteredWorkflow>()

  constructor(workflows: readonly RegisteredWorkflow[] = []) {
    for (const workflow of workflows) {
      if (workflow === null || typeof workflow !== 'object' || workflow.descriptor === null || typeof workflow.descriptor !== 'object') {
        throw new Error('workflow registration must include a descriptor')
      }
      const descriptor = workflow.descriptor
      if (typeof descriptor.id !== 'string' || !validId(descriptor.id)) throw new Error(`invalid workflow id ${JSON.stringify(descriptor.id)}`)
      if (typeof descriptor.version !== 'string' || !validVersion(descriptor.version)) throw new Error(`workflow ${descriptor.id} must use an exact version`)
      assertText(descriptor.description, `workflow ${descriptor.id}.description`)
      if (typeof workflow.execute !== 'function') throw new Error(`workflow ${descriptor.id} must provide an executor`)
      const frozen = Object.freeze({ descriptor: Object.freeze({ ...descriptor }), execute: workflow.execute })
      const existing = this.#workflows.get(descriptor.id)
      if (existing !== undefined) {
        if (descriptorKey(existing.descriptor) === descriptorKey(frozen.descriptor) && existing.execute === frozen.execute) continue
        throw new Error(`conflicting workflow registration: ${descriptor.id}`)
      }
      this.#workflows.set(descriptor.id, frozen)
    }
  }

  get(id: string): RegisteredWorkflow | undefined { return this.#workflows.get(id) }
  list(): readonly RegisteredWorkflow[] { return [...this.#workflows.values()].sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id)) }
}

function agentPrompt(agent: RegisteredAgentDescriptor, task: Task, context?: string): string {
  return [
    `You are the registered ${agent.title} agent (${agent.id}@${agent.version}).`,
    '',
    `YOUR SCOPE: ${agent.instruction}`,
    '',
    `YOU WILL BE GRADED BY: ${describeSignal(agent.signal)}.`,
    ...(agent.edits ? [] : ['', 'Do not write files. Report your result in the final message.']),
    ...(context?.trim() ? ['', '# Workflow context', '', context.trim()] : []),
    '', '# Task', '', task.prompt,
  ].join('\n')
}

function stages(policy: VerifyPolicy | undefined): VerifyStage[] {
  return VERIFY_STAGES.filter((stage) => (policy?.[stage] ?? []).length > 0)
}

async function grade(agent: RegisteredAgentDescriptor, run: RunResult, pathExists: PathExists): Promise<RegisteredAgentGrade> {
  const base = { agent: agent.id, signal: agent.signal, citations: [] as Citation[], fabricated: [] as string[], noFindings: false }
  if (agent.signal.kind === 'verify-stage') {
    if (run.verify.length === 0) return { ...base, passed: false, reason: `no ${agent.signal.stage} verification command ran` }
    const failed = run.verify.filter((item) => !item.ok)
    if (failed.length > 0 || !run.ok) return { ...base, passed: false, reason: `the ${agent.signal.stage} verification signal failed` }
    return { ...base, passed: true, reason: `the ${agent.signal.stage} verification signal passed` }
  }
  if (agent.signal.kind === 'plan-artifact') {
    const files = run.events.flatMap((event) => event.kind === 'plan_written' && Array.isArray(event.payload['files']) ? event.payload['files'].filter((file): file is string => typeof file === 'string') : [])
    return files.length > 0
      ? { ...base, passed: true, reason: `wrote ${files.length} plan document(s)` }
      : { ...base, passed: false, reason: 'the agent wrote no plan document' }
  }
  const citations = extractCitations(run.finalText)
  const noFindings = run.finalText.includes(NO_FINDINGS_TOKEN)
  if (citations.length === 0) return noFindings
    ? { ...base, passed: true, noFindings: true, reason: `reported ${NO_FINDINGS_TOKEN}` }
    : { ...base, passed: false, reason: 'the agent output contained no resolvable citations' }
  const fabricated: string[] = []
  for (const citation of citations) if (!(await pathExists(citation.path))) fabricated.push(citation.path)
  return fabricated.length === 0
    ? { ...base, citations, passed: true, reason: `${citations.length} citation(s) resolved` }
    : { ...base, citations, fabricated, passed: false, reason: `cited missing paths: ${fabricated.join(', ')}` }
}

export async function executeRegisteredAgent(
  agent: RegisteredAgentDescriptor,
  task: Task,
  deps: RunTaskDeps,
  granted: readonly Capability[],
  options: RegisteredAgentOptions = {},
): Promise<RegisteredAgentExecution> {
  const available = agent.signal.kind !== 'verify-stage' || stages(deps.verifyPolicy).includes(agent.signal.stage)
  const capabilities = Object.freeze(agent.capabilities.filter((capability) => granted.includes(capability)))
  if (!available) {
    return { agent, ran: false, skipped: `verification stage ${agent.signal.kind === 'verify-stage' ? agent.signal.stage : ''} is unavailable`, capabilities, run: null, grade: null }
  }
  const selectedTask = options.task ?? task
  const narrowedPolicy: VerifyPolicy = agent.signal.kind === 'verify-stage'
    ? { [agent.signal.stage]: deps.verifyPolicy?.[agent.signal.stage] ?? [] }
    : {}
  const run = await runTask(
    { ...selectedTask, prompt: agentPrompt(agent, selectedTask, options.context), verify: [] },
    { ...deps, verifyPolicy: narrowedPolicy, capabilityGrant: capabilities, reviewEdits: true, tools: undefined },
  )
  return { agent, ran: true, skipped: null, capabilities, run, grade: await grade(agent, run, diskPathExists(deps.root)) }
}
