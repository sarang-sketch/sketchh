import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ACCENT_PRESETS, APPEARANCE_EVENT, DEFAULT_APPEARANCE, appearanceTokens, contrastRatio, normalizeAppearance } from './appearance'
import { ColorThemeController } from './colorTheme'
import { AppearanceSettings } from '../components/settings/AppearanceSettings'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { AppStateProvider, appReducer, initialAppState, loadPersistedState, persistedAppearance, savePersistedState, useAppState, type AppState } from '../state/AppState'
import { diffSettings, parseSettingsImport, serializeSettingsExport } from '../settingsIo'
import { createMonacoDouble } from '../editor/monacoDouble'
import { prepareMonaco } from '../editor/monacoSetup'

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('style'); document.documentElement.dataset.theme = 'dark' })
afterEach(() => { cleanup(); localStorage.clear(); document.documentElement.removeAttribute('style'); document.documentElement.dataset.theme = 'dark' })

describe('portable appearance preferences', () => {
  it('rejects CSS injection and corrupt values, and bounds layout and typography', () => {
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE)
    expect(normalizeAppearance([])).toEqual(DEFAULT_APPEARANCE)
    const normalized = normalizeAppearance({ accentColor: 'red; background: url(/invalid-accent)', surface: 'missing', uiFont: 'url(test)', density: 5, uiFontSize: 900, sidebarWidth: -40, showStatusBar: 'false', reduceMotion: true, unknown: 'ignored' })
    expect(normalized).toEqual({ ...DEFAULT_APPEARANCE, uiFontSize: 16, sidebarWidth: 200, reduceMotion: true })
    expect(normalizeAppearance({ uiFontSize: NaN, sidebarWidth: Infinity })).toEqual(DEFAULT_APPEARANCE)
    expect(normalizeAppearance({ accentColor: '#AbCdEF' }).accentColor).toBe('#abcdef')
  })

  it('keeps text and accent labels readable on every surface, including arbitrary colors', () => {
    const accents = [...ACCENT_PRESETS.map((p) => p.color), '#000000', '#ffffff', '#0000ff', '#ffff00', '#ff00ff', '#00ff00']
    for (const scheme of ['dark', 'light'] as const) for (const surface of ['graphite', 'midnight', 'warm'] as const) for (const accentColor of accents) {
      const tokens = appearanceTokens({ ...DEFAULT_APPEARANCE, surface, accentColor }, scheme)
      for (const bg of ['--bg-primary', '--bg-secondary', '--bg-surface', '--bg-elevated', '--bg-hover']) {
        for (const fg of ['--accent', '--accent-hover', '--text-muted', '--text-secondary', '--text-primary']) {
          expect(contrastRatio(tokens[fg]!, tokens[bg]!), `${scheme}/${surface}/${accentColor}/${fg}/${bg}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
    // Mid-grey fills expose the contrast gap between off-black and white labels.
    for (let channel = 0; channel <= 255; channel++) {
      const color = '#' + channel.toString(16).padStart(2, '0').repeat(3)
      const tokens = appearanceTokens({ ...DEFAULT_APPEARANCE, accentColor: color }, 'dark')
      expect(contrastRatio(tokens['--text-on-accent']!, color)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(tokens['--text-on-accent']!, tokens['--accent-fill-hover']!)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('survives restarting, exports and imports, while older exports keep the current appearance', () => {
    const state = appReducer(initialAppState, { type: 'SET_APPEARANCE', payload: { accentColor: '#a989ff', activityBar: 'top', agentPosition: 'left', sidebarPosition: 'right', density: 'compact', canvas: 'grid', reduceMotion: true } })
    savePersistedState(state)
    expect(persistedAppearance()).toEqual(state.appearance)
    expect(loadPersistedState().appearance).toEqual(state.appearance)
    const parsed = parseSettingsImport(serializeSettingsExport(state.editorSettings, state.agentPrefs, state.appearance))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(appReducer(initialAppState, { type: 'IMPORT_SETTINGS', payload: parsed.parsed }).appearance).toEqual(state.appearance)
    expect(diffSettings({ editor: state.editorSettings, agent: state.agentPrefs, appearance: DEFAULT_APPEARANCE }, parsed.parsed)).toContainEqual({ section: 'Appearance', label: 'Agent panel position', from: 'right', to: 'left' })
    const legacy = parseSettingsImport(serializeSettingsExport(state.editorSettings, state.agentPrefs))
    if (!legacy.ok) throw new Error(legacy.error)
    expect(appReducer(state, { type: 'IMPORT_SETTINGS', payload: legacy.parsed }).appearance).toEqual(state.appearance)
    expect(JSON.parse(localStorage.getItem('sketch.ui.v1')!)).not.toHaveProperty('newConversationNonce')
  })

  it('rejects malformed imports without changing preferences', () => {
    const exported = JSON.parse(serializeSettingsExport(initialAppState.editorSettings, initialAppState.agentPrefs))
    expect(parseSettingsImport(JSON.stringify({ ...exported, appearance: [] })).ok).toBe(false)
    localStorage.setItem('sketch.ui.v1', '{bad json')
    expect(persistedAppearance()).toEqual(DEFAULT_APPEARANCE)
  })
})

describe('live appearance controls', () => {
  it('recolors open editors, notifies terminals, rearranges panes and resets on request', async () => {
    const user = userEvent.setup()
    const monaco = createMonacoDouble()
    prepareMonaco(monaco.api)
    let observed: AppState = initialAppState
    const Probe = () => { observed = useAppState(); return null }
    render(<AppStateProvider><ConfirmProvider><ColorThemeController /><AppearanceSettings /><Probe /></ConfirmProvider></AppStateProvider>)
    const palettes: string[] = []
    const onAppearance = () => palettes.push(document.documentElement.style.getPropertyValue('--bg-primary'))
    window.addEventListener(APPEARANCE_EVENT, onAppearance)
    try {
      await user.selectOptions(screen.getByLabelText('Surface palette'), 'midnight')
      expect(palettes.at(-1)).toBe('#141920')
      expect(monaco.definedThemes.get('sketch-dark')?.colors['editor.background']).toBe('#141920')
      await user.click(screen.getByRole('button', { name: 'Light' }))
      fireEvent.change(screen.getByLabelText('Custom accent color'), { target: { value: '#008877' } })
      const tokens = appearanceTokens(observed.appearance, 'light')
      expect(monaco.theme).toBe('sketch-light')
      expect(monaco.definedThemes.get('sketch-light')?.colors['editorCursor.foreground']).toBe(tokens['--accent'])
      expect(document.documentElement.style.getPropertyValue('--accent-fill')).toBe('#008877')
      await user.selectOptions(screen.getByLabelText('Agent panel position'), 'left')
      await user.selectOptions(screen.getByLabelText('Project sidebar position'), 'right')
      await user.selectOptions(screen.getByLabelText('Interface density'), 'compact')
      await user.click(screen.getByRole('switch', { name: 'Reduce motion' }))
      expect(observed.appearance).toMatchObject({ agentPosition: 'left', sidebarPosition: 'right', density: 'compact', reduceMotion: true })
      expect(document.documentElement.dataset.motion).toBe('reduced')
      await user.click(screen.getByRole('button', { name: 'Reset appearance' }))
      await user.click(within(screen.getByRole('alertdialog', { name: 'Reset appearance?' })).getByRole('button', { name: 'Reset appearance' }))
      expect(observed.appearance).toEqual(DEFAULT_APPEARANCE)
    } finally { window.removeEventListener(APPEARANCE_EVENT, onAppearance) }
  })
})

