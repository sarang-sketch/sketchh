
import { useAppState } from '../state/AppState';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { AgentLayout } from './AgentLayout';
import { IdeLayout } from './IdeLayout';
import styles from './AppLayout.module.css';

// Engine events no longer arrive here. They arrive on the SketchClient stream and
// are accumulated by SketchClientProvider, which both surfaces read (Req 14.2).
// The previous `onTaskEvent` / `onFileChange` Tauri listeners were dead — nothing
// in Rust ever emitted those events — so they are gone rather than left dangling.

export function AppLayout() {
  const state = useAppState();

  return (
    <div className={styles.root}>
      <TitleBar />

      <main className={styles.main}>
        <div className={`${styles.modeContainer} ${state.mode === 'agent' ? styles.active : ''}`}>
          <AgentLayout />
        </div>
        <div className={`${styles.modeContainer} ${state.mode === 'ide' ? styles.active : ''}`}>
          <IdeLayout />
        </div>
      </main>

      <StatusBar />
    </div>
  );
}
