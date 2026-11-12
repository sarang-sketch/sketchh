import { lazy, Suspense, useEffect, useState } from 'react';
import { useAppState } from '../state/AppState';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { FolderPathDialog } from './FolderPathDialog';
import styles from './AppLayout.module.css';

const AgentLayout = lazy(() => import('./AgentLayout').then((m) => ({ default: m.AgentLayout })));
const IdeLayout = lazy(() => import('./IdeLayout'));
const SettingsDialog = lazy(() => import('./settings/SettingsDialog').then((m) => ({ default: m.SettingsDialog })));
const ConnectWizard = lazy(() => import('./settings/ConnectWizard').then((m) => ({ default: m.ConnectWizard })));
const CommandPalette = lazy(() => import('./CommandPalette').then((m) => ({ default: m.CommandPalette })));
const CloneDialog = lazy(() => import('./CloneDialog').then((m) => ({ default: m.CloneDialog })));

// Engine events no longer arrive here. They arrive on the SketchClient stream and
// are accumulated by SketchClientProvider, which both surfaces read (Req 14.2).
// The previous `onTaskEvent` / `onFileChange` Tauri listeners were dead — nothing
// in Rust ever emitted those events — so they are gone rather than left dangling.

export function AppLayout() {
  const state = useAppState();
  const [visited, setVisited] = useState({ agent: state.mode === 'agent', ide: state.mode === 'ide' });
  const [cloneOpen, setCloneOpen] = useState(false);
  useEffect(() => {
    const open = () => setCloneOpen(true);
    window.addEventListener('sketch:clone', open);
    return () => window.removeEventListener('sketch:clone', open);
  }, []);
  useEffect(() => {
    setVisited((previous) => previous[state.mode] ? previous : { ...previous, [state.mode]: true });
  }, [state.mode]);

  return (
    <div className={styles.root} data-focus-mode={state.focusMode ? 'true' : 'false'}>
      <TitleBar />

      <main className={styles.main}>
        <div className={`${styles.modeContainer} ${state.mode === 'agent' ? styles.active : ''}`} hidden={state.mode !== 'agent'} inert={state.mode !== 'agent'} aria-hidden={state.mode !== 'agent'}>
          {(visited.agent || state.mode === 'agent') && <Suspense fallback={<div className={styles.loading} role="status">Opening Cowork…</div>}><AgentLayout /></Suspense>}
        </div>
        <div className={`${styles.modeContainer} ${state.mode === 'ide' ? styles.active : ''}`} hidden={state.mode !== 'ide'} inert={state.mode !== 'ide'} aria-hidden={state.mode !== 'ide'}>
          {(visited.ide || state.mode === 'ide') && <Suspense fallback={<div className={styles.loading} role="status">Opening Code…</div>}><IdeLayout /></Suspense>}
        </div>
      </main>

      {state.appearance.showStatusBar && !state.focusMode && <StatusBar />}

      {/* Reachable from both surfaces; each renders nothing while closed. The wizard
          sits above Settings so "Connect a model" can open from inside it. */}
      <Suspense fallback={<div className={styles.loadingOverlay} role="status">Opening…</div>}>
        {state.settingsOpen && <SettingsDialog />}
        {state.connectOpen && <ConnectWizard />}
        {state.paletteOpen !== null && <CommandPalette />}
        {cloneOpen && <CloneDialog open onClose={() => setCloneOpen(false)} />}
      </Suspense>
      <FolderPathDialog />
    </div>
  );
}
