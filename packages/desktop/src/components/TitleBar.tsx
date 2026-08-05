import { useAppState, useAppDispatch } from '../state/AppState';
import { Settings, Search, Layout, PanelLeft, PanelRight, PanelBottom, User, Sparkles, Zap, Code } from './Icons';
import styles from './TitleBar.module.css';

export function TitleBar() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  const isIde = state.mode === 'ide';

  const handleModeToggle = (mode: 'agent' | 'ide') => {
    dispatch({ type: 'SET_MODE', payload: mode });
  };

  const renderModePill = () => (
    <div className={styles.headerModePill}>
      <div 
        className={styles.headerModeBg} 
        style={{ transform: state.mode === 'agent' ? 'translateX(0)' : 'translateX(100%)' }}
      />
      <button 
        className={`${styles.headerModeBtn} ${state.mode === 'agent' ? styles.activeHeaderMode : ''}`}
        onClick={() => handleModeToggle('agent')}
      >
        <Zap size={12} />
        <span>Cowork</span>
      </button>
      <button 
        className={`${styles.headerModeBtn} ${state.mode === 'ide' ? styles.activeHeaderMode : ''}`}
        onClick={() => handleModeToggle('ide')}
      >
        <Code size={12} />
        <span>Code</span>
      </button>
    </div>
  );

  const handleMinimize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error('Failed to minimize:', err);
    }
  };

  const handleMaximize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      console.error('Failed to maximize:', err);
    }
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch (err) {
      console.error('Failed to close:', err);
    }
  };

  const renderWindowControls = () => (
    <div className={styles.windowControls}>
      <button className={styles.winBtn} title="Minimize" onClick={handleMinimize}>—</button>
      <button className={styles.winBtn} title="Maximize" onClick={handleMaximize}>☐</button>
      <button className={styles.winBtnClose} title="Close" onClick={handleClose}>✕</button>
    </div>
  );

  return (
    <div className={`${styles.titleBar} ${isIde ? styles.ideTitleBar : styles.agentTitleBar}`} data-tauri-drag-region>
      {isIde ? (
        <>
          {/* Sketch IDE Top Bar */}
          <div className={styles.left}>
            <button className={styles.topIconBtn} title="Toggle Side Panel" onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}>
              <PanelLeft size={14} />
            </button>
            <div className={styles.sketchLogo}>S</div>
            {renderModePill()}
            <nav className={styles.menuNav}>
              <span>File</span>
              <span>Edit</span>
              <span>Selection</span>
              <span>View</span>
              <span>Go</span>
              <span>Run</span>
              <span>Terminal</span>
              <span>Help</span>
            </nav>
          </div>

          <div className={styles.center}>
            <span className={styles.ideTitle}>Sketch IDE</span>
          </div>

          <div className={styles.right}>
            <button className={styles.topIconBtn} title="Toggle Bottom Panel" onClick={() => dispatch({ type: 'TOGGLE_BOTTOM_PANEL' })}>
              <PanelBottom size={14} />
            </button>
            <button className={styles.topIconBtn} title="Toggle Chat Panel" onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}>
              <PanelRight size={14} />
            </button>
            <button className={styles.topIconBtn} title="Search">
              <Search size={14} />
            </button>
            <button className={styles.topIconBtn} title="Settings">
              <Settings size={14} />
            </button>
            <div className={styles.avatarMini}>
              <User size={12} />
            </div>
            
            {/* Window controls */}
            {renderWindowControls()}
          </div>
        </>
      ) : (
        <>
          {/* Sketch Cowork Header Top Bar */}
          <div className={styles.leftCowork}>
            <button className={styles.navIconBtn} onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })} title="Toggle Sidebar">
              <PanelLeft size={14} />
            </button>
            <button className={styles.navIconBtn} title="Grid View">
              <Layout size={14} />
            </button>
            <button className={styles.navIconBtn} title="Search">
              <Search size={14} />
            </button>
            <div className={styles.navArrows}>
              <span className={styles.arrowBtn}>‹</span>
              <span className={styles.arrowBtn}>›</span>
            </div>
            {renderModePill()}
          </div>

          <div className={styles.center}>
            <span className={styles.coworkTitle}>
              {state.projectRoot ? state.projectRoot.split(/[/\\]/).pop() : 'Sketch'}
            </span>
          </div>

          <div className={styles.rightCowork}>
            <button className={styles.whatsNewBtn}>
              <Sparkles size={13} />
              <span>What's new</span>
            </button>
            
            {/* Window controls */}
            {renderWindowControls()}
          </div>
        </>
      )}
    </div>
  );
}

