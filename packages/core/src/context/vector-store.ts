// In-memory vector store with cosine-similarity search.
// This is the default, zero-dependency store. A sqlite-vec backed store can be
// dropped in later behind the same VectorStore interface (see types.ts) for
// persistence across sessions on large repos.

import type { VectorStore, EmbeddedChunk, SearchResult } from './types.js'
import { cosineSimilarity } from './embedder.js'

export class MemoryVectorStore implements VectorStore {
  private chunks = new Map<string, EmbeddedChunk>()

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    for (const c of chunks) this.chunks.set(c.id, c)
  }

  async search(query: number[], topK: number): Promise<SearchResult[]> {
    const scored: SearchResult[] = []
    for (const chunk of this.chunks.values()) {
      const score = cosineSimilarity(query, chunk.embedding)
      scored.push({
        chunk: {
          id: chunk.id,
          path: chunk.path,
          index: chunk.index,
          content: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        },
        score,
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  async removeByPath(path: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.path === path) this.chunks.delete(id)
    }
  }

  async clear(): Promise<void> {
    this.chunks.clear()
  }

  async size(): Promise<number> {
    return this.chunks.size
  }
}
