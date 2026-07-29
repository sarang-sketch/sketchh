// Real project search over the scoped command and file I/O seams.
// Results are derived state: AppState owns only the controlled query, while each
// request owns a cancellation token and request id so an older completion cannot
// replace a newer query. Output is always rendered as React text children.
// Validates: Requirements 14.6, 27.1, 27.3, 27.4, 27.5

import { useEffect, useRef, useState } from 'react'

import { FileCode, Search } from '../../components/Icons'
import { useFileActions } from '../../editor/useFileActions'
import { useFileIo } from '../../editor/FileIoProvider'
import { runSearch, type SearchResult, type SearchToken } from '../../search/runSearch'
import {
  DEFAULT_SEARCH_OPTIONS,
  type SearchHit,
  type SearchOptions,
} from '../../search/searchText'
import { useAppDispatch, useAppState } from '../../state/AppState'
import { useCommandIo } from '../../terminal/CommandIoProvider'
import styles from './SearchPanel.module.css'

export const SEARCH_DEBOUNCE_MS = 250

type SearchView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failure'; message: string }
  | { kind: 'result'; result: SearchResult }

function channelName(result: SearchResult): string {
  return result.channel === 'git-grep' ? 'git grep' : 'folder walker'
}

function HitText({ hit }: { hit: SearchHit }) {
  const before = hit.text.slice(0, hit.start)
  const match = hit.text.slice(hit.start, hit.start + hit.length)
  const after = hit.text.slice(hit.start + hit.length)
  return (
    <span className={styles.matchContent}>
      {before}
      <span className={styles.highlight}>{match}</span>
      {after}
    </span>
  )
}

export default function SearchPanel() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const files = useFileIo()
  const command = useCommandIo()
  const fileActions = useFileActions()
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS)
  const [view, setView] = useState<SearchView>({ kind: 'idle' })
  const latestRequest = useRef(0)

  useEffect(() => {
    const requestId = ++latestRequest.current
    const token: SearchToken = { cancelled: false }
    const root = state.projectRoot
    const query = state.searchQuery

    if (root === null || query.trim() === '') {
      setView({ kind: 'idle' })
      return () => {
        token.cancelled = true
      }
    }

    setView({ kind: 'loading' })
    const timer = window.setTimeout(() => {
      void runSearch(
        { files, command },
        { root, query, options, token },
      ).then((outcome) => {
        if (token.cancelled || requestId !== latestRequest.current || 'cancelled' in outcome) return
        if (outcome.ok) setView({ kind: 'result', result: outcome })
        else setView({ kind: 'failure', message: outcome.message })
      })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      token.cancelled = true
      window.clearTimeout(timer)
    }
  }, [command, files, options, state.projectRoot, state.searchQuery])

  const toggle = (key: keyof SearchOptions) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }))
  }

  const result = view.kind === 'result' ? view.result : null

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
          <button
            className={`${styles.optionBtn} ${options.regex ? styles.active : ''}`}
            title="Use Regular Expression"
            aria-pressed={options.regex}
            onClick={() => toggle('regex')}
          >
            .*
          </button>
        </div>
      </div>

      {state.projectRoot === null ? (
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
        <div className={styles.state}>No matches for “{state.searchQuery}”.</div>
      ) : result !== null ? (
        <>
          <div className={styles.summary}>
            {result.hitCount} {result.hitCount === 1 ? 'match' : 'matches'} in{' '}
            {result.groups.length} {result.groups.length === 1 ? 'file' : 'files'} via{' '}
            {channelName(result)}.
            {result.truncated && ` Showing the first ${result.hitCount} matches.`}
          </div>
          {result.fallbackReason !== null && (
            <div className={styles.detail}>
              git grep was unavailable ({result.fallbackReason}); searched with the folder walker.
            </div>
          )}
          {result.unreadable > 0 && (
            <div className={styles.detail}>
              {result.unreadable} {result.unreadable === 1 ? 'path was' : 'paths were'} unreadable.
            </div>
          )}
          <div className={styles.resultsList}>
            {result.groups.map((group) => (
              <div key={group.path} className={styles.fileGroup}>
                <button
                  className={styles.fileHeader}
                  onClick={() => void fileActions.openPath(group.path)}
                  title={`Open ${group.relativePath}`}
                >
                  <FileCode size={14} />
                  <span>{group.relativePath}</span>
                  <span className={styles.badge}>{group.hits.length}</span>
                </button>
                {group.hits.map((hit, index) => (
                  <button
                    key={`${hit.line}:${hit.start}:${index}`}
                    className={styles.matchLine}
                    onClick={() => void fileActions.openPath(group.path)}
                    title={`Open ${group.relativePath} at line ${hit.line}`}
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
