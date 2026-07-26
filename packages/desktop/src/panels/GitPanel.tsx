import { useState } from 'react';
import { GitBranch, ChevronDown, Plus, Minus, Check } from '../components/Icons';
import styles from './GitPanel.module.css';

const MOCK_STAGED = [
  { name: 'src/panels/GitPanel.tsx', status: 'M' },
  { name: 'src/panels/GitPanel.module.css', status: 'A' }
];

const MOCK_CHANGES = [
  { name: 'src/components/AppLayout.tsx', status: 'M' },
  { name: 'src/panels/FileExplorer.tsx', status: 'M' },
  { name: 'src/components/Icons.tsx', status: 'M' }
];

const MOCK_UNTRACKED = [
  { name: 'src/components/ModelSelector.tsx', status: 'U' }
];

export function GitPanel() {
  const [message, setMessage] = useState('');

  const renderFile = (file: { name: string; status: string }, isStaged: boolean) => {
    let statusClass = '';
    switch (file.status) {
      case 'M': statusClass = styles.statusM; break;
      case 'A': statusClass = styles.statusA; break;
      case 'D': statusClass = styles.statusD; break;
      case 'U': statusClass = styles.statusU; break;
    }

    return (
      <div key={file.name} className={styles.fileRow}>
        <div className={styles.fileInfo}>
          <span className={`${styles.statusIcon} ${statusClass}`}>{file.status}</span>
          <span className={styles.fileName}>{file.name.split('/').pop()}</span>
          <span className={styles.filePath}>{file.name.split('/').slice(0, -1).join('/')}</span>
        </div>
        <button className={styles.actionBtn}>
          {isStaged ? <Minus size={14} /> : <Plus size={14} />}
        </button>
      </div>
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.branchInfo}>
          <GitBranch size={14} />
          <span className={styles.branchName}>feature/new-ui</span>
          <ChevronDown size={14} className={styles.chevron} />
        </div>
      </div>

      <div className={styles.commitSection}>
        <textarea 
          className={styles.commitInput} 
          placeholder="Message (Cmd+Enter to commit)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button className={styles.commitBtn}>
          <Check size={14} /> Commit
        </button>
      </div>

      <div className={styles.changesList}>
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <ChevronDown size={14} />
            <span>Staged Changes</span>
            <span className={styles.badge}>{MOCK_STAGED.length}</span>
          </div>
          {MOCK_STAGED.map(f => renderFile(f, true))}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <ChevronDown size={14} />
            <span>Changes</span>
            <span className={styles.badge}>{MOCK_CHANGES.length}</span>
          </div>
          {MOCK_CHANGES.map(f => renderFile(f, false))}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <ChevronDown size={14} />
            <span>Untracked</span>
            <span className={styles.badge}>{MOCK_UNTRACKED.length}</span>
          </div>
          {MOCK_UNTRACKED.map(f => renderFile(f, false))}
        </div>
      </div>
    </div>
  );
}
