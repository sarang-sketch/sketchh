// Settings export / import — W9 invariant 8b.
//
// Two SMALL, real features with no new native file permission, built on the clipboard +
// a validated paste (the same pattern as UserMcpServers' "Import JSON"):
//   - export: a versioned, KEY-FREE JSON of the UI settings (editor, agent, theme);
//   - import: validate a pasted blob against this schema, show exactly what will change,
//     confirm, apply — and reject anything else with a specific error.
//
// It never contains or accepts an API key, and never touches provider config: the
// exported shape has no provider/key fields, and the importer only ever produces an
// `editorSettings` patch and an `agentPrefs` patch (bounded by the reducer's own
// normalisers). The whole feature lives in the UI-settings store (localStorage
// 'sketch.ui.v1'); providers.json and the OS credential store are untouched.

import {
  DEFAULT_AGENT_PREFS,
  DEFAULT_EDITOR_SETTINGS,
  normalizeEditorSettings,
  type AgentPrefs,
  type EditorSettings,
} from './state/AppState'
import { DEFAULT_APPEARANCE, normalizeAppearance, type AppearanceSettings } from './styles/appearance'

/** The current export format version. Bumped only if the shape changes incompatibly. */
export const SETTINGS_EXPORT_VERSION = 1

/** The agent fields that travel in an export (no keys, no MCP server names, no provider). */
export type ExportableAgentPrefs = Pick<AgentPrefs, 'mode' | 'autoApply' | 'maxIterations' | 'maxUsd' | 'verifyChanges'>

export interface SettingsExport {
  /** Identifies the blob as a Sketch settings export (so a stray paste is rejected). */
  kind: 'sketch-settings'
  version: number
  editor: EditorSettings
  agent: ExportableAgentPrefs
  appearance?: AppearanceSettings
}

/** Build the KEY-FREE export object from the current settings. */
export function buildSettingsExport(editor: EditorSettings, agent: AgentPrefs, appearance?: AppearanceSettings): SettingsExport {
  return {
    kind: 'sketch-settings',
    version: SETTINGS_EXPORT_VERSION,
    editor: normalizeEditorSettings(editor),
    ...(appearance === undefined ? {} : { appearance: normalizeAppearance(appearance) }),
    agent: {
      mode: agent.mode,
      autoApply: agent.autoApply,
      maxIterations: agent.maxIterations,
      maxUsd: agent.maxUsd,
      verifyChanges: agent.verifyChanges,
    },
  }
}

/** The pretty-printed JSON a user copies. */
export function serializeSettingsExport(editor: EditorSettings, agent: AgentPrefs, appearance?: AppearanceSettings): string {
  return JSON.stringify(buildSettingsExport(editor, agent, appearance), null, 2)
}

/** One line of the change preview shown before an import is applied. */
export interface SettingsChange {
  /** "Editor" or "Agent". */
  section: 'Editor' | 'Agent' | 'Appearance'
  /** The human label of the field. */
  label: string
  /** The current value, as a string. */
  from: string
  /** The incoming value, as a string. */
  to: string
}

export interface ParsedSettingsImport {
  editor: EditorSettings
  agent: ExportableAgentPrefs
  appearance?: AppearanceSettings
}

export type SettingsImportResult =
  | { ok: true; parsed: ParsedSettingsImport }
  | { ok: false; error: string }

const AGENT_MODES = ['ask', 'agent', 'auto'] as const

/**
 * Parse and validate a pasted blob. On success the returned settings are already
 * normalised (bounded) so applying them cannot break the app. On failure the error
 * names exactly what was wrong — never a silent swallow, never a key accepted.
 */
export function parseSettingsImport(text: string): SettingsImportResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: 'Paste the exported settings JSON first.' }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'That is not valid JSON. Paste the text you copied with “Copy settings”.' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'The settings must be a JSON object.' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.kind !== 'sketch-settings') {
    return { ok: false, error: 'This is not a Sketch settings export (its "kind" is not "sketch-settings").' }
  }
  if (typeof obj.version !== 'number' || obj.version > SETTINGS_EXPORT_VERSION) {
    return {
      ok: false,
      error: `This export is version ${String(obj.version)}, which this build does not understand (it reads up to version ${SETTINGS_EXPORT_VERSION}).`,
    }
  }
  // Reject anything that smells of a key, so an import can never carry one in.
  if (/\b(api[_-]?key|secret|token|bearer|sk-)/i.test(trimmed)) {
    return {
      ok: false,
      error: 'This blob contains a key-shaped field. Settings exports never include keys — refusing to import it.',
    }
  }
  if (typeof obj.editor !== 'object' || obj.editor === null) {
    return { ok: false, error: 'The "editor" section is missing or is not an object.' }
  }
  if (typeof obj.agent !== 'object' || obj.agent === null) {
    return { ok: false, error: 'The "agent" section is missing or is not an object.' }
  }
  // Normalise the editor settings (every field bounded; unknown fields dropped).
  const editor = normalizeEditorSettings(obj.editor as Partial<EditorSettings>)
  // Normalise the agent fields the same way the reducer would, so no out-of-range value
  // survives and no extra field (e.g. mcpServers) is carried in.
  const a = obj.agent as Record<string, unknown>
  const mode = (AGENT_MODES as readonly string[]).includes(a.mode as string)
    ? (a.mode as ExportableAgentPrefs['mode'])
    : DEFAULT_AGENT_PREFS.mode
  const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  const agent: ExportableAgentPrefs = {
    mode,
    autoApply: bool(a.autoApply, DEFAULT_AGENT_PREFS.autoApply),
    maxIterations: Math.round(num(a.maxIterations, 4, 100, DEFAULT_AGENT_PREFS.maxIterations)),
    maxUsd: num(a.maxUsd, 0.05, 100, DEFAULT_AGENT_PREFS.maxUsd),
    verifyChanges: bool(a.verifyChanges, DEFAULT_AGENT_PREFS.verifyChanges),
  }
  if (obj.appearance !== undefined && (obj.appearance === null || typeof obj.appearance !== 'object' || Array.isArray(obj.appearance))) {
    return { ok: false, error: 'The "appearance" section must be an object.' }
  }
  return { ok: true, parsed: { editor, agent, ...(obj.appearance === undefined ? {} : { appearance: normalizeAppearance(obj.appearance) }) } }
}

const EDITOR_LABELS: Record<keyof EditorSettings, string> = {
  fontSize: 'Font size',
  tabSize: 'Tab size',
  insertSpaces: 'Indent with spaces',
  wordWrap: 'Word wrap',
  minimap: 'Minimap',
  lineNumbers: 'Line numbers',
  autoSave: 'Auto save',
  formatOnSave: 'Format on save',
  renderWhitespace: 'Show whitespace',
  stickyScroll: 'Sticky scroll',
  bracketPairColorization: 'Bracket pair colours',
  languageFeatures: 'Language features',
  colorTheme: 'Color theme',
}

const AGENT_LABELS: Record<keyof ExportableAgentPrefs, string> = {
  mode: 'Mode',
  autoApply: 'Apply edits automatically',
  maxIterations: 'Maximum steps per run',
  maxUsd: 'Spend ceiling per run (USD)',
  verifyChanges: "Check changes with the project's tests",
}

const show = (v: unknown): string => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v))

const APPEARANCE_LABELS: Record<keyof AppearanceSettings, string> = {
  accentColor: 'Accent color', surface: 'Surface palette', density: 'Interface density', uiFontSize: 'Interface text size',
  uiFont: 'Interface font', sidebarPosition: 'Project sidebar position', agentPosition: 'Agent panel position',
  activityBar: 'Activity bar position', canvas: 'Cowork background', chatWidth: 'Conversation width',
  sidebarWidth: 'Cowork sidebar width', showStatusBar: 'Status bar', showTips: 'Welcome suggestions', reduceMotion: 'Reduce motion',
}

/** The list of fields that differ between the current settings and the import. */
export function diffSettings(
  current: { editor: EditorSettings; agent: AgentPrefs; appearance?: AppearanceSettings },
  next: ParsedSettingsImport,
): SettingsChange[] {
  const changes: SettingsChange[] = []
  if (next.appearance !== undefined) {
    const previous = current.appearance ?? DEFAULT_APPEARANCE
    for (const key of Object.keys(APPEARANCE_LABELS) as Array<keyof AppearanceSettings>) {
      if (previous[key] !== next.appearance[key]) changes.push({ section: 'Appearance', label: APPEARANCE_LABELS[key], from: show(previous[key]), to: show(next.appearance[key]) })
    }
  }
  for (const key of Object.keys(EDITOR_LABELS) as Array<keyof EditorSettings>) {
    if (current.editor[key] !== next.editor[key]) {
      changes.push({ section: 'Editor', label: EDITOR_LABELS[key], from: show(current.editor[key]), to: show(next.editor[key]) })
    }
  }
  for (const key of Object.keys(AGENT_LABELS) as Array<keyof ExportableAgentPrefs>) {
    if (current.agent[key] !== next.agent[key]) {
      changes.push({ section: 'Agent', label: AGENT_LABELS[key], from: show(current.agent[key]), to: show(next.agent[key]) })
    }
  }
  return changes
}

// Guard: a default export is never a settings export (keeps the shape honest for tests).
void DEFAULT_EDITOR_SETTINGS
