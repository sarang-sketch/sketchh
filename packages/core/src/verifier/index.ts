// Public API for the verifier module

export type {
  CheckName,
  CheckResult,
  VerifySummary,
  DetectedProject,
  CheckConfig,
  CommandRunner,
  CommandOutput,
} from './types.js'
export { detectProject } from './detector.js'
export { ChildProcessRunner } from './command-runner.js'
export { Verifier } from './verifier.js'
export type { VerifyOptions } from './verifier.js'
export { VerifyLoop } from './verify-loop.js'
export type {
  Fixer,
  FixContext,
  VerifyLoopOptions,
  VerifyLoopResult,
  LoopStatus,
} from './verify-loop.js'
