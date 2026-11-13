// The public surface of the hooks module.
export {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  MAX_HOOKS,
  MAX_HOOKS_FILE_BYTES,
  MAX_HOOK_OUTPUT_BYTES,
  MAX_HOOK_TIMEOUT_MS,
  isHookEvent,
} from './types.js'
export type {
  HookConfig,
  HookDecision,
  HookEvent,
  HookOutcome,
  HookPayload,
  HookRunnerLike,
} from './types.js'
export {
  HOOKS_FILE_NAME,
  hooksFilePath,
  isBlocking,
  loadHooks,
  parseHooksConfig,
  saveHooks,
  timeoutFor,
  validateHookConfig,
} from './config.js'
export type { HooksFile, LoadedHooks } from './config.js'
export { HOOK_EVENT_KIND, HookRunner, matchesTool, parseHookDecision, runHookCommand } from './runner.js'
export type { HookRunnerOptions } from './runner.js'
export { hooksList, hooksSave, hooksTest } from './rpc.js'
export type { HooksListResult, HooksSaveResult, HooksTestResult } from './rpc.js'
