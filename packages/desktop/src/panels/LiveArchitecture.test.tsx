// Live Architecture, driven against the REAL engine and a REAL project on disk.
//
// The client below is not a stand-in for the engine: it dispatches the same
// `METHODS` table the sidecar and the dev bridge dispatch, in process instead of over
// a pipe, pointed at a temp directory that really contains the files. So the graph is
// built by `buildRepoGraph`, the views are derived by `generateArchitecture`, the
// diagram on screen is laid out from the Mermaid text the generator emitted, and the
// reason under an unavailable view is the sentence the engine wrote. No fixture, no
// network, no key.
//
// THE ASSERTION THAT MATTERS MOST is in section 4: a view the generator reported as
// `available: false` renders its REASON and NO diagram surface. That is the whole
// point of the generator's honesty rule (see the header of
// packages/core/src/context/architecture.ts), and it is mutation-verifiable — make
// the panel draw an empty diagram for an unavailable view and this test fails.
//
// Validates: Requirements 19.3, 27.1, 27.3, 27.5, 14.6

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METHODS, type MethodContext } from '@sketch/core'

import { LiveArchitecture } from './LiveArchitecture'
import ActivityBar from '../components/ide/ActivityBar'
import SidePanel from '../components/ide/SidePanel'
import { SketchClientProvider } from '../lib/ClientProvider'
import {
  createEventBus,
  type ArchitectureResult,
  type EventHandler,
  type PingResult,
  type SketchClient,
} from '../lib/client'
import { AppStateProvider } from '../state/AppState'

// ── a real project on disk ──────────────────────────────────────────────────

const tmpDirs: string[] = []

/**
 * Two modules, one import between them, one call across it, and no schema and no
 * route anywhere. That shape is deliberate: five views have evidence and two do not,
 * so both branches of the panel are exercised by the same directory.
 */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-architecture-ui-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, 'src', 'core'), { recursive: true })
  mkdirSync(join(dir, 'src', 'ui'), { recursive: true })
  writeFileSync(
    join(dir, 'src', 'core', 'engine.ts'),
    'export function boot(): number {\n  return 1\n}\n',
    'utf8',
  )
  writeFileSync(
    join(dir, 'src', 'ui', 'panel.ts'),
    'import { boot } from "../core/engine"\n\nexport function render(): number {\n  return boot()\n}\n',
    'utf8',
  )
  writeFileSync(join(dir, 'README.md'), '# real project\n', 'utf8')
  return dir
}

// ── the client: the real engine, in process ─────────────────────────────────

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

/**
 * `transport` says 'stdio' because that is what this stands in for: the sidecar
 * dispatching `METHODS`. Nothing in the panel branches on it.
 *
 * `caps` exist so the truncation branch can be reached without a 200-file fixture.
 * They are the engine's own `maxNodes` / `maxEdges` parameters, so what comes back is
 * still derived from the real graph — just less of it.
 */
class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  private readonly ctx = methodContext()
  /** Every architecture call, as sent. */
  readonly calls: Array<{ root: string; index?: boolean }> = []

  constructor(private readonly caps: { maxNodes?: number; maxEdges?: number } = {}) {}

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }

  run(): Promise<never> {
    return Promise.reject(new Error('the architecture panel never starts a run'))
  }

  /** This panel starts no run, so it has none to stop. */
  
/** This surface starts no interactive run, so nothing awaits an answer. */

reply(): Promise<never> {
  return Promise.reject(new Error('this surface never answers a question'))
}

cancel(): Promise<never> {
    return Promise.reject(new Error('this surface never cancels a run'))
  }

  eval(): Promise<never[]> {
    return Promise.resolve([])
  }

  subscribe(handler: EventHandler) {
    return this.bus.subscribe(handler)
  }

  gitStatus(): Promise<never> {
    return Promise.reject(new Error('the architecture panel never reads git'))
  }
  gitDiff(): Promise<never> {
    return Promise.reject(new Error('the architecture panel never reads git'))
  }
  gitStage(): Promise<never> {
    return Promise.reject(new Error('the architecture panel never reads git'))
  }
  gitUnstage(): Promise<never> {
    return Promise.reject(new Error('the architecture panel never reads git'))
  }
  gitCommit(): Promise<never> {
    return Promise.reject(new Error('the architecture panel never reads git'))
  }
  providerCatalog(): Promise<never> {
    return Promise.reject(new Error('the architecture panel never reads provider settings'))
  }
  saveProviderSettings(): Promise<never> {
    return Promise.reject(new Error('the architecture panel never writes provider settings'))
  }
  testProvider(): Promise<never> {
    return Promise.reject(new Error('the architecture panel never tests a provider'))
  }

  architecture(params: { root: string; index?: boolean }): Promise<ArchitectureResult> {
    this.calls.push(params)
    return METHODS['architecture']!(
      {
        root: params.root,
        ...(params.index === true ? { index: true } : {}),
        ...this.caps,
      },
      this.ctx,
    ) as Promise<ArchitectureResult>
  }
}

/** An engine that cannot be reached, for the "name the reason" case. */
class DeadEngineClient extends EngineClient {
  override architecture(): Promise<never> {
    return Promise.reject(new Error('the sidecar is not running: ENOENT'))
  }
}

/**
 * A transport that does not implement the capability at all. `architecture` is
 * optional on the seam (like `captureEval`), so this is a legal client — and it is
 * the case the panel has to name rather than draw around.
 */
function withoutArchitecture(client: EngineClient): SketchClient {
  const stripped = Object.create(client) as SketchClient
  stripped.architecture = undefined
  return stripped
}

function mount(root: string | null, client: SketchClient) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <LiveArchitecture />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

/** Index the project through the panel's own offer, then wait for the views. */
async function indexed(root: string, client: SketchClient) {
  mount(root, client)
  fireEvent.click(await screen.findByText('Index this project'))
  await waitFor(() => expect(screen.getByRole('tablist')).toBeDefined(), { timeout: 5000 })
}

function tab(kind: string): HTMLElement {
  const found = document.querySelector(`[data-view="${kind}"]`)
  if (found === null) throw new Error(`no tab for ${kind}`)
  return found as HTMLElement
}

afterEach(() => {
  cleanup()
})

// ── 1. no fixture, no HTML sink ─────────────────────────────────────────────

describe('the panel ships no fixture and builds no HTML (Requirement 14.6)', () => {
  /** The panel's CODE, comments removed: a comment about a fixture is not one. */
  function code(relative: string): string {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
  }

  const panel = code('LiveArchitecture.tsx')
  const reader = code('../architecture/flowchart.ts')

  it('declares no fixture of its own', () => {
    for (const source of [panel, reader]) {
      expect(source).not.toMatch(/\b(?:MOCK|SAMPLE|EXAMPLE|FIXTURE|DEMO)_[A-Z0-9_]+/)
    }
    // No diagram text is written in the panel: every view comes off the seam.
    expect(panel).not.toContain('flowchart TD')
    expect(panel).not.toContain('flowchart LR')
    expect(panel).toContain('client.architecture')
  })

  it('never sets HTML directly, so a repository-derived label cannot be markup', () => {
    for (const source of [panel, reader]) {
      expect(source).not.toContain('dangerouslySetInnerHTML')
      expect(source).not.toMatch(/\.innerHTML\s*=/)
      expect(source).not.toContain('insertAdjacentHTML')
      expect(source).not.toContain('DOMParser')
    }
  })
})

// ── 2. honest nothings ──────────────────────────────────────────────────────

describe('the four honest nothings (Requirements 27.3, 27.5)', () => {
  it('says no folder is opened, and derives nothing', async () => {
    const client = new EngineClient()
    mount(null, client)

    expect(await screen.findByText('No folder opened')).toBeDefined()
    expect(client.calls).toEqual([])
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('names a transport that cannot answer instead of drawing empty views', async () => {
    mount(makeProject(), withoutArchitecture(new EngineClient()))

    expect(await screen.findByText('No engine behind this transport')).toBeDefined()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('names a failed generation and its reason', async () => {
    mount(makeProject(), new DeadEngineClient())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the sidecar is not running')
    // A failure is not an empty diagram set.
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(document.querySelector('[data-diagram]')).toBeNull()
  })

  it('offers to index when no graph exists, naming where it looked', async () => {
    const dir = makeProject()
    const client = new EngineClient()
    mount(dir, client)

    expect(await screen.findByText('No repository graph indexed yet')).toBeDefined()
    expect(screen.getByText(join(dir, '.sketch', 'index', 'graph.json'))).toBeDefined()
    // The engine's own reason, not a paraphrase.
    expect(document.body.textContent).toContain('no repository graph')
    expect(screen.queryByRole('tablist')).toBeNull()

    fireEvent.click(screen.getByText('Index this project'))

    await waitFor(() => expect(screen.getByRole('tablist')).toBeDefined(), { timeout: 5000 })
    // It really indexed: the graph is on disk, and only the second call asked for it.
    expect(existsSync(join(dir, '.sketch', 'index', 'graph.json'))).toBe(true)
    expect(client.calls.map((call) => call.index === true)).toEqual([false, true])
  })
})

// ── 3. the seven views, as the engine reported them ─────────────────────────

describe('the seven views (Requirements 19.1, 19.3)', () => {
  it('lists all seven, marking which have evidence', async () => {
    await indexed(makeProject(), new EngineClient())

    const kinds = Array.from(document.querySelectorAll('[data-view]'))
      .filter((el) => el.getAttribute('role') === 'tab')
      .map((el) => el.getAttribute('data-view'))
    expect(kinds).toEqual([
      'system',
      'api',
      'database',
      'component',
      'dependency',
      'folder-tree',
      'call-graph',
    ])

    // Availability is visible before a tab is opened: this project has no route
    // registration and no schema file, so exactly those two are marked unavailable.
    expect(tab('api').getAttribute('data-available')).toBe('no')
    expect(tab('database').getAttribute('data-available')).toBe('no')
    for (const kind of ['system', 'component', 'dependency', 'folder-tree', 'call-graph']) {
      expect(tab(kind).getAttribute('data-available'), kind).toBe('yes')
    }
  })

  it('draws the dependency view from the real graph, as text nodes in SVG', async () => {
    await indexed(makeProject(), new EngineClient())

    fireEvent.click(tab('dependency'))

    const svg = await waitFor(() => {
      const found = document.querySelector('[data-diagram="dependency"]')
      if (found === null) throw new Error('no diagram')
      return found
    })
    // Two real files, one real edge between them.
    const labels = Array.from(svg.querySelectorAll('tspan')).map((node) => node.textContent)
    expect(labels).toContain('src/ui/panel.ts')
    expect(labels).toContain('src/core/engine.ts')
    expect(svg.querySelectorAll('rect')).toHaveLength(2)
    expect(svg.querySelectorAll('line')).toHaveLength(1)
    // The label is a text node, so it is text: no element was created from it.
    expect(svg.querySelector('img')).toBeNull()
  })

  it('shows the Mermaid source on request, as text', async () => {
    await indexed(makeProject(), new EngineClient())

    fireEvent.click(tab('folder-tree'))
    fireEvent.click(await screen.findByText('Show Mermaid source'))

    const source = await screen.findByText(/flowchart TD/)
    expect(source.textContent).toContain('src/')
    expect(source.tagName).toBe('PRE')
  })

  it('shows each view’s evidence, and the caveat that makes a heuristic visible', async () => {
    await indexed(makeProject(), new EngineClient())

    fireEvent.click(tab('system'))
    await waitFor(() =>
      expect(screen.getByText(/aggregated by module/)).toBeDefined(),
    )
    // The system view's grouping is a path convention, and the panel says so.
    expect(screen.getByText(/the module boundary is a path convention/)).toBeDefined()

    fireEvent.click(tab('call-graph'))
    await waitFor(() => expect(screen.getByText(/textual, not resolved/)).toBeDefined())
  })

  it('says a view is truncated rather than presenting part of a graph as all of it', async () => {
    // The engine's own node cap, tightened. The graph is still the real one.
    await indexed(makeProject(), new EngineClient({ maxNodes: 2 }))

    fireEvent.click(tab('folder-tree'))

    expect(await screen.findByText(/Truncated:/)).toBeDefined()
    expect(screen.getByText(/of \d+ nodes shown/)).toBeDefined()
  })
})

// ── 4. an unavailable view shows its reason, not an empty diagram ───────────

describe('a view with no evidence states why (Requirement 19.3)', () => {
  it('renders the API view’s reason and no diagram surface', async () => {
    await indexed(makeProject(), new EngineClient())

    fireEvent.click(tab('api'))

    // The engine's sentence, on screen.
    expect(await screen.findByText(/no API surface found/)).toBeDefined()
    expect(screen.getByText('Unavailable.')).toBeDefined()
    // AND NOTHING THAT LOOKS LIKE A DIAGRAM: no drawing surface, no counts of a
    // graph that was never drawn, no "loading" that will never finish.
    expect(document.querySelector('[data-diagram]')).toBeNull()
    expect(document.querySelector('svg[role="img"]')).toBeNull()
    expect(screen.queryByText('Show Mermaid source')).toBeNull()
    expect(screen.queryByText(/Deriving the views/)).toBeNull()
  })

  it('renders the database view’s reason, naming what was searched for', async () => {
    await indexed(makeProject(), new EngineClient())

    fireEvent.click(tab('database'))

    expect(await screen.findByText(/no schema found/)).toBeDefined()
    expect(document.querySelector('[data-diagram]')).toBeNull()
    // Its evidence is still on screen: a reader can see what "found" means here.
    expect(screen.getByText(/schema files only/)).toBeDefined()
  })
})

// ── 5. the surface is reachable ─────────────────────────────────────────────

describe('the entry point (Requirement 27.1)', () => {
  it('opens from the ActivityBar', async () => {
    render(
      <SketchClientProvider client={new EngineClient()}>
        <AppStateProvider initial={{ mode: 'ide', ideActivePanel: null, projectRoot: null }}>
          <ActivityBar />
          <SidePanel />
        </AppStateProvider>
      </SketchClientProvider>,
    )

    fireEvent.click(screen.getByTitle('Live Architecture'))

    // The real panel, in its honest state for a window with no project open.
    expect(await screen.findByText('No folder opened')).toBeDefined()
  })
})

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A locked temp directory is not a test failure.
    }
  }
})
