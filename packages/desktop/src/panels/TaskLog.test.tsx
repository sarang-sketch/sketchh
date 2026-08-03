// The Tasks panel, driven by a real event stream.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §1 — `MOCK_TASKS` is gone at the source level, along with its invented durations,
//     invented per-row costs, invented npm error, invented 65% progress bar, and four
//     agent names this product does not have.
//   * §2 — the filter WORKS. It was declared, bound to state, and never applied: the
//     string `.filter(` did not appear in the file, so choosing "Failed" changed nothing.
//   * §3 — the rows are a projection of the log, and `projectRuns` is driven directly so
//     the projection is tested rather than the markup around it.
//   * §4 — a run driven by a real `runTask` produces a real row, so the projection is
//     tested against the events the engine actually emits rather than against fixtures of
//     what this file assumed they look like.
//
// Validates: Requirements 27.1, 27.3, 27.4, 14.6

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { events as coreEvents, loop, orchestrator, plan, providers } from '@sketch/core'

import { readCode } from '../testing/source'
import { TaskLog, projectRuns, type RunRow } from './TaskLog'
import { SketchClientProvider } from '../lib/ClientProvider'
import {
  createEventBus,
  type EventHandler,
  type PingResult,
  type SketchClient,
} from '../lib/client'
import type { SketchEvent } from '../lib/contracts'
import { AppStateProvider } from '../state/AppState'

const code = readCode

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-tasklog-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  cleanup()
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

class StreamClient implements SketchClient {
  readonly transport = 'stdio' as const
  readonly bus = createEventBus()

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('this panel never starts a run'))
  }
  eval(): Promise<never[]> {
    return Promise.resolve([])
  }
  subscribe(handler: EventHandler) {
    return this.bus.subscribe(handler)
  }
  gitStatus(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitDiff(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitStage(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitUnstage(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitCommit(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  providerCatalog(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  saveProviderSettings(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  testProvider(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
}

let seq = 0
function event(
  runId: string,
  kind: SketchEvent['kind'],
  payload: Record<string, unknown> = {},
  ts = ++seq,
): SketchEvent {
  return { id: `e${++seq}`, ts, runId, kind, payload }
}

function mount(client: StreamClient) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: null }}>
        <TaskLog />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

/** One finished run and one failed one, as the engine really shapes them. */
function twoRuns(): SketchEvent[] {
  return [
    event('r-ok', 'run_started', { taskId: 't1', prompt: 'Add a login form', adapter: 'fake', maxIterations: 6 }, 100),
    event('r-ok', 'run_completed', { ok: true, reason: 'done', iterations: 3, verify: [{ name: 'unit', ok: true }] }, 2600),
    event('r-bad', 'run_started', { taskId: 't2', prompt: 'Break the build', adapter: 'fake', maxIterations: 6 }, 3000),
    event('r-bad', 'run_failed', { ok: false, reason: 'verify_failed', iterations: 4, verify: [{ name: 'unit', ok: false }] }, 3500),
  ]
}

// ── 1. the fixture is gone ──────────────────────────────────────────────────

describe('the fixture this panel replaced', () => {
  it('has no MOCK_TASKS and none of its invented values', () => {
    const panel = code(join('panels', 'TaskLog.tsx'))
    expect(panel).not.toContain('MOCK_TASKS')
    expect(panel).not.toContain('npm ERR! code ERESOLVE')
    expect(panel).not.toContain('$0.15')
    expect(panel).not.toContain('progress: 65')
    // Four agent names that are not roles this product has. `Architect` IS a real role, so
    // the assertion is about the fixture's own quoted strings.
    expect(panel).not.toContain("agent: 'Coder'")
    expect(panel).not.toContain("agent: 'QA'")
    expect(panel).not.toContain("agent: 'System'")
  })

  it('really applies its filter, which it did not before', () => {
    const panel = code(join('panels', 'TaskLog.tsx'))
    expect(panel).toContain('.filter(')
    expect(panel).toContain('matchesFilter')
  })
})

// ── 2. the projection ───────────────────────────────────────────────────────

describe('projectRuns', () => {
  it('makes one row per run and reads every field off the log', () => {
    const rows = projectRuns(twoRuns())
    expect(rows).toHaveLength(2)

    const ok = rows.find((row) => row.runId === 'r-ok')!
    expect(ok.status).toBe('done')
    expect(ok.name).toBe('Add a login form')
    expect(ok.taskId).toBe('t1')
    expect(ok.adapter).toBe('fake')
    expect(ok.iterations).toBe(3)
    expect(ok.durationMs).toBe(2500)
    expect(ok.reason).toBe('done')
    expect(ok.verify).toEqual([{ name: 'unit', ok: true }])

    const bad = rows.find((row) => row.runId === 'r-bad')!
    expect(bad.status).toBe('failed')
    expect(bad.reason).toBe('verify_failed')
    expect(bad.verify).toEqual([{ name: 'unit', ok: false }])
  })

  it('treats a run with no terminal event as running, with no duration', () => {
    const rows = projectRuns([
      event('r-live', 'run_started', { prompt: 'Still going', adapter: 'fake', maxIterations: 12 }, 10),
      event('r-live', 'llm_request', { iteration: 1 }, 20),
      event('r-live', 'llm_response', { iteration: 2 }, 30),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('running')
    expect(rows[0]!.durationMs).toBeNull()
    // The only progress figure the engine reports: iterations against the cap.
    expect(rows[0]!.iterations).toBe(2)
    expect(rows[0]!.maxIterations).toBe(12)
  })

  it('does not drop a run whose start it never saw', () => {
    // A slice the user scrolled into halfway. Hiding it would hide a run that happened.
    const rows = projectRuns([event('r-partial', 'run_failed', { reason: 'aborted' }, 5)])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBeNull()
    expect(rows[0]!.status).toBe('failed')
  })

  it('does not turn the dispatcher slice into a task row', () => {
    // A dispatch is a ladder, not a task, and nothing emits `run_started` under its id.
    const rows = projectRuns([
      event('d1', 'strategy_selected', { component: 'dispatcher', phase: 'attempt', strategy: 'swarm' }, 1),
      event('d1-r1', 'run_started', { prompt: 'Sub-run', adapter: 'fake' }, 2),
      event('d1-r1', 'run_completed', { reason: 'done' }, 3),
    ])
    expect(rows.map((row) => row.runId)).toEqual(['d1-r1'])
    // And the sub-run says which strategy drove it, because its id derives from the dispatch.
    expect(rows[0]!.strategy).toBe('swarm')
  })

  it('does not read the cost router\u2019s model_selected as a dispatch', () => {
    // Since the `EventKind` amendment the router emits its OWN kind, so this can
    // no longer be confused with a strategy by accident. Asserted anyway: the
    // projection must not start treating an unrelated kind as a dispatch.
    const rows = projectRuns([
      event('r1', 'run_started', { prompt: 'x', adapter: 'frontier' }, 1),
      event('r1', 'model_selected', { policy: 'after-plan', adapter: 'ollama' }, 2),
      event('r1', 'run_completed', { reason: 'done' }, 3),
    ])
    expect(rows[0]!.strategy).toBeNull()
  })

  it('does not read a PRE-AMENDMENT router strategy_selected as a dispatch', () => {
    // The old-log case, kept as a live test rather than a promise in a comment.
    // JSONL written before the amendment carries the router under
    // `strategy_selected` with `component: 'router'`. The `component` check in the
    // projection is what keeps that from labelling the run with a strategy nobody
    // chose, so removing the check has to fail something.
    const rows = projectRuns([
      event('r1', 'run_started', { prompt: 'x', adapter: 'frontier' }, 1),
      event('r1', 'strategy_selected', { component: 'router', policy: 'after-plan' }, 2),
      event('r1', 'run_completed', { reason: 'done' }, 3),
    ])
    expect(rows[0]!.strategy).toBeNull()
  })
})

// ── 3. the panel, and the filter that now works ─────────────────────────────

describe('the panel', () => {
  it('says nothing has run rather than showing invented rows', () => {
    mount(new StreamClient())
    expect(screen.getByText(/No task has run in this session/)).toBeTruthy()
  })

  it('renders a row per streamed run and filters for real', async () => {
    const client = new StreamClient()
    mount(client)
    for (const entry of twoRuns()) client.bus.emit(entry)

    await waitFor(() => expect(screen.getByText('Add a login form')).toBeTruthy())
    expect(screen.getByText('Break the build')).toBeTruthy()

    const select = screen.getByLabelText('Filter tasks by status')
    fireEvent.change(select, { target: { value: 'Failed' } })
    await waitFor(() => expect(screen.queryByText('Add a login form')).toBeNull())
    expect(screen.getByText('Break the build')).toBeTruthy()

    fireEvent.change(select, { target: { value: 'Running' } })
    await waitFor(() => expect(screen.getByText(/none of them running/)).toBeTruthy())
    expect(screen.queryByText('Break the build')).toBeNull()

    fireEvent.change(select, { target: { value: 'All' } })
    await waitFor(() => expect(screen.getByText('Add a login form')).toBeTruthy())
  })

  it('shows the real reason and the real failed stage when a row is expanded', async () => {
    const client = new StreamClient()
    mount(client)
    for (const entry of twoRuns()) client.bus.emit(entry)

    await waitFor(() => expect(screen.getByText('Break the build')).toBeTruthy())
    fireEvent.click(screen.getByText('Break the build'))
    await waitFor(() => expect(screen.getByText(/verify_failed/)).toBeTruthy())
    expect(screen.getByText(/failed stages:/)).toBeTruthy()
  })

  it('carries no per-row cost figure, and links to the one cost source', async () => {
    const client = new StreamClient()
    mount(client)
    for (const entry of twoRuns()) client.bus.emit(entry)
    await waitFor(() => expect(screen.getByText('Add a login form')).toBeTruthy())
    expect(document.body.textContent).not.toContain('$')
    expect(screen.getByText(/open the Cost panel/)).toBeTruthy()
  })
})

// ── 4. against a real run ───────────────────────────────────────────────────

describe('the projection against events a real runTask emitted', () => {
  it('produces a row whose every field came off the real log', async () => {
    const root = await makeTmp()
    const store = new coreEvents.MemoryEventStore({ secrets: [] })
    const result = await loop.runTask(
      { id: 'real-1', prompt: 'Offline fixture run', verify: [] },
      {
        adapter: new providers.FakeChatAdapter({}),
        events: store,
        plan: new plan.PlanWriter({ baseDir: root, events: store }),
        files: new orchestrator.DiskFileWriter(),
        root,
        maxIterations: 5,
      },
    )

    const rows: RunRow[] = projectRuns(await store.readAll())
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.runId).toBe(result.runId)
    expect(row.taskId).toBe('real-1')
    expect(row.name).toBe('Offline fixture run')
    expect(row.status).toBe(result.ok ? 'done' : 'failed')
    expect(row.iterations).toBe(result.iterations)
    expect(row.adapter).toBe('fake')
    expect(row.durationMs).not.toBeNull()
  })
})
