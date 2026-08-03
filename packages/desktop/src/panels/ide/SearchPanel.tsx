// Real project search over the client seam.
//
// ── THERE IS NO SEARCH IMPLEMENTATION IN THIS PACKAGE ───────────────────────
//
// This panel had one: `git grep` through the Tauri command policy, a `read_dir` /
// `read_file` folder walk behind it, and a matcher built on JavaScript regular
// expressions. The engine had its own lexical channel for retrieval. Two engines,
// two match dialects — so the same query over the same file could highlight one
// thing here and score another in retrieval. Both files are deleted; the panel now
// calls `client.projectSearch`, which is the engine's ONE lexical channel
// (packages/core/src/context/hybrid-search.ts), reached the same way GitPanel
// reaches `tools/git.ts`.
//
// Two things follow from that, and both are visible in the UI:
//
//   * THE DIALECT IS THE ENGINE'S. Matching is literal, per term, with the engine's
//     smart case; there is no regex mode, because a second dialect is the defect
//     this closed. The terms actually searched for are shown when they differ from
//     what was typed, so a query that was reduced can be understood rather than
//     read as "no matches".
//   * THE ENGINE IS NAMED. `ripgrep` or `scanner`, never silently swapped, and a
//     truncated result says a cap stopped the search instead of looking like an
//     empty one (Requirement 27.5).
//
// Results are derived state: AppState owns only the controlled query, while each
// request carries a request id so an older completion cannot replace a newer query.
// Output is always rendered as React text children.
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.4, 27.5

import { useEffect, useRef, useState } from 'react'

import { FileCode, Search } from '../../components/Icons'
import { isWithinRoot, toAbsolutePath } from '../../editor/paths'
import { useFileActions } from '../../editor/useFileActions'
import { useSketchClient } from '../../lib/ClientProvider'
import type { ProjectSearchHit, ProjectSearchResult } from '../../lib/contracts'
import { useAppDispatch, useAppState } from '../../state/AppState'
import styles from './SearchPanel.module.css'

export const SEARCH_DEBOUNCE_MS = 250

/** The two toggles the engine's dialect can actually honour. */
interface SearchOptions {
  matchCase: boolean
  wholeWord: boolean
}

const DEFAULT_OPTIONS: SearchOptions = { matchCase: false, wholeWord: false }

type SearchView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failure'; message: string }
  | { kind: 'result'; result: ProjectSearchResult }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The engine that answered, in words. Shown, never merely logged. */
function engineName(result: ProjectSearchResult): string {
  return result.engine === 'ripgrep' ? 'ripgrep' : 'the built-in scanner'
}

/**
 * One result line, with the engine's own match offsets highlighted.
 *
 * The spans come from the search result. Nothing here re-finds the query in the
 * text, which is exactly how the two implementations used to disagree.
 */
function HitText({ hit }: { hit: ProjectSearchHit }) {
  const parts: Array<{ text: string; match: boolean }> = []
  let at = 0
  for (const span of hit.spans) {
    if (span.start > at) parts.push({ text: hit.text.slice(at, span.start), match: false })
    parts.push({ text: hit.text.slice(span.start, span.start + span.length), match: true })
    at = span.start + span.length
  }
  if (at < hit.text.length) parts.push({ text: hit.text.slice(at), match: false })

  return (
    <span className={styles.matchContent}>
      {parts.map((part, index) =>
        part.match ? (
          <span key={index} className={styles.highlight}>
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
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
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS)
  const [view, setView] = useState<SearchView>({ kind: 'idle' })
  const latestRequest = useRef(0)

  const search = client.projectSearch

  useEffect(() => {
    const requestId = ++latestRequest.current
    const root = state.projectRoot
    const query = state.searchQuery

    if (root === null || query.trim() === '') {
      setView({ kind: 'idle' })
      return
    }
    if (search === undefined) {
      setView({
        kind: 'failure',
        message: `the ${client.transport} transport has no engine behind it, so there is nothing to search with`,
      })
      return
    }

    setView({ kind: 'loading' })
    const timer = window.setTimeout(() => {
      void search
        .call(client, {
          root,
          query,
          ...(options.matchCase ? { matchCase: true } : {}),
          ...(options.wholeWord ? { wholeWord: true } : {}),
        })
        .then((result) => {
          // A stale answer is dropped rather than rendered: the query it belongs to
          // is not the one on screen.
          if (requestId !== latestRequest.current) return
          setView({ kind: 'result', result })
        })
        .catch((err: unknown) => {
          if (requestId !== latestRequest.current) return
          setView({ kind: 'failure', message: messageOf(err) })
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [client, options, search, state.projectRoot, state.searchQuery])

  const toggle = (key: keyof SearchOptions) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }))
  }

  const result = view.kind === 'result' ? view.result : null
  const root = state.projectRoot
  /** True when the engine reduced the query to something else worth naming. */
  const reduced =
    result !== null &&
    (result.terms.length !== 1 || result.terms[0] !== result.query.trim())

  const open = (relativePath: string) => {
    if (root === null) return
    const absolute = toAbsolutePath(root, relativePath)
    // Advisory: the engine already refused anything outside the project, and the
    // backend refuses again when the file is read. Belt, braces, and a third check
    // in Rust.
    if (!isWithinRoot(root, absolute)) return
    void fileActions.openPath(absolute)
  }

  return (
    <div className={styles.searchPanel}>
      <div className={styles.inputGroup}>
        <div className={styles.searchBox}>
          <Search className={styles.searchIcon} size={14} />
          <input
            className={styles.searchInput}
            value={state.searchQuery}
            onChange={(event) =>
              dispatch({ type: 'SET_SEARCH_QUERY', payload: event.target.value })
            }
            placeholder="Search"
            aria-label="Search project files"
          />
        </div>
        <div className={styles.optionsRow}>
          <button
            className={`${styles.optionBtn} ${options.matchCase ? styles.active : ''}`}
            title="Match Case"
            aria-pressed={options.matchCase}
            onClick={() => toggle('matchCase')}
          >
            Aa
          </button>
          <button
            className={`${styles.optionBtn} ${options.wholeWord ? styles.active : ''}`}
            title="Match Whole Word"
            aria-pressed={options.wholeWord}
            onClick={() => toggle('wholeWord')}
          >
            Ab|
          </button>
        </div>
      </div>

      {root === null ? (
        <div className={styles.state}>No folder open. Open a project to search its files.</div>
      ) : state.searchQuery.trim() === '' ? (
        <div className={styles.state}>Type something to search for.</div>
      ) : view.kind === 'loading' ? (
        <div className={styles.state}>Searching…</div>
      ) : view.kind === 'failure' ? (
        <div className={`${styles.state} ${styles.error}`} role="alert">
          Search failed: {view.message}
        </div>
      ) : result !== null && result.hitCount === 0 ? (
        <>
          <div className={styles.state}>
            No matches for “{state.searchQuery}” in {result.fileCount}{' '}
            {result.fileCount === 1 ? 'file' : 'files'} via {engineName(result)}.
          </div>
          {reduced && (
            <div className={styles.detail}>Searched for: {result.terms.join(', ')}.</div>
          )}
        </>
      ) : result !== null ? (
        <>
          <div className={styles.summary}>
            {result.hitCount} {result.hitCount === 1 ? 'match' : 'matches'} in{' '}
            {result.groups.length} {result.groups.length === 1 ? 'file' : 'files'} via{' '}
            {engineName(result)}.
            {result.truncated &&
              ` A cap stopped the search: showing the first ${result.hitCount} matches, so there may be more.`}
          </div>
          {reduced && (
            <div className={styles.detail}>Searched for: {result.terms.join(', ')}.</div>
          )}
          {result.degraded && result.reason !== null && (
            <div className={styles.detail}>ripgrep did not run: {result.reason}.</div>
          )}
          {result.refused > 0 && (
            <div className={styles.detail}>
              {result.refused} {result.refused === 1 ? 'path was' : 'paths were'} refused for
              being outside the project.
            </div>
          )}
          <div className={styles.resultsList}>
            {result.groups.map((group) => (
              <div key={group.path} className={styles.fileGroup}>
                <button
                  className={styles.fileHeader}
                  onClick={() => open(group.path)}
                  title={`Open ${group.path}`}
                >
                  <FileCode size={14} />
                  <span>{group.path}</span>
                  <span className={styles.badge}>{group.hits.length}</span>
                </button>
                {group.hits.map((hit) => (
                  <button
                    key={hit.line}
                    className={styles.matchLine}
                    onClick={() => open(group.path)}
                    title={`Open ${group.path} at line ${hit.line}`}
                  >
                    <span className={styles.lineNumber}>{hit.line}</span>
                    <HitText hit={hit} />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
