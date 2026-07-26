// Embedders turn text into vectors.
// - ProviderEmbedder calls an OpenAI-compatible /embeddings endpoint.
// - HashEmbedder is a deterministic, dependency-free fallback for offline use and tests.
//   It is NOT semantically meaningful; it exists so the pipeline works with zero setup.

import type { Embedder } from './types.js'

export class ProviderEmbedder implements Embedder {
  readonly dimensions: number

  constructor(
    private opts: {
      baseUrl: string
      apiKey: string
      model: string
      dimensions: number
    }
  ) {
    this.dimensions = opts.dimensions
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const res = await fetch(`${this.opts.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({ model: this.opts.model, input: texts }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Embedding request failed: HTTP ${res.status} ${body}`)
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> }
    return data.data.map(d => d.embedding)
  }
}

// Deterministic hashing embedder. Maps token hashes into a fixed-size vector
// and L2-normalises. Good enough to make the pipeline runnable offline and
// to unit-test vector storage/search without a network call.
export class HashEmbedder implements Embedder {
  constructor(public readonly dimensions = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.embedOne(t))
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0)
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
    for (const token of tokens) {
      const h = this.hash(token)
      const idx = h % this.dimensions
      const sign = (h & 1) === 0 ? 1 : -1
      vec[idx] += sign
    }
    return l2normalise(vec)
  }

  private hash(str: string): number {
    let h = 2166136261
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }
}

export function l2normalise(vec: number[]): number[] {
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum)
  if (norm === 0) return vec
  return vec.map(v => v / norm)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // vectors are pre-normalised, so dot product == cosine similarity
}
