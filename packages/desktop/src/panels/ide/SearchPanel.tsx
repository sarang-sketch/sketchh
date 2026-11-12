// Find in Files and Replace in Files, the way every editor has them.
//
// ── ONE MATCHER, AND IT IS THE ENGINE'S ─────────────────────────────────────
//
// The panel matches nothing itself. It calls `find-in-files` (packages/core
// tools/findReplace.ts), and every highlight, every replacement preview and every edit
// Replace makes comes from that one matcher — so what is highlighted is exactly what is
// replaced. The engine searches EXACTLY what was typed (or a regular expression), with
// Match Case / Whole Word / Regex toggles and "files to include / exclude" boxes.
//
// (`project-search`, which reduces a query to terms for the agent's retrieval, still
// exists for the agent. It is the wrong tool for a person typing `user.id ===`.)
//
// ── REPLACING IS SAFE BY CONSTRUCTION ───────────────────────────────────────
//
//   * Replace All says how many matches in how many files before it writes anything.
//   * Files with unsaved edits in the editor are saved first (after asking), so the
//     replacement and the person's typing are never in conflict.
//   * The engine writes through its contained, snapshotting writer; the result line
//     offers Undo, which restores every file the replace changed (unless it was edited
//     again since — that file is left alone and named).
//   * Open tabs reload what was written (editor/diskSync.ts).
//
// Results are derived state: AppState owns only the query, and each request carries a
// request id so an older completion can never replace a newer query's results.
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.4, 27.5

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ChevronDown, ChevronRight, CollapseAll, FileCode, MoreHorizontal, Search, Undo, X } from '../../components/Icons'
import { useConfirm } from '../../components/ConfirmDialog'
import { announceDiskChanged } from '../../editor/diskSync'
import { isWithinRoot, relativeToRoot, toAbsolutePath } from '../../editor/paths'
import { useFileActions } from '../../editor/useFileActions'
import { useSketchClient } from '../../lib/ClientProvider'
import type { FindInFilesHit, FindInFilesResult, ReplaceInFilesParams, ReplaceInFilesResult } from '../../lib/client'
import { isComposing } from '../../lib/keys'
import { useAppDispatch, useAppState } from '../../state/AppState'
import styles from './SearchPanel.module.css'

export const SEARCH_DEBOUNCE_MS = 250

/** One request id for this panel: a newer search stops the engine working on an older one. */
const REQUEST_ID = 'search-panel'

interface SearchOptions {
  matchCase: boolean
  wholeWord: boolean
  isRegex: boolean
}

const DEFAULT_OPTIONS: SearchOptions = { matchCase: false, wholeWord: false, isRegex: false }

type SearchView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failure'; message: string }
  /** `refreshing`: a newer search is running; these results stay on screen until it answers. */
  | { kind: 'result'; result: FindInFilesResult; refreshing?: boolean }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** `src/lib/util.ts` → name `util.ts`, folder `src/lib`. */
function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at === -1 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

/** One result line, with the engine's spans highlighted and, when replacing, previewed. */
function HitText({ hit, previewing }: { hit: FindInFilesHit; previewing: boolean }) {
  const parts: Array<{ text: string; match: boolean; replacement?: string }> = []
  let at = 0
  for (const span of hit.spans) {
    if (span.start > at) parts.push({ text: hit.text.slice(at, span.start), match: false })
    parts.push({
      text: hit.text.slice(span.start, span.start + span.length),
      match: true,
      ...(span.replacement !== undefined ? { replacement: span.replacement } : {}),
    })
    at = span.start + span.length
  }
  if (at < hit.text.length) parts.push({ text: hit.text.slice(at), match: false })
  return (
    <span className={styles.matchContent}>
      {hit.textStart > 0 && <span className={styles.clipped}>…</span>}
      {parts.map((part, index) =>
        !part.match ? (
          <span key={index}>{part.text}</span>
        ) : previewing && part.replacement !== undefined ? (
          <span key={index}>
            <del className={styles.removed}>{part.text}</del>
            {part.replacement !== '' && <ins className={styles.inserted}>{part.replacement}</ins>}
          </span>
        ) : (
          <span key={index} className={styles.highlight}>
            {part.text}
          </span>
        ),
      )}
    </span>
  )
}

export default function SearchPanel() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const client = useSketchClient()
  const fileActions = useFileActions()
  const confirm = useConfirm()

  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [view, setView] = useState<SearchView>({ kind: 'idle' })
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [replacing, setReplacing] = useState(false)
  const [lastReplace, setLastReplace] = useState<{ result: ReplaceInFilesResult; undone: boolean } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  /** Bumped to search again now: Enter, after a replace, after an undo. */
  const [nonce, setNonce] = useState(0)
  const immediate = useRef(false)
  const latestRequest = useRef(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const replaceRef = useRef<HTMLInputElement | null>(null)

  // Ctrl+Shift+F lands the caret in the search box; Ctrl+Shift+H opens Replace.
  useEffect(() => {
    const focusSearch = () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    const focusReplace = () => {
      setReplaceOpen(true)
      requestAnimationFrame(() => {
        if (inputRef.current?.value === '') inputRef.current.focus()
        else replaceRef.current?.focus()
      })
    }
    window.addEventListener('sketch:focus-search', focusSearch)
    window.addEventListener('sketch:focus-replace', focusReplace)
    return () => {
      window.removeEventListener('sketch:focus-search', focusSearch)
      window.removeEventListener('sketch:focus-replace', focusReplace)
    }
  }, [])

  const find = client.findInFiles
  const root = state.projectRoot
  const query = state.searchQuery
  const previewing = replaceOpen

  useEffect(() => {
    const requestId = ++latestRequest.current
    if (root === null || query === '') {
      setView({ kind: 'idle' })
      return
    }
    if (find === undefined) {
      setView({
        kind: 'failure',
        message: `the ${client.transport} transport has no engine behind it, so there is nothing to search with`,
      })
      return
    }
    // Typing in the Replace box, toggling an option: the list stays while the new answer
    // is computed, instead of flashing "Searching…" on every keystroke.
    setView((current) => (current.kind === 'result' ? { ...current, refreshing: true } : { kind: 'loading' }))
    const delay = immediate.current ? 0 : SEARCH_DEBOUNCE_MS
    immediate.current = false
    const timer = window.setTimeout(() => {
      void find
        .call(client, {
          root,
          query,
          requestId: REQUEST_ID,
          ...(options.matchCase ? { matchCase: true } : {}),
          ...(options.wholeWord ? { wholeWord: true } : {}),
          ...(options.isRegex ? { isRegex: true } : {}),
          ...(include.trim() !== '' ? { include } : {}),
          ...(exclude.trim() !== '' ? { exclude } : {}),
          ...(previewing ? { replacement } : {}),
        })
        .then((result) => {
          // A stale answer is dropped: the query it belongs to is not the one on screen.
          if (requestId !== latestRequest.current) return
          setView({ kind: 'result', result })
          setDismissed(new Set())
        })
        .catch((err: unknown) => {
          if (requestId !== latestRequest.current) return
          setView({ kind: 'failure', message: messageOf(err) })
        })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [client, exclude, find, include, nonce, options, previewing, query, replacement, root])

  const toggle = (key: keyof SearchOptions) => setOptions((current) => ({ ...current, [key]: !current[key] }))

  const result = view.kind === 'result' ? view.result : null
  const groups = useMemo(
    () => (result === null ? [] : result.groups.filter((group) => !dismissed.has(group.path))),
    [dismissed, result],
  )
  const shownMatches = groups.reduce((sum, group) => sum + group.matches, 0)

  const open = (relativePath: string, line?: number, column?: number) => {
    if (root === null) return
    const absolute = toAbsolutePath(root, relativePath)
    // Advisory: the engine already refused anything outside the project, and the
    // backend refuses again when the file is read.
    if (!isWithinRoot(root, absolute)) return
    void fileActions.openPath(absolute).then(() => {
      if (line !== undefined) dispatch({ type: 'REVEAL_IN_EDITOR', payload: { path: absolute, line, column: column ?? 1 } })
    })
  }

  /** Open tabs with unsaved edits among `paths` (project-relative). */
  const unsavedAmong = useCallback(
    (paths: string[]) => {
      if (root === null) return []
      const wanted = new Set(paths.map((p) => p.toLowerCase()))
      return state.openFiles.filter(
        (abs) => state.files[abs]?.isDirty === true && wanted.has(relativeToRoot(root, abs).toLowerCase()),
      )
    },
    [root, state.files, state.openFiles],
  )

  const runReplace = async (
    scope: { paths: string[]; only?: ReplaceInFilesParams['only'] },
    ask: { count: number; files: number } | null,
  ) => {
    if (root === null || client.replaceInFiles === undefined) {
      setNotice({ tone: 'error', text: 'Replacing needs the Sketch engine, and this window is not connected to it.' })
      return
    }
    const unsaved = unsavedAmong(scope.paths)
    if (ask !== null || unsaved.length > 0) {
      const what = replacement === '' ? 'with nothing (delete them)' : `with “${replacement}”`
      const choice = await confirm({
        title:
          ask !== null
            ? `Replace ${plural(ask.count, 'match', 'matches')} in ${plural(ask.files, 'file')}?`
            : 'Save before replacing?',
        message: ask !== null ? `“${query}” ${what}. You can undo this afterwards.` : undefined,
        ...(unsaved.length > 0
          ? { detail: `${plural(unsaved.length, 'file')} with matches ${unsaved.length === 1 ? 'has' : 'have'} unsaved changes; ${unsaved.length === 1 ? 'it is' : 'they are'} saved first.` }
          : {}),
        buttons: [
          { id: 'replace', label: unsaved.length > 0 ? 'Save and Replace' : 'Replace', kind: 'danger' },
          { id: 'cancel', label: 'Cancel' },
        ],
        cancelId: 'cancel',
      })
      if (choice !== 'replace') return
      for (const path of unsaved) {
        if (!(await fileActions.save(path))) {
          setNotice({ tone: 'error', text: 'A file could not be saved, so nothing was replaced.' })
          return
        }
      }
    }
    setReplacing(true)
    setNotice(null)
    try {
      const done = await client.replaceInFiles({
        root,
        query,
        replacement,
        ...(options.matchCase ? { matchCase: true } : {}),
        ...(options.wholeWord ? { wholeWord: true } : {}),
        ...(options.isRegex ? { isRegex: true } : {}),
        ...(include.trim() !== '' ? { include } : {}),
        ...(exclude.trim() !== '' ? { exclude } : {}),
        paths: scope.paths,
        ...(scope.only !== undefined ? { only: scope.only } : {}),
      })
      if (done.replaced > 0) {
        setLastReplace({ result: done, undone: false })
        announceDiskChanged('replace')
      }
      if (done.skipped.length > 0) {
        setNotice({
          tone: done.replaced > 0 ? 'info' : 'error',
          text: done.skipped.map((s) => `${s.path}: ${s.reason}`).join(' · '),
        })
      }
      immediate.current = true
      setNonce((n) => n + 1)
    } catch (err) {
      setNotice({ tone: 'error', text: `Replace failed: ${messageOf(err)}` })
    } finally {
      setReplacing(false)
    }
  }

  const undoReplace = async () => {
    const snapshotId = lastReplace?.result.snapshotId
    if (root === null || snapshotId == null || client.undoRun === undefined) return
    try {
      const undone = await client.undoRun({ root, runId: snapshotId })
      announceDiskChanged('replace')
      setLastReplace((current) => (current === null ? null : { ...current, undone: true }))
      setNotice(
        undone.skipped.length > 0
          ? {
              tone: 'error',
              text: `Restored ${plural(undone.restored.length, 'file')}. Left alone because they changed since: ${undone.skipped.map((s) => s.path).join(', ')}.`,
            }
          : { tone: 'info', text: `Restored ${plural(undone.restored.length, 'file')}.` },
      )
      immediate.current = true
      setNonce((n) => n + 1)
    } catch (err) {
      setNotice({ tone: 'error', text: `Undo failed: ${messageOf(err)}` })
    }
  }

  const refreshing = view.kind === 'result' && view.refreshing === true
  // Never replace from a list that a newer search is about to change.
  const canReplace =
    previewing && result !== null && groups.length > 0 && !replacing && !refreshing && client.replaceInFiles !== undefined

  return (
    <div className={styles.searchPanel}>
      <div className={styles.inputGroup}>
        <div className={styles.searchRow}>
          <button
            type="button"
            className={styles.replaceToggle}
            aria-label="Toggle Replace"
            aria-expanded={replaceOpen}
            title="Toggle Replace (Ctrl+Shift+H)"
            onClick={() => setReplaceOpen((v) => !v)}
          >
            {replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <div className={styles.fields}>
            <div className={styles.searchBox}>
              <Search className={styles.searchIcon} size={14} />
              <input
                ref={inputRef}
                className={styles.searchInput}
                value={query}
                onChange={(event) => dispatch({ type: 'SET_SEARCH_QUERY', payload: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || isComposing(event)) return
                  event.preventDefault()
                  immediate.current = true
                  setNonce((n) => n + 1)
                }}
                placeholder="Search"
                aria-label="Search project files"
                spellCheck={false}
              />
              <div className={styles.optionsRow}>
                <button
                  type="button"
                  className={`${styles.optionBtn} ${options.matchCase ? styles.active : ''}`}
                  title="Match Case"
                  aria-label="Match Case"
                  aria-pressed={options.matchCase}
                  onClick={() => toggle('matchCase')}
                >
                  Aa
                </button>
                <button
                  type="button"
                  className={`${styles.optionBtn} ${options.wholeWord ? styles.active : ''}`}
                  title="Match Whole Word"
                  aria-label="Match Whole Word"
                  aria-pressed={options.wholeWord}
                  onClick={() => toggle('wholeWord')}
                >
                  <u>ab</u>
                </button>
                <button
                  type="button"
                  className={`${styles.optionBtn} ${options.isRegex ? styles.active : ''}`}
                  title="Use Regular Expression"
                  aria-label="Use Regular Expression"
                  aria-pressed={options.isRegex}
                  onClick={() => toggle('isRegex')}
                >
                  .*
                </button>
              </div>
            </div>
            {replaceOpen && (
              <div className={styles.searchBox}>
                <input
                  ref={replaceRef}
                  className={styles.searchInput}
                  value={replacement}
                  onChange={(event) => setReplacement(event.target.value)}
                  placeholder={options.isRegex ? 'Replace ($1, $<name>, \\n)' : 'Replace'}
                  aria-label="Replace with"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={styles.optionBtn}
                  title="Replace All"
                  aria-label="Replace All"
                  disabled={!canReplace}
                  onClick={() =>
                    void runReplace(
                      { paths: groups.map((g) => g.path) },
                      { count: shownMatches, files: groups.length },
                    )
                  }
                >
                  All
                </button>
              </div>
            )}
          </div>
        </div>
        <div className={styles.filterRow}>
          <button
            type="button"
            className={styles.moreBtn}
            aria-label="Toggle Search Details"
            aria-expanded={filtersOpen}
            title="Files to include / exclude"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
        {filtersOpen && (
          <div className={styles.filters}>
            <label className={styles.filterLabel}>
              files to include
              <input
                className={styles.filterInput}
                value={include}
                onChange={(event) => setInclude(event.target.value)}
                placeholder="e.g. src, *.ts"
                aria-label="Files to include"
                spellCheck={false}
              />
            </label>
            <label className={styles.filterLabel}>
              files to exclude
              <input
                className={styles.filterInput}
                value={exclude}
                onChange={(event) => setExclude(event.target.value)}
                placeholder="e.g. *.test.ts, docs/"
                aria-label="Files to exclude"
                spellCheck={false}
              />
            </label>
          </div>
        )}
      </div>

      {lastReplace !== null && (
        <div className={styles.replaceDone} role="status">
          <span>
            {lastReplace.undone
              ? `Undid the replacement of ${plural(lastReplace.result.replaced, 'match', 'matches')}.`
              : `Replaced ${plural(lastReplace.result.replaced, 'match', 'matches')} in ${plural(lastReplace.result.files.length, 'file')}.`}
          </span>
          {!lastReplace.undone && lastReplace.result.snapshotId !== null && client.undoRun !== undefined && (
            <button type="button" className={styles.linkBtn} onClick={() => void undoReplace()}>
              <Undo size={12} /> Undo
            </button>
          )}
          <button type="button" className={styles.iconBtn} aria-label="Dismiss" onClick={() => setLastReplace(null)}>
            <X size={12} />
          </button>
        </div>
      )}
      {notice !== null && (
        <div className={`${styles.detail} ${notice.tone === 'error' ? styles.error : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </div>
      )}

      {root === null ? (
        <div className={styles.state}>No folder open. Open a project to search its files.</div>
      ) : query === '' ? (
        <div className={styles.state}>
          Type to search. <span className={styles.hint}>Enter searches now · Ctrl+Shift+H replaces</span>
        </div>
      ) : view.kind === 'loading' ? (
        <div className={styles.state}>Searching…</div>
      ) : view.kind === 'failure' ? (
        <div className={`${styles.state} ${styles.error}`} role="alert">
          Search failed: {view.message}
        </div>
      ) : result !== null && result.matchCount === 0 ? (
        <div className={styles.state}>
          No results for “{query}” in {plural(result.filesSearched, 'file')}
          {include.trim() !== '' || exclude.trim() !== '' ? ' (with the include/exclude filters)' : ''}.
        </div>
      ) : result !== null ? (
        <>
          <div className={styles.summaryRow}>
            <span className={styles.summary}>
              {plural(shownMatches, 'result')} in {plural(groups.length, 'file')}
              {result.truncated && ' — a cap stopped the search, so there may be more. Narrow it to see the rest.'}
              {refreshing && <span className={styles.refreshing}> · searching…</span>}
            </span>
            <button
              type="button"
              className={styles.iconBtn}
              title={collapsed.size > 0 ? 'Expand All' : 'Collapse All'}
              aria-label={collapsed.size > 0 ? 'Expand All' : 'Collapse All'}
              onClick={() => setCollapsed(collapsed.size > 0 ? new Set() : new Set(groups.map((g) => g.path)))}
            >
              <CollapseAll size={14} />
            </button>
          </div>
          {(result.skipped.binary > 0 || result.skipped.tooLarge > 0) && (
            <div className={styles.detail}>
              Not searched: {[
                result.skipped.binary > 0 ? plural(result.skipped.binary, 'binary file') : null,
                result.skipped.tooLarge > 0 ? `${plural(result.skipped.tooLarge, 'file')} over 1 MB` : null,
              ]
                .filter(Boolean)
                .join(', ')}
              .
            </div>
          )}
          <div className={styles.resultsList} role="tree" aria-label="Search results">
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.path)
              const { name, dir } = splitPath(group.path)
              return (
                <div key={group.path} className={styles.fileGroup} role="treeitem" aria-expanded={!isCollapsed}>
                  <div className={styles.fileHeaderRow}>
                    <button
                      type="button"
                      className={styles.fileHeader}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current)
                          if (next.has(group.path)) next.delete(group.path)
                          else next.add(group.path)
                          return next
                        })
                      }
                      title={group.path}
                    >
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      <FileCode size={14} />
                      <span className={styles.fileName}>{name}</span>
                      {dir !== '' && <span className={styles.fileDir}>{dir}</span>}
                      <span className={styles.badge}>{group.matches}</span>
                    </button>
                    <span className={styles.rowActions}>
                      {previewing && (
                        <button
                          type="button"
                          className={styles.iconBtn}
                          aria-label={`Replace all in ${group.path}`}
                          title="Replace All in this file"
                          disabled={!canReplace}
                          onClick={() => void runReplace({ paths: [group.path] }, null)}
                        >
                          All
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.iconBtn}
                        aria-label={`Dismiss ${group.path}`}
                        title="Dismiss"
                        onClick={() => setDismissed((current) => new Set(current).add(group.path))}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  </div>
                  {!isCollapsed &&
                    group.hits.map((hit) => (
                      <div key={hit.line} className={styles.matchRow}>
                        <button
                          type="button"
                          className={styles.matchLine}
                          onClick={() => open(group.path, hit.line, hit.textStart + (hit.spans[0]?.start ?? 0) + 1)}
                          title={`${group.path}:${hit.line}`}
                        >
                          <span className={styles.lineNumber}>{hit.line}</span>
                          <HitText hit={hit} previewing={previewing} />
                        </button>
                        {previewing && (
                          <button
                            type="button"
                            className={`${styles.iconBtn} ${styles.lineAction}`}
                            aria-label={`Replace in ${group.path} line ${hit.line}`}
                            title="Replace"
                            disabled={!canReplace}
                            onClick={() =>
                              void runReplace(
                                { paths: [group.path], only: { path: group.path, line: hit.line, text: hit.text, textStart: hit.textStart } },
                                null,
                              )
                            }
                          >
                            ↵
                          </button>
                        )}
                      </div>
                    ))}
                </div>
              )
            })}
          </div>
        </>
      ) : null}
    </div>
  )
}
