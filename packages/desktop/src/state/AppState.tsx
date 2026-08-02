import React, { createContext, useContext, useReducer, ReactNode, Dispatch } from 'react';
import { basename, canonicalPath, languageForPath } from '../editor/paths';
import type {
  ProviderDescriptor,
  ProviderSettingsEntry,
  ProviderTestCode,
} from '../lib/contracts';

// Common Interfaces

/**
 * A file the editor has open.
 *
 * `content` IS THE AUTHORITATIVE TEXT of that file in this app (Requirement 15.2).
 * Monaco's model is a projection of it, reconciled in exactly one place —
 * `ModelRegistry.sync` — and every non-keystroke change (disk read, engine write,
 * conflict reload) lands here first. Nothing else caches file text: `openFiles`
 * below holds PATHS, not entries, so there is one record per file and not two.
 */
export interface FileEntry {
  /** Canonical absolute path (see editor/paths.ts). Also the key in `files`. */
  path: string;
  name: string;
  content: string;
  language: string;
  /** True when `content` differs from what is on disk. Cleared by a save. */
  isDirty: boolean;
  /**
   * Set when the engine wrote this file while the buffer had unsaved edits. The
   * user's text is kept; the marker makes the divergence visible instead of
   * resolving it silently in either direction (Requirement 15.3).
   */
  conflict?: FileConflict | null;
}

export interface FileConflict {
  detectedAt: number;
  /** Byte count the engine reported writing, as it appeared in `edit_accepted`. */
  engineBytes: number;
}

/** A message the editor needs a user to see. Never a silent failure. */
export interface EditorNotice {
  level: 'error' | 'info';
  message: string;
}

/** Builds the one record for a file. The only place a `FileEntry` is constructed. */
export function makeFileEntry(path: string, content: string): FileEntry {
  const key = canonicalPath(path);
  return {
    path: key,
    name: basename(key),
    content,
    language: languageForPath(key),
    isDirty: false,
    conflict: null,
  };
}

/**
 * One command the terminal ran, or refused to run.
 *
 * This replaced `terminalLines: string[]`, which was seeded with the two fabricated
 * lines `Sketch Terminal v1.0.0` / `> Ready.` and appended to by a reducer case that
 * had no caller. A flat list of strings also cannot express the states the panel has
 * to distinguish, which is why they are fields here:
 *
 *   running   spawned, no outcome yet
 *   exited    ran to completion. `exitCode` is real, and a non-zero one is shown
 *   denied    the policy refused it — allowlist, containment, confirmation
 *   failed    the program could not start, or there is no native backend
 *
 * `stdout` and `stderr` are kept RAW, exactly as the process wrote them. Escape
 * sequences are interpreted at render time by `terminal/ansi.ts` into text nodes;
 * nothing here is HTML, and nothing downstream turns it into HTML.
 */
export interface TerminalRun {
  id: string;
  /** Exactly what the user typed, for the echoed prompt line. */
  line: string;
  program: string;
  args: string[];
  status: 'running' | 'exited' | 'denied' | 'failed';
  /** Null until the process exits, and for a command that never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Why it was denied, or why it failed. Null when it ran. */
  message: string | null;
}

/** What a settled run reports back. Only the fields an outcome actually knows. */
export interface TerminalRunOutcome {
  id: string;
  status: 'exited' | 'denied' | 'failed';
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  message?: string | null;
}

/** Scrollback cap. Bounded so a `npm ci` transcript cannot grow the state forever. */
export const MAX_TERMINAL_RUNS = 100;

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: number;
}

// `TaskEntry` and `AppState.tasks` are deliberately GONE (task 10.4). The array was never
// populated and never read, and its `status: 'pending' | 'in-progress' | 'completed' |
// 'failed'` was a fourth status vocabulary alongside `TaskLog`'s own. A task IS a run, and a
// run's whole story is already on the append-only event log — prompt, adapter, iterations,
// verify rows, and a terminal reason. `TaskLog.projectRuns` derives the rows from there, so
// task state has one home for the same reason cost does (Requirement 14.6).

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
}

// `Agent` was declared here with a `status: 'idle' | 'busy' | 'offline'` field and an
// `icon: string` naming a component by string. Deleted with `agentTeam` (task 10.4): the
// status vocabulary described a state that does not exist, because a role exists only inside
// a dispatch, and `RoleStatus` in `lib/client.ts` is the shape the engine actually reports.

// `Skill` was declared here with `author`, `icon`, `enabled` and `category` — four
// fields the engine's own `Skill` does not have, invented to make a fixture render.
// Deleted in task 6.4. The shapes the Skills panel uses are
// `SkillsCatalogEntry` and `InstalledSkill` in `lib/client.ts`, which mirror what
// the engine actually returns: a name, a summary, a content digest, and a capability
// grant. A UI type richer than its source is a fixture waiting to happen.

/**
 * Provider state, all of it real.
 *
 * `providerCatalog` is the engine's registry matrix (`PROVIDER_CATALOG`), fetched
 * over the client seam — not a list retyped here. `providers` is what the user has
 * configured, loaded from the KEY-FREE `~/.sketch/providers.json`; there is no
 * `apiKey` on either shape and nothing in this reducer can put one there
 * (Requirement 17.2).
 *
 * The three fixture arrays that used to live here — a hardcoded provider list with
 * invented model names, `selectedProvider: 'anthropic'`, `providerConnected: true` —
 * claimed a working Anthropic connection on a machine that had never made one.
 */
export type Provider = ProviderSettingsEntry;

/**
 * What a connection test has told us, per provider id.
 *
 * `never-run` is a FIRST-CLASS STATE, not a synonym for failure: a test is a real
 * network call and only happens when the user asks, so "we have not checked" is the
 * truthful thing to show until they do (Requirement 27.3).
 */
export type ProviderTestState =
  | { status: 'never-run' }
  | { status: 'testing' }
  | { status: 'ok'; message: string; at: number }
  | { status: 'failed'; code: ProviderTestCode; message: string; at: number }
  | { status: 'cancelled'; at: number };

export interface WorkspaceEntry {
  name: string;
  path: string;
}

export interface ArtifactEntry {
  id: string;
  title: string;
  type: string;
  createdAt: number;
  content: string;
}

// App State
export interface AppState {
  mode: 'agent' | 'ide';
  agentView: 'new_task' | 'projects' | 'artifacts' | 'scheduled' | 'customize' | 'timeline' | 'console';
  workspaces: WorkspaceEntry[];
  artifacts: ArtifactEntry[];
  // `mcpToolsStatus` is deliberately GONE. It held `{ connected: 5, total: 8 }`, a
  // fixture claiming five live tool servers. The real answer belongs to the engine and
  // is fetched by `McpTools` through `mcp-catalog`, and it is a list of what COULD start
  // with what each server costs — never a connection count, because MCP servers are
  // started per run and nothing is connected between runs (Requirement 27.5).

  // Agent Mode State
  conversations: Conversation[];
  activeConversationId: string | null;
  isThinking: boolean;
  thinkingStage: string;
  // No `agentTeam`. See the note where its twelve entries used to be initialised.
  chatMessages: ChatMessage[]; // Keep existing for backwards compatibility if needed
  
  // IDE Mode State
  // `null` means no side panel is open — ActivityBar toggles dispatch it and
  // IdeLayout already handles it, so the union now says so instead of lying.
  ideActivePanel:
    | 'explorer'
    | 'search'
    | 'git'
    /** Diff review: the proposed edits an agent has not applied yet (Req 16.1). */
    | 'review'
    /** Live Architecture: the seven generated views of the graph (Req 19.3). */
    | 'architecture'
    | 'agents'
    | 'skills'
    | 'settings'
    | 'timeline'
    | 'console'
    | 'run'
    /** Test Results: the nine-stage verification contract (Req 4.3, 27.1). */
    | 'tests'
    /** MCP Tools: the curated catalog and what each server costs (Req 22.2, 27.5). */
    | 'mcp'
    /** Cost: the total, summed from the event log. The ONE source (Req 20.2, 20.8). */
    | 'cost'
    /** Memory: what the project remembers, and what superseded what (Req 21.1, 27.1). */
    | 'memory'
    | null;
  terminalOpen: boolean;
  /**
   * Real commands, oldest first. Owned here rather than in the panel so the
   * scrollback survives the bottom panel being toggled shut and re-opened.
   */
  terminalHistory: TerminalRun[];
  /**
   * The search box's text. Owned here so the query survives switching side panels;
   * the RESULTS are not, because they are derived from this plus the disk and a
   * second copy of them could disagree with what the box says.
   */
  searchQuery: string;
  /** Optional provider-backed ghost text. Off unless the user explicitly enables it. */
  ghostCompletionsEnabled: boolean;
  
  // File State — the single owner (Requirement 15.2).
  /** Open tabs, in tab order. PATHS only: the content lives in `files`, once. */
  openFiles: string[];
  activeFile: string | null;
  files: Record<string, FileEntry>;
  projectRoot: string | null;
  /** Surfaced by the editor. Set by a refused read, a failed save, a bad path. */
  editorNotice: EditorNotice | null;
  
  // Skills state deliberately does NOT live here. See the note where the two
  // fixtures were deleted, below `editorNotice`'s initial value: the engine owns it,
  // and `SkillsMarketplace` fetches it through `skills-catalog`.
  
  // Provider State — see the note above `Provider`. Nothing here holds a key.
  /** Configured providers, from `~/.sketch/providers.json`. Empty until one is added. */
  providers: Provider[];
  /** The full matrix from the engine's registry. Empty until the panel loads it. */
  providerCatalog: ProviderDescriptor[];
  /** Where the configuration lives, as the engine reported it. Named in the UI. */
  providerSettingsPath: string | null;
  /** A failed load, a failed save, or a file that carried something it should not. */
  providerSettingsNotice: string | null;
  /** Per-provider connection-test state, keyed by provider id. */
  providerTests: Record<string, ProviderTestState>;
  selectedProvider: string | null;
  selectedModel: string | null;
  
  // UI & Tasks
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  // No `tasks`. See the note where `TaskEntry` used to be declared.
  // `totalCost` is deliberately GONE. It held `12.45`, was never read by anything, and
  // was the third copy of a cost figure alongside two hardcoded `$1.4025` strings.
  // Requirement 20.2 says the session total is the sum over the event log with NO
  // independent source, so a field here would be that second source by definition. The
  // Cost panel fetches it through `cost` and holds no counter either.
}

// Actions
export type AppAction =
  | { type: 'SET_MODE'; payload: 'agent' | 'ide' }
  | { type: 'SET_AGENT_VIEW'; payload: AppState['agentView'] }
  | { type: 'SET_PROJECT_ROOT'; payload: string }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_ACTIVE_PANEL'; payload: AppState['ideActivePanel'] }
  | { type: 'TOGGLE_TERMINAL' }
  | { type: 'SET_ACTIVE_FILE'; payload: string | null }
  | { type: 'OPEN_FILE'; payload: FileEntry }
  | { type: 'CLOSE_FILE'; payload: string }
  | { type: 'UPDATE_FILE_CONTENT'; payload: { path: string; content: string } }
  | { type: 'FILE_SAVED'; payload: string }
  /** The engine reported writing this path. The reducer decides update vs conflict. */
  | { type: 'ENGINE_WROTE_FILE'; payload: { path: string; content: string; bytes?: number; at?: number } }
  /** Explicit user choice: take what is on disk and drop my edits. */
  | { type: 'RELOAD_FILE'; payload: { path: string; content: string } }
  /** Explicit user choice: keep my edits; stop showing the conflict. */
  | { type: 'DISMISS_CONFLICT'; payload: string }
  | { type: 'SET_EDITOR_NOTICE'; payload: EditorNotice | null }
  | { type: 'ADD_MESSAGE'; payload: ChatMessage }
  | { type: 'SET_THINKING'; payload: { isThinking: boolean; stage?: string } }
  | { type: 'SET_CONVERSATION'; payload: string }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_RIGHT_PANEL' }
  | { type: 'TOGGLE_BOTTOM_PANEL' }
  | { type: 'SET_BOTTOM_PANEL_HEIGHT'; payload: number }
  | { type: 'SET_PROVIDER'; payload: { provider: string; model: string } }
  /** The engine answered `provider-catalog`: the matrix plus what is on disk. */
  | {
      type: 'PROVIDER_SETTINGS_LOADED';
      payload: {
        catalog: ProviderDescriptor[];
        providers: Provider[];
        selected: string | null;
        path: string;
        notice?: string | null;
      };
    }
  /** A save came back. The payload is what the engine wrote, not what we sent. */
  | {
      type: 'PROVIDER_SETTINGS_SAVED';
      payload: { providers: Provider[]; selected: string | null; path: string };
    }
  | { type: 'PROVIDER_SETTINGS_NOTICE'; payload: string | null }
  | { type: 'PROVIDER_TEST_STARTED'; payload: string }
  | { type: 'PROVIDER_TEST_SETTLED'; payload: { id: string; state: ProviderTestState } }
  /** A command was just spawned, or refused before it could be. */
  | { type: 'TERMINAL_RUN_STARTED'; payload: TerminalRun }
  /** That command's outcome: an exit code, a denial, or a failure to start. */
  | { type: 'TERMINAL_RUN_SETTLED'; payload: TerminalRunOutcome }
  | { type: 'TERMINAL_CLEARED' }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'SET_GHOST_COMPLETIONS'; payload: boolean };

// Initial State with Mock Data
const initialState: AppState = {
  mode: 'agent',
  agentView: 'new_task',
  // No fabricated workspaces. A folder appears here once the user opens one
  // through the real picker (Requirements 14.6, 27.3).
  workspaces: [],
  artifacts: [
    { id: 'art1', title: 'implementation_plan.md', type: 'Markdown Plan', createdAt: Date.now() - 3600000, content: '# Dual-Mode Architecture Plan...' },
    { id: 'art2', title: 'walkthrough.md', type: 'Walkthrough', createdAt: Date.now() - 1800000, content: '# Build Walkthrough...' }
  ],
  // No `mcpToolsStatus` here either. See the note on the interface field above.
  
  conversations: [
    {
      id: 'conv1',
      title: 'Setup Sketch Foundation',
      createdAt: Date.now() - 86400000,
      messages: [
        { id: 'm1', role: 'user', content: 'Create the initial setup for Sketch', timestamp: Date.now() - 86400000 },
        { id: 'm2', role: 'agent', content: 'I have created the initial files. What next?', timestamp: Date.now() - 86390000 }
      ]
    },
    {
      id: 'conv2',
      title: 'Fix React Router Bug',
      createdAt: Date.now() - 3600000,
      messages: [
        { id: 'm1', role: 'user', content: 'The router is acting up on /settings', timestamp: Date.now() - 3600000 }
      ]
    },
    {
      id: 'conv3',
      title: 'Refactor UI Components',
      createdAt: Date.now(),
      messages: []
    }
  ],
  activeConversationId: 'conv3',
  isThinking: false,
  thinkingStage: '',
  chatMessages: [],
  
  // `agentTeam` is deliberately GONE (task 10.4). It held twelve entries — a status
  // vocabulary (`idle|busy|offline`) that no component used, one of them asserted `busy`,
  // Deployment missing, and Requirement 24.4 names thirteen. It was read by nothing, and it
  // was the second of three disagreeing role lists: `AgentTeamPanel` had four fixtures of
  // its own with a THIRD status vocabulary. Roles now have one home — the engine's role
  // table, reached by `AgentTeamPanel` through `strategy-catalog`, which also answers the
  // only question that matters and a fixture cannot: whether THIS project configures a
  // verification stage that could grade each role (Requirements 24.6, 14.6).

  ideActivePanel: 'explorer',
  terminalOpen: false,
  // Nothing has been run yet, and the panel says exactly that. The two lines that
  // used to sit here (`Sketch Terminal v1.0.0`, `> Ready.`) were output from a
  // program that does not exist.
  terminalHistory: [],
  searchQuery: '',
  // Cost- and latency-sensitive provider work is opt-in, never inferred.
  ghostCompletionsEnabled: false,
  
  openFiles: [],
  activeFile: null,
  files: {},
  // No project is open until the user picks one. A hardcoded root here made every
  // file call address a folder that may not exist on this machine.
  projectRoot: null,
  editorNotice: null,
  
  // Task 6.4 deleted two fixtures here: `installedSkills` (15 invented skills) and
  // `skillMarketplace` (8 more). Neither was ever read by any component, and both
  // duplicated a third fixture inside the panel itself. Skill state now has exactly
  // one home: the engine � the pinned manifest for what is available, the
  // filesystem for what is installed � fetched by `SkillsMarketplace` through
  // `skills-catalog`. Three copies of the same truth is how the copy on screen ends
  // up being the wrong one (Requirement 14.6).
  // Nothing is configured until the settings surface loads `providers.json`, and
  // nothing is connected until the user runs a connection test. Both were asserted
  // here as facts before either had ever happened.
  providers: [],
  providerCatalog: [],
  providerSettingsPath: null,
  providerSettingsNotice: null,
  providerTests: {},
  selectedProvider: null,
  selectedModel: null,
  
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  bottomPanelOpen: true,
  bottomPanelHeight: 250
  // No `totalCost` and no `tasks`. See the notes on the interface fields above.
};

/** The starting state. Exported so a test drives the real reducer, not a copy. */
export const initialAppState: AppState = initialState;

// Reducer
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_MODE':
      return { ...state, mode: action.payload };
    case 'SET_AGENT_VIEW':
      return { ...state, agentView: action.payload };
    case 'SET_PROJECT_ROOT': {
      const root = canonicalPath(action.payload);
      // Opening a different project closes its predecessor's buffers. Leaving them
      // open would leave tabs whose paths the file layer must refuse (Req 15.6),
      // which reads as a broken editor rather than as containment working.
      const switched = root !== state.projectRoot;
      return {
        ...state,
        projectRoot: root,
        openFiles: switched ? [] : state.openFiles,
        files: switched ? {} : state.files,
        activeFile: switched ? null : state.activeFile,
        editorNotice: switched ? null : state.editorNotice,
        workspaces: state.workspaces.some(w => w.path === root)
          ? state.workspaces
          : [{ name: basename(root) || 'project', path: root }, ...state.workspaces]
      };
    }
    case 'CLEAR_MESSAGES':
      return { ...state, chatMessages: [] };
    case 'SET_ACTIVE_PANEL':
      return { ...state, ideActivePanel: action.payload };
    case 'TOGGLE_TERMINAL':
      return { ...state, terminalOpen: !state.terminalOpen };
    case 'SET_ACTIVE_FILE': {
      if (action.payload === null) return { ...state, activeFile: null };
      const path = canonicalPath(action.payload);
      // Only an open tab can be active. Anything else would render an empty editor
      // for a file the state does not have.
      if (!state.openFiles.includes(path)) return state;
      return { ...state, activeFile: path };
    }
    case 'OPEN_FILE': {
      const entry = action.payload;
      const isOpen = state.openFiles.includes(entry.path);
      // Re-opening a file that is already open only focuses its tab. Replacing the
      // record would discard unsaved edits, which a click in the file tree must not
      // do.
      if (isOpen) {
        return { ...state, activeFile: entry.path };
      }
      return {
        ...state,
        openFiles: [...state.openFiles, entry.path],
        activeFile: entry.path,
        files: { ...state.files, [entry.path]: entry }
      };
    }
    case 'CLOSE_FILE': {
      const path = canonicalPath(action.payload);
      const index = state.openFiles.indexOf(path);
      if (index === -1) return state;
      const remaining = state.openFiles.filter(p => p !== path);
      const { [path]: _closed, ...keptFiles } = state.files;
      return {
        ...state,
        openFiles: remaining,
        files: keptFiles,
        // The neighbour to the right, else the one to the left, else nothing —
        // the tab that took the closed tab's place.
        activeFile:
          state.activeFile === path
            ? remaining[Math.min(index, remaining.length - 1)] ?? null
            : state.activeFile
      };
    }
    case 'UPDATE_FILE_CONTENT': {
      const path = canonicalPath(action.payload.path);
      const current = state.files[path];
      // A keystroke in a file that is not open cannot be trusted to define one.
      if (!current) return state;
      if (current.content === action.payload.content) return state;
      return {
        ...state,
        files: {
          ...state.files,
          [path]: { ...current, content: action.payload.content, isDirty: true }
        }
      };
    }
    case 'FILE_SAVED': {
      const path = canonicalPath(action.payload);
      const current = state.files[path];
      if (!current) return state;
      return {
        ...state,
        // Saved means disk now matches `content`, so the conflict marker is stale.
        files: { ...state.files, [path]: { ...current, isDirty: false, conflict: null } }
      };
    }
    case 'ENGINE_WROTE_FILE': {
      const path = canonicalPath(action.payload.path);
      const current = state.files[path];
      // Not open: nothing to reconcile. The editor is not a file cache.
      if (!current) return state;
      if (current.isDirty) {
        // The user's unsaved text exists nowhere else; the engine's version is
        // safely on disk and can be re-read on demand. So keep the buffer and flag
        // the divergence (Requirement 15.3).
        return {
          ...state,
          files: {
            ...state.files,
            [path]: {
              ...current,
              conflict: {
                detectedAt: action.payload.at ?? Date.now(),
                engineBytes: action.payload.bytes ?? 0
              }
            }
          }
        };
      }
      if (current.content === action.payload.content) return state;
      return {
        ...state,
        files: {
          ...state.files,
          [path]: { ...current, content: action.payload.content, isDirty: false, conflict: null }
        }
      };
    }
    case 'RELOAD_FILE': {
      const path = canonicalPath(action.payload.path);
      const current = state.files[path];
      if (!current) return state;
      return {
        ...state,
        files: {
          ...state.files,
          [path]: { ...current, content: action.payload.content, isDirty: false, conflict: null }
        }
      };
    }
    case 'DISMISS_CONFLICT': {
      const path = canonicalPath(action.payload);
      const current = state.files[path];
      if (!current || !current.conflict) return state;
      return { ...state, files: { ...state.files, [path]: { ...current, conflict: null } } };
    }
    case 'SET_EDITOR_NOTICE':
      return { ...state, editorNotice: action.payload };
    case 'ADD_MESSAGE':
      return { ...state, chatMessages: [...state.chatMessages, action.payload] };
    case 'SET_THINKING':
      return { ...state, isThinking: action.payload.isThinking, thinkingStage: action.payload.stage || '' };
    case 'SET_CONVERSATION':
      return { ...state, activeConversationId: action.payload };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'TOGGLE_RIGHT_PANEL':
      return { ...state, rightPanelCollapsed: !state.rightPanelCollapsed };
    case 'TOGGLE_BOTTOM_PANEL':
      return { ...state, bottomPanelOpen: !state.bottomPanelOpen };
    case 'SET_BOTTOM_PANEL_HEIGHT':
      return { ...state, bottomPanelHeight: action.payload };
    case 'SET_PROVIDER': {
      // Only a CONFIGURED provider can be selected. Selecting a catalog row that has
      // no entry in providers.json would make the picker claim a provider the engine
      // cannot resolve.
      const entry = state.providers.find(p => p.id === action.payload.provider);
      if (!entry) return state;
      return {
        ...state,
        selectedProvider: entry.id,
        selectedModel: action.payload.model || entry.model
      };
    }
    case 'PROVIDER_SETTINGS_LOADED': {
      const { catalog, providers, selected, path } = action.payload;
      const chosen = providers.some(p => p.id === selected) ? selected : (providers[0]?.id ?? null);
      return {
        ...state,
        providerCatalog: catalog,
        providers,
        selectedProvider: chosen,
        selectedModel: providers.find(p => p.id === chosen)?.model ?? null,
        providerSettingsPath: path,
        providerSettingsNotice: action.payload.notice ?? null,
        // A reload discards stale verdicts: a test result describes a configuration
        // that may just have changed underneath it.
        providerTests: {}
      };
    }
    case 'PROVIDER_SETTINGS_SAVED': {
      const { providers, selected, path } = action.payload;
      const chosen = providers.some(p => p.id === selected) ? selected : (providers[0]?.id ?? null);
      // Verdicts survive a save only for providers whose configuration is unchanged.
      const kept: Record<string, ProviderTestState> = {};
      for (const entry of providers) {
        const before = state.providers.find(p => p.id === entry.id);
        const unchanged =
          before !== undefined && before.baseUrl === entry.baseUrl && before.model === entry.model;
        const previous = state.providerTests[entry.id];
        if (unchanged && previous) kept[entry.id] = previous;
      }
      return {
        ...state,
        providers,
        selectedProvider: chosen,
        selectedModel: providers.find(p => p.id === chosen)?.model ?? null,
        providerSettingsPath: path,
        providerSettingsNotice: null,
        providerTests: kept
      };
    }
    case 'PROVIDER_SETTINGS_NOTICE':
      return { ...state, providerSettingsNotice: action.payload };
    case 'PROVIDER_TEST_STARTED':
      return {
        ...state,
        providerTests: { ...state.providerTests, [action.payload]: { status: 'testing' } }
      };
    case 'PROVIDER_TEST_SETTLED':
      return {
        ...state,
        providerTests: { ...state.providerTests, [action.payload.id]: action.payload.state }
      };
    // `TOGGLE_SKILL` and `INSTALL_SKILL` were deleted in task 6.4 along with the
    // fixtures they mutated. Installing is an engine operation that verifies a
    // content hash and writes to disk, so it cannot be a reducer over local state;
    // and "enabled" was never real — a skill reaches a run because the run asks for
    // it by name (`task.skillNames`), which is the engine's existing contract.
    // Reintroducing either would put skill state back in two places.
    case 'TERMINAL_RUN_STARTED': {
      const history = [...state.terminalHistory, action.payload];
      return {
        ...state,
        terminalHistory:
          history.length > MAX_TERMINAL_RUNS ? history.slice(-MAX_TERMINAL_RUNS) : history
      };
    }
    case 'TERMINAL_RUN_SETTLED': {
      const outcome = action.payload;
      const index = state.terminalHistory.findIndex(run => run.id === outcome.id);
      // A run that is no longer in the scrollback (cleared, or aged out) has
      // nothing to update. Re-adding it would resurrect output the user dismissed.
      if (index === -1) return state;
      const current = state.terminalHistory[index];
      const settled: TerminalRun = {
        ...current,
        status: outcome.status,
        exitCode: outcome.exitCode ?? null,
        stdout: outcome.stdout ?? '',
        stderr: outcome.stderr ?? '',
        message: outcome.message ?? null
      };
      const history = [...state.terminalHistory];
      history[index] = settled;
      return { ...state, terminalHistory: history };
    }
    case 'TERMINAL_CLEARED':
      return { ...state, terminalHistory: [] };
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload };
    case 'SET_GHOST_COMPLETIONS':
      return { ...state, ghostCompletionsEnabled: action.payload };
    default:
      return state;
  }
}

// Context
const AppStateContext = createContext<AppState | undefined>(undefined);
const AppDispatchContext = createContext<Dispatch<AppAction> | undefined>(undefined);

export const AppStateProvider: React.FC<{
  children: ReactNode;
  /** Test-only seam: start from a known state instead of reaching for globals. */
  initial?: Partial<AppState>;
}> = ({ children, initial }) => {
  const [state, dispatch] = useReducer(
    appReducer,
    initial ? { ...initialState, ...initial } : initialState
  );

  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        {children}
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
};

export const useAppState = () => {
  const context = useContext(AppStateContext);
  if (context === undefined) {
    throw new Error('useAppState must be used within a AppStateProvider');
  }
  return context;
};

export const useAppDispatch = () => {
  const context = useContext(AppDispatchContext);
  if (context === undefined) {
    throw new Error('useAppDispatch must be used within a AppStateProvider');
  }
  return context;
};
