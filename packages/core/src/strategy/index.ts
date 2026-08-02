// Eval-gated multi-agent: the dispatcher, the thirteen roles, deterministic merge, pass@k.
//
// `single` is the default and stays the default until `shouldDefaultToSwarm` says otherwise
// on measured data (Requirement 24.8). Nothing in this module makes the single-agent path
// more expensive than calling `loop.runTask` directly.

export {
  STRATEGIES,
  DEFAULT_STRATEGY,
  ESCALATION_LADDER,
  STRATEGY_DESCRIPTIONS,
  isStrategy,
  heavierThan,
} from './strategies.js'
export type { Strategy } from './strategies.js'

export {
  ROLES,
  ROLE_DEFINITIONS,
  NO_FINDINGS_TOKEN,
  isRole,
  allRoles,
  editingRoles,
  describeSignal,
  roleCapabilities,
  roleVerification,
  partitionRoles,
  assertRoleVerifiable,
  rolePrompt,
} from './roles.js'
export type { Role, RoleDefinition, RoleSignal, RoleVerification } from './roles.js'

export {
  RegisteredAgentRegistry,
  RegisteredWorkflowRegistry,
  executeRegisteredAgent,
} from './extensions.js'
export type {
  RegisteredAgentDescriptor,
  RegisteredAgentExecution,
  RegisteredAgentGrade,
  RegisteredAgentOptions,
  RegisteredWorkflow,
  RegisteredWorkflowContext,
  RegisteredWorkflowDescriptor,
  RegisteredWorkflowExecutor,
} from './extensions.js'

export { extractCitations, diskPathExists, gradeRole } from './grade.js'
export type { Citation, PathExists, RoleGrade } from './grade.js'

export {
  collectProposals,
  mergeProposals,
  consensus,
  blockerFollowUps,
  unverifiableFollowUps,
  proposedPaths,
} from './merge.js'
export type {
  EditProposal,
  MergeConflict,
  MergeResult,
  MergeOptions,
  AppliedEdit,
  Blocker,
  ConsensusResult,
  FollowUpTask,
  FollowUpOrigin,
} from './merge.js'

export {
  dispatch,
  configuredStages,
  terminalReason,
  planTextFrom,
  ESCALATABLE_REASONS,
  SWARM_ORDER,
} from './dispatcher.js'
export type {
  DispatchDeps,
  DispatchResult,
  RoleOutcome,
  RunTaskFn,
  StrategyAttempt,
} from './dispatcher.js'

export {
  passAtK,
  passAtKSet,
  emptyReport,
  liftOver,
  shouldDefaultToSwarm,
} from './passk.js'
export type {
  PassAtKCase,
  PassAtKReport,
  PassAtKOptions,
  Lift,
  SwarmDefaultVerdict,
} from './passk.js'
