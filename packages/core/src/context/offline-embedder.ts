// Offline-first embedding. The composition layer: local by default, provider as
// a cached fallback, and it never throws.
//
// ── THE ONE RULE ────────────────────────────────────────────────────────────
//
// `embed()` ALWAYS resolves, always returns exactly one vector per input, and
// every vector is exactly `dimensions` wide. There is no failure mode that
// returns `[]`, no failure mode that hangs, and no failure mode that rejects.
// Indexing is background work on the way to a model call; a flaky endpoint must
// make retrieval WORSE, loudly, not make the product broken.
//
// The floor under that promise is `hashEmbed` — a pure function over a string
// that allocates an array and returns. Even a caller-supplied local embedder
// that throws, or returns wrong-width vectors, degrades to that floor.
//
// ── OFFLINE IS THE DEFAULT, NOT A FALLBACK ──────────────────────────────────
//
// With no provider configured (the shipped default) this class never resolves a
// hostname. That is not "offline support" bolted onto a network path: the
// network path only exists when a caller passes a `provider`.
//
// ── DEGRADING, AND THE ONE THING IT COSTS ───────────────────────────────────
//
// When a configured provider fails — unreachable, 401, timeout, malformed body,
// wrong vector width — the batch is embedded locally instead and the embedder
// LATCHES into local mode for the rest of its life. Latching is deliberate:
// retrying a dead endpoint once per batch turns a 500-file index into 500
// timeouts, and the first failure has already told us what we need to know.
//
// The cost is real and is reported rather than hidden. Provider vectors and
// local vectors live in DIFFERENT SPACES; a cosine between them is noise. If a
// run returned some of each, `status().mixedVectorSpaces` is true, the degrade
// event carries it, and the honest remedy is to rebuild the index once the
// provider is reachable again. What is NOT done here is padding, projecting or
// otherwise dressing a hash vector up as a model vector.
//
// ── EVENTS ──────────────────────────────────────────────────────────────────
//
// A degrade emits `context_loaded` with `component: "embedder"`. There is no
// embedding EventKind in the contract and inventing one is not allowed, so the
// payload carries the discriminator and the gap is recorded in the handoff.
//
// Validates: Requirements 18.3

import type { EventInput } from '../events/store.js'
import {
  DEFAULT_LOCAL_DIMENSIONS,
  HashEmbedder,
  LOCAL_EMBEDDER_ID,
  LOCAL_EMBEDDER_LIMITATIONS,
  LOCAL_EMBEDDER_MODEL,
  hashEmbed,
  isUsableVector,
  type EmbedderIdentity,
  type IdentifiedEmbedder,
} from './embedder.js'
import {
  FileEmbeddingCache,
  MemoryEmbeddingCache,
  contentHash,
  type EmbeddingCache,
} from './embedding-cache.js'
import type { Embedder } from './types.js'

/** Which path produced the vectors. */
export type EmbedderMode = 'local' | 'provider'

export interface EmbedderStatus {
  /** The path in force now. Starts `provider` only when one was configured. */
  mode: EmbedderMode
  dimensions: number
  /** Identity of the active path — what cache keys are written under. */
  providerId: string
  model: string
  /** True once a configured provider has failed, or when none was configured. */
  degraded: boolean
  /** Why the local path is in force. Redacted; never carries credential material. */
  reason: string | null
  /**
   * True when this instance returned BOTH provider and local vectors. The index
   * now holds two incomparable spaces and should be rebuilt.
   */
  mixedVectorSpaces: boolean
  /** Requests actually sent. Zero is the offline guarantee, in a number. */
  providerCalls: number
  /** Texts sent to the provider. Never includes a cache hit. */
  providerTexts: number
  cacheHits: number
  cacheMisses: number
  /** Texts embedded by the local path. */
  localEmbeds: number
  /**
   * Vectors that came out all-zero — a text with no identifier tokens. Not an
   * error, but such a chunk is unreachable by vector search, so it is counted
   * rather than passed over in silence.
   */
  zeroVectors: number
}

export interface OfflineFirstEmbedderOptions {
  /**
   * The provider path. Omit it — the default — and nothing here touches the
   * network.
   */
  provider?: IdentifiedEmbedder
  /**
   * The local path. Defaults to `HashEmbedder` at the resolved width. A supplied
   * embedder that throws or returns the wrong width is bypassed for the pure
   * `hashEmbed` floor.
   */
  local?: IdentifiedEmbedder
  /**
   * Vector width. Defaults to the provider's when one is given, so a mid-run
   * degrade cannot change the width of vectors already in the store.
   */
  dimensions?: number
  /**
   * Where `.sketch/index/embeddings/` lives. Supplying it is what makes the
   * cache survive a restart.
   */
  baseDir?: string
  /**
   * Cache override. Defaults to a `FileEmbeddingCache` under `baseDir`, or an
   * in-process one when no `baseDir` was given.
   *
   * Only PROVIDER vectors are cached. The local path is deterministic and costs
   * microseconds, so a disk read would be slower than recomputing it.
   */
  cache?: EmbeddingCache
  events?: { emit(event: EventInput): Promise<void> | void }
  runId?: string
}

/**
 * The embedder the product should use. Implements the plain `Embedder` seam, so
 * `hybrid-search.ts`, `ContextEngine` and `MemoryVectorStore` take it as-is.
 */
export class OfflineFirstEmbedder implements Embedder {
  readonly dimensions: number

  private readonly provider: IdentifiedEmbedder | null
  private readonly local: IdentifiedEmbedder
  private readonly cache: EmbeddingCache
  private readonly events: OfflineFirstEmbedderOptions['events']
  private readonly runId: string

  private mode: EmbedderMode
  private reason: string | null
  private providerVectors = 0
  private localVectors = 0
  private degradeReported = false

  private readonly counters = {
    providerCalls: 0,
    providerTexts: 0,
    cacheHits: 0,
    cacheMisses: 0,
    localEmbeds: 0,
    zeroVectors: 0,
  }

  constructor(options: OfflineFirstEmbedderOptions = {}) {
    this.provider = options.provider ?? null
    this.dimensions = Math.max(
      1,
      Math.floor(
        options.dimensions ??
          this.provider?.dimensions ??
          options.local?.dimensions ??
          DEFAULT_LOCAL_DIMENSIONS
      )
    )
    this.local = options.local ?? new HashEmbedder(this.dimensions)
    this.cache =
      options.cache ??
      (options.baseDir === undefined
        ? new MemoryEmbeddingCache()
        : new FileEmbeddingCache(options.baseDir))
    this.events = options.events
    this.runId = options.runId ?? 'index'

    this.mode = this.provider === null ? 'local' : 'provider'
    this.reason =
      this.provider === null
        ? 'no embedding provider configured; using the local hashing vectoriser'
        : null
  }

  /** What the local path is, and is not. Quoted from one place, not paraphrased. */
  static readonly localLimitations = LOCAL_EMBEDDER_LIMITATIONS

  /** Identity of the ACTIVE path. Cache keys are written under exactly this. */
  identity(): EmbedderIdentity {
    if (this.mode === 'provider' && this.provider !== null) {
      return {
        providerId: this.provider.providerId,
        model: this.provider.model,
        dimensions: this.dimensions,
      }
    }
    return {
      providerId: this.local.providerId ?? LOCAL_EMBEDDER_ID,
      model: this.local.model ?? LOCAL_EMBEDDER_MODEL,
      dimensions: this.dimensions,
    }
  }

  status(): EmbedderStatus {
    const identity = this.identity()
    return {
      mode: this.mode,
      dimensions: this.dimensions,
      providerId: identity.providerId,
      model: identity.model,
      degraded: this.mode === 'local',
      reason: this.reason,
      mixedVectorSpaces: this.providerVectors > 0 && this.localVectors > 0,
      ...this.counters,
    }
  }

  /** The cache's own counters, for tests and for a future index report. */
  cacheStats() {
    return this.cache.stats
  }

  /**
   * Embed. Never rejects, never returns a short array, never returns a vector of
   * the wrong width.
   */
  async embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]> {
    if (texts.length === 0) return []
    if (this.mode === 'local' || this.provider === null) return this.localBatch(texts)

    const provider = this.provider
    const identity: EmbedderIdentity = {
      providerId: provider.providerId,
      model: provider.model,
      dimensions: this.dimensions,
    }

    const hashes = texts.map(contentHash)
    const out = new Array<number[] | null>(texts.length).fill(null)
    const missing: number[] = []

    for (let i = 0; i < texts.length; i++) {
      // A cache read is the offline path for a provider vector: no network, and
      // free on the second index of an unchanged file.
      const cached = await this.readCache(identity, hashes[i]!)
      if (cached === null) missing.push(i)
      else out[i] = cached
    }

    if (missing.length > 0) {
      const fetched = await this.fetchMissing(provider, identity, texts, hashes, missing, options)
      if (fetched === null) {
        // The provider is gone. The WHOLE batch goes local so one batch is at
        // least internally comparable; the cache hits above are discarded rather
        // than mixed with hash vectors inside a single result.
        return this.localBatch(texts)
      }
      for (const [index, vector] of fetched) out[index] = vector
    }

    let localFills = 0
    const vectors = out.map((v, i) => {
      if (v !== null) return v
      localFills++
      return this.localOne(texts[i]!)
    })
    this.providerVectors += vectors.length - localFills
    this.countZeros(vectors)
    return vectors
  }

  // ── provider path ─────────────────────────────────────────────────────────

  /**
   * Embed the misses. Returns null when the provider could not be used — every
   * failure mode collapses to that one signal, because the caller's response is
   * the same for all of them.
   */
  private async fetchMissing(
    provider: IdentifiedEmbedder,
    identity: EmbedderIdentity,
    texts: string[],
    hashes: string[],
    missing: number[],
    options?: { signal?: AbortSignal }
  ): Promise<Array<[number, number[]]> | null> {
    const batch = missing.map(i => texts[i]!)
    let vectors: number[][]
    try {
      this.counters.providerCalls++
      this.counters.providerTexts += batch.length
      vectors = await provider.embed(batch, options)
    } catch (err) {
      // The message is already redacted by the provider layer; redacting again
      // would be free but claiming it here is what matters: nothing in this
      // string is credential material.
      await this.degrade(err instanceof Error ? err.message : String(err))
      return null
    }

    if (vectors.length !== batch.length) {
      await this.degrade(`provider returned ${vectors.length} vectors for ${batch.length} texts`)
      return null
    }

    const resolved: Array<[number, number[]]> = []
    for (let k = 0; k < missing.length; k++) {
      const vector = vectors[k]
      if (!isUsableVector(vector, this.dimensions)) {
        // Garbage is never written to the cache and never handed to the store.
        await this.degrade(
          `provider returned a vector that is not ${this.dimensions} usable dimensions`
        )
        return null
      }
      resolved.push([missing[k]!, vector])
      await this.writeCache(identity, hashes[missing[k]!]!, vector)
    }
    return resolved
  }

  private async readCache(identity: EmbedderIdentity, hash: string): Promise<number[] | null> {
    let vector: number[] | null
    try {
      vector = await this.cache.get(identity, hash)
    } catch {
      // A cache that cannot be read is a cache miss, not a failed index.
      vector = null
    }
    if (vector === null) {
      this.counters.cacheMisses++
      return null
    }
    this.counters.cacheHits++
    return vector
  }

  private async writeCache(
    identity: EmbedderIdentity,
    hash: string,
    vector: number[]
  ): Promise<void> {
    try {
      await this.cache.set(identity, hash, vector)
    } catch {
      // Best effort by design; the vector is already in hand.
    }
  }

  // ── local path ────────────────────────────────────────────────────────────

  private async localBatch(texts: string[]): Promise<number[][]> {
    const vectors = await this.runLocal(texts)
    this.localVectors += vectors.length
    this.counters.localEmbeds += vectors.length
    this.countZeros(vectors)
    return vectors
  }

  /**
   * The local path, with the pure function as its floor. A supplied local
   * embedder gets one chance; if it throws or returns anything other than
   * `dimensions` finite numbers, `hashEmbed` answers instead. That is what makes
   * the never-throws promise unconditional.
   */
  private async runLocal(texts: string[]): Promise<number[][]> {
    let candidate: number[][] | null = null
    try {
      candidate = await this.local.embed(texts)
    } catch {
      candidate = null
    }
    if (candidate === null || candidate.length !== texts.length) {
      return texts.map(t => hashEmbed(t, this.dimensions))
    }
    return candidate.map((vector, i) => {
      // An all-zero vector IS legitimate here (a text with no tokens), so the
      // width and finiteness are checked but the magnitude is not.
      if (
        Array.isArray(vector) &&
        vector.length === this.dimensions &&
        vector.every(v => typeof v === 'number' && Number.isFinite(v))
      ) {
        return vector
      }
      return hashEmbed(texts[i]!, this.dimensions)
    })
  }

  private localOne(text: string): number[] {
    this.localVectors++
    this.counters.localEmbeds++
    return hashEmbed(text, this.dimensions)
  }

  private countZeros(vectors: number[][]): void {
    for (const vector of vectors) {
      if (vector.every(v => v === 0)) this.counters.zeroVectors++
    }
  }

  // ── degradation ───────────────────────────────────────────────────────────

  /**
   * Latch into local mode and say so, once.
   *
   * The emit is awaited: a degrade that is only visible after the run has
   * finished writing its log is a degrade nobody sees. A failing sink is
   * swallowed — reporting a problem must not become a second problem.
   */
  private async degrade(detail: string): Promise<void> {
    this.mode = 'local'
    this.reason = `embedding provider unavailable — ${detail}; using the local hashing vectoriser`
    if (this.degradeReported) return
    this.degradeReported = true

    try {
      await this.events?.emit({
        runId: this.runId,
        kind: 'context_loaded',
        payload: {
          component: 'embedder',
          mode: 'local',
          degraded: true,
          reason: this.reason,
          dimensions: this.dimensions,
          // Names only. No url, no header, no key: the reason string is the only
          // free text here and it came through the provider redactor.
          providerId: this.provider?.providerId ?? null,
          model: this.provider?.model ?? null,
          localProviderId: this.local.providerId ?? LOCAL_EMBEDDER_ID,
          localModel: this.local.model ?? LOCAL_EMBEDDER_MODEL,
          mixedVectorSpaces: this.providerVectors > 0,
          limitations: [...LOCAL_EMBEDDER_LIMITATIONS],
        },
      })
    } catch {
      // No sink, or a sink that failed. The status object still tells the truth.
    }
  }
}

/**
 * Build the offline-first embedder. Equivalent to the constructor; it exists so
 * call sites read as an intent ("give me an embedder for this project") rather
 * than as a composition.
 */
export function createEmbedder(options: OfflineFirstEmbedderOptions = {}): OfflineFirstEmbedder {
  return new OfflineFirstEmbedder(options)
}
