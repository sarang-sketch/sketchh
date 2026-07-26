// Contract tests for the canonical types in src/types.ts.
//
// These are deliberately part compile-time, part runtime:
//   · the compile-time half fails `npm run typecheck` if a member of EventKind is
//     removed (the literal array stops assigning) or added (the exhaustive record
//     stops being satisfied);
//   · the runtime half proves every contract shape survives a JSON round-trip,
//     which is what "everything is serializable" means in practice.
//
// Validates: Requirements 2.1, 3.1

import { describe, it, expect } from 'vitest'
import type {
  ChatAdapter,
  Check,
  EvalCase,
  EvalResult,
  EventKind,
  Message,
  ProjectContext,
  ProviderConfig,
  ProviderKind,
  RunResult,
  SecretStore,
  SketchEvent,
  Skill,
  Task,
  Usage,
  VerifyCommand,
  VerifyResult,
} from '../src/types.js'

// Every EventKind literal the design lists, in design order.
// Typed as EventKind[]: drop a member from the union and this stops compiling.
const ALL_EVENT_KINDS: EventKind[] = [
  'run_started', 'plan_written', 'skill_loaded', 'context_loaded', 'context_assembled',
  'llm_request', 'llm_response', 'think',
  'verify_started', 'verify_result',
  'edit_proposed', 'edit_accepted', 'edit_rejected',
  'tool_called', 'tool_denied',
  'budget_exceeded', 'cache_hit', 'strategy_selected',
  'memory_retrieved', 'memory_superseded', 'diagram_updated',
  'run_completed', 'run_failed', 'eval_scored',
]

// The other direction: a Record keyed by the union is only constructible when
// every member is listed, so ADDING a kind without updating this file fails the
// build too. Together the two declarations pin the union exactly.
const EVENT_KIND_EXHAUSTIVE: Record<EventKind, true> = {
  run_started: true, plan_written: true, skill_loaded: true, context_loaded: true,
  context_assembled: true, llm_request: true, llm_response: true, think: true,
  verify_started: true, verify_result: true, edit_proposed: true, edit_accepted: true,
  edit_rejected: true, tool_called: true, tool_denied: true, budget_exceeded: true,
  cache_hit: true, strategy_selected: true, memory_retrieved: true,
  memory_superseded: true, diagram_updated: true, run_completed: true,
  run_failed: true, eval_scored: true,
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('EventKind', () => {
  it('has exactly the 24 kinds the design specifies', () => {
    expect(ALL_EVENT_KINDS).toHaveLength(24)
    expect(new Set(ALL_EVENT_KINDS).size).toBe(24)
  })

  it('contains no kind outside the union and no union member unlisted', () => {
    const fromRecord = Object.keys(EVENT_KIND_EXHAUSTIVE).sort()
    expect(fromRecord).toEqual([...ALL_EVENT_KINDS].sort())
  })
})

describe('serializability', () => {
  const event: SketchEvent = {
    id: 'evt-1',
    ts: 1_700_000_000_000,
    runId: 'run-1',
    kind: 'run_started',
    payload: { prompt: 'add a button', nested: { depth: 2 }, list: [1, 2, 3] },
  }

  const verifyCommand: VerifyCommand = {
    name: 'test',
    cmd: 'npm',
    args: ['test'],
    cwd: '.',
    timeoutMs: 60_000,
  }

  const verifyResult: VerifyResult = {
    name: 'test',
    ok: true,
    exitCode: 0,
    stdout: '101 passed',
    stderr: '',
    durationMs: 1234,
  }

  const task: Task = {
    id: 'task-1',
    prompt: 'add a button',
    verify: [verifyCommand],
    skillNames: ['frontend-design'],
  }

  const run: RunResult = {
    runId: 'run-1',
    ok: true,
    finalText: 'done',
    iterations: 3,
    verify: [verifyResult],
    events: [event],
  }

  const checks: Check[] = [
    { kind: 'verify-pass' },
    { kind: 'contains', text: 'button' },
    { kind: 'not-contains', text: 'TODO' },
  ]

  const evalCase: EvalCase = { id: 'case-1', task, checks }

  it('round-trips a SketchEvent unchanged', () => {
    expect(roundTrip(event)).toEqual(event)
  })

  it('round-trips a Task unchanged', () => {
    expect(roundTrip(task)).toEqual(task)
  })

  it('round-trips a RunResult unchanged, nested events and all', () => {
    const back = roundTrip(run)
    expect(back).toEqual(run)
    expect(back.events[0]!.kind).toBe('run_started')
    expect(back.verify[0]!.ok).toBe(true)
  })

  it('round-trips an EvalCase unchanged, including the Check union', () => {
    const back = roundTrip(evalCase)
    expect(back).toEqual(evalCase)
    expect(back.checks.map(c => c.kind)).toEqual(['verify-pass', 'contains', 'not-contains'])
  })

  it('round-trips a VerifyResult unchanged', () => {
    expect(roundTrip(verifyResult)).toEqual(verifyResult)
  })

  it('round-trips the remaining record shapes unchanged', () => {
    const skill: Skill = {
      name: 'context-packing',
      description: 'packs context',
      body: '# body',
      source: '.sketch/skills/context-packing',
      capabilities: ['read'],
    }
    const projectContext: ProjectContext = { agents: 'AGENTS.md', claude: 'CLAUDE.md' }
    const messages: Message[] = [
      { role: 'system', content: 'you are' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', content: '{"ok":true}' },
    ]
    const usage: Usage = { in: 10, out: 20 }
    const kind: ProviderKind = 'openai-compatible'
    const providerConfig: ProviderConfig = {
      id: 'local',
      kind,
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder',
      headers: { 'x-trace': '1' },
    }
    const evalResult: EvalResult = {
      caseId: 'case-1',
      score: 1,
      passed: true,
      passedChecks: 3,
      totalChecks: 3,
      detail: 'all checks green',
    }

    expect(roundTrip(skill)).toEqual(skill)
    expect(roundTrip(projectContext)).toEqual(projectContext)
    expect(roundTrip(messages)).toEqual(messages)
    expect(roundTrip(usage)).toEqual(usage)
    expect(roundTrip(providerConfig)).toEqual(providerConfig)
    expect(roundTrip(evalResult)).toEqual(evalResult)
  })
})

describe('behavioural contracts', () => {
  it('lets a minimal object literal satisfy ChatAdapter', async () => {
    const adapter: ChatAdapter = {
      id: 'fake',
      async chat(m: Message[]) {
        return { text: m.at(-1)?.content ?? '', usage: { in: 1, out: 1 } }
      },
    }

    const out = await adapter.chat([{ role: 'user', content: 'echo me' }])
    expect(adapter.id).toBe('fake')
    expect(out.text).toBe('echo me')
    expect(out.usage).toEqual({ in: 1, out: 1 })
  })

  it('lets an in-memory object satisfy SecretStore', async () => {
    const rows = new Map<string, string>()
    const store: SecretStore = {
      async get(id) { return rows.get(id) ?? null },
      async set(id, v) { rows.set(id, v) },
      async del(id) { rows.delete(id) },
    }

    expect(await store.get('openai')).toBeNull()
    await store.set('openai', 'sk-test')
    expect(await store.get('openai')).toBe('sk-test')
    await store.del('openai')
    expect(await store.get('openai')).toBeNull()
  })
})

describe('root re-export surface', () => {
  it('exposes the canonical contracts flat from the package root', async () => {
    const root = await import('../src/index.js')
    // Types erase at runtime, so assert the namespaces still exist alongside them;
    // the type-only reachability is proven by this file's own imports compiling
    // and by typecheck over src/index.ts.
    for (const ns of ['providers', 'context', 'verifier', 'memory', 'orchestrator']) {
      expect(root).toHaveProperty(ns)
    }
  })
})
