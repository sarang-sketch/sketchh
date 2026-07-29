// Unified-diff parsing and per-hunk application.
//
// The review surface (Requirement 16) accepts and rejects hunks one at a time.
// The string work behind that lives here, in the core, so it can be tested
// without booting a UI.

export {
  parseUnifiedDiff,
  applyHunks,
  detectLineEnding,
  allHunkIndexes,
} from './hunks.js'

export type {
  DiffLine,
  DiffLineKind,
  Hunk,
  DiffDiagnostic,
  DiffErrorCode,
  ParseDiffResult,
  ApplyHunksResult,
  LineEnding,
  LineEndingReport,
} from './hunks.js'
