import { useState } from 'react';
import styles from './EditorArea.module.css';
import { FileCode, X, ChevronRight, Folder, File, Package } from './Icons';
import { useAppState, useAppDispatch } from '../state/AppState';

export default function EditorArea() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [hasFileOpen, setHasFileOpen] = useState(false);

  const handleOpenFolder = () => {
    dispatch({ type: 'SET_PROJECT_ROOT', payload: 'C:\\Users\\saran\\Downloads\\sketch' });
    setHasFileOpen(true);
  };

  if (!hasFileOpen) {
    return (
      <div className={styles.editorAreaTeal}>
        {/* Welcome Screen Match */}
        <div className={styles.antigravityWelcome}>
          
          {/* Sketch Aman Logo S */}
          <div className={styles.agLogoWrapper}>
            <span className={styles.agLogoText}>S</span>
          </div>

          <h1 className={styles.agTitle}>Sketch Aman IDE</h1>

          {/* Primary & Secondary Buttons */}
          <div className={styles.agBtnRow}>
            <button className={styles.agPrimaryBtn} onClick={handleOpenFolder}>
              <Folder size={16} />
              <span>Open Folder</span>
            </button>

            <button className={styles.agSecondaryBtn}>
              <Package size={16} />
              <span>Clone Repository</span>
            </button>
          </div>

          {/* Workspaces List Section */}
          <div className={styles.workspacesSection}>
            <h3 className={styles.workspacesTitle}>Workspaces</h3>

            <div className={styles.workspacesList}>
              {state.workspaces.map((ws, index) => (
                <div key={index} className={styles.workspaceCard} onClick={handleOpenFolder}>
                  <span className={styles.wsName}>{ws.name}</span>
                  <span className={styles.wsPath}>{ws.path}</span>
                </div>
              ))}
            </div>

            <button className={styles.showMoreBtn}>Show More...</button>
          </div>

        </div>
      </div>
    );
  }

  return (
    <div className={styles.editorArea}>
      <div className={styles.tabBar}>
        <div className={`${styles.tab} ${styles.active}`}>
          <div className={styles.tabIcon}>
            <FileCode size={14} />
          </div>
          <span>App.tsx</span>
          <button className={styles.tabClose} onClick={() => setHasFileOpen(false)}>
            <X size={14} />
          </button>
        </div>
        <div className={styles.tab}>
          <div className={styles.tabIcon}>
            <File size={14} />
          </div>
          <span>styles.css</span>
          <button className={styles.tabClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      
      <div className={styles.breadcrumb}>
        <div className={styles.breadcrumbItem}>sketch</div>
        <ChevronRight size={12} />
        <div className={styles.breadcrumbItem}>desktop</div>
        <ChevronRight size={12} />
        <div className={styles.breadcrumbItem}>src</div>
        <ChevronRight size={12} />
        <div className={styles.breadcrumbItem} style={{ color: 'var(--text-primary)' }}>App.tsx</div>
      </div>
      
      <div className={styles.editorBody}>
        <div className={styles.gutter}>
          {Array.from({ length: 22 }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <div className={styles.codeArea}>
          <span className={styles.comment}>// Sketch Aman Engine connected</span>
          <br/>
          <span className={styles.keyword}>import</span> React, {'{'} <span className={styles.function}>useState</span> {'}'} <span className={styles.keyword}>from</span> <span className={styles.string}>'react'</span>;
          <br/>
          <span className={styles.keyword}>import</span> styles <span className={styles.keyword}>from</span> <span className={styles.string}>'./App.module.css'</span>;
          <br/><br/>
          <span className={styles.keyword}>export</span> <span className={styles.keyword}>default</span> <span className={styles.keyword}>function</span> <span className={styles.function}>App</span>() {'{'}
          <br/>
          {'  '}<span className={styles.keyword}>const</span> [status, setStatus] = <span className={styles.function}>useState</span>{'<'}<span className={styles.type}>string</span>{'>'}(<span className={styles.string}>'Ready'</span>);
          <br/><br/>
          {'  '}<span className={styles.keyword}>return</span> (
          <br/>
          {'    '}{'<div className={styles.container}>'}
          <br/>
          {'      '}{'<h1>'}Sketch Aman Engine{'</h1>'}
          <br/>
          {'      '}{'<p>'}Status: {'{'}status{'}'}{'</p>'}
          <br/>
          {'    '}{'</div>'}
          <br/>
          {'  '});
          <br/>
          {'}'}
        </div>
        <div className={styles.statusBar}>
          Ln 12, Col 4
        </div>
      </div>
    </div>
  );
}

