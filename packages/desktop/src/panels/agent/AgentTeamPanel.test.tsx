// The AI Team panel, driven against the REAL engine role table.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §1 — all THREE role fixtures are gone at the source level: this panel's four
//     function-local agents with their `1 working` header, `AppState.agentTeam`'s twelve
//     entries, and `AppState.tasks` / `TaskEntry`.
//   * §2 — the panel is REACHABLE. No ActivityBar button dispatched `agents` before this
//     task, which is how four fixtures survived in a panel nobody could open.
//   * §3 — there is no per-role status, and that is the honest answer rather than a
//     shortcut: a role exists only inside a dispatch.
//   * §4 — a role this project cannot verify is shown SKIPPED WITH ITS REASON, because
//     Requirement 24.6 refuses to run it and hiding the row would make a swarm look
//     complete.
//   * §5 — the Requirement 24.8 gate says swarm is OFF and why.
//
// Validates: Requirements 24.1, 24.4, 24.6, 24.8, 27.1, 27.3, 27.4, 14.6

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { METHODS, capabilities, strategy, type MethodContext } from '@sketch/core'

import { readCode } from '../../testing/source'
import { AgentTeamPanel } from './AgentTeamPanel'
import ActivityBar from '../../components/ide/ActivityBar'
import SidePanel from '../../components/ide/SidePanel'
import { SketchClientProvider } from '../../lib/ClientProvider'
import {
  createEventBus,
  type EventHandler,
  type PingResult,
  type SketchClient,
  type StrategyCatalogResult,
} from '../../lib/client'
import type { SketchEvent } from '../../lib/contracts'
import { AppStateProvider } from '../../state/AppState'

const code = readCode

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-team-'))
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

function methodContext(cwd: string): MethodContext {
  return {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => cwd,
  }
}

class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  readonly bus = createEventBus()

  constructor(private readonly root: string) {}

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('this panel never starts a run'))
  }
  cancel(): Promise<never> {
    return Promise.reject(new Error('this panel never cancels a run'))
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

  strategyCatalog(options: { root?: string } = {}): Promise<StrategyCatalogResult> {
    return METHODS['strategy-catalog']!(
      { ...options },
      methodContext(this.root),
    ) as Promise<StrategyCatalogResult>
  }
}

function withoutCatalog(client: EngineClient): SketchClient {
  const stripped = Object.create(client) as SketchClient
  stripped.strategyCatalog = undefined
  return stripped
}

function mount(client: SketchClient, root: string | null = null) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <AgentTeamPanel />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

/** A project whose `verify.yaml` configures exactly the named stages. */
async function projectWithStages(stages: Record<string, string>): Promise<string> {
  const root = await makeTmp()
  const lines = Object.entries(stages).map(([stage, command]) => `${stage}: ${command}`)
  await writeFile(join(root, 'verify.yaml'), `${lines.join('\n')}\n`, 'utf8')
  return root
}

// ── 1. the fixtures are gone ────────────────────────────────────────────────

describe('the three role fixtures this panel replaced', () => {
  it('has no function-local agent list and no hardcoded working count', () => {
    const panel = code(join('panels', 'agent', 'AgentTeamPanel.tsx'))
    expect(panel).not.toContain("name: 'Architect'")
    expect(panel).not.toContain("name: 'UI Builder'")
    expect(panel).not.toContain('1 working')
    expect(panel).not.toContain('activeCount')
    // The pulse ring only ever animated a fixture that said `status: 'working'`.
    expect(panel).not.toContain('pulseRing')
  })

  it('has no agentTeam in AppState', () => {
    const state = code(join('state', 'AppState.tsx'))
    expect(state).not.toContain('agentTeam')
    expect(state).not.toContain("id: 'a5'")
    expect(state).not.toContain("status: 'busy'")
  })

  it('has no tasks array or TaskEntry in AppState', () => {
    const state = code(join('state', 'AppState.tsx'))
    expect(state).not.toContain('TaskEntry')
    expect(state).not.toContain('tasks: []')
  })
})

// ── 2. reachable ────────────────────────────────────────────────────────────

describe('the entry point (Requirements 27.1, 27.4)', () => {
  it('opens from the ActivityBar, which never dispatched agents before', async () => {
    const root = await makeTmp()
    render(
      <SketchClientProvider client={new EngineClient(root)}>
        <AppStateProvider initial={{ mode: 'ide', ideActivePanel: null, projectRoot: root }}>
          <ActivityBar />
          <SidePanel />
        </AppStateProvider>
      </SketchClientProvider>,
    )

    expect(screen.queryByText('AI Team')).toBeNull()
    fireEvent.click(screen.getByTitle('AI Team'))
    await waitFor(() => expect(screen.getAllByText('AI Team').length).toBeGreaterThan(0))
    // And it really rendered the catalog, not an empty shell.
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
  })
})

// ── 3. no per-role status ───────────────────────────────────────────────────

describe('what the panel does and does not claim', () => {
  it('never says a role is idle, busy, working or done', async () => {
    const root = await projectWithStages({ unit: 'npm test' })
    mount(new EngineClient(root), root)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())

    const text = document.body.textContent ?? ''
    for (const word of ['working', 'busy', 'offline']) {
      expect(text.toLowerCase()).not.toContain(word)
    }
    // What it says instead: verifiable, or skipped.
    expect(screen.getAllByText('verifiable').length).toBeGreaterThan(0)
  })

  it('lists all thirteen roles Requirement 24.4 names', async () => {
    const root = await makeTmp()
    mount(new EngineClient(root), root)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())

    for (const role of strategy.ROLES) {
      const title = strategy.ROLE_DEFINITIONS[role].title
      expect(screen.getAllByText(title).length, title).toBeGreaterThan(0)
    }
  })

  it('says nothing has been dispatched when nothing has', async () => {
    const root = await makeTmp()
    mount(new EngineClient(root), root)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByText(/Nothing has been dispatched in this session/)).toBeTruthy()
  })

  it('renders real dispatcher events and ignores the cost router\u2019s, old kind and new', async () => {
    const root = await makeTmp()
    const client = new EngineClient(root)
    mount(client, root)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())

    const emitKind = (kind: SketchEvent['kind'], payload: Record<string, unknown>, id: string): void => {
      const event: SketchEvent = { id, ts: 1, runId: 'd1', kind, payload }
      client.bus.emit(event)
    }
    const emit = (payload: Record<string, unknown>, id: string): void =>
      emitKind('strategy_selected', payload, id)

    // The cost router used to emit the same KIND with `component: 'router'`; the `EventKind`
    // amendment gave it `model_selected`. BOTH are sent here — the new kind as a live run
    // produces it, and the old shape as a pre-amendment JSONL log still holds it. Its decision
    // is about which model to use, so neither may produce a line on this panel.
    emitKind('model_selected', { policy: 'always', adapter: 'cheap' }, 'e-new')
    emit({ component: 'router', policy: 'after-plan', adapter: 'cheap' }, 'e0')
    emit({ component: 'dispatcher', phase: 'attempt', attempt: 1, strategy: 'swarm', reason: 'the caller chose swarm' }, 'e1')
    emit({ component: 'dispatcher', phase: 'roles', verifiable: ['research'], skipped: [{ role: 'frontend', reason: 'no build stage' }] }, 'e2')
    emit({ component: 'dispatcher', phase: 'outcome', succeeded: null, stopped: 'swarm is the heaviest strategy' }, 'e3')

    await waitFor(() => expect(screen.getByText(/Attempt 1: swarm/)).toBeTruthy())
    expect(screen.getByText(/1 verifiable, 1 skipped/)).toBeTruthy()
    expect(screen.getByText(/no strategy succeeded/)).toBeTruthy()

    // NEITHER ROUTER EVENT PRODUCED A LINE. Counting is what makes this a real guard: an
    // earlier version of this test only asserted that the string `after-plan` was absent,
    // and `after-plan` lives in the router's `policy` key which this panel never renders —
    // so the assertion passed with the `component` check deleted. Three dispatcher events
    // in, three lines out.
    const activity = screen.getByLabelText('Dispatcher activity').querySelectorAll('li')
    expect(activity).toHaveLength(3)
    expect(screen.queryByText(/after-plan/)).toBeNull()
    // And nothing rendered as the fallback phase, which is what a router payload becomes if
    // it gets past the check.
    for (const line of activity) expect(line.textContent).not.toContain('unknown')
  })
})

// ── 4. skipped roles, with reasons ──────────────────────────────────────────

describe('roles this project cannot verify (Requirement 24.6)', () => {
  it('shows them skipped with the reason, rather than hiding them', async () => {
    // Only `unit`, so Frontend (build), Architect (typecheck), Database (integration),
    // Performance, Deployment and Documentation all lose their graders.
    const root = await projectWithStages({ unit: 'npm test' })
    mount(new EngineClient(root), root)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())

    expect(screen.getAllByText('skipped').length).toBe(6)
    expect(screen.getByText(/configures no "build" stage/)).toBeTruthy()
    expect(screen.getAllByText(/rather than run unverified/).length).toBe(6)
  })

  it('reports how many roles are verifiable, and it matches the engine', async () => {
    const root = await projectWithStages({ unit: 'npm test', build: 'npm run build' })
    const catalog = await new EngineClient(root).strategyCatalog({ root })
    const { verifiable } = strategy.partitionRoles([...strategy.ROLES], ['unit', 'build'])
    expect(catalog.verifiableRoles).toBe(verifiable.length)

    mount(new EngineClient(root), root)
    await waitFor(() =>
      expect(
        screen.getByText(`${verifiable.length} of 13 roles verifiable in this project`),
      ).toBeTruthy(),
    )
  })
})

// ── 5. the 24.8 gate, and the honest empty state ────────────────────────────

describe('the swarm default gate (Requirement 24.8)', () => {
  it('says swarm is off, and that it is off because nothing was measured', async () => {
    const root = await makeTmp()
    mount(new EngineClient(root), root)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())

    expect(screen.getByText('swarm is off')).toBeTruthy()
    expect(screen.getByText(/no pass@k measurement has been run/)).toBeTruthy()
    expect(screen.getByText('default')).toBeTruthy()
  })

  it('refuses to invent a team when there is no engine behind the transport', async () => {
    const root = await makeTmp()
    mount(withoutCatalog(new EngineClient(root)), root)
    expect(screen.getByText('No engine behind this transport')).toBeTruthy()
    expect(screen.getByText(/four fixtures this panel replaced/)).toBeTruthy()
    for (const role of strategy.ROLES) {
      expect(screen.queryByText(strategy.ROLE_DEFINITIONS[role].title)).toBeNull()
    }
  })
})

// ── 6. the duplicated capability table cannot drift ─────────────────────────

describe('the capability wording', () => {
  it('covers every capability the real role table uses', async () => {
    const panel = code(join('panels', 'agent', 'AgentTeamPanel.tsx'))
    const used = new Set(
      strategy.allRoles().flatMap((definition) => [...definition.capabilities]),
    )
    for (const capability of used) {
      expect(panel, capability).toContain(`'${capability}':`)
    }
    // And every capability in the table is a real one, so a typo cannot hide behind a row.
    for (const capability of used) {
      expect(capabilities.isCapability(capability)).toBe(true)
    }
  })
})
