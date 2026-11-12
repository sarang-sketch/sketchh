// The Search panel: Find in Files and Replace in Files, through the REAL engine.
//
// The panel matches nothing itself, so the honest way to test it is to dispatch the same
// `METHODS` table the sidecar dispatches, in process, against a temp project with real
// files. Every line number, highlight and replacement below was computed by the engine
// from bytes on disk, and every replacement was written to (and undone on) real files.
//
// What these pin, in user terms:
//   * it finds EXACTLY what was typed — punctuation included — or a regular expression;
//   * the highlight is the engine's match, and a replace preview shows what goes and
//     what comes in its place;
//   * Replace All asks first, saves unsaved tabs first, writes, and can be undone;
//   * "no project", "nothing typed", "no results" and "the search failed" are different
//     sentences; a cap that stopped the search says so;
//   * a file outside the project cannot be found, however the query spells it.
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.4, 27.5

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METHODS, type MethodContext } from '@sketch/core'

import SearchPanel, { SEARCH_DEBOUNCE_MS } from './SearchPanel'
import { ConfirmProvider } from '../../components/ConfirmDialog'
import { FileIoProvider } from '../../editor/FileIoProvider'
import type { FileIo } from '../../editor/fileIo'
import { canonicalPath } from '../../editor/paths'
import { SketchClientProvider } from '../../lib/ClientProvider'
import {
  createEventBus,
  type EventHandler,
  type FindInFilesParams,
  type FindInFilesResult,
  type PingResult,
  type ReplaceInFilesParams,
  type ReplaceInFilesResult,
  type SketchClient,
  type UndoRunResult,
} from '../../lib/client'
import { AppStateProvider, makeFileEntry, useAppState, type AppState } from '../../state/AppState'

const tmpDirs: string[] = []

function makeWorkspace(): { root: string; outside: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-search-ui-'))
  tmpDirs.push(dir)
  const root = join(dir, 'project')
  const outside = join(dir, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  return { root, outside }
}

function write(base: string, relative: string, content: string): void {
  const full = join(base, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function read(base: string, relative: string): string {
  return readFileSync(join(base, relative), 'utf8')
}

/**
 * `src/retry.ts` DEFINES `parse_retry_budget` on line 3 and CALLS it on line 6;
 * `notes/note.md` merely mentions it. Line 4 contains `DEFAULT_BUDGET` and must not match.
 */
const RETRY = [
  '// HTTP retry policy.',
  'const DEFAULT_BUDGET = 250',
  'export function parse_retry_budget(raw: string): number {',
  '  return Number.parseInt(raw, 10) || DEFAULT_BUDGET',
  '}',
  "export const budget = parse_retry_budget('250')",
  '',
].join('\n')

function seed(root: string): void {
  write(root, 'src/retry.ts', RETRY)
  write(root, 'notes/note.md', 'mentions parse_retry_budget once\n')
}

/** Real reads and writes against the temp project. jsdom has no filesystem of its own. */
function fileIo(): FileIo {
  return {
    async readDir() {
      throw new Error('the search panel does not walk the tree')
    },
    async readFile(_root, path) {
      return readFileSync(path, 'utf8')
    },
    async writeFile(_root, path, content) {
      writeFileSync(path, content, 'utf8')
    },
    async pickFolder() {
      return null
    },
  }
}

function methodContext(root: string): MethodContext {
  return { emitEvent: () => {}, log: () => {}, rememberSecret: () => {}, secrets: () => [], env: {}, cwd: () => root }
}

/** Dispatches the same method table the sidecar dispatches, in this process. */
class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  readonly queries: string[] = []
  readonly replaces: ReplaceInFilesParams[] = []
  /** Hold one query's answer, so a stale completion can be tested. */
  gate: { query: string; release: Promise<void> } | null = null
  /** A smaller cap, so a truncation test does not need thousands of lines. */
  maxHits: number | undefined

  constructor(private readonly root: string) {}

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('the search panel never starts a run'))
  }
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

  async findInFiles(params: FindInFilesParams): Promise<FindInFilesResult> {
    this.queries.push(params.query)
    if (this.gate !== null && this.gate.query === params.query) await this.gate.release
    return METHODS['find-in-files']!(
      { ...params, ...(this.maxHits !== undefined ? { maxHits: this.maxHits } : {}) },
      methodContext(this.root),
    ) as Promise<FindInFilesResult>
  }

  async replaceInFiles(params: ReplaceInFilesParams): Promise<ReplaceInFilesResult> {
    this.replaces.push(params)
    return METHODS['replace-in-files']!({ ...params }, methodContext(this.root)) as Promise<ReplaceInFilesResult>
  }

  async undoRun(params: { root: string; runId: string }): Promise<UndoRunResult> {
    return METHODS['undo-run']!({ ...params }, methodContext(this.root)) as Promise<UndoRunResult>
  }
}

/** The same client with the capability absent, as a mock transport would be. */
function withoutSearch(client: SketchClient): SketchClient {
  const stripped = Object.create(client) as SketchClient
  stripped.findInFiles = undefined
  return stripped
}

function Probe() {
  const state = useAppState()
  const dirty = state.openFiles.filter((p) => state.files[p]?.isDirty)
  return (
    <>
      <div data-testid="active-file">{state.activeFile ?? 'none'}</div>
      <div data-testid="reveal">{state.revealRequest ? `${state.revealRequest.line}:${state.revealRequest.column}` : ''}</div>
      <div data-testid="dirty">{dirty.length}</div>
    </>
  )
}

function mount(root: string | null, client: SketchClient, initial: Partial<AppState> = {}) {
  return render(
    <AppStateProvider initial={{ projectRoot: root, searchQuery: '', ...initial }}>
      <FileIoProvider io={fileIo()}>
        <SketchClientProvider client={client}>
          <ConfirmProvider>
            <SearchPanel />
            <Probe />
          </ConfirmProvider>
        </SketchClientProvider>
      </FileIoProvider>
    </AppStateProvider>,
  )
}

function type(value: string): void {
  fireEvent.change(screen.getByLabelText('Search project files'), { target: { value } })
}

const SLOW = { timeout: 10_000 }

afterEach(() => cleanup())
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ── the panel carries no fixture and no matcher of its own ──────────────────

describe('SearchPanel source guards', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SearchPanel.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  it('has no fixture result and never sets HTML', () => {
    expect(source).not.toMatch(/mockResults|const MOCK_|MOCK_SEARCH/)
    expect(source).not.toContain('dangerouslySetInnerHTML')
  })

  it('does not search, spawn, or match anything itself', () => {
    // A matcher here would be a second dialect: what is highlighted and what Replace
    // writes could then disagree.
    expect(source).not.toMatch(/new RegExp|\.exec\(|\.replace\(\s*\/|useCommandIo|git grep/)
    expect(source).not.toContain('readDir')
    expect(source).toContain('client.findInFiles')
    expect(source).toContain('client.replaceInFiles')
  })
})

// ── honest states ───────────────────────────────────────────────────────────

describe('SearchPanel honest states', () => {
  it('distinguishes no project from nothing typed', () => {
    const { root } = makeWorkspace()
    const client = new EngineClient(root)
    mount(null, client)
    expect(screen.getByText('No folder open. Open a project to search its files.')).toBeDefined()
    cleanup()

    mount(root, client)
    expect(screen.getByText(/Type to search\./)).toBeDefined()
    expect(client.queries).toEqual([])
  })

  it('distinguishes no results from a failed search', async () => {
    const { root } = makeWorkspace()
    seed(root)
    mount(root, new EngineClient(root))
    type('nothing_here_at_all')
    expect(await screen.findByText(/No results for “nothing_here_at_all”/, undefined, SLOW)).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    cleanup()

    // A root that is not there is an ERROR, never "no results".
    const missing = join(root, 'does-not-exist')
    mount(missing, new EngineClient(missing))
    type('parse_retry_budget')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Search failed:'), SLOW)
    expect(screen.queryByText(/No results/)).toBeNull()
  }, 30_000)

  it('says which transport has nothing behind it instead of inventing hits', async () => {
    const { root } = makeWorkspace()
    seed(root)
    mount(root, withoutSearch(new EngineClient(root)))
    type('parse_retry_budget')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('has no engine behind it'))
  })
})

// ── real results ────────────────────────────────────────────────────────────

describe('SearchPanel results', () => {
  it('debounces, finds exactly what was typed, and highlights the engine’s spans', async () => {
    const { root } = makeWorkspace()
    seed(root)
    const client = new EngineClient(root)
    mount(root, client)

    type('parse')
    type('parse_retry_budget(')
    expect(client.queries).toEqual([])
    await screen.findByText(/2 results in 1 file/, undefined, SLOW)
    // One search for the final text, not one per keystroke.
    expect(client.queries).toEqual(['parse_retry_budget('])

    // Literal: the parenthesis is text. Line 3 defines it, line 6 calls it; line 4 is not a hit.
    expect(screen.getByTitle('src/retry.ts:3')).toBeDefined()
    expect(screen.getByTitle('src/retry.ts:6')).toBeDefined()
    expect(screen.queryByTitle('src/retry.ts:4')).toBeNull()
    expect(screen.queryByTitle('notes/note.md:1')).toBeNull()

    const row = screen.getByTitle('src/retry.ts:3')
    const highlighted = row.querySelectorAll('span[class*="highlight"]')
    expect([...highlighted].map((node) => node.textContent)).toEqual(['parse_retry_budget('])
    expect(row.textContent).toContain('export function parse_retry_budget(raw: string): number {')
  }, 30_000)

  it('opens a match where it is: the file, the line and the column', async () => {
    const { root } = makeWorkspace()
    seed(root)
    mount(root, new EngineClient(root))
    type('parse_retry_budget')
    fireEvent.click(await screen.findByTitle('src/retry.ts:6', undefined, SLOW))
    await waitFor(() => expect(screen.getByTestId('active-file').textContent).toBe(canonicalPath(join(root, 'src/retry.ts'))))
    // `export const budget = parse_retry_budget('250')`: the match starts at column 23.
    expect(screen.getByTestId('reveal').textContent).toBe('6:23')
  }, 30_000)

  it('Match Case, Whole Word and Regex each change what is found', async () => {
    const { root } = makeWorkspace()
    write(root, 'a.ts', 'const Value = value + values\n')
    mount(root, new EngineClient(root))
    type('value')
    await screen.findByText(/3 results in 1 file/, undefined, SLOW)
    fireEvent.click(screen.getByRole('button', { name: 'Match Case' }))
    await screen.findByText(/2 results in 1 file/, undefined, SLOW)
    fireEvent.click(screen.getByRole('button', { name: 'Match Whole Word' }))
    await screen.findByText(/1 result in 1 file/, undefined, SLOW)

    fireEvent.click(screen.getByRole('button', { name: 'Match Whole Word' }))
    fireEvent.click(screen.getByRole('button', { name: 'Match Case' }))
    type('val\\w+s')
    await screen.findByText(/No results/, undefined, SLOW)
    fireEvent.click(screen.getByRole('button', { name: 'Use Regular Expression' }))
    await screen.findByText(/1 result in 1 file/, undefined, SLOW)
  }, 30_000)

  it('files to include and exclude narrow the search', async () => {
    const { root } = makeWorkspace()
    write(root, 'src/a.ts', 'needle\n')
    write(root, 'src/a.test.ts', 'needle\n')
    write(root, 'docs/b.md', 'needle\n')
    mount(root, new EngineClient(root))
    type('needle')
    await screen.findByText(/3 results in 3 files/, undefined, SLOW)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Search Details' }))
    fireEvent.change(screen.getByLabelText('Files to include'), { target: { value: 'src' } })
    await screen.findByText(/2 results in 2 files/, undefined, SLOW)
    fireEvent.change(screen.getByLabelText('Files to exclude'), { target: { value: '*.test.ts' } })
    await screen.findByText(/1 result in 1 file/, undefined, SLOW)
    expect(screen.getByTitle('src/a.ts:1')).toBeDefined()
  }, 30_000)

  it('never renders a result the query has already moved past', async () => {
    const { root } = makeWorkspace()
    seed(root)
    write(root, 'src/fresh.ts', 'export const fresh_marker = true\n')
    const client = new EngineClient(root)
    let release!: () => void
    client.gate = { query: 'parse_retry_budget', release: new Promise<void>((done) => (release = () => done())) }
    mount(root, client)

    type('parse_retry_budget')
    await waitFor(() => expect(client.queries).toEqual(['parse_retry_budget']), SLOW)
    type('fresh_marker')
    await screen.findByTitle('src/fresh.ts:1', undefined, SLOW)

    await act(async () => {
      release()
      await new Promise((done) => setTimeout(done, 50))
    })
    expect(screen.queryByTitle('src/retry.ts:3')).toBeNull()
    expect(screen.getByTitle('src/fresh.ts:1')).toBeDefined()
  }, 30_000)

  it('says a cap stopped the search rather than reporting a complete answer', async () => {
    const { root } = makeWorkspace()
    write(root, 'src/bulk.ts', `${Array.from({ length: 60 }, (_, i) => `const capped_${i} = capped_needle`).join('\n')}\n`)
    const client = new EngineClient(root)
    client.maxHits = 25
    mount(root, client)
    type('capped_needle')
    expect(await screen.findByText(/a cap stopped the search/, undefined, SLOW)).toBeDefined()
    expect(screen.getByText(/25 results in 1 file/)).toBeDefined()
  }, 30_000)

  it('cannot see a file outside the project, however the query spells it', async () => {
    const { root, outside } = makeWorkspace()
    seed(root)
    writeFileSync(join(outside, 'secret.ts'), 'export const smuggled_secret = 1\n', 'utf8')
    mount(root, new EngineClient(root))
    type('smuggled_secret')
    await screen.findByText(/No results/, undefined, SLOW)
    type('../outside/secret.ts')
    await screen.findByText(/No results for “..\/outside\/secret.ts”/, undefined, SLOW)
    expect(screen.queryByText(/smuggled_secret/)).toBeNull()
  }, 30_000)
})

// ── replace ─────────────────────────────────────────────────────────────────

describe('SearchPanel replace', () => {
  async function openReplace(text: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Replace' }))
    fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: text } })
  }

  it('previews, asks, replaces on disk, and undoes', async () => {
    const { root } = makeWorkspace()
    seed(root)
    const client = new EngineClient(root)
    mount(root, client)
    type('parse_retry_budget')
    await screen.findByText(/3 results in 2 files/, undefined, SLOW)
    await openReplace('parseRetryBudget')

    // The preview: what goes, and what comes in its place — computed by the engine.
    await waitFor(() => {
      const row = screen.getByTitle('src/retry.ts:3')
      expect(row.querySelector('del')?.textContent).toBe('parse_retry_budget')
      expect(row.querySelector('ins')?.textContent).toBe('parseRetryBudget')
    }, SLOW)
    expect(read(root, 'src/retry.ts')).toBe(RETRY)

    fireEvent.click(screen.getByRole('button', { name: 'Replace All' }))
    expect(await screen.findByText('Replace 3 matches in 2 files?')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))

    await screen.findByText(/Replaced 3 matches in 2 files\./, undefined, SLOW)
    expect(read(root, 'src/retry.ts')).toBe(RETRY.replace(/parse_retry_budget/g, 'parseRetryBudget'))
    expect(read(root, 'notes/note.md')).toBe('mentions parseRetryBudget once\n')
    // The search ran again and has nothing left to show.
    await screen.findByText(/No results for “parse_retry_budget”/, undefined, SLOW)

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))
    await screen.findByText(/Restored 2 files\./, undefined, SLOW)
    expect(read(root, 'src/retry.ts')).toBe(RETRY)
    expect(read(root, 'notes/note.md')).toBe('mentions parse_retry_budget once\n')
  }, 30_000)

  it('Cancel writes nothing', async () => {
    const { root } = makeWorkspace()
    seed(root)
    const client = new EngineClient(root)
    mount(root, client)
    type('parse_retry_budget')
    await screen.findByText(/3 results in 2 files/, undefined, SLOW)
    await openReplace('x')
    await waitFor(() => expect(screen.getByTitle('src/retry.ts:3').querySelector('ins')).not.toBeNull(), SLOW)
    fireEvent.click(screen.getByRole('button', { name: 'Replace All' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await new Promise((done) => setTimeout(done, 50))
    expect(client.replaces).toEqual([])
    expect(read(root, 'src/retry.ts')).toBe(RETRY)
  }, 30_000)

  it('one file, or one line, at a time', async () => {
    const { root } = makeWorkspace()
    seed(root)
    mount(root, new EngineClient(root))
    type('parse_retry_budget')
    await screen.findByText(/3 results in 2 files/, undefined, SLOW)
    await openReplace('prb')
    await waitFor(() => expect(screen.getByTitle('src/retry.ts:6').querySelector('ins')).not.toBeNull(), SLOW)

    fireEvent.click(screen.getByRole('button', { name: 'Replace in src/retry.ts line 6' }))
    await waitFor(() => expect(read(root, 'src/retry.ts')).toContain("export const budget = prb('250')"))
    expect(read(root, 'src/retry.ts')).toContain('export function parse_retry_budget(')
    expect(read(root, 'notes/note.md')).toBe('mentions parse_retry_budget once\n')

    await screen.findByText(/2 results in 2 files/, undefined, SLOW)
    fireEvent.click(screen.getByRole('button', { name: 'Replace all in notes/note.md' }))
    await waitFor(() => expect(read(root, 'notes/note.md')).toBe('mentions prb once\n'))
    expect(read(root, 'src/retry.ts')).toContain('export function parse_retry_budget(')
  }, 30_000)

  it('saves a tab with unsaved edits before replacing in it, so neither is lost', async () => {
    const { root } = makeWorkspace()
    seed(root)
    const path = canonicalPath(join(root, 'src/retry.ts'))
    const entry = makeFileEntry(path, RETRY)
    const edited = RETRY.replace('// HTTP retry policy.', '// HTTP retry policy, edited in the editor.')
    mount(root, new EngineClient(root), {
      openFiles: [path],
      activeFile: path,
      files: { [path]: { ...entry, content: edited, isDirty: true } },
    })
    type('parse_retry_budget')
    await screen.findByText(/3 results in 2 files/, undefined, SLOW)
    await openReplace('prb')
    await waitFor(() => expect(screen.getByTitle('src/retry.ts:3').querySelector('ins')).not.toBeNull(), SLOW)
    fireEvent.click(screen.getByRole('button', { name: 'Replace All' }))
    expect(await screen.findByText(/unsaved changes; it is saved first/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Save and Replace' }))

    await screen.findByText(/Replaced 3 matches in 2 files\./, undefined, SLOW)
    // The person's edit AND the replacement, both on disk.
    expect(read(root, 'src/retry.ts')).toBe(edited.replace(/parse_retry_budget/g, 'prb'))
    expect(screen.getByTestId('dirty').textContent).toBe('0')
  }, 30_000)
})

describe('SearchPanel debounce', () => {
  it('waits a quarter second', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(250)
  })
})
