// Mobile <-> desktop sync bundle, format v2.
//
// This is a FILE BUNDLE sync, not live / real-time sync. The phone exports
// one JSON bundle (or imports one made on desktop), the two sides are merged
// by `updatedAt`, and that is the whole sync story. No network calls happen
// here; the bundle moves by file export/import (or Drive/GitHub) and the
// merge below is the only reconciliation.
//
// Hash: the manifest sha256 is a real SHA-256 over the canonical JSON of the
// files, computed with crypto.subtle when it is available. Where crypto.subtle
// is unavailable (old / non-secure contexts), the hash falls back to a
// synchronous FNV-1a checksum, stored with an explicit `fnv1a:` prefix. That
// fallback is a NON-cryptographic checksum — it is labelled as such everywhere
// it appears and is never called SHA-256.

import { newId } from './store'

export interface SyncFile {
  path: string
  content: string
  updatedAt: number
}

export interface SketchSyncBundle {
  format: 'sketch-sync'
  version: 2
  exportedAt: string
  app: 'sketch-mobile'
  project: { name: string; files: SyncFile[] }
  manifest: { fileCount: number; totalBytes: number; sha256: string }
}

export interface LastSyncInfo {
  exportedAt: string
  fileCount: number
}

export const LAST_SYNC_KEY = 'sketch-mobile:last-sync'

/** Maximum size of a single file in a bundle (5 MiB). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024

export const SYNC_FORMAT = 'sketch-sync'
export const SYNC_VERSION = 2

/** Byte length of a string as UTF-8. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * FNV-1a 32-bit checksum. NON-cryptographic — a fallback only, used when
 * crypto.subtle is unavailable. Never presented as SHA-256.
 */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  const bytes = new TextEncoder().encode(text)
  for (const b of bytes) {
    hash ^= b
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function subtleAvailable(): boolean {
  try {
    return typeof globalThis.crypto?.subtle?.digest === 'function'
  } catch {
    return false
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Hash of the canonical files JSON. Real SHA-256 (64 hex chars) when
 * crypto.subtle is available, otherwise `fnv1a:<hex>` — a labelled,
 * non-cryptographic fallback.
 */
export async function computeBundleHash(files: readonly SyncFile[]): Promise<string> {
  const canonical = canonicalFilesJson(files)
  if (subtleAvailable()) return sha256Hex(canonical)
  return `fnv1a:${fnv1aHex(canonical)}`
}

/** Canonical JSON of the files, sorted by path. */
export function canonicalFilesJson(files: readonly SyncFile[]): string {
  const sorted = [...files]
    .map((f) => ({ content: f.content, path: f.path, updatedAt: f.updatedAt }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return canonicalJson(sorted)
}

export function totalBytesOf(files: readonly SyncFile[]): number {
  return files.reduce((sum, f) => sum + byteLength(f.content), 0)
}

export interface SyncProjectInput {
  name: string
  files: readonly { path: string; content: string; updatedAt: number }[]
}

/** Build a v2 bundle from a project. Throws if a file exceeds 5 MiB or has a bad path. */
export async function createSyncBundle(project: SyncProjectInput): Promise<SketchSyncBundle> {
  const files: SyncFile[] = project.files.map((f) => ({ path: f.path, content: f.content, updatedAt: f.updatedAt }))
  const errors = validateFileList(files)
  if (errors.length > 0) throw new Error(`Cannot create sync bundle: ${errors.join('; ')}`)
  return {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'sketch-mobile',
    project: { name: project.name, files },
    manifest: {
      fileCount: files.length,
      totalBytes: totalBytesOf(files),
      sha256: await computeBundleHash(files),
    },
  }
}

export function syncBundleToJson(bundle: SketchSyncBundle): string {
  return JSON.stringify(bundle, null, 2)
}

/** Parse bundle JSON text. Returns the raw value (use validateSyncBundle to check it). */
export function parseSyncBundleJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  bundle?: SketchSyncBundle
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject `..` path segments, absolute paths and empty paths. */
export function isSafePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false
  return !path.split('/').some((segment) => segment === '..' || segment === '')
}

/** Structural + size + traversal checks on a file list (no hash check). */
export function validateFileList(files: readonly unknown[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  files.forEach((entry, i) => {
    const label = `files[${i}]`
    if (!isRecord(entry)) {
      errors.push(`${label} is not an object`)
      return
    }
    const { path, content, updatedAt } = entry
    if (typeof path !== 'string' || path === '') {
      errors.push(`${label}.path is missing or not a string`)
    } else {
      if (!isSafePath(path)) errors.push(`${label}.path ${JSON.stringify(path)} is unsafe (path traversal or absolute path)`)
      if (seen.has(path)) errors.push(`${label}.path ${JSON.stringify(path)} is duplicated`)
      seen.add(path)
    }
    if (typeof content !== 'string') {
      errors.push(`${label}.content is missing or not a string`)
    } else if (byteLength(content) > MAX_FILE_BYTES) {
      errors.push(`${label}.path ${JSON.stringify(path)} exceeds the 5 MiB per-file limit`)
    }
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
      errors.push(`${label}.updatedAt is missing or not a number`)
    }
  })
  return errors
}

/**
 * Validate a parsed bundle. Rejects the wrong format/version, a missing or
 * inconsistent manifest, a hash mismatch, oversized files and path traversal.
 */
export async function validateSyncBundle(value: unknown): Promise<ValidationResult> {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['Bundle is not an object'] }
  if (value.format !== SYNC_FORMAT) errors.push(`format must be ${JSON.stringify(SYNC_FORMAT)}, got ${JSON.stringify(value.format)}`)
  if (value.version !== SYNC_VERSION) errors.push(`version must be ${SYNC_VERSION}, got ${JSON.stringify(value.version)}`)
  if (value.app !== 'sketch-mobile') errors.push(`app must be "sketch-mobile", got ${JSON.stringify(value.app)}`)
  if (typeof value.exportedAt !== 'string' || Number.isNaN(Date.parse(value.exportedAt))) {
    errors.push('exportedAt is missing or not a valid date string')
  }
  if (!isRecord(value.project)) {
    errors.push('project is missing or not an object')
    return { ok: false, errors }
  }
  if (typeof value.project.name !== 'string' || value.project.name === '') errors.push('project.name is missing or empty')
  if (!Array.isArray(value.project.files)) {
    errors.push('project.files is missing or not an array')
    return { ok: false, errors }
  }
  const files = value.project.files as unknown[]
  const fileListErrors = validateFileList(files)
  errors.push(...fileListErrors)
  if (!isRecord(value.manifest)) {
    errors.push('manifest is missing or not an object')
    return { ok: false, errors }
  }
  const manifest = value.manifest
  if (typeof manifest.fileCount !== 'number' || manifest.fileCount !== files.length) {
    errors.push(`manifest.fileCount (${JSON.stringify(manifest.fileCount)}) does not match the file list (${files.length})`)
  }
  if (typeof manifest.totalBytes !== 'number' || manifest.totalBytes !== totalBytesOf(files as SyncFile[])) {
    errors.push('manifest.totalBytes does not match the file contents')
  }
  if (typeof manifest.sha256 !== 'string' || manifest.sha256 === '') {
    errors.push('manifest.sha256 is missing')
  } else if (fileListErrors.length === 0) {
    // Verify the hash whenever the file list itself is structurally sound,
    // even if the manifest counts are also wrong — a tampered bundle must
    // be reported as a hash mismatch, not only as a byte-count mismatch.
    const expected = manifest.sha256.startsWith('fnv1a:')
      ? `fnv1a:${fnv1aHex(canonicalFilesJson(files as SyncFile[]))}`
      : subtleAvailable()
        ? await sha256Hex(canonicalFilesJson(files as SyncFile[]))
        : null
    if (expected === null) {
      errors.push('manifest.sha256 cannot be verified in this environment (crypto.subtle is unavailable)')
    } else if (expected !== manifest.sha256) {
      errors.push('manifest.sha256 does not match the file contents (bundle may have been tampered with)')
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors: [], bundle: value as unknown as SketchSyncBundle }
}

export interface SyncConflict {
  path: string
  kept: 'incoming' | 'existing'
  reason: string
}

export interface ApplySyncResult {
  merged: { id: string; path: string; content: string; updatedAt: number }[]
  conflicts: SyncConflict[]
  added: string[]
  updated: string[]
  skipped: string[]
}

/**
 * Merge a validated bundle into the phone's existing files.
 * Newer `updatedAt` wins. Equal timestamps with different content are a
 * conflict: the existing file is kept and the conflict is reported. An older
 * incoming file, or identical content, is skipped (existing kept, no conflict).
 */
export function applySyncBundle(
  bundle: SketchSyncBundle,
  existingFiles: readonly { id: string; path: string; content: string; updatedAt: number }[],
): ApplySyncResult {
  const merged = existingFiles.map((f) => ({ ...f }))
  const byPath = new Map(merged.map((f) => [f.path, f]))
  const conflicts: SyncConflict[] = []
  const added: string[] = []
  const updated: string[] = []
  const skipped: string[] = []
  for (const incoming of bundle.project.files) {
    const existing = byPath.get(incoming.path)
    if (existing === undefined) {
      const file = { id: newId(), path: incoming.path, content: incoming.content, updatedAt: incoming.updatedAt }
      merged.push(file)
      byPath.set(incoming.path, file)
      added.push(incoming.path)
    } else if (existing.content === incoming.content) {
      skipped.push(incoming.path)
    } else if (incoming.updatedAt > existing.updatedAt) {
      existing.content = incoming.content
      existing.updatedAt = incoming.updatedAt
      updated.push(incoming.path)
    } else if (incoming.updatedAt === existing.updatedAt) {
      conflicts.push({
        path: incoming.path,
        kept: 'existing',
        reason: 'Same updatedAt but different content — kept the file already on this phone.',
      })
      skipped.push(incoming.path)
    } else {
      skipped.push(incoming.path)
    }
  }
  return { merged, conflicts, added, updated, skipped }
}

/** Last sync info, stored in localStorage under `sketch-mobile:last-sync`. */
export function getLastSync(storage: Storage = localStorage): LastSyncInfo | null {
  try {
    const raw = storage.getItem(LAST_SYNC_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<LastSyncInfo>
    if (typeof parsed.exportedAt !== 'string' || typeof parsed.fileCount !== 'number') return null
    return { exportedAt: parsed.exportedAt, fileCount: parsed.fileCount }
  } catch {
    return null
  }
}

export function setLastSync(info: LastSyncInfo, storage: Storage = localStorage): void {
  try {
    storage.setItem(LAST_SYNC_KEY, JSON.stringify(info))
  } catch {
    // Storage unavailable: the sync status lasts for this session only.
  }
}
