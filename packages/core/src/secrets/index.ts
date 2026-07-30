// Shared credential pattern tables — the engine's single definition of what a
// credential looks like.
//
// Consumed internally by the two redactors (src/providers/redact.ts and
// src/events/redact.ts) and by the key-free guard on `providers.json`
// (src/settings/providerSettings.ts).
//
// PUBLIC, via `secrets` on the package root. Not because a caller needs to redact
// anything itself, but because the engine promises that certain files and frames
// carry no key material, and a caller auditing that promise needs this table rather
// than a private copy of it. A second table is how the promise quietly stops
// holding. Changing an entry here is therefore a change to a published contract.

// The `SecretStore` seam, and NO implementation that persists (Requirement 17.3).
// Real storage is the host's: packages/desktop/src-tauri/src/secret_store.rs against
// the OS credential store. What lives here is the interface, the identifier rule both
// sides enforce, an in-memory store for tests, and a default that refuses loudly.
export {
  SECRET_ID_PATTERN,
  InvalidSecretIdError,
  EmptySecretError,
  NoSecretStoreError,
  MemorySecretStore,
  assertSecretId,
  isValidSecretId,
  unavailableSecretStore,
} from './store.js'
export type { SecretStore } from './store.js'

export {
  MIN_SECRET_LENGTH,
  SENSITIVE_KEY_NAMES,
  SENSITIVE_HEADER_NAMES,
  SECRET_QUERY_PARAM_NAMES,
  SECRET_HEADER_PATTERN,
  SECRET_QUERY_PATTERN,
  SECRET_KEY_SHAPES,
  SECRET_ENV_NAME_PATTERN,
  normalizeKeyName,
  isSensitiveKeyName,
  redactKeyShapes,
} from './patterns.js'
