// Canonical contracts, re-exported for the frontend.
//
// There is exactly ONE source of truth for these shapes: packages/core/src/types.ts.
// This module is a type-only re-export of that file through the workspace package,
// so the UI can never drift from the engine. Nothing here is a local copy.
//
// Type-only on purpose: `export type` is erased at compile time, so the desktop
// bundle takes on no runtime dependency on @sketch/core. The engine is reached
// through the SketchClient seam (see ./client.ts) and never imported directly.

export type {
  // Events — the spine the Timeline and the Agent Console read.
  EventKind,
  SketchEvent,
  // Work units and their results.
  Task,
  RunResult,
  VerifyCommand,
  VerifyResult,
  // Eval harness.
  Check,
  EvalCase,
  EvalResult,
  // Provider-facing shapes that show up inside llm_request / llm_response payloads.
  Message,
  Usage,
  // Skills and project context.
  Skill,
  ProjectContext,
} from '@sketch/core'
