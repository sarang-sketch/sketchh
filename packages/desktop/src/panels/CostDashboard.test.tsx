// The Cost panel, driven against the REAL engine over a REAL JSONL event log.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §1 — RECONCILIATION IS AN EQUALITY, not a tolerance. The figure on screen is
//     `ledgerFor(the log)` to the last decimal place, because both sides are the same
//     computation over the same bytes (Requirement 20.8).
//   * §2 — an unpriced model shows as "unknown" and is COUNTED. It is never rendered as
//     $0.00. That is the one failure this whole phase exists to prevent.
//   * §2 — a local-only run shows a real $0.00 and says why, so the two zeros are
//     distinguishable on screen.
//   * §3 — the three fixtures are gone at the source level: both `$1.4025` strings and
//     `AppState.totalCost`.
//   * §3 — there is no second cost source. The panel keeps no counter and `AppState`
//     holds no total.
//
// Validates: Requirements 20.1, 20.2, 20.8, 27.1, 14.6

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readCode } from '../testing/source'

import { METHODS, cost as costLib, type MethodContext } from '@sketch/core'

import { CostDashboard } from './CostDashboard'
import { SketchClientProvider } from '../lib/ClientProvider'
import {
  createEventBus,
  type CostReport,
  type EventHandler,
  type PingResult,
  type SketchClient,
} from '../lib/client'
import { AppStateProvider } from '../state/AppState'

const tmpDirs: string[] = []

afterEach(cleanup)
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * Shipped source with its comments removed.
 *
 * The fixture guards below search for `$1.4025` and `14.2k tokens`, and a first version
 * searched the raw file and failed — on the comments this task wrote to record what was
 * deleted and why. The rule was never "this string appears nowhere in the file", it is
 * "this fixture is not part of what ships". `testing/source.ts` holds the one stripper and
 * `testing/source.test.ts` proves it still catches a real occurrence.
 */
const read = readCode

/**
 * A project with a REAL `.sketch/events/<date>.jsonl` log.
 *
 * Written as bytes rather than through the store so the test proves the panel reads the
 * durable log the engine actually writes, not an in-memory convenience.
 */
function projectWithLog(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-cost-ui-'))
  tmpDirs.push(dir)
  const events = join(dir, '.sketch', 'events')
  mkdirSync(events, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  writeFileSync(
    join(events, `${day}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  )
  return dir
}

let seq = 0
function llmResponse(model: string | null, usage: { in: number; out: number }, runId = 'run-1') {
  seq += 1
  return {
    id: `evt-${seq}`,
    ts: 1_700_000_000_000 + seq,
    runId,
    kind: 'llm_response',
    payload: {
      iteration: seq,
      text: 'ok',
      adapter: 'openai',
      ...(model === null ? {} : { model }),
      usage,
    },
  }
}

function methodContext(): MethodContext {
  return {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => process.cwd(),
  }
}

class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  private readonly ctx = methodContext()

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('the cost panel never starts a run'))
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

  cost(params: { root: string; runId?: string }): Promise<CostReport> {
    return METHODS['cost']!(
      { root: params.root, ...(params.runId !== undefined ? { runId: params.runId } : {}) },
      this.ctx,
    ) as Promise<CostReport>
  }
}

function withoutCost(client: EngineClient): SketchClient {
  const stripped = Object.create(client) as SketchClient
  stripped.cost = undefined
  return stripped
}

function mount(root: string | null, client: SketchClient) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <CostDashboard />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

// ── 1. reconciliation, to the last decimal ──────────────────────────────────

describe('reconciliation with the log', () => {
  it('shows EXACTLY the sum over the events, not approximately', async () => {
    const events = [
      llmResponse('gpt-4o', { in: 1_000_000, out: 0 }),
      llmResponse('gpt-4o-mini', { in: 3_141_592, out: 271_828 }),
      llmResponse('claude-3-5-sonnet', { in: 12_345, out: 6_789 }),
    ]
    const root = projectWithLog(events)
    mount(root, new EngineClient())

    // The independent computation: the library, over the same event objects.
    const expected = costLib.ledgerFor(events as never)
    // Deliberately not a round number — a tolerance-based assertion would pass on a
    // rounding bug and this is money.
    const rendered = `$${expected.usd.toFixed(4)}`

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain(rendered)
    expect(expected.unpriced).toBe(0)
  })

  it('shows the pricing date, because a table with no date implies live pricing', async () => {
    const root = projectWithLog([llmResponse('gpt-4o', { in: 10, out: 10 })])
    mount(root, new EngineClient())

    await waitFor(() =>
      expect(screen.getByText(new RegExp(`Prices as published on ${costLib.PRICED_AT}`))).toBeTruthy(),
    )
  })

  it('links every row back to the log line it came from', async () => {
    const root = projectWithLog([llmResponse('gpt-4o', { in: 10, out: 10 })])
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByLabelText('Every priced model call')).toBeTruthy())
    // A total a user cannot audit is a total they cannot challenge.
    const rows = screen.getByLabelText('Every priced model call')
    expect(rows.textContent).toContain('evt-')
  })

  it('reports unreadable log lines rather than absorbing them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sketch-cost-ui-'))
    tmpDirs.push(dir)
    const events = join(dir, '.sketch', 'events')
    mkdirSync(events, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    writeFileSync(
      join(events, `${day}.jsonl`),
      [JSON.stringify(llmResponse('gpt-4o', { in: 10, out: 10 })), '{ not json', ''].join('\n'),
      'utf8',
    )

    mount(dir, new EngineClient())
    // Silently dropping lines would UNDERSTATE spend, which is the direction that costs
    // the user money.
    await waitFor(() => expect(screen.getByText(/could not be read and are NOT counted/)).toBeTruthy())
  })
})

// ── 2. unknown is shown as unknown ──────────────────────────────────────────

describe('what the panel refuses to imply', () => {
  it('shows an unpriced model as unknown and counts it, never as $0.00', async () => {
    const root = projectWithLog([
      llmResponse('gpt-4o', { in: 1_000_000, out: 0 }),
      llmResponse('some-unlisted-model', { in: 9_000_000, out: 9_000_000 }),
    ])
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    const summary = screen.getByRole('status').textContent ?? ''

    // The priced half is shown. The unpriced half is named, not zeroed.
    expect(summary).toContain('$2.5000')
    expect(summary).toContain('1 of 2 call(s) used a model that is not in the price table')
    expect(summary).toContain('lower bound')
    // And the row itself says unknown.
    expect(screen.getByLabelText('Every priced model call').textContent).toContain('unknown')
  })

  it('says “unknown” for the headline when nothing could be priced', async () => {
    const root = projectWithLog([llmResponse('mystery', { in: 500, out: 500 })])
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    const summary = screen.getByRole('status').textContent ?? ''
    expect(summary).toContain('unknown')
    // THE ASSERTION. Not a dollar figure of any kind.
    expect(summary).not.toMatch(/\$\d/)
  })

  it('shows a local-only run as a REAL $0.00 and explains the difference', async () => {
    const root = projectWithLog([
      {
        id: 'evt-local',
        ts: 1_700_000_000_001,
        runId: 'run-local',
        kind: 'llm_response',
        payload: { adapter: 'ollama', model: 'llama3.3:70b', usage: { in: 9_000, out: 9_000 } },
      },
    ])
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    const summary = screen.getByRole('status').textContent ?? ''
    expect(summary).toContain('$0.00')
    // The two zeros must be distinguishable on screen, not just in the data.
    expect(summary).toContain('this zero is a real price rather than a missing one')
  })

  it('does not present an empty log as a run that was free', async () => {
    const root = projectWithLog([])
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('No model calls yet')
    expect(screen.getByText(/it means nothing ran, not that everything was free/)).toBeTruthy()
  })

  it('refuses to invent a total when the transport has no engine', () => {
    mount(projectWithLog([llmResponse('gpt-4o', { in: 10, out: 10 })]), withoutCost(new EngineClient()))
    expect(screen.getByText('No engine behind this transport')).toBeTruthy()
    expect(screen.getByText(/an invented invoice/)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

// ── 3. the fixtures are gone, and there is no second source ─────────────────

describe('the fixtures this panel replaced', () => {
  it('has no $1.4025 anywhere in the shipped source', () => {
    for (const file of ['components/StatusBar.tsx', 'panels/TaskLog.tsx']) {
      expect(read(file), `${file} still carries the invented cost`).not.toContain('1.4025')
    }
  })

  it('has no totalCost in AppState', () => {
    const state = read(join('state', 'AppState.tsx'))
    // A field here would be the second source Requirement 20.2 forbids by definition.
    expect(state).not.toContain('totalCost: number')
    expect(state).not.toContain('totalCost: 12.45')
  })

  it('keeps no counter in the panel: the total is fetched, never accumulated', () => {
    const panel = read(join('panels', 'CostDashboard.tsx'))
    // No arithmetic on a stored total. The engine sums; this renders.
    expect(panel).not.toMatch(/setTotal|total\s*\+=|usd\s*\+=/)
    expect(panel).toContain('client.cost')
  })

  it('has one cost surface: the status bar links to it rather than showing a figure', () => {
    const bar = read(join('components', 'StatusBar.tsx'))
    // A second figure in the corner of the window would be a second source, and two
    // money numbers disagree eventually.
    expect(bar).toContain("payload: 'cost'")
    expect(bar).not.toMatch(/\$\{[^}]*usd/)
    expect(bar).not.toContain('14.2k tokens')
  })
})
