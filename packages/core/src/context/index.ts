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

// Embedding. The local hashing path is the default and is NOT a semantic model —
// see the header of embedder.ts and LOCAL_EMBEDDER_LIMITATIONS before relying on
// it. Provider embeddings are a documented, locally cached fallback (18.3).
export {
  ProviderEmbedder,
  HashEmbedder,
  hashEmbed,
  isUsableVector,
  cosineSimilarity,
  l2normalise,
  LOCAL_EMBEDDER_ID,
  LOCAL_EMBEDDER_MODEL,
  LOCAL_EMBEDDER_LIMITATIONS,
  DEFAULT_LOCAL_DIMENSIONS,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
} from './embedder.js'
export type {
  EmbedderIdentity,
  IdentifiedEmbedder,
  ProviderEmbedderOptions,
} from './embedder.js'
export {
  OfflineFirstEmbedder,
  createEmbedder,
} from './offline-embedder.js'
export type {
  EmbedderMode,
  EmbedderStatus,
  OfflineFirstEmbedderOptions,
} from './offline-embedder.js'
export {
  FileEmbeddingCache,
  MemoryEmbeddingCache,
  embeddingCacheKey,
  embeddingsDir,
  contentHash,
  EMBEDDING_CACHE_VERSION,
} from './embedding-cache.js'
export type {
  CacheStats,
  EmbeddingCache,
  EmbeddingCacheRecord,
} from './embedding-cache.js'
export { MemoryVectorStore } from './vector-store.js'
export { ContextEngine } from './context-engine.js'
export type { RetrievedContext, ContextEngineOptions } from './context-engine.js'

// Signature extraction: the outline pass that lets truncation keep coverage.
// Hand-rolled, heuristic, and honest about the languages it cannot parse (18.5).
export {
  extractSignatures,
  renderSignatures,
  languageOf,
  supportsSignatures,
  extensionOf,
  stripNoise,
  BODY_ELISION,
  ARROW_ELISION,
  TRUNCATION_MARKER,
} from './signatures.js'
export type {
  Declaration,
  DeclarationKind,
  SignatureExtraction,
  SignatureLanguage,
  ExtractSignatureOptions,
} from './signatures.js'

// Context assembly under a token budget: memory + skills + top-k chunks +
// one-hop `imports` neighbours, degrading detail before coverage (18.4–18.6,
// 18.8). The token number is an ESTIMATE (`chars/4`), not a tokenizer count.
export {
  assembleContext,
  estimateTokens,
  oneHopNeighbours,
  CHARS_PER_TOKEN,
  TOKEN_ESTIMATE_METHOD,
} from './assembly.js'
export type {
  AssembleContextOptions,
  AssembledContext,
  AssembledSection,
  DetailLevel,
  DroppedItem,
  SectionKind,
} from './assembly.js'
