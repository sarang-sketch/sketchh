// Key-free provider configuration: `~/.sketch/providers.json`.
//
// THE FILE NEVER HOLDS A CREDENTIAL (Requirement 17.2). That is enforced twice,
// deliberately, because one guard is one deletion away from a leak:
//
//   1. `sanitizeEntry` is a WHITELIST. Exactly five fields are copied out of a
//      caller's object; everything else — `apiKey`, `headers`, `token`, a field
//      nobody has invented yet — is dropped because it was never named. A
//      blacklist would have to be taught every new key spelling.
//   2. `assertKeyFree` re-reads the SERIALIZED BYTES and refuses to write them if
//      anything in them looks like a credential, using the same pattern table the
//      event-log redactor uses (`src/secrets/patterns.ts`). So a key smuggled
//      inside a whitelisted field — a `baseUrl` with `?api_key=…`, a `model`
//      pasted from a curl line — still cannot reach disk.
//
// A key is supplied to the engine at invocation time, as a function argument
// (`toProviderConfig`), and is never a field on anything this module persists.
//
// Validates: Requirements 17.1, 17.2, 17.4

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ProviderConfig, ProviderKind, SecretStore } from '../types.js'
import { PROVIDER_CATALOG, describeProvider } from '../providers/registry.js'
import type { ProviderDescriptor } from '../providers/registry.js'
import {
  SECRET_HEADER_PATTERN,
  SECRET_KEY_SHAPES,
  SECRET_QUERY_PATTERN,
  isSensitiveKeyName,
} from '../secrets/patterns.js'

/** The two provider kinds the canonical adapter layer speaks. */
const PROVIDER_KINDS: readonly ProviderKind[] = ['openai-compatible', 'anthropic-messages']

/**
 * One configured provider, as persisted. Five fields, all of them non-secret:
 * which catalog entry (or custom endpoint) it is, how to reach it, and which model
 * to ask for.
 */
export interface ProviderSettingsEntry {
  /** Catalog id, or a caller-chosen id for a custom endpoint. */
  id: string
  kind: ProviderKind
  /** The endpoint that will actually be called. Never carries a query credential. */
  baseUrl: string
  model: string
  /** What the picker shows. Defaults to the catalog name. */
  label: string
}

/** The whole file. Versioned so a later shape change is detectable, not guessed. */
export interface ProviderSettingsFile {
  version: 1
  providers: ProviderSettingsEntry[]
  /** Id of the provider a run uses by default. Null when nothing is configured. */
  selected: string | null
}

export const PROVIDER_SETTINGS_VERSION = 1 as const

/** Nothing configured. The honest starting state, and what a missing file means. */
export function emptyProviderSettings(): ProviderSettingsFile {
  return { version: PROVIDER_SETTINGS_VERSION, providers: [], selected: null }
}

/** `~/.sketch/providers.json`. The home directory is injectable for tests. */
export function providersFilePath(home: string = homedir()): string {
  return join(home, '.sketch', 'providers.json')
}

// ── validation ───────────────────────────────────────────────────────────────

/** What an endpoint is, or precisely why it is not usable. */
export interface EndpointCheck {
  ok: boolean
  /** The URL that will actually be called — shown to the user before they save. */
  resolvedUrl: string
  /** Present when `ok` is false. Names the problem in the user's terms. */
  reason?: string
}

/**
 * Validate a custom endpoint. Refuses a non-http(s) scheme, refuses credentials
 * in the URL, and reports the resolved form (trailing slashes trimmed) so the user
 * sees the address the app will call rather than the one they typed.
 */
export function checkEndpoint(raw: string): EndpointCheck {
  const text = raw.trim()
  if (text === '') {
    return { ok: false, resolvedUrl: '', reason: 'the endpoint URL is empty' }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return {
      ok: false,
      resolvedUrl: text,
      reason: `'${text}' is not a URL — include the scheme, for example http://localhost:11434/v1`,
    }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      resolvedUrl: text,
      reason: `the scheme '${url.protocol.replace(':', '')}' is not supported — use http or https`,
    }
  }

  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      resolvedUrl: `${url.protocol}//${url.host}${url.pathname}`,
      reason: 'the URL carries credentials — supply the key separately, not in the address',
    }
  }

  if (url.search !== '') {
    return {
      ok: false,
      resolvedUrl: `${url.protocol}//${url.host}${url.pathname}`,
      reason: 'the URL carries a query string — the endpoint must be a bare base URL',
    }
  }

  return { ok: true, resolvedUrl: `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '') }
}

// ── the key-free guard ───────────────────────────────────────────────────────

/** Why a payload was refused, when it was. */
export class SecretInSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretInSettingsError'
  }
}

/**
 * Refuse text that contains credential material.
 *
 * Called on the SERIALIZED bytes immediately before they are written, which is the
 * last point where a key can still be stopped. It checks three things, all from
 * the shared table: a credential-shaped JSON key name, a credential-shaped header
 * or query fragment, and a well-known key FORMAT wherever it appears.
 */
export function assertKeyFree(text: string, where: string): void {
  for (const [, name] of text.matchAll(/"([^"\\]+)"\s*:/g)) {
    if (isSensitiveKeyName(name)) {
      throw new SecretInSettingsError(
        `${where} would contain the credential-shaped field '${name}' — provider settings hold no key material (Requirement 17.2)`,
      )
    }
  }

  for (const shape of SECRET_KEY_SHAPES) {
    if (shape.test(text)) {
      shape.lastIndex = 0
      throw new SecretInSettingsError(
        `${where} would contain something shaped like an API key — provider settings hold no key material (Requirement 17.2)`,
      )
    }
    shape.lastIndex = 0
  }

  for (const pattern of [SECRET_HEADER_PATTERN, SECRET_QUERY_PATTERN]) {
    if (pattern.test(text)) {
      pattern.lastIndex = 0
      throw new SecretInSettingsError(
        `${where} would contain a credential-carrying header or query parameter — provider settings hold no key material (Requirement 17.2)`,
      )
    }
    pattern.lastIndex = 0
  }
}

// ── sanitizing ───────────────────────────────────────────────────────────────

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Copy the five persisted fields out of an arbitrary object. A WHITELIST: nothing
 * that is not named here survives, so a caller handing over a live
 * `ProviderConfig` — key, headers and all — yields an entry with neither.
 *
 * Returns `null` when what is left is not a usable provider, so a half-filled form
 * row cannot become a configured provider that fails at run time.
 */
export function sanitizeEntry(value: unknown): ProviderSettingsEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>

  const id = stringField(source, 'id')
  if (id === '') return null

  const descriptor = describeProvider(id)
  const rawKind = stringField(source, 'kind')
  const kind: ProviderKind = PROVIDER_KINDS.includes(rawKind as ProviderKind)
    ? (rawKind as ProviderKind)
    : (descriptor?.kind ?? 'openai-compatible')

  const rawBaseUrl = stringField(source, 'baseUrl') || (descriptor?.defaultBaseUrl ?? '')
  const endpoint = checkEndpoint(rawBaseUrl)
  if (!endpoint.ok) return null

  const model = stringField(source, 'model')
  if (model === '') return null

  // Deployment metadata — serverless, key-required — is NOT persisted here. It is
  // registry data (`ProviderDescriptor`), looked up by id, so the file cannot drift
  // out of step with the catalog and a stale row cannot claim a cost or privacy
  // story the engine does not agree with.
  return {
    id,
    kind,
    baseUrl: endpoint.resolvedUrl,
    model,
    label: stringField(source, 'label') || descriptor?.name || id,
  }
}

/**
 * Sanitize a whole file's worth of settings. Later duplicates of an id lose to
 * earlier ones, and `selected` is dropped unless it names a surviving provider —
 * a selection pointing at nothing is how the UI ends up claiming a provider is
 * active when none is.
 */
export function sanitizeSettings(value: unknown): ProviderSettingsFile {
  const source =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}

  const list = Array.isArray(source['providers']) ? (source['providers'] as unknown[]) : []
  const providers: ProviderSettingsEntry[] = []
  const seen = new Set<string>()
  for (const candidate of list) {
    const entry = sanitizeEntry(candidate)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    providers.push(entry)
  }

  const wanted = typeof source['selected'] === 'string' ? source['selected'] : null
  const selected =
    wanted !== null && seen.has(wanted) ? wanted : (providers[0]?.id ?? null)

  return { version: PROVIDER_SETTINGS_VERSION, providers, selected }
}

/**
 * The bytes that go to disk: sanitized, key-checked, deterministic (fields in a
 * fixed order, providers sorted by id) so a rewrite with no change produces no
 * diff.
 */
export function serializeProviderSettings(value: unknown): string {
  const settings = sanitizeSettings(value)
  const ordered = {
    version: settings.version,
    selected: settings.selected,
    providers: [...settings.providers]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        baseUrl: entry.baseUrl,
        model: entry.model,
        label: entry.label,
      })),
  }
  const text = `${JSON.stringify(ordered, null, 2)}\n`
  assertKeyFree(text, 'providers.json')
  return text
}

// ── corrupt-file backup (shared by the whole-file JSON config loaders) ────────

/**
 * Move an unreadable config file aside so the app starts clean WITHOUT deleting the
 * user's data: the bytes are preserved at `<path>.corrupt-<timestamp>`, never removed.
 *
 * Called only when a config file is genuinely corrupt — invalid JSON, or JSON that is
 * not the object shape the file must have. It is NOT called for a missing file (that is
 * the honest empty state) and NOT for a file that merely contains an unexpected extra
 * field (the sanitizer handles that without losing the file). The move is best-effort:
 * a failure to rename is reported in the returned reason and never throws into the
 * loader, so a read-only directory or a locked file still yields a clean start rather
 * than a crash.
 *
 * Both whole-file config loaders write through temp-then-rename, so a reader never sees
 * a half-written file; "corrupt" therefore means a hand-edit or disk damage, which is
 * safe to set aside. Returns the backup path on success, or null with the reason.
 */
export async function backupCorruptConfig(
  path: string,
  rename_: (from: string, to: string) => Promise<void> = rename,
): Promise<{ backedUpTo: string } | { backedUpTo: null; reason: string }> {
  // A filesystem-safe timestamp: colons are illegal on Windows, so use a compact form.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${path}.corrupt-${stamp}`
  try {
    await rename_(path, backup)
    return { backedUpTo: backup }
  } catch (err) {
    return { backedUpTo: null, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ── file IO ──────────────────────────────────────────────────────────────────

/** Structural problems in a parsed file. Values are never echoed into diagnostics. */
function malformedSettings(value: unknown, path: string): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} is malformed: the root must be an object`]
  }
  const source = value as Record<string, unknown>
  const issues: string[] = []
  if (source['version'] !== PROVIDER_SETTINGS_VERSION) {
    issues.push(`${path} is malformed: version must be ${PROVIDER_SETTINGS_VERSION}`)
  }
  if (!Array.isArray(source['providers'])) {
    issues.push(`${path} is malformed: providers must be an array`)
  } else {
    const seen = new Set<string>()
    source['providers'].forEach((candidate, index) => {
      const entry = sanitizeEntry(candidate)
      if (!entry) issues.push(`${path} is malformed: providers[${index}] is not a usable provider`)
      else if (seen.has(entry.id)) issues.push(`${path} is malformed: provider id '${entry.id}' is duplicated`)
      else seen.add(entry.id)
    })
  }
  if (source['selected'] !== null && typeof source['selected'] !== 'string') {
    issues.push(`${path} is malformed: selected must be a provider id or null`)
  }
  return issues
}

/**
 * Read the configuration. A missing file is not an error — it is "no provider
 * configured", which the UI states plainly. Unparseable or hostile content is
 * reported, not silently replaced, and a key found in a hand-edited file is
 * stripped rather than loaded (the sanitizer's whitelist does that for free).
 */
export async function loadProviderSettings(
  path: string = providersFilePath(),
): Promise<{ settings: ProviderSettingsFile; path: string; diagnostic?: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') return { settings: emptyProviderSettings(), path }
    return {
      settings: emptyProviderSettings(),
      path,
      diagnostic: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // Genuinely corrupt JSON: set the file aside (never deleted) so the next save
    // starts clean, and say plainly where the old bytes went.
    const moved = await backupCorruptConfig(path)
    const where =
      moved.backedUpTo !== null
        ? ` The unreadable file was moved to ${moved.backedUpTo}; a fresh one will be written when you change a setting.`
        : ` The unreadable file could not be moved aside (${moved.reason}); fix or remove it by hand.`
    return {
      settings: emptyProviderSettings(),
      path,
      diagnostic: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}.${where}`,
    }
  }

  const settings = sanitizeSettings(parsed)
  const diagnostics = malformedSettings(parsed, path)
  // A file that carried key material is a finding, not a normal load: the user
  // needs to know their key is sitting in a plain file so they can rotate it.
  try {
    assertKeyFree(raw, path)
  } catch (err) {
    diagnostics.push(
      `${path} contained credential-shaped content, which was NOT loaded. ` +
        `Remove it and store the key in the OS credential store instead. (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  return diagnostics.length === 0
    ? { settings, path }
    : { settings, path, diagnostic: diagnostics.join(' ') }
}

/** File operations injected only to prove failed replacement leaves the old file intact. */
export interface ProviderSettingsIO {
  mkdir(path: string): Promise<void>
  writeTemp(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

const DEFAULT_PROVIDER_SETTINGS_IO: ProviderSettingsIO = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }) },
  writeTemp: async (path, text) => {
    await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  },
  rename,
  remove: async (path) => { await rm(path, { force: true }) },
}

/** A named, useful failure from the atomic persistence boundary. */
export class ProviderSettingsWriteError extends Error {
  constructor(path: string, cause: unknown) {
    super(`could not atomically replace provider settings at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ProviderSettingsWriteError'
  }
}

/**
 * Write through a same-directory temporary file, then atomically rename it over the
 * destination. The live file is never opened with truncation, so any failure before
 * the rename leaves the previous configuration byte-for-byte intact.
 */
export async function saveProviderSettings(
  value: unknown,
  path: string = providersFilePath(),
  io: ProviderSettingsIO = DEFAULT_PROVIDER_SETTINGS_IO,
): Promise<{ settings: ProviderSettingsFile; path: string }> {
  const text = serializeProviderSettings(value)
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await io.mkdir(dirname(path))
    await io.writeTemp(temp, text)
    await io.rename(temp, path)
  } catch (err) {
    try {
      await io.remove(temp)
    } catch {
      // Cleanup must not replace the useful write/rename diagnostic.
    }
    throw new ProviderSettingsWriteError(path, err)
  }
  // Return exactly the normalized, ordered shape whose bytes reached disk.
  return { settings: JSON.parse(text) as ProviderSettingsFile, path }
}

// ── handing a provider to the engine ─────────────────────────────────────────

/**
 * Turn a persisted entry into the config a run needs, with the key supplied HERE,
 * as an argument, for this call only (Requirement 17.4). Nothing about the return
 * value is stored: it is built, used, and dropped.
 */
export function toProviderConfig(
  entry: ProviderSettingsEntry,
  apiKey?: string,
): ProviderConfig {
  const config: ProviderConfig = {
    id: entry.id,
    kind: entry.kind,
    baseUrl: entry.baseUrl,
    model: entry.model,
  }
  if (apiKey !== undefined && apiKey !== '') config.apiKey = apiKey
  return config
}

/**
 * Build the config for a run, resolving the key from a host `SecretStore` AT THE
 * MOMENT OF THE CALL (Requirement 17.4).
 *
 * This is the whole of the key's lifetime in the engine: it is read here, handed to
 * `toProviderConfig`, and lives only as long as the `ProviderConfig` the caller uses
 * for that one invocation. It is not cached, not returned separately, not attached to
 * the entry, and not put in an environment variable a child could inherit.
 *
 * A store that has no key for this provider is NOT an error: a local endpoint needs
 * none, and the adapter is the thing that knows whether the call can proceed without
 * one. A store that FAILS is an error, and it is reported by provider id — never with
 * anything the store returned in the message.
 */
export async function resolveProviderConfig(
  entry: ProviderSettingsEntry,
  secretStore: SecretStore,
): Promise<ProviderConfig> {
  let apiKey: string | null
  try {
    apiKey = await secretStore.get(entry.id)
  } catch (err) {
    throw new Error(
      `could not read the stored key for provider '${entry.id}': ${
        err instanceof Error ? err.message : 'the credential store refused the read'
      }`,
    )
  }
  return toProviderConfig(entry, apiKey ?? undefined)
}

/** The full matrix the settings surface lists. Straight from the registry. */
export function providerMatrix(): readonly ProviderDescriptor[] {
  return PROVIDER_CATALOG
}
