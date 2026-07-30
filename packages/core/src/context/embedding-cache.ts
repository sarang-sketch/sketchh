// The embedding cache — `<project>/.sketch/index/embeddings/<ab>/<key>.json`.
//
// ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
//
// Provider embeddings cost money, take a round trip, and require the network. A
// chunk's vector depends on nothing but the chunk's bytes and the model that
// embedded them, so it is cacheable forever. With this cache in place, a second
// index of an unchanged repository makes ZERO requests: every hit is a local
// file read, so it is free and it works offline.
//
// ── THE KEY, AND WHY EVERY PART OF IT IS THERE ──────────────────────────────
//
//   sha256( version \n providerId \n model \n dimensions \n contentHash )
//
//   * contentHash — a changed chunk is a different chunk. Without it the cache
//     serves the old vector for edited code, which is the worst failure mode
//     available: retrieval that is confidently stale.
//   * model — vectors from two models live in different spaces. A cosine between
//     `text-embedding-3-small` and `text-embedding-3-large` is noise, not a
//     weaker signal.
//   * providerId — two endpoints can advertise the same model name and return
//     different vectors (a gateway, a self-hosted build, a fine-tune). Keying on
//     the model alone would silently mix spaces across a `baseUrl` change.
//   * dimensions — the same model can be asked for a truncated vector; a 256-wide
//     and a 1536-wide vector are not interchangeable, and a length mismatch would
//     otherwise surface as a cosine of 0 rather than as a miss.
//
// The stored record repeats those fields and they are CHECKED on read. The key
// already separates them, so this is belt and braces against a hash collision, a
// half-written file, or a hand-edited cache — a mismatch is a miss, never a
// wrong vector.
//
// ── WHAT IS NOT IN THE FILE ─────────────────────────────────────────────────
//
// No chunk text, no file path, no api key, no url, no header. A cache entry is a
// hash and a list of numbers. The text is deliberately absent: the cache is
// keyed by content hash, so it never needs the content, and a cache that stored
// source text would be a second copy of the repository with none of git's
// hygiene. `test/embeddings.test.ts` asserts the bytes on disk contain no key
// material.
//
// Writes are atomic (temp file then rename) and every failure is swallowed: a
// cache is an optimisation, and a read-only `.sketch/` must slow an index build
// down, not fail it. `CacheStats.errors` counts what was swallowed so the
// silence is still observable.
//
// Validates: Requirements 18.3

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureStateDir } from '../workspace/state-dir.js'
import type { EmbedderIdentity } from './embedder.js'

/** Bumped when the record shape changes. A mismatch is a miss, not an error. */
export const EMBEDDING_CACHE_VERSION = 1

/** `<baseDir>/.sketch/index/embeddings`. */
export function embeddingsDir(baseDir: string): string {
  return join(baseDir, '.sketch', 'index', 'embeddings')
}

/** sha256 of the text, hex. The content half of a cache key. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The cache key. Every component that can change the vector is in the preimage,
 * separated by a character none of them can contain, so no two distinct tuples
 * can be spelled the same way.
 */
export function embeddingCacheKey(identity: EmbedderIdentity, hash: string): string {
  const preimage = [
    `v${EMBEDDING_CACHE_VERSION}`,
    identity.providerId,
    identity.model,
    String(identity.dimensions),
    hash,
  ].join('\n')
  return createHash('sha256').update(preimage, 'utf8').digest('hex')
}

/** One cached vector. Written as JSON; read back with every field verified. */
export interface EmbeddingCacheRecord {
  version: number
  providerId: string
  model: string
  dimensions: number
  /** sha256 of the embedded text. The text itself is never stored. */
  contentHash: string
  vector: number[]
}

export interface CacheStats {
  hits: number
  misses: number
  writes: number
  /** Files read from disk. Lower than `hits` once the in-process memo warms up. */
  diskReads: number
  /** Read/write failures and rejected records. Swallowed, but counted. */
  errors: number
}

/** The seam. A store-backed cache can replace the file one without touching callers. */
export interface EmbeddingCache {
  get(identity: EmbedderIdentity, hash: string): Promise<number[] | null>
  set(identity: EmbedderIdentity, hash: string, vector: number[]): Promise<void>
  readonly stats: CacheStats
}

/**
 * `.sketch/index/embeddings/<key[0:2]>/<key>.json`, sharded two hex characters
 * deep — the same layout as the response cache in the `.sketch/` contract. Flat
 * directories with a hundred thousand entries are slow to list on every platform
 * that matters.
 */
export class FileEmbeddingCache implements EmbeddingCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, writes: 0, diskReads: 0, errors: 0 }

  /** In-process memo, so a repeated chunk in one run does not re-read the file. */
  private readonly memo = new Map<string, number[]>()
  private readonly dir: string

  constructor(private readonly baseDir: string) {
    this.dir = embeddingsDir(baseDir)
  }

  /** Absolute path of a key's record. Exposed so tests can inspect the bytes. */
  pathFor(key: string): string {
    return join(this.dir, key.slice(0, 2), `${key}.json`)
  }

  async get(identity: EmbedderIdentity, hash: string): Promise<number[] | null> {
    const key = embeddingCacheKey(identity, hash)

    const memoised = this.memo.get(key)
    if (memoised !== undefined) {
      this.stats.hits++
      return memoised
    }

    let text: string
    try {
      this.stats.diskReads++
      text = await readFile(this.pathFor(key), 'utf8')
    } catch {
      // Absent is the common case and is not an error.
      this.stats.misses++
      return null
    }

    const record = parseRecord(text)
    // Every field is re-checked against what the caller asked for. A record that
    // does not match is treated as absent: a stale or corrupt file must never
    // become a wrong vector.
    if (
      record === null ||
      record.version !== EMBEDDING_CACHE_VERSION ||
      record.providerId !== identity.providerId ||
      record.model !== identity.model ||
      record.dimensions !== identity.dimensions ||
      record.contentHash !== hash ||
      record.vector.length !== identity.dimensions
    ) {
      this.stats.errors++
      this.stats.misses++
      return null
    }

    this.memo.set(key, record.vector)
    this.stats.hits++
    return record.vector
  }

  async set(identity: EmbedderIdentity, hash: string, vector: number[]): Promise<void> {
    if (vector.length !== identity.dimensions) {
      // Refuse rather than persist a vector that can never be served.
      this.stats.errors++
      return
    }

    const key = embeddingCacheKey(identity, hash)
    this.memo.set(key, vector)

    const record: EmbeddingCacheRecord = {
      version: EMBEDDING_CACHE_VERSION,
      providerId: identity.providerId,
      model: identity.model,
      dimensions: identity.dimensions,
      contentHash: hash,
      vector,
    }

    const target = this.pathFor(key)
    // `.sketch/` gets its self-ignore marker before anything lands inside it.
    const tmp = `${target}.${process.pid}.tmp`
    try {
      await ensureStateDir(this.baseDir)
      await mkdir(join(this.dir, key.slice(0, 2)), { recursive: true })
      await writeFile(tmp, `${JSON.stringify(record)}\n`, 'utf8')
      // Rename is atomic on both platforms we ship: a reader sees the whole file
      // or no file, never a truncated one.
      await rename(tmp, target)
      this.stats.writes++
    } catch {
      this.stats.errors++
      await unlink(tmp).catch(() => {})
    }
  }
}

/** In-memory cache. For tests and for callers that do not want a `.sketch/` dir. */
export class MemoryEmbeddingCache implements EmbeddingCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, writes: 0, diskReads: 0, errors: 0 }
  private readonly entries = new Map<string, number[]>()

  async get(identity: EmbedderIdentity, hash: string): Promise<number[] | null> {
    const found = this.entries.get(embeddingCacheKey(identity, hash))
    if (found === undefined) {
      this.stats.misses++
      return null
    }
    this.stats.hits++
    return found
  }

  async set(identity: EmbedderIdentity, hash: string, vector: number[]): Promise<void> {
    this.entries.set(embeddingCacheKey(identity, hash), vector)
    this.stats.writes++
  }
}

function parseRecord(text: string): EmbeddingCacheRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Partial<EmbeddingCacheRecord>
  if (
    typeof r.version !== 'number' ||
    typeof r.providerId !== 'string' ||
    typeof r.model !== 'string' ||
    typeof r.dimensions !== 'number' ||
    typeof r.contentHash !== 'string' ||
    !Array.isArray(r.vector) ||
    !r.vector.every(v => typeof v === 'number' && Number.isFinite(v))
  ) {
    return null
  }
  return {
    version: r.version,
    providerId: r.providerId,
    model: r.model,
    dimensions: r.dimensions,
    contentHash: r.contentHash,
    vector: r.vector,
  }
}
