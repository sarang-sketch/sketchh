// View logic for the Provider Settings surface. Pure functions, no React, no IO.
//
// The panel renders what these return. Keeping the decisions here is the same
// discipline `git/gitStatus.ts` follows: the interesting rules — which row is
// configured, what a never-run test is allowed to claim, whether a draft is
// savable — are testable without a DOM.
//
// ONE THING HERE IS DELIBERATELY A SECOND OPINION, AND IT IS NOT THE AUTHORITY.
// `previewEndpoint` re-checks the scheme so the user sees the URL that will
// actually be called while they type. The authority is the engine's
// `checkEndpoint` (packages/core/src/settings/providerSettings.ts): the panel saves,
// the engine sanitizes, and the panel then renders WHAT THE ENGINE WROTE. If the two
// ever disagree, the engine's answer is the one on screen — see
// `refusedEntries` below, which is how a locally-accepted endpoint that the engine
// rejected becomes a visible message instead of a silent no-op.
//
// Validates: Requirements 17.1, 17.2, 27.1, 27.3

import type {
  ProviderDescriptor,
  ProviderSettingsEntry,
  ProviderTestResult,
} from '../lib/contracts'
import type { ProviderTestState } from '../state/AppState'

/**
 * True when the endpoint is on THIS machine. Loopback only, and read off the URL
 * that will actually be called rather than off a stored flag: a "local" runtime
 * pointed at someone else's box is not the $0-on-this-machine story, and the row
 * must not keep claiming it is (Requirement 27.3).
 */
export function isLocalEndpoint(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

/**
 * Whether the form offers a key box. The registry decides for a catalog row; for a
 * row the registry does not know — a custom endpoint — the endpoint decides, and
 * anything not on this machine is assumed to want a credential.
 */
export function keyRequired(descriptor: ProviderDescriptor, baseUrl: string): boolean {
  return descriptor.needsKey || !isLocalEndpoint(baseUrl)
}

/** One row of the matrix: a catalog entry, and the configuration if it has one. */
export interface ProviderRow {
  descriptor: ProviderDescriptor
  /** Present when this provider is in `providers.json`. */
  entry: ProviderSettingsEntry | null
  configured: boolean
}

/**
 * The full matrix, configured providers first, then the rest in catalog order.
 * A configured provider whose id is NOT in the catalog (a custom endpoint saved
 * under its own id) still gets a row, built from the entry itself — dropping it
 * would hide a provider the engine will happily use.
 */
export function providerRows(
  catalog: readonly ProviderDescriptor[],
  configured: readonly ProviderSettingsEntry[],
): ProviderRow[] {
  const byId = new Map(configured.map((entry) => [entry.id, entry]))
  const rows: ProviderRow[] = catalog.map((descriptor) => {
    const entry = byId.get(descriptor.id) ?? null
    return { descriptor, entry, configured: entry !== null }
  })

  for (const entry of configured) {
    if (catalog.some((descriptor) => descriptor.id === entry.id)) continue
    rows.push({
      descriptor: {
        id: entry.id,
        name: entry.label,
        kind: entry.kind,
        defaultBaseUrl: entry.baseUrl,
        // Nothing in the registry describes this row, so nothing is asserted about
        // it: whether it wants a credential is read off the endpoint, and a
        // user-supplied endpoint is never claimed to be serverless.
        needsKey: !isLocalEndpoint(entry.baseUrl),
        serverless: false,
      },
      entry,
      configured: true,
    })
  }

  return [...rows.filter((row) => row.configured), ...rows.filter((row) => !row.configured)]
}

/** How a connection-test state reads on screen. `never-run` is not a failure. */
export interface TestSummary {
  tone: 'idle' | 'busy' | 'ok' | 'error'
  label: string
  detail: string
}

export const NEVER_RUN: ProviderTestState = { status: 'never-run' }

export function describeTest(state: ProviderTestState | undefined): TestSummary {
  const current = state ?? NEVER_RUN
  switch (current.status) {
    case 'never-run':
      return {
        tone: 'idle',
        label: 'Not tested',
        detail: 'No connection test has been run, so nothing is known about this endpoint yet.',
      }
    case 'testing':
      return { tone: 'busy', label: 'Testing…', detail: 'Contacting the endpoint.' }
    case 'ok':
      return { tone: 'ok', label: 'Reachable', detail: current.message }
    case 'cancelled':
      return {
        tone: 'idle',
        label: 'Not tested',
        detail: 'The last connection test was cancelled before it finished.',
      }
    case 'failed':
      return { tone: 'error', label: FAILURE_LABELS[current.code] ?? 'Failed', detail: current.message }
  }
}

/**
 * A short label per failure code. The three that matter are three different
 * problems with three different fixes, and the surface must not blur them into one
 * "connection failed" (Requirement 17.1).
 */
const FAILURE_LABELS: Record<string, string> = {
  unreachable: 'Unreachable',
  unauthorized: 'Key rejected',
  forbidden: 'Not permitted',
  'rate-limited': 'Rate limited',
  'model-not-found': 'Model not found',
  'malformed-response': 'Malformed response',
  'invalid-endpoint': 'Bad endpoint',
  'endpoint-error': 'Endpoint error',
  timeout: 'No answer',
  cancelled: 'Cancelled',
}

/** Turn an engine verdict into the state the reducer stores. */
export function stateFromResult(result: ProviderTestResult, at: number): ProviderTestState {
  if (result.ok) return { status: 'ok', message: result.message, at }
  if (result.code === 'cancelled') return { status: 'cancelled', at }
  return { status: 'failed', code: result.code, message: result.message, at }
}

// ── drafts ──────────────────────────────────────────────────────────────────

/**
 * The form's working copy of one provider: the five persisted fields and nothing
 * else. There is no key field, and no deployment flag either — deployment is the
 * registry's to state and the endpoint's to imply, never the form's to invent.
 */
export interface ProviderDraft {
  id: string
  kind: ProviderSettingsEntry['kind']
  baseUrl: string
  model: string
  label: string
}

/** A draft for a catalog row, prefilled with the registry's default endpoint. */
export function draftFor(descriptor: ProviderDescriptor, entry: ProviderSettingsEntry | null): ProviderDraft {
  return {
    id: entry?.id ?? descriptor.id,
    kind: entry?.kind ?? descriptor.kind,
    baseUrl: entry?.baseUrl ?? descriptor.defaultBaseUrl,
    model: entry?.model ?? '',
    label: entry?.label ?? descriptor.name,
  }
}

export interface EndpointPreview {
  ok: boolean
  /** The URL the app will call, as far as this pre-flight can tell. */
  resolvedUrl: string
  reason?: string
}

/**
 * PRE-FLIGHT ONLY (see the module note). Refuses a non-http(s) scheme and shows the
 * resolved URL, so the user is not guessing what will be called.
 */
export function previewEndpoint(raw: string): EndpointPreview {
  const text = raw.trim()
  if (text === '') return { ok: false, resolvedUrl: '', reason: 'Enter the endpoint URL.' }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return {
      ok: false,
      resolvedUrl: text,
      reason: 'Include the scheme, for example http://localhost:11434/v1',
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      resolvedUrl: text,
      reason: `The scheme ${url.protocol.replace(':', '')} is not supported. Use http or https.`,
    }
  }
  if (url.username !== '' || url.password !== '' || url.search !== '') {
    return {
      ok: false,
      resolvedUrl: `${url.protocol}//${url.host}${url.pathname}`,
      reason: 'Give a bare base URL. Credentials and query strings are not stored or sent from here.',
    }
  }
  return { ok: true, resolvedUrl: `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '') }
}

/** Why a draft cannot be saved yet, or null when it can. */
export function draftBlocker(draft: ProviderDraft): string | null {
  if (draft.id.trim() === '') return 'Give the provider an id.'
  if (draft.model.trim() === '') return 'Name the model to use.'
  const endpoint = previewEndpoint(draft.baseUrl)
  return endpoint.ok ? null : (endpoint.reason ?? 'The endpoint URL is not usable.')
}

/** The entry a draft becomes. Every persisted field is explicitly non-secret. */
export function entryFromDraft(draft: ProviderDraft): ProviderSettingsEntry {
  return {
    id: draft.id.trim(),
    kind: draft.kind,
    baseUrl: previewEndpoint(draft.baseUrl).resolvedUrl,
    model: draft.model.trim(),
    label: draft.label.trim() === '' ? draft.id.trim() : draft.label.trim(),
  }
}

/**
 * Ids that were sent to the engine but are not in what came back — i.e. the engine
 * refused them. This is what keeps the pre-flight from becoming an authority.
 */
export function refusedEntries(
  sent: readonly ProviderSettingsEntry[],
  written: readonly ProviderSettingsEntry[],
): string[] {
  const kept = new Set(written.map((entry) => entry.id))
  return sent.filter((entry) => !kept.has(entry.id)).map((entry) => entry.id)
}
