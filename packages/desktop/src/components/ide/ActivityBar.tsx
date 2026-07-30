import styles from './ActivityBar.module.css';
import { Files, Search, GitBranch, GitPullRequest, Play, Puzzle, Settings, Server, Activity, MessageSquare } from '../Icons';
import { useAppState, useAppDispatch, type AppState } from '../../state/AppState';

type PanelId = NonNullable<AppState['ideActivePanel']>;

interface ActivityItem {
  id: PanelId;
  icon: typeof Files;
  label: string;
  badge?: number;
}

export default function ActivityBar() {
  const { ideActivePanel, mcpToolsStatus } = useAppState();
  const dispatch = useAppDispatch();

  // The cast is gone: `ideActivePanel` now includes null, which is what a toggle
  // off has always dispatched.
  const handleToggle = (panel: PanelId) => {
    dispatch({
      type: 'SET_ACTIVE_PANEL',
      payload: ideActivePanel === panel ? null : panel
    });
  };

  const items: ActivityItem[] = [
    { id: 'explorer', icon: Files, label: 'Explorer' },
    { id: 'search', icon: Search, label: 'Search' },
    { id: 'git', icon: GitBranch, label: 'Source Control' },
    { id: 'review', icon: GitPullRequest, label: 'Diff Review' },
    { id: 'timeline', icon: Activity, label: 'Timeline' },
    { id: 'console', icon: MessageSquare, label: 'Agent Console' },
    { id: 'run', icon: Play, label: 'Run & Debug' },
    { id: 'skills', icon: Puzzle, label: 'Extensions & Skills' },
    { id: 'mcp', icon: Server, label: 'MCP Tools', badge: mcpToolsStatus.connected }
  ];

  return (
    <div className={styles.activityBar}>
      <div className={styles.topItems}>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={`${styles.iconButton} ${ideActivePanel === item.id ? styles.active : ''}`}
              onClick={() => handleToggle(item.id)}
              title={item.label}
            >
              <div className={styles.iconWrapper}>
                <Icon size={20} />
                {item.badge !== undefined && (
                  <span className={styles.mcpBadge}>{item.badge}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <div className={styles.bottomItems}>
        <button className={styles.iconButton} title="Settings">
          <div className={styles.iconWrapper}>
            <Settings size={20} />
          </div>
        </button>
      </div>
    </div>
  );
}
