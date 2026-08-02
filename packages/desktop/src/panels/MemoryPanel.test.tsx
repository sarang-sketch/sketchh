// The Memory panel, driven against the REAL engine over a REAL append-only log.
//
// The client dispatches the same `METHODS` table the sidecar dispatches, in process,
// against a temp project. So the windows on screen are the windows the engine computed,
// and retracting really appends a close op to a real file.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §2 — a retracted row is SHOWN, greyed and labelled. Retrieval hides withdrawn facts
//     from a prompt; this panel is the opposite case, because a history you cannot see is
//     a history you cannot correct.
//   * §3 — retracting REQUIRES a reason before the control is enabled, and it is called
//     "Retract", not "Delete". Requirement 21.3 asks that superseding record why.
//   * §3 — retracting appends and does not delete: the row survives with its window closed.
//   * §4 — the lint findings are rendered with their confidence and NOTHING is applied.
//   * §5 — no engine, no memory. Invented decisions with invented dates are the one
//     fixture that would actively mislead the agent about the user's own codebase.
//
// Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.6, 27.1

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { METHODS, memory as mem, type MethodContext } from '@sketch/core'

import { MemoryPanel } from './MemoryPanel'
import { SketchClientProvider } from '../lib/ClientProvider'
import {
  createEventBus,
  type EventHandler,
  type MemoryListResult,
  type MemoryRememberResult,
  type MemorySearchResult,
  type MemorySupersedeResult,
  type PingResult,
  type SketchClient,
} from '../lib/client'
import { AppStateProvider } from '../state/AppState'

const tmpDirs: string[] = []

afterEach(cleanup)
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-memory-ui-'))
  tmpDirs.push(dir)
  return dir
}

function methodContext(root: string): MethodContext {
  return {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => root,
  }
}

class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  readonly supersedes: Array<{ id: string; reason: string }> = []

  constructor(private readonly root: string) {}

  private get ctx(): MethodContext {
    return methodContext(this.root)
  }

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('the memory panel never starts a run'))
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

  memoryList(params: { root: string; kind?: string }): Promise<MemoryListResult> {
    return METHODS['memory-list']!(
      { root: params.root, ...(params.kind !== undefined ? { kind: params.kind } : {}) },
      this.ctx,
    ) as Promise<MemoryListResult>
  }

  memorySearch(params: {
    root: string
    query: string
    includeSuperseded?: boolean
  }): Promise<MemorySearchResult> {
    return METHODS['memory-search']!(
      {
        root: params.root,
        query: params.query,
        ...(params.includeSuperseded === true ? { includeSuperseded: true } : {}),
      },
      this.ctx,
    ) as Promise<MemorySearchResult>
  }

  memoryRemember(params: Record<string, unknown>): Promise<MemoryRememberResult> {
    return METHODS['memory-remember']!(params, this.ctx) as Promise<MemoryRememberResult>
  }

  memorySupersede(params: { root: string; id: string; reason: string }): Promise<MemorySupersedeResult> {
    this.supersedes.push({ id: params.id, reason: params.reason })
    return METHODS['memory-supersede']!(
      { root: params.root, id: params.id, reason: params.reason },
      this.ctx,
    ) as Promise<MemorySupersedeResult>
  }
}

function withoutMemory(client: EngineClient): SketchClient {
  const stripped = Object.create(client) as SketchClient
  stripped.memoryList = undefined
  stripped.memorySearch = undefined
  stripped.memoryRemember = undefined
  stripped.memorySupersede = undefined
  return stripped
}

function mount(root: string | null, client: SketchClient) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <MemoryPanel />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

/** Seed a real store on disk, through the engine's own write path. */
async function seed(root: string): Promise<mem.MemoryStore> {
  const store = new mem.JsonlMemoryStore({ baseDir: root })
  await mem.remember({
    store,
    entry: { kind: 'decision', key: 'api-style', subject: 'api', text: 'We use REST endpoints.' },
  })
  await mem.remember({
    store,
    entry: { kind: 'standard', key: 'test-location', text: 'Tests live beside the code.' },
  })
  await mem.remember({
    store,
    entry: { kind: 'bug', subject: 'payments', text: 'A retry storm hammered Stripe.' },
  })
  return store
}

// ── 1. it shows what is really there ────────────────────────────────────────

describe('the panel reads the real store', () => {
  it('lists entries with their validity windows', async () => {
    const root = makeProject()
    await seed(root)
    mount(root, new EngineClient(root))

    await waitFor(() => expect(screen.getByLabelText('Memory entries')).toBeTruthy())
    expect(screen.getByText('We use REST endpoints.')).toBeTruthy()
    expect(screen.getByText('Tests live beside the code.')).toBeTruthy()
    // The window, in the engine's own words — the panel does not format dates a second way.
    expect(screen.getAllByText(/valid since \d{4}-\d{2}-\d{2}/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('current').length).toBe(3)
  })

  it('says so honestly when nothing is remembered', async () => {
    mount(makeProject(), new EngineClient(makeProject()))
    await waitFor(() => expect(screen.getByText('Nothing remembered yet')).toBeTruthy())
    expect(screen.queryByLabelText('Memory entries')).toBeNull()
  })

  it('says why it is empty with no folder open', () => {
    mount(null, new EngineClient(makeProject()))
    expect(screen.getByText('No folder opened')).toBeTruthy()
  })
})

// ── 2. a retracted row is shown, not hidden ─────────────────────────────────

describe('history is visible', () => {
  it('SHOWS a superseded entry, labelled and with the reason', async () => {
    const root = makeProject()
    const store = await seed(root)
    // The decision changes. `remember` closes the predecessor with a reason.
    await mem.remember({
      store,
      entry: { kind: 'decision', key: 'api-style', subject: 'api', text: 'We use GraphQL endpoints.' },
      reason: 'GraphQL fits the client better',
    })

    mount(root, new EngineClient(root))
    await waitFor(() => expect(screen.getByLabelText('Memory entries')).toBeTruthy())

    // BOTH are on screen. Retrieval hides the retracted one from a prompt; this panel is
    // where a user finds out the agent ever believed it.
    expect(screen.getByText('We use REST endpoints.')).toBeTruthy()
    expect(screen.getByText('We use GraphQL endpoints.')).toBeTruthy()
    // A word, not only a colour.
    expect(screen.getByText('retracted')).toBeTruthy()
    // And why, so the change is auditable.
    expect(screen.getByText(/GraphQL fits the client better/)).toBeTruthy()
  })

  it('offers no Retract control on an already-retracted row', async () => {
    const root = makeProject()
    const store = await seed(root)
    await mem.remember({
      store,
      entry: { kind: 'decision', key: 'api-style', text: 'We use GraphQL.' },
      reason: 'changed',
    })

    mount(root, new EngineClient(root))
    await waitFor(() => expect(screen.getByLabelText('Memory entries')).toBeTruthy())
    // Three live rows had one closed, so one fewer control than rows.
    const rows = screen.getByLabelText('Memory entries').querySelectorAll('li')
    const buttons = screen.getAllByText('Retract')
    expect(rows.length).toBe(4)
    expect(buttons.length).toBe(3)
  })

  it('counts current against total rather than reporting only the live rows', async () => {
    const root = makeProject()
    const store = await seed(root)
    await mem.remember({
      store,
      entry: { kind: 'decision', key: 'api-style', text: 'GraphQL.' },
      reason: 'changed',
    })

    mount(root, new EngineClient(root))
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('3 of 4 entries are currently valid')
  })
})

// ── 3. retracting requires a reason, and appends ────────────────────────────

describe('retracting', () => {
  it('requires a reason before the control is enabled', async () => {
    const root = makeProject()
    await seed(root)
    const client = new EngineClient(root)
    mount(root, client)

    await waitFor(() => expect(screen.getAllByText('Retract').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('Retract')[0]!)

    const dialog = await screen.findByRole('dialog')
    // It is NOT called Delete, and it says what actually happens.
    expect(dialog.textContent).toContain('This is not a delete')
    expect(dialog.textContent).toContain('A reason is required')

    const confirm = dialog.querySelectorAll('button')
    const retract = [...confirm].find((button) => button.textContent === 'Retract')!
    expect(retract.hasAttribute('disabled')).toBe(true)

    // Whitespace is not a reason either.
    fireEvent.change(screen.getByLabelText('Why is this no longer true?'), {
      target: { value: '   ' },
    })
    expect(retract.hasAttribute('disabled')).toBe(true)
    // And nothing has been superseded while the reason was blank.
    expect(client.supersedes).toEqual([])
  })

  it('really retracts, APPENDING a close op and keeping the row', async () => {
    const root = makeProject()
    await seed(root)
    const client = new EngineClient(root)
    mount(root, client)

    await waitFor(() => expect(screen.getAllByText('Retract').length).toBe(3))
    fireEvent.click(screen.getAllByText('Retract')[0]!)
    fireEvent.change(await screen.findByLabelText('Why is this no longer true?'), {
      target: { value: 'we switched to GraphQL in PR 88' },
    })
    fireEvent.click([...screen.getByRole('dialog').querySelectorAll('button')].find((b) => b.textContent === 'Retract')!)

    await waitFor(() => expect(screen.getByText('retracted')).toBeTruthy())
    expect(client.supersedes[0]!.reason).toBe('we switched to GraphQL in PR 88')

    // THE ROW SURVIVES. Its window closed; it was not deleted.
    //
    // Queried by text rather than by role: after a retraction there are two `status`
    // regions on screen — the confirmation notice and the summary — and `getByRole`
    // rightly refuses to guess between them.
    await waitFor(() => expect(screen.getByText(/2\s*of\s*3\s*entries are currently valid/)).toBeTruthy())

    // And on disk it is an APPEND: the original add op still reads `"validTo":null`.
    const dir = mem.memoryDir(root)
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    const text = await readFile(join(dir, files[0]!), 'utf8')
    const lines = text.trim().split('\n')
    expect(lines.some((line) => line.includes('"op":"close"'))).toBe(true)
    const firstAdd = lines.find((line) => line.includes('"op":"add"'))!
    expect(firstAdd).toContain('"validTo":null')
  })

  it('tells the user the change is auditable rather than claiming a deletion', async () => {
    const root = makeProject()
    await seed(root)
    mount(root, new EngineClient(root))

    await waitFor(() => expect(screen.getAllByText('Retract').length).toBe(3))
    fireEvent.click(screen.getAllByText('Retract')[0]!)
    fireEvent.change(await screen.findByLabelText('Why is this no longer true?'), {
      target: { value: 'no longer true' },
    })
    fireEvent.click([...screen.getByRole('dialog').querySelectorAll('button')].find((b) => b.textContent === 'Retract')!)

    await waitFor(() => expect(screen.getByText(/window closed, so the change is auditable/)).toBeTruthy())
  })

  it('cancels without touching anything', async () => {
    const root = makeProject()
    await seed(root)
    const client = new EngineClient(root)
    mount(root, client)

    await waitFor(() => expect(screen.getAllByText('Retract').length).toBe(3))
    fireEvent.click(screen.getAllByText('Retract')[0]!)
    fireEvent.click(await screen.findByText('Cancel'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(client.supersedes).toEqual([])
  })
})

// ── 4. the lint pass reports, and the panel says it applied nothing ─────────

describe('hygiene findings', () => {
  it('shows a contradiction with its confidence and applies nothing', async () => {
    const root = makeProject()
    const store = new mem.JsonlMemoryStore({ baseDir: root })
    // Written straight to the store, bypassing `remember` — the bug the finding catches.
    await store.add({ kind: 'standard', key: 'test-location', text: 'beside the code' })
    await store.add({ kind: 'standard', key: 'test-location', text: 'in tests/' })

    mount(root, new EngineClient(root))
    await waitFor(() => expect(screen.getByRole('tab', { name: /Hygiene/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: /Hygiene/ }))

    const findings = await screen.findByLabelText('Hygiene findings')
    expect(findings.textContent).toContain('Only one can be true')
    expect(screen.getByText('certain')).toBeTruthy()

    // The panel is explicit that it changed nothing.
    expect(screen.getByRole('status').textContent).toContain('reported, not applied')
    // And both entries are still live.
    fireEvent.click(screen.getByRole('tab', { name: /^All/ }))
    await waitFor(() => expect(screen.getAllByText('current').length).toBe(2))
  })

  it('says so when memory is healthy', async () => {
    const root = makeProject()
    await seed(root)
    mount(root, new EngineClient(root))

    await waitFor(() => expect(screen.getByRole('tab', { name: /Hygiene/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: /Hygiene/ }))
    expect(await screen.findByText('No hygiene problems found')).toBeTruthy()
  })
})

// ── 5. searching, and the retrieval contract the panel relies on ────────────

describe('searching', () => {
  it('finds the entry that answers the question and shows history', async () => {
    const root = makeProject()
    const store = await seed(root)
    await mem.remember({
      store,
      entry: { kind: 'decision', key: 'api-style', subject: 'api', text: 'We use GraphQL endpoints.' },
      reason: 'GraphQL fits better',
    })

    mount(root, new EngineClient(root))
    await waitFor(() => expect(screen.getByLabelText('Search memory')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search memory'), { target: { value: 'endpoints' } })
    fireEvent.keyDown(screen.getByLabelText('Search memory'), { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('matched'))
    // The panel asks for history explicitly, so both the live and the retracted decision
    // are here — and the summary states that a prompt would see fewer.
    expect(screen.getByText('We use GraphQL endpoints.')).toBeTruthy()
    expect(screen.getByText('We use REST endpoints.')).toBeTruthy()
  })

  it('reports an honest nothing rather than an error', async () => {
    const root = makeProject()
    await seed(root)
    mount(root, new EngineClient(root))

    await waitFor(() => expect(screen.getByLabelText('Search memory')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Search memory'), {
      target: { value: 'kubernetes helm chart' },
    })
    fireEvent.keyDown(screen.getByLabelText('Search memory'), { key: 'Enter' })

    expect(await screen.findByText('Nothing matched')).toBeTruthy()
    expect(screen.getByText(/honest nothing, not an error/)).toBeTruthy()
  })
})

// ── 6. no engine, no memory ─────────────────────────────────────────────────

describe('honest empty state', () => {
  it('refuses to invent entries when the transport has no engine', () => {
    const root = makeProject()
    mount(root, withoutMemory(new EngineClient(root)))
    expect(screen.getByText('No engine behind this transport')).toBeTruthy()
    expect(screen.getByText(/invented decisions about your codebase/)).toBeTruthy()
    expect(screen.queryByLabelText('Memory entries')).toBeNull()
  })
})
