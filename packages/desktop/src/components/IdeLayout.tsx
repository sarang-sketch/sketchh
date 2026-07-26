
import styles from './IdeLayout.module.css';
import ActivityBar from './ide/ActivityBar';
import SidePanel from './ide/SidePanel';
import EditorArea from './EditorArea';
import IdeChatSidebar from '../panels/ide/IdeChatSidebar';
import Terminal from '../panels/ide/Terminal';
import { useAppState } from '../state/AppState';

export function IdeLayout() {
  const { ideActivePanel, rightPanelCollapsed, bottomPanelOpen } = useAppState();

  return (
    <div className={styles.layout}>
      <ActivityBar />
      {ideActivePanel && <SidePanel />}
      
      <div className={styles.mainContent}>
        <div className={styles.topSection}>
          <div className={styles.editorSection}>
            <EditorArea />
          </div>
          {!rightPanelCollapsed && <IdeChatSidebar />}
        </div>
        
        {bottomPanelOpen && (
          <div className={styles.bottomSection}>
            <Terminal />
          </div>
        )}
      </div>
    </div>
  );
}

export default IdeLayout;
