// The Code surface's editor.
//
// Everything on screen derives from the single state owner:
//
//   tabs           state.openFiles           (paths, in tab order)
//   text + gutter  Monaco, from state.files[path].content
//   dirty dot      state.files[path].isDirty
//   conflict       state.files[path].conflict, set when the engine wrote a dirty buffer
//   breadcrumb     the active path, relative to the real project root
//   cursor         Monaco's own caret (rendered inside CodeEditor)
//
// Tabs behave as in every editor: middle-click closes, drag reorders, right-click offers
// Close / Close Others / Close to the Right / Close Saved / Close All / Copy Path, and a
// tab with unsaved edits is never closed without asking. Markdown files can be previewed.
// Auto-save, when chosen in Settings, saves a second after typing stops or when the
// editor loses focus. Tabs from the last session reopen at startup.
//
// Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.6, 14.6, 27.3

import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './EditorArea.module.css';
import { AlertTriangle, ChevronRight, Diff, Eye, File, FileCode, Folder, Package, X, Code, Search, Terminal as TerminalIcon } from './Icons';
import { CloneDialog } from './CloneDialog';
import { SketchMark } from './SketchMark';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { Markdown } from './Markdown';
import { useAppDispatch, useAppState } from '../state/AppState';
import CodeEditor from '../editor/CodeEditor';
import { DiffView, OPEN_DIFF_EVENT, diffKindFor, requestDiff, type DiffRequest } from '../editor/DiffView';
import { useOptionalGit } from '../git/GitProvider';
import { useFileActions } from '../editor/useFileActions';
import { useEngineWriteReconciler } from '../editor/useEngineWrites';
import { useOpenFilesDiskSync } from '../editor/diskSync';
import { useEditorAgentActions, useInlineCompletionProvider, useInlineEditRunner } from '../editor/inlineCompletion';
import { basename, canonicalPath, pathSegments, relativeToRoot } from '../editor/paths';

/** Auto-save "after delay": this long after the last keystroke. */
export const AUTO_SAVE_DELAY_MS = 1000;

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

export default function EditorArea() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useFileActions();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Markdown files currently shown as a preview instead of source. */
  const [previewing, setPreviewing] = useState<Set<string>>(new Set());
  // Autocomplete (status-bar toggle) and the right-click agent actions.
  const completionProvider = useInlineCompletionProvider();
  const agentAction = useEditorAgentActions();
  // Ctrl+K: edit the selection in place, with a diff to accept or reject.
  const inlineEditRunner = useInlineEditRunner();
  const latest = useRef(state);
  latest.current = state;
  // Effects use the latest actions through a ref: `useFileActions` returns a new object
  // every render, and the terminal re-renders this ten times a second while a command
  // streams, which would otherwise reset the auto-save timer forever.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Engine writes reach the open buffers here, and nowhere else (Requirement 15.3).
  useEngineWriteReconciler();
  // Everything else that changes the disk — a terminal command, a branch switch or
  // pull, another program while the window was in the background — is caught here.
  useOpenFilesDiskSync();

  // Menu/palette clone requests are owned by AppLayout, including before Code first mounts.

  // ── The diff view ───────────────────────────────────────────────────────────
  // It covers the tab it was opened on and closes when another tab (or none) is shown,
  // so there is never a comparison on screen for a file the tab strip does not name.
  const git = useOptionalGit();
  const [diff, setDiff] = useState<(DiffRequest & { openedOn: string | null }) | null>(null);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<DiffRequest | undefined>).detail;
      if (detail === undefined) return;
      const path = canonicalPath(detail.path);
      if (detail.kind !== 'changes') {
        // A snapshot comparison needs no tab: it shows over whatever is open now.
        setDiff({ path, kind: detail.kind, openedOn: latest.current.activeFile });
        return;
      }
      // The right side IS the file's tab, so the tab is opened first. If it cannot be
      // opened (gone, binary, refused), its notice says why and no diff is shown.
      void actionsRef.current.openPath(path).then(() => setDiff({ path, kind: 'changes', openedOn: path }));
    };
    window.addEventListener(OPEN_DIFF_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DIFF_EVENT, onOpen);
  }, []);
  const diffShown = diff !== null && state.activeFile === diff.openedOn;
  useEffect(() => {
    if (diff !== null && !diffShown) setDiff(null);
  }, [diff, diffShown]);

  const { projectRoot, openFiles, activeFile, files, editorNotice } = state;
  const active = activeFile ? files[activeFile] : undefined;
  const autoSave = state.editorSettings.autoSave;

  // ── reopen last session's tabs ───────────────────────────────────────────────
  const restoring = useRef(false);
  useEffect(() => {
    const pending = state.restoreTabs;
    if (pending === null || projectRoot === null || restoring.current) return;
    if (canonicalPath(pending.root) !== projectRoot) {
      dispatch({ type: 'TABS_RESTORED' });
      return;
    }
    restoring.current = true;
    void (async () => {
      // One at a time, in tab order; a file that has since vanished is skipped quietly.
      for (const path of pending.paths) await actionsRef.current.openPath(path);
      if (pending.active !== null && latest.current.openFiles.includes(canonicalPath(pending.active))) {
        actionsRef.current.activate(pending.active);
      }
      dispatch({ type: 'SET_EDITOR_NOTICE', payload: null });
      dispatch({ type: 'TABS_RESTORED' });
      restoring.current = false;
    })();
  }, [dispatch, projectRoot, state.restoreTabs]);

  // ── keyboard ─────────────────────────────────────────────────────────────────
  // Bound on the window so they work with the focus on a tab as well as in the text;
  // `preventDefault` keeps the webview from offering to save or close the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      const snapshot = latest.current;
      if (snapshot.mode !== 'ide') return;
      if (key === 's' && event.altKey) {
        event.preventDefault();
        void actionsRef.current.saveAll();
      } else if (key === 's' && !event.shiftKey) {
        if (!snapshot.activeFile) return;
        event.preventDefault();
        void actionsRef.current.save(snapshot.activeFile);
      } else if (key === 'w' && !event.shiftKey) {
        if (!snapshot.activeFile) return;
        event.preventDefault();
        void actionsRef.current.closePath(snapshot.activeFile);
      } else if ((key === 'tab' || key === 'pagedown' || key === 'pageup') && snapshot.openFiles.length > 1) {
        event.preventDefault();
        const back = key === 'pageup' || (key === 'tab' && event.shiftKey);
        const at = snapshot.activeFile ? snapshot.openFiles.indexOf(snapshot.activeFile) : -1;
        const next = (at + (back ? -1 : 1) + snapshot.openFiles.length) % snapshot.openFiles.length;
        actionsRef.current.activate(snapshot.openFiles[next]!);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ── auto-save ────────────────────────────────────────────────────────────────
  // The delay restarts on EVERY edit to a dirty buffer. Keyed on the text's length it
  // did not: replacing a selection or typing in overtype keeps the length, so the save
  // fired while the user was still typing. Each buffer's last text is remembered, and a
  // change bumps a counter that is part of the key.
  const lastDirtyText = useRef(new Map<string, string>());
  const editCount = useRef(0);
  const dirtyKey = useMemo(() => {
    const seen = new Map<string, string>();
    for (const path of openFiles) {
      const entry = files[path];
      if (!entry?.isDirty) continue;
      if (lastDirtyText.current.get(path) !== entry.content) editCount.current += 1;
      seen.set(path, entry.content);
    }
    lastDirtyText.current = seen;
    return seen.size === 0 ? '' : `${[...seen.keys()].join('|')}#${editCount.current}`;
  }, [files, openFiles]);
  useEffect(() => {
    if (autoSave !== 'afterDelay' || dirtyKey === '') return;
    const timer = setTimeout(() => {
      // A buffer in conflict with the disk, or whose file was deleted, is the user's
      // decision, not ours: auto-save must not resurrect a file a branch switch removed.
      for (const path of latest.current.openFiles) {
        const entry = latest.current.files[path];
        // No format-on-save here, as in VS Code: the user has only paused, and a
        // formatter would move the text under the caret.
        if (entry?.isDirty && !entry.conflict && !entry.deletedOnDisk) void actionsRef.current.save(path, { format: false });
      }
    }, AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoSave, dirtyKey]);

  const saveDirtyNow = () => {
    for (const path of latest.current.openFiles) {
      const entry = latest.current.files[path];
      if (entry?.isDirty && !entry.conflict && !entry.deletedOnDisk) void actionsRef.current.save(path);
    }
  };
  useEffect(() => {
    if (autoSave !== 'onFocusChange') return;
    window.addEventListener('blur', saveDirtyNow);
    return () => window.removeEventListener('blur', saveDirtyNow);
    // saveDirtyNow reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave]);

  // Leaving the page (the browser dev bridge, a reload) with unsaved edits asks first.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!latest.current.openFiles.some((p) => latest.current.files[p]?.isDirty)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

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
        <div className={styles.welcome}>
          <SketchMark size={48} className={styles.welcomeMark} />
          <h1 className={styles.agTitle}>Build with Sketch</h1>
          <p className={styles.agSubtitle}>Your editor, terminal and agent.<br />Open a project to begin.</p>

          <div className={styles.agBtnRow}>
            <button className={styles.agPrimaryBtn} onClick={() => void actions.openFolder()}>
              <Folder size={16} />
              <span>Open Folder</span>
            </button>

            <button className={styles.agSecondaryBtn} onClick={() => setCloneOpen(true)}>
              <Package size={16} />
              <span>Clone Repository</span>
            </button>
          </div>

          <CloneDialog open={cloneOpen} onClose={() => setCloneOpen(false)} />

          {/* Only folders this user has actually opened. No seeded examples. */}
          {state.workspaces.length > 0 && (
            <div className={styles.workspacesSection}>
              <h3 className={styles.workspacesTitle}>Recent</h3>
              <div className={styles.workspacesList}>
                {state.workspaces.slice(0, 8).map((ws) => (
                  <button
                    type="button"
                    key={ws.path}
                    className={styles.workspaceCard}
                    onClick={() => void actions.openFolderPath(ws.path)}
                  >
                    <Folder size={15} />
                    <span className={styles.workspaceInfo}>
                    <span className={styles.wsName}>{ws.name}</span>
                    <span className={styles.wsPath}>{ws.path}</span>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {state.appearance.showTips && <div className={styles.welcomeLinks}>
            <button onClick={() => dispatch({ type: 'OPEN_PALETTE', payload: 'commands' })}>All commands <kbd>Ctrl+Shift+P</kbd></button>
            <button onClick={() => dispatch({ type: 'OPEN_SETTINGS', payload: 'appearance' })}>Personalize your workspace</button>
          </div>}

          {notice}
        </div>
      </div>
    );
  }

  const tabMenu = (path: string): ContextMenuItem[] => {
    const at = openFiles.indexOf(path);
    const saved = openFiles.filter((p) => !files[p]?.isDirty);
    return [
      { id: 'close', label: 'Close', hint: 'Ctrl+W', run: () => void actions.closePath(path) },
      { id: 'others', label: 'Close Others', disabled: openFiles.length < 2, run: () => void actions.closeMany(openFiles.filter((p) => p !== path)) },
      { id: 'right', label: 'Close to the Right', disabled: at === openFiles.length - 1, run: () => void actions.closeMany(openFiles.slice(at + 1)) },
      { id: 'saved', label: 'Close Saved', disabled: saved.length === 0, run: () => void actions.closeMany(saved) },
      { id: 'all', label: 'Close All', run: () => void actions.closeMany(openFiles) },
      'separator',
      { id: 'copy', label: 'Copy Path', run: () => copy(path) },
      { id: 'copyrel', label: 'Copy Relative Path', run: () => copy(relativeToRoot(projectRoot, path)) },
      {
        id: 'reveal',
        label: 'Reveal in Explorer',
        run: () => {
          dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'explorer' });
          window.dispatchEvent(new CustomEvent('sketch:reveal-in-explorer', { detail: { path } }));
        },
      },
      'separator',
      {
        id: 'ask',
        label: 'Ask Sketch About This File',
        run: () => {
          if (state.rightPanelCollapsed) dispatch({ type: 'TOGGLE_RIGHT_PANEL' });
          dispatch({ type: 'SEED_COMPOSER', payload: { text: 'Explain what this file does and how it fits into the project.', files: [relativeToRoot(projectRoot, path)] } });
        },
      },
    ];
  };

  const isMarkdown = active !== undefined && /\.(md|markdown|mdx)$/i.test(active.path);
  const showPreview = isMarkdown && previewing.has(active!.path) && !diffShown;
  const activeDiffKind = active !== undefined ? diffKindFor(git?.status ?? null, git?.root ?? projectRoot, active.path) : null;
  const diffView = diffShown ? (
    <DiffView
      key={`${diff.kind}:${diff.path}`}
      request={diff}
      root={projectRoot}
      onClose={() => setDiff(null)}
      onOpenFile={
        diff.kind === 'deleted'
          ? undefined
          : () => {
              const path = diff.path;
              setDiff(null);
              void actions.openPath(path);
            }
      }
    />
  ) : null;

  return (
    <div className={styles.editorArea}>
      <CloneDialog open={cloneOpen} onClose={() => setCloneOpen(false)} />
      <div
        className={styles.tabBar}
        role="tablist"
        aria-label="Open files"
        onWheel={(event) => {
          // A vertical wheel scrolls the tab strip sideways, as in every editor.
          if (event.deltaY !== 0) event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        {openFiles.map((path, index) => {
          const entry = files[path];
          if (!entry) return null;
          const isActive = path === activeFile;
          return (
            <div
              key={path}
              role="tab"
              aria-selected={isActive}
              title={path}
              draggable
              className={`${styles.tab} ${isActive ? styles.active : ''} ${dragging === path ? styles.tabDragging : ''}`}
              onClick={() => {
                // A tab click means "show me this file", so a comparison over it closes.
                if (diffShown) setDiff(null);
                actions.activate(path);
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                void actions.closePath(path);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, path });
              }}
              onDragStart={(event) => {
                setDragging(path);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', path);
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null && dragging !== path) {
                  dispatch({ type: 'MOVE_TAB', payload: { path: dragging, toIndex: index } });
                }
                setDragging(null);
              }}
            >
              <div className={styles.tabIcon}>
                {entry.language === 'plaintext' ? <File size={14} /> : <FileCode size={14} />}
              </div>
              <span className={entry.deletedOnDisk ? styles.tabDeletedName : undefined}>{entry.name}</span>
              {entry.deletedOnDisk ? (
                <span className={styles.tabConflict} title="Deleted on disk. Save to recreate it.">
                  <AlertTriangle size={12} />
                </span>
              ) : entry.conflict ? (
                <span
                  className={styles.tabConflict}
                  title={entry.conflict.source === 'disk' ? 'Changed on disk' : 'Changed on disk by the engine'}
                >
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
                title="Close (Ctrl+W)"
                onClick={(event) => {
                  event.stopPropagation();
                  void actions.closePath(path);
                }}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {menu !== null && <ContextMenu x={menu.x} y={menu.y} items={tabMenu(menu.path)} onClose={() => setMenu(null)} label="Tab actions" />}

      {active && (
        <nav className={styles.breadcrumb} aria-label="File path">
          {[basename(projectRoot), ...pathSegments(projectRoot, active.path)].map((part, index, all) => {
            const isFile = index === all.length - 1;
            // The folder this segment names: the project root, then one level per segment.
            const folder = [canonicalPath(projectRoot), ...all.slice(1, index + 1)].join('/');
            return (
              <span key={`${part}-${index}`} className={styles.breadcrumbRow}>
                {index > 0 && <ChevronRight size={12} />}
                {isFile ? (
                  <span className={styles.breadcrumbItem} style={{ color: 'var(--text-primary)' }} aria-current="page">
                    {part}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`${styles.breadcrumbItem} ${styles.breadcrumbLink}`}
                    title={`Show ${part} in the Explorer`}
                    onClick={() => {
                      dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'explorer' });
                      window.dispatchEvent(new CustomEvent('sketch:reveal-in-explorer', { detail: { path: folder } }));
                    }}
                  >
                    {part}
                  </button>
                )}
              </span>
            );
          })}
          <span className={styles.breadcrumbActions}>
            {activeDiffKind !== null && (
              <button
                type="button"
                className={styles.previewToggle}
                aria-label="Compare changes"
                aria-pressed={diffShown && diff?.path === active.path}
                onClick={() => {
                  if (diffShown && diff?.path === active.path) setDiff(null);
                  else requestDiff({ path: active.path, kind: activeDiffKind });
                }}
                title={
                  diffShown && diff?.path === active.path
                    ? 'Back to the file'
                    : activeDiffKind === 'staged'
                      ? 'Compare the staged version with the last commit'
                      : 'Compare your edits with the last staged or committed version'
                }
              >
                <Diff size={12} />
                Changes
              </button>
            )}
            {isMarkdown && !diffShown && (
              <button
                type="button"
                className={styles.previewToggle}
                aria-pressed={showPreview}
                onClick={() =>
                  setPreviewing((prev) => {
                    const next = new Set(prev);
                    if (next.has(active.path)) next.delete(active.path);
                    else next.add(active.path);
                    return next;
                  })
                }
                title={showPreview ? 'Edit the Markdown source' : 'Preview the rendered Markdown'}
              >
                {showPreview ? <Code size={12} /> : <Eye size={12} />}
                {showPreview ? 'Edit' : 'Preview'}
              </button>
            )}
          </span>
        </nav>
      )}

      {notice}

      {active?.deletedOnDisk && (
        <div className={styles.conflict} role="alert">
          <AlertTriangle size={14} />
          <span className={styles.noticeText}>
            {active.name} was deleted on disk (by a command, a branch switch or another program). Its text
            is still here; saving recreates the file.
          </span>
          <button className={styles.conflictAction} onClick={() => void actions.save(active.path)}>
            Save to recreate
          </button>
          <button className={styles.conflictAction} onClick={() => void actions.closePath(active.path)}>
            Close tab
          </button>
        </div>
      )}

      {active?.conflict && !active.deletedOnDisk && (
        <div className={styles.conflict} role="alert">
          <AlertTriangle size={14} />
          <span className={styles.noticeText}>
            {active.conflict.source === 'disk'
              ? `${active.name} changed on disk while you had unsaved edits. Your version is still here and nothing was overwritten.`
              : `The engine wrote ${active.name} on disk while you had unsaved edits. Your version is still here and nothing was overwritten.`}
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
        <>
          {diffView}
          {showPreview && (
            <div className={styles.markdownPreview} aria-label="Markdown preview">
              <Markdown text={active.content} headingOffset={0} />
            </div>
          )}
          {/* The editor stays mounted under a preview or a diff so its models and history survive. */}
          <div className={styles.editorStack} style={showPreview || diffShown ? { display: 'none' } : undefined}>
            <CodeEditor
              completionProvider={completionProvider}
              onAgentAction={agentAction}
              onBlurText={autoSave === 'onFocusChange' ? saveDirtyNow : undefined}
              inlineEdit={inlineEditRunner}
            />
          </div>
        </>
      ) : diffView !== null ? (
        diffView
      ) : (
        <div className={styles.emptyEditor}>
          <SketchMark size={40} className={styles.emptyMark} />
          <h1 className={styles.projectTitle}>{basename(projectRoot)}</h1>
          <p>No file is open.</p>
          <div className={styles.shortcutGrid}>
            <button
              type="button"
              className={styles.shortcutItem}
              onClick={() => {
                dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'explorer' });
                requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('sketch:explorer-new', { detail: { kind: 'file' } })));
              }}
            >
              <File size={12} /> New file
            </button>
            <kbd>Ctrl+N</kbd>

            <button type="button" className={styles.shortcutItem} onClick={() => dispatch({ type: 'OPEN_PALETTE', payload: 'files' })}>
              <Search size={12} /> Go to file
            </button>
            <kbd>Ctrl+P</kbd>

            <button
              type="button"
              className={styles.shortcutItem}
              onClick={() => {
                dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'search' });
                requestAnimationFrame(() => window.dispatchEvent(new Event('sketch:focus-search')));
              }}
            >
              <Search size={12} /> Search in files
            </button>
            <kbd>Ctrl+Shift+F</kbd>

            <button
              type="button"
              className={styles.shortcutItem}
              onClick={() => {
                dispatch({ type: 'SHOW_BOTTOM_PANEL', payload: 'terminal' });
                requestAnimationFrame(() => window.dispatchEvent(new Event('sketch:focus-terminal')));
              }}
            >
              <TerminalIcon size={12} /> Terminal
            </button>
            <kbd>Ctrl+`</kbd>

            <button type="button" className={styles.shortcutItem} onClick={() => dispatch({ type: 'OPEN_PALETTE', payload: 'commands' })}>
              <Code size={12} /> All commands
            </button>
            <kbd>Ctrl+Shift+P</kbd>

            <button type="button" className={styles.shortcutItem} onClick={() => dispatch({ type: 'FOCUS_COMPOSER' })}>
              <Code size={12} /> Ask the agent
            </button>
            <kbd>Ctrl+L</kbd>
          </div>
        </div>
      )}
    </div>
  );
}
