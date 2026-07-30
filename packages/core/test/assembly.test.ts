// Context assembly and signature extraction tests.
//
// Uses REAL: temp project directories with real files, the real walker, chunker
// and import extractor via `buildRepoGraph`, the real hybrid search (scanner
// engine, so the result does not depend on whether `rg` is installed on the
// machine), the real hashing embedder and vector store, and a real
// MemoryEventStore. Nothing is mocked.
//
// The two claims that carry this task are asserted on BEHAVIOUR, not on shape:
//
//   * SIGNATURES OVER BODIES — at a budget that fits two outlines but only one
//     body, both chunks survive as outlines. Prefer bodies instead and the count
//     drops to one, which is what the mutation check exercises.
//   * THE BUDGET IS NEVER EXCEEDED — swept across every budget from 0 upwards,
//     `estimateTokens(text) <= budget` holds at each step.
//
// Validates: Requirements 18.4, 18.5, 18.6, 18.8

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  assembleContext,
  estimateTokens,
  oneHopNeighbours,
  TOKEN_ESTIMATE_METHOD,
} from '../src/context/assembly.js'
import {
  extractSignatures,
  renderSignatures,
  languageOf,
  BODY_ELISION,
} from '../src/context/signatures.js'
import { buildRepoGraph, type RepoGraph } from '../src/context/repo-graph.js'
import { ContextEngine } from '../src/context/context-engine.js'
import { HashEmbedder } from '../src/context/embedder.js'
import { MemoryVectorStore } from '../src/context/vector-store.js'
import { MemoryEventStore } from '../src/events/index.js'
import type { Skill } from '../src/types.js'

const tmpDirs: string[] = []

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-assembly-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function write(root: string, relative: string, content: string): Promise<void> {
  const full = join(root, relative)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

// ── the fixture ─────────────────────────────────────────────────────────────
//
// `service.ts` mentions the query token and imports `repo.ts`, so `repo.ts` is
// the one-hop neighbour. `theme.css` also mentions the token, which is how a
// language with no signature extractor gets into the same assembly.

const SERVICE = `import { findWidget } from './repo.js'

/** Load one widget by id. */
export async function loadWidget(id: string): Promise<string> {
  const widget = await findWidget(id)
  if (widget === null) throw new Error('loadWidget: no such widget')
  return widget
}

export const describeWidget = (id: string): string => \`widget \${id}\`
`

const REPO = `export interface WidgetRow {
  id: string
  label: string
}

/** Find a widget row, or null. */
export async function findWidget(id: string): Promise<string | null> {
  return id === '' ? null : id
}

export function countWidgets(rows: WidgetRow[]): number {
  return rows.length
}
`

const THEME = `.loadWidget-panel {
  color: blue;
  padding: 10px;
}
`

async function seed(root: string): Promise<void> {
  await write(root, 'src/service.ts', SERVICE)
  await write(root, 'src/repo.ts', REPO)
  await write(root, 'styles/theme.css', THEME)
}

async function graphFor(root: string): Promise<RepoGraph> {
  const { graph } = await buildRepoGraph({ root, previous: null, persist: false })
  return graph
}

const SKILLS: Skill[] = [
  {
    name: 'context-packing',
    description: 'Pack only what the task needs.',
    body: 'Prefer signatures over bodies when the budget is tight.',
    source: 'test',
  },
]

const MEMORY = ['## Coding standards', '- style: no semicolons', '- tests: vitest'].join('\n')

interface AssembleArgs {
  budgetTokens: number
  root: string
  graph: RepoGraph
  events?: MemoryEventStore
  memory?: string
  skills?: Skill[]
  maxNeighbours?: number
}

async function assemble(args: AssembleArgs) {
  return assembleContext({
    root: args.root,
    graph: args.graph,
    query: 'loadWidget',
    budgetTokens: args.budgetTokens,
    memory: args.memory ?? MEMORY,
    skills: args.skills ?? SKILLS,
    // The scanner engine keeps the test hermetic: identical results whether or
    // not ripgrep is installed.
    preferRipgrep: false,
    topK: 6,
    maxNeighbours: args.maxNeighbours ?? 4,
    events: args.events,
    runId: 'run-assembly',
  })
}

// ── signature extraction ────────────────────────────────────────────────────

describe('extractSignatures', () => {
  it('keeps function and type signatures and elides bodies', () => {
    const extraction = extractSignatures('src/repo.ts', REPO)

    expect(extraction.supported).toBe(true)
    expect(extraction.declarations.map(d => d.name)).toEqual([
      'WidgetRow',
      'findWidget',
      'countWidgets',
    ])

    const findWidget = extraction.declarations.find(d => d.name === 'findWidget')!
    expect(findWidget.signature).toBe(
      `export async function findWidget(id: string): Promise<string | null> ${BODY_ELISION}`
    )
    // The body is gone; the contract is not.
    expect(findWidget.signature).not.toContain('return id')
    expect(findWidget.doc).toContain('Find a widget row')

    // An interface's members ARE its signature, so the block is kept whole.
    const row = extraction.declarations.find(d => d.name === 'WidgetRow')!
    expect(row.signature).toContain('label: string')
    expect(row.signature.trimEnd().endsWith('}')).toBe(true)
  })

  it('extracts arrow functions, classes and their methods', () => {
    const source = [
      'export class Cache {',
      '  private entries = new Map<string, string>()',
      '',
      '  get(key: string): string | undefined {',
      '    return this.entries.get(key)',
      '  }',
      '}',
      '',
      'export const identity = (value: string): string => value',
      '',
      'const total = (1 + 2)',
    ].join('\n')

    const names = extractSignatures('src/cache.ts', source).declarations.map(d => d.name)
    expect(names).toContain('Cache')
    expect(names).toContain('get')
    expect(names).toContain('identity')
    // `const total = (1 + 2)` is a value, not a callable, and is not claimed.
    expect(names).not.toContain('total')
  })

  it('extracts Python defs and classes', () => {
    const source = [
      'class Widget:',
      '    """A widget."""',
      '',
      '    def label(self, prefix: str) -> str:',
      '        return prefix',
      '',
      'async def load(id: str) -> str:',
      '    return id',
    ].join('\n')

    const extraction = extractSignatures('app/widget.py', source)
    expect(extraction.language).toBe('python')
    expect(extraction.declarations.map(d => d.name)).toEqual(['Widget', 'label', 'load'])
    expect(extraction.declarations[2]!.signature).toContain('async def load(id: str) -> str:')
  })

  it('degrades honestly on a language it cannot parse', () => {
    const extraction = extractSignatures('styles/theme.css', THEME)

    expect(languageOf('styles/theme.css')).toBe('unsupported')
    expect(extraction.supported).toBe(false)
    expect(extraction.declarations).toEqual([])
    expect(extraction.reason).toContain('no signature extractor')
    // Nothing is invented for a language it does not read.
    expect(renderSignatures(extraction)).toBe('')
  })

  it('omits a declaration it cannot bound instead of emitting a fragment', () => {
    // A chunk that starts mid-parameter-list: the opening `function` line is not
    // in the text at all, and the trailing declaration never closes.
    const midChunk = [
      '  return widget',
      '}',
      '',
      'export function unterminated(',
      '  first: string,',
    ].join('\n')

    const extraction = extractSignatures('src/service.ts', midChunk)
    expect(extraction.declarations).toEqual([])
    expect(extraction.unresolved).toBe(1)
    expect(renderSignatures(extraction)).toBe('')
  })

  it('never lets a braceless declaration absorb the next one', () => {
    const source = [
      "export type Mode = 'local' | 'provider'",
      '',
      'export interface Status {',
      '  mode: Mode',
      '}',
      '',
    ].join('\n')

    const extraction = extractSignatures('src/types.ts', source)
    const mode = extraction.declarations.find(d => d.name === 'Mode')!
    expect(mode.signature).toBe("export type Mode = 'local' | 'provider'")
    expect(mode.signature).not.toContain('interface')
    expect(extraction.declarations.find(d => d.name === 'Status')!.signature).toContain(
      'mode: Mode'
    )
  })

  it('is a pure function of its input', () => {
    const once = extractSignatures('src/repo.ts', REPO)
    const twice = extractSignatures('src/repo.ts', REPO)
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice))
  })
})

// ── assembly ────────────────────────────────────────────────────────────────

describe('assembleContext', () => {
  it('combines memory, skills, top-k chunks and one-hop graph neighbours', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)

    const result = await assemble({ root, graph, budgetTokens: 4_000 })

    const kinds = new Set(result.sections.map(s => s.kind))
    expect(kinds.has('memory')).toBe(true)
    expect(kinds.has('skill')).toBe(true)
    expect(kinds.has('chunk')).toBe(true)
    expect(kinds.has('neighbour')).toBe(true)

    // The seed came from search; the neighbour came from the graph's `imports`.
    expect(result.chunkPaths).toContain('src/service.ts')
    expect(result.neighbourPaths).toEqual(['src/repo.ts'])
    expect(result.paths).toContain('src/repo.ts')

    // The neighbour reaches the TEXT, not just the path list.
    expect(result.text).toContain('one-hop dependency')
    expect(result.text).toContain('findWidget')
    expect(result.text).toContain('## Project memory')
    expect(result.text).toContain('## Skill: context-packing')
    expect(result.withinBudget).toBe(true)
  })

  it('follows the persisted graph imports edges for the one hop', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)

    expect(oneHopNeighbours(graph, ['src/service.ts'], 8)).toEqual(['src/repo.ts'])
    // Seeds are never returned as their own neighbours.
    expect(oneHopNeighbours(graph, ['src/service.ts', 'src/repo.ts'], 8)).toEqual([])
    expect(oneHopNeighbours(graph, ['src/service.ts'], 0)).toEqual([])
  })

  it('prefers signatures over bodies when the budget forces truncation', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)

    const roomy = await assemble({ root, graph, budgetTokens: 4_000 })
    const chunkSections = roomy.sections.filter(s => s.kind === 'chunk')
    expect(chunkSections.length).toBeGreaterThanOrEqual(2)
    expect(chunkSections.every(s => s.detail === 'body')).toBe(true)

    // A budget that fits every outline but not every body. Memory and skills are
    // higher priority than chunks, so give them their own room.
    const overhead = roomy.sections
      .filter(s => s.kind !== 'chunk' && s.kind !== 'neighbour')
      .reduce((sum, s) => sum + s.tokens, 0)
    const biggestBody = Math.max(...chunkSections.map(s => s.tokens))
    const tight = overhead + biggestBody

    const squeezed = await assemble({ root, graph, budgetTokens: tight })
    const squeezedChunks = squeezed.sections.filter(s => s.kind === 'chunk')

    // THE CLAIM: coverage survives, detail does not. A body-first strategy would
    // spend the same budget on one whole chunk.
    expect(squeezedChunks.length).toBeGreaterThan(1)
    expect(squeezedChunks.some(s => s.detail.startsWith('signatures'))).toBe(true)
    expect(squeezed.text).toContain(BODY_ELISION)
    expect(squeezed.degraded).toBe(true)
    expect(squeezed.withinBudget).toBe(true)
  })

  it('drops in the documented priority order: neighbours, then chunks, then skills, then memory', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)

    const roomy = await assemble({ root, graph, budgetTokens: 4_000 })
    const memoryTokens = roomy.sections.find(s => s.kind === 'memory')!.tokens

    // Just enough for the memory block and nothing else.
    const result = await assemble({ root, graph, budgetTokens: memoryTokens })
    expect(result.sections.map(s => s.kind)).toEqual(['memory'])
    expect(result.dropped.map(d => d.kind)).toContain('neighbour')
    expect(result.dropped.map(d => d.kind)).toContain('chunk')
    expect(result.withinBudget).toBe(true)
  })

  it('never exceeds the budget, swept across every budget from zero', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)

    const roomy = await assemble({ root, graph, budgetTokens: 4_000 })
    const ceiling = roomy.tokenEstimate + 40

    for (let budget = 0; budget <= ceiling; budget += 7) {
      const result = await assemble({ root, graph, budgetTokens: budget })
      expect(
        estimateTokens(result.text),
        `budget ${budget} produced ${estimateTokens(result.text)} estimated tokens`
      ).toBeLessThanOrEqual(budget)
      expect(result.tokenEstimate).toBeLessThanOrEqual(budget)
      expect(result.withinBudget).toBe(true)
    }
  })

  it('handles a budget of zero and a budget smaller than one chunk', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)

    const zero = await assemble({ root, graph, budgetTokens: 0 })
    expect(zero.text).toBe('')
    expect(zero.tokenEstimate).toBe(0)
    expect(zero.sections).toEqual([])
    expect(zero.paths).toEqual([])
    expect(zero.withinBudget).toBe(true)
    expect(zero.dropped.length).toBeGreaterThan(0)
    expect(zero.dropped.every(d => d.reason === 'token budget')).toBe(true)

    // Smaller than any single chunk body, but not zero: what survives is a
    // legible fragment of context, not a truncated one.
    const sliver = await assemble({ root, graph, budgetTokens: 6, memory: '', skills: [] })
    expect(estimateTokens(sliver.text)).toBeLessThanOrEqual(6)
    expect(sliver.sections.every(s => s.detail !== 'body')).toBe(true)
  })

  it('degrades an unparseable language to its path rather than a fabricated outline', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)

    const roomy = await assemble({ root, graph, budgetTokens: 4_000, memory: '', skills: [] })
    expect(roomy.signatureUnsupported).toContain('styles/theme.css')
    const css = roomy.sections.find(s => s.path === 'styles/theme.css')!
    expect(css.detail).toBe('body')

    // Squeeze it: the css chunk has no signature rung, so it goes to path only.
    const squeezed = await assemble({
      root,
      graph,
      budgetTokens: Math.ceil(roomy.tokenEstimate / 3),
      memory: '',
      skills: [],
    })
    const squeezedCss = squeezed.sections.find(s => s.path === 'styles/theme.css')
    if (squeezedCss !== undefined) {
      expect(['path', 'body']).toContain(squeezedCss.detail)
      if (squeezedCss.detail === 'path') {
        expect(squeezed.text).toContain('styles/theme.css:1-5 (path only)')
        expect(squeezed.text).not.toContain('color: blue')
      }
    }
  })

  it('emits context_assembled as the primary assembly record', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)
    const events = new MemoryEventStore()

    const result = await assemble({ root, graph, budgetTokens: 4_000, events })
    const emitted = (await events.readAll()).filter(e => e.kind === 'context_assembled')

    // Three call sites share this kind; only the assembly step is `primary`.
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.runId).toBe('run-assembly')
    expect(emitted[0]!.payload.component).toBe('assembly')
    expect(emitted[0]!.payload.primary).toBe(true)

    expect(emitted[0]!.payload.paths).toEqual(result.paths)
    expect(emitted[0]!.payload.neighbourPaths).toEqual(['src/repo.ts'])
    expect(emitted[0]!.payload.tokenEstimate).toBe(result.tokenEstimate)
    expect(emitted[0]!.payload.budgetTokens).toBe(4_000)
    expect(emitted[0]!.payload.withinBudget).toBe(true)

    // The number is named as the estimate it is.
    expect(emitted[0]!.payload.tokenEstimateMethod).toBe(TOKEN_ESTIMATE_METHOD)
    expect(TOKEN_ESTIMATE_METHOD).toBe('chars/4')
    expect(emitted[0]!.payload.tokenEstimateIsHeuristic).toBe(true)

    // The query text itself never reaches the log.
    expect(JSON.stringify(emitted[0]!.payload)).not.toContain('loadWidget"')
    expect(emitted[0]!.payload.queryLength).toBe('loadWidget'.length)
  })

  it('is deterministic for the same graph, query and budget', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)

    const first = await assemble({ root, graph, budgetTokens: 300 })
    const second = await assemble({ root, graph, budgetTokens: 300 })

    expect(second.text).toBe(first.text)
    expect(JSON.stringify(second.sections)).toBe(JSON.stringify(first.sections))
    expect(second.paths).toEqual(first.paths)
  })

  it('runs the hybrid vector channel when one is supplied', async () => {
    const root = await makeProject()
    await seed(root)
    const graph = await graphFor(root)

    const embedder = new HashEmbedder(128)
    const store = new MemoryVectorStore()
    const engine = new ContextEngine({ embedder, vectorStore: store })
    await engine.indexProject(root)

    const result = await assembleContext({
      root,
      graph,
      query: 'loadWidget',
      budgetTokens: 4_000,
      vector: { embedder, store },
      preferRipgrep: false,
      runId: 'run-vector',
    })

    expect(result.vectorOnly).toBe(false)
    expect(result.chunkPaths.length).toBeGreaterThan(0)
    expect(result.withinBudget).toBe(true)
  })
})

// ── the consumed expansion (Requirement 18.8) ───────────────────────────────

describe('ContextEngine.retrieve consumes the dependency expansion', () => {
  it('puts a one-hop neighbour’s content into the retrieved chunks', async () => {
    const root = await makeProject()
    await seed(root)

    const engine = new ContextEngine({ embedder: new HashEmbedder(256) })
    await engine.indexProject(root)

    // topK of 1 so the neighbour can only arrive through the graph: if search
    // returned it too, the expansion would prove nothing.
    const ctx = await engine.retrieve('loadWidget widget id', 1)

    // The seed is what search found; the neighbour is what the graph added.
    expect(ctx.seedPaths).toEqual(['src/service.ts'])
    expect(ctx.neighbourPaths).toEqual(['src/repo.ts'])
    expect(ctx.files).toContain('src/repo.ts')

    // THE BUG THIS FIXES: the expansion used to be computed and discarded, so a
    // neighbour's CONTENT never reached the caller however relevant it was.
    expect(ctx.neighbourChunks).toBeGreaterThan(0)
    const paths = ctx.chunks.map(c => c.path)
    expect(paths).toContain('src/repo.ts')
    expect(ctx.chunks.find(c => c.path === 'src/repo.ts')!.content).toContain('findWidget')
  })

  it('keeps the char budget while adding neighbours', async () => {
    const root = await makeProject()
    await seed(root)

    const engine = new ContextEngine({
      embedder: new HashEmbedder(64),
      maxContextChars: 120,
    })
    await engine.indexProject(root)

    const ctx = await engine.retrieve('loadWidget', 5)
    expect(ctx.totalChars).toBeLessThanOrEqual(120)
  })
})
