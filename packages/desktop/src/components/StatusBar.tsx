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
// `0 errors / 2 warnings` is deleted. There is no diagnostics pipeline in this build, so
// the counts were decoration — and a status bar claiming two warnings while the editor
// shows none teaches the user to ignore the status bar.
//
// `Anthropic` is deleted for the same reason: it claimed a provider whether or not one
// was configured.
//
// The line/column and file-size figures are left as they are: they belong to the editor
// surface, are marked in task 3.x, and are not this task's to fix.
//
// Validates: Requirements 20.8, 27.1, 27.3, 14.6

import { useAppDispatch, useAppState } from '../state/AppState';
import { useOptionalGit } from '../git/GitProvider';
import { branchLabel } from '../git/gitStatus';
import { GitBranch, Zap } from './Icons';
import styles from './StatusBar.module.css';

export function StatusBar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const git = useOptionalGit();
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

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        {provider !== null && (
          <div className={styles.item} title={`Configured in providers.json`}>
            <div className={styles.statusDot} />
            <span>{provider.label || provider.id}</span>
          </div>
        )}
        {branch !== null && (
          <div className={styles.item} title={git?.root ?? undefined}>
            <GitBranch size={12} />
            <span>{branch}</span>
          </div>
        )}
      </div>

      <div className={styles.right}>
        {isAgent ? (
          model !== null && <div className={styles.item}>{model}</div>
        ) : (
          <>
            <div className={styles.badge}>TSX</div>
            <div className={styles.item}>Ln 42, Col 15</div>
            <div className={styles.item}>UTF-8</div>
            <div className={styles.item}>4.2 KB</div>
          </>
        )}

        {/* Opens the panel that has the real total. See the header. */}
        <button
          type="button"
          className={styles.costButton}
          onClick={() => dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'cost' })}
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
