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

// Unified-diff parsing and per-hunk apply: `diff.parseUnifiedDiff`, `diff.applyHunks`.
// The review surface renders these hunks; the engine applies the accepted subset.
export * as diff from './diff/index.js'

export * as events from './events/index.js'
export * as skills from './skills/index.js'
export * as plan from './plan/index.js'

// `<project>/.sketch/` — the engine's own state directory, and the self-ignore
// marker that keeps the event log and the plan out of the user's `git status`.
export * as workspace from './workspace/index.js'

// The agent loop: `loop.runTask(task, deps)`.
export * as loop from './loop/index.js'

// Tools the engine drives on the machine: `tools.GitTool`, `tools.parseStatus`.
// The Git panel reaches these through the RPC methods below, not by importing them
// — the desktop bundle takes no runtime dependency on this package.
export * as tools from './tools/index.js'

// The eval harness: `evals.runEvalSet(cases, deps)` and `evals.meanScore(results)`.
// Built before the things it judges — every lift claim is measured through it.
export * as evals from './evals/index.js'

// RPC method handlers plus the transport seams a second transport needs.
//
// The Vite dev bridge (packages/desktop/vite.config.ts) is a real transport for
// this protocol: it parses requests with `parseRequest`, builds its handler
// context with `createMethodContext`, and scrubs every outgoing frame with
// `sanitizeFrame`. Exporting these keeps it from growing its own copies, which is
// how the two transports drifted in the first place.
export {
  METHODS,
  METHOD_NAMES,
  REQUIRED_METHOD_NAMES,
  InvalidParamsError,
  NotImplementedError,
} from './rpc/methods.js'
export type { MethodContext, MethodHandler } from './rpc/methods.js'

export {
  parseRequest,
  encodeFrame,
  isEventFrame,
  isResponseFrame,
  ERROR_CODES,
} from './rpc/frames.js'
export type {
  Frame,
  FrameId,
  ErrorCode,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  ParseResult,
} from './rpc/frames.js'

export { createMethodContext, sanitizeFrame, collectParamSecrets } from './rpc/server.js'
export type { MethodContextIO } from './rpc/server.js'

