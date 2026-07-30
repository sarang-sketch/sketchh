// Embedders turn text into vectors. Read the honesty section before trusting
// anything this file produces.
//
// ── WHAT THE LOCAL PATH ACTUALLY IS ──────────────────────────────────────────
//
// `HashEmbedder` IS NOT A SEMANTIC EMBEDDING MODEL. It is a hashing trick: it
// splits text on identifier characters, hashes each token with FNV-1a, adds ±1
// into the bucket that hash lands in, and L2-normalises the result. That is a
// signed random-projection bag-of-tokens vector — the "hashing trick" from
// pre-transformer text classification, not a learned representation.
//
// What follows from that, stated plainly rather than implied away:
//
//   * `car` and `automobile` are ORTHOGONAL under it. There is no synonym
//     knowledge, no word sense, no word order, no subword handling. Two texts
//     score similar only when they SHARE LITERAL TOKENS.
//   * A cosine of 0.6 here means "these two chunks reuse the same identifiers",
//     which is a lexical fact. `hybrid-search.ts`'s lexical channel measures the
//     same fact directly, more precisely, and with line-level evidence.
//   * Consequently the vector channel adds LITTLE over the lexical channel when
//     the local path is in force. It contributes token-overlap recall (a chunk
//     that shares many identifiers but not the exact query string) and nothing
//     more. Retrieval quality with the local embedder is essentially the quality
//     of the lexical channel, which is exactly why Requirement 18.2 (hybrid,
//     never vector-only) had to land before this task.
//
// ── WHY THERE IS NO REAL LOCAL MODEL ────────────────────────────────────────
//
// `packages/core` has zero runtime dependencies, enforced by
// `test/deps.test.ts`. A real local embedder needs a tokenizer and an inference
// runtime (onnxruntime-node, transformers.js, a GGUF loader) — every one of them
// a native or multi-megabyte dependency, and native modules are precisely what
// makes a local-first install fail on someone's machine. So the honest options
// were: a hashing vectoriser (this), or a sidecar process holding the model
// (deferred — it is a packaging and lifecycle problem, not an embedding one).
// We ship the hashing vectoriser as the DEFAULT and the provider endpoint as a
// documented, cached FALLBACK, and we do not describe the former as semantic
// search anywhere in the product.
//
// ── THE PROVIDER PATH ───────────────────────────────────────────────────────
//
// `ProviderEmbedder` calls an OpenAI-shaped `/embeddings` endpoint. It is real
// semantic embedding and it is NETWORK EGRESS: the chunk text leaves the
// machine. Every error it raises goes through the provider redactor
// (`src/providers/redact.ts`) with the api key and credential-shaped headers in
// the secrets list, because 401 bodies echo credentials back. See PRIVACY.md §1.
//
// Offline-by-default composition, caching and degradation live in
// `offline-embedder.ts`. This file holds only the two leaf implementations.
//
// Validates: Requirements 18.3

import type { ProviderConfig } from '../types.js'
import { providerError } from '../providers/redact.js'
import { collectSecrets, trimBaseUrl } from '../providers/wire.js'
import type { Embedder } from './types.js'

/**
 * Identity of an embedding source, and the part of a cache key that is not the
 * content. A vector is only reusable for the exact `(provider, model,
 * dimensions)` triple that produced it — vectors from two different models are
 * not comparable, and a cosine between them is noise.
 */
export interface EmbedderIdentity {
  /** Provider id: `openai`, `local-hash-v1`, a custom endpoint's id. */
  readonly providerId: string
  /** Model name as the provider spells it. */
  readonly model: string
  readonly dimensions: number
}

/** An embedder that can name itself, so its output can be cached safely. */
export interface IdentifiedEmbedder extends Embedder, EmbedderIdentity {
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>
}

/** Provider id recorded for the local hashing path. Part of every local cache key. */
export const LOCAL_EMBEDDER_ID = 'local-hash-v1'

/** Model name recorded for the local hashing path. */
export const LOCAL_EMBEDDER_MODEL = 'fnv1a-signed-projection'

/**
 * The limitations of the local path, in the product's own words. Exported so the
 * UI, the event payload and the docs quote ONE list instead of three drifting
 * paraphrases, and so a test can assert the list is what ships.
 */
export const LOCAL_EMBEDDER_LIMITATIONS: readonly string[] = Object.freeze([
  'Not a semantic model: a hashing vectoriser (FNV-1a signed random projection over tokens).',
  'No synonyms, no word senses, no word order, no subwords — similarity means shared literal tokens.',
  'Adds little over the lexical channel; hybrid search is what carries retrieval quality offline.',
  'Zero network, zero dependencies, deterministic and instant — which is why it is the default.',
])

/** Default width of the local vector. */
export const DEFAULT_LOCAL_DIMENSIONS = 256

// ── the local path ──────────────────────────────────────────────────────────

/** FNV-1a over UTF-16 code units. Deterministic across platforms and runs. */
function fnv1a(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * The local vectoriser as a pure function.
 *
 * Exported because it is the floor of the whole embedding stack: whatever else
 * fails — the network, the cache, a caller-supplied embedder — this cannot. It
 * allocates an array, hashes some tokens and returns. `offline-embedder.ts`
 * relies on that to guarantee it never throws.
 *
 * A text with no identifier characters yields the ZERO vector. That is not a
 * silent failure and it is not hidden: `l2normalise` leaves it as zeros, cosine
 * against it is 0, and the caller counts it (`EmbedderStatus.zeroVectors`).
 */
export function hashEmbed(text: string, dimensions = DEFAULT_LOCAL_DIMENSIONS): number[] {
  const width = Math.max(1, Math.floor(dimensions))
  const vec = new Array<number>(width).fill(0)
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  for (const token of tokens) {
    const h = fnv1a(token)
    vec[h % width] += (h & 1) === 0 ? 1 : -1
  }
  return l2normalise(vec)
}

/**
 * The offline default. A HASHING VECTORISER, not a semantic embedding model —
 * see the header of this file and {@link LOCAL_EMBEDDER_LIMITATIONS}. It exists
 * so the pipeline runs with no network, no key and no dependency, and so vector
 * storage and search are testable without a provider.
 */
export class HashEmbedder implements IdentifiedEmbedder {
  readonly providerId = LOCAL_EMBEDDER_ID
  readonly model = LOCAL_EMBEDDER_MODEL

  constructor(public readonly dimensions = DEFAULT_LOCAL_DIMENSIONS) {}

  /** Never throws, never touches the network, never awaits anything. */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => hashEmbed(t, this.dimensions))
  }
}

// ── the provider path ───────────────────────────────────────────────────────

export interface ProviderEmbedderOptions {
  baseUrl: string
  apiKey: string
  model: string
  dimensions: number
  /** Provider id for errors and cache keys. Defaults to the endpoint's host. */
  id?: string
  /** Extra headers, e.g. a gateway token. Credential-shaped values are redacted. */
  headers?: Record<string, string>
  /** Wall-clock cap per request. A hung endpoint must not hang an index build. */
  timeoutMs?: number
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Default per-request cap. Generous for a batch, finite for a black hole. */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 20_000

interface EmbeddingsResponse {
  data?: Array<{ embedding?: unknown; index?: number } | null> | null
}

/**
 * `POST {baseUrl}/embeddings`, OpenAI-shaped. NETWORK EGRESS: the text goes to
 * the endpoint configured in `~/.sketch/providers.json`.
 *
 * Errors are built by `providerError` with the key and every credential-shaped
 * header in the secrets list, so no failure path can carry the credential into a
 * message, a log or a cache file.
 */
export class ProviderEmbedder implements IdentifiedEmbedder {
  readonly providerId: string
  readonly model: string
  readonly dimensions: number

  private readonly secrets: string[]
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: ProviderEmbedderOptions) {
    this.providerId = opts.id ?? hostOf(opts.baseUrl)
    this.model = opts.model
    this.dimensions = opts.dimensions
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    // Same secret collection as the chat adapters, so a newly recognised
    // credential-shaped header is scrubbed here too.
    const config: ProviderConfig = {
      id: this.providerId,
      kind: 'openai-compatible',
      baseUrl: opts.baseUrl,
      model: opts.model,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    }
    this.secrets = collectSecrets(config)
  }

  /**
   * Embed a batch. THROWS a redacted `Error` on any failure — including a
   * timeout, which is reported as a failure rather than an empty result.
   * `OfflineFirstEmbedder` is what turns these throws into a degrade.
   */
  async embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]> {
    if (texts.length === 0) return []

    const deadline = withTimeout(this.timeoutMs, options?.signal)
    try {
      // RACED, not merely signalled. Aborting the controller is the polite ask
      // and a cooperative `fetch` honours it, but the timeout is a PROMISE the
      // caller can win on its own — so a transport that ignores its signal, or a
      // body that never finishes arriving, still cannot hang an index build.
      // The timer also covers the body read, not just the handshake.
      return await Promise.race([this.request(texts, deadline), deadline.expired])
    } catch (err) {
      if (deadline.timedOut) {
        throw providerError({
          providerId: this.providerId,
          detail: `embedding request exceeded ${this.timeoutMs}ms`,
          secrets: this.secrets,
        })
      }
      throw err
    } finally {
      deadline.dispose()
    }
  }

  private async request(texts: string[], deadline: Deadline): Promise<number[][]> {
    const url = `${trimBaseUrl(this.opts.baseUrl)}/embeddings`
    const body = JSON.stringify({ model: this.opts.model, input: texts })

    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal: deadline.signal,
      })
    } catch (err) {
      throw providerError({
        providerId: this.providerId,
        detail: deadline.timedOut
          ? `embedding request exceeded ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
        secrets: this.secrets,
      })
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw providerError({
        providerId: this.providerId,
        status: res.status,
        detail,
        secrets: this.secrets,
      })
    }

    let data: EmbeddingsResponse
    try {
      data = (await res.json()) as EmbeddingsResponse
    } catch (err) {
      throw providerError({
        providerId: this.providerId,
        status: res.status,
        detail: `unparseable embeddings body — ${err instanceof Error ? err.message : String(err)}`,
        secrets: this.secrets,
      })
    }

    const rows = Array.isArray(data.data) ? data.data : []
    if (rows.length !== texts.length) {
      // A short batch would silently misalign vectors with chunks, which is far
      // worse than a failed request: every id would point at the wrong text.
      throw providerError({
        providerId: this.providerId,
        detail: `expected ${texts.length} embeddings, received ${rows.length}`,
        secrets: this.secrets,
      })
    }

    return rows.map((row, i) => {
      const vector = row?.embedding
      if (!isUsableVector(vector, this.dimensions)) {
        throw providerError({
          providerId: this.providerId,
          detail:
            `embedding ${i} is not ${this.dimensions} finite numbers ` +
            `(model '${this.opts.model}' may not match the configured dimensions)`,
          secrets: this.secrets,
        })
      }
      return vector
    })
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.opts.apiKey) headers['Authorization'] = `Bearer ${this.opts.apiKey}`
    return { ...headers, ...(this.opts.headers ?? {}) }
  }
}

/** Host of a base URL, for attributing an error when no id was configured. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || 'embeddings'
  } catch {
    return 'embeddings'
  }
}

/**
 * A vector fit to store: an array of exactly `dimensions` finite numbers, not
 * all zero. The all-zero check matters — a zero vector scores 0 against
 * everything, so accepting one from a provider means silently indexing a chunk
 * that can never be retrieved.
 */
export function isUsableVector(value: unknown, dimensions: number): value is number[] {
  if (!Array.isArray(value) || value.length !== dimensions) return false
  let magnitude = 0
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false
    magnitude += v * v
  }
  return magnitude > 0
}

/**
 * An abort signal that fires on the caller's signal OR after `ms`.
 *
 * Hand-rolled rather than `AbortSignal.timeout` + `AbortSignal.any` so the
 * timer can be cleared: an unref'd pending timer keeps a CLI process alive after
 * its work is done, and `timedOut` distinguishes "we gave up" from "the socket
 * failed" in the error message.
 */
interface Deadline {
  signal: AbortSignal
  timedOut: boolean
  /** Rejects when the deadline passes. Raced against the request. */
  expired: Promise<never>
  dispose(): void
}

function withTimeout(ms: number, signal?: AbortSignal): Deadline {
  const controller = new AbortController()
  let expire: (err: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => {
    expire = reject
  })
  // The race handles this rejection, but a request that wins the race leaves the
  // rejection unobserved; swallow it here so it can never surface as an
  // unhandled rejection.
  void expired.catch(() => {})

  const state: Deadline = {
    signal: controller.signal,
    timedOut: false,
    expired,
    dispose: () => {},
  }

  const timer = setTimeout(() => {
    state.timedOut = true
    controller.abort()
    expire(new Error(`deadline of ${ms}ms passed`))
  }, ms)

  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted === true) controller.abort()

  state.dispose = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  return state
}

export function l2normalise(vec: number[]): number[] {
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum)
  if (norm === 0) return vec
  return vec.map(v => v / norm)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // vectors are pre-normalised, so dot product == cosine similarity
}
