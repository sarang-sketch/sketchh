// The diff view: what changed in one file, side by side (or inline), in the editor area.
//
// It makes the same three comparisons git itself makes, so what it shows always agrees
// with the Source Control list it was opened from:
//
//   changes   index ↔ working tree   `git diff`           the right side is the live tab
//   staged    HEAD  ↔ index          `git diff --staged`  both sides read-only snapshots
//   deleted   index ↔ nothing        a file removed from the disk; nothing left to edit
//
// The right side of "changes" is the open tab's OWN model, borrowed through the editor
// bridge, so typing there is editing the file: the tab goes dirty, Ctrl+S saves it, and
// the arrows Monaco draws beside each change put that change back. Snapshots live in
// in-memory models that no file can collide with; they are this component's alone, and
// it re-reads them whenever git's state may have moved (a stage, a commit, a branch
// switch, a terminal command). Nothing here writes to git or to the disk.

import { useEffect, useRef, useState } from 'react'

import styles from './DiffView.module.css'
import { ArrowDown, ArrowUp, Columns, FileCode, FoldVertical, X } from '../components/Icons'
import { useOptionalSketchClient } from '../lib/ClientProvider'
import { useOptionalGit } from '../git/GitProvider'
import type { GitStatusResult } from '../lib/contracts'
import { useAppState } from '../state/AppState'
import { whenEditorBridge } from './editorBridge'
import { useDiskChangeSignal } from './diskSync'
import { loadMonaco, type LoadedMonaco } from './monacoSetup'
import type { DiffEditor, Disposable, TextModel } from './monacoApi'
import { optionsFor } from './CodeEditor'
import { basename, canonicalPath, languageForPath, relativeToRoot, toAbsolutePath } from './paths'

export type DiffKind = 'changes' | 'staged' | 'deleted'

export interface DiffRequest {
  /** Absolute path of the file. */
  path: string
  kind: DiffKind
}

/** Source Control, the palette and the editor ask for a diff with this event. */
export const OPEN_DIFF_EVENT = 'sketch:open-diff'

export function requestDiff(request: DiffRequest): void {
  window.dispatchEvent(new CustomEvent<DiffRequest>(OPEN_DIFF_EVENT, { detail: request }))
}

/**
 * Which comparison a file's own "Open Changes" means: its unstaged edits when it has
 * any (or is new), else its staged ones. Null when git reports nothing for it.
 */
export function diffKindFor(status: GitStatusResult | null, root: string | null, path: string): DiffKind | null {
  if (status === null || root === null || !status.isRepo) return null
  const key = canonicalPath(path)
  const matches = (change: { path: string }) => canonicalPath(toAbsolutePath(root, change.path)) === key
  const unstaged = status.unstaged.find(matches)
  if (unstaged !== undefined) return unstaged.worktree.trim() === 'D' ? 'deleted' : 'changes'
  if (status.untracked.some(matches)) return 'changes'
  if (status.staged.some(matches)) return 'staged'
  return null
}

/** What each side is, in words, for the header. */
const SIDES: Record<DiffKind, { left: string; right: string }> = {
  changes: { left: 'Staged or committed', right: 'Working tree' },
  staged: { left: 'Last commit (HEAD)', right: 'Staged' },
  deleted: { left: 'Staged or committed', right: 'Deleted' },
}

const SIDE_BY_SIDE_KEY = 'sketch.diff.sideBySide'
const HIDE_UNCHANGED_KEY = 'sketch.diff.hideUnchanged'
/** Two columns of about 320 px each are the narrowest that still read. */
export const SIDE_BY_SIDE_MIN_WIDTH = 640

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key)
    return value === null ? fallback : value === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // A full or blocked storage only loses the preference.
  }
}

export interface DiffViewProps {
  request: DiffRequest
  /** The project folder, which git reads relative to. */
  root: string
  onClose(): void
  /** Show the file itself (closes the diff). Absent when there is no file to show. */
  onOpenFile?: () => void
  /** Injected in tests. Production uses the real, lazily loaded Monaco. */
  loader?: () => Promise<LoadedMonaco>
}

interface Sides {
  left: string
  right: string
  /** The left side does not exist (a new file): everything on the right is added. */
  leftMissing: boolean
}

export function DiffView({ request, root, onClose, onOpenFile, loader = loadMonaco }: DiffViewProps) {
  const client = useOptionalSketchClient()
  const git = useOptionalGit()
  const settings = useAppState().editorSettings
  const hostRef = useRef<HTMLDivElement | null>(null)
  const diffRef = useRef<DiffEditor | null>(null)
  /** The left side on screen: always a snapshot this view made. */
  const originalRef = useRef<TextModel | null>(null)
  /** The right side on screen: the live tab (changes) or a snapshot (staged, deleted). */
  const modifiedRef = useRef<TextModel | null>(null)
  /** The tab's own model when the right side is the live file; null for a snapshot. */
  const liveRef = useRef<TextModel | null>(null)
  /** Makes a snapshot model this view owns; set once Monaco is loaded. */
  const makeRef = useRef<((value: string) => TextModel) | null>(null)
  const ownedRef = useRef<Set<TextModel>>(new Set())
  const [ready, setReady] = useState(false)
  /** Monaco could not show a diff here (no diff editor, the file is not open). */
  const [viewError, setViewError] = useState<string | null>(null)
  /** Git could not be read. Cleared by the next successful read. */
  const [gitError, setGitError] = useState<string | null>(null)
  const [sides, setSides] = useState<Sides | null>(null)
  const sidesRef = useRef<Sides | null>(null)
  sidesRef.current = sides
  const [changeCount, setChangeCount] = useState<number | null>(null)
  const [sideBySide, setSideBySide] = useState(() => readFlag(SIDE_BY_SIDE_KEY, true))
  const [hideUnchanged, setHideUnchanged] = useState(() => readFlag(HIDE_UNCHANGED_KEY, false))
  const [epoch, setEpoch] = useState(0)
  /** What a newly created diff editor starts with: the toggles and settings as they are now. */
  const current = useRef({ sideBySide, hideUnchanged, settings })
  current.current = { sideBySide, hideUnchanged, settings }

  // A terminal command or another program may have staged, committed or switched.
  useDiskChangeSignal((change) => {
    if (change.git || change.paths === null) setEpoch((n) => n + 1)
  })

  // ── The two texts, from git ────────────────────────────────────────────────
  const status = git?.status ?? null
  const gitShow = client?.gitShow
  useEffect(() => {
    if (gitShow === undefined || client === null) {
      setGitError('Comparing needs the engine, which is not connected.')
      return
    }
    let cancelled = false
    const show = (ref: 'HEAD' | 'index') =>
      gitShow.call(client, { root, path: request.path, ref }).then((result) => result.content)
    const left = show(request.kind === 'staged' ? 'HEAD' : 'index')
    const right = request.kind === 'staged' ? show('index') : Promise.resolve(null)
    Promise.all([left, right]).then(
      ([before, after]) => {
        if (cancelled) return
        setGitError(null)
        setSides({ left: before ?? '', right: after ?? '', leftMissing: before === null })
      },
      (err: unknown) => {
        if (!cancelled) setGitError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      cancelled = true
    }
    // `status` is in the list on purpose: a stage, a commit or a switch changes it,
    // and each may change what the index or HEAD holds for this file.
  }, [client, gitShow, root, request.path, request.kind, status, epoch])

  // ── Monaco's diff editor, once per file and comparison ─────────────────────
  useEffect(() => {
    let cancelled = false
    const subscriptions: Disposable[] = []
    let diff: DiffEditor | null = null
    let stopWaiting: () => void = () => {}
    let slowTimer: ReturnType<typeof setTimeout> | null = null
    setReady(false)
    setViewError(null)
    setChangeCount(null)

    loader()
      .then(({ api, theme }) => {
        const host = hostRef.current
        if (cancelled || host === null) return
        const scratch = api.editor.createScratchModel
        const createDiffEditor = api.editor.createDiffEditor
        if (createDiffEditor === undefined || scratch === undefined) {
          setViewError('This editor cannot show a comparison.')
          return
        }
        const language = languageForPath(request.path)
        // Every snapshot this view makes is its own, and is disposed by it.
        const make = (value: string) => {
          const model = scratch(value, language)
          ownedRef.current.add(model)
          return model
        }
        makeRef.current = make

        const build = (live: TextModel | null) => {
          const known = sidesRef.current
          const original = make(known?.left ?? '')
          const modified = live ?? make(known?.right ?? '')
          const start = current.current
          const font = optionsFor(start.settings)
          diff = createDiffEditor(host, {
            theme,
            automaticLayout: true,
            // The live file stays editable on the right; a snapshot of git's does not.
            readOnly: live === null,
            originalEditable: false,
            renderSideBySide: start.sideBySide,
            // Monaco goes inline below 900 px; with the side panel and the chat open the
            // editor is narrower than that on most screens, so side by side would never show.
            useInlineViewWhenSpaceIsLimited: true,
            renderSideBySideInlineBreakpoint: SIDE_BY_SIDE_MIN_WIDTH,
            hideUnchangedRegions: { enabled: start.hideUnchanged },
            fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', monospace",
            ...(font.fontSize !== undefined ? { fontSize: font.fontSize } : {}),
            ...(font.lineHeight !== undefined ? { lineHeight: font.lineHeight } : {}),
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fixedOverflowWidgets: true,
          })
          diff.setModel({ original, modified })
          const editor = diff
          subscriptions.push(editor.onDidUpdateDiff(() => setChangeCount(editor.getLineChanges()?.length ?? 0)))
          diffRef.current = editor
          originalRef.current = original
          modifiedRef.current = modified
          liveRef.current = live
          setReady(true)
        }

        if (request.kind !== 'changes') {
          build(null)
          return
        }
        // The tab was opened just before this view; its editor may still be loading.
        slowTimer = setTimeout(() => {
          if (!cancelled && diff === null) setViewError('The editor is still loading. Close this and try again in a moment.')
        }, 5000)
        stopWaiting = whenEditorBridge((bridge) => {
          if (cancelled) return
          if (slowTimer !== null) clearTimeout(slowTimer)
          const live = bridge.acquireModel?.(request.path) ?? null
          if (live === null) {
            setViewError(`${basename(request.path)} is not open, so there is nothing to compare it with.`)
            return
          }
          build(live)
        })
      })
      .catch((err: unknown) => {
        if (!cancelled) setViewError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      stopWaiting()
      if (slowTimer !== null) clearTimeout(slowTimer)
      for (const subscription of subscriptions) subscription.dispose()
      // Detach before disposing: the right side may be the tab's own model, which
      // must outlive this view. Only the snapshots this view made are disposed.
      const shown = diff as DiffEditor | null
      shown?.setModel(null)
      shown?.dispose()
      for (const model of ownedRef.current) if (!model.isDisposed()) model.dispose()
      ownedRef.current.clear()
      diffRef.current = null
      originalRef.current = null
      modifiedRef.current = null
      liveRef.current = null
      makeRef.current = null
    }
  }, [loader, request.path, request.kind])

  // New text from git: fresh snapshot models swapped in, the old ones disposed. A
  // snapshot is never edited in place — the only text a model is ever written with is
  // a file's, by the model registry — and the live tab on the right is never touched.
  useEffect(() => {
    const diff = diffRef.current
    const make = makeRef.current
    const original = originalRef.current
    const modified = modifiedRef.current
    if (!ready || sides === null || diff === null || make === null || original === null || modified === null) return
    const staleLeft = original.getValue() !== sides.left
    const staleRight = liveRef.current === null && modified.getValue() !== sides.right
    if (!staleLeft && !staleRight) return
    const nextOriginal = staleLeft ? make(sides.left) : original
    const nextModified = staleRight ? make(sides.right) : modified
    diff.setModel({ original: nextOriginal, modified: nextModified })
    originalRef.current = nextOriginal
    modifiedRef.current = nextModified
    for (const old of [staleLeft ? original : null, staleRight ? modified : null]) {
      if (old === null) continue
      ownedRef.current.delete(old)
      if (!old.isDisposed()) old.dispose()
    }
  }, [ready, sides])

  // Toggles and editor settings, applied to the live diff.
  useEffect(() => {
    if (!ready) return
    const font = optionsFor(settings)
    diffRef.current?.updateOptions({
      renderSideBySide: sideBySide,
      hideUnchangedRegions: { enabled: hideUnchanged },
      ...(font.fontSize !== undefined ? { fontSize: font.fontSize } : {}),
      ...(font.lineHeight !== undefined ? { lineHeight: font.lineHeight } : {}),
    })
  }, [ready, sideBySide, hideUnchanged, settings])

  const toggleSideBySide = () => {
    setSideBySide((value) => {
      writeFlag(SIDE_BY_SIDE_KEY, !value)
      return !value
    })
  }
  const toggleHideUnchanged = () => {
    setHideUnchanged((value) => {
      writeFlag(HIDE_UNCHANGED_KEY, !value)
      return !value
    })
  }
  const go = (target: 'next' | 'previous') => {
    const diff = diffRef.current
    if (diff === null) return
    diff.goToDiff(target)
    diff.focusModified()
  }

  const name = basename(request.path)
  const relative = relativeToRoot(root, request.path)
  const labels = SIDES[request.kind]
  const error = viewError ?? gitError
  const summary =
    error !== null
      ? null
      : changeCount === null || sides === null
        ? 'Comparing…'
        : changeCount === 0
          ? 'No changes'
          : `${changeCount} ${changeCount === 1 ? 'change' : 'changes'}`
  const noChanges = changeCount === 0

  return (
    <div
      className={styles.diffView}
      aria-label={`Changes in ${relative}`}
      onKeyDown={(event) => {
        // Alt+F5 / Shift+Alt+F5 move between changes, as they do in the editor.
        if (event.key === 'F5' && event.altKey) {
          event.preventDefault()
          go(event.shiftKey ? 'previous' : 'next')
        }
      }}
    >
      <div className={styles.toolbar}>
        <div className={styles.title} title={relative}>
          <span className={styles.name}>{name}</span>
          <span className={styles.sides}>
            {sides?.leftMissing === true ? 'New file' : labels.left} ↔ {labels.right}
            {request.kind === 'changes' ? ' (editable)' : ''}
          </span>
        </div>
        {summary !== null && (
          <span className={styles.summary} role="status">
            {summary}
          </span>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => go('previous')}
            disabled={!ready || noChanges}
            aria-label="Previous change"
            title="Previous change (Shift+Alt+F5)"
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => go('next')}
            disabled={!ready || noChanges}
            aria-label="Next change"
            title="Next change (Alt+F5)"
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={toggleSideBySide}
            aria-pressed={sideBySide}
            aria-label="Side by side"
            title={sideBySide ? 'Show the changes inline' : 'Show the changes side by side'}
          >
            <Columns size={14} />
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={toggleHideUnchanged}
            aria-pressed={hideUnchanged}
            aria-label="Hide unchanged lines"
            title={hideUnchanged ? 'Show every line' : 'Collapse the lines that did not change'}
          >
            <FoldVertical size={14} />
          </button>
          {onOpenFile !== undefined && (
            <button type="button" className={styles.button} onClick={onOpenFile} aria-label="Open file" title="Open the file">
              <FileCode size={14} />
            </button>
          )}
          <button type="button" className={styles.button} onClick={onClose} aria-label="Close changes" title="Close the comparison">
            <X size={14} />
          </button>
        </div>
      </div>
      {error !== null && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.host} ref={hostRef} data-testid="diff-host" />
    </div>
  )
}

export default DiffView
