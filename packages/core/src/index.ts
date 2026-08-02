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

// The curated skill registry: a pinned manifest with a content hash per skill, and
// an installer that REFUSES on mismatch (`registry.installSkill`). A content pin,
// not a signature — see the header of `registry/manifest.ts`.
export * as registry from './registry/index.js'

// Capability scoping. `capabilities.ToolDispatcher` is the ONE place a tool call is
// authorised; the vocabulary fails closed on a token it does not recognise. Phase
// 7.3 registers real tools here and does not get to add a second dispatcher.
export * as capabilities from './capabilities/index.js'

// The ONE credential pattern table (`secrets.SECRET_KEY_SHAPES`,
// `secrets.isSensitiveKeyName`). Public because "holds no key material" is a
// contract this engine makes to its callers (Requirements 17.2, 3.7), and a caller
// cannot verify that contract without the engine's own definition of what a
// credential looks like. Left private, every consumer writes its own table and the
// tables drift — which is the exact failure this module was created to prevent.
// Pure data and pure functions: no I/O, no runtime dependency.
export * as secrets from './secrets/index.js'

// Key-free provider configuration (`~/.sketch/providers.json`) and the per-provider
// connection test. The settings surface reaches these through the RPC methods below,
// so the desktop bundle keeps taking no runtime dependency on this package.
export * as settings from './settings/index.js'
export * as plan from './plan/index.js'

// `<project>/.sketch/` — the engine's own state directory, and the self-ignore
// marker that keeps the event log and the plan out of the user's `git status`.
export * as workspace from './workspace/index.js'

// The agent loop: `loop.runTask(task, deps)`.
export * as loop from './loop/index.js'

// The curated MCP tool layer: `mcp.McpHost`, `mcp.MCP_CATALOG`. Hand-rolled JSON-RPC
// over stdio, pinned launch argv, and a server that hangs is written off for the run
// rather than wedging it. Produces `ToolDescriptor`s; never authorises them.
export * as mcp from './mcp/index.js'

// Cost: the ONE price table with the date it was true (`cost.PRICED_AT`), and a ledger
// that is a pure function of the event log. There is no counter kept alongside the log,
// because two sources of a money number agree right up until they do not. An unpriced
// model reports `null` and is counted — never `$0.00`, which is how a user finds out
// what a run cost from an invoice.
export * as cost from './cost/index.js'

// Tools the engine drives on the machine: `tools.GitTool`, `tools.parseStatus`.
// The Git panel reaches these through the RPC methods below, not by importing them
// — the desktop bundle takes no runtime dependency on this package.
export * as tools from './tools/index.js'

// The eval harness: `evals.runEvalSet(cases, deps)` and `evals.meanScore(results)`.
// Built before the things it judges — every lift claim is measured through it.
export * as evals from './evals/index.js'

// Eval-gated multi-agent: `strategy.dispatch(task, deps)`, the thirteen roles and the
// verification signal each is graded by, the deterministic merge, and pass@k.
//
// `strategy.DEFAULT_STRATEGY` is `single` and it stays that way until
// `strategy.shouldDefaultToSwarm` says otherwise on measured pass@k lift (Requirement 24.8).
// That function has no override parameter on purpose.
export * as strategy from './strategy/index.js'

// Host-owned, immutable production extension registries. One bundle is injected into
// either transport; importing the package registers nothing globally.
export * as extensions from './extensions/index.js'
export { createEngineExtensionRegistry, createExtensionBundle } from './extensions/index.js'
export type {
  EngineExtensionRegistry,
  EngineExtensionRegistryOptions,
  ExtensionBundle,
  ExtensionBundleOptions,
} from './extensions/index.js'

// Honest benchmark reports: fixed budgets, explicit unknowns, versioned harness identity,
// strict comparability, and validated artifacts under `.sketch/bench/`.
export * as bench from './bench/index.js'

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
export type { ServerIO } from './rpc/server.js'

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

export {
  ProtocolServer,
  createServer,
  createMethodContext,
  sanitizeFrame,
  collectParamSecrets,
} from './rpc/server.js'
export type { MethodContextIO } from './rpc/server.js'

