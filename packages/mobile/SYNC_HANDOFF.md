# Sketch Mobile — sync + offline handoff

## 1. Sync bundle v2 (`src/sync.ts`)

A **file bundle**, not live / real-time sync. The phone and the desktop never
talk to each other directly. One side exports a bundle file, the file is moved
(Drive, GitHub, cable, any file transfer), the other side imports it and the
merge below runs. That is the whole sync story — nothing here is live, and
nothing here makes a network call.

### Format

```ts
interface SketchSyncBundle {
  format: 'sketch-sync'
  version: 2
  exportedAt: string            // ISO date string
  app: 'sketch-mobile'
  project: { name: string; files: { path: string; content: string; updatedAt: number }[] }
  manifest: { fileCount: number; totalBytes: number; sha256: string }
}
```

- `manifest.sha256` is a real SHA-256 (64 lowercase hex chars) over the
  canonical JSON of the files — files sorted by path, object keys sorted
  recursively — computed with `crypto.subtle` when available.
- Where `crypto.subtle` is unavailable, the hash is a synchronous FNV-1a
  checksum stored as `fnv1a:<8 hex chars>`. That fallback is
  **non-cryptographic** and is labelled as such in code, docs and the stored
  value itself; it is never called SHA-256.
- Per-file limit: 5 MiB (`MAX_FILE_BYTES`). Larger files are rejected at
  creation and at validation.

### Functions (`src/sync.ts`)

| Function | Behaviour |
|---|---|
| `createSyncBundle({ name, files })` | Async (hashing is async). Throws on oversized files / unsafe paths. |
| `validateSyncBundle(unknown)` | Async, returns `{ ok, errors[], bundle? }`. Rejects wrong `format`/`version`/`app`, missing/inconsistent manifest, hash mismatch (tampering), oversized files, duplicate paths, path traversal (`..` segments, absolute or backslash paths), bad `updatedAt`. |
| `applySyncBundle(bundle, existingFiles)` | Sync. Returns `{ merged, conflicts, added, updated, skipped }`. |
| `syncBundleToJson(bundle)` / `parseSyncBundleJson(text)` | JSON round-trip helpers. |
| `getLastSync(storage?)` / `setLastSync(info, storage?)` | Last-sync status `{ exportedAt, fileCount }` in localStorage under `sketch-mobile:last-sync`. |
| `computeBundleHash(files)`, `canonicalFilesJson(files)`, `fnv1aHex(text)` | Hash helpers (exported for tests / desktop reuse). |

### Merge rules (`applySyncBundle`)

- Incoming file not on this phone → **added**.
- Same content → **skipped** (no change, no conflict).
- Different content, incoming `updatedAt` newer → **updated** (incoming wins).
- Different content, incoming `updatedAt` older → **skipped** (existing wins, not a conflict).
- Different content, **equal** `updatedAt` → **conflict**: existing file is kept,
  reported as `{ path, kept: 'existing', reason }`, and also listed in `skipped`.

### UI wiring (already done)

Settings → "Sync with desktop" in `src/App.tsx` (the old v1 Export/Import
project buttons are untouched and still work):

```tsx
// Export
const bundle = await createSyncBundle({ name: 'Sketch mobile project', files })
download(`sketch-sync-${bundle.exportedAt.slice(0, 10)}.json`, syncBundleToJson(bundle), 'application/json')
const info = { exportedAt: bundle.exportedAt, fileCount: bundle.manifest.fileCount }
setLastSync(info) // also shown in Settings as "Last sync: N files · <date>"

// Import
const result = await validateSyncBundle(parseSyncBundleJson(text))
if (!result.ok || result.bundle === undefined) { /* show result.errors */ return }
const applied = applySyncBundle(result.bundle, files)
setFiles(applied.merged)
setLastSync({ exportedAt: result.bundle.exportedAt, fileCount: result.bundle.manifest.fileCount })
// applied.conflicts (if any) are shown to the user; those files kept the phone copy.
```

Desktop side (not built here): read the same JSON, run the same rules —
`createSyncBundle` / `validateSyncBundle` / `applySyncBundle` in `src/sync.ts`
are plain TypeScript with no mobile-only dependency except `newId` from
`./store` (used only to give newly added files an id); a desktop port needs
only that one helper replaced.

## 2. Service worker (`public/sw.js`, `src/serviceWorker.ts`)

- `public/sw.js` — cache name `sketch-mobile-v1`. On install it caches the
  app shell (`/`, `/index.html`, `/manifest.webmanifest`, icons). Navigations
  are network-first with the cached shell as the offline fallback; other
  same-origin GETs are cache-first. Old caches are deleted on activate.
  **Provider / API calls are never cached**: any cross-origin request, or any
  URL containing `chat/completions`, bypasses the worker entirely.
- `src/serviceWorker.ts` — `registerServiceWorker()` registers `/sw.js`
  **only in production builds** (`import.meta.env.PROD`) and only when
  `'serviceWorker' in navigator`. It resolves to `null` (app works as before,
  online only) when unsupported or when registration fails. Called once from
  `src/main.tsx`; it is safe in dev and in tests because the production guard
  returns early there. The optional `deps` argument (`{ navigator, production }`)
  exists so tests can pass a mocked navigator.

## 3. Limits — stated plainly

- **This is still file-bundle sync, NOT live/real-time sync.** There is no
  server, no websocket, no background sync, no conflict UI beyond the
  one-line report in Settings, and no merge of two edits to the same file
  (equal timestamps keep the phone copy).
- Offline works for the **app shell after first load**; the agent still needs
  network because provider calls are never cached, and files edited offline
  only reach the desktop when a bundle is exported and imported.
- The FNV-1a fallback hash is a checksum, not a cryptographic hash: on a
  device without `crypto.subtle` a tampered bundle is much less reliably
  detected. In practice modern phones/browsers provide `crypto.subtle`.
- No terminal, no git, no builds on mobile — unchanged.
