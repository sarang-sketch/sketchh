
import styles from './Terminal.module.css';
import { Plus } from '../../components/Icons';

export default function Terminal() {
  return (
    <div className={styles.terminal}>
      <div className={styles.header}>
        <div className={styles.tabs}>
          <div className={`${styles.tab} ${styles.active}`}>Terminal 1</div>
          <div className={styles.tab}>Terminal 2</div>
          <button className={styles.addBtn} title="New Terminal">
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div className={styles.body}>
        <div className={styles.outputLine}>
          <span className={styles.prompt}>saran@sketch</span> <span className={styles.path}>~/Downloads/sketch/desktop</span> $ npm install
        </div>
        <div className={styles.outputLine}>
          <span className={styles.info}>[1/4]</span> Resolving packages...
        </div>
        <div className={styles.outputLine}>
          <span className={styles.info}>[2/4]</span> Fetching packages...
        </div>
        <div className={styles.outputLine}>
          <span className={styles.info}>[3/4]</span> Linking dependencies...
        </div>
        <div className={styles.outputLine}>
          <span className={styles.success}>success</span> Saved lockfile.
        </div>
        <div className={styles.outputLine}>
          <span className={styles.info}>info</span> Done in 4.52s.
        </div>
        
        <div className={styles.inputLine}>
          <span className={styles.prompt}>saran@sketch</span>
          <span className={styles.path}>~/Downloads/sketch/desktop</span> $ 
          <div className={styles.cursor}></div>
        </div>
      </div>
    </div>
  );
}
