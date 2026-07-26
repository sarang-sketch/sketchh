// Types for the context engine

export interface IndexedFile {
  path: string        // relative to project root
  size: number
  hash: string        // content hash for change detection
  imports: string[]   // resolved relative paths this file imports
}

export interface Chunk {
  id: string          // `${path}#${index}`
  path: string
  index: number       // chunk position within the file
  content: string
  startLine: number
  endLine: number
}

export interface EmbeddedChunk extends Chunk {
  embedding: number[]
}

export interface SearchResult {
  chunk: Chunk
  score: number       // cosine similarity, 0..1
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
  readonly dimensions: number
}

export interface VectorStore {
  upsert(chunks: EmbeddedChunk[]): Promise<void>
  search(query: number[], topK: number): Promise<SearchResult[]>
  removeByPath(path: string): Promise<void>
  clear(): Promise<void>
  size(): Promise<number>
}
