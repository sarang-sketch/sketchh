// The window's view of credential storage: presence, save, remove. Never a value.
//
// ── WHERE A KEY LIVES, AND FOR HOW LONG ─────────────────────────────────────
//
// Typed into the form  → held in one `useState` for exactly as long as the user is
//                        looking at that form;
// Saved               → handed to Rust, which hands it to the OS credential store and
//                        wipes its own copy. Nothing in this package keeps it;
// Read back           → NEVER. There is no read operation on this interface because
//                        there is no Tauri command behind one. The engine takes a key
//                        as an argument for one call (Requirement 17.4), and the only
//                        key that can reach a call from this window is one the user
//                        just typed.
//
// `KeyStore` is an interface for the same reason `FileIo` and `SketchClient` are: a
// test drives the real panel and the real reducer without a Tauri webview, and the
// double it uses cannot accidentally become a persisting store.
//
// Validates: Requirements 17.3, 17.4

import {
  listProviderKeys,
  removeProviderKey,
  setProviderKey,
  type ProviderKeyPresence,
} from '../ipc/bridge'

export type { ProviderKeyPresence }

export interface KeyStore {
  /** Which of these providers have a stored key, and which store that is. */
  presence(providerIds: string[]): Promise<ProviderKeyPresence[]>
  /** Store a key. Resolves with the name of the store it went into. */
  save(providerId: string, apiKey: string): Promise<string>
  /** Remove a stored key. Resolves with the name of the store. */
  remove(providerId: string): Promise<string>
}

/** The real one: the Rust commands, renamed onto the interface. */
export const bridgeKeyStore: KeyStore = {
  presence: (providerIds) => listProviderKeys(providerIds),
  save: (providerId, apiKey) => setProviderKey(providerId, apiKey),
  remove: (providerId) => removeProviderKey(providerId),
}

/**
 * What the UI knows about one provider's key.
 *
 * `unknown` is a FIRST-CLASS STATE, exactly like `never-run` for a connection test: in
 * a browser dev session there is no credential store to ask, and claiming "no key
 * stored" would be a guess dressed as a fact (Requirement 27.3).
 */
export type KeyState =
  | { status: 'unknown'; reason: string }
  | { status: 'absent'; store: string }
  | { status: 'stored'; store: string }
  | { status: 'saving' }
  | { status: 'removing' }

/** Turn a bridge rejection into a sentence a user can act on. */
export function describeKeyFailure(
  operation: 'read' | 'save' | 'remove',
  providerId: string,
  err: unknown,
): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()
  if (lower.includes('not running under tauri')) {
    return `Keys are stored by the operating system, which the desktop app reaches and a browser tab cannot. Nothing was ${
      operation === 'read' ? 'read' : operation === 'save' ? 'saved' : 'removed'
    }.`
  }
  if (lower.includes('no operating system credential store')) {
    return `This machine has no usable credential store, so the key for ${providerId} cannot be remembered. ${raw}`
  }
  return `Could not ${operation} the stored key for ${providerId}: ${raw}`
}

/**
 * Ask the store about a set of providers, mapping the answer onto `KeyState`.
 *
 * Never throws: a refusal is data, so the panel can put the reason on screen instead
 * of rendering a silent "no key".
 */
export async function readKeyStates(
  store: KeyStore,
  providerIds: string[],
): Promise<Record<string, KeyState>> {
  if (providerIds.length === 0) return {}
  try {
    const rows = await store.presence(providerIds)
    const states: Record<string, KeyState> = {}
    for (const row of rows) {
      states[row.id] = row.hasKey
        ? { status: 'stored', store: row.store }
        : { status: 'absent', store: row.store }
    }
    return states
  } catch (err) {
    const reason = describeKeyFailure('read', providerIds.join(', '), err)
    const states: Record<string, KeyState> = {}
    for (const id of providerIds) states[id] = { status: 'unknown', reason }
    return states
  }
}

/** How a key state reads on screen. One sentence, and it never guesses. */
export function describeKeyState(state: KeyState | undefined): string {
  if (state === undefined) return 'Checking the operating system credential store…'
  switch (state.status) {
    case 'unknown':
      return state.reason
    case 'absent':
      return `No key is stored in ${state.store}. A key typed here is used for the next request only unless you save it.`
    case 'stored':
      return `A key is stored in ${state.store}. Runs and connection tests use it; type a new one here to replace it.`
    case 'saving':
      return 'Saving the key to the operating system credential store…'
    case 'removing':
      return 'Removing the stored key…'
  }
}
