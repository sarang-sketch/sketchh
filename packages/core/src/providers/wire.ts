// Small shared helpers for the dependency-free ChatAdapter implementations.

import type { ProviderConfig } from '../types.js'

/**
 * Optional generation controls for the two built-in adapters.
 *
 * NOT part of the `ChatAdapter` contract (`types.ts` is the spec's file and only names
 * `signal`). A caller that wants a short, cheap answer — inline completion is the one
 * that does — builds one of these and passes it where the contract expects
 * `{ signal }`. The built-in adapters honour the extra keys; any other adapter, a test
 * double included, simply ignores them, which is the safe degradation: a longer answer
 * that the caller clips, never a refused call.
 */
export interface ChatCallOptions {
  signal?: AbortSignal
  /** Upper bound on generated tokens. */
  maxTokens?: number
  /** Sampling temperature; low for completion, where creativity is a bug. */
  temperature?: number
  /** Stop sequences, where the endpoint supports them. */
  stop?: string[]
}

/** The generation-control fields of a `ChatCallOptions`, validated and bounded. */
export function generationControls(options: ChatCallOptions | undefined): {
  maxTokens?: number
  temperature?: number
  stop?: string[]
} {
  if (options === undefined) return {}
  const out: { maxTokens?: number; temperature?: number; stop?: string[] } = {}
  if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    out.maxTokens = Math.min(32_768, Math.floor(options.maxTokens))
  }
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    out.temperature = Math.max(0, Math.min(2, options.temperature))
  }
  if (Array.isArray(options.stop)) {
    const stop = options.stop.filter((s): s is string => typeof s === 'string' && s !== '').slice(0, 4)
    if (stop.length > 0) out.stop = stop
  }
  return out
}

// Header names whose configured value must be treated as credential material.
const SECRET_HEADER_NAME = /(authorization|key|token|secret|password)/i

/** Strip trailing slashes so `${baseUrl}/path` never produces a double slash. */
export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Everything in a config that must never reach an error message: the api key plus
 * the values of any credential-shaped custom header.
 */
export function collectSecrets(config: ProviderConfig): string[] {
  const secrets: string[] = []
  if (config.apiKey) secrets.push(config.apiKey)
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (SECRET_HEADER_NAME.test(name) && value) secrets.push(value)
  }
  return secrets
}
