// Public API for the context module

export type {
  IndexedFile,
  Chunk,
  EmbeddedChunk,
  SearchResult,
  Embedder,
  VectorStore,
} from './types.js'
export { walkProject } from './walker.js'
export type { WalkedFile } from './walker.js'
export { chunkFile } from './chunker.js'
export type { RawChunk, ChunkOptions } from './chunker.js'
export {
  buildDependencyGraph,
  expandWithDependencies,
} from './dependency-graph.js'
export type { DependencyGraph } from './dependency-graph.js'
export {
  ProviderEmbedder,
  HashEmbedder,
  cosineSimilarity,
  l2normalise,
} from './embedder.js'
export { MemoryVectorStore } from './vector-store.js'
export { ContextEngine } from './context-engine.js'
export type { RetrievedContext, ContextEngineOptions } from './context-engine.js'
