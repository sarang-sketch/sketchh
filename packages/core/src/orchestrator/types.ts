// Types for what survives of the orchestrator module: the sandboxed file writer.
//
// This file used to carry the legacy state machine's vocabulary — `TaskStatus`,
// `PlanStep`, `Plan`, `StepResult`, `OrchestratorEvent`. That machine
// (`orchestrator.ts`, `planner.ts`, `agent-runner.ts`) was deleted along with the
// legacy `verifier/` it drove; the canonical agent loop is `loop/runTask` and its
// contracts live in `src/types.ts`. Only `FileEdit` outlived it, because
// `file-writer.ts` is genuinely shared: `loop/edits.ts`, `strategy/merge.ts` and
// the RPC methods all apply edits through `FileWriter`.

export interface FileEdit {
  path: string
  // Full new content of the file. The writer resolves it against the root and
  // refuses anything that escapes.
  content: string
}
