// Canonical contracts, re-exported for the frontend.
//
// There is exactly ONE source of truth for these shapes: packages/core/src/types.ts.
// This module is a type-only re-export of that file through the workspace package,
// so the UI can never drift from the engine. Nothing here is a local copy.
//
// Type-only on purpose: `export type` is erased at compile time, so the desktop
// bundle takes on no runtime dependency on @sketch/core. The engine is reached
// through the SketchClient seam (see ./client.ts) and never imported directly.

import type { providers, settings, tools } from '@sketch/core'

/**
 * The git shapes, taken from the engine's parser rather than restated.
 *
 * `tools` is a namespace export, so these cannot ride the flat `export type {}`
 * below; a type alias through a type-only namespace import is still erased at
 * compile time, so the runtime dependency rule holds (Requirement 1.x).
 */
export type GitStatusResult = tools.GitStatusResult
export type GitFileChange = tools.GitFileChange

/**
 * Provider settings, taken from the engine rather than restated.
 *
 * `ProviderDescriptor` is the registry's catalog row — the full matrix the settings
 * surface lists, including the `serverless` flag. The `ProviderSettings*` shapes are
 * the KEY-FREE file at `~/.sketch/providers.json`; there is no `apiKey` field on any
 * of them, by construction (Requirement 17.2).
 */
export type ProviderDescriptor = providers.ProviderDescriptor
export type ProviderSettingsEntry = settings.ProviderSettingsEntry
export type ProviderSettingsFile = settings.ProviderSettingsFile
export type ProviderTestResult = settings.ProviderTestResult
export type ProviderTestCode = settings.ProviderTestCode

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
