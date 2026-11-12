// The colour theme, end to end inside the window: the real reducer and settings, the
// real Monaco loader seam (over its double) and the real theme registry. In user terms:
//   * choosing Light switches the window, the native controls and every open editor at
//     once, and new editors open in it too;
//   * "Match system" follows the operating system, including when it changes while the
//     app is open;
//   * the choice survives a restart, and a damaged stored value falls back to Dark.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

import { AppStateProvider, persistedColorTheme, useAppDispatch } from '../state/AppState'
import { createMonacoDouble } from '../editor/monacoDouble'
import { prepareMonaco } from '../editor/monacoSetup'
import { editorExtensionRegistry, SKETCH_THEME } from '../editor/extensionRegistry'
import { COLOR_SCHEME_EVENT, ColorThemeController, applyColorScheme, currentScheme, resolveScheme } from './colorTheme'

type Listener = (event: { matches: boolean }) => void

/** `matchMedia` for the light-mode query, with a switch the test flips. */
function fakeSystem(light: boolean) {
  const listeners = new Set<Listener>()
  const query = {
    matches: light,
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
  }
  ;(window as { matchMedia?: unknown }).matchMedia = (q: string) => {
    expect(q).toBe('(prefers-color-scheme: light)')
    return query
  }
  return {
    set(next: boolean) {
      query.matches = next
      for (const listener of [...listeners]) listener({ matches: next })
    },
    get listeners() {
      return listeners.size
    },
  }
}

let dispatchRef: ReturnType<typeof useAppDispatch> | null = null
function Grab() {
  dispatchRef = useAppDispatch()
  return null
}

function mount(colorTheme: 'dark' | 'light' | 'system') {
  render(
    <AppStateProvider initial={{ editorSettings: { ...defaults(), colorTheme } }}>
      <ColorThemeController />
      <Grab />
    </AppStateProvider>,
  )
}

function defaults() {
  return {
    fontSize: 13,
    tabSize: 2,
    insertSpaces: true,
    wordWrap: false,
    minimap: true,
    lineNumbers: 'on' as const,
    autoSave: 'off' as const,
    formatOnSave: false,
    renderWhitespace: 'selection' as const,
    stickyScroll: true,
    bracketPairColorization: true,
    languageFeatures: true,
  }
}

beforeEach(() => {
  applyColorScheme('dark')
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  delete (window as { matchMedia?: unknown }).matchMedia
  applyColorScheme('dark')
  dispatchRef = null
})

describe('the colour theme', () => {
  it('switches the window, native controls and open editors, and new editors start in it', () => {
    const monaco = createMonacoDouble()
    // What the real loader does once Monaco is in memory.
    expect(prepareMonaco(monaco.api).theme).toBe(SKETCH_THEME)
    const seen: string[] = []
    const onScheme = (event: Event) => seen.push((event as CustomEvent<{ scheme: string }>).detail.scheme)
    window.addEventListener(COLOR_SCHEME_EVENT, onScheme)

    mount('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    act(() => dispatchRef!({ type: 'SET_EDITOR_SETTINGS', payload: { colorTheme: 'light' } }))

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(monaco.theme).toBe('sketch-light')
    expect(prepareMonaco(monaco.api).theme).toBe('sketch-light')
    expect(monaco.definedThemes.has('sketch-light')).toBe(true)
    expect(seen).toEqual(['light'])

    act(() => dispatchRef!({ type: 'SET_EDITOR_SETTINGS', payload: { colorTheme: 'dark' } }))
    expect(currentScheme()).toBe('dark')
    expect(monaco.theme).toBe(SKETCH_THEME)
    expect(editorExtensionRegistry.activeTheme).toBe(SKETCH_THEME)
    expect(seen).toEqual(['light', 'dark'])
    window.removeEventListener(COLOR_SCHEME_EVENT, onScheme)
  })

  it('follows the operating system when set to Match system, live', () => {
    const system = fakeSystem(true)
    mount('system')
    expect(currentScheme()).toBe('light')
    act(() => system.set(false))
    expect(currentScheme()).toBe('dark')
    act(() => system.set(true))
    expect(currentScheme()).toBe('light')
    // A fixed choice stops listening to the system.
    act(() => dispatchRef!({ type: 'SET_EDITOR_SETTINGS', payload: { colorTheme: 'dark' } }))
    expect(currentScheme()).toBe('dark')
    expect(system.listeners).toBe(0)
    act(() => system.set(true))
    expect(currentScheme()).toBe('dark')
  })

  it('is read back at startup, and a damaged value means Dark', () => {
    expect(persistedColorTheme()).toBe('dark')
    window.localStorage.setItem('sketch.ui.v1', JSON.stringify({ editorSettings: { ...defaults(), colorTheme: 'light' } }))
    expect(persistedColorTheme()).toBe('light')
    window.localStorage.setItem('sketch.ui.v1', JSON.stringify({ editorSettings: { colorTheme: 'purple' } }))
    expect(persistedColorTheme()).toBe('dark')
    window.localStorage.setItem('sketch.ui.v1', '{not json')
    expect(persistedColorTheme()).toBe('dark')
    expect(resolveScheme('system', true)).toBe('light')
    expect(resolveScheme('system', false)).toBe('dark')
  })
})
