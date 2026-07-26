// Tests for the context engine

import { describe, it, expect } from 'vitest'
import { chunkFile } from '../src/context/chunker.js'
import {
  buildDependencyGraph,
  expandWithDependencies,
} from '../src/context/dependency-graph.js'
import {
  HashEmbedder,
  cosineSimilarity,
  l2normalise,
} from '../src/context/embedder.js'
import { MemoryVectorStore } from '../src/context/vector-store.js'
import { ContextEngine } from '../src/context/context-engine.js'
import type { EmbeddedChunk } from '../src/context/types.js'

// ── chunker ───────────────────────────────────────────────────────────────

describe('chunkFile', () => {
  it('returns one chunk for short content', () => {
    const chunks = chunkFile('a.ts', 'const x = 1')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].id).toBe('a.ts#0')
    expect(chunks[0].content).toBe('const x = 1')
  })

  it('splits long content into multiple chunks', () => {
    const content = 'x'.repeat(5000)
    const chunks = chunkFile('big.ts', content, { maxChunkSize: 2000, overlap: 200 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].index).toBe(0)
    expect(chunks[1].index).toBe(1)
  })

  it('overlapping chunks share content', () => {
    const content = 'abcdefghij'.repeat(300) // 3000 chars
    const chunks = chunkFile('f.ts', content, { maxChunkSize: 1000, overlap: 200 })
    // chunk 0 ends at 1000, chunk 1 starts at 800 → overlap region shared
    const tail = chunks[0].content.slice(-200)
    const head = chunks[1].content.slice(0, 200)
    expect(tail).toBe(head)
  })

  it('handles empty files', () => {
    const chunks = chunkFile('empty.ts', '')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe('')
  })

  it('tracks line numbers', () => {
    const content = 'line1\nline2\nline3'
    const chunks = chunkFile('lines.ts', content)
    expect(chunks[0].startLine).toBe(0)
    expect(chunks[0].endLine).toBe(2)
  })
})

// ── dependency graph ────────────────────────────────────────────────────────

describe('buildDependencyGraph', () => {
  it('resolves relative TS imports', () => {
    const files = [
      { relativePath: 'src/a.ts', content: `import { b } from './b'` },
      { relativePath: 'src/b.ts', content: `export const b = 1` },
    ]
    const graph = buildDependencyGraph(files)
    expect(graph.edges.get('src/a.ts')?.has('src/b.ts')).toBe(true)
  })

  it('ignores external package imports', () => {
    const files = [
      { relativePath: 'src/a.ts', content: `import react from 'react'` },
    ]
    const graph = buildDependencyGraph(files)
    expect(graph.edges.get('src/a.ts')?.size).toBe(0)
  })

  it('resolves index files', () => {
    const files = [
      { relativePath: 'src/a.ts', content: `import { x } from './utils'` },
      { relativePath: 'src/utils/index.ts', content: `export const x = 1` },
    ]
    const graph = buildDependencyGraph(files)
    expect(graph.edges.get('src/a.ts')?.has('src/utils/index.ts')).toBe(true)
  })

  it('resolves Python imports', () => {
    const files = [
      { relativePath: 'app.py', content: `from .helper import thing` },
      { relativePath: 'helper.py', content: `thing = 1` },
    ]
    const graph = buildDependencyGraph(files)
    expect(graph.edges.get('app.py')?.has('helper.py')).toBe(true)
  })
})

describe('expandWithDependencies', () => {
  it('includes direct dependencies of seeds', () => {
    const files = [
      { relativePath: 'a.ts', content: `import './b'` },
      { relativePath: 'b.ts', content: `import './c'` },
      { relativePath: 'c.ts', content: `` },
    ]
    const graph = buildDependencyGraph(files)
    const expanded = expandWithDependencies(graph, ['a.ts'], 1)
    expect(expanded).toContain('a.ts')
    expect(expanded).toContain('b.ts')
    expect(expanded).not.toContain('c.ts') // depth 1 only
  })

  it('follows deps to given depth', () => {
    const files = [
      { relativePath: 'a.ts', content: `import './b'` },
      { relativePath: 'b.ts', content: `import './c'` },
      { relativePath: 'c.ts', content: `` },
    ]
    const graph = buildDependencyGraph(files)
    const expanded = expandWithDependencies(graph, ['a.ts'], 2)
    expect(expanded).toContain('c.ts')
  })
})

// ── embedder ─────────────────────────────────────────────────────────────────

describe('HashEmbedder', () => {
  it('produces vectors of the configured dimension', async () => {
    const e = new HashEmbedder(128)
    const [v] = await e.embed(['hello world'])
    expect(v).toHaveLength(128)
  })

  it('is deterministic', async () => {
    const e = new HashEmbedder(64)
    const [a] = await e.embed(['same text'])
    const [b] = await e.embed(['same text'])
    expect(a).toEqual(b)
  })

  it('produces L2-normalised vectors', async () => {
    const e = new HashEmbedder(64)
    const [v] = await e.embed(['some tokens here for embedding'])
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })

  it('similar texts score higher than dissimilar', async () => {
    const e = new HashEmbedder(256)
    const [q] = await e.embed(['database connection pool config'])
    const [similar] = await e.embed(['database connection pool settings'])
    const [different] = await e.embed(['frontend button styling css'])
    expect(cosineSimilarity(q, similar)).toBeGreaterThan(cosineSimilarity(q, different))
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical normalised vectors', () => {
    const v = l2normalise([1, 2, 3])
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5)
  })

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
  })
})

// ── vector store ─────────────────────────────────────────────────────────────

describe('MemoryVectorStore', () => {
  const mkChunk = (id: string, path: string, embedding: number[]): EmbeddedChunk => ({
    id, path, index: 0, content: `content of ${id}`, startLine: 0, endLine: 1, embedding,
  })

  it('upserts and searches', async () => {
    const store = new MemoryVectorStore()
    await store.upsert([
      mkChunk('a#0', 'a.ts', l2normalise([1, 0, 0])),
      mkChunk('b#0', 'b.ts', l2normalise([0, 1, 0])),
    ])
    const results = await store.search(l2normalise([1, 0, 0]), 2)
    expect(results[0].chunk.id).toBe('a#0')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })

  it('respects topK', async () => {
    const store = new MemoryVectorStore()
    await store.upsert([
      mkChunk('a#0', 'a.ts', l2normalise([1, 0, 0])),
      mkChunk('b#0', 'b.ts', l2normalise([0, 1, 0])),
      mkChunk('c#0', 'c.ts', l2normalise([0, 0, 1])),
    ])
    const results = await store.search(l2normalise([1, 1, 1]), 2)
    expect(results).toHaveLength(2)
  })

  it('removes by path', async () => {
    const store = new MemoryVectorStore()
    await store.upsert([
      mkChunk('a#0', 'a.ts', l2normalise([1, 0, 0])),
      mkChunk('a#1', 'a.ts', l2normalise([1, 1, 0])),
      mkChunk('b#0', 'b.ts', l2normalise([0, 1, 0])),
    ])
    await store.removeByPath('a.ts')
    expect(await store.size()).toBe(1)
  })

  it('clears', async () => {
    const store = new MemoryVectorStore()
    await store.upsert([mkChunk('a#0', 'a.ts', l2normalise([1, 0, 0]))])
    await store.clear()
    expect(await store.size()).toBe(0)
  })
})

// ── ContextEngine (integration, in-memory) ──────────────────────────────────

describe('ContextEngine', () => {
  it('indexes file content and retrieves relevant chunks', async () => {
    const engine = new ContextEngine({ embedder: new HashEmbedder(256) })
    await engine.reindexFile('auth.ts', 'function login(user, password) { return authenticate(user, password) }', 'h1')
    await engine.reindexFile('styles.css', '.button { color: blue; padding: 10px; }', 'h2')

    const ctx = await engine.retrieve('user login authentication password', 5)
    expect(ctx.chunks.length).toBeGreaterThan(0)
    // The auth file should rank above the css file for this query
    expect(ctx.chunks[0].path).toBe('auth.ts')
  })

  it('reindexFile skips unchanged content (same hash)', async () => {
    const engine = new ContextEngine({ embedder: new HashEmbedder(64) })
    const changed1 = await engine.reindexFile('a.ts', 'content', 'hash1')
    const changed2 = await engine.reindexFile('a.ts', 'content', 'hash1')
    expect(changed1).toBe(true)
    expect(changed2).toBe(false)
  })

  it('reindexFile re-indexes when hash changes', async () => {
    const engine = new ContextEngine({ embedder: new HashEmbedder(64) })
    await engine.reindexFile('a.ts', 'old content', 'hash1')
    const changed = await engine.reindexFile('a.ts', 'new content', 'hash2')
    expect(changed).toBe(true)
  })

  it('removeFile clears the file from the index', async () => {
    const engine = new ContextEngine({ embedder: new HashEmbedder(64) })
    await engine.reindexFile('a.ts', 'content', 'hash1')
    await engine.removeFile('a.ts')
    const stats = await engine.stats()
    expect(stats.files).toBe(0)
  })

  it('respects the context char budget', async () => {
    const engine = new ContextEngine({
      embedder: new HashEmbedder(64),
      maxContextChars: 50,
    })
    await engine.reindexFile('a.ts', 'x'.repeat(100), 'h1')
    await engine.reindexFile('b.ts', 'y'.repeat(100), 'h2')
    const ctx = await engine.retrieve('x', 10)
    expect(ctx.totalChars).toBeLessThanOrEqual(50)
  })
})
