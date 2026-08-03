// The text-search surface over the ONE lexical channel.
//
// ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
//
// There were two lexical search implementations in this repository: this package's
// lexical channel (retrieval), and the desktop Search panel's own `git grep` +
// folder-walk engine with its own regex matcher. Two engines, two match dialects, so
// the same query over the same file could highlight one thing in the panel and score
// another in retrieval. The panel's engine is deleted; `projectSearch` is what it
// calls now, through the `project-search` RPC method.
//
// The load-bearing test is `agrees with the retrieval channel, hit for hit`: the same
// query over the same fixture, through BOTH entry points — `lexicalSearch` as the
// retrieval stack calls it, and `METHODS['project-search']` as the panel calls it —
// must produce the same files, the same lines and the same offsets. Break the shared
// dialect (`matchSpans`) and that test fails alongside the panel's own.
//
// Uses REAL: temp projects with real files, the real walker/chunker, the real `rg`
// when this machine has one AND the forced scanner so both engines are covered
// everywhere, and the real method table the sidecar dispatches. Nothing is mocked.
//
// Validates: Requirements 18.2, 27.4, 27.5

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  containedProjectPath,
  detectRipgrep,
  lexicalSearch,
  matchSpans,
  clipLine,
  projectSearch,
  resetRipgrepDetection,
  PREVIEW_CHARS,
  type ProjectSearchResult,
} from '../src/context/index.js'
import { buildRepoGraph, graphPath } from '../src/context/repo-graph.js'
import { METHODS, type MethodContext } from '../src/rpc/methods.js'

const tmpDirs: string[] = []

/** A binary name that cannot exist, to force the scanner deterministically. */
const MISSING_BINARY = 'sketch-no-such-ripgrep-binary'

beforeEach(() => {
  resetRipgrepDetection()
})

afterEach(async () => {
  resetRipgrepDetection()
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeWorkspace(): Promise<{ root: string; outside: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-project-search-'))
  tmpDirs.push(dir)
  const root = join(dir, 'project')
  const outside = join(dir, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  return { root, outside }
}

async function write(base: string, relative: string, content: string): Promise<void> {
  const full = join(base, relative)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

/**
 * The fixture, byte-for-byte the one the desktop panel's test uses
 * (packages/desktop/src/panels/ide/SearchPanel.test.tsx). Same query over the same
 * bytes through both entry points is the claim; a shared fixture is what makes the
 * two assertions comparable.
 */
async function seed(root: string): Promise<void> {
  await write(
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
    ].join('\n')
  )
  await write(root, 'notes/note.md', 'mentions parse_retry_budget once\n')
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

/** `path:line` for every rendered hit, in the order a result list shows them. */
function rendered(result: ProjectSearchResult): string[] {
  return result.groups.flatMap(group => group.hits.map(hit => `${group.path}:${hit.line}`))
}

// ── the convergence itself ──────────────────────────────────────────────────

describe('one dialect, two entry points', () => {
  it('agrees with the retrieval channel, hit for hit', async () => {
    const { root } = await makeWorkspace()
    await seed(root)
    const { graph } = await buildRepoGraph({ root, persist: false })
    const query = 'parse_retry_budget'

    // ENTRY POINT 1: the retrieval stack's lexical channel, called exactly as
    // `hybridSearch` calls it.
    const retrieval = await lexicalSearch({ root, query, graph })

    // ENTRY POINT 2: the desktop Search panel, which reaches the engine through this
    // method and nothing else.
    const panel = (await METHODS['project-search']!(
      { root, query },
      methodContext(root)
    )) as ProjectSearchResult

    // Same engine, so a difference below cannot be blamed on ripgrep-versus-scanner.
    expect(panel.engine).toBe(retrieval.engine)
    expect(panel.terms).toEqual(retrieval.terms)

    // Same lines. The retrieval channel counts 0-based, the surface renders 1-based,
    // and that +1 is the ONLY difference permitted between them.
    const fromRetrieval = retrieval.hits
      .flatMap(hit => hit.matchedLines.map(line => `${hit.path}:${line.line + 1}`))
      .sort()
    expect([...rendered(panel)].sort()).toEqual([...new Set(fromRetrieval)].sort())

    // Same offsets. The panel highlights these spans; the ranking counted them.
    const spansFromRetrieval = new Map<string, string>()
    for (const hit of retrieval.hits) {
      for (const line of hit.matchedLines) {
        spansFromRetrieval.set(
          `${hit.path}:${line.line + 1}`,
          line.spans.map(s => `${s.start}+${s.length}${s.exact ? '!' : ''}`).join(',')
        )
      }
    }
    for (const group of panel.groups) {
      for (const hit of group.hits) {
        expect(
          hit.spans.map(s => `${s.start}+${s.length}${s.exact ? '!' : ''}`).join(','),
          `${group.path}:${hit.line}`
        ).toBe(spansFromRetrieval.get(`${group.path}:${hit.line}`))
      }
    }

    // And the spans are the identifier itself, not the line around it.
    const definition = panel.groups
      .find(group => group.path === 'src/retry.ts')!
      .hits.find(hit => hit.line === 3)!
    expect(definition.text).toBe('export function parse_retry_budget(raw: string): number {')
    expect(definition.spans).toHaveLength(1)
    expect(definition.text.slice(definition.spans[0]!.start, definition.spans[0]!.start + definition.spans[0]!.length))
      .toBe(query)
  })

  it('gives the same answer from ripgrep and from the fallback scanner', async () => {
    const { root } = await makeWorkspace()
    await seed(root)

    const fast = await projectSearch({ root, query: 'parse_retry_budget' })
    const slow = await projectSearch({ root, query: 'parse_retry_budget', preferRipgrep: false })

    const probe = await detectRipgrep({ cwd: root })
    expect(fast.engine).toBe(probe.available ? 'ripgrep' : 'scanner')
    expect(slow.engine).toBe('scanner')
    expect(rendered(slow)).toEqual(rendered(fast))
    expect(slow.hitCount).toBe(fast.hitCount)
  })
})

// ── the engine is named, never silently swapped ─────────────────────────────

describe('engine reporting', () => {
  it('names the scanner and why it ran', async () => {
    const { root } = await makeWorkspace()
    await seed(root)

    const result = await projectSearch({
      root,
      query: 'parse_retry_budget',
      binary: MISSING_BINARY,
    })

    expect(result.engine).toBe('scanner')
    expect(result.degraded).toBe(true)
    expect(result.reason).toContain(MISSING_BINARY)
    expect(result.reason).toContain('scanning the indexed file list')
    // Degraded, not broken.
    expect(rendered(result)).toContain('src/retry.ts:3')
  })

  it('separates an empty result from a capped one', async () => {
    const { root } = await makeWorkspace()
    await write(root, 'src/a.ts', 'const needle_one = needle\nconst needle_two = needle\n')

    const empty = await projectSearch({ root, query: 'no_such_token_anywhere' })
    expect(empty.hitCount).toBe(0)
    expect(empty.truncated).toBe(false)

    const capped = await projectSearch({ root, query: 'needle', maxHits: 1 })
    expect(capped.hitCount).toBe(1)
    expect(capped.truncated).toBe(true)
  })

  it('reports where the searched file list came from', async () => {
    const { root } = await makeWorkspace()
    await seed(root)

    // No index yet: the universe is walked, and searching writes NOTHING.
    const walked = await projectSearch({ root, query: 'parse_retry_budget' })
    expect(walked.universe).toBe('walk')
    expect(walked.fileCount).toBe(2)
    expect(existsSync(graphPath(root))).toBe(false)

    // Once an index exists it is reused rather than re-walked.
    await buildRepoGraph({ root })
    const indexed = await projectSearch({ root, query: 'parse_retry_budget' })
    expect(indexed.universe).toBe('graph')
    expect(rendered(indexed)).toEqual(rendered(walked))
  })
})

// ── containment ─────────────────────────────────────────────────────────────

describe('containment', () => {
  it('refuses a path that would leave the project', () => {
    const root = join(tmpdir(), 'sketch-contained-root')
    expect(containedProjectPath(root, 'src/app.ts')).toBe('src/app.ts')
    expect(containedProjectPath(root, join(root, 'src/app.ts'))).toBe('src/app.ts')

    // Every shape of escape, refused.
    expect(containedProjectPath(root, '../outside/secret.ts')).toBeNull()
    expect(containedProjectPath(root, 'src/../../outside/secret.ts')).toBeNull()
    expect(containedProjectPath(root, join(tmpdir(), 'elsewhere/secret.ts'))).toBeNull()
    expect(containedProjectPath(root, '')).toBeNull()
    expect(containedProjectPath(root, 'src/a\0.ts')).toBeNull()
    // The root itself is a directory, not a result.
    expect(containedProjectPath(root, '.')).toBeNull()
  })

  it('cannot reach a file outside the project, and a traversal query is data', async () => {
    const { root, outside } = await makeWorkspace()
    await seed(root)
    await writeFile(join(outside, 'secret.ts'), 'export const smuggled_secret = 1\n', 'utf8')

    for (const preferRipgrep of [true, false]) {
      // The text is on the disk one directory up. It is not in the walked universe.
      const hunt = await projectSearch({ root, query: 'smuggled_secret', preferRipgrep })
      expect(hunt.hitCount, `engine ${hunt.engine}`).toBe(0)
      expect(hunt.refused).toBe(0)

      // A query that spells a path searches for that TEXT. It does not read a file.
      const traversal = await projectSearch({ root, query: '../outside/secret.ts', preferRipgrep })
      expect(traversal.hitCount, `engine ${traversal.engine}`).toBe(0)
      expect(traversal.groups).toEqual([])
    }

    // And the file it was hunting for is still there, unread and unchanged.
    expect(await readFile(join(outside, 'secret.ts'), 'utf8')).toBe(
      'export const smuggled_secret = 1\n'
    )
  })

  it('requires a root on the wire rather than searching the server cwd', async () => {
    await expect(METHODS['project-search']!({ query: 'x' }, methodContext(process.cwd())))
      .rejects.toThrow(/params\.root/)
  })

  it('fails on an unreadable root instead of calling it no matches', async () => {
    // Coverage carried over from the deleted `runSearch.test.ts` ("reports a root
    // read failure rather than calling it no matches"). The walker swallows a
    // `readdir` failure, so without an explicit check this would return zero hits
    // and read as "that word is not in your project".
    const { root } = await makeWorkspace()
    await expect(projectSearch({ root: join(root, 'does-not-exist'), query: 'anything' }))
      .rejects.toThrow(/cannot search/)

    await write(root, 'src/a.ts', 'const needle = 1\n')
    await expect(projectSearch({ root: join(root, 'src/a.ts'), query: 'needle' }))
      .rejects.toThrow(/not a directory/)
  })
})

// ── the options a surface offers ────────────────────────────────────────────

describe('search options', () => {
  it('keeps smart case by default and honours an explicit match-case', async () => {
    const { root } = await makeWorkspace()
    await write(root, 'src/config.ts', 'export const RETRY_BUDGET_MS = 4500\n')
    await write(root, 'src/other.ts', 'export const budget = 1\n')

    // Smart case: a lower-case query is prose, so it finds the SCREAMING_CASE constant.
    const smart = await projectSearch({ root, query: 'budget' })
    expect(rendered(smart).sort()).toEqual(['src/config.ts:1', 'src/other.ts:1'])

    // Match case: exactly what was typed.
    const exact = await projectSearch({ root, query: 'budget', matchCase: true })
    expect(rendered(exact)).toEqual(['src/other.ts:1'])
  })

  it('drops substring occurrences for a whole-word search, using the same boundary rule', async () => {
    const { root } = await makeWorkspace()
    await write(root, 'src/exact.ts', 'const budget = 1\n')
    await write(root, 'src/substring.ts', 'const budgetish = 2\nconst xbudget = 3\n')

    for (const preferRipgrep of [true, false]) {
      const loose = await projectSearch({ root, query: 'budget', matchCase: true, preferRipgrep })
      expect(rendered(loose).sort()).toEqual([
        'src/exact.ts:1',
        'src/substring.ts:1',
        'src/substring.ts:2',
      ])

      const strict = await projectSearch({
        root,
        query: 'budget',
        matchCase: true,
        wholeWord: true,
        preferRipgrep,
      })
      expect(rendered(strict), `engine ${strict.engine}`).toEqual(['src/exact.ts:1'])
    }
  })

  it('reports the terms a prose query was reduced to', async () => {
    const { root } = await makeWorkspace()
    await seed(root)
    const result = await projectSearch({ root, query: 'where is the retry budget parsed?' })
    // The stopwords are gone, so a surface can explain a miss instead of showing none.
    expect(result.terms).toEqual(['retry', 'budget', 'parsed'])
    expect(rendered(result)).toContain('src/retry.ts:3')
  })
})

// ── the pieces the dialect is made of ───────────────────────────────────────

describe('the shared dialect', () => {
  it('reports every occurrence with its boundary verdict', () => {
    expect(matchSpans('const budget = budget + 1', 'budget')).toEqual([
      { start: 6, length: 6, exact: true },
      { start: 15, length: 6, exact: true },
    ])
    expect(matchSpans('retryBudgetMs', 'Budget')).toEqual([{ start: 5, length: 6, exact: false }])
    expect(matchSpans('anything', '')).toEqual([])
  })

  it('keeps a long line s match visible and moves its spans with it', () => {
    const line = `${'x'.repeat(1_000)}needle${'y'.repeat(1_000)}`
    const spans = matchSpans(line, 'needle')
    const clipped = clipLine(line, spans)

    expect(clipped.text.length).toBeLessThanOrEqual(PREVIEW_CHARS + 2)
    expect(clipped.spans).toHaveLength(1)
    const span = clipped.spans[0]!
    expect(clipped.text.slice(span.start, span.start + span.length)).toBe('needle')
  })
})
