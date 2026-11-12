// Which folders the user has allowed the terminal to run commands in.
//
// The engine refuses a terminal command without `confirmed: true`, and the panel earns
// that by asking. Asking before EVERY command made the terminal unusable as a terminal,
// so the question is asked once per folder, the way an IDE asks whether to trust a
// workspace: "Run once" asks again next time; "Always allow in this folder" remembers it
// here, in this window's local storage and nowhere else. Settings lists the folders and
// can forget any of them.

import { canonicalPath } from '../editor/paths'

const KEY = 'sketch.terminal.trusted.v1'

function store(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

function key(root: string): string {
  const canonical = canonicalPath(root)
  // Windows paths are case-insensitive: one folder, one entry.
  return /^[A-Za-z]:\//.test(canonical) ? canonical.toLowerCase() : canonical
}

/** Every folder the terminal may run in without asking, as stored. */
export function trustedFolders(): string[] {
  const s = store()
  if (s === null) return []
  try {
    const raw = JSON.parse(s.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function isFolderTrusted(root: string | null): boolean {
  if (root === null || root === '') return false
  return trustedFolders().includes(key(root))
}

export function trustFolder(root: string): void {
  const s = store()
  if (s === null) return
  const next = [...new Set([...trustedFolders(), key(root)])].slice(-200)
  try {
    s.setItem(KEY, JSON.stringify(next))
  } catch {
    // Quota or privacy mode: the folder is simply asked about again next time.
  }
}

export function forgetTrustedFolder(root: string): void {
  const s = store()
  if (s === null) return
  const k = key(root)
  try {
    s.setItem(KEY, JSON.stringify(trustedFolders().filter((f) => f !== k)))
  } catch {
    /* nothing to forget */
  }
  sessionAllowed.delete(k)
}

/** Folders allowed until the app restarts ("Allow until I restart"). Never stored. */
const sessionAllowed = new Set<string>()

export function allowFolderForSession(root: string): void {
  sessionAllowed.add(key(root))
}

/** May a terminal run in `root` without asking: trusted, or allowed for this session. */
export function isFolderAllowed(root: string | null): boolean {
  if (root === null || root === '') return false
  return isFolderTrusted(root) || sessionAllowed.has(key(root))
}
