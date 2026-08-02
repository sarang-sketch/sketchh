// Absolute-path canonicalization for the editor's `Map<path, model>`.
//
// WHY THIS FILE EXISTS AT ALL. Requirement 15.1 says the model map is keyed by
// absolute path, and Monaco keys its models by `Uri`. Those are two different
// namespaces, and on Windows the same file has several spellings that are all
// "the same absolute path":
//
//     C:\Users\me\app\src\App.tsx
//     c:/Users/me/app/src/App.tsx
//     C:/Users/me/app//src/App.tsx
//     C:/Users/me/app/src/../src/App.tsx
//
// If any two of those reach `createModel` we get TWO models for ONE file, each
// with its own text — the exact "two sources of truth" trap this phase exists to
// avoid. So every path entering the editor is first put through `canonicalPath`,
// and that canonical string is the ONLY key used for `state.files`, for the model
// map, and for the Monaco `Uri`.
//
// THE WINDOWS PATH → URI MAPPING, spelled out because this is where it breaks:
//
//     "C:\Users\me\app\src\App.tsx"     raw path from the OS / the engine
//   → "C:/Users/me/app/src/App.tsx"     canonicalPath: `\`→`/`, collapse `//`,
//                                       resolve `.`/`..`, upper-case the drive
//   → monaco.Uri.file(that)             → "file:///c%3A/Users/me/app/src/App.tsx"
//
// `Uri.file` lower-cases the drive letter and percent-encodes the colon itself, so
// we must NOT try to build the URI string by hand — we hand it a canonical path
// and let it do that once. Because `canonicalPath` is idempotent and injective on
// paths that differ by more than spelling, `path → Uri` is one-to-one, which is
// what makes `Map<path, model>` and Monaco's own model registry agree.
//
// This module only imports the synchronous editor extension registry. It remains
// free of Monaco and filesystem work.
//
// Validates: Requirements 15.1, 15.2

import { editorExtensionRegistry } from './extensionRegistry'

/** A drive-letter path (`C:\...`, `c:/...`). */
const WINDOWS_DRIVE = /^[A-Za-z]:[/\\]/

/** True for `C:\x`, `/x`, and UNC `\\server\share`. */
export function isAbsolutePath(path: string): boolean {
  const value = path.trim()
  if (value === '') return false
  return WINDOWS_DRIVE.test(value) || value.startsWith('/') || value.startsWith('\\')
}

/**
 * Resolve `.` and `..` inside an already slash-separated body. A `..` that would
 * climb above the first segment is dropped rather than kept: keeping it would
 * produce a key that no longer names a real location, and containment is enforced
 * separately (and authoritatively) in Rust.
 */
function resolveDotSegments(segments: string[]): string[] {
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out
}

/**
 * The one canonical spelling of an absolute path. Idempotent:
 * `canonicalPath(canonicalPath(p)) === canonicalPath(p)`.
 *
 * Not a filesystem operation — no symlink resolution, no case folding of anything
 * but the drive letter. Rust canonicalizes for real when it enforces containment;
 * this is only about not minting two keys for one file.
 */
export function canonicalPath(path: string): string {
  const value = path.trim().replace(/\\/g, '/')
  if (value === '') return ''

  // UNC: `//server/share/...`. The leading double slash is part of the path.
  if (value.startsWith('//')) {
    const body = resolveDotSegments(value.slice(2).split('/'))
    return `//${body.join('/')}`
  }

  if (WINDOWS_DRIVE.test(value)) {
    const drive = value.slice(0, 2).toUpperCase()
    const body = resolveDotSegments(value.slice(2).split('/'))
    return `${drive}/${body.join('/')}`
  }

  if (value.startsWith('/')) {
    return `/${resolveDotSegments(value.split('/')).join('/')}`
  }

  // Relative. Kept relative; callers that need an absolute key use `toAbsolutePath`.
  return resolveDotSegments(value.split('/')).join('/')
}

/**
 * Canonical absolute path for `path`, interpreted against `root` when relative.
 * The engine's `edit_accepted` events carry project-relative paths, so this is the
 * function that turns an engine event into a model-map key.
 */
export function toAbsolutePath(root: string, path: string): string {
  if (isAbsolutePath(path)) return canonicalPath(path)
  const base = canonicalPath(root)
  if (base === '') return canonicalPath(path)
  return canonicalPath(`${base}/${path}`)
}

/**
 * Whether `absolutePath` sits inside `root`. Advisory only — it exists so the UI
 * can say "that file is outside the project" before making a call the backend
 * would refuse anyway. The authoritative check is `command_policy` in Rust and is
 * never bypassed or weakened here (Requirement 15.6).
 */
export function isWithinRoot(root: string, absolutePath: string): boolean {
  const base = canonicalPath(root)
  const target = canonicalPath(absolutePath)
  if (base === '' || target === '') return false
  // Windows and macOS are case-insensitive in practice; comparing case-sensitively
  // would report a false "outside the project" for `c:/x` under root `C:/x`.
  const caseless = WINDOWS_DRIVE.test(`${base}/`)
  const a = caseless ? base.toLowerCase() : base
  const b = caseless ? target.toLowerCase() : target
  return b === a || b.startsWith(a.endsWith('/') ? a : `${a}/`)
}

/** `C:/app/src/App.tsx` under `C:/app` → `src/App.tsx`. Falls back to the input. */
export function relativeToRoot(root: string, absolutePath: string): string {
  const base = canonicalPath(root)
  const target = canonicalPath(absolutePath)
  if (!isWithinRoot(base, target)) return target
  const rest = target.slice(base.length)
  return rest.startsWith('/') ? rest.slice(1) : rest
}

export function basename(path: string): string {
  const canonical = canonicalPath(path)
  const index = canonical.lastIndexOf('/')
  return index === -1 ? canonical : canonical.slice(index + 1)
}

/** Path segments, for the breadcrumb. Empty for a path with no root-relative part. */
export function pathSegments(root: string, absolutePath: string): string[] {
  return relativeToRoot(root, absolutePath).split('/').filter((s) => s !== '')
}

/**
 * Monaco language id for a path. Mappings come from the same process-local
 * registry the production loader consumes; unknown extensions remain plaintext.
 */
export function languageForPath(path: string): string {
  const name = basename(path).toLowerCase()
  if (name === 'dockerfile') {
    return editorExtensionRegistry.languageForExtension('dockerfile') ?? 'plaintext'
  }
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  return editorExtensionRegistry.languageForExtension(name.slice(dot + 1)) ?? 'plaintext'
}
