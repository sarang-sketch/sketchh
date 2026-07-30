// The `SecretStore` seam — and, deliberately, NO implementation that persists.
//
// ── WHY THERE IS NOTHING HERE THAT CAN WRITE A KEY ──────────────────────────
//
// Requirement 17.3 says the core depends only on `get`/`set`/`del` and that the real
// implementation lives OUTSIDE the core, against the operating system's credential
// store. That is not a layering preference, it is the security property: an engine
// that has no code path to a keychain cannot leak one, and an engine with no runtime
// dependencies has no native module that could.
//
// So this module contains exactly three things:
//
//   1. `assertSecretId` — what a legal secret identifier is. The host mirrors this
//      rule (packages/desktop/src-tauri/src/secret_store.rs); both sides validate,
//      because the side that skips validation is the one that gets a surprise.
//   2. `MemorySecretStore` — a process-lifetime `Map`. For tests and for an
//      ephemeral session. It has no `fs` import, so it cannot become a file store by
//      accident (see the guard in test/secrets.store.test.ts).
//   3. `unavailableSecretStore` — the default a caller gets when no host store was
//      injected. Every method THROWS, naming the missing host. A default that
//      returned `null` from `get` and swallowed `set` would look like an empty
//      keychain, and "your key was silently discarded" is the worst possible failure
//      mode for this seam.
//
// ── ERRORS NAME KEYS, NEVER VALUES ──────────────────────────────────────────
//
// Nothing in this file interpolates a secret VALUE into a message, a stack, or a
// return value. The identifier is the only thing that is ever echoed. Same rule as
// providers/redact.ts, for the same reason: an error string ends up in a log, an
// event payload, and a bug report.
//
// Validates: Requirements 17.3, 17.4

import type { SecretStore } from '../types.js'

/** Re-exported so a consumer of this module needs no second import. */
export type { SecretStore }

/**
 * Legal secret identifiers: a provider id, essentially. Letters, digits, `.`, `_`
 * and `-`, 1–128 characters.
 *
 * Narrow on purpose. The identifier becomes an ACCOUNT NAME in an OS credential
 * store — a Windows Credential Manager target, a Keychain account, a libsecret
 * attribute — and those are C-string-shaped interfaces where a NUL, a newline, or a
 * path separator is at best a confusing entry and at worst a way to address a
 * different record than the one named.
 */
export const SECRET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Why an identifier was refused. Carries the identifier, never a value. */
export class InvalidSecretIdError extends Error {
  constructor(id: string) {
    super(
      `'${id}' is not a usable secret id: use 1-128 characters from A-Z a-z 0-9 . _ - , starting with a letter or digit`,
    )
    this.name = 'InvalidSecretIdError'
  }
}

/** Refused when a caller tries to store nothing. Deleting is `del`, not `set('')`. */
export class EmptySecretError extends Error {
  constructor(id: string) {
    super(`refusing to store an empty secret for '${id}': use del to remove it`)
    this.name = 'EmptySecretError'
  }
}

/** Throw unless `id` is a legal secret identifier. Returns it trimmed. */
export function assertSecretId(id: string): string {
  const trimmed = id.trim()
  if (!SECRET_ID_PATTERN.test(trimmed)) throw new InvalidSecretIdError(id)
  return trimmed
}

/** True when `id` is a legal secret identifier. The non-throwing form. */
export function isValidSecretId(id: string): boolean {
  return SECRET_ID_PATTERN.test(id.trim())
}

/**
 * A `SecretStore` that lives and dies with the process.
 *
 * For tests, and for a session where a user supplies a key once and does not want
 * it kept. NOTHING HERE TOUCHES THE FILESYSTEM: there is no `node:fs` import in this
 * file, which is the property the guard test asserts, because "in memory" is a claim
 * that is one convenience commit away from being false.
 */
export class MemorySecretStore implements SecretStore {
  readonly #rows = new Map<string, string>()

  async get(id: string): Promise<string | null> {
    return this.#rows.get(assertSecretId(id)) ?? null
  }

  async set(id: string, value: string): Promise<void> {
    const key = assertSecretId(id)
    if (value === '') throw new EmptySecretError(key)
    this.#rows.set(key, value)
  }

  async del(id: string): Promise<void> {
    this.#rows.delete(assertSecretId(id))
  }

  /** Which ids hold a secret. IDS ONLY — this never hands back a value. */
  ids(): string[] {
    return [...this.#rows.keys()].sort()
  }

  /** How many secrets are held. For assertions that must not read a value. */
  get size(): number {
    return this.#rows.size
  }
}

/** Thrown by every method of `unavailableSecretStore`. Names the missing host. */
export class NoSecretStoreError extends Error {
  constructor(operation: string, id: string, detail: string) {
    super(
      `cannot ${operation} the secret '${id}': ${detail}. The engine has no credential storage of its own — the host application supplies a SecretStore backed by the OS credential store (Requirement 17.3).`,
    )
    this.name = 'NoSecretStoreError'
  }
}

/**
 * The default store: one that refuses, loudly, in all three directions.
 *
 * Used wherever a `SecretStore` is optional, so an unconfigured engine fails with a
 * sentence about the missing host instead of behaving like an empty keychain.
 */
export function unavailableSecretStore(
  detail = 'no host credential store was supplied',
): SecretStore {
  return {
    async get(id: string): Promise<string | null> {
      throw new NoSecretStoreError('read', id, detail)
    },
    async set(id: string): Promise<void> {
      throw new NoSecretStoreError('store', id, detail)
    },
    async del(id: string): Promise<void> {
      throw new NoSecretStoreError('remove', id, detail)
    },
  }
}
