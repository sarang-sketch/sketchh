// Problems — what the editor's language services found in the open files.
//
// The list is `AppState.diagnostics`, which the editor fills from Monaco's markers as
// files are opened and edited (see editor/CodeEditor.tsx). Clicking a problem opens its
// file at the line. "Fix with Sketch" hands every problem in a file to the agent.
//
// Scope, stated in the UI rather than implied: these are the problems in OPEN files,
// as the in-editor language services see them. The project's own compiler, linter and
// tests are the Test Results panel's job.

import { useMemo, useState } from 'react'

import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, FileCode, Info, Sparkles } from '../../components/Icons'
import { relativeToRoot } from '../../editor/paths'
import { useFileActions } from '../../editor/useFileActions'
import { requestInlineEdit } from '../../editor/inlineEditing'
import { useOptionalAgentSession } from '../../lib/AgentSession'
import { useOptionalSketchClient } from '../../lib/ClientProvider'
import { useAppDispatch, useAppState, type Diagnostic } from '../../state/AppState'
import styles from './ProblemsPanel.module.css'

const ORDER: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 }

export function countProblems(diagnostics: Record<string, Diagnostic[]>): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const list of Object.values(diagnostics)) {
    for (const d of list) {
      if (d.severity === 'error') errors += 1
      else if (d.severity === 'warning') warnings += 1
    }
  }
  return { errors, warnings }
}

export function ProblemsPanel() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const fileActions = useFileActions()
  const session = useOptionalAgentSession()
  const client = useOptionalSketchClient()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return Object.entries(state.diagnostics)
      .map(([path, list]) => ({
        path,
        list: [...list]
          .filter((d) => needle === '' || d.message.toLowerCase().includes(needle) || path.toLowerCase().includes(needle))
          .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.line - b.line || a.column - b.column),
      }))
      .filter((group) => group.list.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path))
  }, [filter, state.diagnostics])

  const totals = countProblems(state.diagnostics)
  const root = state.projectRoot

  const go = async (path: string, d: Diagnostic) => {
    dispatch({ type: 'SET_MODE', payload: 'ide' })
    await fileActions.openPath(path)
    dispatch({ type: 'REVEAL_IN_EDITOR', payload: { path, line: d.line, column: d.column } })
  }

  // One problem, fixed in place: inline edit on its lines, with a diff to accept.
  const canFixInline = client?.inlineEdit !== undefined
  const quickFix = async (path: string, d: Diagnostic) => {
    await go(path, d)
    const code = d.code !== undefined ? ` (${d.source ?? 'code'} ${d.code})` : ''
    requestInlineEdit({
      path,
      lines: { start: d.line, end: Math.min(Math.max(d.endLine, d.line), d.line + 40) },
      instruction: `Fix this ${d.severity} on line ${d.line}: ${d.message}${code}`,
      autoRun: true,
    })
  }

  const fix = (path: string, list: Diagnostic[]) => {
    if (session === null) return
    const rel = root === null ? path : relativeToRoot(root, path)
    const lines = list
      .slice(0, 40)
      .map((d) => `- line ${d.line}:${d.column} ${d.severity}: ${d.message}${d.code ? ` (${d.code})` : ''}`)
      .join('\n')
    if (state.rightPanelCollapsed) dispatch({ type: 'TOGGLE_RIGHT_PANEL' })
    session.send(
      `Fix these problems in \`${rel}\`:\n\n${lines}\n\nFind the root cause of each, make the smallest correct change, and keep the file's style.`,
      { display: `Fix ${list.length} problem${list.length === 1 ? '' : 's'} in ${rel}` },
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <input
          className={styles.filter}
          placeholder="Filter problems (text or file)"
          aria-label="Filter problems"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className={styles.totals}>
          <AlertCircle size={12} className={styles.error} /> {totals.errors}
          <AlertTriangle size={12} className={styles.warning} /> {totals.warnings}
        </span>
      </div>

      {groups.length === 0 ? (
        <div className={styles.empty}>
          {Object.keys(state.diagnostics).length === 0
            ? 'No problems found in the open files.'
            : 'No problems match the filter.'}
          <div className={styles.emptyHint}>
            Problems appear here as you open and edit TypeScript, JavaScript, JSON, CSS and HTML files.
          </div>
        </div>
      ) : (
        <div className={styles.list} role="tree" aria-label="Problems">
          {groups.map(({ path, list }) => {
            const open = !collapsed.has(path)
            const rel = root === null ? path : relativeToRoot(root, path)
            return (
              <div key={path} role="treeitem" aria-expanded={open}>
                <div className={styles.fileRow}>
                  <button
                    type="button"
                    className={styles.fileToggle}
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev)
                        if (next.has(path)) next.delete(path)
                        else next.add(path)
                        return next
                      })
                    }
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <FileCode size={13} />
                    <span className={styles.fileName}>{rel.split('/').pop()}</span>
                    <span className={styles.fileDir}>{rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''}</span>
                    <span className={styles.badge}>{list.length}</span>
                  </button>
                  {session !== null && (
                    <button
                      type="button"
                      className={styles.fixBtn}
                      onClick={() => fix(path, list)}
                      disabled={session.activeRunId !== null}
                      title="Ask the agent to fix every problem in this file"
                    >
                      <Sparkles size={11} /> Fix with Sketch
                    </button>
                  )}
                </div>
                {open &&
                  list.map((d, index) => (
                    <div key={`${d.line}:${d.column}:${index}`} className={styles.problemRow}>
                      <button
                        type="button"
                        className={styles.problem}
                        onClick={() => void go(path, d)}
                        title={`${rel}:${d.line}:${d.column}`}
                      >
                        {d.severity === 'error' ? (
                          <AlertCircle size={13} className={styles.error} />
                        ) : d.severity === 'warning' ? (
                          <AlertTriangle size={13} className={styles.warning} />
                        ) : (
                          <Info size={13} className={styles.info} />
                        )}
                        <span className={styles.message}>{d.message}</span>
                        {d.source !== undefined && <span className={styles.source}>{d.source}{d.code ? `(${d.code})` : ''}</span>}
                        <span className={styles.position}>
                          [Ln {d.line}, Col {d.column}]
                        </span>
                      </button>
                      {canFixInline && (
                        <button
                          type="button"
                          className={styles.quickFix}
                          onClick={() => void quickFix(path, d)}
                          aria-label="Fix this problem with AI"
                          title="Fix with AI, in the editor: shows the change for you to accept"
                        >
                          <Sparkles size={11} />
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default ProblemsPanel
