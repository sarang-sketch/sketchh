// ONE table of credential patterns, shared by every redactor in the engine.
//
// Two redactors exist and both must stay: `src/providers/redact.ts` scrubs a
// STRING on the way into a thrown provider error, and `src/events/redact.ts`
// sanitizes a STRUCTURED payload on the way into the append-only event log.
// Those are different problems and each keeps its own logic. What they must never
// have is two different ideas of what a credential looks like: a key format
// learned by one would silently leak through the other.
//
// So the tables live here, exactly once. Add a newly discovered key format to
// SECRET_KEY_SHAPES and both redactors pick it up on the next call.
//
// Validates: Requirements 2.6, 3.7

/** Secret values shorter than this are ignored — redacting "1" would erase the log. */
export const MIN_SECRET_LENGTH = 4

/**
 * Credential-shaped key NAMES, normalized (lowercased, non-alphanumerics
 * stripped) so `apiKey`, `api_key`, `API-KEY`, and `x-api-key` all collapse onto
 * the same entry. Matching is exact after normalization, so `maxTokens` and
 * `totalTokens` are not caught by the `token` entry.
 */
export const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'apikey',
  'xapikey',
  'password',
  'token',
  'secret',
  'accesstoken',
  'refreshtoken',
])

/** Lowercase, non-alphanumerics stripped: `X-API-Key` → `xapikey`. */
export function normalizeKeyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** True when a key's name means its value is credential material, whatever it is. */
export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(normalizeKeyName(key))
}

/**
 * Header names whose *value* is credential material wherever it appears — used to
 * build {@link SECRET_HEADER_PATTERN}. Kept as data so the set is greppable and
 * testable alongside the name set above.
 */
export const SENSITIVE_HEADER_NAMES: readonly string[] = [
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'x-auth-token',
]

/** Query parameters that carry credential material: `?key=…`, `&access_token=…`. */
export const SECRET_QUERY_PARAM_NAMES: readonly string[] = [
  'key',
  'api_key',
  'apikey',
  'access_token',
  'token',
  'secret',
]

/**
 * `Authorization: Bearer …` and friends, in any of the shapes a diagnostic string
 * puts them in (`name: value`, `name=value`, optionally quoted). Group 1 is the
 * header name, group 2 the separator — replace with `$1$2<redacted>` to keep the
 * message diagnosable while losing the value.
 */
export const SECRET_HEADER_PATTERN = new RegExp(
  `\\b(${SENSITIVE_HEADER_NAMES.join('|')})\\b(\\s*[:=]\\s*)("?)((?:bearer|token)\\s+)?[^\\s,;"'}\\]]+`,
  'gi',
)

/** `?key=…` / `&api_key=…`. Group 1 is the `?key=` prefix; the value is dropped. */
export const SECRET_QUERY_PATTERN = new RegExp(
  `([?&](?:${SECRET_QUERY_PARAM_NAMES.join('|')})=)[^&\\s"'#]+`,
  'gi',
)

/**
 * Well-known credential FORMATS, redacted on shape alone — this is what catches a
 * key that was never configured: one echoed back by a provider, pasted into a
 * prompt, or read out of a file.
 *
 * Every entry is global so `String.replace` scrubs all occurrences. Reuse across
 * calls is safe: `replace` resets `lastIndex`.
 *
 * When you add an entry here, add a sample to `test/secrets.patterns.test.ts` —
 * that test asserts BOTH redactors catch every shape in this table, so a missing
 * sample fails the build rather than quietly covering one consumer.
 */
export const SECRET_KEY_SHAPES: readonly RegExp[] = [
  // Hyphen-delimited vendor prefixes: sk-…, gsk-…, sk-ant-…, sk-or-…, xai-…
  /\b(?:sk|pk|gsk|sk-ant|sk-or|xai|ghp|gho|github_pat)-[A-Za-z0-9_-]{6,}/gi,
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub personal access token
  /gho_[A-Za-z0-9]{20,}/g, // GitHub OAuth token
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, // Any bearer header value
]

/** Environment variable names whose values are treated as secrets by default. */
export const SECRET_ENV_NAME_PATTERN =
  /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL)/i

/** Replace every {@link SECRET_KEY_SHAPES} match in `text` with `replacement`. */
export function redactKeyShapes(text: string, replacement: string): string {
  let out = text
  for (const shape of SECRET_KEY_SHAPES) out = out.replace(shape, replacement)
  return out
}
