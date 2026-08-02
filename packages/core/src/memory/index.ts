// Project memory: versioned rows, hygiene, and retrieval.
//
// ── TWO SURFACES LIVE HERE, ON PURPOSE ─────────────────────────────────────
//
// `MemoryStore` and everything around it is the Phase 9 surface: every row carries a
// validity window, superseding appends rather than edits, and retrieval excludes retracted
// facts by default.
//
// `ProjectMemory` / `MemoryProjectMemory` is the ORIGINAL surface and is still exported,
// unchanged. The legacy orchestrator (`src/orchestrator/orchestrator.ts`) depends on four
// of its members — `digest`, `addTestRecord`, `addConversation`, and the type name — and
// changing them to fit the new store would break a live caller for no benefit to it. The
// two are bridged by `legacyProjectMemory`, so a caller can hand the versioned store to
// the old orchestrator and get versioning underneath without the orchestrator learning
// anything new. Converging them is a spec decision, not a refactor to slip in here.

export {
  MEMORY_KINDS,
  MEMORY_KIND_DESCRIPTIONS,
  STILL_VALID,
  asMemoryEntry,
  describeWindow,
  isCurrent,
  isMemoryKind,
  isMemorySource,
  isValidAt,
} from './entries.js'
export type { MemoryEntry, MemoryEntryInput, MemoryKind, MemorySource } from './entries.js'

export {
  InMemoryStore,
  JsonlMemoryStore,
  applyOps,
  asMemoryOp,
  memoryDir,
} from './store.js'
export type {
  AddOp,
  CloseOp,
  JsonlMemoryStoreOptions,
  MemoryOp,
  MemoryQuery,
  MemoryStore,
  MemoryStoreOptions,
  ReadMemoryResult,
  SupersedeRequest,
  SupersedeResult,
} from './store.js'

export {
  ALL_MEMORY_KINDS,
  expireMemory,
  lintMemory,
  remember,
  supersedeEntry,
} from './hygiene.js'
export type {
  ExpireOptions,
  ExpireResult,
  LintConfidence,
  MemoryEventSink,
  MemoryLintFinding,
  RememberOptions,
  RememberResult,
} from './hygiene.js'

export {
  DEFAULT_MEMORY_TOP_K,
  MAX_RECENCY_BOOST,
  RECENCY_HALF_LIFE_MS,
  memoryDigest,
  recencyBoost,
  renderMemoryForPrompt,
  retrieveMemory,
} from './retrieve.js'
export type {
  MemoryChannel,
  MemoryChannelReport,
  MemoryHit,
  RetrieveMemoryOptions,
  RetrieveMemoryResult,
} from './retrieve.js'

// ── the original surface, unchanged ─────────────────────────────────────────

export type {
  ProjectMemory,
  Decision,
  Standard,
  BugRecord,
  TestRecord,
  ConversationRecord,
} from './types.js'
export { MemoryProjectMemory } from './project-memory.js'
export type { Clock } from './project-memory.js'
export { legacyProjectMemory } from './legacy-bridge.js'
