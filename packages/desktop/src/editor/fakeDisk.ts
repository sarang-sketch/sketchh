// A test double for the file layer named by ./fileIo.ts (`FileIo`).
//
// TEST-ONLY. Nothing under src/ may import this file, and ./editor.test.tsx asserts
// that alongside the same rule for ./monacoDouble.ts. It exists because the real
// implementation is a Tauri `invoke`, which does not exist under jsdom — so without
// a double, every test of opening, saving and reconciling a file would have to mock
// the thing it is trying to test.
//
// WHAT IS FAKE: the bytes live in a Map instead of on disk, and the folder picker
// answers with whatever the test set. That is all.
//
// WHAT IS FAITHFUL, on purpose: the refusals. Containment lives in Rust
// (src-tauri/src/command_policy.rs) and is never weakened or bypassed here; this
// double reproduces the SHAPE of its two refusal messages ("… is outside the open
// project root …", "… escapes the project root …") and the OS "os error 2", because
// `describeFileFailure` reads those strings and a test that invented friendlier
// wording would prove nothing about what a user sees.
//
// WHAT IS REAL IN EVERY TEST THAT USES IT: `readForEditor`, `writeFromEditor`,
// `describeFileFailure`, `useFileActions`, the `AppState` reducer, `ModelRegistry`
// and the reconciler.

import type { FileIo } from './fileIo'
import { canonicalPath, isWithinRoot } from './paths'

export interface FakeDisk {
  /** Hand this to `<FileIoProvider io={…}>`. */
  io: FileIo
  /** The bytes, by canonical absolute path. */
  files: Map<string, string>
  /** Every read attempt, in order, with the root that was passed with it. */
  reads: Array<{ root: string; path: string }>
  /** Every write attempt that passed containment. */
  writes: Array<{ root: string; path: string; content: string }>
  /** What the folder picker returns. Null is a cancelled dialog. */
  pickResult: string | null
  /** Set to make the picker itself fail, as a cancelled OS dialog cannot. */
  pickError: Error | null
  pickCalls: number
  /**
   * Set to make every write fail. The case this stands in for is real: a path that
   * READS fine can still fail `resolve_write_target` in Rust — a symlink inside the
   * project pointing out of it is canonicalized on the write side and refused.
   */
  writeError: Error | null
  /** Write behind the editor's back — what the engine's file writer does. */
  set(path: string, content: string): void
  read(path: string): string | undefined
}

function refuseOutside(root: string, path: string): void {
  if (root.trim() === '') throw new Error('no project root is open, so no path may be used')
  if (path.includes('..')) {
    throw new Error(`file '${path}' escapes the project root ${root}`)
  }
  if (!isWithinRoot(root, path)) {
    throw new Error(`file '${path}' is outside the open project root ${root}`)
  }
}

export function createFakeDisk(initial: Record<string, string> = {}): FakeDisk {
  const files = new Map<string, string>()
  for (const [path, content] of Object.entries(initial)) files.set(canonicalPath(path), content)

  const disk: FakeDisk = {
    files,
    reads: [],
    writes: [],
    pickResult: null,
    pickError: null,
    pickCalls: 0,
    writeError: null,
    set(path, content) {
      files.set(canonicalPath(path), content)
    },
    read(path) {
      return files.get(canonicalPath(path))
    },
    io: {
      async readFile(root, path) {
        disk.reads.push({ root, path })
        refuseOutside(root, path)
        const content = files.get(canonicalPath(path))
        if (content === undefined) {
          throw new Error(`failed to read ${path}: The system cannot find the file (os error 2)`)
        }
        return content
      },
      async readDir(root, path) {
        refuseOutside(root, path)
        // Derived from the same Map the reads come from, so this double cannot
        // claim a file exists that a read would then fail to find. Mirrors the
        // backend's ordering (folders first, then case-insensitive by name) and its
        // skip list, because the panel is written against that shape.
        const prefix = canonicalPath(path).replace(/\/$/, '') + '/'
        const seen = new Map<string, boolean>()
        for (const filePath of files.keys()) {
          if (!filePath.startsWith(prefix)) continue
          const rest = filePath.slice(prefix.length)
          const slash = rest.indexOf('/')
          const name = slash === -1 ? rest : rest.slice(0, slash)
          if (name === '') continue
          if (name.startsWith('.') || name === 'node_modules' || name === 'target' || name === 'dist') {
            continue
          }
          seen.set(name, slash !== -1 || (seen.get(name) ?? false))
        }
        return [...seen.entries()]
          .map(([name, isDir]) => ({ name, path: `${prefix}${name}`, isDir }))
          .sort((a, b) =>
            a.isDir === b.isDir
              ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
              : a.isDir
                ? -1
                : 1,
          )
      },
      async writeFile(root, path, content) {
        refuseOutside(root, path)
        if (disk.writeError) throw disk.writeError
        disk.writes.push({ root, path, content })
        files.set(canonicalPath(path), content)
      },
      async pickFolder() {
        disk.pickCalls += 1
        if (disk.pickError) throw disk.pickError
        return disk.pickResult
      },
    },
  }

  return disk
}
