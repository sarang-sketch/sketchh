// Shared credential pattern tables. Internal: consumed by the two redactors
// (src/providers/redact.ts and src/events/redact.ts), not part of the public API.

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
