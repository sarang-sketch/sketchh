// The Search panel, driven against the REAL engine over a REAL project on disk.
//
// ── WHY THIS TEST LOOKS LIKE THIS ───────────────────────────────────────────
//
// The panel used to have its own search engine in this package — `git grep` through
// the Tauri command policy, a folder walk behind it, and its own regex matcher — so
// its tests could be written against a command double that returned canned
// `path:line:text` lines. That implementation is deleted. The panel now calls the
// engine's ONE lexical channel over the client seam, so the honest way to test it is
// to dispatch the same `METHODS` table the sidecar dispatches, in process, against a
// temp project with real files in it. Every line number, every highlight offset and
// every engine name below was computed by the engine from bytes on disk.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §3 — the highlight offsets come from the ENGINE's `matchSpans`, the same
//     function the retrieval ranking counts. Break it and this test AND
//     packages/core's retrieval tests fail together. That is the whole point of the
//     convergence: one dialect, two callers, provably.
//   * §4 — the engine that answered is NAMED, and a cap that stopped the search says
//     so instead of looking like "no matches" (Requirement 27.5).
//   * §5 — a file outside the project is not searchable, and a query that spells a
//     path outside the project is data, not a path.
//   * §6 — no engine behind the transport means no results, not invented ones.
//
// Validates: Requirements 14.6, 22.6, 27.1, 27.3, 27.4, 27.5

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METHODS, context, type MethodContext } from '@sketch/core'

import SearchPanel, { SEARCH_DEBOUNCE_MS } from './SearchPanel'
import { FileIoProvider } from '../../editor/FileIoProvider'
import type { FileIo } from '../../editor/fileIo'
import { canonicalPath } from '../../editor/paths'
import { SketchClientProvider } from '../../lib/ClientProvider'
import {
  createEventBus,
  type EventHandler,
  type PingResult,
  type SketchClient,
} from '../../lib/client'
import type { ProjectSearchResult } from '../../lib/contracts'
import { AppStateProvider, useAppState, type AppState } from '../../state/AppState'

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

/**
 * The fixture, byte-for-byte the one packages/core/test/project-search.test.ts uses.
 * `src/retry.ts` DEFINES `parse_retry_budget` on line 3 and CALLS it on line 6;
 * `notes/note.md` merely mentions it. Line 4 contains `DEFAULT_BUDGET` and must not
 * match, which is what makes the highlight offsets below worth asserting.
 */
function seed(root: string): void {
  write(
    root,
    'src/retry.ts',
    [
      '// HTTP retry policy.',
      'const DEFAULT_BUDGET = 250',
      'export function parse_retry_budget(raw: string): number {',
      '  return Number.parseInt(raw, 10) || DEFAULT_BUDGET',
      '}',
      "export const budget = parse_retry_budget('250')",
      '',
    ].join('\n'),
  )
  write(root, 'notes/note.md', 'mentions parse_retry_budget once\n')
}

/** Real reads against the temp project. jsdom has no filesystem of its own. */
function fileIo(): FileIo {
  return {
    async readDir() {
      throw new Error('the search panel does not walk the tree any more')
    },
    async readFile(_root, path) {
      return readFileSync(path, 'utf8')
    },
    async writeFile() {
      throw new Error('search never writes')
    },
    async pickFolder() {
      return null
    },
  }
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

/** Dispatches the same method table the sidecar dispatches, in this process. */
class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  readonly queries: string[] = []
  /** Set to hold one query's answer, so a stale completion can be tested. */
  gate: { query: string; release: Promise<void> } | null = null

  constructor(private readonly root: string) {}

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('the search panel never starts a run'))
  }
  eval(): Promise<never[]> {
    return Promise.resolve([])
  }
  subscribe(handler: EventHandler) {
    return this.bus.subscribe(handler)
  }
  gitStatus(): Promise<never> {
    return Promise.reject(new Error('the search panel never reads git'))
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

  async projectSearch(params: {
    root: string
    query: string
    matchCase?: boolean
    wholeWord?: boolean
  }): Promise<ProjectSearchResult> {
    this.queries.push(params.query)
    if (this.gate !== null && this.gate.query === params.query) await this.gate.release
    return METHODS['project-search']!(
      {
        root: params.root,
        query: params.query,
        ...(params.matchCase === true ? { matchCase: true } : {}),
        ...(params.wholeWord === true ? { wholeWord: true } : {}),
      },
      methodContext(this.root),
    ) as Promise<ProjectSearchResult>
  }
}

/** The same client with the capability absent, as a mock transport would be. */
function withoutSearch(client: SketchClient): SketchClient {
  const stripped = Object.create(client) as SketchClient
  stripped.projectSearch = undefined
  return stripped
}

function Probe() {
  const state = useAppState()
  return <div data-testid="active-file">{state.activeFile ?? 'none'}</div>
}

function mount(
  root: string | null,
  client: SketchClient,
  initial: Partial<AppState> = {},
  files: FileIo = fileIo(),
) {
  return render(
    <AppStateProvider initial={{ projectRoot: root, searchQuery: '', ...initial }}>
      <FileIoProvider io={files}>
        <SketchClientProvider client={client}>
          <SearchPanel />
          <Probe />
        </SketchClientProvider>
      </FileIoProvider>
    </AppStateProvider>,
  )
}

function type(value: string): void {
  fireEvent.change(screen.getByLabelText('Search project files'), { target: { value } })
}

/** Which engine THIS machine will use, so the test states it rather than accepting either. */
async function expectedEngine(root: string): Promise<string> {
  const probe = await context.detectRipgrep({ cwd: root })
  return probe.available ? 'ripgrep' : 'the built-in scanner'
}

beforeEach(() => {
  // Detection is cached process-wide by design; a test must not inherit it.
  context.resetRipgrepDetection()
})

afterEach(() => {
  cleanup()
  context.resetRipgrepDetection()
})

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ── §1 the panel carries no fixture and no second implementation ────────────

describe('SearchPanel source guards', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SearchPanel.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  it('has no fixture result and never sets HTML', () => {
    expect(source).not.toMatch(/mockResults|const MOCK_|MOCK_SEARCH/)
    expect(source).not.toContain('dangerouslySetInnerHTML')
    expect(source).not.toContain('src/components/Button.tsx')
  })

  it('does not search, spawn, or match anything itself', () => {
    // The convergence, asserted structurally: no second engine can grow back here.
    // A matcher in this file is a second dialect, and a spawn in this file is the
    // `git grep` path that made `rg` look like an allowlist problem.
    expect(source).not.toMatch(/new RegExp|\.exec\(|useCommandIo|git grep/)
    expect(source).not.toContain('readDir')
    expect(source).toContain('client.projectSearch')
  })
})

// ── §2 honest states ────────────────────────────────────────────────────────

describe('SearchPanel honest states', () => {
  it('distinguishes no project from no query', () => {
    const { root } = makeWorkspace()
    const client = new EngineClient(root)
    mount(null, client)
    expect(screen.getByText('No folder open. Open a project to search its files.')).toBeDefined()
    expect((screen.getByLabelText('Search project files') as HTMLInputElement).value).toBe('')
    cleanup()

    mount(root, client)
    expect(screen.getByText('Type something to search for.')).toBeDefined()
    expect(client.queries).toEqual([])
  })

  it('distinguishes no matches from a failed search', async () => {
    const { root } = makeWorkspace()
    seed(root)
    mount(root, new EngineClient(root))
    type('nothing_here_at_all')
    await waitFor(() => expect(screen.getByText(/No matches/)).toBeDefined(), { timeout: 10_000 })
    expect(screen.getByText(/No matches for “nothing_here_at_all”/)).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    cleanup()

    // A root that is not there is an ERROR, never "no matches": the difference is
    // "look somewhere else" versus "that word is not in your project".
    const missing = join(root, 'does-not-exist')
    mount(missing, new EngineClient(missing))
    type('parse_retry_budget')
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined(), { timeout: 10_000 })
    expect(screen.getByRole('alert').textContent).toContain('Search failed:')
    expect(screen.queryByText(/No matches/)).toBeNull()
    // Two real searches over a real project, each with the debounce and a ripgrep
    // probe in front of it. The 5 s default is a harness limit, not a contract.
  }, 30_000)
})

// ── §3 real results, with the engine's own match offsets ─────────────────────

describe('SearchPanel results', () => {
  it('debounces, names the engine, and highlights the spans the engine returned', async () => {
    const { root } = makeWorkspace()
    seed(root)
    const client = new EngineClient(root)
    mount(root, client)

    // Every keystroke of a word must not be a search.
    type('parse')
    type('parse_retry_budget')
    expect(client.queries).toEqual([])

    await waitFor(() => expect(screen.getByText(/matches in/)).toBeDefined(), { timeout: 10_000 })
    expect(client.queries).toEqual(['parse_retry_budget'])

    const engine = await expectedEngine(root)
    expect(screen.getByText(new RegExp(`via ${engine}\\.`))).toBeDefined()

    // Real line numbers from the real file: the definition is line 3, the call is
    // line 6 (1-based, as every editor counts). Line 4 mentions DEFAULT_BUDGET and
    // is NOT a hit — the dialect matches the query, not a word near it.
    expect(screen.getByTitle('Open src/retry.ts at line 3')).toBeDefined()
    expect(screen.getByTitle('Open src/retry.ts at line 6')).toBeDefined()
    expect(screen.queryByTitle('Open src/retry.ts at line 4')).toBeNull()
    expect(screen.getByTitle('Open notes/note.md at line 1')).toBeDefined()

    // THE DIALECT. The highlighted text is what the engine's `matchSpans` found —
    // the panel has no matcher to compute it with. The span must cover exactly the
    // identifier, not the surrounding line.
    const row = screen.getByTitle('Open src/retry.ts at line 3')
    const highlighted = row.querySelectorAll('span[class*="highlight"]')
    expect([...highlighted].map((node) => node.textContent)).toEqual(['parse_retry_budget'])
    expect(row.textContent).toContain('export function parse_retry_budget(raw: string): number {')
  }, 30_000)

  it('opens a hit through the file-action owner', async () => {
    const { root } = makeWorkspace()
    seed(root)
    mount(root, new EngineClient(root))
    type('parse_retry_budget')
    await waitFor(() => expect(screen.getByTitle('Open src/retry.ts at line 3')).toBeDefined(), {
      timeout: 10_000,
    })

    fireEvent.click(screen.getByTitle('Open src/retry.ts at line 3'))
    await waitFor(() =>
      expect(screen.getByTestId('active-file').textContent).toBe(
        canonicalPath(join(root, 'src/retry.ts')),
      ),
    )
  }, 30_000)

  it('never renders a result the query has already moved past', async () => {
    const { root } = makeWorkspace()
    seed(root)
    write(root, 'src/fresh.ts', 'export const fresh_marker = true\n')
    const client = new EngineClient(root)
    let release!: () => void
    client.gate = {
      query: 'parse_retry_budget',
      release: new Promise<void>((done) => {
        release = () => done()
      }),
    }
    mount(root, client)

    type('parse_retry_budget')
    await waitFor(() => expect(client.queries).toEqual(['parse_retry_budget']), { timeout: 10_000 })

    type('fresh_marker')
    await waitFor(() => expect(screen.getByTitle('Open src/fresh.ts at line 1')).toBeDefined(), {
      timeout: 10_000,
    })

    // The abandoned query now finishes, with results nobody is asking for.
    await act(async () => {
      release()
      await new Promise((done) => setTimeout(done, 50))
    })

    expect(screen.queryByTitle('Open src/retry.ts at line 3')).toBeNull()
    expect(screen.getByTitle('Open src/fresh.ts at line 1')).toBeDefined()
  }, 30_000)
})

// ── §4 a cap is not an empty result ─────────────────────────────────────────

describe('SearchPanel truncation', () => {
  it('says a cap stopped the search rather than reporting a complete answer', async () => {
    const { root } = makeWorkspace()
    // Five files of sixty matching lines each: more than the engine's 200-hit cap,
    // and each file over its own 50-match cap.
    for (let file = 0; file < 5; file++) {
      const lines = Array.from({ length: 60 }, (_, i) => `const capped_needle_${file}_${i} = capped_needle`)
      write(root, `src/bulk-${file}.ts`, `${lines.join('\n')}\n`)
    }
    mount(root, new EngineClient(root))
    type('capped_needle')

    await waitFor(() => expect(screen.getByText(/A cap stopped the search/)).toBeDefined(), {
      timeout: 15_000,
    })
    expect(screen.getByText(/200 matches in/)).toBeDefined()
    expect(screen.queryByText(/No matches/)).toBeNull()
  }, 30_000)
})

// ── §5 containment ─────────────────────────────────────────────────────────

describe('SearchPanel containment', () => {
  it('cannot see a file outside the project, however the query spells it', async () => {
    const { root, outside } = makeWorkspace()
    seed(root)
    writeFileSync(join(outside, 'secret.ts'), 'export const smuggled_secret = 1\n', 'utf8')

    const client = new EngineClient(root)
    mount(root, client)

    // The text exists on the disk, one directory above the project. It is not in the
    // walked universe, so there is nothing to find.
    type('smuggled_secret')
    await waitFor(() => expect(screen.getByText(/No matches/)).toBeDefined(), { timeout: 10_000 })
    cleanup()

    // And a query that is a path traversal is a QUERY: it searches for that text, it
    // does not read that file.
    mount(root, client)
    type('../outside/secret.ts')
    await waitFor(() => expect(screen.getByText(/No matches/)).toBeDefined(), { timeout: 10_000 })
    expect(screen.queryByText(/smuggled_secret/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  }, 30_000)
})

// ── §6 no engine, no results ────────────────────────────────────────────────

describe('SearchPanel without an engine', () => {
  it('says which transport has nothing behind it instead of inventing hits', async () => {
    const { root } = makeWorkspace()
    seed(root)
    mount(root, withoutSearch(new EngineClient(root)))
    type('parse_retry_budget')
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
    expect(screen.getByRole('alert').textContent).toContain('has no engine behind it')
    expect(screen.queryByText(/matches in/)).toBeNull()
  })
})

// The debounce constant is exported for callers that coordinate with it; asserted
// here so a change to it is a deliberate one.
describe('SearchPanel debounce', () => {
  it('waits a quarter second', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(250)
  })
})
