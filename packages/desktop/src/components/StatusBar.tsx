// The status bar.
//
// ── THE COST FIGURE IS GONE AND IS NOT REPLACED WITH A NUMBER ──────────────
//
// `$1.4025` used to sit here, and the same string sat in `TaskLog`, and `AppState` held
// `totalCost: 12.45` as a third copy. All three are deleted.
//
// It is deliberately NOT replaced with a live total. Requirement 20.2 says the session
// total is the sum over the event log with no independent source, and a status bar that
// fetched and cached its own copy would BE that second source — a number in the corner of
// the window that disagrees with the panel is worse than no number at all, because the
// user has to work out which one lied. So this is a button that opens the Cost panel,
// which owns the total.
//
// ── THE OTHER FIXTURES HERE, AND WHAT HAPPENED TO THEM ─────────────────────
//
// `Claude 3.5 Sonnet` now reads the selected provider and model from `providers.json`
// (task 4.1's real state), and renders nothing when nothing is configured.
//
// `14.2k tokens` is deleted. A real token count is a sum over the log, which is the Cost
// panel's job; a plausible-looking one in the corner is the same failure as the dollar
// figure.
//
// `0 errors / 2 warnings` was deleted while there was no diagnostics pipeline, because
// counts nobody computed were decoration. There is one now — the editor's language
// services report problems into `AppState.diagnostics` — so the counts are back, real,
// and a click opens the Problems panel that lists them.
//
// `Anthropic` is deleted for the same reason: it claimed a provider whether or not one
// was configured.
//
// The line/column and file-size figures are left as they are: they belong to the editor
// surface, are marked in task 3.x, and are not this task's to fix.
//
// Validates: Requirements 20.8, 27.1, 27.3, 14.6

import { useEffect } from 'react';
import { useAppDispatch, useAppState } from '../state/AppState';
import { useOptionalGit } from '../git/GitProvider';
import { branchLabel } from '../git/gitStatus';
import { useEngineStatus, useSketchClient } from '../lib/ClientProvider';
import { byteLength } from '../editor/fileIo';
import { AlertCircle, AlertTriangle, GitBranch, Lock, Sparkles, Zap } from './Icons';
import { countProblems } from '../panels/ide/ProblemsPanel';
import { runEditorAction } from '../editor/editorBridge';
import styles from './StatusBar.module.css';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StatusBar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const git = useOptionalGit();
  const engine = useEngineStatus();
  const isAgent = state.mode === 'agent';

  // The real branch, from the one git owner the window has (src/git/GitProvider).
  // It used to read `main` unconditionally, which was wrong in every repository not
  // on main and a lie in every folder that is not a repository at all. There is no
  // fallback name: with no project open, or no repository, the chip is not rendered
  // (Requirements 14.6, 27.3).
  const branch = branchLabel(git?.status ?? null);

  // The configured selection, or nothing. Never a plausible default.
  const provider = state.providers.find((entry) => entry.id === state.selectedProvider) ?? null;
  const model = state.selectedModel ?? provider?.model ?? null;

  // The editor facts, from the editor. They used to read `TSX`, `Ln 42, Col 15`,
  // `UTF-8` and `4.2 KB` whatever was open — or with nothing open at all.
  const active = state.activeFile ? state.files[state.activeFile] : undefined;

  const problems = countProblems(state.diagnostics);
  const indent = state.editorSettings.insertSpaces ? `Spaces: ${state.editorSettings.tabSize}` : `Tab Size: ${state.editorSettings.tabSize}`;

  // Offline Mode, as the engine reports it, asked once the engine is up. Settings →
  // Privacy refreshes the same state when the switch changes.
  const client = useSketchClient();
  useEffect(() => {
    if (engine.state !== 'ready' || client.privacyStatus === undefined) return;
    let live = true;
    client.privacyStatus().then(
      (status) => live && dispatch({ type: 'SET_OFFLINE', payload: status.offline }),
      () => live && dispatch({ type: 'SET_OFFLINE', payload: null }),
    );
    return () => {
      live = false;
    };
  }, [client, dispatch, engine.state]);

  const engineLabel =
    engine.state === 'ready' ? 'Engine ready' : engine.state === 'error' ? 'Engine not running' : 'Starting engine…';

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        <div
          className={styles.item}
          title={engine.state === 'error' ? `${engineLabel}: ${engine.error ?? 'unknown error'}` : `${engineLabel}${engine.ping ? ` (v${engine.ping.version}, ${engine.ping.transport})` : ''}`}
        >
          <div className={`${styles.statusDot} ${engine.state === 'error' ? styles.dotError : engine.state === 'ready' ? '' : styles.dotIdle}`} />
          {engine.state !== 'ready' && <span>{engineLabel}</span>}
        </div>
        {state.offline === true && (
          <button
            type="button"
            className={styles.itemButton}
            title="Offline Mode is on: only models on this computer can be used (Settings → Privacy)"
            onClick={() => dispatch({ type: 'OPEN_SETTINGS', payload: 'privacy' })}
          >
            <Lock size={12} />
            <span>Offline</span>
          </button>
        )}
        {provider !== null ? (
          <button
            type="button"
            className={styles.itemButton}
            title="Change the model (Settings → Models)"
            onClick={() => dispatch({ type: 'OPEN_SETTINGS', payload: 'models' })}
          >
            <span>{provider.label || provider.id}</span>
            {model !== null && <span className={`${styles.muted} ${styles.modelName}`}>· {model}</span>}
          </button>
        ) : (
          state.providerSettingsPath !== null && (
            <button type="button" className={styles.itemButton} onClick={() => dispatch({ type: 'OPEN_CONNECT' })}>
              Connect a model
            </button>
          )
        )}
        {branch !== null && (
          <button
            type="button"
            className={styles.itemButton}
            title={`Source Control: ${git?.root ?? ''}`}
            onClick={() => {
              dispatch({ type: 'SET_MODE', payload: 'ide' });
              dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'git' });
            }}
          >
            <GitBranch size={12} />
            <span>{branch}</span>
          </button>
        )}
        {!isAgent && state.projectRoot !== null && (
          <button
            type="button"
            className={styles.itemButton}
            title={`Problems in the open files (Ctrl+Shift+M): ${problems.errors} error${problems.errors === 1 ? '' : 's'}, ${problems.warnings} warning${problems.warnings === 1 ? '' : 's'}`}
            aria-label={`${problems.errors} error${problems.errors === 1 ? '' : 's'}, ${problems.warnings} warning${problems.warnings === 1 ? '' : 's'}. Open Problems`}
            onClick={() => dispatch({ type: 'SHOW_BOTTOM_PANEL', payload: 'problems' })}
          >
            <AlertCircle size={12} className={problems.errors > 0 ? styles.errorIcon : undefined} />
            <span>{problems.errors}</span>
            <AlertTriangle size={12} className={problems.warnings > 0 ? styles.warningIcon : undefined} />
            <span>{problems.warnings}</span>
          </button>
        )}
      </div>

      <div className={styles.right}>
        {!isAgent && (
          // AUTOCOMPLETE — the ghost-text toggle. Off until the user turns it on: each
          // suggestion is a model call, and on a paid provider that is a cost that grows
          // with how much somebody types. With no model connected it offers to connect one.
          <button
            type="button"
            className={`${styles.itemButton} ${state.ghostCompletionsEnabled ? styles.autocompleteOn : ''}`}
            aria-pressed={state.ghostCompletionsEnabled}
            title={
              provider === null
                ? 'Autocomplete needs a model. Click to connect one (free options available).'
                : state.ghostCompletionsEnabled
                  ? `Autocomplete is ON with ${model ?? provider.label}: pause while typing to see a suggestion, Tab to accept, Esc to dismiss, Alt+\\ to ask now. Click to turn off.`
                  : 'Autocomplete is OFF. Click to get AI code suggestions as you type (Tab to accept).'
            }
            onClick={() => {
              if (provider === null) {
                dispatch({ type: 'OPEN_CONNECT' });
                return;
              }
              dispatch({ type: 'SET_GHOST_COMPLETIONS', payload: !state.ghostCompletionsEnabled });
            }}
          >
            <Sparkles size={12} />
            <span>{state.ghostCompletionsEnabled ? 'Autocomplete' : 'Autocomplete off'}</span>
          </button>
        )}
        {!isAgent && active && (
          <>
            <div className={`${styles.badge} ${styles.optional}`}>{active.language}</div>
            {state.cursor && (
              <button type="button" className={styles.itemButton} title="Go to Line (Ctrl+G)" onClick={() => runEditorAction('editor.action.gotoLine')}>
                Ln {state.cursor.line}, Col {state.cursor.column}
              </button>
            )}
            <button type="button" className={styles.itemButton} title="Indentation (Settings → Editor)" onClick={() => dispatch({ type: 'OPEN_SETTINGS', payload: 'editor' })}>
              {indent}
            </button>
            <div className={`${styles.item} ${styles.optional}`}>UTF-8</div>
            <div className={`${styles.item} ${styles.optional}`} title="Line endings">{active.content.includes('\r\n') ? 'CRLF' : 'LF'}</div>
            <div className={`${styles.item} ${styles.optional}`}>{formatBytes(byteLength(active.content))}</div>
            {active.isDirty && (
              <div className={styles.item} title="This file has unsaved changes">
                <span className={styles.dirtyDot} />
                <span>unsaved</span>
              </div>
            )}
          </>
        )}

        {/* Opens the panel that has the real total. See the header. */}
        <button
          type="button"
          className={styles.costButton}
          onClick={() => {
            dispatch({ type: 'SET_MODE', payload: 'ide' });
            dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'cost' });
          }}
          title="Open the Cost panel, which sums this project's event log"
        >
          <Zap size={12} className={styles.zap} />
          <span>Cost</span>
        </button>

        <div className={`${styles.badge} ${isAgent ? styles.badgeAgent : styles.badgeIde}`}>
          {isAgent ? 'AGENT' : 'IDE'}
        </div>
      </div>
    </div>
  );
}
