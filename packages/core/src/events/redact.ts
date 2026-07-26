// Payload sanitation for the event log.
//
// "No event payload may ever carry a secret" is a hard constraint. The event log
// is written to disk in plaintext, is read back by the UI, and is the artifact a
// user is most likely to paste into a bug report. So sanitation happens in the
// store itself, on the write path, rather than being left to every call site to
// remember.
//
// Three defences, applied in order:
//   1. Key-name redaction — a key whose normalized name is a known credential
//      name loses its value entirely, whatever that value looks like.
//   2. Known-value redaction — any occurrence of a configured secret VALUE is
//      replaced wherever it appears, including in the middle of a longer string
//      such as a URL or an error message.
//   3. Shape redaction — well-known key formats (`sk-…`, `ghp_…`, `Bearer …`)
//      are redacted even when the value was never configured, which covers keys
//      that arrive from a provider response or a user-pasted prompt.
//
// ON THE OTHER REDACTOR: `src/providers/redact.ts` scrubs a thrown provider
// error's message. That is a different problem (a string, not a structured
// payload) and it keeps its own logic. What the two now SHARE is the table of
// what a credential looks like: the key names and key shapes below come from
// `src/secrets/patterns.ts`, so a newly discovered key format taught to one
// redactor is caught by both.
//
// Validates: Requirements 3.7

import {
  MIN_SECRET_LENGTH,
  SECRET_ENV_NAME_PATTERN,
  isSensitiveKeyName,
  redactKeyShapes,
} from "../secrets/patterns.js";

/** Replacement written in place of any secret material. */
export const REDACTED = "[redacted]";

/** Written when nesting exceeds the traversal limit (cycle or pathological depth). */
export const TRUNCATED = "[truncated]";

/**
 * Maximum nesting depth traversed. Beyond this the value is replaced rather
 * than descended into, which also makes a cyclic payload safe to sanitize.
 */
const MAX_DEPTH = 64;

function sanitizeString(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    // split/join rather than RegExp: no escaping bugs on keys containing
    // regex metacharacters, which real keys frequently do.
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  // Shape table is shared with the provider redactor; see src/secrets/patterns.ts.
  return redactKeyShapes(out, REDACTED);
}

function sanitizeValue(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (typeof value === "string") return sanitizeString(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, secrets, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKeyName(key) ? REDACTED : sanitizeValue(inner, secrets, depth + 1);
  }
  return out;
}

/**
 * Strip secret material from an event payload, recursively through nested
 * objects and arrays. Returns a new structure; the input is never mutated.
 *
 * @param payload The payload as supplied by a call site.
 * @param secrets Known secret VALUES (configured API keys, resolved tokens).
 */
export function sanitizePayload(
  payload: Record<string, unknown>,
  secrets: readonly string[] = [],
): Record<string, unknown> {
  const usable = secrets.filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LENGTH);
  return sanitizeValue(payload, usable, 0) as Record<string, unknown>;
}

/**
 * Credential-shaped values found in an environment. Used as the default secret
 * list so a key exported into the process environment cannot reach disk through
 * an event payload even when no call site declared it.
 */
export function secretsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (SECRET_ENV_NAME_PATTERN.test(name)) out.push(value);
  }
  return out;
}
