import type { EditorThemeDefinition } from './extensionRegistry'

const readToken = (name: string): string => typeof document === 'undefined' ? '' : document.documentElement.style.getPropertyValue(name).trim()

/** Adapt built-in Monaco surfaces to the workbench while preserving syntax rules. */
export function workbenchTheme(definition: EditorThemeDefinition, read = readToken): EditorThemeDefinition {
  const colors = { ...definition.colors }
  const map: Record<string, string[]> = {
    '--bg-primary': ['editor.background', 'editorGutter.background', 'minimap.background'],
    '--bg-secondary': ['editor.lineHighlightBackground', 'editorWidget.background', 'editorHoverWidget.background', 'editorSuggestWidget.background'],
    '--border': ['editorWidget.border', 'editorHoverWidget.border', 'editorSuggestWidget.border', 'editorIndentGuide.background1'],
    '--border-strong': ['editorIndentGuide.activeBackground1'],
    '--text-primary': ['editor.foreground', 'editorWidget.foreground', 'editorHoverWidget.foreground', 'editorSuggestWidget.foreground'],
    '--text-muted': ['editorLineNumber.foreground'],
    '--text-secondary': ['editorLineNumber.activeForeground'],
    '--accent': ['editorCursor.foreground', 'focusBorder', 'editorBracketMatch.border'],
  }
  const hex = (name: string) => { const value = read(name); return /^#[a-f\d]{6}$/i.test(value) ? value : null }
  for (const [token, names] of Object.entries(map)) {
    const value = hex(token)
    if (value) for (const name of names) colors[name] = value
  }
  const accent = hex('--accent')
  if (accent) {
    colors['editor.selectionBackground'] = accent + '33'
    colors['editor.inactiveSelectionBackground'] = accent + '22'
    colors['editor.findMatchBackground'] = accent + '55'
    colors['editor.findMatchHighlightBackground'] = accent + '22'
    colors['editorSuggestWidget.selectedBackground'] = accent + '22'
  }
  const border = hex('--border-strong')
  if (border) colors['scrollbarSlider.background'] = border + '99'
  const foreground = hex('--text-primary')?.slice(1)
  const comment = hex('--text-muted')?.slice(1)
  return { ...definition, colors, rules: definition.rules.map((rule) => {
    if (comment && rule.token === 'comment') return { ...rule, foreground: comment }
    if (foreground && (rule.token === '' || rule.token === 'variable')) return { ...rule, foreground }
    return rule
  }) }
}
