
import { useAppState } from '../state/AppState';
import { useOptionalGit } from '../git/GitProvider';
import { branchLabel } from '../git/gitStatus';
import { GitBranch, AlertCircle, AlertTriangle, Zap } from './Icons';
import styles from './StatusBar.module.css';

export function StatusBar() {
  const state = useAppState();
  const git = useOptionalGit();
  const isAgent = state.mode === 'agent';

  // The real branch, from the one git owner the window has (src/git/GitProvider).
  // It used to read `main` unconditionally, which was wrong in every repository not
  // on main and a lie in every folder that is not a repository at all. There is no
  // fallback name: with no project open, or no repository, the chip is not rendered
  // (Requirements 14.6, 27.3).
  const branch = branchLabel(git?.status ?? null);

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        <div className={styles.item}>
          <div className={styles.statusDot} />
          <span>Anthropic</span>
        </div>
        {branch !== null && (
          <div className={styles.item} title={git?.root ?? undefined}>
            <GitBranch size={12} />
            <span>{branch}</span>
          </div>
        )}
        <div className={styles.item}>
          <span className={styles.error}><AlertCircle size={12} /> 0</span>
          <span className={styles.warning}><AlertTriangle size={12} /> 2</span>
        </div>
      </div>

      <div className={styles.right}>
        {isAgent ? (
          <>
            <div className={styles.item}>Claude 3.5 Sonnet</div>
            <div className={styles.item}>14.2k tokens</div>
          </>
        ) : (
          <>
            <div className={styles.badge}>TSX</div>
            <div className={styles.item}>Ln 42, Col 15</div>
            <div className={styles.item}>UTF-8</div>
            <div className={styles.item}>4.2 KB</div>
          </>
        )}

        {/* The cost figure is still hardcoded. It belongs to the cost dashboard
            (task 8.4), which owns the real total; changing it here would put a
            second cost source in the product. */}
        <div className={styles.item}>
          <Zap size={12} className={styles.zap} />
          <span>$1.4025</span>
        </div>

        <div className={`${styles.badge} ${isAgent ? styles.badgeAgent : styles.badgeIde}`}>
          {isAgent ? 'AGENT' : 'IDE'}
        </div>
      </div>
    </div>
  );
}
