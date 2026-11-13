import { describe, expect, it } from 'vitest'

import {
  applySyncBundle, computeBundleHash, createSyncBundle, fnv1aHex, getLastSync, MAX_FILE_BYTES,
  parseSyncBundleJson, setLastSync, syncBundleToJson, validateSyncBundle,
  type LastSyncInfo, type SketchSyncBundle,
} from './sync'

const files = [
  { id: '1', path: 'src/app.js', content: 'const a = 1\n', updatedAt: 1000 },
  { id: '2', path: 'index.html', content: '<h1>hi</h1>\n', updatedAt: 2000 },
]

function fakeStorage(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size },
  } as Storage
}

describe('sync bundle v2', () => {
  it('creates a bundle with a matching manifest', async () => {
    const bundle = await createSyncBundle({ name: 'My project', files })
    expect(bundle.format).toBe('sketch-sync')
    expect(bundle.version).toBe(2)
    expect(bundle.app).toBe('sketch-mobile')
    expect(bundle.manifest.fileCount).toBe(2)
    expect(bundle.manifest.totalBytes).toBeGreaterThan(0)
    // Real SHA-256 when crypto.subtle is available, otherwise the labelled
    // non-cryptographic fnv1a fallback — never an unlabelled fake SHA-256.
    if (typeof globalThis.crypto?.subtle?.digest === 'function') {
      expect(bundle.manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
    } else {
      expect(bundle.manifest.sha256.startsWith('fnv1a:')).toBe(true)
      expect(fnv1aHex('test')).toMatch(/^[0-9a-f]{8}$/)
    }
    expect(bundle.manifest.sha256).toBe(await computeBundleHash(bundle.project.files))
    expect(await validateSyncBundle(bundle)).toEqual({ ok: true, errors: [], bundle })
  })

  it('round-trips through JSON.stringify/parse', async () => {
    const bundle = await createSyncBundle({ name: 'My project', files })
    const parsed = parseSyncBundleJson(syncBundleToJson(bundle))
    const result = await validateSyncBundle(parsed)
    expect(result.ok).toBe(true)
    expect(result.bundle?.project.files).toEqual(bundle.project.files)
  })

  it('rejects a tampered bundle (hash mismatch)', async () => {
    const bundle = await createSyncBundle({ name: 'My project', files })
    const tampered = JSON.parse(syncBundleToJson(bundle)) as SketchSyncBundle
    tampered.project.files[0]!.content = 'const a = 999\n'
    const result = await validateSyncBundle(tampered)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/sha256/i)
  })

  it('rejects the wrong format or version', async () => {
    const bundle = await createSyncBundle({ name: 'My project', files })
    const wrongFormat = { ...bundle, format: 'other-sync' }
    expect((await validateSyncBundle(wrongFormat)).ok).toBe(false)
    const wrongVersion = { ...bundle, version: 1 }
    const versionResult = await validateSyncBundle(wrongVersion)
    expect(versionResult.ok).toBe(false)
    expect(versionResult.errors.join(' ')).toMatch(/version/)
    expect((await validateSyncBundle(null)).ok).toBe(false)
    expect((await validateSyncBundle({ ...bundle, manifest: undefined })).ok).toBe(false)
  })

  it('rejects path traversal', async () => {
    const bundle = await createSyncBundle({ name: 'My project', files })
    const evil = JSON.parse(syncBundleToJson(bundle)) as SketchSyncBundle
    evil.project.files.push({ path: '../secret.txt', content: 'x', updatedAt: 1 })
    evil.manifest.fileCount = 3
    const result = await validateSyncBundle(evil)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/unsafe|traversal/i)
  })

  it('rejects an oversized file', async () => {
    await expect(
      createSyncBundle({ name: 'Big', files: [{ path: 'big.txt', content: 'x'.repeat(MAX_FILE_BYTES + 1), updatedAt: 1 }] }),
    ).rejects.toThrow(/5 MiB/)
  })

  it('merges by updatedAt: newer wins, older is skipped, equal timestamps conflict', async () => {
    const bundle = await createSyncBundle({
      name: 'Desktop',
      files: [
        { path: 'src/app.js', content: 'newer', updatedAt: 3000 }, // newer than existing (1000)
        { path: 'index.html', content: 'older', updatedAt: 500 }, // older than existing (2000)
        { path: 'src/same.js', content: 'same', updatedAt: 1000 }, // equal time, different content
        { path: 'new.txt', content: 'brand new', updatedAt: 4000 },
      ],
    })
    const existing = [
      ...files,
      { id: '3', path: 'src/same.js', content: 'different', updatedAt: 1000 },
    ]
    const result = applySyncBundle(bundle, existing)
    expect(result.added).toEqual(['new.txt'])
    expect(result.updated).toEqual(['src/app.js'])
    expect(result.skipped).toEqual(expect.arrayContaining(['index.html', 'src/same.js']))
    expect(result.conflicts).toEqual([
      { path: 'src/same.js', kept: 'existing', reason: expect.stringContaining('Same updatedAt') },
    ])
    const mergedByPath = new Map(result.merged.map((f) => [f.path, f]))
    expect(mergedByPath.get('src/app.js')?.content).toBe('newer')
    expect(mergedByPath.get('index.html')?.content).toBe('<h1>hi</h1>\n') // older incoming did not overwrite
    expect(mergedByPath.get('src/same.js')?.content).toBe('different') // conflict kept existing
    expect(mergedByPath.get('new.txt')?.content).toBe('brand new')
  })

  it('skips files whose content is identical', async () => {
    const bundle = await createSyncBundle({ name: 'Desktop', files })
    const result = applySyncBundle(bundle, files)
    expect(result.added).toEqual([])
    expect(result.updated).toEqual([])
    expect(result.conflicts).toEqual([])
    expect(result.skipped).toEqual(['src/app.js', 'index.html'])
  })
})

describe('last sync status', () => {
  it('stores and reads the last sync info in localStorage', () => {
    const storage = fakeStorage()
    expect(getLastSync(storage)).toBeNull()
    const info: LastSyncInfo = { exportedAt: '2026-11-13T00:00:00.000Z', fileCount: 3 }
    setLastSync(info, storage)
    expect(getLastSync(storage)).toEqual(info)
  })

  it('returns null for corrupt stored data', () => {
    const storage = fakeStorage()
    storage.setItem('sketch-mobile:last-sync', 'not json')
    expect(getLastSync(storage)).toBeNull()
  })
})
