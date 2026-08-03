// Persisted repository graph tests.
//
// Uses REAL: temp project directories with real files, the real walker, the real
// chunker, the real import extractor, and real bytes at
// `<project>/.sketch/index/graph.json`. A real MemoryEventStore for the emit.
// Nothing is mocked.
//
// The incremental claim is asserted on WORK PERFORMED, not on output equality:
// `RepoGraphStats.chunked`, `.parsed` and `.contentReads` are incremented at
// their call sites, so a rebuild that quietly re-chunks the world fails these
// tests even though its graph would be identical.
//
// Validates: Requirements 18.1

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildRepoGraph,
  loadRepoGraph,
  graphPath,
  GRAPH_VERSION,
  type RepoGraph,
} from '../src/context/repo-graph.js'
import { MemoryEventStore } from '../src/events/index.js'

const tmpDirs: string[] = []

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-graph-'))
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

/** A small real project: three linked TypeScript files and a doc. */
async function seed(root: string): Promise<void> {
  await write(root, 'src/app.ts', `import { helper } from './helper.js'\nexport const app = helper\n`)
  await write(root, 'src/helper.ts', `import { util } from './util.js'\nexport const helper = util\n`)
  await write(root, 'src/util.ts', `export const util = 1\n`)
  await write(root, 'README.md', `# project\n`)
}

function fileOf(graph: RepoGraph, path: string) {
  return graph.files.find(f => f.path === path)
}

describe('buildRepoGraph', () => {
  it('builds from the walker, chunker and import extractor and persists to .sketch/index/graph.json', async () => {
    const root = await makeProject()
    await seed(root)

    const { graph, stats, path } = await buildRepoGraph({ root })

    expect(path).toBe(graphPath(root))
    expect(graph.version).toBe(GRAPH_VERSION)
    expect(graph.files.map(f => f.path)).toEqual([
      'README.md',
      'src/app.ts',
      'src/helper.ts',
      'src/util.ts',
    ])
    expect(graph.fileCount).toBe(4)
    expect(graph.chunkCount).toBeGreaterThanOrEqual(4)

    // Edges come from the real extractor and resolve within the project.
    expect(fileOf(graph, 'src/app.ts')!.imports).toEqual(['src/helper.ts'])
    expect(fileOf(graph, 'src/helper.ts')!.imports).toEqual(['src/util.ts'])
    expect(fileOf(graph, 'src/util.ts')!.imports).toEqual([])

    // Chunks come from the real chunker.
    const app = fileOf(graph, 'src/app.ts')!
    expect(app.chunks).toHaveLength(1)
    expect(app.chunks[0]!.index).toBe(0)
    expect(app.hash).toMatch(/^[0-9a-f]{16}$/)

    // First build does the work for every file.
    expect(stats.added).toBe(4)
    expect(stats.reused).toBe(0)
    expect(stats.chunked).toBe(4)
    expect(stats.parsed).toBe(4)

    // Real bytes on disk, reloadable.
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as RepoGraph
    expect(onDisk).toEqual(graph)
    expect(await loadRepoGraph(root)).toEqual(graph)
  })

  it('writes byte-identical bytes for an unchanged tree', async () => {
    const root = await makeProject()
    await seed(root)

    await buildRepoGraph({ root })
    const first = await readFile(graphPath(root), 'utf8')

    // Rebuild incrementally, and rebuild from scratch: both must produce the
    // same bytes, or the diff of the index is noise.
    await buildRepoGraph({ root })
    const second = await readFile(graphPath(root), 'utf8')
    await buildRepoGraph({ root, previous: null })
    const third = await readFile(graphPath(root), 'utf8')

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(first).not.toContain(root) // no absolute path, so the graph travels
    expect(first.endsWith('\n')).toBe(true)
  })

  it('re-chunks and re-parses only the files whose hash changed', async () => {
    const root = await makeProject()
    await seed(root)
    const before = await buildRepoGraph({ root })
    const hashBefore = fileOf(before.graph, 'src/util.ts')!.hash

    // Rewrite one file with different content; touch nothing else.
    await write(root, 'src/util.ts', `export const util = 2\nexport const extra = 3\n`)

    const { stats, graph } = await buildRepoGraph({ root })

    expect(stats.walked).toBe(4)
    expect(stats.changed).toBe(1)
    expect(stats.added).toBe(0)
    expect(stats.reused).toBe(3)
    // The evidence: exactly one chunk pass, one parse, one content read.
    expect(stats.chunked).toBe(1)
    expect(stats.parsed).toBe(1)
    expect(stats.contentReads).toBe(1)

    // And the changed file's new content really is reflected.
    expect(fileOf(graph, 'src/util.ts')!.hash).not.toBe(hashBefore)
    expect(fileOf(graph, 'src/util.ts')!.size).toBe(
      `export const util = 2\nexport const extra = 3\n`.length
    )
  })

  it('does no chunking or parsing at all when nothing changed', async () => {
    const root = await makeProject()
    await seed(root)
    await buildRepoGraph({ root })

    const { stats } = await buildRepoGraph({ root })

    expect(stats.reused).toBe(4)
    expect(stats.chunked).toBe(0)
    expect(stats.parsed).toBe(0)
    expect(stats.contentReads).toBe(0)
  })

  it('chunks and parses only the new file when one is added', async () => {
    const root = await makeProject()
    await seed(root)
    await buildRepoGraph({ root })

    await write(root, 'src/extra.ts', `import { util } from './util.js'\nexport const extra = util\n`)
    const { stats, graph } = await buildRepoGraph({ root })

    expect(stats.added).toBe(1)
    expect(stats.reused).toBe(4)
    expect(stats.chunked).toBe(1)
    expect(stats.parsed).toBe(1)
    expect(fileOf(graph, 'src/extra.ts')!.imports).toEqual(['src/util.ts'])
  })

  it('drops a deleted file and its inbound edges without re-parsing survivors', async () => {
    const root = await makeProject()
    await seed(root)
    await buildRepoGraph({ root })

    await rm(join(root, 'src', 'util.ts'))
    const { graph, stats } = await buildRepoGraph({ root })

    expect(stats.removed).toBe(1)
    expect(stats.reused).toBe(3)
    // A dead path must not survive in the index, or search returns it forever.
    expect(fileOf(graph, 'src/util.ts')).toBeUndefined()
    expect(graph.fileCount).toBe(3)
    // The inbound edge goes too — imports are re-resolved from cached
    // specifiers, which costs no parse.
    expect(fileOf(graph, 'src/helper.ts')!.imports).toEqual([])
    expect(fileOf(graph, 'src/helper.ts')!.specifiers).toEqual(['./util.js'])
    expect(stats.parsed).toBe(0)
  })

  it('resolves a previously dangling import when its target appears, without re-parsing', async () => {
    const root = await makeProject()
    await write(root, 'src/app.ts', `import { late } from './late.js'\nexport const app = late\n`)
    const first = await buildRepoGraph({ root })
    expect(fileOf(first.graph, 'src/app.ts')!.imports).toEqual([])

    await write(root, 'src/late.ts', `export const late = 1\n`)
    const second = await buildRepoGraph({ root })

    expect(fileOf(second.graph, 'src/app.ts')!.imports).toEqual(['src/late.ts'])
    // `src/app.ts` was not re-read or re-parsed: only the new file was.
    expect(second.stats.parsed).toBe(1)
    expect(second.stats.reused).toBe(1)
  })

  it('rebuilds from scratch when the persisted graph is corrupt or from another version', async () => {
    const root = await makeProject()
    await seed(root)
    await buildRepoGraph({ root })

    await writeFile(graphPath(root), '{ not json', 'utf8')
    expect(await loadRepoGraph(root)).toBeNull()
    const corrupt = await buildRepoGraph({ root })
    expect(corrupt.stats.added).toBe(4)
    expect(corrupt.stats.chunked).toBe(4)

    await writeFile(
      graphPath(root),
      JSON.stringify({ version: GRAPH_VERSION + 1, files: [] }),
      'utf8'
    )
    expect(await loadRepoGraph(root)).toBeNull()
    const stale = await buildRepoGraph({ root })
    expect(stale.stats.added).toBe(4)
  })

  it('degrades to the stated file cap instead of indexing everything', async () => {
    const root = await makeProject()
    for (let i = 0; i < 10; i++) {
      await write(root, `src/f${String(i).padStart(2, '0')}.ts`, `export const f${i} = ${i}\n`)
    }

    const { graph } = await buildRepoGraph({ root, maxFiles: 4 })
    expect(graph.fileCount).toBe(4)
    expect(graph.truncated).toBe(true)
    expect(graph.maxFiles).toBe(4)

    const persisted = (await loadRepoGraph(root))!
    expect(persisted.truncated).toBe(true)
    expect(persisted.maxFiles).toBe(4)
  })

  it('never indexes its own state directory', async () => {
    const root = await makeProject()
    await seed(root)

    await buildRepoGraph({ root })
    const { graph } = await buildRepoGraph({ root })

    expect(graph.files.some(f => f.path.startsWith('.sketch'))).toBe(false)
    // `.sketch/` carries its self-ignore marker, so the index never dirties git status.
    expect(await readFile(join(root, '.sketch', '.gitignore'), 'utf8')).toContain('*')
  })

  it('reports the build on the event log under its own kind', async () => {
    const root = await makeProject()
    await seed(root)
    const events = new MemoryEventStore()

    await buildRepoGraph({ root, events, runId: 'run-1' })
    const emitted = await events.readAll()

    expect(emitted).toHaveLength(1)
    // Indexing has its own kind since the `EventKind` amendment. It used to be
    // `context_loaded` plus `component: 'repo-graph'`, which a consumer had to
    // read the payload to identify.
    expect(emitted[0]!.kind).toBe('repo_indexed')
    expect(emitted[0]!.runId).toBe('run-1')
    // And the discriminator is GONE, not merely redundant: leaving it would keep
    // a consumer's payload check alive and working, so nobody would migrate.
    expect(emitted[0]!.payload.component).toBeUndefined()
    expect(emitted[0]!.payload.files).toBe(4)
    expect(emitted[0]!.payload.added).toBe(4)
  })

  it('can build without persisting', async () => {
    const root = await makeProject()
    await seed(root)

    const { graph } = await buildRepoGraph({ root, persist: false })
    expect(graph.fileCount).toBe(4)
    expect(await loadRepoGraph(root)).toBeNull()
  })
})
