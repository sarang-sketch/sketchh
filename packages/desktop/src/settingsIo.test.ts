// W9 invariant 8b — settings export/import is real, key-free, and validated.
import { describe, it, expect } from 'vitest'
import {
  buildSettingsExport,
  serializeSettingsExport,
  parseSettingsImport,
  diffSettings,
  SETTINGS_EXPORT_VERSION,
} from './settingsIo'
import { DEFAULT_AGENT_PREFS, DEFAULT_EDITOR_SETTINGS, type AgentPrefs } from './state/AppState'

const agent: AgentPrefs = { ...DEFAULT_AGENT_PREFS, mcpServers: ['my-server'] }

describe('settings export', () => {
  it('is versioned and key-free, and never carries provider or key fields', () => {
    const out = buildSettingsExport(DEFAULT_EDITOR_SETTINGS, agent)
    expect(out.kind).toBe('sketch-settings')
    expect(out.version).toBe(SETTINGS_EXPORT_VERSION)
    const json = JSON.stringify(out)
    // No key-shaped or provider fields leak into the export.
    expect(json).not.toMatch(/apiKey|api_key|secret|providers|baseUrl|mcpServers|token/i)
    // The agent subset is exactly the five preference fields, not the MCP server list.
    expect(Object.keys(out.agent).sort()).toEqual(
      ['autoApply', 'maxIterations', 'maxUsd', 'mode', 'verifyChanges'].sort(),
    )
  })

  it('serializes to pretty JSON that round-trips through parse', () => {
    const text = serializeSettingsExport({ ...DEFAULT_EDITOR_SETTINGS, fontSize: 16 }, agent)
    const result = parseSettingsImport(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.parsed.editor.fontSize).toBe(16)
  })
})

describe('settings import validation', () => {
  it('rejects empty, non-JSON and non-object input with specific errors', () => {
    expect(parseSettingsImport('')).toMatchObject({ ok: false })
    expect(parseSettingsImport('not json {')).toMatchObject({ ok: false })
    const arr = parseSettingsImport('[1,2,3]')
    expect(arr.ok).toBe(false)
    if (!arr.ok) expect(arr.error).toMatch(/object/i)
  })

  it('rejects a blob whose kind is not a sketch settings export', () => {
    const r = parseSettingsImport(JSON.stringify({ kind: 'something-else', version: 1, editor: {}, agent: {} }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not a Sketch settings export/i)
  })

  it('rejects a future version it cannot understand', () => {
    const r = parseSettingsImport(
      JSON.stringify({ kind: 'sketch-settings', version: SETTINGS_EXPORT_VERSION + 5, editor: {}, agent: {} }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/version/i)
  })

  it('refuses a blob carrying a key-shaped field', () => {
    const r = parseSettingsImport(
      JSON.stringify({ kind: 'sketch-settings', version: 1, editor: {}, agent: {}, apiKey: 'sk-abc123' }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/key-shaped|keys/i)
  })

  it('normalises and bounds the imported values (an out-of-range value is clamped, not trusted)', () => {
    const r = parseSettingsImport(
      JSON.stringify({
        kind: 'sketch-settings',
        version: 1,
        editor: { fontSize: 9999, tabSize: 4, colorTheme: 'light', bogus: 'x' },
        agent: { mode: 'ask', maxIterations: 10000, maxUsd: -5, autoApply: false, verifyChanges: false },
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.parsed.editor.fontSize).toBeLessThanOrEqual(32)
    expect(r.parsed.editor.colorTheme).toBe('light')
    expect(r.parsed.agent.maxIterations).toBeLessThanOrEqual(100)
    expect(r.parsed.agent.maxUsd).toBeGreaterThanOrEqual(0.05)
    expect(r.parsed.agent.mode).toBe('ask')
    // No stray field survives on the agent subset.
    expect(Object.keys(r.parsed.agent).sort()).toEqual(
      ['autoApply', 'maxIterations', 'maxUsd', 'mode', 'verifyChanges'].sort(),
    )
  })
})

describe('settings diff', () => {
  it('lists exactly the fields that differ, by section and label', () => {
    const current = { editor: DEFAULT_EDITOR_SETTINGS, agent: DEFAULT_AGENT_PREFS }
    const next = {
      editor: { ...DEFAULT_EDITOR_SETTINGS, fontSize: 18, colorTheme: 'light' as const },
      agent: { mode: 'auto' as const, autoApply: false, maxIterations: DEFAULT_AGENT_PREFS.maxIterations, maxUsd: DEFAULT_AGENT_PREFS.maxUsd, verifyChanges: DEFAULT_AGENT_PREFS.verifyChanges },
    }
    const changes = diffSettings(current, next)
    const labels = changes.map((c) => c.label)
    expect(labels).toContain('Font size')
    expect(labels).toContain('Color theme')
    expect(labels).toContain('Mode')
    expect(labels).toContain('Apply edits automatically')
    // Unchanged fields are not listed.
    expect(labels).not.toContain('Tab size')
    expect(labels).not.toContain('Maximum steps per run')
  })

  it('reports no changes when the import matches the current settings', () => {
    const current = { editor: DEFAULT_EDITOR_SETTINGS, agent: DEFAULT_AGENT_PREFS }
    const parsed = parseSettingsImport(serializeSettingsExport(DEFAULT_EDITOR_SETTINGS, DEFAULT_AGENT_PREFS))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(diffSettings(current, parsed.parsed)).toEqual([])
  })
})
