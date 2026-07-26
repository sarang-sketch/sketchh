import styles from './AgentLayout.module.css';
import { ConversationSidebar } from '../panels/agent/ConversationSidebar';
import { AgentChat } from '../panels/agent/AgentChat';
import { SkillsMarketplace } from '../panels/SkillsMarketplace';
import { FileExplorer } from '../panels/FileExplorer';
import { TaskLog } from '../panels/TaskLog';
import { AgentTimelinePanel } from '../ui/panels/AgentTimeline';
import { AgentConsolePanel } from '../ui/panels/AgentConsole';
import { useAppState } from '../state/AppState';

export const AgentLayout: React.FC = () => {
  const { sidebarCollapsed, agentView } = useAppState();

  const renderMainContent = () => {
    switch (agentView) {
      case 'projects':
        return <FileExplorer />;
      case 'artifacts':
        return <TaskLog />;
      case 'scheduled':
        return <TaskLog />;
      case 'customize':
        return <SkillsMarketplace />;
      case 'timeline':
        return <AgentTimelinePanel />;
      case 'console':
        return <AgentConsolePanel />;
      case 'new_task':
      default:
        return <AgentChat />;
    }
  };

  return (
    <div className={styles.layout}>
      {!sidebarCollapsed && (
        <div className={styles.sidebar}>
          <ConversationSidebar />
        </div>
      )}
      <div className={styles.main}>
        {renderMainContent()}
      </div>
    </div>
  );
};
