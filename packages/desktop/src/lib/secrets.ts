// Getting a stored key to a run, and nowhere else.
//
// The credential store has always worked. What did not work was USING what it stored:
// the settings surface saved a key, the user restarted, and the only key that could
// reach a model was one they typed again for that call. Requirement 17.4 says a key is
// supplied to the engine at invocation time; this module is that supply.
//
// ── THE RULE THIS MODULE EXISTS TO KEEP ─────────────────────────────────────
//
// A resolved key lives in one local variable, goes onto one outgoing request, and is
// dropped. It is NEVER put in React state, in AppState, in a ref, in a module-level
// cache, or in a log line. Nothing here returns it to a panel for display, and nothing
// here stores it — so the value's lifetime is one function call in one run.
//
// The engine's side of the seam is already sound: `params.provider.apiKey` is handed to
// `ctx.rememberSecret` the moment it is parsed, so every response, error, and event is
// scrubbed of it before anything is written. That is why the run request is a safe place
// to put a key and a log line is not.

import { resolveProviderKey } from '../ipc/bridge'

/**
 * The stored key for one provider, or `null` when a run should proceed without one.
 *
 * `null` covers three genuinely different situations, deliberately collapsed here
 * because the caller's behaviour is the same in all three — send no key and let the
 * engine give its own honest refusal or run key-free:
 *
 *   * nothing is stored for this provider (the common case for local Ollama),
 *   * there is no Tauri runtime, as in browser development,
 *   * the OS store could not be reached.
 *
 * The distinction is not lost, it is REPORTED: a store that failed calls `onProblem`
 * with the reason, so a surface can say "your saved key could not be read" instead of
 * silently behaving as though the user never saved one. What is never done is throwing,
 * because a credential-store hiccup should not take down a run against a local model
 * that needs no key at all.
 */
export async function resolveApiKeyForRun(
  providerId: string,
  onProblem?: (reason: string) => void,
): Promise<string | null> {
  try {
    const key = await resolveProviderKey(providerId)
    // Defensive: Rust already filters a blank record, and a blank key would make the
    // engine send an empty credential and report a provider error instead of "no key".
    return key !== null && key.trim() !== '' ? key : null
  } catch (error) {
    // The message names the operation, never a value: `SecretError` has no variant that
    // can hold one, and outside Tauri the message is about the missing runtime.
    onProblem?.(error instanceof Error ? error.message : String(error))
    return null
  }
}
