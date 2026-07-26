// @sketch/core — public API

// The canonical contracts are flat at the root: `import { SketchEvent } from '@sketch/core'`.
// Module-local types stay behind their namespaces, which is what keeps the
// provider-local `Message` / `ProviderConfig` from colliding with the canonical ones.
export * from './types.js'

export * as providers from './providers/index.js'
export * as context from './context/index.js'
export * as memory from './memory/index.js'
export * as orchestrator from './orchestrator/index.js'

// `verifier` and `verify` are BOTH intentional and neither is a typo:
//   verifier/ — the legacy check-suite aggregate (CheckResult[] → VerifySummary),
//               still used by the existing orchestrator.
//   verify/   — the new shell-less command runner (VerifyCommand → VerifyResult)
//               from the canonical contracts, used by the agent loop.
// They will converge when the legacy orchestrator is retired. Until then, deleting
// or merging either one breaks a live caller.
export * as verifier from './verifier/index.js'
export * as verify from './verify/index.js'

export * as events from './events/index.js'
export * as skills from './skills/index.js'
export * as plan from './plan/index.js'

// The agent loop: `loop.runTask(task, deps)`.
export * as loop from './loop/index.js'

// The eval harness: `evals.runEvalSet(cases, deps)` and `evals.meanScore(results)`.
// Built before the things it judges — every lift claim is measured through it.
export * as evals from './evals/index.js'
