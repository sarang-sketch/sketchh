// The ONE place that picks a client implementation.
//
// Requirement 13.3: no React component may import a concrete client. Components
// take the `SketchClient` interface out of the provider in ./ClientProvider.tsx;
// this file is the only module that knows which class is instantiated. That is
// what makes swapping in the sidecar (task 2.1) a one-line change here.
//
// Validates: Requirements 13.2, 13.3

import type { SketchClient, TransportKind } from './client'
import { MockSketchClient, type MockClientOptions } from './mockClient'
import { StdioSketchClient } from './stdioClient'
import { HttpSketchClient } from './httpClient'

/** Values accepted in `VITE_BRIDGE`. */
export type BridgeSetting = TransportKind | 'auto'

export interface ResolveInput {
  /** Raw `import.meta.env.VITE_BRIDGE`, if set. */
  bridge?: string | undefined
  /** Whether the Tauri webview injected its internals. */
  hasTauri: boolean
}

const VALID: readonly BridgeSetting[] = ['mock', 'stdio', 'http', 'auto']

/**
 * Resolve the transport from the environment.
 *
 * - `VITE_BRIDGE=mock|stdio|http` selects explicitly and always wins.
 * - `VITE_BRIDGE=auto` picks the real transport for the host: sidecar inside
 *   Tauri, dev HTTP bridge in a plain browser.
 * - Unset behaves as `auto`.
 *
 * THE DEFAULT IS A REAL TRANSPORT. It used to be 'mock', which meant an app
 * started without `VITE_BRIDGE` set silently ran on fabricated data — the exact
 * thing Requirement 13.7 forbids. Now both real transports exist, so the mock is
 * reachable only by asking for it: `VITE_BRIDGE=mock`. A missing engine surfaces
 * as an error state, which is information; a mock in its place is not.
 */
export function resolveTransport({ bridge, hasTauri }: ResolveInput): TransportKind {
  const setting = (bridge ?? '').trim().toLowerCase()

  if (setting !== '' && !VALID.includes(setting as BridgeSetting)) {
    throw new Error(
      `VITE_BRIDGE="${bridge}" is not a transport. Use one of: ${VALID.join(', ')}.`,
    )
  }

  if (setting === 'mock' || setting === 'stdio' || setting === 'http') return setting
  // 'auto' and unset are the same rule.
  return hasTauri ? 'stdio' : 'http'
}

export interface CreateClientOptions {
  bridge?: string | undefined
  hasTauri?: boolean
  mock?: MockClientOptions
}

function detectTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function readBridgeEnv(): string | undefined {
  // Guarded so the factory is usable from a plain Node context too.
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  return env?.VITE_BRIDGE
}

export function createSketchClient(options: CreateClientOptions = {}): SketchClient {
  const transport = resolveTransport({
    bridge: options.bridge ?? readBridgeEnv(),
    hasTauri: options.hasTauri ?? detectTauri(),
  })

  switch (transport) {
    case 'mock':
      return new MockSketchClient(options.mock)

    case 'stdio':
      return new StdioSketchClient()

    case 'http':
      return new HttpSketchClient()
  }
}
