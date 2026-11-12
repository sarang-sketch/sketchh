// The bottom panel: Problems and Terminal, the two views every IDE keeps under the editor.

import { AlertCircle, Maximize, Minus, Terminal as TerminalIcon, X } from './Icons'
import ProblemsPanel, { countProblems } from '../panels/ide/ProblemsPanel'
import Terminal from '../panels/ide/Terminal'
import { useAppDispatch, useAppState } from '../state/AppState'
import styles from './BottomPanel.module.css'

export function BottomPanel({ maximized, onToggleMaximize }: { maximized: boolean; onToggleMaximize(): void }) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const { errors, warnings } = countProblems(state.diagnostics)
  const tab = state.bottomPanelTab
  const running = state.terminalHistory.some((run) => run.status === 'running')

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Bottom panel">
          <button
            type="button"
            role="tab"
            id="bottom-tab-problems"
            aria-controls="bottom-panel-body"
            aria-selected={tab === 'problems'}
            className={`${styles.tab} ${tab === 'problems' ? styles.active : ''}`}
            onClick={() => dispatch({ type: 'SET_BOTTOM_PANEL_TAB', payload: 'problems' })}
          >
            <AlertCircle size={13} />
            <span>Problems</span>
            {errors + warnings > 0 && (
              <span className={styles.counts}>
                {errors > 0 && <span className={styles.err}>{errors}</span>}
                {warnings > 0 && <span className={styles.warn}>{warnings}</span>}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            id="bottom-tab-terminal"
            aria-controls="bottom-panel-body"
            aria-selected={tab === 'terminal'}
            className={`${styles.tab} ${tab === 'terminal' ? styles.active : ''}`}
            onClick={() => dispatch({ type: 'SET_BOTTOM_PANEL_TAB', payload: 'terminal' })}
          >
            <TerminalIcon size={13} />
            <span>Terminal</span>
            {running && <span className={styles.dot} aria-label="a command is running" />}
          </button>
        </div>
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onToggleMaximize}
            title={maximized ? 'Restore panel size' : 'Maximize panel'}
            aria-label={maximized ? 'Restore panel size' : 'Maximize panel'}
          >
            {maximized ? <Minus size={13} /> : <Maximize size={13} />}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => dispatch({ type: 'TOGGLE_BOTTOM_PANEL' })}
            title="Hide panel (Ctrl+J)"
            aria-label="Hide panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div
        className={styles.body}
        id="bottom-panel-body"
        role="tabpanel"
        aria-labelledby={tab === 'problems' ? 'bottom-tab-problems' : 'bottom-tab-terminal'}
      >
        {tab === 'problems' ? <ProblemsPanel /> : <Terminal />}
      </div>
    </div>
  )
}

export default BottomPanel
