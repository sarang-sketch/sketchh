// The derived light theme (./themeColors.ts), checked against the app's REAL stylesheets.
// In user terms:
//   * the dark theme looks exactly as it did: every rewritten colour falls back to the
//     very literal it replaced, and nothing else in any stylesheet changes;
//   * every colour the light theme needs is defined — no variable is left without a value;
//   * the light theme is never harder to read than the dark one: wherever a rule sets
//     both a text and a background colour, the light pair meets WCAG AA (4.5:1) or at
//     least the contrast the dark pair had;
//   * the hand-picked theme variables meet AA on the light backgrounds;
//   * the white label of an orange button stays white.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Root, type Rule } from 'postcss'

import {
  LIGHT_SELECTOR,
  colorKey,
  contrastRatio,
  formatColor,
  lightColor,
  parseColor,
  roleOf,
  themeColors,
  type Rgba,
} from './themeColors'

const SRC = join(__dirname, '..')

function cssFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...cssFiles(path))
    else if (name.endsWith('.css')) out.push(path)
  }
  return out
}

const FILES = cssFiles(SRC)
const THEMED = /var\((--sk-(?:fg|bg|border|shadow)-[0-9a-f]{8}), ([^()]*(?:\([^()]*\))?)\)/g

function transform(file: string) {
  const source = readFileSync(file, 'utf8')
  const result = postcss([themeColors(() => true)]).process(source, { from: file })
  return { source, root: result.root }
}

/** The rule the step appends: always the stylesheet's last node. */
function lightRule(root: Root): Rule | undefined {
  const last = root.last
  return last !== undefined && last.type === 'rule' && last.selector === LIGHT_SELECTOR ? last : undefined
}

const opaque = (text: string): Rgba | null => {
  const color = parseColor(text)
  return color !== null && color.a === 1 ? color : null
}

describe('the light theme derived from the dark stylesheets', () => {
  it('reads the real stylesheets', () => {
    expect(FILES.length).toBeGreaterThan(30)
  })

  it('leaves the dark theme exactly as it was', () => {
    for (const file of FILES) {
      const { source, root } = transform(file)
      const original = postcss.parse(source, { from: file })
      lightRule(root)?.remove()
      // Unwrap every themed colour back to its fallback: the stylesheet must come back.
      const unwrapped = root.toString().replace(THEMED, (_all, _name, literal: string) => literal)
      expect(unwrapped, file).toBe(original.toString())
    }
  })

  it('defines a light value for every colour it themes', () => {
    let themed = 0
    for (const file of FILES) {
      const { root } = transform(file)
      const used = new Set([...root.toString().matchAll(THEMED)].map((m) => m[1]!))
      const defined = new Set<string>()
      lightRule(root)?.walkDecls((decl) => {
        defined.add(decl.prop)
        expect(parseColor(decl.value), `${file} ${decl.prop}`).not.toBeNull()
      })
      for (const name of used) expect(defined.has(name), `${file} uses ${name}`).toBe(true)
      themed += used.size
    }
    // The workspace redesign replaces more literal colors with appearance tokens.
    // 248 legacy values remain at this revision; keep a broad non-vacuity floor,
    // while the assertions above require every emitted variable to be defined.
    // appearance.test.tsx separately checks the new tokens across every palette.
    expect(themed).toBeGreaterThan(200)
  })

  it('is never harder to read than the dark theme where a rule sets text on a background', () => {
    const failures: string[] = []
    let pairs = 0
    for (const file of FILES) {
      const parsed = postcss.parse(readFileSync(file, 'utf8'), { from: file })
      parsed.walkRules((rule) => {
        if (rule.selector === LIGHT_SELECTOR) return
        let fg: Rgba | null = null
        let bg: Rgba | null = null
        let onAccent = false
        rule.each((node) => {
          if (node.type !== 'decl') return
          if (node.prop === 'color') fg = opaque(node.value)
          if (node.prop === 'background' || node.prop === 'background-color') {
            bg = opaque(node.value)
            if (/var\(--accent/.test(node.value)) onAccent = true
          }
        })
        if (fg === null || bg === null || onAccent) return
        pairs += 1
        const dark = contrastRatio(fg, bg)
        // On a vivid fill (an orange button) the label keeps its colour, as the step does.
        const bgLight = lightColor(bg, 'bg')
        const fgLight = bgLight === bg ? fg : lightColor(fg, 'fg')
        const light = contrastRatio(fgLight, bgLight)
        if (light < Math.min(4.5, dark) * 0.95) {
          failures.push(`${file.slice(SRC.length)} ${rule.selector}: dark ${dark.toFixed(2)} → light ${light.toFixed(2)}`)
        }
      })
    }
    // Same tokenisation shift: fewer rules now set a literal color+background pair
    // (most go through var(--token) now), so the number of pairs this readability check
    // examines fell from the W1-era floor to the current 18. The load-bearing assertion
    // is the next line — every pair examined still passes the contrast check — and that
    // is unchanged; this floor only guards against the check examining nothing. (W10.)
    expect(pairs).toBeGreaterThan(15)
    expect(failures).toEqual([])
  })

  it('keeps vivid fills, black shadows and coloured tints, and turns white highlights black', () => {
    const accent = parseColor('#ea580c')!
    expect(lightColor(accent, 'bg')).toBe(accent)
    const shadow = parseColor('rgba(0, 0, 0, 0.5)')!
    expect(lightColor(shadow, 'shadow')).toBe(shadow)
    const tint = parseColor('rgba(249, 115, 22, 0.15)')!
    // A coloured tint keeps its colour; as a background it is half as strong on white.
    expect(formatColor(lightColor(tint, 'bg'))).toBe('rgba(249, 115, 22, 0.075)')
    expect(lightColor(tint, 'border')).toBe(tint)
    expect(formatColor(lightColor(parseColor('rgba(255, 255, 255, 0.08)')!, 'bg'))).toBe('rgba(0, 0, 0, 0.048)')
    // Surfaces and text land on the hand-picked theme values.
    expect(formatColor(lightColor(parseColor('#121212')!, 'bg'))).toBe('#ffffff')
    expect(formatColor(lightColor(parseColor('#262626')!, 'bg'))).toBe('#ebebeb')
    expect(formatColor(lightColor(parseColor('#262626')!, 'border'))).toBe('#e5e5e5')
    expect(formatColor(lightColor(parseColor('#f5f5f5')!, 'fg'))).toBe('#1f1f1f')
    expect(formatColor(lightColor(parseColor('#a3a3a3')!, 'fg'))).toBe('#525252')
  })

  it('leaves the theme variables and the label of an accent button alone', () => {
    const css = ":root { --bg: #121212; }\n.primary { background: #ea580c; color: #fff; }\n.plain { color: #f5f5f5; border: 1px solid #262626; }"
    const root = postcss([themeColors(() => true)]).process(css, { from: 'x.css' }).root
    const text = root.toString()
    expect(text).toContain('--bg: #121212;')
    expect(text).toContain('background: #ea580c; color: #fff;')
    expect(text).toContain('color: var(--sk-fg-f5f5f5ff, #f5f5f5)')
    expect(text).toContain('border: 1px solid var(--sk-border-262626ff, #262626)')
    expect(lightRule(root)?.toString()).toContain('--sk-fg-f5f5f5ff: #1f1f1f')
    // Third-party stylesheets are not the app's to theme.
    const skipped = postcss([themeColors(() => false)]).process(css, { from: 'x.css' }).root.toString()
    expect(skipped).toBe(css)
  })

  it('keeps a colour marked "theme: fixed" on its own line, and only that one', () => {
    const css = '.knob { background: #f5f5f5; /* theme: fixed */\n  color: #f5f5f5;\n  /* theme: fixed */\n  border-color: #262626; }'
    const text = postcss([themeColors(() => true)]).process(css, { from: 'x.css' }).root.toString()
    expect(text).toContain('background: #f5f5f5; /* theme: fixed */')
    expect(text).toContain('color: var(--sk-fg-f5f5f5ff, #f5f5f5)')
    // A comment on the next line is about nothing in particular.
    expect(text).toContain('border-color: var(--sk-border-262626ff, #262626)')
  })

  it('names colours by role and value, and parses every spelling the stylesheets use', () => {
    expect(roleOf('background-color')).toBe('bg')
    expect(roleOf('border-left')).toBe('border')
    expect(roleOf('color')).toBe('fg')
    expect(roleOf('box-shadow')).toBe('shadow')
    expect(roleOf('--accent')).toBeNull()
    expect(roleOf('width')).toBeNull()
    expect(colorKey(parseColor('#fff')!)).toBe('ffffffff')
    expect(parseColor('rgba(88,166,255,.3)')).toEqual({ r: 88, g: 166, b: 255, a: 0.3 })
    expect(parseColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 })
    expect(parseColor('#26262699')!.a).toBeCloseTo(0.6, 2)
    expect(parseColor('var(--x)')).toBeNull()
  })
})

describe('the hand-picked light values of the theme variables', () => {
  const global = postcss.parse(readFileSync(join(SRC, 'styles', 'global.css'), 'utf8'))
  const light = new Map<string, Rgba>()
  global.walkRules((rule) => {
    if (rule.selector !== LIGHT_SELECTOR) return
    rule.walkDecls((decl) => {
      const color = parseColor(decl.value)
      if (color !== null) light.set(decl.prop, color)
    })
  })
  const v = (name: string) => {
    const color = light.get(name)
    if (color === undefined || color.a !== 1) throw new Error(`${name} has no opaque light value`)
    return color
  }

  it('gives every colour variable of the dark theme a light value', () => {
    const colours: string[] = []
    global.walkRules((rule) => {
      if (rule.selector !== ':root') return
      rule.walkDecls((decl) => {
        if (parseColor(decl.value) !== null) colours.push(decl.prop)
      })
    })
    expect(colours.length).toBeGreaterThan(20)
    for (const name of colours) expect(light.has(name), name).toBe(true)
  })

  it('meets WCAG AA for text on every light surface', () => {
    for (const surface of ['--bg-primary', '--bg-secondary', '--bg-surface']) {
      for (const text of ['--text-primary', '--text-secondary', '--text-muted', '--accent', '--error', '--success', '--warning']) {
        expect(contrastRatio(v(text), v(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    // White labels on the accent buttons, at rest and on hover.
    for (const fill of ['--accent', '--accent-fill', '--accent-fill-hover']) {
      expect(contrastRatio(parseColor('#ffffff')!, v(fill)), fill).toBeGreaterThanOrEqual(4.5)
    }
  })
})
