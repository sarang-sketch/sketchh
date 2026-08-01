// Capability scoping: the vocabulary, and the one point that enforces it.
//
// A skill's `capabilities:` is not a label. `ToolDispatcher.call` consults the
// grant before any tool runs, and there is exactly one such function in this
// package — `capabilities.test.ts` asserts that, the same way the Rust side
// asserts there is exactly one `is_within`.

export {
  CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
  DEFAULT_CAPABILITIES,
  SENSITIVE_CAPABILITIES,
  capabilitiesForSkill,
  describeCapabilities,
  grants,
  isCapability,
  parseCapabilities,
} from './vocabulary.js'
export type { Capability, CapabilitySet, ParseCapabilitiesResult } from './vocabulary.js'

export { ToolDispatcher, describeGrantForPrompt } from './guard.js'
export type {
  DenialReason,
  ToolCallResult,
  ToolContext,
  ToolDescriptor,
  ToolDispatcherOptions,
  ToolOutcome,
} from './guard.js'
