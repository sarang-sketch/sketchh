// The window's colour theme: dark, light, or whatever the operating system is set to.
//
// One attribute decides it — `<html data-theme="light">` — and everything follows from
// that: the stylesheets (global.css and the light values derived at build time, see
// ./themeColors.ts), native controls and scrollbars (`color-scheme`), the code editors
// (Monaco's theme), and the terminals (which listen for the event below). It is applied
// once before the first render (main.tsx), so the window never flashes the other theme,
// and again whenever the setting or the system's preference changes.

import { useEffect, useState } from 'react'

import { setEditorScheme } from '../editor/editorTheme'
import { useAppState, type EditorSettings } from '../state/AppState'
import { APPEARANCE_EVENT, applyAppearance } from './appearance'

export type ColorThemeSetting = EditorSettings['colorTheme']
export type ColorScheme = 'dark' | 'light'

/** Fired on `window` after the scheme changed; `detail.scheme` is the new one. */
export const COLOR_SCHEME_EVENT = 'sketch:color-scheme'

const LIGHT_QUERY = '(prefers-color-scheme: light)'

export function systemPrefersLight(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_QUERY).matches
  } catch {
    return false
  }
}

export function resolveScheme(setting: ColorThemeSetting, prefersLight: boolean): ColorScheme {
  if (setting === 'system') return prefersLight ? 'light' : 'dark'
  return setting
}

/** The scheme on screen now. */
export function currentScheme(): ColorScheme {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/** Put `scheme` on the window: the stylesheets, native controls, editors and terminals. */
export function applyColorScheme(scheme: ColorScheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const changed = root.dataset.theme !== scheme
  root.dataset.theme = scheme
  root.style.colorScheme = scheme
  setEditorScheme(scheme)
  if (changed) window.dispatchEvent(new CustomEvent<{ scheme: ColorScheme }>(COLOR_SCHEME_EVENT, { detail: { scheme } }))
}

/** Keeps the window on the chosen theme, following the system when that is the choice. */
export function ColorThemeController(): null {
  const { editorSettings, appearance } = useAppState()
  const setting = editorSettings.colorTheme
  const [prefersLight, setPrefersLight] = useState(systemPrefersLight)

  useEffect(() => {
    if (setting !== 'system' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(LIGHT_QUERY)
    const update = () => setPrefersLight(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [setting])

  const scheme = resolveScheme(setting, prefersLight)
  useEffect(() => {
    const previous = currentScheme()
    applyAppearance(appearance, scheme)
    applyColorScheme(scheme)
    if (previous === scheme) window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: { scheme } }))
  }, [scheme, appearance])
  return null
}
