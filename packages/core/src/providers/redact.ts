// Centralized secret redaction for provider errors.
//
// Every error thrown out of the provider layer passes through here. Nothing else
// in the codebase is allowed to build a provider error message by hand, because
// the interesting failures — 401s, malformed URLs, proxy errors — are exactly the
// ones whose bodies tend to echo the credential back at you.
//
// The credential-name and key-shape tables are NOT defined here: they live in
// `src/secrets/patterns.ts`, shared with the event-log sanitizer, so a newly
// discovered key format cannot be taught to one redactor and missed by the other.
//
// Validates: Requirements 2.6

import {
  MIN_SECRET_LENGTH,
  SECRET_HEADER_PATTERN,
  SECRET_QUERY_PATTERN,
  redactKeyShapes,
} from '../secrets/patterns.js'

/** Fixed stand-in for anything secret. Never varies, so it is greppable in tests. */
export const REDACTED = '«redacted»'

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace every occurrence of `secrets` — and every credential-shaped
 * header/query fragment — with {@link REDACTED}.
 *
 * Short or empty secrets are ignored: a one-character "secret" would blank out
 * half the message and tell the user nothing.
 */
export function redact(text: string, secrets: string[] = []): string {
  let out = text

  for (const secret of secrets) {
    if (typeof secret !== 'string') continue
    const trimmed = secret.trim()
    if (trimmed.length < MIN_SECRET_LENGTH) continue
    out = out.replace(new RegExp(escapeRegExp(trimmed), 'g'), REDACTED)
  }

  out = out.replace(
    SECRET_HEADER_PATTERN,
    (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`,
  )
  out = out.replace(SECRET_QUERY_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`)
  out = redactKeyShapes(out, REDACTED)

  return out
}

/** Everything a provider error needs to say, minus the credential. */
export interface ProviderErrorFacts {
  /** Provider id, e.g. `openai` — always present so a failure is attributable. */
  providerId: string
  /** HTTP status, when the failure came back over the wire. */
  status?: number
  /** Response body, exception message, or any other diagnostic detail. */
  detail?: string
  /** Credential values to scrub. Missing/short entries are skipped. */
  secrets?: string[]
}

/**
 * Build the message for a thrown provider error: provider id, status when known,
 * and a redacted detail tail. Truncated so a giant HTML error page cannot bury
 * the useful part.
 */
export function providerErrorMessage(facts: ProviderErrorFacts): string {
  const head = facts.status === undefined
    ? `${facts.providerId}: request failed`
    : `${facts.providerId}: HTTP ${facts.status}`

  const detail = redact(facts.detail ?? '', facts.secrets ?? []).trim()
  if (!detail) return head
  const clipped = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail
  return `${head} — ${clipped}`
}

/** Convenience: an `Error` whose message is guaranteed redacted. */
export function providerError(facts: ProviderErrorFacts): Error {
  return new Error(providerErrorMessage(facts))
}
