// Public API for the orchestrator module.
//
// What remains is the sandboxed file writer and the tolerant JSON extractor. The
// legacy plan → execute → verify → fix state machine and its `Planner` /
// `AgentRunner` collaborators were deleted with the legacy `verifier/` they drove
// (see `types.ts`). The canonical driver is `loop.runTask`.

export type { FileEdit } from './types.js'
export { extractJson } from './json.js'
export {
  DiskFileWriter,
  SnapshottingFileWriter,
  assertRealContainment,
  isWithin,
  realTargetPath,
  restoreSnapshot,
  snapshotDir,
} from './file-writer.js'
export type { FileWriter, RestoreOutcome, SnapshotEntry, SnapshotManifest } from './file-writer.js'
