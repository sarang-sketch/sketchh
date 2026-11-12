import React, { lazy, Suspense, useEffect, useState } from 'react';
import styles from './SidePanel.module.css';
import { useAppDispatch, useAppState, type AppState } from '../../state/AppState';
import { FileExplorer } from '../../panels/FileExplorer';
import SearchPanel from '../../panels/ide/SearchPanel';
import { GitPanel } from '../../panels/GitPanel';
import { DiffReview } from '../../panels/DiffReview';
import { ResizeHandle } from '../ResizeHandle';
import { X } from '../Icons';

// The common editing tools stay immediate; optional workbenches load on first use.
const LiveArchitecture = lazy(() => import('../../panels/LiveArchitecture').then((m) => ({ default: m.LiveArchitecture })));
const AgentTeamPanel = lazy(() => import('../../panels/agent/AgentTeamPanel').then((m) => ({ default: m.AgentTeamPanel })));
const TeamPanel = lazy(() => import('../../team/TeamPanel').then((m) => ({ default: m.TeamPanel })));
const SkillsMarketplace = lazy(() => import('../../panels/SkillsMarketplace').then((m) => ({ default: m.SkillsMarketplace })));
const AgentTimelinePanel = lazy(() => import('../../ui/panels/AgentTimeline').then((m) => ({ default: m.AgentTimelinePanel })));
const AgentConsolePanel = lazy(() => import('../../ui/panels/AgentConsole').then((m) => ({ default: m.AgentConsolePanel })));
const RunPanel = lazy(() => import('../../panels/ide/RunPanel'));
const ProviderSettings = lazy(() => import('../../panels/ProviderSettings').then((m) => ({ default: m.ProviderSettings })));
const McpTools = lazy(() => import('../../panels/McpTools').then((m) => ({ default: m.McpTools })));
const TestResults = lazy(() => import('../../panels/TestResults').then((m) => ({ default: m.TestResults })));
const CostDashboard = lazy(() => import('../../panels/CostDashboard').then((m) => ({ default: m.CostDashboard })));
const BenchmarksPanel = lazy(() => import('../../panels/BenchmarksPanel').then((m) => ({ default: m.BenchmarksPanel })));
const MemoryPanel = lazy(() => import('../../panels/MemoryPanel').then((m) => ({ default: m.MemoryPanel })));

type PanelId = NonNullable<AppState['ideActivePanel']>;

const SIDE_WIDTH_KEY = 'sketch.layout.sideWidth.v1';
const DEFAULT_SIDE_WIDTH = 280;
const MIN_SIDE_WIDTH = 220;
const MAX_SIDE_WIDTH = 560;

/** Panels whose own header already names them; a second one is noise. */
const OWNS_HEADER = new Set<PanelId>([
  'explorer',
  'architecture',
  'mcp',
  'skills',
  'tests',
  'cost',
  'benchmarks',
  'memory',
  'timeline',
  'console',
  'settings',
]);

function readWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(SIDE_WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_SIDE_WIDTH ? Math.min(MAX_SIDE_WIDTH, value) : DEFAULT_SIDE_WIDTH;
  } catch {
    return DEFAULT_SIDE_WIDTH;
  }
}

export default function SidePanel() {
  const { ideActivePanel, appearance } = useAppState();
  const dispatch = useAppDispatch();
  const [width, setWidth] = useState(readWidth);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDE_WIDTH_KEY, String(width));
    } catch {
      /* not remembered, still applied */
    }
  }, [width]);

  let content: React.ReactNode = null;
  let title = '';

  switch (ideActivePanel) {
    case 'explorer':
      // FileExplorer owns its header, so it can keep the new-file / refresh
      // actions in the same row as the view's name.
      title = 'Explorer';
      content = <FileExplorer />;
      break;
    case 'search':
      title = 'Search';
      content = <SearchPanel />;
      break;
    case 'git':
      title = 'Source Control';
      content = <GitPanel />;
      break;
    case 'review':
      title = 'Diff Review';
      content = <DiffReview />;
      break;
    case 'architecture':
      title = 'Live Architecture';
      content = <LiveArchitecture />;
      break;
    case 'agents':
      // Task 10.4: the three strategies, the thirteen roles, and what grades each one.
      // Reachable at last — the ActivityBar now dispatches this, which it never did.
      title = 'AI Team';
      content = <AgentTeamPanel />;
      break;
    case 'team':
      title = 'Build Team';
      content = <TeamPanel />;
      break;
    case 'skills':
      title = 'Skills';
      content = <SkillsMarketplace />;
      break;
    case 'timeline':
      title = 'Timeline';
      content = <AgentTimelinePanel />;
      break;
    case 'console':
      title = 'Agent Console';
      content = <AgentConsolePanel />;
      break;
    case 'run':
      title = 'Run';
      content = <RunPanel />;
      break;
    case 'settings':
      title = 'Provider Settings';
      content = <ProviderSettings />;
      break;
    case 'mcp':
      // Task 7.3: the curated catalog, what each server costs, and what it is missing.
      // No connection count, because nothing is connected between runs.
      title = 'MCP Tools';
      content = <McpTools />;
      break;
    case 'tests':
      // Task 7.4: the nine-stage contract, resolved on mount and run on request.
      title = 'Test Results';
      content = <TestResults />;
      break;
    case 'cost':
      // Task 8.4: the total, summed from the event log. The one cost source.
      title = 'Cost';
      content = <CostDashboard />;
      break;
    case 'benchmarks':
      title = 'Benchmarks';
      content = <BenchmarksPanel />;
      break;
    case 'memory':
      // Task 9.4: what the project remembers, with validity windows. Retracted rows are
      // shown, not hidden — a history you cannot see is a history you cannot correct.
      title = 'Memory';
      content = <MemoryPanel />;
      break;
    default:
      return null;
  }

  const showHeader = ideActivePanel !== null && !OWNS_HEADER.has(ideActivePanel);

  return (
    <div className={styles.sidePanel} style={{ width }} data-position={appearance.sidebarPosition}>
      {showHeader && (
        <div className={styles.header}>
          <span className={styles.headerTitle}>{title}</span>
          <button
            type="button"
            className={styles.headerClose}
            onClick={() => dispatch({ type: 'SET_ACTIVE_PANEL', payload: null })}
            title="Hide side panel (Ctrl+B)"
            aria-label="Hide side panel"
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div className={styles.content}>
        <Suspense fallback={<div className={styles.loading} role="status">Opening {title.toLowerCase()}…</div>}>{content}</Suspense>
      </div>
      <ResizeHandle
        orientation="vertical"
        size={width}
        min={MIN_SIDE_WIDTH}
        max={MAX_SIDE_WIDTH}
        direction={appearance.sidebarPosition === 'right' ? -1 : 1}
        defaultSize={DEFAULT_SIDE_WIDTH}
        onResize={setWidth}
        label="Resize the side panel"
        className={styles.resizeHandle}
      />
    </div>
  );
}
