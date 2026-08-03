// Task 5.3 — offline embeddings: the local path, the cache, and the degrade.
//
// Everything here is real: the real hashing vectoriser, the real
// `FileEmbeddingCache` writing real files into a real temp `.sketch/`, the real
// `ProviderEmbedder` over an injected `fetch`, and a real `MemoryEventStore`.
// The only substitution is the socket — a provider endpoint is the one thing a
// test cannot have offline, and the whole point of the task is what happens when
// that socket misbehaves.
//
// The three claims under test, in order:
//
//   1. THE LOCAL PATH IS HONEST. It is a hashing vectoriser, and these tests
//      assert its LIMITS as facts (synonyms are orthogonal), rather than
//      asserting a semantic quality it does not have.
//   2. THE CACHE IS KEYED CORRECTLY AND SURVIVES A RESTART. A changed chunk, a
//      changed model, a changed provider and a changed width are four different
//      keys — asserted behaviourally (the provider is called again and the NEW
//      vector wins), not just on the key string.
//   3. THE OFFLINE PATH NEVER FAILS. Unreachable, hanging, 401, malformed and
//      wrong-width providers all produce usable vectors, a `degraded` status, a
//      reason, and an event — never a throw, never a hang, never an empty vector.
//
// Validates: Requirements 18.3

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DEFAULT_LOCAL_DIMENSIONS,
  HashEmbedder,
  LOCAL_EMBEDDER_ID,
  LOCAL_EMBEDDER_LIMITATIONS,
  ProviderEmbedder,
  cosineSimilarity,
  hashEmbed,
  isUsableVector,
  type IdentifiedEmbedder,
} from '../src/context/embedder.js'
import {
  EMBEDDING_CACHE_VERSION,
  FileEmbeddingCache,
  contentHash,
  embeddingCacheKey,
  embeddingsDir,
} from '../src/context/embedding-cache.js'
import { OfflineFirstEmbedder, createEmbedder } from '../src/context/offline-embedder.js'
import { MemoryVectorStore } from '../src/context/vector-store.js'
import { MemoryEventStore } from '../src/events/index.js'
import { REDACTED } from '../src/providers/redact.js'

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-embed-'))
  tmpDirs.push(dir)
  return dir
}

/**
 * A credential with no vendor shape, for the same reason `privacy.test.ts` uses
 * one: a `sk-…` key is caught by the shape table even when the configured-value
 * redaction is deleted, so a shaped key would let the mutation pass.
 */
const FAKE_KEY = 'Wq4Tn8Ly2Vb6Rj0Xd5Hf3Kc7Mp1Sa9E'

const DIMS = 8

function unitVector(seed: number, dimensions = DIMS): number[] {
  const vec = new Array<number>(dimensions).fill(0)
  vec[seed % dimensions] = 1
  return vec
}

/** A provider embedder over an injected fetch. Counts calls; never a real socket. */
function fakeProvider(opts: {
  id?: string
  model?: string
  dimensions?: number
  respond: (texts: string[]) => Promise<Response> | Response
  timeoutMs?: number
}): { embedder: ProviderEmbedder; calls: () => number; texts: () => string[] } {
  let calls = 0
  const seen: string[] = []
  const embedder = new ProviderEmbedder({
    id: opts.id ?? 'test-provider',
    baseUrl: 'https://embeddings.example.invalid/v1',
    apiKey: FAKE_KEY,
    model: opts.model ?? 'text-embedding-test',
    dimensions: opts.dimensions ?? DIMS,
    timeoutMs: opts.timeoutMs ?? 5_000,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      calls++
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] }
      const texts = body.input ?? []
      seen.push(...texts)
      return opts.respond(texts)
    }) as unknown as typeof fetch,
  })
  return { embedder, calls: () => calls, texts: () => seen }
}

/** An OpenAI-shaped 200 whose vectors are deterministic per text. */
function okEmbeddings(vector: (text: string, i: number) => number[]) {
  return (texts: string[]): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ data: texts.map((t, i) => ({ embedding: vector(t, i), index: i })) }),
      text: async () => '',
    }) as unknown as Response
}

// ── 1. the local path, and what it is not ───────────────────────────────────

describe('the local path is a hashing vectoriser, not a semantic model', () => {
  it('states its own limitations, and says outright that it is not semantic', () => {
    // The product quotes this list. If someone softens the local path's
    // description, they have to edit the list a test reads.
    const prose = LOCAL_EMBEDDER_LIMITATIONS.join(' ').toLowerCase()
    expect(prose).toContain('not a semantic model')
    expect(prose).toContain('hashing')
    expect(LOCAL_EMBEDDER_LIMITATIONS.length).toBeGreaterThanOrEqual(3)
  })

  it('scores synonyms as unrelated — the limitation, asserted as a fact', () => {
    // A real embedding model puts `car` and `automobile` close together. This one
    // cannot: they share no token, so the vectors are orthogonal. Documenting
    // that here is the honest alternative to implying semantic behaviour.
    const car = hashEmbed('car', 512)
    const automobile = hashEmbed('automobile', 512)
    expect(Math.abs(cosineSimilarity(car, automobile))).toBeLessThan(0.01)
    // Shared tokens are all it can see.
    const a = hashEmbed('parse retry budget from config', 512)
    const b = hashEmbed('parse retry budget from settings', 512)
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.5)
  })

  it('is deterministic, correctly sized and L2-normalised', () => {
    const a = hashEmbed('function login(user)', 64)
    const b = hashEmbed('function login(user)', 64)
    expect(a).toEqual(b)
    expect(a).toHaveLength(64)
    expect(Math.sqrt(a.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 10)
  })

  it('returns the zero vector for a text with no tokens, and reports it', async () => {
    // Not hidden: a chunk of pure punctuation cannot be retrieved by vector
    // search, and the counter is how a caller finds that out.
    const embedder = new OfflineFirstEmbedder({ dimensions: 16 })
    const [vector] = await embedder.embed(['   ...   '])
    expect(vector).toHaveLength(16)
    expect(vector!.every(v => v === 0)).toBe(true)
    expect(embedder.status().zeroVectors).toBe(1)
  })

  it('needs no network and no provider by default', async () => {
    const embedder = createEmbedder()
    const vectors = await embedder.embed(['alpha beta', 'gamma delta'])

    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toHaveLength(DEFAULT_LOCAL_DIMENSIONS)
    const status = embedder.status()
    expect(status.mode).toBe('local')
    expect(status.providerCalls).toBe(0)
    expect(status.providerId).toBe(LOCAL_EMBEDDER_ID)
    // Offline is the default, so the default is reported as degraded-with-reason
    // rather than silently pretending to be the provider path.
    expect(status.degraded).toBe(true)
    expect(status.reason).toContain('no embedding provider configured')
  })

  it('drops in wherever the Embedder seam is consumed', async () => {
    // The 5.2 interfaces must keep working: same seam, same vector store.
    const embedder = createEmbedder({ dimensions: 64 })
    const store = new MemoryVectorStore()
    const [vector] = await embedder.embed(['export function parse_retry_budget() {}'])
    await store.upsert([
      {
        id: 'src/retry.ts#0',
        path: 'src/retry.ts',
        index: 0,
        content: 'export function parse_retry_budget() {}',
        startLine: 0,
        endLine: 1,
        embedding: vector!,
      },
    ])
    const [query] = await embedder.embed(['parse_retry_budget'])
    const results = await store.search(query!, 3)
    expect(results[0]!.chunk.path).toBe('src/retry.ts')
  })

  it('rejects a vector that is empty, short, non-finite or all zero', () => {
    expect(isUsableVector([], 3)).toBe(false)
    expect(isUsableVector([1, 2], 3)).toBe(false)
    expect(isUsableVector([1, Number.NaN, 2], 3)).toBe(false)
    expect(isUsableVector([0, 0, 0], 3)).toBe(false)
    expect(isUsableVector([0, 1, 0], 3)).toBe(true)
  })
})

// ── 2. the cache key ────────────────────────────────────────────────────────

describe('the cache key separates content, model, provider and width', () => {
  const base = { providerId: 'openai', model: 'text-embedding-3-small', dimensions: 1536 }
  const hash = contentHash('export const x = 1')

  it('is stable for the same tuple', () => {
    expect(embeddingCacheKey(base, hash)).toBe(embeddingCacheKey(base, hash))
  })

  it('changes when the content changes', () => {
    expect(embeddingCacheKey(base, contentHash('export const x = 2'))).not.toBe(
      embeddingCacheKey(base, hash)
    )
  })

  it('changes when the model changes', () => {
    expect(embeddingCacheKey({ ...base, model: 'text-embedding-3-large' }, hash)).not.toBe(
      embeddingCacheKey(base, hash)
    )
  })

  it('changes when the provider changes', () => {
    expect(embeddingCacheKey({ ...base, providerId: 'gateway' }, hash)).not.toBe(
      embeddingCacheKey(base, hash)
    )
  })

  it('changes when the width changes', () => {
    expect(embeddingCacheKey({ ...base, dimensions: 256 }, hash)).not.toBe(
      embeddingCacheKey(base, hash)
    )
  })
})

describe('the cache on disk', () => {
  it('writes under .sketch/index/embeddings and survives a new process', async () => {
    const root = await makeProject()
    const identity = { providerId: 'openai', model: 'm1', dimensions: DIMS }
    const hash = contentHash('chunk one')

    const first = new FileEmbeddingCache(root)
    await first.set(identity, hash, unitVector(3))
    expect(first.stats.writes).toBe(1)

    // A brand-new instance with no memo: this is the restart.
    const second = new FileEmbeddingCache(root)
    const found = await second.get(identity, hash)
    expect(found).toEqual(unitVector(3))
    expect(second.stats.hits).toBe(1)
    expect(second.stats.diskReads).toBe(1)

    const dir = embeddingsDir(root)
    expect((await stat(dir)).isDirectory()).toBe(true)
    // The `.sketch/` self-ignore marker is in place, so the index never dirties
    // the user's git status.
    expect(await readFile(join(root, '.sketch', '.gitignore'), 'utf8')).toContain('*')
  })

  it('stores the hash and the vector, and never the text or a key', async () => {
    const root = await makeProject()
    const identity = { providerId: 'openai', model: 'm1', dimensions: DIMS }
    const secretText = 'const password = "hunter2"'
    const cache = new FileEmbeddingCache(root)
    await cache.set(identity, contentHash(secretText), unitVector(1))

    const bytes = await readAllFiles(embeddingsDir(root))
    expect(bytes).not.toContain('hunter2')
    expect(bytes).not.toContain(FAKE_KEY)
    expect(bytes).toContain(contentHash(secretText))
    expect(JSON.parse(bytes.trim()).version).toBe(EMBEDDING_CACHE_VERSION)
  })

  it('treats a corrupt or mismatched record as a miss, not a wrong vector', async () => {
    const root = await makeProject()
    const identity = { providerId: 'openai', model: 'm1', dimensions: DIMS }
    const hash = contentHash('chunk one')
    const cache = new FileEmbeddingCache(root)
    const file = cache.pathFor(embeddingCacheKey(identity, hash))

    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '{ this is not json', 'utf8')
    expect(await cache.get(identity, hash)).toBeNull()

    // A record whose fields do not match the request is also a miss: a hash
    // collision or a hand-edited file must not become a vector from a different
    // model.
    await writeFile(
      file,
      JSON.stringify({
        version: EMBEDDING_CACHE_VERSION,
        providerId: 'openai',
        model: 'a-different-model',
        dimensions: DIMS,
        contentHash: hash,
        vector: unitVector(2),
      }),
      'utf8'
    )
    expect(await new FileEmbeddingCache(root).get(identity, hash)).toBeNull()
  })

  it('never fails a build when the cache cannot be written', async () => {
    // A file where the shard directory needs to be: `mkdir` fails, the write is
    // swallowed, and the caller still gets its vector.
    const root = await makeProject()
    const identity = { providerId: 'openai', model: 'm1', dimensions: DIMS }
    const hash = contentHash('chunk one')
    const cache = new FileEmbeddingCache(root)
    const key = embeddingCacheKey(identity, hash)
    await mkdir(embeddingsDir(root), { recursive: true })
    await writeFile(join(embeddingsDir(root), key.slice(0, 2)), 'in the way', 'utf8')

    await cache.set(identity, hash, unitVector(4))
    expect(cache.stats.errors).toBeGreaterThan(0)
    // The memo still answers within the process; only durability was lost.
    expect(await cache.get(identity, hash)).toEqual(unitVector(4))
  })
})

// ── 3. the provider path, cached ────────────────────────────────────────────

describe('provider embeddings are fetched once and then read from disk', () => {
  it('caches a chunk so it is never re-embedded and never re-fetched', async () => {
    const root = await makeProject()
    const provider = fakeProvider({ respond: okEmbeddings((_t, i) => unitVector(i + 1)) })
    const first = new OfflineFirstEmbedder({ provider: provider.embedder, baseDir: root })

    const a = await first.embed(['chunk one', 'chunk two'])
    expect(provider.calls()).toBe(1)
    expect(first.status().mode).toBe('provider')
    expect(first.status().degraded).toBe(false)

    // Same texts, a NEW embedder over the same project: the restart case.
    const second = new OfflineFirstEmbedder({ provider: provider.embedder, baseDir: root })
    const b = await second.embed(['chunk one', 'chunk two'])

    expect(b).toEqual(a)
    expect(provider.calls()).toBe(1) // not re-fetched
    expect(second.status().cacheHits).toBe(2)
    expect(second.status().providerTexts).toBe(0)
  })

  it('sends only the misses when one chunk of a batch changed', async () => {
    const root = await makeProject()
    const provider = fakeProvider({ respond: okEmbeddings((t, i) => unitVector(t.length + i)) })
    const warm = new OfflineFirstEmbedder({ provider: provider.embedder, baseDir: root })
    await warm.embed(['stable chunk'])

    const next = new OfflineFirstEmbedder({ provider: provider.embedder, baseDir: root })
    await next.embed(['stable chunk', 'edited chunk!'])

    expect(provider.texts()).toEqual(['stable chunk', 'edited chunk!'])
    expect(next.status().cacheHits).toBe(1)
    expect(next.status().providerTexts).toBe(1)
  })

  it('re-embeds when the model changes rather than serving the stale vector', async () => {
    // THE INVALIDATION TEST. Drop `model` from the cache key preimage in
    // embedding-cache.ts and this fails: the m2 embedder would serve m1's vector
    // and never call the provider.
    const root = await makeProject()
    const m1 = fakeProvider({ model: 'm1', respond: okEmbeddings(() => unitVector(1)) })
    const m2 = fakeProvider({ model: 'm2', respond: okEmbeddings(() => unitVector(5)) })

    const withM1 = new OfflineFirstEmbedder({ provider: m1.embedder, baseDir: root })
    expect(await withM1.embed(['same text'])).toEqual([unitVector(1)])

    const withM2 = new OfflineFirstEmbedder({ provider: m2.embedder, baseDir: root })
    expect(await withM2.embed(['same text'])).toEqual([unitVector(5)])
    expect(m2.calls()).toBe(1)
    expect(withM2.status().cacheHits).toBe(0)
  })

  it('re-embeds when the provider changes, even for the same model name', async () => {
    // Same key insight as the model case: a gateway advertising `m1` is not the
    // same `m1`. Drop `providerId` from the preimage and this fails.
    const root = await makeProject()
    const direct = fakeProvider({ id: 'openai', model: 'm1', respond: okEmbeddings(() => unitVector(1)) })
    const gateway = fakeProvider({ id: 'gateway', model: 'm1', respond: okEmbeddings(() => unitVector(6)) })

    await new OfflineFirstEmbedder({ provider: direct.embedder, baseDir: root }).embed(['t'])
    const viaGateway = new OfflineFirstEmbedder({ provider: gateway.embedder, baseDir: root })
    expect(await viaGateway.embed(['t'])).toEqual([unitVector(6)])
    expect(gateway.calls()).toBe(1)
  })

  it('keeps every cache file free of key material', async () => {
    const root = await makeProject()
    const provider = fakeProvider({ respond: okEmbeddings(() => unitVector(2)) })
    const embedder = new OfflineFirstEmbedder({ provider: provider.embedder, baseDir: root })
    await embedder.embed(['some source code with an api key in it', FAKE_KEY])

    const bytes = await readAllFiles(embeddingsDir(root))
    expect(bytes.length).toBeGreaterThan(0)
    // Neither the configured credential nor the embedded text reaches disk.
    expect(bytes).not.toContain(FAKE_KEY)
    expect(bytes).not.toContain('some source code')
    expect(bytes).not.toContain('Authorization')
    expect(bytes).not.toContain('Bearer')
    expect(bytes).not.toContain('embeddings.example.invalid')
  })
})

// ── 4. never fail, never hang, never leak ───────────────────────────────────

describe('an unreachable provider degrades instead of failing', () => {
  it('returns local vectors, reports the degrade, and does not throw', async () => {
    // THE DEGRADE TEST. Make the catch in `fetchMissing` rethrow and this fails.
    const root = await makeProject()
    const provider = fakeProvider({
      respond: () => {
        throw new Error('getaddrinfo ENOTFOUND embeddings.example.invalid')
      },
    })
    const events = new MemoryEventStore()
    const embedder = new OfflineFirstEmbedder({
      provider: provider.embedder,
      baseDir: root,
      events,
      runId: 'run-1',
    })

    const vectors = await embedder.embed(['alpha token', 'beta token'])

    expect(vectors).toHaveLength(2)
    for (const vector of vectors) {
      expect(vector).toHaveLength(DIMS)
      expect(vector.every(v => Number.isFinite(v))).toBe(true)
      expect(vector.some(v => v !== 0)).toBe(true)
    }

    const status = embedder.status()
    expect(status.mode).toBe('local')
    expect(status.degraded).toBe(true)
    expect(status.reason).toContain('embedding provider unavailable')
    expect(status.mixedVectorSpaces).toBe(false)

    // Found BY KIND, not by payload key. That is the whole point of the
    // `EventKind` amendment: this used to be `context_loaded` plus
    // `component: 'embedder'`, so the only way to find a degrade was to read
    // payloads and hope the discriminator was spelled the same way.
    const emitted = (await events.readAll()).filter(e => e.kind === 'embedder_degraded')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.payload.component).toBeUndefined()
    expect(emitted[0]!.payload.degraded).toBe(true)
  })

  it('latches to local so a dead endpoint is not retried once per batch', async () => {
    const provider = fakeProvider({
      respond: () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const embedder = new OfflineFirstEmbedder({ provider: provider.embedder })
    await embedder.embed(['one'])
    await embedder.embed(['two'])
    await embedder.embed(['three'])
    expect(provider.calls()).toBe(1)
    expect(embedder.status().localEmbeds).toBe(3)
  })

  it('gives up on a hanging endpoint instead of hanging with it', async () => {
    // A socket that accepts and never answers. Without the deadline this test
    // never finishes; with it, the run degrades and continues.
    const provider = fakeProvider({
      timeoutMs: 60,
      respond: () => new Promise<Response>(() => {}),
    })
    const embedder = new OfflineFirstEmbedder({ provider: provider.embedder })
    const started = Date.now()
    const vectors = await embedder.embed(['slow chunk'])
    const elapsed = Date.now() - started

    expect(vectors).toHaveLength(1)
    expect(elapsed).toBeLessThan(5_000)
    expect(embedder.status().reason).toContain('exceeded')
  })

  it('degrades on a 401 without carrying the key into the reason', async () => {
    const provider = fakeProvider({
      respond: () =>
        ({
          ok: false,
          status: 401,
          text: async () => `{"error":{"message":"Invalid API key: ${FAKE_KEY}"}}`,
          json: async () => ({}),
        }) as unknown as Response,
    })
    const embedder = new OfflineFirstEmbedder({ provider: provider.embedder })
    await embedder.embed(['chunk'])

    const reason = embedder.status().reason ?? ''
    expect(reason).not.toContain(FAKE_KEY)
    expect(reason).toContain(REDACTED)
    expect(reason).toContain('401')
  })

  it('refuses a wrong-width vector and caches nothing from that response', async () => {
    const root = await makeProject()
    const provider = fakeProvider({
      // Three numbers where eight were configured: a model/dimension mismatch.
      respond: okEmbeddings(() => [1, 0, 0]),
    })
    const embedder = new OfflineFirstEmbedder({ provider: provider.embedder, baseDir: root })
    const vectors = await embedder.embed(['chunk'])

    expect(vectors[0]).toHaveLength(DIMS)
    expect(embedder.status().mode).toBe('local')
    // Nothing was persisted: a garbage vector in the cache would outlive the run.
    await expect(readAllFiles(embeddingsDir(root))).resolves.toBe('')
  })

  it('degrades on a short batch rather than misaligning vectors with chunks', async () => {
    const provider = fakeProvider({
      respond: () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: unitVector(1), index: 0 }] }),
          text: async () => '',
        }) as unknown as Response,
    })
    const embedder = new OfflineFirstEmbedder({ provider: provider.embedder })
    const vectors = await embedder.embed(['one', 'two'])
    expect(vectors).toHaveLength(2)
    expect(embedder.status().mode).toBe('local')
    expect(embedder.status().reason).toContain('expected 2 embeddings')
  })

  it('reports mixed vector spaces when a run gets some of each', async () => {
    // The honest cost of degrading mid-run: the index now holds two
    // incomparable spaces, and the remedy is a rebuild.
    let healthy = true
    const provider = fakeProvider({
      respond: texts => {
        if (!healthy) throw new Error('ECONNRESET')
        return okEmbeddings((_t, i) => unitVector(i + 1))(texts)
      },
    })
    const embedder = new OfflineFirstEmbedder({ provider: provider.embedder })
    await embedder.embed(['first batch'])
    healthy = false
    await embedder.embed(['second batch'])

    expect(embedder.status().mixedVectorSpaces).toBe(true)
  })

  it('falls through to the pure vectoriser when even the local embedder throws', async () => {
    // The floor under the never-throws promise.
    const brokenLocal: IdentifiedEmbedder = {
      providerId: 'broken',
      model: 'broken',
      dimensions: DIMS,
      embed: async () => {
        throw new Error('local embedder is broken')
      },
    }
    const embedder = new OfflineFirstEmbedder({ local: brokenLocal, dimensions: DIMS })
    const vectors = await embedder.embed(['alpha beta gamma'])
    expect(vectors).toHaveLength(1)
    expect(vectors[0]).toEqual(hashEmbed('alpha beta gamma', DIMS))
  })

  it('always returns one vector per input, of the configured width', async () => {
    const embedder = new OfflineFirstEmbedder({ dimensions: 32 })
    const texts = ['a', '', 'const x = 1', 'x'.repeat(5_000)]
    const vectors = await embedder.embed(texts)
    expect(vectors).toHaveLength(texts.length)
    for (const vector of vectors) expect(vector).toHaveLength(32)
    expect(await embedder.embed([])).toEqual([])
  })

  it('keeps HashEmbedder itself network-free and unchanged', async () => {
    // The 5.2 tests construct HashEmbedder directly; its behaviour is a
    // compatibility surface, not an implementation detail.
    const embedder = new HashEmbedder(128)
    const [vector] = await embedder.embed(['unchanged'])
    expect(vector).toEqual(hashEmbed('unchanged', 128))
    expect(embedder.providerId).toBe(LOCAL_EMBEDDER_ID)
  })
})

/** Concatenate every file under `dir`, recursively. Empty string when absent. */
async function readAllFiles(dir: string): Promise<string> {
  let out = ''
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return ''
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const info = await stat(full)
    out += info.isDirectory() ? await readAllFiles(full) : await readFile(full, 'utf8')
  }
  return out
}
