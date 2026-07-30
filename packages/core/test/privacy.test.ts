// Task 4.4 — the two claims PRIVACY.md makes that a test can hold up.
//
//   1. NO TELEMETRY VOCABULARY anywhere under `packages/**/src`, and no
//      telemetry-shaped dependency in any manifest or in the lockfile. A package
//      can phone home without its name ever appearing in our source, so the
//      manifests are scanned too.
//   2. A THROWN PROVIDER ERROR NEVER CARRIES THE CONFIGURED KEY. `redact()` already
//      does this; this file is what stops someone deleting the call. It regressed
//      once already, on the event-log side, and was only caught by a cold rebuild.
//
// WHY THE SCANNER IS NOT `String.includes`
// A guard that any of three trivial edits defeats is decoration. This one:
//   * is case-insensitive, so `PostHog` and `TELEMETRY` are caught;
//   * condenses adjacent string literals, so `'post' + 'hog'`, `['post','hog']`
//     and `` `post${''}hog` `` are caught;
//   * decodes `\uXXXX` and `\xNN` escapes, so `\u0070osthog` is caught;
//   * strips comments FIRST, so the prose explaining the ban — including in this
//     project's own source headers — is not a finding;
//   * requires identifier boundaries, so `ProviderSettingsEntry` (which contains
//     the letters s-e-n-t-r-y glued to `Settings`) is not a finding either.
//
// It does not defeat computed obfuscation (`String.fromCharCode`, a name assembled
// from a config value). Nothing static does. The defences there are the
// zero-dependency rule in deps.test.ts and code review.
//
// Validates: Requirements 17.5, 17.6, 17.8

import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OpenAICompatibleAdapter } from '../src/providers/openaiCompatible.js'
import { AnthropicMessagesAdapter } from '../src/providers/anthropicMessages.js'
import { REDACTED } from '../src/providers/redact.js'
import { testProviderConnection } from '../src/settings/connectionTest.js'
import type { Message } from '../src/types.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const packagesRoot = join(repoRoot, 'packages')

// ── 1. no telemetry ─────────────────────────────────────────────────────────

/**
 * The banned vocabulary, assembled from halves.
 *
 * Not squeamishness: this file lives in `test/`, outside the scanned `src/` roots,
 * but the same words appear in `tasks.md`, `NEED-TO-DO.md` and PRIVACY.md, and a
 * future move of this file into a scanned directory would otherwise turn the guard
 * into a self-report. The scanner reassembles concatenated literals precisely so
 * this trick would NOT save a real offender.
 */
const BANNED: readonly string[] = [
  'ana' + 'lytics',
  'tele' + 'metry',
  'sen' + 'try',
  'post' + 'hog',
]

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.json', '.css']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'resources', '.sketch', '.git'])

/** Every `src` directory under `packages/`, at any depth (`desktop/src-tauri/src` too). */
function srcRoots(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (!statSync(full).isDirectory()) continue
    if (entry === 'src') found.push(full)
    else found.push(...srcRoots(full))
  }
  return found
}

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

/**
 * Block comments, and line comments that are not the `//` of a URL scheme or the
 * inside of a string literal. `'https://post…'` must survive: deleting from `//`
 * to end of line unconditionally would erase an offending URL and call the file
 * clean.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w"'`])\/\/[^\n]*/g, '$1')
}

/** `\u0070` → `p`, `\x70` → `p`. Cheap, and it closes the obvious escape route. */
function decodeEscapes(source: string): string {
  return source
    .replace(/\\u\{?([0-9a-fA-F]{1,6})\}?/g, (m, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return code > 0x10ffff ? m : String.fromCodePoint(code)
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
}

/**
 * Join literals that are adjacent across a `+`, a `,`, or nothing at all, so
 * split-string evasion collapses back to one word. Deliberately narrow: it only
 * removes a quote/separator/quote run, never all whitespace, because gluing every
 * token in the file together manufactures words that are not in it.
 */
function joinAdjacentLiterals(source: string): string {
  let out = source.replace(/\$\{\s*(?:''|""|``)?\s*\}/g, '')
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/['"`]\s*[+,]?\s*['"`]/g, '')
    if (next === out) break
    out = next
  }
  return out
}

/** `initAnalytics` → `init Analytics`, so a camelCase-glued word is still a word. */
function splitCamelCase(source: string): string {
  return source.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

/**
 * `_` is NOT here: `TELEMETRY_ENDPOINT` is the word plus a separator, not a longer
 * identifier. Letters and digits are, which is what keeps `ProviderSettingsEntry`
 * (…gs + Entry, spelling s-e-n-t-r-y) out of the findings.
 */
const IDENTIFIER_CHAR = /[a-z0-9$]/

/** Occurrences of `word` in `haystack` that are not part of a longer identifier. */
function boundedHits(haystack: string, word: string): number {
  let hits = 0
  for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + 1)) {
    const before = at === 0 ? '' : haystack[at - 1]!
    const after = haystack[at + word.length] ?? ''
    if (IDENTIFIER_CHAR.test(before) || IDENTIFIER_CHAR.test(after)) continue
    hits++
  }
  return hits
}

/**
 * The banned words a blob contains, after normalization. Empty means clean.
 *
 * Three views of the same text, because no single one catches everything without
 * inventing findings: the text as written (`PostHog` → `posthog`), the text with
 * camelCase separated (`initAnalytics` → `init analytics`), and the text with
 * adjacent literals joined (`'post' + 'hog'` → `posthog`).
 */
function bannedWordsIn(source: string): string[] {
  const clean = decodeEscapes(stripComments(source))
  const views = [
    clean.toLowerCase(),
    splitCamelCase(clean).toLowerCase(),
    joinAdjacentLiterals(clean.toLowerCase()),
  ]
  return BANNED.filter((word) => views.some((view) => boundedHits(view, word) > 0))
}

const scannedRoots = srcRoots(packagesRoot)
const scannedFiles = scannedRoots.flatMap(filesUnder)

describe('Requirements 17.5, 17.6 — there is no telemetry to opt out of', () => {
  it('scans every src root in every package', () => {
    // A guard that inspects nothing is not a guard. Both packages, and the Rust
    // backend, must actually be in the set.
    const relative_ = scannedRoots.map((r) => relative(repoRoot, r).replaceAll('\\', '/'))
    expect(relative_).toContain('packages/core/src')
    expect(relative_).toContain('packages/desktop/src')
    expect(relative_).toContain('packages/desktop/src-tauri/src')
    expect(scannedFiles.length).toBeGreaterThan(100)
  })

  it('finds no telemetry vocabulary in any source file', () => {
    const offenders: string[] = []
    for (const file of scannedFiles) {
      const words = bannedWordsIn(readFileSync(file, 'utf8'))
      if (words.length > 0) {
        offenders.push(`${relative(repoRoot, file).replaceAll('\\', '/')}: ${words.join(', ')}`)
      }
    }

    expect(
      offenders,
      `Rule 13 and Requirement 17.5: v1 ships no analytics, crash reporting or usage ` +
        `tracking, and PRIVACY.md states so as a fact a reader can verify. If a build ` +
        `needs one of these words for an unrelated reason, rename the symbol — do not ` +
        `widen this guard.`,
    ).toEqual([])
  })

  it('declares no telemetry-shaped dependency in any manifest or in the lockfile', () => {
    const manifests = [
      join(repoRoot, 'package.json'),
      join(packagesRoot, 'core', 'package.json'),
      join(packagesRoot, 'desktop', 'package.json'),
    ].filter(existsSync)
    expect(manifests.length).toBe(3)

    const offenders: string[] = []
    for (const manifest of manifests) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      const names = [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ]
      for (const name of names) {
        for (const word of BANNED) {
          if (name.toLowerCase().includes(word)) offenders.push(`${manifest}: ${name}`)
        }
      }
    }

    // The lockfile covers transitive packages: a dependency of a dependency can
    // phone home without any of our manifests naming it.
    const lock = join(repoRoot, 'package-lock.json')
    if (existsSync(lock)) {
      const bytes = readFileSync(lock, 'utf8').toLowerCase()
      for (const word of BANNED) {
        if (boundedHits(bytes, word) > 0) offenders.push(`package-lock.json: ${word}`)
      }
    }

    expect(
      offenders,
      'A telemetry SDK in the tree is a telemetry SDK in the product, whether or not ' +
        'our own source imports it.',
    ).toEqual([])
  })

  it('detects the evasions it claims to detect, and none of the prose it must ignore', () => {
    // The scanner is itself under test: a guard nobody has broken on purpose is a
    // guard nobody knows works. Every string below is a synthetic sample.
    const evasions = [
      `import Post${'Hog'} from 'post' + 'hog-js'`,
      `const sdk = ['post', 'hog'].join('')`,
      `const sdk = \`post\${''}hog\``,
      `const sdk = '\\u0070osthog'`,
      `TELEMETRY_ENDPOINT = 'https://example.invalid/collect'`,
      `fetch('https://x.invalid//telemetry')`,
      `initAnalytics()`,
      `const dsn = 'sen' + 'try.io/123'`,
    ]
    for (const sample of evasions) {
      expect(bannedWordsIn(sample), `not caught: ${sample}`).not.toEqual([])
    }

    const innocent = [
      '// This package ships no analytics, no telemetry, and no crash reporting.',
      '/* posthog and sentry are forbidden by Rule 13. */',
      "import type { ProviderSettingsEntry } from './contracts.js'",
      'const rows: ProviderSettingsEntry[] = []',
      'const settings = { entry: 1 }',
      'function documentedElsewhere() { return 1 } // see PRIVACY.md, no telemetry',
    ]
    for (const sample of innocent) {
      expect(bannedWordsIn(sample), `false positive: ${sample}`).toEqual([])
    }
  })
})

// ── 2. a thrown provider error never carries the key ────────────────────────

/**
 * A synthetic credential with NO VENDOR SHAPE — no `sk-` prefix, no `AIza`, nothing
 * the pattern table recognizes. That is deliberate and it is the whole point of the
 * value: a shaped key is caught by `SECRET_KEY_SHAPES` even if the configured-value
 * redaction is deleted, so a test using one would pass through the mutation it is
 * supposed to catch. This is what a self-hosted gateway, a corporate proxy, or a
 * user's own token generator hands out, and the ONLY thing that can redact it is the
 * `secrets` list being wired through to `redact()`.
 */
const FAKE_KEY = 'Zq7Xr2Lp9Nv4Rt6Yb8Hd3Kf1Mj5Sc0Ae'

/** Never configured anywhere — it exists to prove the shape table works too. */
const ECHOED_SHAPED_KEY = 'sk-ant-api03-0000111122223333444455556666'

const HELLO: Message[] = [{ role: 'user', content: 'Hello' }]

const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
})

/** A 401 whose body echoes the credential back — the realistic leak, not a contrived one. */
function echoingUnauthorized() {
  const body = JSON.stringify({
    error: {
      // Bare, in prose: no header name and no query parameter around it, so no
      // pattern in the table can recognize it. Only the configured value can.
      message: `Invalid API key: ${FAKE_KEY}`,
      request: { headers: { authorization: `Bearer ${FAKE_KEY}` } },
      url: `https://api.example.invalid/v1/chat?key=${FAKE_KEY}`,
      hint: `expected a key like ${ECHOED_SHAPED_KEY}`,
    },
  })
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 401,
    json: () => Promise.resolve(JSON.parse(body)),
    text: () => Promise.resolve(body),
  })
}

async function rejection(call: Promise<unknown>): Promise<Error> {
  const outcome = await call.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  )
  if (outcome === null) throw new Error('expected the call to reject, but it resolved')
  return outcome
}

describe('Requirement 17.8 — a provider failure never carries the key out with it', () => {
  it('keeps the key out of an OpenAI-compatible 401', async () => {
    global.fetch = echoingUnauthorized() as unknown as typeof fetch
    const adapter = new OpenAICompatibleAdapter({
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.invalid/v1',
      model: 'gpt-4o',
      apiKey: FAKE_KEY,
    })

    const err = await rejection(adapter.chat(HELLO))
    // THE MUTATION TARGET: drop `secrets: this.secrets` (or the whole `providerError`
    // call) from openaiCompatible.ts and this line fails.
    expect(err.message).not.toContain(FAKE_KEY)
    // And a key-shaped value nobody configured is redacted on shape alone.
    expect(err.message).not.toContain(ECHOED_SHAPED_KEY)
    expect(err.message).toContain(REDACTED)
    // Still diagnosable: the provider and the status survive redaction.
    expect(err.message).toContain('openai')
    expect(err.message).toContain('401')
  })

  it('keeps the key out of an Anthropic 401, including a custom header value', async () => {
    global.fetch = echoingUnauthorized() as unknown as typeof fetch
    const adapter = new AnthropicMessagesAdapter({
      id: 'anthropic',
      kind: 'anthropic-messages',
      baseUrl: 'https://api.example.invalid',
      model: 'claude-3-5-sonnet-latest',
      apiKey: FAKE_KEY,
      headers: { 'x-proxy-token': 'proxy-token-0123456789' },
    })

    const err = await rejection(adapter.chat(HELLO))
    expect(err.message).not.toContain(FAKE_KEY)
    expect(err.message).not.toContain('proxy-token-0123456789')
    expect(err.message).toContain(REDACTED)
  })

  it('keeps the key out of a transport failure, where the reason is not ours to shape', async () => {
    // Node puts the request URL in some transport errors; a key in the query string
    // therefore rides out in `err.message` unless the redactor sees it.
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error(`request to https://api.example.invalid/v1/chat?key=${FAKE_KEY} failed`),
      ) as unknown as typeof fetch

    const adapter = new OpenAICompatibleAdapter({
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.invalid/v1',
      model: 'gpt-4o',
      apiKey: FAKE_KEY,
    })

    const err = await rejection(adapter.chat(HELLO))
    expect(err.message).not.toContain(FAKE_KEY)
    expect(err.message).toContain(REDACTED)
  })

  it('keeps the key out of the connection test verdict too', async () => {
    // The one other place a key crosses the wire (task 4.1). Same redactor, and the
    // result is returned rather than thrown, so it needs its own assertion.
    const result = await testProviderConnection(
      {
        id: 'openai',
        kind: 'openai-compatible',
        baseUrl: 'https://api.example.invalid/v1',
        model: 'gpt-4o',
        apiKey: FAKE_KEY,
      },
      { fetchImpl: echoingUnauthorized() as unknown as typeof fetch },
    )

    expect(result.code).toBe('unauthorized')
    expect(result.message).not.toContain(FAKE_KEY)
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
  })
})
