// ContextEngine — orchestrates indexing and retrieval.
// Ties together: walker → chunker → dependency graph → embedder → vector store.

import { readFile } from 'node:fs/promises'
import { walkProject, type WalkedFile } from './walker.js'
import { chunkFile } from './chunker.js'
import { buildDependencyGraph, expandWithDependencies, type DependencyGraph } from './dependency-graph.js'
import { MemoryVectorStore } from './vector-store.js'
import type { Embedder, VectorStore, EmbeddedChunk, Chunk } from './types.js'

export interface RetrievedContext {
  files: string[]           // relative paths, ranked by relevance
  chunks: Chunk[]           // the actual relevant chunks
  totalChars: number
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
    this.graph.edges.delete(relativePath)
  }

  // Retrieve relevant context for a task description.
  async retrieve(task: string, topK = 12): Promise<RetrievedContext> {
    const [queryVec] = await this.embedder.embed([task])
    const results = await this.store.search(queryVec, topK)

    // Expand seed files with their direct dependencies for better context.
    const seedPaths = [...new Set(results.map(r => r.chunk.path))]
    const expandedPaths = expandWithDependencies(this.graph, seedPaths, 1)

    // Rank: chunks from search first, trimmed to the char budget.
    const chunks: Chunk[] = []
    let totalChars = 0
    for (const r of results) {
      if (totalChars + r.chunk.content.length > this.maxContextChars) break
      chunks.push(r.chunk)
      totalChars += r.chunk.content.length
    }

    return { files: expandedPaths, chunks, totalChars }
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
