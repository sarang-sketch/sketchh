// W9 invariants 2, 3, 4, 8 — settings persist, take effect through the reducer, reset
// to defaults, import is applied and bounded, and no key ever reaches localStorage.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appReducer,
  initialAppState,
  loadPersistedState,
  savePersistedState,
  DEFAULT_AGENT_PREFS,
  DEFAULT_EDITOR_SETTINGS,
  type AppState,
} from './AppState'

beforeEach(() => {
  window.localStorage.clear()
})

describe('a corrupt sketch.ui.v1 never bricks startup (W10 invariant 5)', () => {
  it('preserves the corrupt bytes, resets to a clean start, and surfaces a plain notice', () => {
    window.localStorage.setItem('sketch.ui.v1', '{ not valid json ]')

    const restored = loadPersistedState()

    // Clean start: none of the broken data leaks in; an info notice explains the reset.
    expect(restored.conversations).toBeUndefined()
    expect(restored.editorNotice).toBeDefined()
    expect(restored.editorNotice?.level).toBe('info')
    expect(restored.editorNotice?.message).toMatch(/unreadable/i)
    // The bytes were preserved (never silently discarded) and the main key cleared.
    expect(window.localStorage.getItem('sketch.ui.v1.corrupt')).toBe('{ not valid json ]')
    expect(window.localStorage.getItem('sketch.ui.v1')).toBeNull()
  })

  it('a missing key is the honest empty state, not a notice', () => {
    const restored = loadPersistedState()
    expect(restored.editorNotice).toBeUndefined()
    expect(restored.conversations).toBeUndefined()
  })
})

describe('editor + agent settings persist and reset', () => {
  it('a changed editor setting survives a save/restore round-trip (invariant 2a)', () => {
    let state = appReducer(initialAppState, { type: 'SET_EDITOR_SETTINGS', payload: { fontSize: 20 } })
    savePersistedState(state)
    const restored = loadPersistedState()
    expect(restored.editorSettings?.fontSize).toBe(20)
  })

  it('a changed agent pref survives a round-trip', () => {
    const state = appReducer(initialAppState, { type: 'SET_AGENT_PREFS', payload: { maxUsd: 7.5 } })
    savePersistedState(state)
    expect(loadPersistedState().agentPrefs?.maxUsd).toBe(7.5)
  })

  it('Restore defaults returns the editor settings to their defaults (invariant 3)', () => {
    let state = appReducer(initialAppState, { type: 'SET_EDITOR_SETTINGS', payload: { fontSize: 20, minimap: false } })
    expect(state.editorSettings.fontSize).toBe(20)
    state = appReducer(state, { type: 'SET_EDITOR_SETTINGS', payload: DEFAULT_EDITOR_SETTINGS })
    expect(state.editorSettings).toEqual(DEFAULT_EDITOR_SETTINGS)
  })
})

describe('IMPORT_SETTINGS reducer (invariant 8b)', () => {
  it('applies the imported editor + agent values', () => {
    const state = appReducer(initialAppState, {
      type: 'IMPORT_SETTINGS',
      payload: {
        editor: { ...DEFAULT_EDITOR_SETTINGS, fontSize: 17, colorTheme: 'light' },
        agent: { mode: 'ask', autoApply: false, maxIterations: 12, maxUsd: 1, verifyChanges: false },
      },
    })
    expect(state.editorSettings.fontSize).toBe(17)
    expect(state.editorSettings.colorTheme).toBe('light')
    expect(state.agentPrefs.mode).toBe('ask')
    expect(state.agentPrefs.autoApply).toBe(false)
  })

  it("keeps the user's own MCP server list (an import never names a server)", () => {
    const withServers: AppState = { ...initialAppState, agentPrefs: { ...DEFAULT_AGENT_PREFS, mcpServers: ['srv-a'] } }
    const state = appReducer(withServers, {
      type: 'IMPORT_SETTINGS',
      payload: {
        editor: DEFAULT_EDITOR_SETTINGS,
        agent: { mode: 'auto', autoApply: true, maxIterations: 30, maxUsd: 2, verifyChanges: true },
      },
    })
    expect(state.agentPrefs.mcpServers).toEqual(['srv-a'])
  })

  it('bounds an out-of-range imported value (the reducer is safe on its own)', () => {
    const state = appReducer(initialAppState, {
      type: 'IMPORT_SETTINGS',
      payload: {
        editor: DEFAULT_EDITOR_SETTINGS,
        // Deliberately out-of-range numbers to prove the reducer clamps them.
        agent: { mode: 'agent', autoApply: true, maxIterations: 99999, maxUsd: 9999, verifyChanges: true },
      },
    })
    expect(state.agentPrefs.maxIterations).toBeLessThanOrEqual(100)
    expect(state.agentPrefs.maxUsd).toBeLessThanOrEqual(100)
  })
})

describe('no key ever reaches local storage (invariant 4)', () => {
  it('a key-shaped string pasted into a conversation is scrubbed before it is stored', () => {
    const state: AppState = {
      ...initialAppState,
      conversations: [
        {
          id: 'c',
          title: 'secret sk-1234567890abcdef',
          messages: [{ id: 'm', role: 'user', content: 'use sk-ABCDEFGHIJKLMNOP', timestamp: 1 }],
          createdAt: 1,
        },
      ],
    }
    savePersistedState(state)
    const raw = window.localStorage.getItem('sketch.ui.v1') ?? ''
    expect(raw).not.toMatch(/sk-1234567890abcdef/)
    expect(raw).not.toMatch(/sk-ABCDEFGHIJKLMNOP/)
    expect(raw).toContain('[redacted]')
  })

  it('an imported settings object carries no provider/key field into state or storage', () => {
    const state = appReducer(initialAppState, {
      type: 'IMPORT_SETTINGS',
      payload: {
        editor: DEFAULT_EDITOR_SETTINGS,
        agent: { mode: 'agent', autoApply: true, maxIterations: 30, maxUsd: 2, verifyChanges: true },
      },
    })
    savePersistedState(state)
    const raw = window.localStorage.getItem('sketch.ui.v1') ?? ''
    expect(raw).not.toMatch(/apiKey|api_key|providers|baseUrl/i)
  })
})
