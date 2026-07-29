// The file tree, as a pure function of two caches.
//
// WHY THIS IS NOT A TREE OF OBJECTS. The panel this replaces held a nested
// `FileNode[]` in `useState` and toggled a folder by deep-copying the whole tree with
// `JSON.parse(JSON.stringify(...))` and mutating the copy. That shape has to be kept
// in step with the filesystem by hand, and once a node carries `isOpen`, `children`
// and (inevitably) content, the tree becomes a second file cache competing with
// `AppState.files` — which is exactly the duplication task 3.1 removed.
//
// So the tree is DERIVED. Two flat caches own everything:
//
//   dirs      Map<dirPath, DirLoad>   what one `read_dir` answered, per directory
//   expanded  Set<dirPath>            which directories the user has opened
//
// and `flattenTree` turns them into the rows to render. Collapsing a folder does not
// discard what was read; re-reading is a refresh, which is a separate action.
//
// Pure string and collection work: no React, no I/O, no filesystem. Every rule below
// — what a loading folder looks like, what an empty one says, what a failed one says,
// what happens at a symlink loop — is testable without a DOM.
//
// Validates: Requirements 14.4, 27.3, 27.5

/** One directory entry. Structurally the backend's `FsEntry`. */
export interface TreeEntry {
  name: string
  /** Absolute path as the backend spelled it. */
  path: string
  isDir: boolean
}

/** What is known about one directory. There is no fourth state: absent means unread. */
export type DirLoad =
  | { status: 'loading' }
  | { status: 'ready'; entries: TreeEntry[] }
  /** Named, with the reason. A failure is NEVER rendered as an empty folder. */
  | { status: 'error'; message: string }

export type TreeRow =
  | { kind: 'dir'; key: string; depth: number; path: string; name: string; expanded: boolean }
  | { kind: 'file'; key: string; depth: number; path: string; name: string }
  /** A sentence where children would be: reading, empty, failed, or a loop. */
  | { kind: 'note'; key: string; depth: number; tone: 'info' | 'error'; text: string }

export interface TreeInput {
  /** The open project root. Always listed; it is not in `expanded`. */
  root: string
  dirs: Map<string, DirLoad>
  expanded: Set<string>
}

export const READING = 'Reading…'
export const EMPTY_FOLDER = 'This folder is empty.'
/** Said out loud rather than silently returning nothing. */
export const UNREAD_FOLDER = 'Not read yet.'

/**
 * The rows to render, top to bottom.
 *
 * A directory contributes its own row, and — when expanded — either its children or
 * exactly one note explaining why there are none. The distinction between "empty",
 * "still reading" and "failed" is the whole point: all three used to look identical.
 */
export function flattenTree(input: TreeInput): TreeRow[] {
  const rows: TreeRow[] = []
  walk(input, input.root, 0, [input.root], rows)
  return rows
}

function walk(
  input: TreeInput,
  dir: string,
  depth: number,
  ancestors: string[],
  rows: TreeRow[],
): void {
  const load = input.dirs.get(dir)

  if (load === undefined) {
    rows.push({ kind: 'note', key: `${dir}:unread`, depth, tone: 'info', text: UNREAD_FOLDER })
    return
  }
  if (load.status === 'loading') {
    rows.push({ kind: 'note', key: `${dir}:loading`, depth, tone: 'info', text: READING })
    return
  }
  if (load.status === 'error') {
    rows.push({ kind: 'note', key: `${dir}:error`, depth, tone: 'error', text: load.message })
    return
  }
  if (load.entries.length === 0) {
    rows.push({ kind: 'note', key: `${dir}:empty`, depth, tone: 'info', text: EMPTY_FOLDER })
    return
  }

  for (const entry of load.entries) {
    if (!entry.isDir) {
      rows.push({
        kind: 'file',
        key: entry.path,
        depth,
        path: entry.path,
        name: entry.name,
      })
      continue
    }

    const isExpanded = input.expanded.has(entry.path)
    rows.push({
      kind: 'dir',
      key: entry.path,
      depth,
      path: entry.path,
      name: entry.name,
      expanded: isExpanded,
    })
    if (!isExpanded) continue

    // A symlinked directory can point at one of its own ancestors. Recursing would
    // not merely be slow, it would not terminate. Say so instead.
    if (ancestors.includes(entry.path)) {
      rows.push({
        kind: 'note',
        key: `${entry.path}:cycle`,
        depth: depth + 1,
        tone: 'error',
        text: 'This folder links back to a folder it is already inside, so it is not expanded.',
      })
      continue
    }

    walk(input, entry.path, depth + 1, [...ancestors, entry.path], rows)
  }
}

/**
 * The directories that must be read for the current expansion: the root, plus every
 * expanded directory that is actually REACHABLE from it.
 *
 * Reachability matters. `expanded` is kept when a parent collapses, so that
 * re-opening the parent restores what the user had open — but a directory whose
 * parent is closed must not be re-read, or a refresh would fetch a subtree nobody
 * can see. This is the only place that decides what to fetch, so the effect that
 * fetches cannot invent its own answer.
 */
export function directoriesToRead(input: TreeInput): string[] {
  const out = [input.root]
  const seen = new Set(out)

  const visit = (dir: string) => {
    const load = input.dirs.get(dir)
    if (load === undefined || load.status !== 'ready') return
    for (const entry of load.entries) {
      if (!entry.isDir || !input.expanded.has(entry.path) || seen.has(entry.path)) continue
      seen.add(entry.path)
      out.push(entry.path)
      visit(entry.path)
    }
  }
  visit(input.root)

  return out
}
