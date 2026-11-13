// UI Doctor — real checks against a live DOM.
//
// No axe, no fake score: every result comes from querying the document the
// user is looking at (the IDE's own page by default) and from computed styles.
// Contrast is a luminance-ratio ESTIMATE from computed colour/background — it
// does not account for background images, gradients, or text over images, and
// the panel says so. Takes a Document or an HTMLElement root so tests can pass
// a jsdom document.

export type UiCheckSeverity = 'pass' | 'warn' | 'error'

export interface UiCheckResult {
  id: string
  label: string
  severity: UiCheckSeverity
  detail: string
  selector?: string
}

/** Flagged when the estimated contrast ratio is below this. */
export const CONTRAST_THRESHOLD = 3

function cssSelector(el: Element): string {
  const parts: string[] = []
  let current: Element | null = el
  while (current !== null && parts.length < 4) {
    let part = current.tagName.toLowerCase()
    const id = (current as HTMLElement).id
    if (id) {
      part += `#${id}`
      parts.unshift(part)
      break
    }
    const cls = typeof (current as HTMLElement).className === 'string' ? (current as HTMLElement).className.trim().split(/\s+/)[0] : ''
    if (cls) part += `.${cls}`
    const parent: Element | null = current.parentElement
    if (parent !== null) {
      const tag = current.tagName
      const siblings = [...parent.children].filter((c: Element) => c.tagName === tag)
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
    }
    parts.unshift(part)
    current = parent
  }
  return parts.join(' > ')
}

interface Rgb {
  r: number
  g: number
  b: number
  a: number
}

function parseRgb(value: string): Rgb | null {
  const m = value.trim().match(/^rgba?\(([^)]+)\)$/)
  if (!m) return null
  const parts = m[1].split(',').map((p) => Number(p.trim()))
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 ? parts[3] : 1 }
}

function luminance({ r, g, b }: Rgb): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrastRatio(fg: Rgb, bg: Rgb): number {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/** Effective background: walk up until a non-transparent background-color. */
function effectiveBackground(el: Element, win: Window): Rgb {
  let current: Element | null = el
  while (current !== null) {
    const bg = parseRgb(win.getComputedStyle(current).backgroundColor)
    if (bg !== null && bg.a > 0) {
      // Composite a translucent background over white (the usual page default).
      if (bg.a < 1) {
        return {
          r: bg.r * bg.a + 255 * (1 - bg.a),
          g: bg.g * bg.a + 255 * (1 - bg.a),
          b: bg.b * bg.a + 255 * (1 - bg.a),
          a: 1,
        }
      }
      return bg
    }
    current = current.parentElement
  }
  return { r: 255, g: 255, b: 255, a: 1 }
}

function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) return labelledBy.trim()
  const label = el.getAttribute('aria-label')
  if (label !== null && label.trim() !== '') return label.trim()
  const title = el.getAttribute('title')
  if (title !== null && title.trim() !== '') return title.trim()
  return (el.textContent ?? '').trim()
}

export function runUiChecks(root: Document | HTMLElement): UiCheckResult[] {
  const results: UiCheckResult[] = []
  const doc: Document = root instanceof Document ? root : root.ownerDocument
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null)
  const scope: ParentNode = root instanceof Document ? root : root

  // (a) images without alt.
  const images = [...scope.querySelectorAll('img')]
  const missingAlt = images.filter((img) => !img.hasAttribute('alt'))
  if (images.length === 0) {
    results.push({ id: 'img-alt', label: 'Images without alt text', severity: 'pass', detail: 'No <img> elements found on this page.' })
  } else if (missingAlt.length === 0) {
    results.push({ id: 'img-alt', label: 'Images without alt text', severity: 'pass', detail: `All ${images.length} image(s) have an alt attribute (an empty alt is valid for decorative images).` })
  } else {
    for (const img of missingAlt) {
      results.push({
        id: 'img-alt',
        label: 'Image without alt text',
        severity: 'error',
        detail: 'This image has no alt attribute, so screen readers announce its file name or nothing at all.',
        selector: cssSelector(img),
      })
    }
  }

  // (b) buttons without an accessible name.
  const buttons = [...scope.querySelectorAll('button')]
  const unnamed = buttons.filter((b) => accessibleName(b) === '')
  if (buttons.length === 0) {
    results.push({ id: 'button-name', label: 'Buttons without an accessible name', severity: 'pass', detail: 'No <button> elements found on this page.' })
  } else if (unnamed.length === 0) {
    results.push({ id: 'button-name', label: 'Buttons without an accessible name', severity: 'pass', detail: `All ${buttons.length} button(s) have an accessible name.` })
  } else {
    for (const b of unnamed) {
      results.push({
        id: 'button-name',
        label: 'Button without an accessible name',
        severity: 'error',
        detail: 'This button has no text, aria-label, or title, so assistive technology cannot say what it does.',
        selector: cssSelector(b),
      })
    }
  }

  // (c) inputs without a label.
  const inputs = [...scope.querySelectorAll('input, select, textarea')]
  const unlabeled = inputs.filter((el) => {
    const input = el as HTMLInputElement
    if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') return false
    if (el.getAttribute('aria-label')?.trim() || el.getAttribute('aria-labelledby')?.trim()) return false
    if ((input.labels?.length ?? 0) > 0) return false
    if (el.closest('label') !== null) return false
    return true
  })
  if (inputs.length === 0) {
    results.push({ id: 'input-label', label: 'Inputs without a label', severity: 'pass', detail: 'No form controls found on this page.' })
  } else if (unlabeled.length === 0) {
    results.push({ id: 'input-label', label: 'Inputs without a label', severity: 'pass', detail: `All ${inputs.length} form control(s) have a label.` })
  } else {
    for (const el of unlabeled) {
      results.push({
        id: 'input-label',
        label: 'Form control without a label',
        severity: 'error',
        detail: 'This control has no <label>, aria-label, or aria-labelledby, so its purpose is not announced.',
        selector: cssSelector(el),
      })
    }
  }

  // (d) document title.
  const title = doc.title.trim()
  results.push(
    title === ''
      ? { id: 'doc-title', label: 'Document title', severity: 'error', detail: 'This document has no <title>. The tab and screen-reader announcements have nothing to say.' }
      : { id: 'doc-title', label: 'Document title', severity: 'pass', detail: `Title is present: “${title}”.` },
  )

  // (e) html lang.
  const lang = doc.documentElement.getAttribute('lang')?.trim() ?? ''
  results.push(
    lang === ''
      ? { id: 'html-lang', label: 'Page language', severity: 'warn', detail: 'The <html> element has no lang attribute, so screen readers guess the pronunciation language.' }
      : { id: 'html-lang', label: 'Page language', severity: 'pass', detail: `Page language is “${lang}”.` },
  )

  // (f) contrast estimate from computed style.
  if (win === null) {
    results.push({ id: 'contrast', label: 'Text contrast (estimate)', severity: 'pass', detail: 'No window available, so contrast could not be estimated.' })
  } else {
    const textEls = [...scope.querySelectorAll('p, span, a, li, td, th, h1, h2, h3, h4, h5, h6, button, label, div')]
      .filter((el) => (el.textContent ?? '').trim() !== '' && el.children.length === 0)
    let checked = 0
    let low = 0
    for (const el of textEls) {
      const style = win.getComputedStyle(el)
      const fg = parseRgb(style.color)
      if (fg === null) continue
      const bg = effectiveBackground(el, win)
      const ratio = contrastRatio(fg, bg)
      checked += 1
      if (ratio < CONTRAST_THRESHOLD) {
        low += 1
        results.push({
          id: 'contrast',
          label: 'Low contrast text (estimate)',
          severity: 'warn',
          detail: `Estimated contrast ${ratio.toFixed(2)}:1, below ${CONTRAST_THRESHOLD}:1. Estimate only — computed colour against the nearest solid background; background images and gradients are not accounted for.`,
          selector: cssSelector(el),
        })
      }
    }
    if (low === 0) {
      results.push({
        id: 'contrast',
        label: 'Text contrast (estimate)',
        severity: 'pass',
        detail:
          checked === 0
            ? 'No leaf text elements with a computable colour were found.'
            : `All ${checked} checked text element(s) are at or above an estimated ${CONTRAST_THRESHOLD}:1. Estimate only — see any flagged row for the caveat.`,
      })
    }
  }

  return results
}
