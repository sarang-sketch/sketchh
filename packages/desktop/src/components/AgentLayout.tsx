// The Cowork surface: conversations on the left, the chosen view on the right.
//
// On a narrow window the conversation list floats over the chat instead of squeezing
// it, and closes itself when the window gets narrow, so the chat stays usable at any
// size — the same rule the Code surface follows (IdeLayout.tsx).

import { lazy, Suspense, useEffect, useRef } from 'react';

import styles from './AgentLayout.module.css';
import { ConversationSidebar } from '../panels/agent/ConversationSidebar';
import { AgentChat } from '../panels/agent/AgentChat';
import { useAppDispatch, useAppState } from '../state/AppState';
import { useWindowWidth } from '../lib/useWindowWidth';
import { ResizeHandle } from './ResizeHandle';

const CoworkProjects = lazy(() => import('../panels/agent/CoworkProjects').then((m) => ({ default: m.CoworkProjects })));
const WorkflowLibrary = lazy(() => import('../panels/agent/WorkflowLibrary').then((m) => ({ default: m.WorkflowLibrary })));
const SkillsMarketplace = lazy(() => import('../panels/SkillsMarketplace').then((m) => ({ default: m.SkillsMarketplace })));
const TaskLog = lazy(() => import('../panels/TaskLog').then((m) => ({ default: m.TaskLog })));
const AgentTimelinePanel = lazy(() => import('../ui/panels/AgentTimeline').then((m) => ({ default: m.AgentTimelinePanel })));
const AgentConsolePanel = lazy(() => import('../ui/panels/AgentConsole').then((m) => ({ default: m.AgentConsolePanel })));
const McpTools = lazy(() => import('../panels/McpTools').then((m) => ({ default: m.McpTools })));
const MemoryPanel = lazy(() => import('../panels/MemoryPanel').then((m) => ({ default: m.MemoryPanel })));

/** Below this width the conversation list floats over the chat. */
export const NARROW_COWORK_PX = 760;

export const AgentLayout: React.FC = () => {
  const { sidebarCollapsed, agentView, appearance, focusMode } = useAppState();
  const dispatch = useAppDispatch();
  const narrow = useWindowWidth() < NARROW_COWORK_PX;

  // Becoming narrow closes the list once; opening it again while narrow floats it.
  const wasNarrow = useRef(false);
  useEffect(() => {
    if (narrow && !wasNarrow.current && !sidebarCollapsed) dispatch({ type: 'TOGGLE_SIDEBAR' });
    wasNarrow.current = narrow;
    // Only the transition matters, not every toggle the user makes afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);

  const renderMainContent = () => {
    switch (agentView) {
      case 'projects':
        return <CoworkProjects />;
      case 'workflows':
        return <WorkflowLibrary />;
      case 'tools':
        return <McpTools />;
      case 'memory':
        return <MemoryPanel />;
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
    <div className={styles.layout} data-narrow={narrow ? 'true' : 'false'} data-sidebar={appearance.sidebarPosition}>
      {!sidebarCollapsed && !focusMode && (
        <div className={`${styles.sidebar} ${narrow ? styles.sidebarFloating : ''}`}>
          <ConversationSidebar />
          {!narrow && <ResizeHandle orientation="vertical" size={appearance.sidebarWidth} min={200} max={360} direction={appearance.sidebarPosition === 'left' ? 1 : -1} defaultSize={244} onResize={(sidebarWidth) => dispatch({ type: 'SET_APPEARANCE', payload: { sidebarWidth } })} label="Resize the conversation sidebar" className={styles.resizeHandle} />}
        </div>
      )}
      {narrow && !sidebarCollapsed && !focusMode && (
        <button
          type="button"
          className={styles.scrim}
          aria-label="Close the conversation list"
          onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
        />
      )}
      <div className={styles.main}>
        <Suspense fallback={<div className={styles.loading} role="status">Opening workspace…</div>}>{renderMainContent()}</Suspense>
      </div>
    </div>
  );
};
