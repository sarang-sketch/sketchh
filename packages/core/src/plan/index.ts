// Public surface of the plan artifact writer.
//
// src/index.ts is wired by the orchestrator after this batch; import from
// '../plan/index.js' in the meantime.

export {
  PlanWriter,
  InvalidRunIdError,
  PLAN_DOCUMENTS,
  assertSafeRunId,
  documentFile,
  resolveDocument,
} from "./writer.js";
export type {
  PlanArtifacts,
  PlanDocument,
  PlanWriteResult,
  PlanWriterOptions,
} from "./writer.js";
