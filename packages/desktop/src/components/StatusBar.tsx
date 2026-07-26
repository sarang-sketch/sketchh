
import { useAppState } from '../state/AppState';
import { GitBranch, AlertCircle, AlertTriangle, Zap } from './Icons';
import styles from './StatusBar.module.css';

export function StatusBar() {
  const state = useAppState();
  const isAgent = state.mode === 'agent';

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        <div className={styles.item}>
          <div className={styles.statusDot} />
          <span>Anthropic</span>
        </div>
        <div className={styles.item}>
          <GitBranch size={12} />
          <span>main</span>
        </div>
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
