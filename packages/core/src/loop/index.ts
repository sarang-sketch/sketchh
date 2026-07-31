// Public surface of the agent loop.

export {
  runTask,
  systemPrompt,
  formatVerifyFeedback,
  DEFAULT_MAX_ITERATIONS,
  PLAN_GATE_REASON,
  TOOL_UNAVAILABLE_REASON,
  ASK_UNSUPPORTED_REASON,
  RETRIEVED_CONTEXT_HEADING,
} from './agent.js'
export type { RunTaskDeps, PlanGate, VerifyRunner } from './agent.js'

export { parseAction, isActionName, ACTION_NAMES } from './actions.js'
export type { Action, ActionName, EditSpec } from './actions.js'

export {
  applyEdit,
  applyPreparedEdit,
  prepareEdit,
  unifiedDiff,
  diskTextReader,
} from './edits.js'
export type {
  EditOutcome,
  ApplyEditOptions,
  PreparedEdit,
  PrepareEditResult,
  TextReader,
} from './edits.js'
