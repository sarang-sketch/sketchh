// Diff review, driven by real events against a real reducer and a real file layer.
//
// WHAT IS REAL HERE: the `edit_proposed` events come off the client seam exactly as
// the engine's do, the hunks are parsed and applied by the engine's own diff module
// (packages/core/src/diff/hunks.ts), the state transitions go through the `AppState`
// reducer, and the writes go through `writeFromEditor`. The panel is the real panel.
//
// WHAT IS DOUBLED, and only because it cannot exist under jsdom: the Tauri file layer
// (../editor/fakeDisk.ts — `invoke` has no implementation here). Its refusals are
// faithful to Rust's, so containment is exercised rather than bypassed.
//
// THE WRITER IS COUNTED, NOT INSPECTED. Requirement 16.5 says that rejecting every
// hunk leaves no file changed, and "it rewrote the same bytes" does not satisfy that:
// a rewrite bumps the modification time, wakes every watcher, and re-triggers a
// build. So `writes` below counts CALLS — before containment, before anything — and
// the reject-all test requires that count to be zero.
//
// Validates: Requirements 16.1, 16.2, 16.3, 16.5, 14.6, 15.2

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DiffReview } from './DiffReview'
import { FileIoProvider } from '../editor/FileIoProvider'
import { createFakeDisk, type FakeDisk } from '../editor/fakeDisk'
import type { FileIo } from '../editor/fileIo'
import { SketchClientProvider, useOptionalSketchEvents } from '../lib/ClientProvider'
import { createEventBus, type PingResult, type SketchClient } from '../lib/client'
import type { RunResult, SketchEvent } from '../lib/contracts'
import { AppStateProvider, makeFileEntry, useAppState, type AppState } from '../state/AppState'

const ROOT = 'C:/app'
const FILE = 'C:/app/src/app.ts'
const STATED = 'src/app.ts'

const ORIGINAL = [
  'line one',
  'line two',
  'line three',
  'line four',
  'line five',
  'line six',
  'line seven',
  'line eight',
  'line nine',
  'line ten',
  '',
].join('\n')

/** Two hunks, far enough apart that accepting one cannot disturb the other. */
const DIFF = [
  '@@ -1,3 +1,3 @@',
  ' line one',
  '-line two',
  '+line two changed',
  ' line three',
  '@@ -8,3 +8,3 @@',
  ' line eight',
  '-line nine',
  '+line nine changed',
  ' line ten',
  '',
].join('\n')

// ── the seam ────────────────────────────────────────────────────────────────

/** A client that emits nothing until a test says so. */
class FakeEventClient implements SketchClient {
  readonly transport = 'mock' as const
  private readonly bus = createEventBus()
  private seq = 0

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'mock' })
  }

  run(): Promise<RunResult> {
    throw new Error('the review surface never starts a run')
  }

  eval(): Promise<never[]> {
    return Promise.resolve([])
  }

  subscribe(handler: (event: SketchEvent) => void) {
    return this.bus.subscribe(handler)
  }

  gitStatus(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }

  gitDiff(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }

  gitStage(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }

  gitUnstage(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }

  gitCommit(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }

  // Diff review never touches provider configuration.
  providerCatalog(): Promise<never> {
    return Promise.reject(new Error('no provider configuration in this test'))
  }

  saveProviderSettings(): Promise<never> {
    return Promise.reject(new Error('no provider configuration in this test'))
  }

  testProvider(): Promise<never> {
    return Promise.reject(new Error('no provider configuration in this test'))
  }

  emit(kind: SketchEvent['kind'], payload: Record<string, unknown>, runId = 'run-1'): string {
    this.seq += 1
    const id = `engine-${this.seq}`
    act(() => {
      this.bus.emit({ id, ts: 1_700_000_000_000 + this.seq, runId, kind, payload })
    })
    return id
  }
}

/** Every write ATTEMPT, counted before the file layer can refuse or accept it. */
interface CountingIo {
  io: FileIo
  attempts: Array<{ path: string; content: string }>
}

function countingIo(disk: FakeDisk): CountingIo {
  const attempts: Array<{ path: string; content: string }> = []
  return {
    attempts,
    io: {
      readFile: (root, path) => disk.io.readFile(root, path),
      readDir: (root, path) => disk.io.readDir(root, path),
      pickFolder: () => disk.io.pickFolder(),
      async writeFile(root, path, content) {
        attempts.push({ path, content })
        await disk.io.writeFile(root, path, content)
      },
    },
  }
}

/** The one authoritative record of what the events say, and of file content. */
function Probe() {
  const events = useOptionalSketchEvents()
  const state = useAppState()
  return (
    <div>
      <span data-testid="events">
        {JSON.stringify(events.map((event) => ({ kind: event.kind, payload: event.payload })))}
      </span>
      <span data-testid="buffer">{state.files[FILE]?.content ?? 'not open'}</span>
      <span data-testid="dirty">{String(state.files[FILE]?.isDirty ?? false)}</span>
    </div>
  )
}

interface EventShape {
  kind: string
  payload: Record<string, unknown>
}

function emitted(kind: string): EventShape[] {
  const all = JSON.parse(screen.getByTestId('events').textContent ?? '[]') as EventShape[]
  return all.filter((event) => event.kind === kind)
}

let client: FakeEventClient
let disk: FakeDisk
let counting: CountingIo

beforeEach(() => {
  client = new FakeEventClient()
  disk = createFakeDisk({ [FILE]: ORIGINAL })
  counting = countingIo(disk)
})

afterEach(() => {
  cleanup()
})

function mount(initial: Partial<AppState> = {}) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ mode: 'ide', projectRoot: ROOT, ...initial }}>
        <FileIoProvider io={counting.io}>
          <DiffReview />
          <Probe />
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

/** The `plan_written` event the UI mirrors. It does not authorise the engine. */
function plan(runId = 'run-1'): string {
  return client.emit('plan_written', { dir: `${ROOT}/.sketch/plan/${runId}` }, runId)
}

/** The `edit_proposed` the engine emits before it writes. Returns its event id. */
function propose(
  diff: string = DIFF,
  path: string = STATED,
  runId = 'run-1',
  withPlan = true,
): string {
  if (withPlan) plan(runId)
  return client.emit('edit_proposed', { iteration: 1, edits: [{ path, diff }] }, runId)
}

const accept = (index: number) =>
  fireEvent.click(screen.getByLabelText(`Accept hunk ${index} of ${STATED}`))
const reject = (index: number) =>
  fireEvent.click(screen.getByLabelText(`Reject hunk ${index} of ${STATED}`))

// ── 0. plan gate mirror ─────────────────────────────────────────────────────

describe('DiffReview — run-scoped plan gate mirror (Requirements 16.4, 6.5)', () => {
  it('keeps acceptance disabled and writes nothing when this run has no plan_written event', async () => {
    mount()
    propose(DIFF, STATED, 'run-1', false)

    const acceptFirst = screen.getByLabelText(`Accept hunk 1 of ${STATED}`)
    const apply = screen.getByRole('button', { name: /Apply/ })
    expect(acceptFirst.hasAttribute('disabled')).toBe(true)
    expect(apply.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('note').textContent).toContain(
      'Apply is disabled because no plan_written event has been observed for run run-1',
    )

    fireEvent.click(acceptFirst)
    fireEvent.click(apply)
    await act(async () => {})
    expect(counting.attempts).toEqual([])
    expect(disk.read(FILE)).toBe(ORIGINAL)
  })

  it('does not let plan_written for another run unlock this proposal', () => {
    mount()
    plan('run-other')
    propose(DIFF, STATED, 'run-1', false)

    expect(screen.getByLabelText(`Accept hunk 1 of ${STATED}`).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /Apply/ }).hasAttribute('disabled')).toBe(true)
  })

  it('enables acceptance when plan_written is observed later for the same run', () => {
    mount()
    propose(DIFF, STATED, 'run-1', false)
    expect(screen.getByLabelText(`Accept hunk 1 of ${STATED}`).hasAttribute('disabled')).toBe(true)

    // The projection is order-independent: the plan can arrive after the proposal.
    plan('run-1')
    expect(screen.getByLabelText(`Accept hunk 1 of ${STATED}`).hasAttribute('disabled')).toBe(false)

    accept(1)
    accept(2)
    expect(screen.getByRole('button', { name: /Apply/ }).hasAttribute('disabled')).toBe(false)
  })

  it('recomputes the gate for the selected proposal rather than leaking across runs', () => {
    mount()
    propose(DIFF, STATED, 'run-a', false)
    propose(DIFF, 'src/other.ts', 'run-b', false)
    plan('run-a')

    // Newest run B is selected and remains locked.
    expect(
      screen.getByLabelText('Accept hunk 1 of src/other.ts').hasAttribute('disabled'),
    ).toBe(true)

    // Selecting older run A derives its own gate from the same event log.
    fireEvent.click(screen.getByText(STATED, { selector: 'span' }).closest('button')!)
    expect(screen.getByLabelText(`Accept hunk 1 of ${STATED}`).hasAttribute('disabled')).toBe(false)
  })
})

// ── 1. no fixture, no HTML ──────────────────────────────────────────────────

describe('DiffReview — nothing fabricated, nothing rendered as HTML', () => {
  /** The panel's CODE, comments stripped: a comment about a fixture is not one. */
  const code = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'DiffReview.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  it('declares no fixture of any kind (Requirement 14.6)', () => {
    expect(code).not.toMatch(/const MOCK_/)
    expect(code).not.toMatch(/const SAMPLE_/)
    expect(code).not.toMatch(/const EXAMPLE_/)
    // A hardcoded patch would be a fixture whatever it was called.
    expect(code).not.toContain('@@ -')
  })

  it('never sets HTML from diff text', () => {
    expect(code).not.toContain('dangerouslySetInnerHTML')
    expect(code).not.toContain('innerHTML')
  })

  it('does not reach for Monaco or keep a second copy of file text', () => {
    // The editor projects from AppState; the review surface writes through the file
    // layer and tells the reducer (Requirement 15.2).
    expect(code).not.toContain('setValue')
    expect(code).not.toContain('monaco')
    expect(code).toContain('writeFromEditor')
  })

  it('re-implements neither the parser nor the applier', () => {
    expect(code).toContain("from '../review/diffEngine'")
    expect(code).not.toContain('parseUnifiedDiff(')
  })
})

// ── 2. a real proposal, rendered ────────────────────────────────────────────

describe('DiffReview renders a proposal', () => {
  it('shows every hunk of the patch the event carried, as text (Requirement 16.1)', () => {
    mount()
    propose()

    expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeDefined()
    expect(screen.getByText('@@ -8,3 +8,3 @@')).toBeDefined()
    // The bodies are text nodes, prefixed the way a patch is.
    expect(screen.getByText(/^-line two$/m)).toBeDefined()
    expect(screen.getByText(/^\+line two changed$/m)).toBeDefined()
    expect(screen.getByText(/^\+line nine changed$/m)).toBeDefined()
  })

  it('offers accept and reject on each hunk (Requirement 16.2)', () => {
    mount()
    propose()

    for (const index of [1, 2]) {
      expect(screen.getByLabelText(`Accept hunk ${index} of ${STATED}`)).toBeDefined()
      expect(screen.getByLabelText(`Reject hunk ${index} of ${STATED}`)).toBeDefined()
    }
  })

  it('will not apply until every hunk has a verdict', () => {
    mount()
    propose()

    const apply = screen.getByRole('button', { name: /Apply/ })
    expect(apply.hasAttribute('disabled')).toBe(true)

    accept(1)
    expect(screen.getByText(/1 hunk still needs? a verdict/)).toBeDefined()
    expect(screen.getByRole('button', { name: /Apply/ }).hasAttribute('disabled')).toBe(true)

    reject(2)
    expect(screen.getByRole('button', { name: /Apply/ }).hasAttribute('disabled')).toBe(false)
  })
})

// ── 3. accepting one hunk and rejecting the other ───────────────────────────

describe('DiffReview applies exactly the accepted hunks', () => {
  it('writes the accepted hunk, leaves the rejected one out, and emits both events', async () => {
    mount()
    const proposalId = propose()

    accept(1)
    reject(2)
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))

    await waitFor(() => expect(counting.attempts).toHaveLength(1))

    // Hunk 1 landed; hunk 2 did not. One write, not two.
    const written = disk.read(FILE)
    expect(written).toContain('line two changed')
    expect(written).toContain('line nine')
    expect(written).not.toContain('line nine changed')
    // Everything else is byte-identical, trailing newline included.
    expect(written).toBe(ORIGINAL.replace('line two\n', 'line two changed\n'))

    await waitFor(() => expect(emitted('edit_accepted')).toHaveLength(1))
    const accepted = emitted('edit_accepted')[0]!
    expect(accepted.payload['hunks']).toEqual([0])
    expect(accepted.payload['path']).toBe(STATED)
    expect(accepted.payload['proposalId']).toBe(proposalId)

    const rejected = emitted('edit_rejected')[0]!
    expect(rejected.payload['hunks']).toEqual([1])
    expect(typeof rejected.payload['reason']).toBe('string')
    expect((rejected.payload['reason'] as string).length).toBeGreaterThan(0)
  })

  it('carries the reviewer\'s own reason on the rejection (Requirement 16.3)', async () => {
    mount()
    propose()

    fireEvent.change(screen.getByLabelText('Why these hunks are rejected'), {
      target: { value: 'renaming that breaks the public API' },
    })
    accept(1)
    reject(2)
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))

    await waitFor(() => expect(emitted('edit_rejected')).toHaveLength(1))
    expect(emitted('edit_rejected')[0]!.payload['reason']).toBe(
      'renaming that breaks the public API',
    )
  })

  it('updates the one state owner when the file is open, with no dirty flag left behind', async () => {
    // Open in a tab: the buffer is the authoritative baseline (Requirement 15.2).
    mount({
      openFiles: [FILE],
      activeFile: FILE,
      files: { [FILE]: makeFileEntry(FILE, ORIGINAL) },
    })
    propose()

    accept(1)
    accept(2)
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))

    await waitFor(() =>
      expect(screen.getByTestId('buffer').textContent).toContain('line two changed'),
    )
    expect(screen.getByTestId('buffer').textContent).toContain('line nine changed')
    // Disk and state agree, and nothing is pretending to be unsaved.
    expect(screen.getByTestId('buffer').textContent).toBe(disk.read(FILE))
    expect(screen.getByTestId('dirty').textContent).toBe('false')
  })
})

// ── 4. rejecting everything writes nothing at all ───────────────────────────

describe('DiffReview — rejecting every hunk (Requirement 16.5)', () => {
  it('never calls the writer, and leaves the file byte-identical', async () => {
    mount()
    const proposalId = propose()

    fireEvent.change(screen.getByLabelText('Why these hunks are rejected'), {
      target: { value: 'not the change I asked for' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Reject all/ }))

    await waitFor(() => expect(emitted('edit_rejected')).toHaveLength(1))

    // THE GUARD. Not "it wrote the same bytes" — the writer was never called.
    expect(counting.attempts).toEqual([])
    expect(disk.writes).toEqual([])
    expect(disk.read(FILE)).toBe(ORIGINAL)

    const rejected = emitted('edit_rejected')[0]!
    expect(rejected.payload['hunks']).toEqual([0, 1])
    expect(rejected.payload['reason']).toBe('not the change I asked for')
    expect(rejected.payload['proposalId']).toBe(proposalId)
    expect(emitted('edit_accepted')).toEqual([])
  })

  it('writes nothing when every hunk is individually rejected and Apply is pressed', async () => {
    mount()
    propose()

    reject(1)
    reject(2)
    // Apply is refused outright: there is nothing to write, and the button says so.
    const apply = screen.getByRole('button', { name: /Apply/ })
    expect(apply.hasAttribute('disabled')).toBe(true)
    fireEvent.click(apply)

    // Let anything the click could have started run to completion first.
    await act(async () => {})

    expect(screen.getAllByText('will not apply')).toHaveLength(2)
    expect(counting.attempts).toEqual([])
    expect(disk.read(FILE)).toBe(ORIGINAL)
  })
})

// ── 5. a proposal that no longer fits the file ──────────────────────────────

describe('DiffReview — a stale proposal is named, not swallowed', () => {
  it('reports the mismatched hunk when the file on disk has moved on, and writes nothing', async () => {
    // Someone edited the file after the proposal was made.
    disk.set(FILE, ORIGINAL.replace('line two\n', 'line TWO edited by hand\n'))
    mount()
    propose()

    accept(1)
    reject(2)
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('no longer matches')
    expect(alert.textContent).toContain(STATED)
    // The diagnostic names the hunk that failed and what it expected.
    expect(alert.textContent).toContain('hunk 1')
    expect(alert.textContent).toContain('line two')

    expect(counting.attempts).toEqual([])
    expect(disk.read(FILE)).toBe(ORIGINAL.replace('line two\n', 'line TWO edited by hand\n'))
    expect(emitted('edit_accepted')).toEqual([])
  })

  it('says so before a click when the open buffer already disagrees', async () => {
    const drifted = ORIGINAL.replace('line nine\n', 'line NINE edited by hand\n')
    mount({
      openFiles: [FILE],
      activeFile: FILE,
      files: { [FILE]: makeFileEntry(FILE, drifted) },
    })
    propose()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('no longer matches')
    expect(alert.textContent).toContain('hunk 2')
    // Still shown as a diff, not blanked out: the reviewer can see what drifted.
    expect(screen.getByText('@@ -8,3 +8,3 @@')).toBeDefined()
  })

  it('reports a patch it cannot parse instead of drawing an empty diff', () => {
    mount()
    propose('this is not a unified diff\n')

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('could not be read')
    expect(alert.textContent).toContain('no-hunk-header')
  })
})

// ── 6. the honest nothings ─────────────────────────────────────────────────

describe('DiffReview — honest states', () => {
  it('says no folder is open', () => {
    mount({ projectRoot: null })
    expect(screen.getByText('No folder open')).toBeDefined()
  })

  it('says there is no proposal to review', () => {
    mount()
    expect(screen.getByText('No proposal to review')).toBeDefined()
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull()
  })

  it('says a proposal is already resolved, and offers no controls for it', () => {
    mount()
    propose()
    // The engine applied it itself, which is what its own edit_accepted means.
    client.emit('edit_accepted', { path: STATED, bytes: 120, created: false })

    expect(screen.getByRole('status').textContent).toContain('Already resolved')
    expect(screen.queryByLabelText(`Accept hunk 1 of ${STATED}`)).toBeNull()
    expect(screen.queryByRole('button', { name: /Reject all/ })).toBeNull()
  })

  it('reports a proposal that carried no diff text as exactly that', () => {
    mount()
    client.emit('edit_proposed', {
      iteration: 1,
      edits: [{ path: STATED, wholeFile: false, searchBytes: 12, replaceBytes: 30 }],
    })

    expect(screen.getByText(/carried no diff text/)).toBeDefined()
    // The byte summary the event DID carry is still reported.
    expect(screen.getByText(/12 B searched/)).toBeDefined()
    expect(screen.queryByLabelText(`Accept hunk 1 of ${STATED}`)).toBeNull()
  })
})
