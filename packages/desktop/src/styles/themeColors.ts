// The light theme, derived from the dark one when the app is built.
//
// The stylesheets were written for one dark palette, and spell colours out (`#262626`,
// `rgba(255,255,255,0.08)`) about as often as they use the theme variables in
// global.css. Rewriting ~875 colours by hand into semantic variables would touch every
// stylesheet while changing nothing a user can see in the dark theme, so the light
// theme is DERIVED instead, by a PostCSS step Vite runs on the app's own stylesheets:
//
//   color: #f5f5f5        becomes      color: var(--sk-fg-f5f5f5ff, #f5f5f5)
//
// The fallback is the original literal and nothing defines `--sk-*` in the dark theme,
// so dark renders exactly the values it rendered before. Each stylesheet also gets one
// rule, `:root[data-theme='light'] { --sk-fg-f5f5f5ff: #1f1f1f; … }`, holding the light
// value of every colour it uses. A colour written tomorrow is themed the same way, with
// no list to keep up to date.
//
// HOW A LIGHT VALUE IS CHOSEN. In OKLab (lightness that matches what the eye sees), by
// what the colour is FOR, read from the property it is set on:
//
//   text        color, fill, stroke…    light text → dark text, keeping its hue
//   background  background…             dark surfaces → light ones; a light "pill" → dark
//   border      border, outline…        dark lines → light grey lines
//   shadow      box-shadow…             as border; black shadows stay black
//
// Saturated mid-tone fills (the orange buttons, a green status dot) and translucent
// tints stay as they are: they read on white as well as on black. Text on such a fill
// — the white label of a primary button — is left alone too: that is the one place the
// same `#fff` means something else. A white highlight becomes a black one. A colour that
// must not change at all says so on its own line: `background: #f5f5f5; /* theme: fixed */`.
// The theme VARIABLES (`--bg-primary`…) are never derived: their light values are picked
// by hand in global.css, and these curves are tuned to agree with them.
//
// Build-time only. Nothing in the app imports this module; vite.config.ts does.

import type { Declaration, Plugin, Rule } from 'postcss'

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0–1. */
  a: number
}

export type ColorRole = 'fg' | 'bg' | 'border' | 'shadow'

// ── Parsing and printing ────────────────────────────────────────────────────

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** A colour literal as written in CSS, or null when it is not one this step reads. */
export function parseColor(text: string): Rgba | null {
  const value = text.trim()
  const hex = HEX.exec(value)
  if (hex !== null) {
    let digits = hex[1]!.toLowerCase()
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('')
    const n = (i: number) => parseInt(digits.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? round(n(6) / 255, 3) : 1 }
  }
  const fn = /^rgba?\(([^()]*)\)$/i.exec(value)
  if (fn === null) return null
  // Both `rgba(1, 2, 3, 0.5)` and `rgb(1 2 3 / 50%)`.
  const parts = fn[1]!.split(/[\s,/]+/).filter((p) => p !== '')
  if (parts.length !== 3 && parts.length !== 4) return null
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p))
  const [r, g, b] = parts.slice(0, 3).map(channel) as [number, number, number]
  const alphaText = parts[3]
  const a = alphaText === undefined ? 1 : alphaText.endsWith('%') ? parseFloat(alphaText) / 100 : parseFloat(alphaText)
  if (![r, g, b, a].every(Number.isFinite)) return null
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) }
}

export function formatColor(color: Rgba): string {
  const r = Math.round(color.r)
  const g = Math.round(color.g)
  const b = Math.round(color.b)
  if (color.a >= 1) return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  return `rgba(${r}, ${g}, ${b}, ${round(color.a, 3)})`
}

/** `rrggbbaa`, the stable key a colour is named by. */
export function colorKey(color: Rgba): string {
  return [color.r, color.g, color.b, color.a * 255]
    .map((n) => Math.round(n).toString(16).padStart(2, '0'))
    .join('')
}

function round(value: number, places: number): number {
  const f = 10 ** places
  return Math.round(value * f) / f
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

// ── OKLab ────────────────────────────────────────────────────────────────────

interface Lab {
  L: number
  a: number
  b: number
}

function toLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function fromLinear(value: number): number {
  const v = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055
  return v * 255
}

export function toOklab(color: Rgba): Lab {
  const r = toLinear(color.r)
  const g = toLinear(color.g)
  const b = toLinear(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

function labToLinear(lab: Lab): [number, number, number] {
  const l = (lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3
  const m = (lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3
  const s = (lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

/** Back to sRGB, giving up chroma (never lightness) until the colour exists. */
function fromOklab(lab: Lab, alpha: number): Rgba {
  let scale = 1
  for (let step = 0; step < 24; step += 1) {
    const linear = labToLinear({ L: lab.L, a: lab.a * scale, b: lab.b * scale })
    if (linear.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      const [r, g, b] = linear.map((v) => clamp(fromLinear(clamp(v, 0, 1)), 0, 255)) as [number, number, number]
      return { r, g, b, a: alpha }
    }
    scale *= 0.85
  }
  const grey = clamp(fromLinear(clamp(lab.L ** 3, 0, 1)), 0, 255)
  return { r: grey, g: grey, b: grey, a: alpha }
}

function chroma(lab: Lab): number {
  return Math.hypot(lab.a, lab.b)
}

// ── The mapping ──────────────────────────────────────────────────────────────

type Curve = ReadonlyArray<readonly [number, number]>

/** Dark-theme lightness → light-theme lightness, for grey TEXT. */
const FG: Curve = [
  [0, 1], [0.182, 0.97], [0.269, 0.87], [0.321, 0.82], [0.372, 0.78], [0.439, 0.7],
  [0.555, 0.5], [0.58, 0.49], [0.633, 0.472], [0.686, 0.455], [0.716, 0.439],
  [0.82, 0.39], [0.87, 0.355], [0.922, 0.3], [0.97, 0.239], [1, 0.2],
]

/** …for grey SURFACES: #121212 → white, #262626 → #ebebeb, a light pill → dark. */
const BG: Curve = [
  [0, 1], [0.182, 1], [0.205, 0.979], [0.235, 0.964], [0.269, 0.94], [0.285, 0.93],
  [0.321, 0.9], [0.372, 0.87], [0.439, 0.82], [0.555, 0.716], [0.716, 0.555],
  [0.87, 0.372], [0.97, 0.269], [1, 0.239],
]

/** …for grey LINES: #262626 → #e5e5e5, #404040 → #cccccc. */
const BORDER: Curve = [
  [0, 0.985], [0.182, 0.97], [0.235, 0.952], [0.269, 0.922], [0.285, 0.91], [0.321, 0.895],
  [0.372, 0.86], [0.439, 0.82], [0.555, 0.716], [0.716, 0.555], [0.97, 0.372], [1, 0.35],
]

function along(curve: Curve, x: number): number {
  if (x <= curve[0]![0]) return curve[0]![1]
  for (let i = 1; i < curve.length; i += 1) {
    const [x1, y1] = curve[i]!
    const [x0, y0] = curve[i - 1]!
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
  }
  return curve[curve.length - 1]![1]
}

/** Below this chroma a colour is treated as grey (its slight tint is kept). */
const NEUTRAL_CHROMA = 0.035

/** A saturated mid-tone: an accent fill, a status dot. Reads on white and on black. */
function isVivid(lab: Lab): boolean {
  return chroma(lab) >= 0.08 && lab.L >= 0.5 && lab.L <= 0.9
}

/** The colour this one should be in the light theme. Returns the same object when kept. */
export function lightColor(color: Rgba, role: ColorRole): Rgba {
  const lab = toOklab(color)
  const c = chroma(lab)
  const translucent = color.a < 1

  if (translucent) {
    // Black shadows and scrims work on both backgrounds.
    if (lab.L < 0.06) return color
    // A coloured tint keeps its colour; as a background it is half as strong on white,
    // where the same tint reads twice as heavy and would crowd the text on it.
    if (c >= NEUTRAL_CHROMA) return role === 'bg' ? { ...color, a: round(Math.max(color.a * 0.5, 0.04), 3) } : color
    // A white highlight on dark becomes a black one on light.
    if (lab.L > 0.93) return { r: 0, g: 0, b: 0, a: round(color.a * (role === 'fg' ? 0.9 : 0.6), 3) }
    // A translucent dark surface (a frosted panel) becomes a translucent light one.
  }

  // Grey, or text with only a hint of colour (slate, a warm grey): the grey curves, which
  // keep that hint. Only clearly coloured text takes the coloured mapping below.
  if (c < NEUTRAL_CHROMA || (role === 'fg' && c < 0.07)) {
    if (role === 'shadow' && lab.L < 0.06) return color
    const curve = role === 'fg' ? FG : role === 'bg' ? BG : BORDER
    return fromOklab({ L: along(curve, lab.L), a: lab.a, b: lab.b }, color.a)
  }

  // Coloured.
  if (role === 'fg') {
    // Light coloured text (#fca5a5 on dark) → its deep version (a readable red on white);
    // the rare dark coloured text, from a light pill, → a light one.
    const L = lab.L >= 0.5 ? clamp(1.28 - lab.L, 0.36, 0.5) : clamp(1.25 - lab.L, 0.75, 0.9)
    return fromOklab({ L, a: lab.a, b: lab.b }, color.a)
  }
  if (isVivid(lab)) return color
  // A dark tinted surface or line (an error box's #6b2b2b) → a pale tint of the same hue,
  // pale enough for coloured text on it to stay readable.
  const target = role === 'bg' ? Math.min(c * 0.6, 0.06) : Math.min(c * 0.7, 0.07)
  const k = target / c
  const curve = role === 'bg' ? BG : BORDER
  const L =
    lab.L < 0.6
      ? clamp(along(curve, lab.L) - (role === 'bg' ? 0.03 : 0.04), role === 'bg' ? 0.9 : 0.78, 0.97)
      : along(curve, lab.L)
  return fromOklab({ L, a: lab.a * k, b: lab.b * k }, color.a)
}

// ── Which role a property plays ─────────────────────────────────────────────

const FG_PROPS = new Set([
  'color', 'fill', 'stroke', 'caret-color', 'text-decoration-color', '-webkit-text-fill-color',
  'text-emphasis-color', 'text-decoration',
])

export function roleOf(prop: string): ColorRole | null {
  const p = prop.toLowerCase()
  if (p.startsWith('--')) return null
  if (FG_PROPS.has(p)) return 'fg'
  if (p === 'background' || p.startsWith('background-')) return 'bg'
  if (p.startsWith('border') || p.startsWith('outline') || p.startsWith('column-rule') || p === 'scrollbar-color') return 'border'
  if (p === 'box-shadow' || p === 'text-shadow' || p === 'filter') return 'shadow'
  return null
}

/**
 * Whether a background is an accent-coloured fill, so the text set on it in the same
 * rule (a primary button's white label) must stay as it is.
 */
export function isAccentFill(value: string): boolean {
  if (/var\(--(?:accent|error|success|warning|purple|pink)\b/.test(value)) return true
  for (const literal of value.match(LITERAL) ?? []) {
    const color = parseColor(literal)
    if (color !== null && color.a >= 0.6 && isVivid(toOklab(color))) return true
  }
  return false
}

// ── Rewriting stylesheets ────────────────────────────────────────────────────

const LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|rgba?\([^()]*\)/g

/**
 * One declaration's value with every themed colour behind a variable whose fallback is
 * the original literal. `sink` collects the light value of each variable used.
 */
export function rewriteValue(value: string, role: ColorRole, sink: Map<string, string>): string {
  if (/url\(/i.test(value)) return value
  return value.replace(LITERAL, (literal) => {
    const color = parseColor(literal)
    if (color === null) return literal
    const light = lightColor(color, role)
    if (light === color) return literal
    const name = `--sk-${role}-${colorKey(color)}`
    sink.set(name, formatColor(light))
    return `var(${name}, ${literal})`
  })
}

export const LIGHT_SELECTOR = ":root[data-theme='light']"

/**
 * The PostCSS step. `include` decides which stylesheets are the app's own (third-party
 * CSS — Monaco's, xterm's — is themed by its own options and left alone).
 */
export function themeColors(include: (file: string) => boolean): Plugin {
  return {
    postcssPlugin: 'sketch-theme-colors',
    Once(root, { Rule: RuleNode, Declaration: DeclarationNode }) {
      const file = root.source?.input.file ?? ''
      if (!include(file)) return
      const sink = new Map<string, string>()
      root.walkDecls((decl: Declaration) => {
        const role = roleOf(decl.prop)
        if (role === null) return
        if (role === 'fg' && decl.parent?.type === 'rule' && onAccent(decl.parent as Rule)) return
        if (fixedByComment(decl)) return
        const next = rewriteValue(decl.value, role, sink)
        if (next !== decl.value) decl.value = next
      })
      if (sink.size === 0) return
      // Nodes carry the stylesheet's source, as parsed ones do; Vite reads it to resolve urls.
      const rule = new RuleNode({ selector: LIGHT_SELECTOR, source: root.source })
      for (const [prop, value] of [...sink].sort(([a], [b]) => a.localeCompare(b))) {
        const decl = new DeclarationNode({ prop, value })
        decl.source = root.source
        rule.append(decl)
      }
      root.append(rule)
    },
  }
}

function onAccent(rule: Rule): boolean {
  let accent = false
  rule.each((node) => {
    if (node.type === 'decl' && roleOf(node.prop) === 'bg' && isAccentFill(node.value)) accent = true
  })
  return accent
}

/**
 * `background: #f5f5f5; /* theme: fixed *\/` — a colour that is the same in both themes
 * (a switch's knob is white on light and on dark). The comment must sit on the same line,
 * so it is plainly about that one declaration.
 */
function fixedByComment(decl: Declaration): boolean {
  const next = decl.next()
  return (
    next !== undefined &&
    next.type === 'comment' &&
    /^theme:\s*fixed\b/.test(next.text) &&
    next.source?.start?.line !== undefined &&
    next.source.start.line === decl.source?.end?.line
  )
}

// ── Contrast, for the tests that hold the light theme to a readable standard ──

function luminance(color: Rgba): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b)
}

/** WCAG 2 contrast ratio of two opaque colours, 1–21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
