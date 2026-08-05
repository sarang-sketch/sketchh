// The Code surface's editor.
//
// WHAT THIS COMPONENT NO LONGER HAS, and why that was the whole point of task 3.1:
// a local `hasFileOpen` boolean, two hardcoded tabs ("App.tsx", "styles.css"), a
// 22-row gutter built from `Array.from({ length: 22 })`, hand-written `<span>`s
// pretending to be syntax highlighting, a hardcoded "Ln 12, Col 4", and an "Open
// Folder" button that dispatched one developer's absolute path.
//
// All of it is gone. Everything on screen now derives from the single state owner:
//
//   tabs           state.openFiles           (paths, in tab order)
//   text + gutter  Monaco, from state.files[path].content
//   dirty dot      state.files[path].isDirty
//   conflict       state.files[path].conflict, set when the engine wrote a dirty buffer
//   breadcrumb     the active path, relative to the real project root
//   cursor         Monaco's own caret (rendered inside CodeEditor)
//   Open Folder    the OS folder picker, via the file layer
//
// Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.6, 14.6, 27.3

import { useEffect } from 'react';
import styles from './EditorArea.module.css';
import { AlertTriangle, ChevronRight, File, FileCode, Folder, Package, X } from './Icons';
import { useAppDispatch, useAppState } from '../state/AppState';
import CodeEditor from '../editor/CodeEditor';
import { useFileActions } from '../editor/useFileActions';
import { useEngineWriteReconciler } from '../editor/useEngineWrites';
import { basename, pathSegments } from '../editor/paths';

export default function EditorArea() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useFileActions();

  // Engine writes reach the open buffers here, and nowhere else (Requirement 15.3).
  useEngineWriteReconciler();

  const { projectRoot, openFiles, activeFile, files, editorNotice } = state;
  const active = activeFile ? files[activeFile] : undefined;

  // Ctrl/Cmd+S. Bound on the window rather than on the editor so it works with the
  // focus on a tab as well as in the text, and `preventDefault` keeps the webview
  // from offering to save the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey)) return
      if (!activeFile) return
      event.preventDefault();
      void actions.save(activeFile);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions, activeFile]);

  const notice = editorNotice && (
    <div className={styles.notice} role="alert">
      <AlertTriangle size={14} />
      <span className={styles.noticeText}>{editorNotice.message}</span>
      <button className={styles.noticeClose} onClick={actions.dismissNotice} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );

  if (!projectRoot) {
    return (
      <div className={styles.editorAreaTeal}>
        <div className={styles.antigravityWelcome}>
          <div className={styles.agLogoWrapper}>
            <span className={styles.agLogoText}>S</span>
          </div>

          <h1 className={styles.agTitle}>Sketch IDE</h1>

          <div className={styles.agBtnRow}>
            <button className={styles.agPrimaryBtn} onClick={() => void actions.openFolder()}>
              <Folder size={16} />
              <span>Open Folder</span>
            </button>

            <button className={styles.agSecondaryBtn}>
              <Package size={16} />
              <span>Clone Repository</span>
            </button>
          </div>

          {/* Only folders this user has actually opened. No seeded examples. */}
          {state.workspaces.length > 0 && (
            <div className={styles.workspacesSection}>
              <h3 className={styles.workspacesTitle}>Workspaces</h3>
              <div className={styles.workspacesList}>
                {state.workspaces.map((ws) => (
                  <div
                    key={ws.path}
                    className={styles.workspaceCard}
                    onClick={() => dispatch({ type: 'SET_PROJECT_ROOT', payload: ws.path })}
                  >
                    <span className={styles.wsName}>{ws.name}</span>
                    <span className={styles.wsPath}>{ws.path}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {notice}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.editorArea}>
      <div className={styles.tabBar} role="tablist" aria-label="Open files">
        {openFiles.map((path) => {
          const entry = files[path];
          if (!entry) return null;
          const isActive = path === activeFile;
          return (
            <div
              key={path}
              role="tab"
              aria-selected={isActive}
              title={path}
              className={`${styles.tab} ${isActive ? styles.active : ''}`}
              onClick={() => actions.activate(path)}
            >
              <div className={styles.tabIcon}>
                {entry.language === 'plaintext' ? <File size={14} /> : <FileCode size={14} />}
              </div>
              <span>{entry.name}</span>
              {entry.conflict ? (
                <span className={styles.tabConflict} title="Changed on disk by the engine">
                  <AlertTriangle size={12} />
                </span>
              ) : entry.isDirty ? (
                <span className={styles.tabDirty} aria-label="unsaved changes">
                  ●
                </span>
              ) : null}
              <button
                className={styles.tabClose}
                aria-label={`Close ${entry.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  actions.closePath(path);
                }}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {active && (
        <div className={styles.breadcrumb}>
          {[basename(projectRoot), ...pathSegments(projectRoot, active.path)].map((part, index, all) => (
            <span key={`${part}-${index}`} className={styles.breadcrumbRow}>
              {index > 0 && <ChevronRight size={12} />}
              <span
                className={styles.breadcrumbItem}
                style={index === all.length - 1 ? { color: 'var(--text-primary)' } : undefined}
              >
                {part}
              </span>
            </span>
          ))}
        </div>
      )}

      {notice}

      {active?.conflict && (
        <div className={styles.conflict} role="alert">
          <AlertTriangle size={14} />
          <span className={styles.noticeText}>
            The engine wrote {active.name} on disk while you had unsaved edits. Your version is
            still here and nothing was overwritten.
          </span>
          <button
            className={styles.conflictAction}
            onClick={() => void actions.reloadFromDisk(active.path)}
          >
            Reload from disk
          </button>
          <button className={styles.conflictAction} onClick={() => actions.keepMine(active.path)}>
            Keep my version
          </button>
        </div>
      )}

      {active ? (
        <CodeEditor />
      ) : (
        <div className={styles.emptyEditor}>
          <FileCode size={28} />
          <p>No file is open.</p>
          <p className={styles.emptyHint}>Choose a file in the Explorer to start editing.</p>
        </div>
      )}
    </div>
  );
}
