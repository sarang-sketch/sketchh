// Public surface of the eval harness.
//
// The trainer's gate depends on exactly three of these: `runEvalSet`, `meanScore`,
// and the `EvalDeps` shape it builds per candidate skill.

export {
  runEval,
  runEvalSet,
  meanScore,
  evaluateCheck,
  checkLabel,
  runOutputText,
  EMPTY_CHECKS_DETAIL,
  UNEVALUABLE_CREDENTIAL_TARGET_REASON,
} from './runner.js'
export type { EvalDeps, CheckOutcome } from './runner.js'
