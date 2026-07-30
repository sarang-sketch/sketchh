// Task 4.5, Part A — nothing the window loads comes from off this machine.
//
// WHY THIS FILE EXISTS
// `index.html` carried two `<link rel="preconnect">` hints and a Google Fonts
// stylesheet. They were fetched on window load, before the user did anything, and
// no CSP directive covers `preconnect` — so in a packaged build the stylesheet was
// blocked while the speculative DNS lookup and TLS handshake could still happen.
// PRIVACY.md §3 named it as a defect. Part A removed it by vendoring the two
// families into this package; this file is what stops it coming back, in that form
// or any other.
//
// WHAT IT ASSERTS
//   1. No scanned file names a font CDN.
//   2. No scanned file names a NON-LOOPBACK url in a SUBRESOURCE position — an HTML
//      tag attribute, a CSS `url()`, a CSS `@import`, or any url ending in an
//      extension a page loads (woff2, css, js, png, wasm…).
//   3. `index.html` declares no speculative connection hint at all: `preconnect`,
//      `dns-prefetch`, `prefetch` and `preload` are all absent, because the first of
//      those is precisely the one a CSP cannot stop.
//   4. The replacement is real: the woff2 files are in the tree, they are woff2, the
//      OFL text ships beside them, and `fonts.css` points at them with a relative
//      url that Vite resolves inside the bundle.
//
// WHAT IT DELIBERATELY DOES NOT FLAG
// Provider endpoints. `https://api.openai.com/v1` in the registry is the model call
// the user configured — documented egress, PRIVACY.md §1 — and it is not a
// subresource. The scanner separates "the page loads this" from "the engine posts to
// this"; conflating them would force the guard to be deleted the first time someone
// added a provider.
//
// SELF-EXCLUSION
// This one file is skipped by the scan. It contains synthetic offending samples so
// the scanner is itself under test, exactly the reason `packages/core/test/
// privacy.test.ts` lives outside the roots it scans. Nothing else is excluded.
//
// Validates: Requirements 17.7, 26.3

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const selfPath = fileURLToPath(import.meta.url)
const desktopRoot = resolve(selfPath, '..', '..')
const repoRoot = resolve(desktopRoot, '..', '..')
const indexHtmlPath = join(desktopRoot, 'index.html')
const fontsDir = join(desktopRoot, 'src', 'assets', 'fonts')

// ── the file set ────────────────────────────────────────────────────────────

const SCANNED_EXTENSIONS = ['.html', '.css', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'resources', '.sketch', '.git'])

function filesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...filesUnder(full))
    else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full)
  }
  return found
}

const scannedFiles = [
  indexHtmlPath,
  ...filesUnder(join(desktopRoot, 'src')),
  ...filesUnder(join(desktopRoot, 'src-tauri', 'src')),
  ...filesUnder(join(repoRoot, 'packages', 'core', 'src')),
].filter((file) => file !== selfPath)

const shortName = (file: string) => relative(repoRoot, file).replaceAll('\\', '/')

// ── normalization ───────────────────────────────────────────────────────────

/** Block comments, and line comments that are not the `//` of a url scheme. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:\w"'`])\/\/[^\n]*/g, '$1')
}

/** `'fonts.goo' + 'gleapis.com'` collapses back to one host. */
function joinAdjacentLiterals(source: string): string {
  let out = source.replace(/\$\{\s*(?:''|""|``)?\s*\}/g, '')
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/['"`]\s*[+,]?\s*['"`]/g, '')
    if (next === out) break
    out = next
  }
  return out
}

/** Two views of the same text: as written, and with split literals rejoined. */
function views(source: string): string[] {
  const clean = stripComments(source)
  return [clean, joinAdjacentLiterals(clean)]
}

// ── 1. font CDNs ────────────────────────────────────────────────────────────

/**
 * Assembled from halves so this file does not report itself if it is ever moved
 * into a scanned position. The literal-joining pass above is what makes the same
 * trick useless to a real offender.
 */
const FONT_HOSTS: readonly string[] = [
  'fonts.google' + 'apis.com',
  'fonts.gsta' + 'tic.com',
  'fonts.bun' + 'ny.net',
  'use.type' + 'kit.net',
  'use.font' + 'awesome.com',
  'fast.fo' + 'nts.net',
  'cdn.font' + 'source.org',
]

function fontHostsIn(source: string): string[] {
  const lowered = views(source).map((view) => view.toLowerCase())
  return FONT_HOSTS.filter((host) => lowered.some((view) => view.includes(host)))
}

// ── 2. non-loopback subresources ────────────────────────────────────────────

const URL_PATTERN = /(?:https?:)?\/\/[a-z0-9._~%-]+(?::\d+)?(?:\/[^\s'"`)<>\\]*)?/gi

/**
 * Extensions a page fetches as part of rendering itself.
 *
 * `.ts`, `.tsx` and `.json` are NOT here. A repository path is not a subresource,
 * and including them turned a fixture of Windows UNC paths in `editor/paths.test.ts`
 * into a finding — a guard that cries wolf gets deleted.
 */
const SUBRESOURCE_EXTENSION =
  /\.(?:woff2?|ttf|otf|eot|css|m?js|cjs|png|jpe?g|gif|svg|webp|avif|ico|wasm|mp4|webm|ogg)(?:[?#]|$)/i

/** HTML elements that fetch, and the attributes they fetch from. */
const HTML_SUBRESOURCE_TAG =
  /<(?:link|script|img|image|iframe|frame|source|embed|object|audio|video|track|use)\b[^>]*>/gi

const CSS_URL = /url\(\s*['"]?([^'")]+)/gi
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"]+)/gi

function hostOf(url: string): string {
  const withScheme = url.startsWith('//') ? `https:${url}` : url
  try {
    return new URL(withScheme).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Loopback, and nothing else. `localhost`, the whole 127/8 block, and `::1` — the
 * three ways to name this machine. A LAN address is not loopback: `192.168.x.x` is
 * somebody else's computer.
 */
function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

/** Every non-loopback url that a page would fetch, per view of the text. */
function externalSubresourcesIn(source: string, isHtml: boolean): string[] {
  const found = new Set<string>()

  const consider = (candidate: string): void => {
    const trimmed = candidate.trim()
    if (!/^(?:https?:)?\/\//i.test(trimmed)) return
    const host = hostOf(trimmed)
    if (host === '' || isLoopback(host)) return
    found.add(trimmed)
  }

  for (const view of views(source)) {
    // (a) anything with an explicit scheme AND a subresource extension, wherever it
    //     appears. The scheme is required here because `//server/share/x.js` is a
    //     Windows UNC path, not a url, and this repository has fixtures full of them.
    for (const url of view.match(URL_PATTERN) ?? []) {
      if (/^https?:\/\//i.test(url) && SUBRESOURCE_EXTENSION.test(url)) consider(url)
    }

    // (b) a url inside a fetching HTML tag, extension or not — a Google Fonts
    //     stylesheet url has no `.css` on the end, and `preconnect` has no path.
    if (isHtml) {
      for (const tag of view.match(HTML_SUBRESOURCE_TAG) ?? []) {
        for (const url of tag.match(URL_PATTERN) ?? []) consider(url)
      }
    }

    // (c) a url inside a CSS `url()` or `@import`, extension or not.
    for (const match of view.matchAll(CSS_URL)) consider(match[1] ?? '')
    for (const match of view.matchAll(CSS_IMPORT)) consider(match[1] ?? '')
  }

  return [...found]
}

// ── the assertions ──────────────────────────────────────────────────────────

describe('Requirement 17.7 — the window loads no subresource from off this machine', () => {
  it('scans the files it claims to scan', () => {
    const names = scannedFiles.map(shortName)
    expect(names).toContain('packages/desktop/index.html')
    expect(names).toContain('packages/desktop/src/styles/global.css')
    expect(names).toContain('packages/desktop/src/styles/fonts.css')
    expect(names).toContain('packages/core/src/providers/registry.ts')
    expect(scannedFiles.length).toBeGreaterThan(100)
  })

  it('names no font CDN in any source or HTML file', () => {
    const offenders: string[] = []
    for (const file of scannedFiles) {
      const hosts = fontHostsIn(readFileSync(file, 'utf8'))
      if (hosts.length > 0) offenders.push(`${shortName(file)}: ${hosts.join(', ')}`)
    }
    expect(
      offenders,
      'A web font from a CDN is a third party contacted on launch, before the user ' +
        'does anything. Vendor the file into src/assets/fonts/ and declare it in ' +
        'src/styles/fonts.css instead — do not widen this guard.',
    ).toEqual([])
  })

  it('references no non-loopback url as a subresource', () => {
    const offenders: string[] = []
    for (const file of scannedFiles) {
      const urls = externalSubresourcesIn(readFileSync(file, 'utf8'), file.endsWith('.html'))
      if (urls.length > 0) offenders.push(`${shortName(file)}: ${urls.join(', ')}`)
    }
    expect(
      offenders,
      'Every asset the window loads must come from the bundle or from loopback. A ' +
        'provider endpoint is fine — it is not a subresource, and PRIVACY.md §1 ' +
        'documents it — but a stylesheet, a script, a font or an image from a remote ' +
        'host is unasked-for egress on launch.',
    ).toEqual([])
  })

  it('declares no speculative connection hint in index.html', () => {
    // `preconnect` is the specific reason this guard exists: it opens a DNS lookup
    // and a TLS connection, and no CSP directive covers it, so removing the tag is
    // the only control. `dns-prefetch`, `prefetch` and `preload` are here because
    // they are the same idea with different names.
    const html = readFileSync(indexHtmlPath, 'utf8')
    const code = stripComments(html)
    for (const hint of ['preconnect', 'dns-prefetch', 'prefetch', 'preload', 'modulepreload']) {
      expect(code.toLowerCase(), `index.html declares rel="${hint}"`).not.toContain(hint)
    }
    // And the only tag left that loads anything is the local module entry point.
    const tags = code.match(HTML_SUBRESOURCE_TAG) ?? []
    expect(tags).toHaveLength(1)
    expect(tags[0]).toContain('src="/src/main.tsx"')
    expect(tags[0]).not.toContain('//')
  })
})

describe('Requirement 17.7 — the two families are vendored, licensed, and declared locally', () => {
  const interFile = join(fontsDir, 'inter-latin-variable.woff2')
  const monoFile = join(fontsDir, 'jetbrains-mono-latin-variable.woff2')

  it('ships both woff2 files, and they are really woff2', () => {
    for (const file of [interFile, monoFile]) {
      expect(existsSync(file), `${shortName(file)} is missing`).toBe(true)
      const bytes = readFileSync(file)
      // wOF2 magic. An empty placeholder or a saved HTML error page would pass a
      // size check and fail to render; the signature is what makes this real.
      expect(bytes.subarray(0, 4).toString('latin1'), shortName(file)).toBe('wOF2')
      expect(bytes.byteLength).toBeGreaterThan(10_000)
    }
  })

  it('ships the Open Font License text beside them, as the licence requires', () => {
    for (const licence of ['inter-OFL.txt', 'jetbrains-mono-OFL.txt']) {
      const path = join(fontsDir, licence)
      expect(existsSync(path), `${licence} is missing`).toBe(true)
      const text = readFileSync(path, 'utf8')
      expect(text).toContain('Open Font License')
      expect(text).toContain('Copyright')
    }
  })

  it('declares each family from a relative url the bundler resolves', () => {
    const css = readFileSync(join(desktopRoot, 'src', 'styles', 'fonts.css'), 'utf8')
    expect(css).toContain("font-family: 'Inter'")
    expect(css).toContain("font-family: 'JetBrains Mono'")
    expect(css).toContain('../assets/fonts/inter-latin-variable.woff2')
    expect(css).toContain('../assets/fonts/jetbrains-mono-latin-variable.woff2')
    // One variable file per family covers the four and three static weights the
    // deleted stylesheet used to request.
    expect(css.match(/@font-face/g)).toHaveLength(2)
    expect(css.match(/font-weight: 100 900;/g)).toHaveLength(2)

    // And the app actually loads them: global.css is the file main.tsx imports.
    const global = readFileSync(join(desktopRoot, 'src', 'styles', 'global.css'), 'utf8')
    expect(global).toContain("@import './fonts.css'")
    expect(global).toContain("--font-sans: 'Inter'")
    expect(global).toContain("--font-mono: 'JetBrains Mono'")
  })
})

describe('the egress scanner catches what it claims, and nothing it must not', () => {
  it('catches the tags that were deleted, and their variants', () => {
    const g = 'fonts.google' + 'apis.com'
    const s = 'fonts.gsta' + 'tic.com'
    const offending = [
      `<link rel="preconnect" href="https://${g}" />`,
      `<link href="https://${g}/css2?family=Inter" rel="stylesheet" />`,
      `<link rel="stylesheet" href="//${s}/inter.css" />`,
      `@import url('https://${g}/css2?family=Inter');`,
      `@font-face { src: url(https://${s}/s/inter/v13/x.woff2) format('woff2'); }`,
      `<script src="https://cdn.example.test/counter-shaped.js"></script>`,
      `<img src="https://tracker.example.test/pixel.png" />`,
      `const sheet = 'https://fonts.goo' + 'gleapis.com/css2?family=Inter'`,
      `body { background: url("https://cdn.example.test/hero.webp"); }`,
    ]
    for (const sample of offending) {
      const caught =
        fontHostsIn(sample).length > 0 || externalSubresourcesIn(sample, true).length > 0
      expect(caught, `not caught: ${sample}`).toBe(true)
    }
  })

  it('does not flag a provider endpoint, a loopback url, or a bundled asset', () => {
    const innocent = [
      "baseUrl: 'https://api.openai.com/v1'",
      "baseUrl: 'https://api.anthropic.com'",
      "baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'",
      "await fetch('https://api.example.invalid/v1/chat/completions')",
      "const local = 'http://localhost:11434/v1'",
      "const local = 'http://127.0.0.1:1234/v1/models'",
      "src: url('../assets/fonts/inter-latin-variable.woff2') format('woff2-variations')",
      '<script type="module" src="/src/main.tsx"></script>',
      "// see https://developer.mozilla.org/en-US/docs/Web/CSS/font-display for the tradeoff",
    ]
    for (const sample of innocent) {
      expect(fontHostsIn(sample), `false positive: ${sample}`).toEqual([])
      expect(externalSubresourcesIn(sample, true), `false positive: ${sample}`).toEqual([])
    }
  })

  it('treats a LAN address as external, because it is somebody else’s machine', () => {
    expect(isLoopback('192.168.1.10')).toBe(false)
    expect(isLoopback('10.0.0.5')).toBe(false)
    expect(isLoopback('localhost')).toBe(true)
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('127.13.1.9')).toBe(true)
  })
})
