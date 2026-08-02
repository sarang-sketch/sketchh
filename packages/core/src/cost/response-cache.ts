// The content-addressed response cache. A repeated identical request makes no second
// network call.
//
// ── THE KEY MUST CONTAIN EVERYTHING THAT CAN CHANGE THE ANSWER ─────────────
//
// Requirement 20.7 names provider, model, messages and options. A cache that omits ANY
// input returns a wrong answer with total confidence, which is worse than a cache miss
// by a wide margin — a miss costs money, a wrong hit costs correctness and is invisible.
// So the preimage is every component joined by `\n`, a character none of them can
// contain, exactly as `embedding-cache.ts` does it. Options are serialised with SORTED
// KEYS, because `{a,b}` and `{b,a}` are the same request and must be the same key, while
// `temperature: 0` and `temperature: 1` must not be.
//
// A version prefix means a change to the key scheme or the record shape is a MISS rather
// than a mis-read of an old record in a new format.
//
// ── WHAT THIS WRITES TO DISK, STATED PLAINLY ───────────────────────────────
//
// This is the first cache in the project that stores MODEL OUTPUT, and the honesty note
// matters because `embedding-cache.ts` deliberately stores no text at all and its test
// asserts as much.
//
//   * The RESPONSE TEXT is stored. It has to be — replaying it is the entire feature.
//   * The REQUEST MESSAGES ARE NOT. Only their hash. A prompt routinely contains a user's
//     source code and sometimes a secret they pasted, and a cache is a place people forget
//     exists. The hash is enough to match a repeat and useless to anyone reading the
//     directory.
//   * NO CREDENTIAL, no base URL, no header. The provider is identified by its id.
//
// Everything lands under `<project>/.sketch/cache/`, which `ensureStateDir` makes
// invisible to `git status`, so a cached response cannot be committed by accident. A
// response can still hold whatever the model said about the user's code, so the store is
// as local and as ignorable as the event log — and `clearResponseCache` exists so a user
// can delete it without deleting anything else.
//
// ── A CACHE HIT IS AN EVENT, BECAUSE OTHERWISE NOBODY CAN TELL ─────────────
//
// `cache_hit` is emitted with the usage of the response being replayed, which is what
// lets `ledgerFor` report money the cache avoided. Without the event a working cache and
// a broken one look identical from outside: both produce answers, and only the invoice
// distinguishes them.
//
// Validates: Requirements 20.7, 20.8

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureStateDir } from '../workspace/state-dir.js'
import type { Message, Usage } from '../types.js'

/** Bump when the key scheme or the record shape changes. A mismatch is a MISS. */
export const RESPONSE_CACHE_VERSION = 1

/** `<baseDir>/.sketch/cache/responses`. */
export function responseCacheDir(baseDir: string): string {
  return join(baseDir, '.sketch', 'cache', 'responses')
}

/** Everything about a request that can change its answer. */
export interface ResponseCacheIdentity {
  /** Provider id, e.g. `openai`. Never a base URL and never a key. */
  provider: string
  model: string
  messages: readonly Message[]
  /**
   * Request options — temperature, top-p, max tokens, anything the wire carries.
   *
   * Serialised with sorted keys. A cache that ignored temperature would hand a
   * deterministic answer to a request that asked for a creative one.
   */
  options?: Record<string, unknown>
}

/**
 * The cache key.
 *
 * Messages are folded in role-and-content order, with the role included: swapping who
 * said what is a different conversation.
 */
export function responseCacheKey(identity: ResponseCacheIdentity): string {
  const messages = identity.messages.map((m) => `${m.role}\u0000${m.content}`).join('\u0001')
  const preimage = [
    `v${RESPONSE_CACHE_VERSION}`,
    identity.provider,
    identity.model,
    stableJson(identity.options ?? {}),
    messages,
  ].join('\n')
  return createHash('sha256').update(preimage, 'utf8').digest('hex')
}

/**
 * JSON with keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two identical option objects built in
 * different orders would hash differently and every request would miss.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
}

/** One cached response. Read back with every field verified. */
export interface ResponseCacheRecord {
  version: number
  provider: string
  model: string
  /** sha256 of the serialised messages. THE MESSAGES THEMSELVES ARE NOT STORED. */
  messagesHash: string
  /** Sorted-key JSON of the options. Small, and part of what a reader must verify. */
  options: string
  /** The model's reply. Stored, because replaying it is the point. */
  text: string
  /** The usage the original call reported, so a hit can price what it avoided. */
  usage: Usage
  /** When the entry was written, epoch ms. Used by `pruneResponseCache`. */
  writtenAt: number
}

export interface ResponseCacheStats {
  hits: number
  misses: number
  writes: number
  /** Read/write failures and rejected records. Swallowed, but counted. */
  errors: number
}

/** The seam. A memory implementation exists so a test needs no `.sketch/`. */
export interface ResponseCache {
  get(identity: ResponseCacheIdentity): Promise<ResponseCacheRecord | null>
  set(identity: ResponseCacheIdentity, value: { text: string; usage: Usage }): Promise<void>
  readonly stats: ResponseCacheStats
}

/**
 * `.sketch/cache/responses/<key[0:2]>/<key>.json`, sharded two hex characters deep — the
 * same layout as the embedding cache. Flat directories with a hundred thousand entries
 * are slow to list on every platform that matters.
 */
export class FileResponseCache implements ResponseCache {
  readonly stats: ResponseCacheStats = { hits: 0, misses: 0, writes: 0, errors: 0 }

  private readonly dir: string

  constructor(
    private readonly baseDir: string,
    /** Entries older than this are treated as a miss. Default: no expiry. */
    private readonly maxAgeMs?: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.dir = responseCacheDir(baseDir)
  }

  /** Absolute path of a key's record. Exposed so tests can inspect the bytes. */
  pathFor(key: string): string {
    return join(this.dir, key.slice(0, 2), `${key}.json`)
  }

  async get(identity: ResponseCacheIdentity): Promise<ResponseCacheRecord | null> {
    const key = responseCacheKey(identity)
    let raw: string
    try {
      raw = await readFile(this.pathFor(key), 'utf8')
    } catch {
      // Absent is the common case and is not an error.
      this.stats.misses += 1
      return null
    }

    let record: ResponseCacheRecord
    try {
      record = JSON.parse(raw) as ResponseCacheRecord
    } catch {
      this.stats.errors += 1
      this.stats.misses += 1
      return null
    }

    // EVERY component re-verified. A key collision is astronomically unlikely and a
    // corrupt or hand-edited file is not, and both are caught by the same check.
    const expectedMessages = hashMessages(identity.messages)
    if (
      record.version !== RESPONSE_CACHE_VERSION ||
      record.provider !== identity.provider ||
      record.model !== identity.model ||
      record.messagesHash !== expectedMessages ||
      record.options !== stableJson(identity.options ?? {}) ||
      typeof record.text !== 'string' ||
      typeof record.usage?.in !== 'number' ||
      typeof record.usage?.out !== 'number'
    ) {
      this.stats.errors += 1
      this.stats.misses += 1
      return null
    }

    if (this.maxAgeMs !== undefined && this.now() - record.writtenAt > this.maxAgeMs) {
      // Stale is a miss, not an error: a model's answer to the same question can be
      // legitimately different a month later.
      this.stats.misses += 1
      return null
    }

    this.stats.hits += 1
    return record
  }

  async set(
    identity: ResponseCacheIdentity,
    value: { text: string; usage: Usage },
  ): Promise<void> {
    const key = responseCacheKey(identity)
    const target = this.pathFor(key)
    const record: ResponseCacheRecord = {
      version: RESPONSE_CACHE_VERSION,
      provider: identity.provider,
      model: identity.model,
      messagesHash: hashMessages(identity.messages),
      options: stableJson(identity.options ?? {}),
      text: value.text,
      usage: { in: value.usage.in, out: value.usage.out },
      writtenAt: this.now(),
    }

    // Write to a pid-suffixed temp file and rename: a reader must never see half a
    // record, and two processes writing the same key must not interleave.
    const tmp = `${target}.${process.pid}.tmp`
    try {
      await ensureStateDir(this.baseDir)
      await mkdir(join(this.dir, key.slice(0, 2)), { recursive: true })
      await writeFile(tmp, JSON.stringify(record), 'utf8')
      await rename(tmp, target)
      this.stats.writes += 1
    } catch {
      this.stats.errors += 1
      // A cache that cannot write must not break the run it was helping.
      await unlink(tmp).catch(() => {})
    }
  }
}

/** In-memory cache. For tests, and for a caller that wants no `.sketch/` at all. */
export class MemoryResponseCache implements ResponseCache {
  readonly stats: ResponseCacheStats = { hits: 0, misses: 0, writes: 0, errors: 0 }
  private readonly entries = new Map<string, ResponseCacheRecord>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(identity: ResponseCacheIdentity): Promise<ResponseCacheRecord | null> {
    const record = this.entries.get(responseCacheKey(identity))
    if (record === undefined) {
      this.stats.misses += 1
      return null
    }
    this.stats.hits += 1
    return record
  }

  async set(
    identity: ResponseCacheIdentity,
    value: { text: string; usage: Usage },
  ): Promise<void> {
    this.entries.set(responseCacheKey(identity), {
      version: RESPONSE_CACHE_VERSION,
      provider: identity.provider,
      model: identity.model,
      messagesHash: hashMessages(identity.messages),
      options: stableJson(identity.options ?? {}),
      text: value.text,
      usage: { ...value.usage },
      writtenAt: this.now(),
    })
    this.stats.writes += 1
  }

  get size(): number {
    return this.entries.size
  }
}

/**
 * Delete the whole response cache.
 *
 * Exists so a user can throw away stored model output without touching the event log or
 * the index. A cache holding what a model said about someone's code should be one
 * command to remove, not a directory they have to find.
 */
export async function clearResponseCache(baseDir: string): Promise<void> {
  await rm(responseCacheDir(baseDir), { recursive: true, force: true })
}

/** How many entries are on disk. Cheap enough for a settings surface. */
export async function responseCacheSize(baseDir: string): Promise<number> {
  const dir = responseCacheDir(baseDir)
  let total = 0
  let shards: string[]
  try {
    shards = await readdir(dir)
  } catch {
    return 0
  }
  for (const shard of shards) {
    try {
      const files = await readdir(join(dir, shard))
      total += files.filter((name) => name.endsWith('.json')).length
    } catch {
      // A file where a shard directory was expected. Not fatal.
    }
  }
  return total
}

/** sha256 over the role-tagged messages. The text itself never reaches disk. */
export function hashMessages(messages: readonly Message[]): string {
  const serialised = messages.map((m) => `${m.role}\u0000${m.content}`).join('\u0001')
  return createHash('sha256').update(serialised, 'utf8').digest('hex')
}

/**
 * Wrap an adapter so identical requests are served from the cache.
 *
 * A DECORATOR, not a change to the loop: the loop keeps one way to make a request, and
 * caching is a property of the adapter it was handed. That also means the eval harness
 * and the trainer get it for free, which is where a response cache pays for itself —
 * scoring the same case fifty times is fifty identical requests.
 *
 * `onHit` is how `cache_hit` reaches the log. The decorator does not emit it itself
 * because it has no run id; the caller that owns the run supplies the sink.
 */
export function cachedAdapter(options: {
  adapter: { readonly id: string; readonly model?: string; chat: ChatFn }
  cache: ResponseCache
  /** Request options that are part of the key. Must match what the adapter sends. */
  requestOptions?: Record<string, unknown>
  onHit?: (info: { provider: string; model: string; usage: Usage; key: string }) => void | Promise<void>
}): { readonly id: string; readonly model?: string; chat: ChatFn } {
  const { adapter, cache } = options
  // No model means no stable key: two different models behind one adapter id would
  // share entries. Named explicitly so the fallback is visible rather than assumed.
  const model = adapter.model ?? 'unknown-model'

  return {
    id: adapter.id,
    ...(adapter.model !== undefined ? { model: adapter.model } : {}),
    async chat(messages, chatOptions) {
      const identity: ResponseCacheIdentity = {
        provider: adapter.id,
        model,
        messages,
        ...(options.requestOptions !== undefined ? { options: options.requestOptions } : {}),
      }

      const hit = await cache.get(identity)
      if (hit !== null) {
        await options.onHit?.({
          provider: adapter.id,
          model,
          usage: hit.usage,
          key: responseCacheKey(identity),
        })
        // NO SECOND NETWORK CALL. That is the requirement, and it is why this returns
        // here rather than validating against a fresh request.
        return { text: hit.text, usage: hit.usage }
      }

      const response = await adapter.chat(messages, chatOptions)
      // Only a successful response is stored. A throw propagates uncached: caching a
      // failure would replay someone's outage for as long as the entry lived.
      await cache.set(identity, {
        text: response.text,
        usage: response.usage ?? { in: 0, out: 0 },
      })
      return response
    },
  }
}

type ChatFn = (
  messages: Message[],
  options?: { signal?: AbortSignal },
) => Promise<{ text: string; usage?: Usage }>
