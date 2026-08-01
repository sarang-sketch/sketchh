// Public surface of the shell-less verify runner.

export {
  runCommand,
  runCommands,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  EXIT_TIMEOUT,
  EXIT_SPAWN_FAILED,
  EXIT_ABORTED,
  EXIT_SIGNALLED,
} from './runner.js'
export type { VerifyEventSink, RunCommandOptions } from './runner.js'

// The verification contract: nine ordered stages, `verify.yaml` taking precedence
// over per-stack detection, and an unconfigured stage reported as skipped rather
// than failing. This layer decides WHAT runs; `runner.ts` is still the only place
// this package spawns a process.
export {
  POLICY_FILENAMES,
  VERIFY_STAGES,
  detectLanguage,
  detectVerifyPolicy,
  formatPolicyResult,
  isVerifyStage,
  parsePolicyJson,
  parsePolicyYaml,
  resolveVerifyPolicy,
  runVerifyPolicy,
  splitArgv,
  verifyProject,
} from './policy.js'
export type {
  DetectedLanguage,
  PolicyResult,
  PolicySource,
  ResolvedPolicy,
  RunPolicyOptions,
  StageResult,
  StageStatus,
  VerifyPolicy,
  VerifyStage,
} from './policy.js'
