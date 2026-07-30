// ContextEngine — orchestrates indexing and retrieval.
// Ties together: walker → chunker → dependency graph → embedder → vector store.

import { readFile } from 'node:fs/promises'
import { walkProject, type WalkedFile } from './walker.js'
import { chunkFile } from './chunker.js'
import { buildDependencyGraph, expandWithDependencies, type DependencyGraph } from './dependency-graph.js'
import { MemoryVectorStore } from './vector-store.js'
import type { Embedder, VectorStore, EmbeddedChunk, Chunk } from './types.js'

export interface RetrievedContext {
  files: string[]           // relative paths: seeds plus one-hop dependencies
  chunks: Chunk[]           // the actual relevant chunks, seeds then neighbours
  totalChars: number
  /** Paths the search itself returned. */
  seedPaths: string[]
  /** Paths reached by one hop along the dependency edges. */
  neighbourPaths: string[]
  /** Chunks in `chunks` that came from a neighbour rather than the search. */
  neighbourChunks: number
}

export interface ContextEngineOptions {
  embedder: Embedder
  vectorStore?: VectorStore
  maxContextChars?: number  // budget for retrieved context, default 40000
}

export class ContextEngine {
  private embedder: Embedder
  private store: VectorStore
  private graph: DependencyGraph = { edges: new Map() }
  private hashes = new Map<string, string>()  // relativePath -> content hash
  // Chunk content by path. The vector store searches by similarity; a one-hop
  // neighbour is selected by GRAPH position, so its chunks have to be reachable
  // without a query vector.
  private chunksByPath = new Map<string, Chunk[]>()
  private maxContextChars: number

  constructor(opts: ContextEngineOptions) {
    this.embedder = opts.embedder
    this.store = opts.vectorStore ?? new MemoryVectorStore()
    this.maxContextChars = opts.maxContextChars ?? 40000
  }

  // Full index of a project directory.
  async indexProject(root: string): Promise<{ filesIndexed: number; chunksIndexed: number }> {
    const files = await walkProject(root)
    const withContent = await this.loadContents(files)

    this.graph = buildDependencyGraph(
      withContent.map(f => ({ relativePath: f.relativePath, content: f.content }))
    )

    let chunkCount = 0
    for (const file of withContent) {
      await this.indexFileContent(file.relativePath, file.content, file.hash)
      chunkCount += this.chunkCountFor(file.content)
    }

    return { filesIndexed: withContent.length, chunksIndexed: chunkCount }
  }

  // Incremental: re-index a single file if its hash changed.
  async reindexFile(relativePath: string, content: string, hash: string): Promise<boolean> {
    if (this.hashes.get(relativePath) === hash) return false
    await this.store.removeByPath(relativePath)
    await this.indexFileContent(relativePath, content, hash)
    return true
  }

  async removeFile(relativePath: string): Promise<void> {
    await this.store.removeByPath(relativePath)
    this.hashes.delete(relativePath)
    this.chunksByPath.delete(relativePath)
    this.graph.edges.delete(relativePath)
  }

  /**
   * Retrieve relevant context for a task description.
   *
   * The one-hop expansion is CONSUMED here, not just reported. It used to be
   * computed and then have no effect on the returned chunks, so a dependency's
   * content never reached the model however useful it was (Requirement 18.8).
   * Now the neighbours' chunks are appended after the search hits, under the
   * same character budget: relevance first, dependencies with whatever budget is
   * left.
   */
  async retrieve(task: string, topK = 12): Promise<RetrievedContext> {
    const [queryVec] = await this.embedder.embed([task])
    const results = await this.store.search(queryVec, topK)

    // Expand seed files with their direct dependencies for better context.
    const seedPaths = [...new Set(results.map(r => r.chunk.path))]
    const expandedPaths = expandWithDependencies(this.graph, seedPaths, 1)
    const seen = new Set(seedPaths)
    // Sorted so the same index and query select the same neighbours every time.
    const neighbourPaths = expandedPaths.filter(p => !seen.has(p)).sort()

    // Rank: chunks from search first, trimmed to the char budget.
    const chunks: Chunk[] = []
    let totalChars = 0
    for (const r of results) {
      if (totalChars + r.chunk.content.length > this.maxContextChars) break
      chunks.push(r.chunk)
      totalChars += r.chunk.content.length
    }

    // Then the one-hop neighbours, in path order, with what budget remains.
    let neighbourChunks = 0
    for (const path of neighbourPaths) {
      for (const chunk of this.chunksByPath.get(path) ?? []) {
        if (totalChars + chunk.content.length > this.maxContextChars) break
        chunks.push(chunk)
        totalChars += chunk.content.length
        neighbourChunks++
      }
    }

    return {
      files: expandedPaths,
      chunks,
      totalChars,
      seedPaths,
      neighbourPaths,
      neighbourChunks,
    }
  }

  async stats(): Promise<{ chunks: number; files: number }> {
    return { chunks: await this.store.size(), files: this.hashes.size }
  }

  private async indexFileContent(relativePath: string, content: string, hash: string): Promise<void> {
    const rawChunks = chunkFile(relativePath, content)
    const embeddings = await this.embedder.embed(rawChunks.map(c => c.content))
    const embedded: EmbeddedChunk[] = rawChunks.map((c, i) => ({
      ...c,
      embedding: embeddings[i],
    }))
    await this.store.upsert(embedded)
    this.hashes.set(relativePath, hash)
    this.chunksByPath.set(
      relativePath,
      rawChunks.map(c => ({
        id: c.id,
        path: c.path,
        index: c.index,
        content: c.content,
        startLine: c.startLine,
        endLine: c.endLine,
      }))
    )
  }

  private chunkCountFor(content: string): number {
    return chunkFile('x', content).length
  }

  private async loadContents(files: WalkedFile[]): Promise<Array<WalkedFile & { content: string }>> {
    const out: Array<WalkedFile & { content: string }> = []
    await Promise.all(files.map(async f => {
      try {
        const content = await readFile(f.path, 'utf8')
        out.push({ ...f, content })
      } catch { /* skip unreadable */ }
    }))
    return out
  }
}
