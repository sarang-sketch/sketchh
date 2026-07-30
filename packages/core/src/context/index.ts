// Public API for the context module

export type {
  IndexedFile,
  Chunk,
  EmbeddedChunk,
  SearchResult,
  Embedder,
  VectorStore,
} from './types.js'
export { walkProject, walkProjectDetailed, DEFAULT_MAX_FILES } from './walker.js'
export type { WalkedFile, WalkOptions, WalkResult } from './walker.js'
export { chunkFile } from './chunker.js'
export type { RawChunk, ChunkOptions } from './chunker.js'
export {
  buildDependencyGraph,
  expandWithDependencies,
  extractImportSpecifiers,
  resolveImportSpecifier,
} from './dependency-graph.js'
export type { DependencyGraph } from './dependency-graph.js'

// The persisted repository graph: `<project>/.sketch/index/graph.json`.
export {
  buildRepoGraph,
  loadRepoGraph,
  saveRepoGraph,
  serializeRepoGraph,
  graphPath,
  GRAPH_VERSION,
} from './repo-graph.js'
export type {
  RepoGraph,
  GraphFile,
  GraphChunk,
  RepoGraphStats,
  BuildRepoGraphOptions,
  RepoGraphBuildResult,
} from './repo-graph.js'
// Hybrid retrieval: lexical + vector, fused by reciprocal rank, then reranked.
// Vector-only is not the shipped default (Requirement 18.2).
export {
  hybridSearch,
  lexicalSearch,
  vectorSearch,
  reciprocalRankFusion,
  rerank,
  rerankScore,
  compareFused,
  resolveSearchConfig,
  isVectorOnly,
  detectRipgrep,
  resetRipgrepDetection,
  ripgrepArgs,
  parseRipgrepLine,
  countMatches,
  looksLikeDefinition,
  chunkForLine,
  DEFAULT_SEARCH_CONFIG,
  RERANK_WEIGHTS,
  MAX_RERANK_BOOST,
  RRF_K,
  RIPGREP_BINARY,
  DEFAULT_TOP_K,
  MAX_LEXICAL_HITS,
  MAX_MATCHES_PER_FILE,
  MAX_SCANNED_FILES,
} from './hybrid-search.js'
export type {
  ChannelName,
  ChannelReport,
  FusedCandidate,
  HybridHit,
  HybridSearchOptions,
  HybridSearchResult,
  LexicalEngine,
  LexicalHit,
  LexicalResult,
  LexicalSearchOptions,
  RankedItem,
  RankedList,
  RipgrepProbe,
  SearchConfig,
  VectorChannel,
  VectorHit,
} from './hybrid-search.js'

export {
  ProviderEmbedder,
  HashEmbedder,
  cosineSimilarity,
  l2normalise,
} from './embedder.js'
export { MemoryVectorStore } from './vector-store.js'
export { ContextEngine } from './context-engine.js'
export type { RetrievedContext, ContextEngineOptions } from './context-engine.js'
