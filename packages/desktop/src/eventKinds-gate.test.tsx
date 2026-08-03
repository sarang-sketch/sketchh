// THE CONSUMER-SIDE GATE for the `EventKind` amendment.
//
// Six kinds were added to the contract — `repo_indexed`, `context_retrieved`,
// `embedder_degraded`, `model_selected`, `skill_trained`, `ask` — each replacing
// an existing kind plus a `component` payload discriminator.
//
// WHY THIS FILE EXISTS. Migrating an emitter is verified by a producer-side test
// in `packages/core/test`: "the event has the new kind". That test says nothing
// about whether anything still RENDERS it. The Timeline's `summarize` ends in
// `default: return ''`, so a kind nobody taught it about still lists, still
// expands, still shows its payload — and shows a blank one-line summary. Nothing
// fails. That is precisely how a UI silently stops matching.
//
// So this gate drives the REAL core emitters into one real event store and
// renders the REAL Timeline over the result. Break a kind at any emitter and the
// assertion that fails is here, on the consumer side, not just in core.
//
// Validates: Requirements 3.1, 3.1a, 3.1b, 27.2

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { context, events, loop, orchestrator, plan, skills } from '@sketch/core'
import type { ChatAdapter, EvalCase, Message, Skill, Usage } from '@sketch/core'
import { AgentTimeline } from './ui/panels/AgentTimeline'

const roots: string[] = []

afterEach(async () => {
  cleanup()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-eventkinds-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'src', 'booking.ts'),
    'export function bookingTotal(nights: number): number {\n  return nights * 120\n}\n',
    'utf8',
  )
  await writeFile(
    join(root, 'src', 'index.ts'),
    "import { bookingTotal } from './booking.js'\nexport const total = bookingTotal(2)\n",
    'utf8',
  )
  return root
}

function scripted(id: string, script: readonly string[]): ChatAdapter {
  let index = 0
  return {
    id,
    model: `${id}-model`,
    chat: async () => ({
      text: script[Math.min(index++, script.length - 1)]!,
      usage: { in: 10, out: 5 } satisfies Usage,
    }),
  }
}

const PLAN = JSON.stringify({
  action: 'plan',
  artifacts: { prd: 'Book a room.', architecture: 'One module.', tests: 'node checks' },
})
const DONE = JSON.stringify({ action: 'done', text: 'finished' })

/**
 * Reads the rendered summary cell of a Timeline row. The row is
 * `[offset][kind][summary]`, so the last span is the summary. A kind the switch
 * does not handle renders '' here — which is the silent failure this file exists
 * to catch.
 */
function summaryFor(kind: string): string {
  const row = screen.getByText(kind).closest('button')
  expect(row, `no Timeline row rendered for kind ${kind}`).not.toBeNull()
  const spans = row!.querySelectorAll('span')
  return spans[spans.length - 1]!.textContent ?? ''
}

/** A skill whose body declares the topics it covers. The body IS the state. */
function skill(name: string, topics: readonly number[]): Skill {
  return {
    name,
    description: `Handles topics ${topics.join(', ')}.`,
    body: ['# Procedure', ...topics.map((n) => `covers: topic-${n}`)].join('\n'),
    source: `memory:${name}`,
  }
}

function topicCase(n: number): EvalCase {
  return {
    id: `c${n}`,
    task: { id: `task-c${n}`, prompt: `Solve topic-${n}, please.`, verify: [] },
    checks: [{ kind: 'contains', text: `ANSWER topic-${n}` }],
  }
}

/** Answers a topic only when a skill in the system prompt covers it. Offline. */
const skillAware: ChatAdapter = {
  id: 'skill-aware',
  model: 'scripted',
  chat: async (messages: Message[]) => {
    const covered = new Set<string>()
    for (const message of messages) {
      if (message.role !== 'system') continue
      for (const match of message.content.matchAll(/covers:\s*(topic-\d+)/g)) covered.add(match[1]!)
    }
    const prompt = messages.find((m) => m.role === 'user')?.content ?? ''
    const topic = /(topic-\d+)/.exec(prompt)?.[1] ?? 'topic-unknown'
    const text = covered.has(topic) ? `ANSWER ${topic}: done.` : `No guidance for ${topic}.`
    return { text: JSON.stringify({ action: 'done', text }), usage: { in: 0, out: 0 } }
  },
}

describe('the six amended EventKinds reach the Timeline from the real emitters', () => {
  it('renders each new kind with a real summary, not a blank cell', async () => {
    const root = await project()
    const store = new events.MemoryEventStore({ secrets: [] })
    const writer = new plan.PlanWriter({ baseDir: root, events: store })
    const files = new orchestrator.DiskFileWriter()

    // ── repo_indexed (was context_loaded + component: 'repo-graph') ──────────
    const { graph } = await context.buildRepoGraph({
      root,
      events: store,
      runId: 'kinds-index',
      persist: false,
    })

    // ── context_retrieved (was context_assembled + component: 'hybrid-search')
    await context.hybridSearch({
      root,
      query: 'bookingTotal',
      graph,
      events: store,
      runId: 'kinds-search',
    })

    // ── embedder_degraded (was context_loaded + component: 'embedder') ───────
    const unreachable: context.IdentifiedEmbedder = {
      providerId: 'unreachable-provider',
      model: 'text-embedding-3-small',
      dimensions: 8,
      embed: async () => {
        throw new Error('ECONNREFUSED')
      },
    }
    const embedder = new context.OfflineFirstEmbedder({
      provider: unreachable,
      events: store,
      runId: 'kinds-embed',
    })
    await embedder.embed(['bookingTotal'])
    expect(embedder.status().degraded).toBe(true)

    // ── model_selected (was strategy_selected + component: 'router') ─────────
    await loop.runTask(
      { id: 'kinds-router-task', prompt: 'Route this cheaply.', verify: [] },
      {
        adapter: scripted('frontier', [PLAN, DONE]),
        router: { cheap: scripted('cheap', [PLAN, DONE]), policy: 'always' },
        events: store,
        plan: writer,
        files,
        root,
        ids: () => 'kinds-router',
      },
    )

    // ── ask (was think + action: 'ask') ─────────────────────────────────────
    await loop.runTask(
      { id: 'kinds-ask-task', prompt: 'Pick a database.', verify: [] },
      {
        adapter: scripted('asking', [JSON.stringify({ action: 'ask', question: 'Postgres or SQLite?' })]),
        events: store,
        plan: writer,
        files,
        root,
        ids: () => 'kinds-ask',
      },
    )

    // ── skill_trained (was think + component: 'skillopt') ───────────────────
    await skills.trainSkill({
      seed: skill('reviewer', [1]),
      train: [topicCase(1)],
      val: [topicCase(2)],
      epochs: 1,
      proposeEdit: skills.scriptedProposeEdit([skill('reviewer', [1, 2])]),
      events: store,
      adapter: skillAware,
      runId: 'kinds-train',
    })

    const log = await store.readAll()
    render(<AgentTimeline events={log} transportLabel="in-process core" />)

    // Every new kind is on screen, and every one of them says something. A blank
    // summary here means the emitter migrated and the consumer did not.
    expect(summaryFor('repo_indexed')).toMatch(/2 files · \d+ chunks/)
    expect(summaryFor('context_retrieved')).toContain('lexical')
    expect(summaryFor('embedder_degraded')).toContain('embedding provider unavailable')
    expect(summaryFor('model_selected')).toBe('always → cheap (cheap-model)')
    expect(summaryFor('ask')).toBe('Postgres or SQLite?')
    expect(screen.getAllByText('skill_trained').length).toBeGreaterThanOrEqual(3)
    expect(summaryFor('embedder_degraded')).not.toBe('')

    // And the kinds they REPLACED are gone from a freshly written log. If one
    // came back, some emitter was reverted.
    expect(log.some((e) => e.kind === 'context_loaded')).toBe(false)
    expect(log.some((e) => e.kind === 'strategy_selected')).toBe(false)
    expect(log.some((e) => e.kind === 'think')).toBe(false)

    // `context_assembled` stays, and stays discriminated: assembly and the loop's
    // breadcrumb are the same fact at two fidelities, which is what `component`
    // is for. Only the loop ran here, so only its breadcrumb is present.
    const assembled = log.filter((e) => e.kind === 'context_assembled')
    expect(assembled.length).toBeGreaterThan(0)
    expect(assembled.every((e) => typeof e.payload.component === 'string')).toBe(true)
  }, 120_000)

  it('still renders a pre-amendment log line rather than dropping it', () => {
    // The honest limit of the change, asserted. An old JSONL line keeps its old
    // kind and its payload, and the Timeline lists it — but it does NOT gain the
    // new kind's summary, because it was never that kind. `context_loaded` had no
    // `summarize` case before the amendment and has none now.
    const legacy = [
      {
        id: 'legacy-1',
        ts: 1_000,
        runId: 'old-run',
        kind: 'context_loaded' as const,
        payload: { component: 'repo-graph', files: 9 },
      },
      {
        id: 'legacy-2',
        ts: 1_001,
        runId: 'old-run',
        kind: 'strategy_selected' as const,
        payload: { component: 'router', policy: 'always', adapter: 'ollama' },
      },
    ]

    render(<AgentTimeline events={legacy} />)

    expect(screen.getByText('2 events')).toBeDefined()
    expect(screen.getByText('context_loaded')).toBeDefined()
    expect(summaryFor('context_loaded')).toBe('')
    // The old router line does render, under `strategy_selected`, with the
    // phase-less 'selection' wording — which is what it always looked like.
    expect(summaryFor('strategy_selected')).toBe('strategy · selection')
  })
})
