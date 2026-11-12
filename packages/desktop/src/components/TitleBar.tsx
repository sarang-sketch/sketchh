// The title bar.
//
// What it used to have: eight menu names (File, Edit, Selection, View, Go, Run,
// Terminal, Help) that were plain text and did nothing; Settings, Search, Grid View,
// back/forward arrows and "What's new" buttons with no handler; an avatar for an
// account that does not exist. Every control left here does what it says.

import { useEffect, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppState';
import { useFileActions } from '../editor/useFileActions';
import { canonicalPath } from '../editor/paths';
import { runEditorAction } from '../editor/editorBridge';
import { currentScheme } from '../styles/colorTheme';
import { useConfirm } from './ConfirmDialog';
import { askToClose, markCloseConfirmed } from '../lib/windowClose';
import { openExternal } from './Markdown';
import { isTauri } from '../ipc/bridge';
import { Settings, Search, PanelLeft, PanelRight, PanelBottom, Sparkles, Zap, Code, Minus, WindowMaximize, X } from './Icons';
import { WHATS_NEW } from '../whatsNew';
import { SketchMark } from './SketchMark';
import { LayoutMenu } from './LayoutMenu';
import styles from './TitleBar.module.css';

const REPO_URL = 'https://github.com/sarang-sketch/sketch';

interface MenuItem {
  label: string;
  hint?: string;
  run: () => void;
  disabled?: boolean;
  /** Tooltip, e.g. the full path of a recent folder. */
  title?: string;
}

function Menu({ name, items, open, onOpen, onClose }: {
  name: string;
  items: Array<MenuItem | 'separator'>;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <div className={styles.menuWrap}>
      <button
        className={`${styles.menuTrigger} ${open ? styles.menuTriggerOpen : ''}`}
        onClick={() => (open ? onClose() : onOpen())}
        onMouseEnter={(e) => {
          // Moving across the bar with a menu open switches menus, like a native bar.
          if ((e.currentTarget.closest('[data-menubar-open="true"]') as HTMLElement | null) !== null) onOpen();
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {name}
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          {items.map((item, index) =>
            item === 'separator' ? (
              <div key={`s${index}`} className={styles.menuSep} />
            ) : (
              <button
                key={`${index}:${item.label}`}
                role="menuitem"
                className={styles.menuItem}
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  onClose();
                  item.run();
                }}
              >
                <span>{item.label}</span>
                {item.hint && <span className={styles.menuHint}>{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function TitleBar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const fileActions = useFileActions();
  const confirm = useConfirm();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [whatsNew, setWhatsNew] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1400 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /** Below this the seven menu names do not fit beside the window controls. */
  const compactMenus = width < 1320;

  const isIde = state.mode === 'ide';
  const dirtyCount = state.openFiles.filter((path) => state.files[path]?.isDirty).length;

  useEffect(() => {
    if (openMenu === null && !whatsNew) return;
    const onDown = (event: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
        setWhatsNew(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
        setWhatsNew(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu, whatsNew]);

  const handleModeToggle = (mode: 'agent' | 'ide') => {
    dispatch({ type: 'SET_MODE', payload: mode });
  };

  const showPanel = (panel: NonNullable<typeof state.ideActivePanel>) => {
    // Panels are hidden in focus mode. Choosing one is a request to see it, so
    // leave focus mode first instead of changing a panel the user cannot see.
    if (state.focusMode) dispatch({ type: 'TOGGLE_FOCUS_MODE' });
    dispatch({ type: 'SET_MODE', payload: 'ide' });
    dispatch({ type: 'SET_ACTIVE_PANEL', payload: panel });
  };

  // The same rule for the title-bar toggles that LayoutMenu already follows:
  // exit focus mode, and only toggle a panel that was hidden when doing so.
  const togglePanel = (action: Parameters<typeof dispatch>[0], visible: boolean) => {
    if (state.focusMode) {
      dispatch({ type: 'TOGGLE_FOCUS_MODE' });
      if (!visible) dispatch(action);
    } else dispatch(action);
  };

  const renderModePill = () => (
    <div className={styles.headerModePill}>
      <div
        className={styles.headerModeBg}
        style={{ transform: state.mode === 'agent' ? 'translateX(0)' : 'translateX(100%)' }}
      />
      <button
        type="button"
        className={`${styles.headerModeBtn} ${state.mode === 'agent' ? styles.activeHeaderMode : ''}`}
        aria-pressed={state.mode === 'agent'}
        aria-label="Cowork"
        onClick={() => handleModeToggle('agent')}
      >
        <Zap size={12} />
        <span>Cowork</span>
      </button>
      <button
        type="button"
        className={`${styles.headerModeBtn} ${state.mode === 'ide' ? styles.activeHeaderMode : ''}`}
        aria-pressed={state.mode === 'ide'}
        aria-label="Code"
        onClick={() => handleModeToggle('ide')}
      >
        <Code size={12} />
        <span>Code</span>
      </button>
    </div>
  );

  const windowCall = async (op: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      if (op === 'close') {
        // Unsaved edits are never thrown away by the close button.
        const dirty = state.openFiles.filter((p) => state.files[p]?.isDirty).map((p) => state.files[p]!.name);
        if (!(await askToClose(dirty, confirm, () => fileActions.saveAll()))) return;
        // The close request this sends is already answered; it must not ask again.
        markCloseConfirmed();
      }
      // The window API exists only in the packaged app. In the Vite dev preview there
      // is no Tauri runtime, so calling getCurrentWindow() throws a TypeError that
      // dirties the console (B-008). Guard it: the unsaved-work prompt above still runs
      // so the behaviour is visible in dev, but the no-op window call is skipped.
      if (!isTauri()) return;
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      if (op === 'minimize') await win.minimize();
      else if (op === 'toggleMaximize') await win.toggleMaximize();
      else await win.close();
    } catch (err) {
      console.error(`Failed to ${op}:`, err);
    }
  };

  const toggleSide = () => isIde
    ? togglePanel({ type: 'TOGGLE_IDE_SIDE_PANEL' }, state.ideActivePanel !== null)
    : togglePanel({ type: 'TOGGLE_SIDEBAR' }, !state.sidebarCollapsed);
  const editorAction = (id: string) => () => {
    if (!runEditorAction(id)) {
      dispatch({ type: 'SET_EDITOR_NOTICE', payload: { level: 'info', message: 'Open a file first: that command works on the file in the editor.' } });
    }
  };
  const hasFile = state.activeFile !== null;
  const hasRoot = state.projectRoot !== null;
  const newEntry = (kind: 'file' | 'folder') => () => {
    showPanel('explorer');
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('sketch:explorer-new', { detail: { kind } })));
  };
  // File → Open Recent: the folders this user actually opened, newest first, minus this one.
  const recent = state.workspaces
    .filter((ws) => state.projectRoot === null || canonicalPath(ws.path) !== state.projectRoot)
    .slice(0, 6);
  const recentMenu: Array<MenuItem | 'separator'> =
    recent.length === 0
      ? []
      : [
          'separator',
          { label: 'Open Recent', disabled: true, run: () => {} },
          ...recent.map((ws) => ({
            label: ws.name,
            title: ws.path,
            run: () => {
              dispatch({ type: 'SET_MODE', payload: 'ide' });
              void fileActions.openFolderPath(ws.path);
            },
          })),
        ];

  const renderWindowControls = () => (
    <div className={styles.windowControls}>
      <button type="button" className={styles.winBtn} title="Minimize" aria-label="Minimize" onClick={(e) => { e.stopPropagation(); void windowCall('minimize'); }}>
        <Minus size={12} />
      </button>
      <button type="button" className={styles.winBtn} title="Maximize" aria-label="Maximize" onClick={(e) => { e.stopPropagation(); void windowCall('toggleMaximize'); }}>
        <WindowMaximize size={10} />
      </button>
      <button type="button" className={styles.winBtnClose} title="Close" aria-label="Close window" onClick={(e) => { e.stopPropagation(); void windowCall('close'); }}>
        <X size={12} />
      </button>
    </div>
  );

  const menus: Record<string, Array<MenuItem | 'separator'>> = {
    File: [
      { label: 'New File…', hint: 'Ctrl+N', run: newEntry('file'), disabled: !hasRoot },
      { label: 'New Folder…', run: newEntry('folder'), disabled: !hasRoot },
      'separator',
      { label: 'Open Folder…', hint: 'Ctrl+O', run: () => void fileActions.openFolder() },
      { label: 'Clone Repository…', run: () => { dispatch({ type: 'SET_MODE', payload: 'ide' }); window.dispatchEvent(new CustomEvent('sketch:clone')); } },
      ...recentMenu,
      'separator',
      { label: 'Save', hint: 'Ctrl+S', run: () => void fileActions.save(), disabled: !hasFile },
      { label: 'Save All', hint: 'Ctrl+Alt+S', run: () => void fileActions.saveAll(), disabled: !state.openFiles.some((p) => state.files[p]?.isDirty) },
      {
        label: `Auto Save${state.editorSettings.autoSave === 'off' ? '' : ' ✓'}`,
        run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { autoSave: state.editorSettings.autoSave === 'off' ? 'afterDelay' : 'off' } }),
      },
      'separator',
      { label: 'Close Editor', hint: 'Ctrl+W', run: () => { if (state.activeFile) void fileActions.closePath(state.activeFile); }, disabled: !hasFile },
      { label: 'Close All Editors', run: () => void fileActions.closeMany(state.openFiles), disabled: state.openFiles.length === 0 },
      'separator',
      { label: 'Settings', hint: 'Ctrl+,', run: () => dispatch({ type: 'OPEN_SETTINGS' }) },
    ],
    Edit: [
      { label: 'Undo', hint: 'Ctrl+Z', run: editorAction('undo'), disabled: !hasFile },
      { label: 'Redo', hint: 'Ctrl+Y', run: editorAction('redo'), disabled: !hasFile },
      'separator',
      { label: 'Find', hint: 'Ctrl+F', run: editorAction('actions.find'), disabled: !hasFile },
      { label: 'Replace', hint: 'Ctrl+H', run: editorAction('editor.action.startFindReplaceAction'), disabled: !hasFile },
      { label: 'Find in Files', hint: 'Ctrl+Shift+F', run: () => { showPanel('search'); requestAnimationFrame(() => window.dispatchEvent(new Event('sketch:focus-search'))); } },
      { label: 'Replace in Files', hint: 'Ctrl+Shift+H', run: () => { showPanel('search'); requestAnimationFrame(() => window.dispatchEvent(new Event('sketch:focus-replace'))); } },
      'separator',
      { label: 'Toggle Line Comment', hint: 'Ctrl+/', run: editorAction('editor.action.commentLine'), disabled: !hasFile },
      { label: 'Format Document', hint: 'Shift+Alt+F', run: editorAction('editor.action.formatDocument'), disabled: !hasFile },
      'separator',
      { label: 'Edit with AI…', hint: 'Ctrl+K', run: editorAction('sketch.inlineEdit'), disabled: !hasFile },
      { label: 'Revert Change at Cursor', run: editorAction('sketch.git.revertChange'), disabled: !hasFile },
    ],
    View: [
      { label: 'Command Palette…', hint: 'Ctrl+Shift+P', run: () => dispatch({ type: 'OPEN_PALETTE', payload: 'commands' }) },
      'separator',
      { label: 'Explorer', hint: 'Ctrl+Shift+E', run: () => showPanel('explorer') },
      { label: 'Search', hint: 'Ctrl+Shift+F', run: () => showPanel('search') },
      { label: 'Source Control', hint: 'Ctrl+Shift+G', run: () => showPanel('git') },
      { label: 'Run', run: () => showPanel('run') },
      { label: 'Diff Review', run: () => showPanel('review') },
      { label: 'Problems', hint: 'Ctrl+Shift+M', run: () => { if (state.focusMode) dispatch({ type: 'TOGGLE_FOCUS_MODE' }); dispatch({ type: 'SET_MODE', payload: 'ide' }); dispatch({ type: 'SHOW_BOTTOM_PANEL', payload: 'problems' }); } },
      'separator',
      { label: 'Toggle Side Bar', hint: 'Ctrl+B', run: toggleSide },
      { label: 'Toggle Panel', hint: 'Ctrl+J', run: () => togglePanel({ type: 'TOGGLE_BOTTOM_PANEL' }, state.bottomPanelOpen) },
      { label: 'Toggle Agent Chat', run: () => togglePanel({ type: 'TOGGLE_RIGHT_PANEL' }, !state.rightPanelCollapsed) },
      'separator',
      { label: `Word Wrap${state.editorSettings.wordWrap ? ' ✓' : ''}`, hint: 'Alt+Z', run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { wordWrap: !state.editorSettings.wordWrap } }) },
      { label: `Minimap${state.editorSettings.minimap ? ' ✓' : ''}`, run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { minimap: !state.editorSettings.minimap } }) },
      { label: 'Zoom In', hint: 'Ctrl+=', run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { fontSize: state.editorSettings.fontSize + 1 } }) },
      { label: 'Zoom Out', hint: 'Ctrl+-', run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { fontSize: state.editorSettings.fontSize - 1 } }) },
      'separator',
      {
        label: state.editorSettings.colorTheme === 'light' || (state.editorSettings.colorTheme === 'system' && currentScheme() === 'light') ? 'Dark Theme' : 'Light Theme',
        run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { colorTheme: currentScheme() === 'light' ? 'dark' : 'light' } }),
      },
    ],
    Go: [
      { label: 'Go to File…', hint: 'Ctrl+P', run: () => dispatch({ type: 'OPEN_PALETTE', payload: 'files' }) },
      { label: 'Go to Line…', hint: 'Ctrl+G', run: editorAction('editor.action.gotoLine'), disabled: !hasFile },
      { label: 'Go to Symbol in File…', hint: 'Ctrl+Shift+O', run: editorAction('editor.action.quickOutline'), disabled: !hasFile },
      { label: 'Go to Definition', hint: 'F12', run: editorAction('editor.action.revealDefinition'), disabled: !hasFile },
      'separator',
      { label: 'Next Problem', hint: 'F8', run: editorAction('editor.action.marker.next'), disabled: !hasFile },
      { label: 'Previous Problem', hint: 'Shift+F8', run: editorAction('editor.action.marker.prev'), disabled: !hasFile },
      { label: 'Next Change', hint: 'Alt+F5', run: editorAction('sketch.git.nextChange'), disabled: !hasFile },
      { label: 'Previous Change', hint: 'Shift+Alt+F5', run: editorAction('sketch.git.previousChange'), disabled: !hasFile },
    ],
    Run: [
      { label: 'Run a Script…', hint: 'F5', run: () => showPanel('run') },
      { label: 'Run Checks (tests, lint, build)', run: () => showPanel('tests') },
    ],
    Terminal: [
      { label: 'New Terminal', hint: 'Ctrl+Shift+`', run: () => { dispatch({ type: 'SET_MODE', payload: 'ide' }); dispatch({ type: 'TERMINAL_NEW' }); } },
      { label: 'Toggle Terminal', hint: 'Ctrl+`', run: () => { dispatch({ type: 'SET_MODE', payload: 'ide' }); dispatch({ type: 'SHOW_BOTTOM_PANEL', payload: 'terminal' }); } },
    ],
    Help: [
      { label: 'Keyboard Shortcuts', run: () => dispatch({ type: 'OPEN_SETTINGS', payload: 'shortcuts' }) },
      { label: 'Connect a Model…', run: () => dispatch({ type: 'OPEN_CONNECT' }) },
      'separator',
      { label: 'Source Code', run: () => void openExternal(REPO_URL) },
      { label: 'Report a Problem', run: () => void openExternal(`${REPO_URL}/issues/new/choose`) },
    ],
  };

  return (
    <div ref={barRef} className={`${styles.titleBar} ${isIde ? styles.ideTitleBar : styles.agentTitleBar}`} data-tauri-drag-region>
      {isIde ? (
        <>
          <div className={styles.left}>
            <button className={styles.topIconBtn} title="Toggle Side Bar (Ctrl+B)" onClick={() => togglePanel({ type: 'TOGGLE_IDE_SIDE_PANEL' }, state.ideActivePanel !== null)}>
              <PanelLeft size={14} />
            </button>
            <SketchMark size={23} />
            {renderModePill()}
            <nav className={styles.menuNav} data-menubar-open={openMenu !== null ? 'true' : 'false'}>
              {compactMenus ? (
                // A narrow window: the seven menus become one, grouped by their names.
                <Menu
                  name="Menu"
                  items={Object.entries(menus).flatMap(([name, items], index) => [
                    ...(index > 0 ? ['separator' as const] : []),
                    ...items.map((item) => (item === 'separator' ? item : { ...item, label: `${name}: ${item.label}` })),
                  ])}
                  open={openMenu === 'Menu'}
                  onOpen={() => setOpenMenu('Menu')}
                  onClose={() => setOpenMenu(null)}
                />
              ) : (
                Object.entries(menus).map(([name, items]) => (
                  <Menu
                    key={name}
                    name={name}
                    items={items}
                    open={openMenu === name}
                    onOpen={() => setOpenMenu(name)}
                    onClose={() => setOpenMenu(null)}
                  />
                ))
              )}
            </nav>
          </div>

          <div className={styles.center} data-tauri-drag-region>
            <button type="button" className={styles.commandBar} title="Go to file (Ctrl+P)" aria-label="Search project files" onClick={() => dispatch({ type: 'OPEN_PALETTE', payload: 'files' })}>
              <Search size={13} />
              <span className={styles.ideTitleName}>
                {state.projectRoot ? state.projectRoot.split(/[/\\]/).filter(Boolean).pop() : 'Search your workspace'}
              </span>
              {dirtyCount > 0 && (
                <span
                  className={styles.dirtyDot}
                  role="img"
                  title={`${dirtyCount} unsaved file${dirtyCount === 1 ? '' : 's'}`}
                  aria-label={`${dirtyCount} unsaved file${dirtyCount === 1 ? '' : 's'}`}
                />
              )}
              <kbd>Ctrl P</kbd>
            </button>
          </div>

          <div className={styles.right}>
            {state.focusMode && <button className={styles.focusExit} onClick={() => dispatch({ type: 'TOGGLE_FOCUS_MODE' })}>Exit focus</button>}
            <LayoutMenu />
            <button className={styles.topIconBtn} title="Toggle Terminal" onClick={() => togglePanel({ type: 'TOGGLE_BOTTOM_PANEL' }, state.bottomPanelOpen)}>
              <PanelBottom size={14} />
            </button>
            <button className={styles.topIconBtn} title="Toggle Agent Chat" onClick={() => togglePanel({ type: 'TOGGLE_RIGHT_PANEL' }, !state.rightPanelCollapsed)}>
              <PanelRight size={14} />
            </button>
            <button className={styles.topIconBtn} title="Search in files" onClick={() => showPanel('search')}>
              <Search size={14} />
            </button>
            <button className={styles.topIconBtn} title="Settings (Ctrl+,)" onClick={() => dispatch({ type: 'OPEN_SETTINGS' })}>
              <Settings size={14} />
            </button>
            {renderWindowControls()}
          </div>
        </>
      ) : (
        <>
          <div className={styles.leftCowork}>
            <button className={styles.navIconBtn} onClick={() => togglePanel({ type: 'TOGGLE_SIDEBAR' }, !state.sidebarCollapsed)} title="Toggle Sidebar">
              <PanelLeft size={14} />
            </button>
            <SketchMark size={24} />
            <span className={styles.brandName}>sketch</span>
            {renderModePill()}
          </div>

          <div className={styles.center} data-tauri-drag-region>
            <button type="button" className={styles.commandBar} aria-label="Search commands" title="Command palette (Ctrl+Shift+P)" onClick={() => dispatch({ type: 'OPEN_PALETTE', payload: 'commands' })}>
              <Search size={13} /><span>{state.projectRoot ? state.projectRoot.split(/[/\\]/).filter(Boolean).pop() : 'Search or jump to…'}</span><kbd>Ctrl K</kbd>
            </button>
          </div>

          <div className={styles.rightCowork}>
            {state.focusMode && <button className={styles.focusExit} onClick={() => dispatch({ type: 'TOGGLE_FOCUS_MODE' })}>Exit focus</button>}
            <LayoutMenu />
            <div className={styles.menuWrap}>
              <button className={styles.whatsNewBtn} onClick={() => setWhatsNew(!whatsNew)} aria-expanded={whatsNew}>
                <Sparkles size={13} />
                <span>What's new</span>
              </button>
              {whatsNew && (
                <div className={`${styles.menu} ${styles.whatsNewPanel}`} role="dialog" aria-label="What's new">
                  <div className={styles.whatsNewTitle}>In this version</div>
                  <ul className={styles.whatsNewList}>
                    {WHATS_NEW.map((entry) => (
                      <li key={entry.text}>{entry.text}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <button className={styles.navIconBtn} title="Settings (Ctrl+,)" onClick={() => dispatch({ type: 'OPEN_SETTINGS' })}>
              <Settings size={14} />
            </button>
            {renderWindowControls()}
          </div>
        </>
      )}
    </div>
  );
}
