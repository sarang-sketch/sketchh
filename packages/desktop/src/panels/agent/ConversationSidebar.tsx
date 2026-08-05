import { useAppState, useAppDispatch } from '../../state/AppState';
import type { AppState } from '../../state/AppState';
import { 
  Plus, Folder, FileText, Clock, Settings, ChevronDown, Activity, MessageSquare
} from '../../components/Icons';
import styles from './ConversationSidebar.module.css';

export const ConversationSidebar: React.FC = () => {
  const state = useAppState();
  const dispatch = useAppDispatch();

  const handleViewSelect = (view: AppState['agentView']) => {
    dispatch({ type: 'SET_AGENT_VIEW', payload: view });
  };

  const handleNewTask = () => {
    dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' });
    dispatch({ type: 'CLEAR_MESSAGES' });
  };

  return (
    <div className={styles.container}>
      {/* New Task Button */}
      <div className={styles.newTaskSection}>
        <button className={styles.newTaskBtn} onClick={handleNewTask}>
          <Plus size={14} />
          <span>New task</span>
        </button>
      </div>

      {/* Navigation Menu */}
      <nav className={styles.menuNav}>
        <button 
          className={`${styles.menuItem} ${state.agentView === 'projects' ? styles.activeMenuItem : ''}`}
          onClick={() => handleViewSelect('projects')}
        >
          <Folder size={15} />
          <span>Projects</span>
        </button>
        
        <button 
          className={`${styles.menuItem} ${state.agentView === 'artifacts' ? styles.activeMenuItem : ''}`}
          onClick={() => handleViewSelect('artifacts')}
        >
          <FileText size={15} />
          <span>Artifacts</span>
        </button>

        <button 
          className={`${styles.menuItem} ${state.agentView === 'scheduled' ? styles.activeMenuItem : ''}`}
          onClick={() => handleViewSelect('scheduled')}
        >
          <Clock size={15} />
          <span>Scheduled</span>
        </button>

        <button 
          className={`${styles.menuItem} ${state.agentView === 'timeline' ? styles.activeMenuItem : ''}`}
          onClick={() => handleViewSelect('timeline')}
        >
          <Activity size={15} />
          <span>Timeline</span>
        </button>

        <button 
          className={`${styles.menuItem} ${state.agentView === 'console' ? styles.activeMenuItem : ''}`}
          onClick={() => handleViewSelect('console')}
        >
          <MessageSquare size={15} />
          <span>Agent Console</span>
        </button>

        <button 
          className={`${styles.menuItem} ${state.agentView === 'customize' ? styles.activeMenuItem : ''}`}
          onClick={() => handleViewSelect('customize')}
        >
          <Settings size={15} />
          <span>Customize</span>
        </button>
      </nav>

      {/* Recents Section */}
      <div className={styles.recentsSection}>
        <div className={styles.recentsHeader}>
          <span>Recents</span>
          <button className={styles.filterBtn} title="Filter">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
          </button>
        </div>

        <div className={styles.recentsList}>
          {state.conversations.map((c) => (
            <div 
              key={c.id} 
              className={`${styles.recentItem} ${c.id === state.activeConversationId ? styles.activeRecent : ''}`}
              onClick={() => dispatch({ type: 'SET_CONVERSATION', payload: c.id })}
            >
              <span className={styles.recentTitle}>{c.title}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom Profile Footer */}
      <div className={styles.bottomFooter}>
        <div className={styles.userBadge}>
          <div className={styles.orangeDot}>S</div>
          <span className={styles.userNameText}>Sketch</span>
          <ChevronDown size={13} className={styles.chevronIcon} />
        </div>
      </div>
    </div>
  );
};

