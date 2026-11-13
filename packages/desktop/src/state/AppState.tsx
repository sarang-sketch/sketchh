import React, { createContext, useContext, useEffect, useReducer, useRef, ReactNode, Dispatch } from 'react';
import { basename, canonicalPath, languageForPath } from '../editor/paths';
import { DEFAULT_APPEARANCE, normalizeAppearance, type AppearanceSettings } from '../styles/appearance';
import { ComposerDraftsProvider } from './ComposerDrafts';
import {
  archiveConversation,
  editAndResend,
  pinConversation,
  setFeedback,
  setPerChatModel,
  toggleFeedback,
  unarchiveConversation,
  unpinConversation,
  type ConversationExtrasMap,
  type FeedbackStore,
  type FeedbackVote,
} from './conversationExtras';
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
  /**
   * What this window last knew to be ON DISK — the text it opened, saved, reloaded or
   * was told the engine wrote. It is the baseline a disk check compares with: without
   * it, a tab with unsaved edits always differs from the disk, so "did something else
   * change this file?" could not be answered. It also lets typing back to the saved
   * text clear the dirty dot. Same record, not a second cache of the file.
   */
  diskContent: string;
  /**
   * Bumped each time `diskContent` is re-established. A disk read that STARTED before
   * a save, a reload or an engine write carries the older number and is dropped, so a
   * slow read can never put back text the user has just replaced.
   */
  diskVersion: number;
  /** The file has gone from disk while its tab is open. The text is kept; saving recreates it. */
  deletedOnDisk?: boolean;
}

export interface FileConflict {
  detectedAt: number;
  /** Byte count the engine reported writing, as it appeared in `edit_accepted`. */
  engineBytes: number;
  /**
   * Absent: the engine wrote the file. `disk`: something else did — a terminal
   * command, a branch switch or pull, another program — found by a disk check.
   */
  source?: 'disk';
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
    diskContent: content,
    diskVersion: 0,
    deletedOnDisk: false,
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
  status: 'running' | 'exited' | 'denied' | 'failed' | 'stopped';
  /** Null until the process exits, and for a command that never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Why it was denied, or why it failed. Null when it ran. */
  message: string | null;
  /** The terminal tab this run belongs to. Runs predating tabs belong to the first. */
  terminalId?: string;
  /** Where it ran, absolute. */
  cwd?: string | null;
  /** The engine's id for the process, once it has started. */
  sessionId?: string | null;
  /** Wall-clock length, once it has ended. */
  durationMs?: number | null;
}

/** One terminal tab: its own folder and its own scrollback. */
export interface TerminalTab {
  id: string;
  title: string;
  /** Absolute; null means the project root. */
  cwd: string | null;
  /**
   * `shell`: a real shell in a pseudo-terminal (the desktop app) — arrow-key menus,
   * REPLs, vim, a virtualenv that stays active. `commands`: the classic runner, one
   * process per line, which works over every transport and backs the Run panel.
   * Absent on a tab created before the window knew which it could offer.
   */
  kind?: 'shell' | 'commands';
  /** The shell profile a `shell` tab runs (null: this machine's default). */
  profileId?: string | null;
}

/** Characters kept per stream per run. The newest output wins; the head is dropped. */
export const MAX_TERMINAL_OUTPUT_CHARS = 400_000;

function appendCapped(current: string, more: string | undefined): string {
  if (more === undefined || more === '') return current;
  const next = current + more;
  return next.length > MAX_TERMINAL_OUTPUT_CHARS ? next.slice(next.length - MAX_TERMINAL_OUTPUT_CHARS) : next;
}

/** What a settled run reports back. Only the fields an outcome actually knows. */
export interface TerminalRunOutcome {
  id: string;
  status: 'exited' | 'denied' | 'failed' | 'stopped';
  exitCode?: number | null;
  /** When present, REPLACES the output. A streamed run settles without these. */
  stdout?: string;
  stderr?: string;
  message?: string | null;
  durationMs?: number | null;
}

/** Scrollback cap. Bounded so a `npm ci` transcript cannot grow the state forever. */
export const MAX_TERMINAL_RUNS = 100;

/** One line of a finished run's activity, kept with the message so it survives a reload. */
export interface RunStepSummary {
  kind: 'plan' | 'read' | 'search' | 'list' | 'edit' | 'verify' | 'think' | 'ask' | 'tool' | 'index' | 'warn' | 'error' | 'command' | 'skill'
  text: string
  ok?: boolean
}

/**
 * What a finished run can PROVE it did, from its own events: the checks that ran and
 * how they ended, the commands it executed with their exit codes, and what it cost in
 * model calls and tokens. Nothing here is the model's own claim.
 */
export interface RunReceipt {
  checks: Array<{ name: string; ok: boolean }>
  commands: Array<{ command: string; exitCode: number }>
  modelCalls: number
  tokens: { in: number; out: number }
  /**
   * Calls whose token usage the provider did NOT report (`usageKnown: false`). Their
   * tokens are not in {@link tokens} — there is nothing to add — so a surface shows them
   * as "unknown", never as 0. Old logs without the flag count as known (0 here).
   */
  tokensUnknownCalls: number
  /** True when any call's numbers are an estimate (the offline fake adapter's ~len/4). */
  tokensEstimated: boolean
  /**
   * Automatic retries across this message's calls: the extra wire requests beyond the
   * first try (so `attempts` 3 contributes 2). The receipt says "(N retries)" when > 0,
   * while {@link modelCalls} stays the LOGICAL call count.
   */
  retries: number
  /**
   * The distinct models for this message's calls, in first-seen order: the model the
   * provider NAMED as having answered when it reported one (a router alias when one
   * resolved), otherwise the requested model. So the chat shows which model actually
   * handled the message, not only the one the picker displayed. Empty on a log with
   * no model recorded.
   */
  models: string[]
  /**
   * True when at least one call recorded the model the PROVIDER named (`responseModel`),
   * so {@link models} are answered models. False when only the requested model is known
   * (the provider named none), so a surface should label them "(requested)".
   */
  modelsAnswered: boolean
  durationMs: number | null
  /**
   * The run's apply-mode edit outcome, from its terminal event (completion honesty,
   * B-003). `failed > 0` means edits the run tried to write did not land — the chat
   * shows this so a run that said "done" over failed edits cannot read as a success.
   * Absent on an old event log that predates the fields.
   */
  edits?: { applied: number; failed: number }
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: number;
  /** The engine run this message reports on, when it is an agent reply. */
  runId?: string;
  /** Whether that run ended ok. Undefined for non-run messages. */
  ok?: boolean;
  /** Compact activity, so a reopened conversation still shows what the run did. */
  steps?: RunStepSummary[];
  /** What the run verifiably did: checks, commands, calls, tokens, time. */
  receipt?: RunReceipt;
  /** Files the run changed (auto-apply) or proposed (review), project-relative. */
  files?: Array<{ path: string; added: number; removed: number; created: boolean }>;
  /** 'applied' | 'proposed' | 'undone' — what happened to those files. */
  filesState?: 'applied' | 'proposed' | 'undone' | 'accepted' | 'rejected';
  /** The project the run was in, so Undo addresses the right folder. */
  root?: string;
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
  /** Last activity, for ordering Recents. */
  updatedAt?: number;
  /** The folder the conversation worked in. */
  root?: string | null;
}

/**
 * How much the agent may do without asking, chosen in the composer (Shift+Tab cycles):
 *
 *   * `ask`   — read-only: it reads, explains, reviews and plans; the ENGINE refuses edits.
 *   * `agent` — edits (applied with Undo, or proposed for review per `autoApply`), and
 *               every command it wants to run is put to you first.
 *   * `auto`  — works to completion without interrupting: edits applied, ordinary
 *               commands run without asking, questions answered by "use your
 *               judgement". Destructive commands still need you.
 */
export type AgentMode = 'ask' | 'agent' | 'auto';

export const AGENT_MODES: readonly AgentMode[] = ['ask', 'agent', 'auto'];

/**
 * Speed is orthogonal to mode: it says how long a run may go on, not what it may
 * do. The user asked for a Normal / Turbo switch in the chat; the committed code
 * had no "Turbo" anywhere (only Ask/Agent/Auto), so this is the control that was
 * missing. It is NOT a different model or a fake backend:
 *
 *   * `normal` — the full agent: up to `maxIterations` turns, the last 12 turns of
 *     history, the configured spend/token budget.
 *   * `turbo`  — faster and lighter: turns capped (10 in Ask/Agent, 20 in Auto),
 *     only the last 6 turns of history, a smaller token budget. Same model, same
 *     permissions, same mode — it just stops sooner and reads less context.
 */
export type AgentSpeed = 'normal' | 'turbo';

export const AGENT_SPEEDS: readonly AgentSpeed[] = ['normal', 'turbo'];

/** How the agent behaves. Chosen by the user; persisted with the window. */
export interface AgentPrefs {
  /** See {@link AgentMode}. */
  mode: AgentMode;
  /** See {@link AgentSpeed}. Normal is the full agent; Turbo is faster and lighter. */
  speed: AgentSpeed;
  /**
   * Write edits as the run makes them (every run can be undone from its snapshot),
   * or leave each one as a proposal to review first.
   */
  autoApply: boolean;
  /** Model turns per run. */
  maxIterations: number;
  /** Spend ceiling per run, in USD, for priced providers. */
  maxUsd: number;
  /**
   * Run the project's own checks (tests, lint, typecheck, build — from verify.yaml or
   * detected from the project) to verify auto-applied changes before a run counts as
   * done. Runs the project's scripts on this machine, so it is the user's choice.
   */
  verifyChanges: boolean;
  /**
   * The user's own MCP servers that chats may start, by name (MCP panel → "Use in
   * chats"). Each run starts only these, and only once each is approved where needed.
   */
  mcpServers?: string[];
  /**
   * Hooks (`.sketch/hooks.json`) run for this project's runs. Off by default: it
   * turns on only when the user saves hooks through the Hooks panel, because a
   * hooks file names programs Sketch runs as the user. The engine still only
   * loads hooks when the run passes `hooksEnabled: true`.
   */
  hooksEnabled?: boolean;
}

export const DEFAULT_AGENT_PREFS: AgentPrefs = { mode: 'agent', speed: 'normal', autoApply: true, maxIterations: 30, maxUsd: 2, verifyChanges: true };

/** How the code editor looks and behaves. Chosen in Settings → Editor; persisted. */
export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: 'on' | 'off' | 'relative';
  /** Save without Ctrl+S: a second after typing stops, or when the editor loses focus. */
  autoSave: 'off' | 'afterDelay' | 'onFocusChange';
  /** Format the document before saving, where a formatter exists for its language. */
  formatOnSave: boolean;
  renderWhitespace: 'none' | 'selection' | 'all';
  /** The current scope's header (function, class) stays pinned while scrolling. */
  stickyScroll: boolean;
  bracketPairColorization: boolean;
  /** IntelliSense, hover and problems for TypeScript, JavaScript, JSON, CSS and HTML. */
  languageFeatures: boolean;
  /** The whole window's colours: dark, light, or the operating system's choice. */
  colorTheme: 'dark' | 'light' | 'system';
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 13,
  tabSize: 2,
  insertSpaces: true,
  wordWrap: false,
  minimap: true,
  lineNumbers: 'on',
  autoSave: 'off',
  formatOnSave: false,
  renderWhitespace: 'selection',
  stickyScroll: true,
  bracketPairColorization: true,
  languageFeatures: true,
  colorTheme: 'dark',
};

/** Every field checked and bounded, so a corrupted stored value cannot break the editor. */
export function normalizeEditorSettings(input: Partial<EditorSettings> | null | undefined): EditorSettings {
  const d = DEFAULT_EDITOR_SETTINGS;
  const s = input ?? {};
  const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  return {
    fontSize: num(s.fontSize, 8, 32, d.fontSize),
    tabSize: num(s.tabSize, 1, 8, d.tabSize),
    insertSpaces: bool(s.insertSpaces, d.insertSpaces),
    wordWrap: bool(s.wordWrap, d.wordWrap),
    minimap: bool(s.minimap, d.minimap),
    lineNumbers: pick(s.lineNumbers, ['on', 'off', 'relative'] as const, d.lineNumbers),
    autoSave: pick(s.autoSave, ['off', 'afterDelay', 'onFocusChange'] as const, d.autoSave),
    formatOnSave: bool(s.formatOnSave, d.formatOnSave),
    renderWhitespace: pick(s.renderWhitespace, ['none', 'selection', 'all'] as const, d.renderWhitespace),
    stickyScroll: bool(s.stickyScroll, d.stickyScroll),
    bracketPairColorization: bool(s.bracketPairColorization, d.bracketPairColorization),
    languageFeatures: bool(s.languageFeatures, d.languageFeatures),
    colorTheme: pick(s.colorTheme, ['dark', 'light', 'system'] as const, d.colorTheme),
  };
}

/** One problem a language service reported, 1-based like the editor's own positions. */
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  source?: string;
  code?: string;
}

export type SettingsTab = 'models' | 'agent' | 'appearance' | 'editor' | 'privacy' | 'shortcuts' | 'about';

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
  agentView: 'new_task' | 'projects' | 'artifacts' | 'scheduled' | 'customize' | 'timeline' | 'console' | 'workflows' | 'tools' | 'memory';
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
  /**
   * Per-conversation extras (pin, archive, per-chat model) and thumbs feedback,
   * keyed by conversation / message id. Pure helpers in `conversationExtras.ts`;
   * persisted alongside conversations (see `PersistedState`).
   */
  conversationExtras: ConversationExtrasMap;
  messageFeedback: FeedbackStore;
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
    | 'team'
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
    /** Benchmarks: latest validated artifact only. Reading never starts a benchmark. */
    | 'benchmarks'
    | 'memory'
    /** Project Rescue: real findings about this project's health. */
    | 'rescue'
    /** UI Doctor: real accessibility and markup checks on the live page. */
    | 'ui-doctor'
    /** API Lab: real HTTP requests with a timeout, from this window. */
    | 'api-lab'
    /** Hooks: the `.sketch/hooks.json` programs runs may execute. */
    | 'hooks'
    /** Debugger: recorded breakpoints and the Node inspector launch. No stepping yet. */
    | 'debugger'
    /** Daily briefing: runs, costs, tasks and conversations for one day. */
    | 'briefing'
    /** EGM Design & Review: Elephant drafts, Goldfish reviewers, you approve. */
    | 'egm'
    | null;
  terminalOpen: boolean;
  /**
   * Real commands, oldest first. Owned here rather than in the panel so the
   * scrollback survives the bottom panel being toggled shut and re-opened.
   */
  terminalHistory: TerminalRun[];
  /** Terminal tabs, in order. Always at least one. */
  terminals: TerminalTab[];
  activeTerminalId: string;
  /** The window can start real shells (the desktop app with a terminal backend). */
  terminalShellsAvailable: boolean;
  /** Which view the bottom panel shows. */
  bottomPanelTab: 'terminal' | 'problems';
  /** The side panel to bring back when the side bar is toggled on again. */
  lastIdePanel: Exclude<AppState['ideActivePanel'], null>;
  /** How the code editor looks and behaves. Persisted. */
  editorSettings: EditorSettings;
  appearance: AppearanceSettings;
  /** Focus changes visibility, never the saved layout or open buffers. */
  focusMode: boolean;
  composerFocusNonce: number;
  /**
   * Scroll the editor to a line. Set by search results, Problems, Go to Line; the editor
   * consumes it once per `nonce`.
   */
  revealRequest: { path: string; line: number; column: number; nonce: number } | null;
  /** Problems the editor's language services report, per open file. */
  diagnostics: Record<string, Diagnostic[]>;
  /** Tabs from the last session, waiting to be reopened from disk. Consumed once. */
  restoreTabs: { root: string; paths: string[]; active: string | null } | null;
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
  /** The Settings dialog, reachable from both surfaces. */
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /**
   * Offline Mode as the engine last reported it. `null` until it answers, and on a
   * transport that cannot say. Shown in the status bar; enforced by the engine.
   */
  offline: boolean | null;
  /** The "Connect a model" wizard. */
  connectOpen: boolean;
  /** The provider the wizard should open on, when something asked for one. */
  connectProvider: string | null;
  agentPrefs: AgentPrefs;
  /** Monaco's caret in the active file, 1-based. Null when no editor has focus yet. */
  cursor: { line: number; column: number } | null;
  /** Providers whose key the engine found in its environment, by variable NAME. */
  providerEnvKeys: Record<string, string>;
  /** Quick Open / Command Palette, or null when neither is showing. */
  paletteOpen: 'files' | 'commands' | null;
  /** Text an editor action placed in the Code sidebar's composer, to be finished by the user. */
  composerSeed: { text: string; files: string[]; nonce: number; preserveText?: boolean } | null;
  /** A distinct draft for each fresh, unsent conversation. Never persisted. */
  newConversationNonce: number;
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
  | { type: 'CLEAR_PROJECT_ROOT'; payload?: { notice?: EditorNotice } }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_ACTIVE_PANEL'; payload: AppState['ideActivePanel'] }
  | { type: 'TOGGLE_TERMINAL' }
  | { type: 'SET_ACTIVE_FILE'; payload: string | null }
  | { type: 'OPEN_FILE'; payload: FileEntry }
  | { type: 'CLOSE_FILE'; payload: string }
  | { type: 'UPDATE_FILE_CONTENT'; payload: { path: string; content: string } }
  /**
   * A write finished. With `content`, the buffer is marked clean only if it still holds
   * exactly what was written — typing during the write keeps it dirty. Decided here, on
   * the latest state, so no render timing can get it wrong.
   */
  | { type: 'FILE_SAVED'; payload: string | { path: string; content: string } }
  /** The engine reported writing this path. The reducer decides update vs conflict. */
  | { type: 'ENGINE_WROTE_FILE'; payload: { path: string; content: string; bytes?: number; at?: number } }
  /** Explicit user choice: take what is on disk and drop my edits. */
  | { type: 'RELOAD_FILE'; payload: { path: string; content: string } }
  /** Explicit user choice: keep my edits; stop showing the conflict. */
  | { type: 'DISMISS_CONFLICT'; payload: string }
  /**
   * A disk check read this open file. `version` is the entry's `diskVersion` when the
   * read started; a read that predates a save or reload is dropped. The reducer
   * decides: a clean buffer takes the new text, a dirty one keeps it and is flagged.
   */
  | { type: 'DISK_CHANGED'; payload: { path: string; content: string; version?: number; at?: number } }
  /** A disk check found this open file gone. The text stays; the tab says so. */
  | { type: 'DISK_DELETED'; payload: { path: string; version?: number } }
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
        envKeys?: Record<string, string>;
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
  | { type: 'TERMINAL_CLEARED'; payload?: string }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'SET_GHOST_COMPLETIONS'; payload: boolean }
  /** Patch one message of the active conversation (attach steps, mark undone). */
  | { type: 'UPDATE_MESSAGE'; payload: { id: string; patch: Partial<ChatMessage> } }
  | { type: 'DELETE_CONVERSATION'; payload: string }
  /** A conversation imported from a JSON export file (see conversationImport.ts). */
  | { type: 'IMPORT_CONVERSATION'; payload: Conversation }
  /** Rename one conversation (Recents inline edit). Title is trimmed and capped; an empty
   *  title keeps the old one; an unknown id is a no-op. */
  | { type: 'RENAME_CONVERSATION'; payload: { id: string; title: string } }
  /** Pin / archive a conversation. Pinned conversations sort first in Recents;
   * archived ones leave the main list (see `conversationExtras.ts`). */
  | { type: 'PIN_CONVERSATION'; payload: string }
  | { type: 'UNPIN_CONVERSATION'; payload: string }
  | { type: 'ARCHIVE_CONVERSATION'; payload: string }
  | { type: 'UNARCHIVE_CONVERSATION'; payload: string }
  /** Run this conversation with a different model. `null` clears back to the global
   * model. Unknown model ids are rejected (the reducer keeps the old value). */
  | { type: 'SET_CONVERSATION_MODEL'; payload: { id: string; model: string | null } }
  /** Thumbs up / down on one agent message. Sending the same vote again clears it. */
  | { type: 'SET_MESSAGE_FEEDBACK'; payload: { messageId: string; vote: FeedbackVote } }
  /** Replace one of your messages and drop everything after it, so a new run can
   * start from the edited text. The re-run itself is the caller's job. */
  | { type: 'EDIT_AND_RESEND'; payload: { messageId: string; newText: string } }
  /** Settings → Privacy → Clear chat history. Every conversation, from memory and from disk. */
  | { type: 'CLEAR_CONVERSATIONS' }
  /** What the engine last reported about Offline Mode (`null` until it has answered). */
  | { type: 'SET_OFFLINE'; payload: boolean | null }
  | { type: 'NEW_CONVERSATION' }
  | { type: 'OPEN_SETTINGS'; payload?: SettingsTab }
  | { type: 'CLOSE_SETTINGS' }
  | { type: 'OPEN_CONNECT'; payload?: string | null }
  | { type: 'CLOSE_CONNECT' }
  | { type: 'SET_AGENT_PREFS'; payload: Partial<AgentPrefs> }
  | { type: 'SET_CURSOR'; payload: { line: number; column: number } | null }
  /** Quick Open (`files`, Ctrl+P) or the Command Palette (`commands`, Ctrl+Shift+P). */
  | { type: 'OPEN_PALETTE'; payload: 'files' | 'commands' }
  | { type: 'CLOSE_PALETTE' }
  | { type: 'SEED_COMPOSER'; payload: { text: string; files?: string[]; preserveText?: boolean } }
  | { type: 'CLEAR_COMPOSER_SEED' }
  | { type: 'FORGET_WORKSPACE'; payload: string }
  /** The side bar on and off in the Code surface, remembering which panel it showed. */
  | { type: 'TOGGLE_IDE_SIDE_PANEL' }
  /** Close several tabs at once (Close Others / to the Right / Saved / All). */
  | { type: 'CLOSE_FILES'; payload: string[] }
  /** Move a tab within the tab bar. */
  | { type: 'MOVE_TAB'; payload: { path: string; toIndex: number } }
  /** A file or folder was renamed on disk: retarget every open tab under `from`. */
  | { type: 'PATHS_RENAMED'; payload: { from: string; to: string } }
  /** A file or folder was deleted on disk: close every tab under it. */
  | { type: 'PATHS_DELETED'; payload: string }
  | { type: 'SET_EDITOR_SETTINGS'; payload: Partial<EditorSettings> }
  | { type: 'SET_APPEARANCE'; payload: Partial<AppearanceSettings> }
  | { type: 'TOGGLE_FOCUS_MODE' }
  | { type: 'FOCUS_COMPOSER' }
  | { type: 'APPLY_LAYOUT_PRESET'; payload: 'balanced' | 'review' | 'write' }
  /**
   * Apply a validated settings import (W9). Only the UI-settings store is touched: the
   * editor settings and the exportable agent fields. Never a key, never provider config.
   */
  | {
      type: 'IMPORT_SETTINGS'
      payload: {
        editor: EditorSettings
        appearance?: AppearanceSettings
        agent: Pick<AgentPrefs, 'mode' | 'autoApply' | 'maxIterations' | 'maxUsd' | 'verifyChanges'>
      }
    }
  | { type: 'REVEAL_IN_EDITOR'; payload: { path: string; line: number; column?: number } }
  | { type: 'SET_DIAGNOSTICS'; payload: { path: string; diagnostics: Diagnostic[] } }
  | { type: 'SET_BOTTOM_PANEL_TAB'; payload: AppState['bottomPanelTab'] }
  /** Show the bottom panel on a given tab (opening it if it was closed). */
  | { type: 'SHOW_BOTTOM_PANEL'; payload: AppState['bottomPanelTab'] }
  | {
      type: 'TERMINAL_NEW';
      payload?: {
        cwd?: string | null;
        id?: string;
        title?: string;
        /** Default: a real shell when the window can start one, else the classic runner. */
        kind?: 'shell' | 'commands';
        profileId?: string | null;
      };
    }
  /** The window learned whether it can start real shells. Untouched tabs follow. */
  | { type: 'TERMINAL_SHELLS_AVAILABLE'; payload: boolean }
  | { type: 'TERMINAL_RETITLE'; payload: { id: string; title: string } }
  | { type: 'TERMINAL_CLOSE'; payload: string }
  | { type: 'TERMINAL_SELECT'; payload: string }
  | { type: 'TERMINAL_CD'; payload: { terminalId: string; cwd: string | null } }
  /** Streamed output for a running command. Appended, capped from the head. */
  | { type: 'TERMINAL_RUN_OUTPUT'; payload: { id: string; stdout?: string; stderr?: string } }
  | { type: 'TERMINAL_RUN_SESSION'; payload: { id: string; sessionId: string; cwd?: string } }
  | { type: 'TABS_RESTORED' };

// Initial State with Mock Data
const initialState: AppState = {
  mode: 'agent',
  agentView: 'new_task',
  // No fabricated workspaces. A folder appears here once the user opens one
  // through the real picker (Requirements 14.6, 27.3).
  workspaces: [],
  // No fabricated artifacts. The two that used to sit here (`implementation_plan.md`,
  // `walkthrough.md`) were never produced by any run on this machine.
  artifacts: [],
  // No `mcpToolsStatus` here either. See the note on the interface field above.

  // No fabricated conversations. "Setup Sketch Foundation", "Fix React Router Bug" and
  // "Refactor UI Components" were shown under Recents on every fresh install, and
  // clicking one loaded nothing. Recents now lists only what this user actually asked,
  // restored from local storage by the provider when persistence is on.
  conversations: [],
  activeConversationId: null,
  conversationExtras: {},
  messageFeedback: {},
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
  terminals: [{ id: 'term-1', title: 'Terminal 1', cwd: null }],
  activeTerminalId: 'term-1',
  terminalShellsAvailable: false,
  bottomPanelTab: 'terminal',
  lastIdePanel: 'explorer',
  editorSettings: DEFAULT_EDITOR_SETTINGS,
  appearance: DEFAULT_APPEARANCE,
  focusMode: false,
  composerFocusNonce: 0,
  revealRequest: null,
  diagnostics: {},
  restoreTabs: null,
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
  // one home: the engine — the pinned manifest for what is available, the
  // filesystem for what is installed — fetched by `SkillsMarketplace` through
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
  bottomPanelHeight: 250,
  settingsOpen: false,
  settingsTab: 'models',
  offline: null,
  connectOpen: false,
  connectProvider: null,
  agentPrefs: DEFAULT_AGENT_PREFS,
  cursor: null,
  providerEnvKeys: {},
  paletteOpen: null,
  composerSeed: null,
  newConversationNonce: 0,
  // No `totalCost` and no `tasks`. See the notes on the interface fields above.
};

/** The starting state. Exported so a test drives the real reducer, not a copy. */
export const initialAppState: AppState = initialState;

/** Recents is bounded: the oldest conversation gives way, never the newest. */
export const MAX_CONVERSATIONS = 60;
/** A renamed conversation title is trimmed and capped at this length. */
export const MAX_CONVERSATION_TITLE = 120;
/** Per-conversation scrollback kept in memory and on disk. */
export const MAX_MESSAGES_PER_CONVERSATION = 200;

/** A conversation's title: its first request, on one line, shortened. */
export function titleFor(message: ChatMessage): string {
  if (message.role !== 'user') return 'New task';
  const line = message.content.replace(/\s+/g, ' ').trim();
  if (line === '') return 'New task';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

// ── persistence ─────────────────────────────────────────────────────────────
//
// Conversations, opened folders and agent preferences survive a restart. They live
// in this window's local storage and nowhere else — no account, no sync, no server.
// Text is scrubbed of credential-shaped strings before it is stored, because a user
// who pastes a key into a prompt should not find it sitting in a profile directory.

const STORAGE_KEY = 'sketch.ui.v1';

/** Credential formats, mirrored from the engine's table (packages/core/src/secrets). */
const KEY_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|gsk|sk-ant|sk-or|xai|ghp|gho|github_pat)-[A-Za-z0-9_-]{6,}/gi,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const shape of KEY_SHAPES) out = out.replace(shape, '[redacted]');
  return out;
}

interface PersistedState {
  conversations: Conversation[];
  activeConversationId: string | null;
  /** Per-conversation pin/archive/model extras, keyed by conversation id. */
  conversationExtras?: ConversationExtrasMap;
  /** Thumbs feedback, keyed by message id. */
  messageFeedback?: FeedbackStore;
  workspaces: WorkspaceEntry[];
  projectRoot: string | null;
  agentPrefs: AgentPrefs;
  mode: AppState['mode'];
  /** The status-bar Autocomplete toggle. Off until the user turns it on. */
  ghostCompletionsEnabled?: boolean;
  editorSettings?: EditorSettings;
  appearance?: AppearanceSettings;
  /** Layout: which side panel, whether chat and the bottom panel are showing. */
  layout?: {
    ideActivePanel: AppState['ideActivePanel'];
    rightPanelCollapsed: boolean;
    bottomPanelOpen: boolean;
    bottomPanelHeight: number;
  };
  /** Open tabs by PATH (never content), reopened from disk on the next start. */
  openTabs?: { root: string; paths: string[]; active: string | null };
}

/**
 * The stored colour theme, read before the first render (main.tsx) so the window opens
 * in the right theme instead of flashing the default one first.
 */
export function persistedColorTheme(): EditorSettings['colorTheme'] {
  const store = storage();
  if (store === null) return DEFAULT_EDITOR_SETTINGS.colorTheme;
  try {
    const raw = JSON.parse(store.getItem(STORAGE_KEY) ?? 'null') as Partial<PersistedState> | null;
    return normalizeEditorSettings(raw?.editorSettings).colorTheme;
  } catch {
    return DEFAULT_EDITOR_SETTINGS.colorTheme;
  }
}

/** Read before paint, using the same store and validation as the state provider. */
export function persistedAppearance(): AppearanceSettings {
  try {
    const raw = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? 'null') as Partial<PersistedState> | null;
    return normalizeAppearance(raw?.appearance);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Tabs to reopen at startup, read once by the editor. Paths only. */
export function persistedTabs(): { root: string; paths: string[]; active: string | null } | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = JSON.parse(store.getItem(STORAGE_KEY) ?? 'null') as Partial<PersistedState> | null;
    const tabs = raw?.openTabs;
    if (!tabs || typeof tabs.root !== 'string' || !Array.isArray(tabs.paths)) return null;
    return {
      root: tabs.root,
      paths: tabs.paths.filter((p): p is string => typeof p === 'string').slice(0, 30),
      active: typeof tabs.active === 'string' ? tabs.active : null,
    };
  } catch {
    return null;
  }
}

const PANEL_IDS: ReadonlyArray<Exclude<AppState['ideActivePanel'], null>> = [
  'explorer', 'search', 'git', 'review', 'architecture', 'agents', 'skills', 'settings',
  'timeline', 'console', 'run', 'tests', 'mcp', 'cost', 'benchmarks', 'memory',
  'rescue', 'ui-doctor', 'api-lab', 'hooks', 'debugger', 'briefing', 'egm',
];

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Sidecar key the corrupt `sketch.ui.v1` bytes are preserved under, never discarded. */
const CORRUPT_STORAGE_KEY = `${STORAGE_KEY}.corrupt`;

/**
 * Handle a corrupt persisted-state blob: keep the original bytes under a sidecar key
 * (so nothing the user had is silently lost), clear the main key so the next save
 * writes a clean file, and return an informational notice so the window does not just
 * start blank with no explanation. Every store operation is wrapped: a storage that
 * throws (quota, privacy mode) still yields a clean, noticed start rather than a crash.
 */
function corruptPersistedState(store: Storage, stored: string | null): Partial<AppState> {
  try {
    if (stored !== null) store.setItem(CORRUPT_STORAGE_KEY, stored);
    store.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort: even if we cannot preserve or clear it, a clean start is correct.
  }
  return {
    editorNotice: {
      level: 'info',
      message:
        'Your saved Sketch preferences were unreadable and have been reset. ' +
        'The previous data was kept under "sketch.ui.v1.corrupt" in case you need it.',
    },
  };
}

/** What was stored last time, validated field by field. Unknown or broken data is dropped. */
export function loadPersistedState(): Partial<AppState> {
  const store = storage();
  if (store === null) return {};
  const stored = store.getItem(STORAGE_KEY);
  let raw: unknown;
  try {
    raw = JSON.parse(stored ?? 'null');
  } catch {
    // Corrupt persisted UI state must not brick startup. Preserve the bytes under a
    // sidecar key (never silently discarded), clear the main key so the next save
    // starts clean, and surface a plain notice rather than starting silently blank.
    return corruptPersistedState(store, stored);
  }
  if (raw === null || typeof raw !== 'object') return {};
  const data = raw as Partial<PersistedState>;
  const out: Partial<AppState> = {};
  if (Array.isArray(data.conversations)) {
    out.conversations = data.conversations
      .filter((c): c is Conversation => !!c && typeof c.id === 'string' && Array.isArray(c.messages))
      .slice(0, MAX_CONVERSATIONS);
  }
  if (data.conversationExtras && typeof data.conversationExtras === 'object' && !Array.isArray(data.conversationExtras)) {
    const extras: ConversationExtrasMap = {};
    for (const [id, value] of Object.entries(data.conversationExtras)) {
      if (value !== null && typeof value === 'object') {
        const entry = value as { pinned?: unknown; archived?: unknown; model?: unknown };
        extras[id] = {
          pinned: entry.pinned === true,
          archived: entry.archived === true,
          model: typeof entry.model === 'string' ? entry.model : null,
        };
      }
    }
    out.conversationExtras = extras;
  }
  if (data.messageFeedback && typeof data.messageFeedback === 'object' && !Array.isArray(data.messageFeedback)) {
    const feedback: FeedbackStore = {};
    for (const [id, value] of Object.entries(data.messageFeedback)) {
      if (value !== null && typeof value === 'object') {
        const entry = value as { vote?: unknown; note?: unknown };
        if (entry.vote === 'up' || entry.vote === 'down') {
          feedback[id] = {
            messageId: id,
            vote: entry.vote,
            ...(typeof entry.note === 'string' && entry.note !== '' ? { note: entry.note } : {}),
          };
        }
      }
    }
    out.messageFeedback = feedback;
  }
  if (Array.isArray(data.workspaces)) {
    out.workspaces = data.workspaces.filter(
      (w): w is WorkspaceEntry => !!w && typeof w.path === 'string' && typeof w.name === 'string'
    );
  }
  if (typeof data.projectRoot === 'string' && data.projectRoot !== '') out.projectRoot = data.projectRoot;
  if (data.agentPrefs && typeof data.agentPrefs === 'object') {
    out.agentPrefs = { ...DEFAULT_AGENT_PREFS, ...data.agentPrefs };
    const servers = out.agentPrefs.mcpServers;
    if (servers !== undefined && !(Array.isArray(servers) && servers.every((name) => typeof name === 'string'))) {
      delete out.agentPrefs.mcpServers;
    }
    if (!AGENT_SPEEDS.includes(out.agentPrefs.speed)) out.agentPrefs.speed = DEFAULT_AGENT_PREFS.speed;
  }
  if (data.mode === 'agent' || data.mode === 'ide') out.mode = data.mode;
  if (data.ghostCompletionsEnabled === true) out.ghostCompletionsEnabled = true;
  if (data.editorSettings && typeof data.editorSettings === 'object') {
    out.editorSettings = normalizeEditorSettings(data.editorSettings);
  }
  if (data.appearance !== undefined) out.appearance = normalizeAppearance(data.appearance);
  const layout = data.layout;
  if (layout && typeof layout === 'object') {
    const panel = layout.ideActivePanel;
    if (panel === null || (typeof panel === 'string' && (PANEL_IDS as readonly string[]).includes(panel))) {
      out.ideActivePanel = panel;
      if (panel !== null) out.lastIdePanel = panel;
    }
    if (typeof layout.rightPanelCollapsed === 'boolean') out.rightPanelCollapsed = layout.rightPanelCollapsed;
    if (typeof layout.bottomPanelOpen === 'boolean') out.bottomPanelOpen = layout.bottomPanelOpen;
    if (typeof layout.bottomPanelHeight === 'number' && Number.isFinite(layout.bottomPanelHeight)) {
      out.bottomPanelHeight = Math.min(900, Math.max(120, Math.round(layout.bottomPanelHeight)));
    }
  }
  const tabs = persistedTabs();
  if (tabs !== null && tabs.paths.length > 0) out.restoreTabs = tabs;
  return out;
}

export function savePersistedState(state: AppState): void {
  const store = storage();
  if (store === null) return;
  const payload: PersistedState = {
    conversations: state.conversations.map(c => ({
      ...c,
      title: scrubSecrets(c.title),
      messages: c.messages.map(m => ({ ...m, content: scrubSecrets(m.content) })),
    })),
    conversationExtras: state.conversationExtras,
    messageFeedback: state.messageFeedback,
    activeConversationId: null,
    workspaces: state.workspaces,
    projectRoot: state.projectRoot,
    agentPrefs: state.agentPrefs,
    mode: state.mode,
    ghostCompletionsEnabled: state.ghostCompletionsEnabled,
    editorSettings: state.editorSettings,
    appearance: state.appearance,
    layout: {
      ideActivePanel: state.ideActivePanel,
      rightPanelCollapsed: state.rightPanelCollapsed,
      bottomPanelOpen: state.bottomPanelOpen,
      bottomPanelHeight: state.bottomPanelHeight,
    },
    ...(state.restoreTabs !== null
      ? { openTabs: state.restoreTabs }
      : state.projectRoot !== null
        ? { openTabs: { root: state.projectRoot, paths: state.openFiles, active: state.activeFile } }
        : {}),
  };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota or privacy mode: the session still works, it just will not be remembered.
  }
}

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
        diagnostics: switched ? {} : state.diagnostics,
        // Every terminal starts at the new project's root.
        terminals: switched ? state.terminals.map(t => ({ ...t, cwd: null })) : state.terminals,
        // Tabs saved for another project are not reopened in this one.
        restoreTabs: switched && state.restoreTabs !== null && canonicalPath(state.restoreTabs.root) !== root ? null : state.restoreTabs,
        workspaces: state.workspaces.some(w => w.path === root)
          ? state.workspaces
          : [{ name: basename(root) || 'project', path: root }, ...state.workspaces]
      };
    }
    case 'CLEAR_PROJECT_ROOT': {
      // The open folder is gone (deleted or renamed since it was persisted). Go to the
      // welcome / no-folder state with a plain notice, rather than leaving a dead
      // explorer or a stream of not-found errors. Tabs restored for that vanished root
      // are dropped with it; any files that somehow still carry UNSAVED edits are KEPT
      // (losing unsaved work silently is worse than a stale tab), while clean,
      // disk-backed entries are cleared so no tab points at a path the file layer must
      // refuse. On a fresh start there are typically no dirty buffers, so this clears to
      // an empty editor.
      const dirtyOpen = state.openFiles.filter((p) => state.files[p]?.isDirty);
      const keptFiles: AppState['files'] = {};
      for (const p of dirtyOpen) { const e = state.files[p]; if (e !== undefined) keptFiles[p] = e; }
      return {
        ...state,
        projectRoot: null,
        openFiles: dirtyOpen,
        files: keptFiles,
        activeFile: dirtyOpen.includes(state.activeFile ?? '') ? state.activeFile : (dirtyOpen[0] ?? null),
        diagnostics: {},
        restoreTabs: null,
        terminals: state.terminals.map(t => ({ ...t, cwd: null })),
        editorNotice: action.payload?.notice ?? state.editorNotice,
      };
    }
    case 'CLEAR_MESSAGES':
    case 'NEW_CONVERSATION':
      // A new task is a new conversation. The previous one stays in Recents; only the
      // view is cleared, and the next message opens a fresh record.
      return { ...state, chatMessages: [], activeConversationId: null, newConversationNonce: state.newConversationNonce + 1 };
    case 'SET_ACTIVE_PANEL':
      return {
        ...state,
        ideActivePanel: action.payload,
        lastIdePanel: action.payload ?? state.ideActivePanel ?? state.lastIdePanel,
      };
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
      const { [path]: _problems, ...keptDiagnostics } = state.diagnostics;
      return {
        ...state,
        openFiles: remaining,
        files: keptFiles,
        diagnostics: keptDiagnostics,
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
          // Typing (or undoing) back to exactly what is on disk is clean again, as in
          // every editor. A file deleted on disk stays unsaved whatever it says.
          [path]: {
            ...current,
            content: action.payload.content,
            isDirty: current.deletedOnDisk === true || action.payload.content !== current.diskContent
          }
        }
      };
    }
    case 'FILE_SAVED': {
      const saved = action.payload;
      const path = canonicalPath(typeof saved === 'string' ? saved : saved.path);
      const current = state.files[path];
      if (!current) return state;
      const written = typeof saved === 'string' ? current.content : saved.content;
      // Whatever was written is now the disk's text, and saving was the user's answer
      // to any conflict or deletion that was showing.
      const disk = { diskContent: written, diskVersion: current.diskVersion + 1, deletedOnDisk: false, conflict: null };
      // The user typed while the write was in flight: disk has the older text, so the
      // buffer is still dirty.
      if (written !== current.content) {
        return { ...state, files: { ...state.files, [path]: { ...current, ...disk, isDirty: true } } };
      }
      return {
        ...state,
        files: { ...state.files, [path]: { ...current, ...disk, isDirty: false } }
      };
    }
    case 'ENGINE_WROTE_FILE': {
      const path = canonicalPath(action.payload.path);
      const current = state.files[path];
      // Not open: nothing to reconcile. The editor is not a file cache.
      if (!current) return state;
      const disk = { diskContent: action.payload.content, diskVersion: current.diskVersion + 1, deletedOnDisk: false };
      if (current.isDirty && current.content !== action.payload.content) {
        // The user's unsaved text exists nowhere else; the engine's version is
        // safely on disk and can be re-read on demand. So keep the buffer and flag
        // the divergence (Requirement 15.3).
        return {
          ...state,
          files: {
            ...state.files,
            [path]: {
              ...current,
              ...disk,
              conflict: {
                detectedAt: action.payload.at ?? Date.now(),
                engineBytes: action.payload.bytes ?? 0
              }
            }
          }
        };
      }
      return {
        ...state,
        files: {
          ...state.files,
          [path]: { ...current, ...disk, content: action.payload.content, isDirty: false, conflict: null }
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
          [path]: {
            ...current,
            content: action.payload.content,
            isDirty: false,
            conflict: null,
            diskContent: action.payload.content,
            diskVersion: current.diskVersion + 1,
            deletedOnDisk: false
          }
        }
      };
    }
    case 'DISMISS_CONFLICT': {
      const path = canonicalPath(action.payload);
      const current = state.files[path];
      if (!current || !current.conflict) return state;
      return { ...state, files: { ...state.files, [path]: { ...current, conflict: null } } };
    }
    case 'DISK_CHANGED': {
      const path = canonicalPath(action.payload.path);
      const current = state.files[path];
      if (!current) return state;
      // Started before a save, a reload or an engine write: it describes an older disk.
      if (action.payload.version !== undefined && action.payload.version !== current.diskVersion) return state;
      const content = action.payload.content;
      if (content === current.diskContent && current.deletedOnDisk !== true) return state;
      const disk = { diskContent: content, diskVersion: current.diskVersion + 1, deletedOnDisk: false };
      if (!current.isDirty || current.content === content) {
        // Nothing unsaved to lose (or the disk now says what the buffer says): the
        // tab simply shows the file as it is.
        return {
          ...state,
          files: { ...state.files, [path]: { ...current, ...disk, content, isDirty: false, conflict: null } }
        };
      }
      // Unsaved edits are never overwritten. Keep them and say the file changed.
      return {
        ...state,
        files: {
          ...state.files,
          [path]: {
            ...current,
            ...disk,
            conflict: { detectedAt: action.payload.at ?? Date.now(), engineBytes: 0, source: 'disk' }
          }
        }
      };
    }
    case 'DISK_DELETED': {
      const path = canonicalPath(action.payload.path);
      const current = state.files[path];
      if (!current || current.deletedOnDisk === true) return state;
      if (action.payload.version !== undefined && action.payload.version !== current.diskVersion) return state;
      return {
        ...state,
        files: {
          ...state.files,
          [path]: { ...current, deletedOnDisk: true, diskVersion: current.diskVersion + 1, conflict: null }
        }
      };
    }
    case 'SET_EDITOR_NOTICE':
      return { ...state, editorNotice: action.payload };
    case 'ADD_MESSAGE': {
      const message = action.payload;
      const now = message.timestamp;
      let activeId = state.activeConversationId;
      let conversations = state.conversations;
      if (activeId === null || !conversations.some(c => c.id === activeId)) {
        activeId = `conv-${message.id}`;
        conversations = [
          {
            id: activeId,
            title: titleFor(message),
            messages: [],
            createdAt: now,
            updatedAt: now,
            root: state.projectRoot,
          },
          ...conversations,
        ];
      }
      let updated: ChatMessage[] = [];
      conversations = conversations.map(c => {
        if (c.id !== activeId) return c;
        updated = [...c.messages, message].slice(-MAX_MESSAGES_PER_CONVERSATION);
        const firstUser = c.messages.length === 0 && message.role === 'user';
        return { ...c, messages: updated, updatedAt: now, title: firstUser ? titleFor(message) : c.title };
      });
      conversations = [...conversations]
        .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
        .slice(0, MAX_CONVERSATIONS);
      return { ...state, conversations, activeConversationId: activeId, chatMessages: updated };
    }
    case 'UPDATE_MESSAGE': {
      const { id, patch } = action.payload;
      const apply = (m: ChatMessage): ChatMessage => (m.id === id ? { ...m, ...patch, id: m.id } : m);
      return {
        ...state,
        chatMessages: state.chatMessages.map(apply),
        conversations: state.conversations.map(c =>
          c.messages.some(m => m.id === id) ? { ...c, messages: c.messages.map(apply) } : c
        ),
      };
    }
    case 'CLEAR_CONVERSATIONS':
      return { ...state, conversations: [], activeConversationId: null, chatMessages: [] };
    case 'SET_OFFLINE':
      return state.offline === action.payload ? state : { ...state, offline: action.payload };
    case 'DELETE_CONVERSATION': {
      const remaining = state.conversations.filter(c => c.id !== action.payload);
      const wasActive = state.activeConversationId === action.payload;
      return {
        ...state,
        conversations: remaining,
        activeConversationId: wasActive ? null : state.activeConversationId,
        chatMessages: wasActive ? [] : state.chatMessages,
      };
    }
    case 'RENAME_CONVERSATION': {
      // Trim and cap; an empty title keeps the old one (a blank name helps no one), and an
      // unknown id changes nothing. Only the named conversation's title moves.
      const next = action.payload.title.trim().slice(0, MAX_CONVERSATION_TITLE);
      if (next === '') return state;
      let changed = false;
      const conversations = state.conversations.map(c => {
        if (c.id !== action.payload.id || c.title === next) return c;
        changed = true;
        return { ...c, title: next };
      });
      return changed ? { ...state, conversations } : state;
    }
    case 'PIN_CONVERSATION':
      return { ...state, conversationExtras: pinConversation(state.conversationExtras, action.payload) };
    case 'UNPIN_CONVERSATION':
      return { ...state, conversationExtras: unpinConversation(state.conversationExtras, action.payload) };
    case 'ARCHIVE_CONVERSATION':
      return { ...state, conversationExtras: archiveConversation(state.conversationExtras, action.payload) };
    case 'UNARCHIVE_CONVERSATION':
      return { ...state, conversationExtras: unarchiveConversation(state.conversationExtras, action.payload) };
    case 'SET_CONVERSATION_MODEL': {
      // The allowlist is the configured models only — an unknown id is rejected
      // and the old value stays, so a stale pick can never point a run nowhere.
      const allowed = state.providers.map((provider) => provider.model);
      const result = setPerChatModel(state.conversationExtras, action.payload.id, action.payload.model, allowed);
      return result.ok ? { ...state, conversationExtras: result.extras } : state;
    }
    case 'SET_MESSAGE_FEEDBACK': {
      // Toggle: voting the same way again clears the vote; a different vote
      // switches it. A null vote clears it outright.
      const vote = action.payload.vote;
      const next =
        vote === null
          ? setFeedback(state.messageFeedback, action.payload.messageId, null)
          : toggleFeedback(state.messageFeedback, action.payload.messageId, vote);
      return { ...state, messageFeedback: next };
    }
    case 'EDIT_AND_RESEND': {
      const active = state.conversations.find((c) => c.id === state.activeConversationId);
      if (active === undefined) return state;
      const result = editAndResend(active.messages, action.payload.messageId, action.payload.newText);
      if (!result.ok) return state;
      const conversations = state.conversations.map((c) =>
        c.id === active.id ? { ...c, messages: result.messages, updatedAt: Date.now() } : c,
      );
      return { ...state, conversations, chatMessages: result.messages };
    }
    case 'SET_THINKING':
      return { ...state, isThinking: action.payload.isThinking, thinkingStage: action.payload.stage || '' };
    case 'SET_CONVERSATION': {
      const conversation = state.conversations.find(c => c.id === action.payload);
      if (!conversation) return { ...state, activeConversationId: action.payload };
      return { ...state, activeConversationId: conversation.id, chatMessages: conversation.messages };
    }
    case 'IMPORT_CONVERSATION': {
      const imported = action.payload;
      // A duplicate id (the same file imported twice) gets a fresh id; the messages
      // are capped like any conversation, and the import becomes the active one.
      const id = state.conversations.some(c => c.id === imported.id)
        ? `conv-import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        : imported.id;
      const conversation: Conversation = { ...imported, id, messages: imported.messages.slice(-MAX_MESSAGES_PER_CONVERSATION) };
      const conversations = [conversation, ...state.conversations].slice(0, MAX_CONVERSATIONS);
      return { ...state, conversations, activeConversationId: id, chatMessages: conversation.messages };
    }
    case 'OPEN_SETTINGS':
      return { ...state, settingsOpen: true, settingsTab: action.payload ?? state.settingsTab };
    case 'CLOSE_SETTINGS':
      return { ...state, settingsOpen: false };
    case 'OPEN_CONNECT':
      return { ...state, connectOpen: true, connectProvider: action.payload ?? null };
    case 'CLOSE_CONNECT':
      return { ...state, connectOpen: false, connectProvider: null };
    case 'SET_AGENT_PREFS': {
      const next = { ...state.agentPrefs, ...action.payload };
      // Bounded here so a corrupted stored value cannot produce an unbounded run.
      next.maxIterations = Math.min(100, Math.max(4, Math.round(next.maxIterations || DEFAULT_AGENT_PREFS.maxIterations)));
      next.maxUsd = Math.min(100, Math.max(0.05, Number(next.maxUsd) || DEFAULT_AGENT_PREFS.maxUsd));
      if (!AGENT_MODES.includes(next.mode)) next.mode = DEFAULT_AGENT_PREFS.mode;
      if (!AGENT_SPEEDS.includes(next.speed)) next.speed = DEFAULT_AGENT_PREFS.speed;
      return { ...state, agentPrefs: next };
    }
    case 'OPEN_PALETTE':
      return { ...state, paletteOpen: action.payload };
    case 'CLOSE_PALETTE':
      return { ...state, paletteOpen: null };
    case 'SEED_COMPOSER':
      return {
        ...state,
        composerSeed: {
          text: action.payload.text,
          files: action.payload.files ?? [],
          nonce: (state.composerSeed?.nonce ?? 0) + 1,
          preserveText: action.payload.preserveText,
        },
      };
    case 'CLEAR_COMPOSER_SEED':
      return { ...state, composerSeed: null };
    case 'SET_CURSOR':
      return { ...state, cursor: action.payload };
    case 'FORGET_WORKSPACE':
      return { ...state, workspaces: state.workspaces.filter(w => w.path !== action.payload) };
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
        providerEnvKeys: action.payload.envKeys ?? {},
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
        // A streamed run already holds its output; only an outcome that carries
        // output (the one-shot path) replaces it.
        stdout: outcome.stdout ?? current.stdout,
        stderr: outcome.stderr ?? current.stderr,
        message: outcome.message ?? null,
        durationMs: outcome.durationMs ?? current.durationMs ?? null
      };
      const history = [...state.terminalHistory];
      history[index] = settled;
      return { ...state, terminalHistory: history };
    }
    case 'TERMINAL_CLEARED': {
      if (action.payload === undefined) return { ...state, terminalHistory: [] };
      const first = state.terminals[0]?.id;
      // Running commands stay: clearing the screen does not stop anything.
      return {
        ...state,
        terminalHistory: state.terminalHistory.filter(
          run => (run.terminalId ?? first) !== action.payload || run.status === 'running'
        )
      };
    }
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload };
    case 'SET_GHOST_COMPLETIONS':
      return { ...state, ghostCompletionsEnabled: action.payload };
    case 'TOGGLE_IDE_SIDE_PANEL':
      return state.ideActivePanel === null
        ? { ...state, ideActivePanel: state.lastIdePanel }
        : { ...state, lastIdePanel: state.ideActivePanel, ideActivePanel: null };
    case 'CLOSE_FILES': {
      const closing = new Set(action.payload.map(p => canonicalPath(p)));
      if (closing.size === 0) return state;
      const remaining = state.openFiles.filter(p => !closing.has(p));
      if (remaining.length === state.openFiles.length) return state;
      const files: Record<string, FileEntry> = {};
      for (const [key, entry] of Object.entries(state.files)) if (!closing.has(key)) files[key] = entry;
      let activeFile = state.activeFile;
      if (activeFile !== null && closing.has(activeFile)) {
        // The nearest survivor to the right of the old active tab, else to its left.
        const at = state.openFiles.indexOf(activeFile);
        const right = state.openFiles.slice(at + 1).find(p => !closing.has(p));
        const left = [...state.openFiles.slice(0, at)].reverse().find(p => !closing.has(p));
        activeFile = right ?? left ?? null;
      }
      const diagnostics = { ...state.diagnostics };
      for (const path of closing) delete diagnostics[path];
      return { ...state, openFiles: remaining, files, activeFile, diagnostics };
    }
    case 'MOVE_TAB': {
      const path = canonicalPath(action.payload.path);
      const from = state.openFiles.indexOf(path);
      if (from === -1) return state;
      const tabs = state.openFiles.filter(p => p !== path);
      const to = Math.max(0, Math.min(tabs.length, action.payload.toIndex));
      tabs.splice(to, 0, path);
      return { ...state, openFiles: tabs };
    }
    case 'PATHS_RENAMED': {
      const from = canonicalPath(action.payload.from);
      const to = canonicalPath(action.payload.to);
      // Windows paths compare without case; POSIX paths do not.
      const fold = (p: string) => (/^[A-Za-z]:\//.test(from) ? p.toLowerCase() : p);
      const lowerFrom = fold(from);
      // The renamed path itself, or anything beneath it when it was a folder.
      const remap = (path: string): string | null => {
        const lower = fold(path);
        if (lower === lowerFrom) return to;
        if (lower.startsWith(`${lowerFrom}/`)) return canonicalPath(to + path.slice(from.length));
        return null;
      };
      let changed = false;
      const files: Record<string, FileEntry> = {};
      for (const [key, entry] of Object.entries(state.files)) {
        const next = remap(key);
        if (next === null) {
          files[key] = entry;
          continue;
        }
        changed = true;
        // Unsaved edits travel with the file: the buffer is renamed, not reloaded.
        files[next] = { ...entry, path: next, name: basename(next), language: languageForPath(next) };
      }
      if (!changed) return state;
      const openFiles = state.openFiles.map(p => remap(p) ?? p);
      const activeFile = state.activeFile === null ? null : (remap(state.activeFile) ?? state.activeFile);
      const diagnostics: Record<string, Diagnostic[]> = {};
      for (const [key, list] of Object.entries(state.diagnostics)) if (remap(key) === null) diagnostics[key] = list;
      return { ...state, files, openFiles, activeFile, diagnostics };
    }
    case 'PATHS_DELETED': {
      const target = canonicalPath(action.payload);
      const fold = (p: string) => (/^[A-Za-z]:\//.test(target) ? p.toLowerCase() : p);
      const gone = fold(target);
      const under = (path: string) => {
        const lower = fold(path);
        return lower === gone || lower.startsWith(`${gone}/`);
      };
      const closing = state.openFiles.filter(under);
      if (closing.length === 0) return state;
      return appReducer(state, { type: 'CLOSE_FILES', payload: closing });
    }
    case 'SET_EDITOR_SETTINGS':
      return { ...state, editorSettings: normalizeEditorSettings({ ...state.editorSettings, ...action.payload }) };
    case 'SET_APPEARANCE':
      return { ...state, appearance: normalizeAppearance({ ...state.appearance, ...action.payload }) };
    case 'TOGGLE_FOCUS_MODE':
      return { ...state, focusMode: !state.focusMode };
    case 'FOCUS_COMPOSER':
      return { ...state, composerFocusNonce: state.composerFocusNonce + 1, focusMode: false,
        ...(state.mode === 'ide' ? { rightPanelCollapsed: false } : { agentView: 'new_task' }) };
    case 'APPLY_LAYOUT_PRESET':
      return {
        ...state, mode: 'ide', focusMode: false,
        ideActivePanel: action.payload === 'review' ? 'review' : action.payload === 'write' ? null : 'explorer',
        lastIdePanel: action.payload === 'review' ? 'review' : 'explorer',
        rightPanelCollapsed: action.payload === 'write',
        bottomPanelOpen: action.payload === 'balanced',
      };
    case 'IMPORT_SETTINGS': {
      // The payload is already validated and normalised by settingsIo.parseSettingsImport,
      // but it is re-bounded here so this reducer is safe on its own: the editor settings
      // go through the same normaliser, and the agent fields through the same clamps as
      // SET_AGENT_PREFS. The agent's mcpServers (user's own servers) is carried over
      // untouched — an import never names or changes a server. Provider config and keys
      // are not in this state and are not touched.
      const editorSettings = normalizeEditorSettings(action.payload.editor);
      const nextAgent = { ...state.agentPrefs, ...action.payload.agent };
      nextAgent.maxIterations = Math.min(100, Math.max(4, Math.round(nextAgent.maxIterations || DEFAULT_AGENT_PREFS.maxIterations)));
      nextAgent.maxUsd = Math.min(100, Math.max(0.05, Number(nextAgent.maxUsd) || DEFAULT_AGENT_PREFS.maxUsd));
      if (!AGENT_MODES.includes(nextAgent.mode)) nextAgent.mode = DEFAULT_AGENT_PREFS.mode;
      return { ...state, editorSettings, agentPrefs: nextAgent,
        appearance: action.payload.appearance === undefined ? state.appearance : normalizeAppearance(action.payload.appearance) };
    }
    case 'REVEAL_IN_EDITOR': {
      const path = canonicalPath(action.payload.path);
      return {
        ...state,
        revealRequest: {
          path,
          line: Math.max(1, Math.floor(action.payload.line)),
          column: Math.max(1, Math.floor(action.payload.column ?? 1)),
          nonce: (state.revealRequest?.nonce ?? 0) + 1,
        },
      };
    }
    case 'SET_DIAGNOSTICS': {
      const path = canonicalPath(action.payload.path);
      const previous = state.diagnostics[path];
      if ((previous === undefined || previous.length === 0) && action.payload.diagnostics.length === 0) return state;
      const diagnostics = { ...state.diagnostics };
      if (action.payload.diagnostics.length === 0) delete diagnostics[path];
      else diagnostics[path] = action.payload.diagnostics;
      return { ...state, diagnostics };
    }
    case 'SET_BOTTOM_PANEL_TAB':
      return { ...state, bottomPanelTab: action.payload };
    case 'SHOW_BOTTOM_PANEL':
      return { ...state, bottomPanelOpen: true, bottomPanelTab: action.payload };
    case 'TERMINAL_NEW': {
      const used = new Set(state.terminals.map(t => t.id));
      let n = state.terminals.length + 1;
      while (used.has(`term-${n}`)) n += 1;
      const requested = action.payload?.id;
      const id = requested !== undefined && !used.has(requested) ? requested : `term-${n}`;
      const kind = action.payload?.kind ?? (state.terminalShellsAvailable ? 'shell' : 'commands');
      const wanted = action.payload?.title ?? `Terminal ${n}`;
      const titles = new Set(state.terminals.map(t => t.title));
      let title = wanted;
      for (let k = 2; titles.has(title); k += 1) title = `${wanted} ${k}`;
      const tab: TerminalTab = {
        id,
        title,
        cwd: action.payload?.cwd ?? null,
        kind,
        ...(kind === 'shell' ? { profileId: action.payload?.profileId ?? null } : {}),
      };
      return {
        ...state,
        terminals: [...state.terminals, tab],
        activeTerminalId: tab.id,
        bottomPanelOpen: true,
        bottomPanelTab: 'terminal',
      };
    }
    case 'TERMINAL_SHELLS_AVAILABLE': {
      if (state.terminalShellsAvailable === action.payload) return state;
      if (!action.payload) return { ...state, terminalShellsAvailable: false };
      // A tab nothing has run in yet becomes a real shell; one with a history keeps it.
      const first = state.terminals[0]?.id;
      const used = new Set(state.terminalHistory.map(run => run.terminalId ?? first));
      const terminals = state.terminals.map(t =>
        t.kind === undefined && !used.has(t.id) ? { ...t, kind: 'shell' as const, profileId: null } : t,
      );
      return { ...state, terminalShellsAvailable: true, terminals };
    }
    case 'TERMINAL_RETITLE': {
      const { id } = action.payload;
      const wanted = action.payload.title.trim();
      if (wanted === '' || !state.terminals.some(t => t.id === id)) return state;
      // Two PowerShell tabs read "Windows PowerShell" and "Windows PowerShell 2".
      const taken = new Set(state.terminals.filter(t => t.id !== id).map(t => t.title));
      let title = wanted;
      for (let n = 2; taken.has(title); n += 1) title = `${wanted} ${n}`;
      if (state.terminals.some(t => t.id === id && t.title === title)) return state;
      return { ...state, terminals: state.terminals.map(t => (t.id === id ? { ...t, title } : t)) };
    }
    case 'TERMINAL_CLOSE': {
      const first = state.terminals[0]?.id;
      const runs = state.terminalHistory.filter(run => (run.terminalId ?? first) !== action.payload);
      const remaining = state.terminals.filter(t => t.id !== action.payload);
      if (remaining.length === state.terminals.length) return state;
      // There is always a terminal to type into.
      const terminals: TerminalTab[] =
        remaining.length > 0
          ? remaining
          : [
              state.terminalShellsAvailable
                ? { id: 'term-1', title: 'Terminal 1', cwd: null, kind: 'shell', profileId: null }
                : { id: 'term-1', title: 'Terminal 1', cwd: null },
            ];
      const activeTerminalId = terminals.some(t => t.id === state.activeTerminalId)
        ? state.activeTerminalId
        : terminals[terminals.length - 1]!.id;
      return { ...state, terminals, activeTerminalId, terminalHistory: runs };
    }
    case 'TERMINAL_SELECT':
      return state.terminals.some(t => t.id === action.payload) ? { ...state, activeTerminalId: action.payload } : state;
    case 'TERMINAL_CD':
      return {
        ...state,
        terminals: state.terminals.map(t => (t.id === action.payload.terminalId ? { ...t, cwd: action.payload.cwd } : t)),
      };
    case 'TERMINAL_RUN_OUTPUT': {
      const { id, stdout, stderr } = action.payload;
      const index = state.terminalHistory.findIndex(run => run.id === id);
      if (index === -1) return state;
      const current = state.terminalHistory[index]!;
      const history = [...state.terminalHistory];
      history[index] = { ...current, stdout: appendCapped(current.stdout, stdout), stderr: appendCapped(current.stderr, stderr) };
      return { ...state, terminalHistory: history };
    }
    case 'TERMINAL_RUN_SESSION': {
      const index = state.terminalHistory.findIndex(run => run.id === action.payload.id);
      if (index === -1) return state;
      const history = [...state.terminalHistory];
      history[index] = {
        ...history[index]!,
        sessionId: action.payload.sessionId,
        ...(action.payload.cwd !== undefined ? { cwd: action.payload.cwd } : {}),
      };
      return { ...state, terminalHistory: history };
    }
    case 'TABS_RESTORED':
      return { ...state, restoreTabs: null };
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
  /**
   * Restore conversations, folders and preferences from local storage and keep them
   * there. ON only for the real window (App.tsx); a test tree stays hermetic.
   */
  persist?: boolean;
}> = ({ children, initial, persist = false }) => {
  const [state, dispatch] = useReducer(appReducer, undefined, (): AppState => {
    const base = initial ? { ...initialState, ...initial } : initialState;
    if (!persist) return base;
    const restored = loadPersistedState();
    const root = restored.projectRoot ?? null;
    return {
      ...base,
      ...restored,
      projectRoot: root === null ? base.projectRoot : canonicalPath(root),
      // Reopening the app opens a new task; the last conversation is one click away.
      activeConversationId: null,
      chatMessages: [],
    };
  });

  // Only what is persisted can make a save worthwhile. Keyed on those slices, so typing
  // in the editor (file content) and moving the caret no longer re-serialize every
  // conversation a quarter-second after each pause.
  const latestState = useRef(state);
  latestState.current = state;
  useEffect(() => {
    if (!persist) return;
    const timer = setTimeout(() => savePersistedState(latestState.current), 250);
    return () => clearTimeout(timer);
  }, [
    persist,
    state.conversations,
    state.workspaces,
    state.projectRoot,
    state.agentPrefs,
    state.mode,
    state.ghostCompletionsEnabled,
    state.editorSettings,
    state.appearance,
    state.ideActivePanel,
    state.rightPanelCollapsed,
    state.bottomPanelOpen,
    state.bottomPanelHeight,
    state.openFiles,
    state.activeFile,
    state.restoreTabs,
  ]);

  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        <ComposerDraftsProvider draftKey={state.activeConversationId ?? `new:${state.projectRoot ?? ''}:${state.newConversationNonce}`}>
          {children}
        </ComposerDraftsProvider>
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
