// The one place the desktop package reaches for the diff engine.
//
// Parsing a unified diff and applying a SUBSET of its hunks is pure, deterministic
// string work, and it already exists — packages/core/src/diff/hunks.ts, written and
// unit-tested in part 1 of this task (see packages/core/test/diff.test.ts). None of
// it is re-implemented here. A second parser is how the engine's idea of a hunk and
// the review surface's idea of a hunk drift apart, and the drift shows up as a
// corrupted file.
//
// WHY A PATH INTO core/dist AND NOT `import { diff } from '@sketch/core'`:
// the package root re-exports the whole engine — the loop, the event store, the git
// tool — and those import `node:fs`, `node:child_process` and `node:crypto`. Pulling
// the root into a browser bundle drags all of it in and the build fails on the node
// builtins. `dist/diff/index.js` and the `dist/diff/hunks.js` behind it import
// NOTHING: no package, no builtin, not even another core module. So this is the one
// runtime import the renderer takes from core, and it is a leaf.
//
// The desktop package already resolves core's TYPES out of `dist` (see
// lib/contracts.ts, and `types: ./dist/index.d.ts` in core's package.json), so
// "core must be built before desktop typechecks" is not a new constraint — the root
// `npm run build` builds core first.
//
// Validates: Requirements 16.1, 16.2, 16.3, 16.5

export {
  parseUnifiedDiff,
  applyHunks,
  allHunkIndexes,
  detectLineEnding,
} from '../../../core/dist/diff/index.js'

export type {
  DiffDiagnostic,
  DiffErrorCode,
  DiffLine,
  DiffLineKind,
  Hunk,
  ApplyHunksResult,
  ParseDiffResult,
} from '../../../core/dist/diff/index.js'
