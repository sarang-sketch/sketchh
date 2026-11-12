/** Portable workbench preferences. No provider, credentials, or project access lives here. */
export interface AppearanceSettings {
  accentColor: string
  surface: 'graphite' | 'midnight' | 'warm'
  density: 'comfortable' | 'compact'
  uiFontSize: number
  uiFont: 'inter' | 'system'
  sidebarPosition: 'left' | 'right'
  agentPosition: 'left' | 'right'
  activityBar: 'side' | 'top' | 'hidden'
  canvas: 'plain' | 'dots' | 'grid'
  chatWidth: 'comfortable' | 'wide'
  sidebarWidth: number
  showStatusBar: boolean
  showTips: boolean
  reduceMotion: boolean
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  accentColor: '#f58a50',
  surface: 'graphite',
  density: 'comfortable',
  uiFontSize: 13,
  uiFont: 'inter',
  sidebarPosition: 'left',
  agentPosition: 'right',
  activityBar: 'side',
  canvas: 'plain',
  chatWidth: 'comfortable',
  sidebarWidth: 244,
  showStatusBar: true,
  showTips: true,
  reduceMotion: false,
}

export const ACCENT_PRESETS = [
  { name: 'Ember', color: '#f58a50' },
  { name: 'Jade', color: '#63c4a5' },
  { name: 'Sky', color: '#79a9ff' },
  { name: 'Iris', color: '#b69af7' },
  { name: 'Rose', color: '#e98fa8' },
  { name: 'Gold', color: '#dcb86c' },
] as const

/** A palette changed without switching light/dark; terminals must repaint too. */
export const APPEARANCE_EVENT = 'sketch:appearance'

export function normalizeAppearance(value: unknown): AppearanceSettings {
  const s = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const d = DEFAULT_APPEARANCE
  const pick = <T extends string>(v: unknown, values: readonly T[], fallback: T): T =>
    typeof v === 'string' && (values as readonly string[]).includes(v) ? v as T : fallback
  const number = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
  const bool = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback
  return {
    accentColor: typeof s.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.accentColor) ? s.accentColor.toLowerCase() : d.accentColor,
    surface: pick(s.surface, ['graphite', 'midnight', 'warm'], d.surface),
    density: pick(s.density, ['comfortable', 'compact'], d.density),
    uiFontSize: number(s.uiFontSize, 12, 16, d.uiFontSize),
    uiFont: pick(s.uiFont, ['inter', 'system'], d.uiFont),
    sidebarPosition: pick(s.sidebarPosition, ['left', 'right'], d.sidebarPosition),
    agentPosition: pick(s.agentPosition, ['left', 'right'], d.agentPosition),
    activityBar: pick(s.activityBar, ['side', 'top', 'hidden'], d.activityBar),
    canvas: pick(s.canvas, ['plain', 'dots', 'grid'], d.canvas),
    chatWidth: pick(s.chatWidth, ['comfortable', 'wide'], d.chatWidth),
    sidebarWidth: number(s.sidebarWidth, 200, 360, d.sidebarWidth),
    showStatusBar: bool(s.showStatusBar, d.showStatusBar),
    showTips: bool(s.showTips, d.showTips),
    reduceMotion: bool(s.reduceMotion, d.reduceMotion),
  }
}

const DARK_SURFACES = {
  graphite: ['#141414', '#191919', '#222222', '#292929', '#303030', '#303030', '#252525', '#414141'],
  midnight: ['#141920', '#191f28', '#202834', '#283240', '#303c4c', '#303b49', '#252e3a', '#435368'],
  warm: ['#1b1816', '#211e1b', '#292521', '#322d28', '#3b352e', '#37312b', '#2d2722', '#4c4239'],
} as const
const LIGHT_SURFACES = {
  graphite: ['#fafafa', '#f3f3f3', '#ffffff', '#ececec', '#e7e7e7', '#dedede', '#ebebeb', '#c9c9c9'],
  midnight: ['#f7f9fc', '#eef2f7', '#ffffff', '#e6ecf4', '#dde5ef', '#d7dfea', '#e7edf5', '#b9c7d8'],
  warm: ['#faf8f4', '#f2eee7', '#fffdf9', '#ebe5db', '#e4ddd1', '#ddd5c8', '#ede7dd', '#c8bcaa'],
} as const

function rgb(hex: string): number[] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((n) => { const v = n / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
function mix(a: string, b: string, amount: number): string {
  const other = rgb(b)
  return '#' + rgb(a).map((v, i) => Math.round(v + (other[i]! - v) * amount).toString(16).padStart(2, '0')).join('')
}
/** Keep the selected hue, but make small accent text readable against every raised surface. */
export function readableAccent(hex: string, background: string): string {
  const target = luminance(background) < 0.3 ? '#ffffff' : '#000000'
  for (let step = 0; step <= 100; step++) {
    const value = mix(hex, target, step / 100)
    if (contrastRatio(value, background) >= 4.5) return value
  }
  return target
}

export function appearanceTokens(settings: AppearanceSettings, scheme: 'dark' | 'light'): Record<string, string> {
  const s = normalizeAppearance(settings)
  const dark = scheme === 'dark'
  const colors = (dark ? DARK_SURFACES : LIGHT_SURFACES)[s.surface]
  const names = ['--bg-primary', '--bg-secondary', '--bg-surface', '--bg-elevated', '--bg-hover', '--border', '--border-subtle', '--border-strong']
  const accent = readableAccent(s.accentColor, colors[4])
  const fill = s.accentColor
  const onAccent = contrastRatio(fill, '#000000') >= contrastRatio(fill, '#ffffff') ? '#000000' : '#ffffff'
  return {
    ...Object.fromEntries(names.map((name, i) => [name, colors[i]!])),
    '--text-primary': dark ? '#eeeeec' : '#252523',
    '--text-secondary': dark ? '#b2b2ad' : '#50504c',
    '--text-muted': readableAccent(dark ? '#92928e' : '#666661', colors[4]),
    '--accent': accent,
    '--accent-hover': readableAccent(mix(s.accentColor, dark ? '#ffffff' : '#000000', 0.15), colors[4]),
    '--accent-active': accent,
    '--accent-strong': accent,
    '--accent-fill': fill,
    '--accent-fill-hover': mix(fill, onAccent === '#000000' ? '#ffffff' : '#000000', 0.1),
    '--text-on-accent': onAccent,
    '--accent-subtle': 'color-mix(in srgb, ' + accent + ' 11%, transparent)',
    '--bg-active': 'color-mix(in srgb, ' + accent + ' 11%, transparent)',
    '--font-sans': s.uiFont === 'system' ? "'Segoe UI', system-ui, sans-serif" : "'Inter', 'Segoe UI', system-ui, sans-serif",
    '--text-base': s.uiFontSize + 'px',
    '--text-sm': (s.uiFontSize - 1) + 'px',
    '--text-xs': (s.uiFontSize - 2) + 'px',
    '--text-md': (s.uiFontSize + 1) + 'px',
    '--control-sm': s.density === 'compact' ? '24px' : '28px',
    '--control-md': s.density === 'compact' ? '30px' : '34px',
    '--control-lg': s.density === 'compact' ? '36px' : '40px',
    '--row-height': s.density === 'compact' ? '30px' : '36px',
    '--chat-content-width': s.chatWidth === 'wide' ? '980px' : '760px',
    '--cowork-sidebar-width': s.sidebarWidth + 'px',
  }
}

export function applyAppearance(settings: AppearanceSettings, scheme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const s = normalizeAppearance(settings)
  for (const [name, value] of Object.entries(appearanceTokens(s, scheme))) root.style.setProperty(name, value)
  root.dataset.density = s.density
  root.dataset.canvas = s.canvas
  root.dataset.motion = s.reduceMotion ? 'reduced' : 'full'
  root.dataset.activity = s.activityBar
}
