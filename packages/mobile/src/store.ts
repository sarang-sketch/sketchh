// The mobile project's files. They live in this phone's browser storage
// (localStorage) — the mobile app has no desktop filesystem, and it never
// pretends otherwise. Export downloads the whole project as one JSON file;
// import reads that file back. Nothing leaves the phone except a provider
// request the user explicitly configures in Settings.

export interface MobileFile {
  id: string
  /** Slash-separated path, e.g. `src/app.js`. Folders are implied by paths. */
  path: string
  content: string
  updatedAt: number
}

export const STORE_KEY = 'sketch.mobile.files.v1'

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function seedProject(now = Date.now()): MobileFile[] {
  return [
    {
      id: newId(),
      path: 'README.md',
      content:
        '# My Sketch project\n\nThis project lives on your phone. Tap a file to edit it,\nask the agent about it, or preview it.\n\n- `index.html` — a page you can preview\n- `src/app.js` — JavaScript you can run in Preview\n',
      updatedAt: now,
    },
    {
      id: newId(),
      path: 'index.html',
      content:
        '<!doctype html>\n<html>\n  <head><meta charset="utf-8"><title>Hello from Sketch</title></head>\n  <body style="font-family: sans-serif; background: #141414; color: #eeeeec; padding: 24px;">\n    <h1>Hello from Sketch</h1>\n    <p>Edit this file, then open Preview to see it change.</p>\n  </body>\n</html>\n',
      updatedAt: now,
    },
    {
      id: newId(),
      path: 'src/app.js',
      content:
        '// Run this in Preview — console output shows below the page.\nconst numbers = [1, 2, 3, 4, 5]\nconsole.log("sum:", numbers.reduce((a, b) => a + b, 0))\n',
      updatedAt: now,
    },
  ]
}

export function loadFiles(storage: Storage = localStorage): MobileFile[] {
  try {
    const raw = storage.getItem(STORE_KEY)
    if (raw === null) {
      const seeded = seedProject()
      storage.setItem(STORE_KEY, JSON.stringify(seeded))
      return seeded
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return seedProject()
    return parsed.filter(
      (f): f is MobileFile =>
        !!f && typeof f.id === 'string' && typeof f.path === 'string' && typeof f.content === 'string',
    )
  } catch {
    return seedProject()
  }
}

export function saveFiles(files: readonly MobileFile[], storage: Storage = localStorage): void {
  try {
    storage.setItem(STORE_KEY, JSON.stringify(files))
  } catch {
    // Storage full or unavailable (private mode): edits stay in memory for the session.
  }
}

/** A new file, named so it never collides with an existing path. A blank
 *  name creates nothing — the UI never silently creates an "untitled" file. */
export function createFile(files: readonly MobileFile[], name: string): MobileFile[] {
  const clean = name.trim().replace(/^\/+/, '')
  if (clean === '') return [...files]
  let path = clean
  let n = 2
  while (files.some((f) => f.path === path)) {
    const dot = clean.lastIndexOf('.')
    path = dot > 0 ? `${clean.slice(0, dot)}-${n}${clean.slice(dot)}` : `${clean}-${n}`
    n += 1
  }
  return [...files, { id: newId(), path, content: '', updatedAt: Date.now() }]
}

/** Build the path for a new file: the typed name, with the chosen extension
 *  added when the name has no extension yet. Returns '' for a blank name. */
export function buildFilePath(name: string, ext: string): string {
  const clean = name.trim().replace(/^\/+/, '')
  if (clean === '') return ''
  if (/\.[a-z0-9]+$/i.test(clean)) return clean
  return `${clean}.${ext}`
}

/** Byte length of a string as UTF-8. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function fileBytes(file: MobileFile): number {
  return byteLength(file.content)
}

export function fileLines(file: MobileFile): number {
  return file.content === '' ? 0 : file.content.split('\n').length
}

/** Human size: 12 B, 1.2 KB, 3.4 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `${(tokens / 1000).toFixed(1)}k`
}

/** Relative time: "just now", "5m ago", "2h ago", "3d ago", or a short date. */
export function timeAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  return new Date(ts).toLocaleDateString()
}

export interface ProjectStats {
  files: number
  lines: number
  bytes: number
}

export function projectStats(files: readonly MobileFile[]): ProjectStats {
  return {
    files: files.length,
    lines: files.reduce((sum, f) => sum + fileLines(f), 0),
    bytes: files.reduce((sum, f) => sum + fileBytes(f), 0),
  }
}

/** The starter template: the same three files a fresh project starts with. */
export function starterFiles(now = Date.now()): MobileFile[] {
  return seedProject(now)
}

export function updateFile(files: readonly MobileFile[], id: string, content: string): MobileFile[] {
  return files.map((f) => (f.id === id ? { ...f, content, updatedAt: Date.now() } : f))
}

export function renameFile(files: readonly MobileFile[], id: string, path: string): MobileFile[] {
  const clean = path.trim().replace(/^\/+/, '')
  if (clean === '' || files.some((f) => f.id !== id && f.path === clean)) return [...files]
  return files.map((f) => (f.id === id ? { ...f, path: clean, updatedAt: Date.now() } : f))
}

export function deleteFile(files: readonly MobileFile[], id: string): MobileFile[] {
  return files.filter((f) => f.id !== id)
}

/** The whole project as one JSON file, for export / import. */
export function projectToJson(files: readonly MobileFile[]): string {
  return JSON.stringify({ app: 'sketch-mobile', version: 1, files }, null, 2)
}

export function projectFromJson(text: string): MobileFile[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { files?: unknown }).files)) return null
    const files = (parsed as { files: unknown[] }).files.filter(
      (f): f is MobileFile =>
        !!f && typeof f === 'object' && typeof (f as MobileFile).path === 'string' && typeof (f as MobileFile).content === 'string',
    )
    if (files.length === 0) return null
    return files.map((f) => ({ ...f, id: typeof f.id === 'string' ? f.id : newId(), updatedAt: Date.now() }))
  } catch {
    return null
  }
}

/** Folders implied by the file paths, top-level first. */
export function foldersOf(files: readonly MobileFile[]): string[] {
  const out = new Set<string>()
  for (const f of files) {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'))
  }
  return [...out].sort()
}
