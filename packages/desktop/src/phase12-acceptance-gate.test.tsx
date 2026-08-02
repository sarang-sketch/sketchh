// Phase 12.6 UI gate — the Timeline renders the real core event log for planning,
// verification, swarm consensus/merge, and a deterministic budget stop.
//
// This is observability evidence over scripted offline model turns, not evidence that a
// real provider can build a booking product.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { events, loop, orchestrator, plan, strategy } from '@sketch/core'
import type { ChatAdapter, Message, Usage } from '@sketch/core'
import { AgentTimeline } from './ui/panels/AgentTimeline'

const roots: string[] = []

afterEach(async () => {
  cleanup()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

const PLAN = JSON.stringify({
  action: 'plan',
  artifacts: { prd: 'Build the booking slice.', architecture: 'Small ESM modules.', tests: 'Real node checks.' },
})
const VERIFY = JSON.stringify({ action: 'verify' })
const THINK = JSON.stringify({ action: 'think', text: 'working' })
const done = (text: string) => JSON.stringify({ action: 'done', text })
const edit = (path: string, replace: string) =>
  JSON.stringify({ action: 'edit', edits: [{ path, search: '', replace }] })

function scripted(script: readonly string[], usage: Usage = { in: 10, out: 5 }): ChatAdapter {
  let index = 0
  return {
    id: 'timeline-scripted',
    model: 'scripted',
    chat: async () => ({ text: script[Math.min(index++, script.length - 1)]!, usage }),
  }
}

class RoleAdapter implements ChatAdapter {
  readonly id = 'timeline-roles'
  readonly model = 'scripted'
  readonly #counts = new Map<string, number>()

  constructor(private readonly scripts: Record<string, readonly string[]>) {}

  async chat(messages: Message[]): Promise<{ text: string; usage?: Usage }> {
    const prompt = messages.map((message) => message.content).join('\n')
    const key = Object.keys(this.scripts).find((candidate) => candidate !== '*' && prompt.includes(candidate)) ?? '*'
    const index = this.#counts.get(key) ?? 0
    this.#counts.set(key, index + 1)
    const script = this.scripts[key] ?? this.scripts['*'] ?? [done('nothing to do')]
    return { text: script[Math.min(index, script.length - 1)]!, usage: { in: 10, out: 5 } }
  }
}

describe('Phase 12.6 UI acceptance — evidence is observable in the Timeline', () => {
  it('renders real plan, verify, consensus/merge, and budget events with terminal outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sketch-p126-ui-'))
    roots.push(root)
    await mkdir(join(root, 'src'), { recursive: true })

    const store = new events.MemoryEventStore({ secrets: [] })
    const writer = new plan.PlanWriter({ baseDir: root, events: store })
    const files = new orchestrator.DiskFileWriter()
    const pass = {
      name: 'unit',
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      cwd: root,
      timeoutMs: 30_000,
    }
    const policy = { unit: [pass] }

    // A normal production loop creates the durable plan and verification rows.
    await loop.runTask(
      { id: 'timeline-green-task', prompt: 'Build the booking slice.', verify: [] },
      {
        adapter: scripted([PLAN, VERIFY, done('green')]),
        events: store,
        plan: writer,
        files,
        root,
        verifyPolicy: policy,
        ids: () => 'timeline-green',
      },
    )

    // An explicitly requested swarm creates dispatcher events whose outcome now carries
    // bounded consensus, merge, and verification summaries.
    await strategy.dispatch(
      { id: 'timeline-swarm-task', prompt: 'Add two verified modules.', verify: [] },
      {
        adapter: new RoleAdapter({
          'as the Backend role': [PLAN, edit('src/backend.mjs', 'export const backend = true\n'), VERIFY, done('backend done')],
          'as the Testing role': [PLAN, edit('src/testing.mjs', 'export const testing = true\n'), VERIFY, done('testing done')],
          'as the Security role': [PLAN, done('NO FINDINGS')],
          'as the Reviewer role': [PLAN, done('NO FINDINGS')],
          '*': [PLAN, done('NO FINDINGS')],
        }),
        events: store,
        plan: writer,
        files,
        root,
        verifyPolicy: policy,
        strategy: 'swarm',
        roles: ['backend', 'testing', 'security', 'reviewer'],
        dispatchId: 'timeline-swarm',
      },
    )

    // A real cost guard ends this run; the model script would otherwise keep thinking.
    await loop.runTask(
      { id: 'timeline-budget-task', prompt: 'Keep working expensively.', verify: [] },
      {
        adapter: scripted([PLAN, THINK, THINK, THINK, done('never reached')], { in: 200_000, out: 50_000 }),
        events: store,
        plan: writer,
        files,
        root,
        maxIterations: 10,
        budget: { maxTokens: 300_000, onBreach: 'stop' },
        ids: () => 'timeline-budget',
      },
    )

    const realEvents = await store.readAll()
    render(<AgentTimeline events={realEvents} transportLabel="in-process core" />)

    expect(screen.getByText(`${realEvents.length} events`)).toBeDefined()
    expect(screen.getByText('in-process core')).toBeDefined()

    const green = screen.getByLabelText('Run timeline-green')
    expect(within(green).getByText('completed')).toBeDefined()
    expect(within(green).getByText('plan_written')).toBeDefined()
    expect(within(green).getByText('verify_started')).toBeDefined()
    expect(within(green).getByText('verify_result')).toBeDefined()
    expect(within(green).getByText('run_completed')).toBeDefined()

    // The dispatcher has no run_completed event of its own. Its durable
    // strategy_selected{phase:"outcome"} is terminal, so the Timeline must not leave the
    // completed swarm marked as "running".
    const swarm = screen.getByLabelText('Run timeline-swarm')
    expect(within(swarm).getByText('completed')).toBeDefined()
    expect(within(swarm).getByText('swarm · 4 verifiable · 0 skipped')).toBeDefined()
    const outcome = within(swarm).getByText('swarm · completed').closest('button')!
    fireEvent.click(outcome)
    expect(swarm.textContent).toContain('"consensus"')
    expect(swarm.textContent).toContain('"reached": true')
    expect(swarm.textContent).toContain('"agreeing"')
    expect(swarm.textContent).toContain('"merge"')
    expect(swarm.textContent).toContain('"applied"')
    expect(swarm.textContent).toContain('"verify"')
    expect(swarm.textContent).toContain('"verifiedAnything": true')

    const budget = screen.getByLabelText('Run timeline-budget')
    expect(within(budget).getByText('failed')).toBeDefined()
    expect(within(budget).getByText('budget_exceeded')).toBeDefined()
    expect(within(budget).getByText('tokens · stopped')).toBeDefined()
    expect(within(budget).getByText('run_failed')).toBeDefined()
    expect(within(budget).getByText(/budget reached/)).toBeDefined()
    const exceeded = within(budget).getByText('tokens · stopped').closest('button')!
    fireEvent.click(exceeded)
    expect(budget.textContent).toContain('"configured": "stop"')
    expect(budget.textContent).toContain('"outcome": "stopped"')
    expect(budget.textContent).toContain('"spent"')
  }, 60_000)
})
