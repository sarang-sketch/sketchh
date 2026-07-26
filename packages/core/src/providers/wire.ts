// Small shared helpers for the dependency-free ChatAdapter implementations.

import type { ProviderConfig } from '../types.js'

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
