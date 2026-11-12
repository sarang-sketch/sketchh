// The activity bar.
//
// ── WHY IT IS SPLIT INTO "PRIMARY" AND "MORE" ───────────────────────────────
//
// Every view in the Code surface used to be a permanent icon here — sixteen of
// them, most of them used once a week. At a laptop height the bar became a
// scrolling strip of identical glyphs with no labels, and the two most common
// actions (Explorer, Search) had to be found in the middle of it.
//
// The bar now keeps the five views a code session actually cycles through, plus
// a "More views" menu for the audit surfaces. The menu carries the label beside
// each icon, so a view is discoverable by name instead of by guessing a glyph.
// Nothing was removed: every old button is still here and still dispatches the
// same panel.
//
// ── THE MCP BADGE IS STILL GONE, AND THAT IS THE FIX ─────────────────────────
//
// This bar used to render `badge: mcpToolsStatus.connected`, whose value came from
// `{ connected: 5, total: 8, warning: true }` hardcoded in `AppState`. Five servers
// were never connected; eight never existed. MCP servers are started PER RUN, so a
// number here would be a fixture whichever value it held. What a user can know
// before a run is which servers COULD start, and that is the MCP Tools panel.
//
// Validates: Requirements 27.1, 27.4, 27.5

import { useEffect, useRef, useState } from 'react';

import styles from './ActivityBar.module.css';
import {
  Files,
  Search,
  GitBranch,
  GitPullRequest,
  Layers,
  Play,
  Puzzle,
  Settings,
  Server,
  Activity,
  MessageSquare,
  Check,
  Zap,
  Database,
  Users,
  Clock,
  MoreHorizontal,
  X,
} from '../Icons';
import { useAppState, useAppDispatch, type AppState } from '../../state/AppState';

type PanelId = NonNullable<AppState['ideActivePanel']>;

interface ActivityItem {
  id: PanelId;
  icon: typeof Files;
  label: string;
  /** A sentence shown under the label in the More menu. */
  hint?: string;
}

/** The views a coding session reaches for. */
const PRIMARY: ActivityItem[] = [
  { id: 'explorer', icon: Files, label: 'Explorer' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'git', icon: GitBranch, label: 'Source Control' },
  { id: 'run', icon: Play, label: 'Run' },
  { id: 'skills', icon: Puzzle, label: 'Extensions & Skills' },
];

/**
 * Everything else. These are real surfaces, but a permanent icon for each made
 * the bar unreadable; they live in the More menu with their names beside them.
 */
const SECONDARY: ActivityItem[] = [
  { id: 'review', icon: GitPullRequest, label: 'Diff Review', hint: 'Proposed and uncommitted changes' },
  { id: 'architecture', icon: Layers, label: 'Live Architecture', hint: 'Modules and how they connect' },
  { id: 'timeline', icon: Activity, label: 'Timeline', hint: 'What the engine did, in order' },
  { id: 'console', icon: MessageSquare, label: 'Agent Console', hint: 'Prompts, replies and token use' },
  { id: 'tests', icon: Check, label: 'Test Results', hint: 'The project’s own checks' },
  { id: 'cost', icon: Zap, label: 'Cost', hint: 'Spend, summed from the event log' },
  { id: 'benchmarks', icon: Clock, label: 'Benchmarks', hint: 'Measured runs, including failures' },
  { id: 'memory', icon: Database, label: 'Memory', hint: 'What the project remembers' },
  { id: 'agents', icon: Users, label: 'AI Team', hint: 'Strategies, roles and grading' },
  { id: 'team', icon: Layers, label: 'Build Team', hint: 'Frontend, backend and database chats' },
  { id: 'mcp', icon: Server, label: 'MCP Tools', hint: 'Curated servers and what they need' },
];

export default function ActivityBar() {
  const { ideActivePanel, appearance } = useAppState();
  const dispatch = useAppDispatch();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreWrap = useRef<HTMLDivElement>(null);

  // Clicking anywhere else or pressing Escape closes the menu, like every other
  // popover in the window.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: MouseEvent) => {
      if (moreWrap.current !== null && !moreWrap.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  // A toggle, not an assignment: clicking the active view closes it and gives
  // the editor the width back.
  const toggle = (panel: PanelId) => {
    dispatch({
      type: 'SET_ACTIVE_PANEL',
      payload: ideActivePanel === panel ? null : panel,
    });
    setMoreOpen(false);
  };

  const itemButton = (item: ActivityItem, showLabel: boolean) => {
    const Icon = item.icon;
    const active = ideActivePanel === item.id;
    return (
      <button
        key={item.id}
        type="button"
        className={`${styles.iconButton} ${showLabel ? styles.menuItem : ''} ${active ? styles.active : ''}`}
        onClick={() => toggle(item.id)}
        title={item.label}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        tabIndex={showLabel && !moreOpen ? -1 : undefined}
      >
        <span className={styles.iconWrapper}>
          <Icon size={showLabel ? 16 : 20} aria-hidden="true" />
        </span>
        {/* The label is rendered only while the menu is open: a closed popover
            must not contribute sixteen hidden names, nor their text, to the
            document. The button keeps its title and aria-label. */}
        {showLabel && moreOpen && (
          <span className={styles.menuText}>
            <span className={styles.menuLabel}>{item.label}</span>
            {item.hint !== undefined && <span className={styles.menuHint}>{item.hint}</span>}
          </span>
        )}
      </button>
    );
  };

  const moreActive = SECONDARY.some((item) => item.id === ideActivePanel);

  return (
    <nav className={styles.activityBar} aria-label="Views" data-position={appearance.activityBar} data-edge={appearance.sidebarPosition}>
      <div className={styles.topItems}>
        {PRIMARY.map((item) => itemButton(item, false))}
      </div>

      <div className={styles.bottomItems}>
        <div className={styles.moreWrap} ref={moreWrap}>
          <button
            type="button"
            className={`${styles.iconButton} ${moreActive ? styles.active : ''} ${moreOpen ? styles.open : ''}`}
            onClick={() => setMoreOpen((open) => !open)}
            title="More views"
            aria-label="More views"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
          >
            <span className={styles.iconWrapper}>
              {moreOpen ? <X size={18} aria-hidden="true" /> : <MoreHorizontal size={20} aria-hidden="true" />}
              {moreActive && !moreOpen && <span className={styles.moreDot} aria-hidden="true" />}
            </span>
          </button>

          <div
            className={styles.moreMenu}
            role="menu"
            aria-label="More views"
            hidden={!moreOpen}
          >
            <div className={styles.moreTitle}>More views</div>
            {SECONDARY.map((item) => itemButton(item, true))}
          </div>
        </div>

        {/* Provider Settings is the one settings surface that lives in the Code
            surface; the full app settings open from the title bar or Ctrl+,. */}
        <button
          type="button"
          className={`${styles.iconButton} ${ideActivePanel === 'settings' ? styles.active : ''}`}
          onClick={() => toggle('settings')}
          title="Provider Settings"
          aria-label="Provider Settings"
          aria-current={ideActivePanel === 'settings' ? 'page' : undefined}
        >
          <span className={styles.iconWrapper}>
            <Settings size={20} aria-hidden="true" />
          </span>
        </button>
      </div>
    </nav>
  );
}
