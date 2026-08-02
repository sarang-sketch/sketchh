// The activity bar.
//
// ── THE MCP BADGE IS GONE, AND THAT IS THE FIX ──────────────────────────────
//
// This bar used to render `badge: mcpToolsStatus.connected`, whose value came from
// `{ connected: 5, total: 8, warning: true }` hardcoded in `AppState`. Five servers
// were never connected; eight never existed. The number moved for no reason and meant
// nothing.
//
// It is not replaced with a real count, because there is no real count to show. MCP
// servers are started PER RUN and only for the capabilities that run holds — the
// unavailability latch is per-run by definition (Requirement 22.3: unavailable "for the
// remainder of the run"). Between runs nothing is connected, so a number here would be
// a fixture whichever value it held. What a user can know before a run is which servers
// COULD start, and that is a list with reasons, which is a panel and not a badge.
//
// Validates: Requirements 27.1, 27.4, 27.5

import styles from './ActivityBar.module.css';
import { Files, Search, GitBranch, GitPullRequest, Layers, Play, Puzzle, Settings, Server, Activity, MessageSquare, Check } from '../Icons';
import { useAppState, useAppDispatch, type AppState } from '../../state/AppState';

type PanelId = NonNullable<AppState['ideActivePanel']>;

interface ActivityItem {
  id: PanelId;
  icon: typeof Files;
  label: string;
}

export default function ActivityBar() {
  const { ideActivePanel } = useAppState();
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
    { id: 'architecture', icon: Layers, label: 'Live Architecture' },
    { id: 'timeline', icon: Activity, label: 'Timeline' },
    { id: 'console', icon: MessageSquare, label: 'Agent Console' },
    { id: 'run', icon: Play, label: 'Run & Debug' },
    { id: 'tests', icon: Check, label: 'Test Results' },
    { id: 'skills', icon: Puzzle, label: 'Extensions & Skills' },
    { id: 'mcp', icon: Server, label: 'MCP Tools' }
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
              </div>
            </button>
          );
        })}
      </div>
      <div className={styles.bottomItems}>
        {/* Was a dead button. It now opens Provider Settings, which is the only
            settings surface that exists (task 4.1, Requirement 27.4). */}
        <button
          className={`${styles.iconButton} ${ideActivePanel === 'settings' ? styles.active : ''}`}
          onClick={() => handleToggle('settings')}
          title="Provider Settings"
        >
          <div className={styles.iconWrapper}>
            <Settings size={20} />
          </div>
        </button>
      </div>
    </div>
  );
}
