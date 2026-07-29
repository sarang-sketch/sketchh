import React, { createContext, useContext, useReducer, ReactNode, Dispatch } from 'react';
import { basename, canonicalPath, languageForPath } from '../editor/paths';

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

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: number;
}

export interface TaskEntry {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: 'idle' | 'busy' | 'offline';
  icon: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  icon: string;
  enabled: boolean;
  category: string;
}

export interface Provider {
  id: string;
  name: string;
  models: string[];
}

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
  mcpToolsStatus: { connected: number; total: number; warning?: boolean };

  // Agent Mode State
  conversations: Conversation[];
  activeConversationId: string | null;
  isThinking: boolean;
  thinkingStage: string;
  agentTeam: Agent[];
  chatMessages: ChatMessage[]; // Keep existing for backwards compatibility if needed
  
  // IDE Mode State
  // `null` means no side panel is open — ActivityBar toggles dispatch it and
  // IdeLayout already handles it, so the union now says so instead of lying.
  ideActivePanel:
    | 'explorer'
    | 'search'
    | 'git'
    | 'agents'
    | 'skills'
    | 'settings'
    | 'timeline'
    | 'console'
    | 'run'
    | 'mcp'
    | null;
  terminalOpen: boolean;
  terminalLines: string[];
  searchQuery: string;
  searchResults: any[];
  
  // File State — the single owner (Requirement 15.2).
  /** Open tabs, in tab order. PATHS only: the content lives in `files`, once. */
  openFiles: string[];
  activeFile: string | null;
  files: Record<string, FileEntry>;
  projectRoot: string | null;
  /** Surfaced by the editor. Set by a refused read, a failed save, a bad path. */
  editorNotice: EditorNotice | null;
  
  // Skills State
  installedSkills: Skill[];
  skillMarketplace: Skill[];
  
  // Provider State
  providers: Provider[];
  selectedProvider: string | null;
  selectedModel: string | null;
  providerConnected: boolean;
  
  // UI & Tasks
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  tasks: TaskEntry[];
  totalCost: number;
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
  | { type: 'TOGGLE_SKILL'; payload: string }
  | { type: 'INSTALL_SKILL'; payload: Skill }
  | { type: 'ADD_TERMINAL_LINE'; payload: string }
  | { type: 'SET_SEARCH_QUERY'; payload: string };

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
  mcpToolsStatus: { connected: 5, total: 8, warning: true },
  
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
  
  agentTeam: [
    { id: 'a1', name: 'CEO Agent', role: 'Orchestrator', status: 'idle', icon: 'Bot' },
    { id: 'a2', name: 'Planner', role: 'Task Breakdown', status: 'idle', icon: 'Brain' },
    { id: 'a3', name: 'Research', role: 'Documentation & Search', status: 'idle', icon: 'Search' },
    { id: 'a4', name: 'Architect', role: 'System Design', status: 'idle', icon: 'Layers' },
    { id: 'a5', name: 'Backend', role: 'Server Code', status: 'busy', icon: 'Server' },
    { id: 'a6', name: 'Frontend', role: 'UI Implementation', status: 'idle', icon: 'Layout' },
    { id: 'a7', name: 'Database', role: 'Schema Design', status: 'idle', icon: 'Database' },
    { id: 'a8', name: 'Security', role: 'Auditing', status: 'idle', icon: 'Shield' },
    { id: 'a9', name: 'Testing', role: 'QA & Coverage', status: 'idle', icon: 'Check' },
    { id: 'a10', name: 'Reviewer', role: 'Code Review', status: 'idle', icon: 'FileCode' },
    { id: 'a11', name: 'Performance', role: 'Optimization', status: 'idle', icon: 'Zap' },
    { id: 'a12', name: 'Docs', role: 'Documentation', status: 'idle', icon: 'FileText' }
  ],
  
  ideActivePanel: 'explorer',
  terminalOpen: false,
  terminalLines: ['Sketch Terminal v1.0.0', '> Ready.'],
  searchQuery: '',
  searchResults: [],
  
  openFiles: [],
  activeFile: null,
  files: {},
  // No project is open until the user picks one. A hardcoded root here made every
  // file call address a folder that may not exist on this machine.
  projectRoot: null,
  editorNotice: null,
  
  installedSkills: [
    { id: 's1', name: 'skillopt', description: 'Optimize your code automatically', version: '1.2.0', author: 'Sketch Team', icon: 'Zap', enabled: true, category: 'Optimization' },
    { id: 's2', name: 'superpowers', description: 'Advanced IDE features', version: '2.0.1', author: 'Community', icon: 'Star', enabled: true, category: 'Productivity' },
    { id: 's3', name: 'tdd', description: 'Test Driven Development workflow', version: '1.0.0', author: 'Sketch Team', icon: 'Check', enabled: false, category: 'Testing' },
    { id: 's4', name: 'grill-me', description: 'Aggressive code review', version: '0.9.5', author: 'Community', icon: 'AlertCircle', enabled: true, category: 'Review' },
    { id: 's5', name: 'caveman', description: 'Simplify complex code', version: '1.0.0', author: 'Sketch Team', icon: 'Minus', enabled: false, category: 'Refactoring' },
    { id: 's6', name: 'frontend-design', description: 'UI/UX best practices', version: '1.1.0', author: 'Designers', icon: 'Palette', enabled: true, category: 'Design' },
    { id: 's7', name: 'code-reviewer', description: 'Standard code review', version: '1.5.0', author: 'Sketch Team', icon: 'MessageSquare', enabled: true, category: 'Review' },
    { id: 's8', name: 'browser-use', description: 'Automate browser tasks', version: '2.1.0', author: 'Community', icon: 'Globe', enabled: false, category: 'Automation' },
    { id: 's9', name: 'react-skill', description: 'React specific optimizations', version: '18.2.0', author: 'Sketch Team', icon: 'Code', enabled: true, category: 'Framework' },
    { id: 's10', name: 'nextjs-skill', description: 'Next.js best practices', version: '13.4.0', author: 'Community', icon: 'Code', enabled: true, category: 'Framework' },
    { id: 's11', name: 'docker-skill', description: 'Docker container management', version: '1.0.0', author: 'Sketch Team', icon: 'Package', enabled: true, category: 'DevOps' },
    { id: 's12', name: 'security-skill', description: 'Security vulnerability scanning', version: '1.1.0', author: 'Security Pros', icon: 'Shield', enabled: true, category: 'Security' },
    { id: 's13', name: 'git-workflow', description: 'Git branch management', version: '1.0.0', author: 'Sketch Team', icon: 'GitBranch', enabled: true, category: 'VCS' },
    { id: 's14', name: 'api-design', description: 'RESTful API best practices', version: '1.0.0', author: 'Community', icon: 'Server', enabled: true, category: 'Architecture' },
    { id: 's15', name: 'database-design', description: 'SQL Schema optimization', version: '1.0.0', author: 'Sketch Team', icon: 'Database', enabled: false, category: 'Architecture' }
  ],
  skillMarketplace: [
    { id: 'm1', name: 'Vue Support', description: 'Vue.js development tools', version: '1.0.0', author: 'Community', icon: 'Code', enabled: false, category: 'Framework' },
    { id: 'm2', name: 'Angular Support', description: 'Angular development tools', version: '1.0.0', author: 'Community', icon: 'Code', enabled: false, category: 'Framework' },
    { id: 'm3', name: 'Svelte Support', description: 'Svelte development tools', version: '1.0.0', author: 'Community', icon: 'Code', enabled: false, category: 'Framework' },
    { id: 'm4', name: 'Rust Support', description: 'Rust development tools', version: '1.0.0', author: 'Community', icon: 'FileRust', enabled: false, category: 'Language' },
    { id: 'm5', name: 'Python Support', description: 'Python development tools', version: '1.0.0', author: 'Community', icon: 'FilePython', enabled: false, category: 'Language' },
    { id: 'm6', name: 'Go Support', description: 'Go development tools', version: '1.0.0', author: 'Community', icon: 'Code', enabled: false, category: 'Language' },
    { id: 'm7', name: 'AWS toolkit', description: 'AWS integration', version: '1.0.0', author: 'Community', icon: 'Cloud', enabled: false, category: 'Cloud' },
    { id: 'm8', name: 'GCP toolkit', description: 'GCP integration', version: '1.0.0', author: 'Community', icon: 'Cloud', enabled: false, category: 'Cloud' }
  ],
  
  providers: [
    { id: 'openai', name: 'OpenAI', models: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
    { id: 'anthropic', name: 'Anthropic', models: ['claude-3-5-sonnet', 'claude-3-opus', 'claude-3-haiku'] },
    { id: 'gemini', name: 'Gemini', models: ['gemini-1.5-pro', 'gemini-1.5-flash'] },
    { id: 'groq', name: 'Groq', models: ['llama3-70b-8192', 'mixtral-8x7b-32768'] },
    { id: 'openrouter', name: 'OpenRouter', models: ['auto'] },
    { id: 'ollama', name: 'Ollama (Local)', models: ['llama3', 'mistral', 'phi3'] }
  ],
  selectedProvider: 'anthropic',
  selectedModel: 'claude-3-5-sonnet',
  providerConnected: true,
  
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  bottomPanelOpen: true,
  bottomPanelHeight: 250,
  tasks: [],
  totalCost: 12.45
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
    case 'SET_PROVIDER':
      return { ...state, selectedProvider: action.payload.provider, selectedModel: action.payload.model };
    case 'TOGGLE_SKILL':
      return {
        ...state,
        installedSkills: state.installedSkills.map(skill =>
          skill.id === action.payload ? { ...skill, enabled: !skill.enabled } : skill
        )
      };
    case 'INSTALL_SKILL':
      return { ...state, installedSkills: [...state.installedSkills, action.payload] };
    case 'ADD_TERMINAL_LINE':
      return { ...state, terminalLines: [...state.terminalLines, action.payload] };
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload };
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
