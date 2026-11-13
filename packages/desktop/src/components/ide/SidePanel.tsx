import React, { lazy, Suspense, useEffect, useState } from 'react';
import styles from './SidePanel.module.css';
import { useAppDispatch, useAppState, type AppState } from '../../state/AppState';
import { FileExplorer } from '../../panels/FileExplorer';
import SearchPanel from '../../panels/ide/SearchPanel';
import { GitPanel } from '../../panels/GitPanel';
import { DiffReview } from '../../panels/DiffReview';
import { ResizeHandle } from '../ResizeHandle';
import { X } from '../Icons';
import { useSketchClient } from '../../lib/ClientProvider';
import { useOptionalTerminalRunner } from '../../terminal/TerminalRunner';
import {
  describeTestResult,
  engineHooksToPanel,
  panelHooksToEngineConfig,
} from '../../panels/hooksAdapter';
import type { HookConfig } from '../../panels/HooksPanel';

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
const ProjectRescue = lazy(() => import('../../panels/ProjectRescue').then((m) => ({ default: m.ProjectRescue })));
const UiDoctor = lazy(() => import('../../panels/UiDoctor').then((m) => ({ default: m.UiDoctor })));
const ApiLab = lazy(() => import('../../panels/ApiLab').then((m) => ({ default: m.ApiLab })));
const HooksPanel = lazy(() => import('../../panels/HooksPanel').then((m) => ({ default: m.HooksPanel })));
const DebuggerPanel = lazy(() => import('../../panels/ide/DebuggerPanel').then((m) => ({ default: m.DebuggerPanel })));
// The host (not the component): it builds the briefing items from the
// conversations, so no briefing module is statically imported by this shell
// — see DailyBriefingHost.tsx for why that matters to the bundle check.
const DailyBriefingHost = lazy(() => import('../../panels/DailyBriefingHost').then((m) => ({ default: m.DailyBriefingHost })));

/**
 * The Hooks panel's data host: loads `.sketch/hooks.json` through the engine,
 * saves through it, and tests through it. Saving is the user's opt-in — it is
 * what turns `agentPrefs.hooksEnabled` on, so a run only loads hooks the user
 * configured here. A rejected save keeps the previous list on screen and
 * shows the engine's reason instead of pretending the edit landed.
 */
function HooksPanelHost() {
  const { projectRoot } = useAppState();
  const dispatch = useAppDispatch();
  const client = useSketchClient();
  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHooks([]);
    setSaveError(null);
    setTestResult(null);
    if (projectRoot === null || client.hooksList === undefined) return;
    client
      .hooksList({ root: projectRoot })
      .then((result) => {
        if (!cancelled) setHooks(engineHooksToPanel(result.hooks));
      })
      .catch(() => {
        if (!cancelled) setSaveError('The hooks file could not be read.');
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, client]);

  if (projectRoot === null) return <p>No project open. Open a folder to configure hooks.</p>;
  if (client.hooksList === undefined) return <p>Hooks need the engine connection.</p>;

  return (
    <HooksPanel
      hooks={hooks}
      saveError={saveError}
      testResult={testResult}
      onSave={(next) => {
        if (client.hooksSave === undefined) return;
        const config = panelHooksToEngineConfig(next);
        client
          .hooksSave({ root: projectRoot, config })
          .then((result) => {
            if (!result.ok) {
              setSaveError(result.problems.join('; '));
              return;
            }
            setHooks(next);
            setSaveError(null);
            dispatch({
              type: 'SET_AGENT_PREFS',
              payload: { hooksEnabled: next.some((hook) => hook.enabled) },
            });
          })
          .catch((err: unknown) => {
            setSaveError(err instanceof Error ? err.message : 'The hooks file could not be saved.');
          });
      }}
      onTest={(hookId) => {
        if (client.hooksTest === undefined) return;
        const hook = hooks.find((candidate) => candidate.id === hookId);
        if (hook === undefined) return;
        // The engine needs a tool name for Pre/PostToolUse tests. A hook with
        // an empty matcher matches every tool, so a sample tool name stands in.
        const tool =
          hook.matcher.trim() !== '' ? hook.matcher.trim() : hook.event === 'PreToolUse' || hook.event === 'PostToolUse' ? 'edit_file' : undefined;
        client
          .hooksTest({ root: projectRoot, event: hook.event, ...(tool !== undefined ? { tool } : {}) })
          .then((result) => setTestResult(describeTestResult(result)))
          .catch((err: unknown) => {
            setTestResult(err instanceof Error ? `Test failed: ${err.message}` : 'Test failed.');
          });
      }}
    />
  );
}

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
  'rescue',
  'ui-doctor',
  'api-lab',
  'hooks',
  'debugger',
  'briefing',
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
  const state = useAppState();
  const { ideActivePanel, appearance } = state;
  const dispatch = useAppDispatch();
  const terminal = useOptionalTerminalRunner();
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
    case 'rescue': {
      // Project Rescue analyses what the window actually has open: the open
      // files with their real contents. It is a partial view of the project,
      // not a whole-tree scan — the engine has no file-contents listing yet.
      const files = Object.values(state.files).map((file) => ({
        path: file.path,
        size: new TextEncoder().encode(file.content).length,
        content: file.content,
      }));
      const dirs = [...new Set(files.map((file) => file.path.split('/').slice(0, -1).join('/')).filter((dir) => dir !== ''))];
      title = 'Project Rescue';
      content = <ProjectRescue files={files} dirs={dirs} />;
      break;
    }
    case 'ui-doctor':
      // Checks the live page (this window) — no props, no data to wire.
      title = 'UI Doctor';
      content = <UiDoctor />;
      break;
    case 'api-lab':
      // Real fetch from this window — no props, no data to wire.
      title = 'API Lab';
      content = <ApiLab />;
      break;
    case 'hooks':
      title = 'Hooks';
      content = <HooksPanelHost />;
      break;
    case 'debugger':
      title = 'Debugger';
      content = (
        <DebuggerPanel
          {...(terminal !== null
            ? {
                onLaunch: (config) => {
                  // Starts a bare Node inspector session in the terminal. No
                  // entry file is chosen yet — the inspector URL the panel
                  // shows is live, but there is no program to step through
                  // until an entry file is wired to this launch.
                  void terminal.run(`node --inspect=${config.inspectPort}`);
                },
              }
            : {})}
        />
      );
      break;
    case 'briefing': {
      title = 'Daily briefing';
      content = <DailyBriefingHost conversations={state.conversations} />;
      break;
    }
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
