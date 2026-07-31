// Agent loop tests.
//
// Uses REAL: the filesystem (temp dirs via mkdtemp), a real MemoryEventStore, a
// real PlanWriter, the real DiskFileWriter, and REAL SUBPROCESSES for verify
// (`process.execPath -e …`). The only substituted collaborator is the model
// itself, via FakeChatAdapter with a per-scenario injected script — which is the
// point of that seam.
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 3.3, 3.4, 6.4, 6.5

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runTask,
  DEFAULT_MAX_ITERATIONS,
  PLAN_GATE_REASON,
  RETRIEVED_CONTEXT_HEADING,
} from '../src/loop/index.js'
import { parseUnifiedDiff, applyHunks, allHunkIndexes } from '../src/diff/index.js'
import { parseAction } from '../src/loop/actions.js'
import { MemoryEventStore } from '../src/events/index.js'
import { PlanWriter } from '../src/plan/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { FakeChatAdapter, FAKE_DEFAULT_SCRIPT } from '../src/providers/fake.js'
import type { ChatAdapter, Message, SketchEvent, Task, Usage, VerifyCommand } from '../src/types.js'

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-loop-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A verify command that really passes, in a real child process. */
const PASSING: VerifyCommand = {
  name: 'unit',
  cmd: process.execPath,
  args: ['-e', 'process.stdout.write("all good")'],
}

/** A verify command that really fails and really writes to stderr. */
const FAILING: VerifyCommand = {
  name: 'unit',
  cmd: process.execPath,
  args: ['-e', 'console.error("BOOM-FROM-STDERR"); process.exit(1)'],
}

function task(overrides: Partial<Task> = {}): Task {
  return { id: 't1', prompt: 'Build the thing.', verify: [], ...overrides }
}

interface Harness {
  root: string
  events: MemoryEventStore
  plan: PlanWriter
  files: DiskFileWriter
}

async function harness(): Promise<Harness> {
  const root = await makeTmp()
  const events = new MemoryEventStore({ secrets: [] })
  return { root, events, plan: new PlanWriter({ baseDir: root, events }), files: new DiskFileWriter() }
}

function deps(h: Harness, adapter: ChatAdapter, extra: Record<string, unknown> = {}) {
  return {
    adapter,
    events: h.events,
    plan: h.plan,
    files: h.files,
    root: h.root,
    maxIterations: 6,
    ...extra,
  }
}

const kinds = (events: readonly SketchEvent[]): string[] => events.map((e) => e.kind)

const terminal = (events: readonly SketchEvent[]): SketchEvent[] =>
  events.filter((e) => e.kind === 'run_completed' || e.kind === 'run_failed')

/** Every message the model saw on its last call, flattened. */
const seenByModel = (adapter: FakeChatAdapter): string =>
  (adapter.lastMessages ?? []).map((m: Message) => m.content).join('\n---\n')

const PLAN_ACTION = JSON.stringify({ action: 'plan', artifacts: { prd: 'the prd', arch: 'the arch' } })
const DONE_ACTION = JSON.stringify({ action: 'done', text: 'finished' })

function editAction(path: string, replace: string, search = ''): string {
  return JSON.stringify({ action: 'edit', edits: [{ path, search, replace }] })
}

describe('the happy path', () => {
  it('runs the default three-call script plan → verify → done and returns ok', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter()
    const result = await runTask(task({ verify: [PASSING] }), deps(h, adapter))

    expect(adapter.script).toEqual(FAKE_DEFAULT_SCRIPT)
    expect(result.ok).toBe(true)
    expect(result.iterations).toBe(3)
    expect(result.finalText).toBe('Offline fixture run complete.')
    expect(result.verify.map((v) => [v.name, v.ok])).toEqual([['unit', true]])

    expect(kinds(result.events)).toEqual([
      'run_started',
      'context_assembled',
      'llm_request',
      'llm_response',
      'plan_written',
      'llm_request',
      'llm_response',
      'verify_started',
      'verify_result',
      'llm_request',
      'llm_response',
      'run_completed',
    ])

    // The plan really landed on disk, which is what the gate reads.
    expect(await h.plan.hasPlan(result.runId)).toBe(true)
  })

  it('documents a modest default iteration cap', () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(12)
  })
})

describe('the plan gate (Requirements 5.5, 6.4, 6.5)', () => {
  it('rejects an edit that arrives before any plan, writes nothing, feeds the refusal back, and keeps going', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({
      script: [editAction('src/sneaky.ts', 'export const x = 1\n'), PLAN_ACTION, DONE_ACTION],
    })

    const result = await runTask(task(), deps(h, adapter))

    const rejected = result.events.filter((e) => e.kind === 'edit_rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.payload.reason).toBe(PLAN_GATE_REASON)

    // Nothing was written and the accept event never fired for this run.
    expect(await exists(join(h.root, 'src', 'sneaky.ts'))).toBe(false)
    expect(kinds(result.events)).not.toContain('edit_accepted')
    expect(kinds(result.events)).not.toContain('edit_proposed')

    // The refusal reached the model...
    expect(seenByModel(adapter)).toContain('EDIT REJECTED')
    expect(seenByModel(adapter)).toContain(PLAN_GATE_REASON)

    // ...and the loop continued rather than dying: it went on to plan and finish.
    expect(result.iterations).toBe(3)
    expect(result.ok).toBe(true)
    expect(kinds(result.events)).toContain('plan_written')
    expect(terminal(result.events).map((e) => e.kind)).toEqual(['run_completed'])
  })

  it('accepts the same edit once a plan exists from an earlier iteration', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({
      script: [PLAN_ACTION, editAction('src/real.ts', 'export const x = 1\n'), DONE_ACTION],
    })

    const result = await runTask(task(), deps(h, adapter))

    expect(result.ok).toBe(true)
    expect(kinds(result.events)).not.toContain('edit_rejected')
    expect(await readFile(join(h.root, 'src', 'real.ts'), 'utf8')).toBe('export const x = 1\n')

    const accepted = result.events.filter((e) => e.kind === 'edit_accepted')
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.payload.path).toBe('src/real.ts')
    expect(accepted[0]!.payload.created).toBe(true)
    expect(seenByModel(adapter)).toContain('EDIT APPLIED')
  })

  it('still refuses independently when plan_written was emitted but the authoritative gate later denies', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({
      script: [PLAN_ACTION, editAction('src/denied.ts', 'export const denied = true\n'), DONE_ACTION],
    })
    const denyingPlan = {
      write: h.plan.write.bind(h.plan),
      // Models the artifact disappearing or becoming invalid after plan_written.
      // A UI projection would be unlocked, but the engine asks this seam again.
      hasPlan: async (_runId: string) => false,
    }

    const result = await runTask(task(), deps(h, adapter, { plan: denyingPlan }))
    const order = kinds(result.events)

    expect(order).toContain('plan_written')
    expect(order.indexOf('plan_written')).toBeLessThan(order.indexOf('edit_rejected'))
    expect(result.events.find((event) => event.kind === 'edit_rejected')?.payload.reason).toBe(
      PLAN_GATE_REASON,
    )
    expect(order).not.toContain('edit_proposed')
    expect(order).not.toContain('edit_accepted')
    expect(await exists(join(h.root, 'src', 'denied.ts'))).toBe(false)
  })
})

describe('human review mode (Requirements 16.1, 16.4, 16.5)', () => {
  it('emits a real applicable patch and leaves disk untouched for review', async () => {
    const h = await harness()
    await writeFile(join(h.root, 'review.txt'), 'alpha\r\nbeta\r\n', 'utf8')
    const adapter = new FakeChatAdapter({
      script: [PLAN_ACTION, editAction('review.txt', 'BETA', 'beta'), DONE_ACTION],
    })

    const result = await runTask(task(), deps(h, adapter, { reviewEdits: true }))
    const proposal = result.events.find((event) => event.kind === 'edit_proposed')!
    const edit = (proposal.payload.edits as Array<{ diff: string }>)[0]!

    expect(proposal.payload.reviewRequired).toBe(true)
    expect(edit.diff).toContain('-beta')
    expect(edit.diff).toContain('+BETA')
    expect(await readFile(join(h.root, 'review.txt'), 'utf8')).toBe('alpha\r\nbeta\r\n')
    expect(kinds(result.events)).not.toContain('edit_accepted')

    const parsed = parseUnifiedDiff(edit.diff)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const reviewed = applyHunks(
      'alpha\r\nbeta\r\n',
      parsed.hunks,
      allHunkIndexes(parsed.hunks),
    )
    expect(reviewed).toEqual({ ok: true, content: 'alpha\r\nBETA\r\n' })
  })
})

describe('event-before-action ordering (Requirement 3.3)', () => {
  it('emits edit_proposed before edit_accepted, run_started first, and the terminal event last', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({
      script: [PLAN_ACTION, editAction('a.txt', 'hello'), DONE_ACTION],
    })

    const result = await runTask(task(), deps(h, adapter))
    const order = kinds(result.events)

    expect(order[0]).toBe('run_started')
    expect(order[order.length - 1]).toBe('run_completed')

    const proposed = order.indexOf('edit_proposed')
    const accepted = order.indexOf('edit_accepted')
    expect(proposed).toBeGreaterThan(-1)
    expect(accepted).toBeGreaterThan(proposed)

    const proposal = result.events[proposed]!
    const edits = proposal.payload.edits as Array<{ path: string; diff?: string }>
    expect(edits[0]!.path).toBe('a.txt')
    expect(edits[0]!.diff).toContain('@@ -0,0 +1,1 @@')
    const parsed = parseUnifiedDiff(edits[0]!.diff!)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const applied = applyHunks('', parsed.hunks, allHunkIndexes(parsed.hunks))
      expect(applied).toEqual({ ok: true, content: 'hello' })
    }

    // The announce-before-acting rule holds for the model call too.
    expect(order.indexOf('llm_request')).toBeLessThan(order.indexOf('llm_response'))
    // And for verify, whose events come from the runner's sink.
    expect(order).not.toContain('verify_started')
  })

  it('emits verify_started before verify_result', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter()
    const result = await runTask(task({ verify: [PASSING] }), deps(h, adapter))
    const order = kinds(result.events)
    expect(order.indexOf('verify_started')).toBeLessThan(order.indexOf('verify_result'))
  })
})

describe('exactly one terminal event (Requirement 3.4)', () => {
  it('emits one run_completed on the success path', async () => {
    const h = await harness()
    const result = await runTask(task({ verify: [PASSING] }), deps(h, new FakeChatAdapter()))
    expect(terminal(result.events).map((e) => e.kind)).toEqual(['run_completed'])
  })

  it('emits one run_failed on the failure path', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({ script: ['{"action":"verify"}', DONE_ACTION] })
    const result = await runTask(task({ verify: [FAILING] }), deps(h, adapter))

    expect(result.ok).toBe(false)
    expect(terminal(result.events).map((e) => e.kind)).toEqual(['run_failed'])
  })
})

describe('parsing model output (Requirements 5.2, 5.3)', () => {
  it('degrades unparseable output to think and continues', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({
      script: ['I am afraid I cannot do that, Dave.', DONE_ACTION],
    })

    const result = await runTask(task(), deps(h, adapter))

    const thoughts = result.events.filter((e) => e.kind === 'think')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]!.payload.degraded).toBe(true)
    expect(thoughts[0]!.payload.text).toBe('I am afraid I cannot do that, Dave.')

    expect(result.ok).toBe(true)
    expect(result.iterations).toBe(2)
  })

  it('parses a fenced JSON action', async () => {
    const h = await harness()
    const fenced = '```json\n{ "action": "plan", "artifacts": { "prd": "fenced prd" } }\n```'
    const adapter = new FakeChatAdapter({ script: [fenced, DONE_ACTION] })

    const result = await runTask(task(), deps(h, adapter))

    expect(kinds(result.events)).toContain('plan_written')
    expect(kinds(result.events)).not.toContain('think')
    expect(await h.plan.readPlan(result.runId)).toEqual({ prd: 'fenced prd' })
  })

  it('degrades an unknown action name and a malformed edit batch', () => {
    expect(parseAction('{"action":"delete_everything"}')).toMatchObject({
      action: 'think',
      degraded: true,
    })
    expect(parseAction('{"action":"edit","edits":"src/a.ts"}')).toMatchObject({
      action: 'think',
      degraded: true,
    })
    expect(parseAction('{"action":"verify"}')).toEqual({ action: 'verify' })
  })
})

describe('verify feedback (Requirements 5.6, 5.8)', () => {
  it('feeds captured stderr from a failing command back to the model', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({ script: ['{"action":"verify"}', DONE_ACTION] })

    const result = await runTask(task({ verify: [FAILING] }), deps(h, adapter))

    expect(seenByModel(adapter)).toContain('VERIFY FAIL')
    expect(seenByModel(adapter)).toContain('BOOM-FROM-STDERR')
    expect(result.verify[0]!.ok).toBe(false)
    expect(result.verify[0]!.exitCode).toBe(1)
  })

  it('done after a failing verify is not ok', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({ script: ['{"action":"verify"}', DONE_ACTION] })
    const result = await runTask(task({ verify: [FAILING] }), deps(h, adapter))
    expect(result.ok).toBe(false)
    expect(result.finalText).toBe('finished')
  })

  it('done with no verify commands configured is ok', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({ script: [DONE_ACTION] })
    const result = await runTask(task({ verify: [] }), deps(h, adapter))

    expect(result.ok).toBe(true)
    expect(result.verify).toEqual([])
    expect(kinds(result.events)).not.toContain('verify_started')
  })

  it('runs configured commands on done when the model never verified', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({ script: [DONE_ACTION] })
    const result = await runTask(task({ verify: [PASSING] }), deps(h, adapter))

    expect(result.iterations).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.verify.map((v) => v.name)).toEqual(['unit'])
    expect(kinds(result.events)).toContain('verify_result')
  })
})

describe('termination', () => {
  it('emits exactly one run_failed with a reason on maxIterations exhaustion', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({ script: ['{"action":"think","text":"pondering"}'] })

    const result = await runTask(task(), deps(h, adapter, { maxIterations: 2 }))

    expect(result.ok).toBe(false)
    expect(result.iterations).toBe(2)
    const terminals = terminal(result.events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.kind).toBe('run_failed')
    expect(terminals[0]!.payload.reason).toBe('max_iterations')
    expect(result.finalText).toContain('maxIterations (2)')
  })

  it('treats ask as a terminal not-ok run carrying the question', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({
      script: [JSON.stringify({ action: 'ask', question: 'Which database?' })],
    })

    const result = await runTask(task(), deps(h, adapter))

    expect(result.ok).toBe(false)
    expect(result.finalText).toBe('Which database?')
    const terminals = terminal(result.events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.payload.reason).toBe('awaiting_human_input')
  })

  it('fails the run without an unhandled rejection when the adapter throws, redacting the message', async () => {
    const h = await harness()
    const throwing: ChatAdapter = {
      id: 'exploding',
      chat: async () => {
        throw new Error('upstream refused key sk-abcdef1234567890xyz')
      },
    }

    const result = await runTask(task(), deps(h, throwing))

    expect(result.ok).toBe(false)
    expect(result.finalText).toContain('Provider error')
    expect(result.finalText).not.toContain('sk-abcdef1234567890xyz')
    const terminals = terminal(result.events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.kind).toBe('run_failed')
    expect(terminals[0]!.payload.reason).toBe('provider_error')
    expect(JSON.stringify(terminals[0]!.payload)).not.toContain('sk-abcdef1234567890xyz')
  })

  it('terminates when the signal aborts', async () => {
    const h = await harness()
    const controller = new AbortController()
    const adapter = new FakeChatAdapter({ script: [PLAN_ACTION, DONE_ACTION] })
    controller.abort()

    const result = await runTask(task(), deps(h, adapter, { signal: controller.signal }))

    expect(result.ok).toBe(false)
    expect(result.finalText).toBe('Run aborted.')
    expect(adapter.callCount).toBe(0)
    const terminals = terminal(result.events)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.payload.reason).toBe('aborted')
  })

  it('aborts mid-run once the signal fires', async () => {
    const h = await harness()
    const controller = new AbortController()
    let calls = 0
    const adapter: ChatAdapter = {
      id: 'aborter',
      chat: async () => {
        calls++
        controller.abort()
        return { text: '{"action":"think","text":"one more"}', usage: { in: 1, out: 1 } }
      },
    }

    const result = await runTask(task(), deps(h, adapter, { signal: controller.signal }))

    expect(calls).toBe(1)
    expect(result.ok).toBe(false)
    expect(terminal(result.events).map((e) => e.payload.reason)).toEqual(['aborted'])
  })
})

describe('tool actions (Requirement 5.9)', () => {
  it('denies a tool call and continues', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({
      script: [JSON.stringify({ action: 'tool', name: 'shell', args: { cmd: 'rm -rf /' } }), DONE_ACTION],
    })

    const result = await runTask(task(), deps(h, adapter))

    const denied = result.events.filter((e) => e.kind === 'tool_denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]!.payload.name).toBe('shell')
    expect(String(denied[0]!.payload.reason)).toContain('tools are not yet available')
    expect(seenByModel(adapter)).toContain('TOOL DENIED')
    expect(result.ok).toBe(true)
    expect(result.iterations).toBe(2)
  })
})

describe('edit failure modes', () => {
  it('reports a search string that does not match, leaving the file untouched', async () => {
    const h = await harness()
    await writeFile(join(h.root, 'a.txt'), 'original content\n', 'utf8')
    const adapter = new FakeChatAdapter({
      script: [PLAN_ACTION, editAction('a.txt', 'replacement', 'NOT PRESENT'), DONE_ACTION],
    })

    const result = await runTask(task(), deps(h, adapter))

    const rejected = result.events.filter((e) => e.kind === 'edit_rejected')
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]!.payload.reason)).toContain('search string not found')
    expect(await readFile(join(h.root, 'a.txt'), 'utf8')).toBe('original content\n')
    expect(seenByModel(adapter)).toContain('REFUSED')
    expect(kinds(result.events)).not.toContain('edit_accepted')
  })

  it('applies a matching search/replace to the first occurrence only', async () => {
    const h = await harness()
    await writeFile(join(h.root, 'a.txt'), 'x = 1\nx = 1\n', 'utf8')
    const adapter = new FakeChatAdapter({
      script: [PLAN_ACTION, editAction('a.txt', 'x = 2', 'x = 1'), DONE_ACTION],
    })

    await runTask(task(), deps(h, adapter))

    expect(await readFile(join(h.root, 'a.txt'), 'utf8')).toBe('x = 2\nx = 1\n')
  })

  it('refuses a path outside the project root', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({
      script: [PLAN_ACTION, editAction('../escaped.txt', 'pwned'), DONE_ACTION],
    })

    const result = await runTask(task(), deps(h, adapter))

    const rejected = result.events.filter((e) => e.kind === 'edit_rejected')
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]!.payload.reason)).toContain('outside the project root')
    expect(await exists(join(h.root, '..', 'escaped.txt'))).toBe(false)
    expect(kinds(result.events)).not.toContain('edit_accepted')
    // Proposed still precedes the per-edit verdict: the gate was open, this edit
    // was not.
    expect(kinds(result.events)).toContain('edit_proposed')
  })
})

describe('cost accounting inputs', () => {
  it('puts usage on every llm_response event', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter()
    const result = await runTask(task({ verify: [PASSING] }), deps(h, adapter))

    const responses = result.events.filter((e) => e.kind === 'llm_response')
    expect(responses).toHaveLength(3)
    for (const event of responses) {
      const usage = event.payload.usage as Usage
      expect(typeof usage.in).toBe('number')
      expect(typeof usage.out).toBe('number')
      expect(usage.in).toBeGreaterThan(0)
      expect(usage.out).toBeGreaterThan(0)
    }
  })

  it('reports zeros when an adapter cannot count tokens', async () => {
    const h = await harness()
    const silent: ChatAdapter = { id: 'silent', chat: async () => ({ text: DONE_ACTION }) }

    const result = await runTask(task(), deps(h, silent))

    const response = result.events.find((e) => e.kind === 'llm_response')!
    expect(response.payload.usage).toEqual({ in: 0, out: 0 })
  })
})

// ── retrieved context (Requirement 18.4, the loop's half of it) ──────────────
//
// The loop does no retrieval. What it owes the context layer is a way in that is
// distinguishable from `AGENTS.md`, does not appear when nothing was retrieved,
// and does not put repository bodies on the event log a second time.

describe('retrieved context', () => {
  it('shows the assembled text to the model under its own heading, with a caveat', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({ script: [DONE_ACTION] })

    await runTask(
      task(),
      deps(h, adapter, { retrievedContext: 'export const RETRY_BUDGET_MS = 4500' }),
    )

    const seen = seenByModel(adapter)
    expect(seen).toContain(RETRIEVED_CONTEXT_HEADING)
    expect(seen).toContain('export const RETRY_BUDGET_MS = 4500')
    // Labelled as retrieval, not as instruction. A model that reads a retrieved
    // guess as a project rule will follow a file it merely happened to find.
    expect(seen).toMatch(/evidence to check/i)
  })

  it('is a separate system message from AGENTS.md, not merged into it', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({ script: [DONE_ACTION] })

    await runTask(
      task(),
      deps(h, adapter, {
        projectContext: { agents: 'Always run npm test.', claude: '' },
        retrievedContext: 'export const RETRY_BUDGET_MS = 4500',
      }),
    )

    const messages = adapter.lastMessages ?? []
    const agents = messages.filter((m) => m.content.includes('Always run npm test.'))
    const retrieved = messages.filter((m) => m.content.includes(RETRIEVED_CONTEXT_HEADING))
    expect(agents).toHaveLength(1)
    expect(retrieved).toHaveLength(1)
    expect(agents[0]).not.toBe(retrieved[0])
    expect(retrieved[0]!.content).not.toContain('Always run npm test.')
  })

  it('adds no message at all when it is absent or blank', async () => {
    const h = await harness()

    const without = new FakeChatAdapter({ script: [DONE_ACTION] })
    await runTask(task(), deps(h, without))
    const blank = new FakeChatAdapter({ script: [DONE_ACTION] })
    await runTask(task(), deps(h, blank, { retrievedContext: '   \n  ' }))

    expect((blank.lastMessages ?? []).length).toBe((without.lastMessages ?? []).length)
    expect(seenByModel(blank)).not.toContain(RETRIEVED_CONTEXT_HEADING)
  })

  it('logs that context was supplied and how big it was, never the text itself', async () => {
    const h = await harness()
    const adapter = new FakeChatAdapter({ script: [DONE_ACTION] })
    const body = 'export const RETRY_BUDGET_MS = 4500'

    const result = await runTask(task(), deps(h, adapter, { retrievedContext: body }))

    const breadcrumb = result.events.find(
      (e) => e.kind === 'context_assembled' && e.payload.component === 'agent-loop',
    )!
    expect(breadcrumb.payload.hasRetrievedContext).toBe(true)
    expect(breadcrumb.payload.retrievedContextChars).toBe(body.length)
    // The bodies belong to the assembly event's path list, not to this one.
    expect(JSON.stringify(breadcrumb.payload)).not.toContain('RETRY_BUDGET_MS')
  })
})
