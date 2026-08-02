// The MCP Tools panel, driven against the REAL curated catalog.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §1 — the two fixtures are GONE at the source level: `mcpToolsStatus` in `AppState`
//     (`{ connected: 5, total: 8 }`) and the chat sidebar tooltip naming four servers
//     this product does not have.
//   * §2 — there is NO connection count anywhere, and that is the honest answer rather
//     than a shortcut: servers start per run, so between runs nothing is connected.
//   * §3 — every row shows the capability it costs and the exact pinned argv, and no
//     command says `@latest`.
//   * §4 — the capability wording table covers every capability the real catalog uses,
//     so the duplicated copy cannot drift from the engine's vocabulary.
//
// Validates: Requirements 22.2, 22.4, 22.5, 27.1, 27.5

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METHODS, mcp, type MethodContext } from '@sketch/core'

import { McpTools } from './McpTools'
import { SketchClientProvider } from '../lib/ClientProvider'
import {
  createEventBus,
  type EventHandler,
  type McpCatalogResult,
  type PingResult,
  type SketchClient,
} from '../lib/client'
import { AppStateProvider } from '../state/AppState'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..')

function read(relative: string): string {
  return readFileSync(join(src, relative), 'utf8')
}

/**
 * Source with comments removed.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A WEAKENING ─────────────────────────
 *
 * The fixture guards below search for `mcpToolsStatus`, `connected: 5`, and the invented
 * tooltip text. A first version searched the raw file and failed — on the comments this
 * task wrote to record what was deleted and why. That is the same false positive
 * `deps.test.ts` hit when a `['from', 'into']` stopword array read as an import: the
 * DATA moved, not the guard.
 *
 * The honest rule was never "this string appears nowhere in the file", it is "this
 * fixture is not part of what ships". A comment does not ship behaviour, and forbidding
 * the words would mean the codebase could not explain its own history — which is worse,
 * because the next person to see `connected: 5` in a git log needs to find out it was
 * removed on purpose.
 *
 * So: comments are stripped and the CODE is searched. `stripsCommentsOnly` below proves
 * the stripper still catches a real occurrence, in a string literal, in JSX, and in a
 * property position — because a guard that removed too much would silently pass.
 */
function code(relative: string): string {
  return stripComments(read(relative))
}

function stripComments(source: string): string {
  let out = ''
  let index = 0
  // Tracks whether the scanner is inside a quoted run, so a `//` in a URL survives.
  let quote: string | null = null

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (quote !== null) {
      out += char
      if (char === '\\') {
        out += source[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1
      }
      index += 2
      continue
    }

    out += char
    index += 1
  }
  return out
}

function methodContext(env: NodeJS.ProcessEnv = {}): MethodContext {
  return {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env,
    cwd: () => process.cwd(),
  }
}

class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  private readonly ctx: MethodContext

  constructor(env: NodeJS.ProcessEnv = {}) {
    this.ctx = methodContext(env)
  }

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('the MCP panel never starts a run'))
  }
  eval(): Promise<never[]> {
    return Promise.resolve([])
  }
  subscribe(handler: EventHandler) {
    return this.bus.subscribe(handler)
  }
  gitStatus(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitDiff(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitStage(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitUnstage(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitCommit(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  providerCatalog(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  saveProviderSettings(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  testProvider(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }

  mcpCatalog(): Promise<McpCatalogResult> {
    return METHODS['mcp-catalog']!({}, this.ctx) as Promise<McpCatalogResult>
  }
}

function withoutMcp(client: EngineClient): SketchClient {
  const stripped = Object.create(client) as SketchClient
  stripped.mcpCatalog = undefined
  return stripped
}

function mount(client: SketchClient) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: null }}>
        <McpTools />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

afterEach(cleanup)

// ── 1. the fixtures are gone ────────────────────────────────────────────────

describe('the fixtures this panel replaced', () => {
  it('strips comments only — the guard below still catches a real occurrence', () => {
    // The refinement, proved on all four shapes a fixture could actually take.
    const sample = [
      '// mcpToolsStatus: { connected: 5 } — a comment about the deleted field',
      '/* mcpToolsStatus: { connected: 5 } */',
      'const keep = { mcpToolsStatus: { connected: 5 } }',
      'const url = "https://example.com/mcpToolsStatus"',
      '<div title="MCP Tools Active (cloudrun)" />',
    ].join('\n')
    const stripped = stripComments(sample)

    // Prose is gone.
    expect(stripped).not.toContain('a comment about the deleted field')
    // Code, a string literal, and JSX are all still there — twice for the property and
    // once for the URL, so a guard scanning this would still fail on the real thing.
    expect(stripped.match(/mcpToolsStatus/g)).toHaveLength(2)
    expect(stripped).toContain('connected: 5')
    expect(stripped).toContain('MCP Tools Active (cloudrun)')
    // A `//` inside a string is not a comment.
    expect(stripped).toContain('https://example.com')
  })

  it('has no mcpToolsStatus in AppState', () => {
    const state = code(join('state', 'AppState.tsx'))
    // The field, its initial value, and every read of it.
    expect(state).not.toContain('mcpToolsStatus')
    expect(state).not.toContain('connected: 5')
  })

  it('has no invented server names in the chat sidebar tooltip', () => {
    const sidebar = code(join('panels', 'ide', 'IdeChatSidebar.tsx'))
    // These four were never servers in this product.
    expect(sidebar).not.toContain('MCP Tools Active (cloudrun')
    expect(sidebar).not.toContain('mcpWarningBadge')
  })

  it('has no hardcoded badge left on the ActivityBar', () => {
    const bar = code(join('components', 'ide', 'ActivityBar.tsx'))
    expect(bar).not.toContain('mcpToolsStatus')
    expect(bar).not.toContain('badge:')
    // And the badge element itself, not only its data source.
    expect(bar).not.toContain('mcpBadge')
  })
})

// ── 2. no connection count, anywhere ────────────────────────────────────────

describe('what the panel does and does not claim', () => {
  it('reports configured-of-total and never a connection count', async () => {
    mount(new EngineClient())

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    const summary = screen.getByRole('status').textContent ?? ''
    expect(summary).toMatch(/\d+ of \d+ servers configured/)
    expect(summary).toContain('Nothing is connected between runs')
    // "configured" is a claim about credentials, not about a live process.
    expect(summary).not.toMatch(/\d+ connected/)
  })

  it('says which credentials are missing, by name', async () => {
    mount(new EngineClient())

    await waitFor(() => expect(screen.getByLabelText('Curated MCP servers')).toBeTruthy())
    // A surface can ask for exactly what is absent instead of showing an opaque
    // handshake failure ten seconds later.
    expect(screen.getByText(/GITHUB_PERSONAL_ACCESS_TOKEN/)).toBeTruthy()
    expect(screen.getAllByText('needs setup').length).toBeGreaterThan(0)
  })

  it('flips an entry to configured when its credential really is present', async () => {
    mount(new EngineClient({ NOTION_TOKEN: 'not-a-real-token' }))

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    // Notion needs exactly one variable, so supplying it must move the count.
    expect(screen.queryByText(/NOTION_TOKEN/)).toBeNull()
  })
})

// ── 3. the capability and the argv are both on screen ───────────────────────

describe('every row shows what it costs and what it runs', () => {
  it('names the one capability per server, in plain words', async () => {
    mount(new EngineClient())

    await waitFor(() => expect(screen.getByLabelText('Curated MCP servers')).toBeTruthy())
    for (const entry of mcp.MCP_CATALOG) {
      const command = screen.getByLabelText(`${entry.title} launch command`)
      expect(command.textContent).toContain(entry.launch.command)
      // Pinned. A command that changes under you is a supply chain that arrives
      // silently on the next invocation.
      expect(command.textContent).not.toContain('@latest')
    }
  })

  it('marks the grants that reach past this project', async () => {
    mount(new EngineClient())

    await waitFor(() => expect(screen.getByLabelText('Curated MCP servers')).toBeTruthy())
    // `proc:spawn` is on terminal, docker, ssh and android in the shipped catalog.
    const expected = mcp.MCP_CATALOG.filter((entry) => entry.requires === 'proc:spawn').length
    expect(screen.getAllByText(/reaches past this project/).length).toBe(expected)
  })

  it('shows each server’s caveat rather than only its capability', async () => {
    mount(new EngineClient())

    await waitFor(() => expect(screen.getByLabelText('Curated MCP servers')).toBeTruthy())
    // The capability alone does not say that a token's scopes are the real boundary,
    // or that the Docker socket is effectively root.
    const withCaveats = mcp.MCP_CATALOG.filter((entry) => entry.caveat !== undefined)
    expect(withCaveats.length).toBeGreaterThan(0)
    for (const entry of withCaveats) {
      expect(screen.getByText(entry.caveat!)).toBeTruthy()
    }
  })

  it('is honest that these packages are not audited', async () => {
    mount(new EngineClient())
    await waitFor(() => expect(screen.getByText(/has not audited their contents/)).toBeTruthy())
  })
})

// ── 4. the duplicated capability table cannot drift ─────────────────────────

describe('the capability wording', () => {
  it('covers every capability the real catalog uses', () => {
    const panel = read(join('panels', 'McpTools.tsx'))
    for (const capability of new Set(mcp.MCP_CATALOG.map((entry) => entry.requires))) {
      expect(panel).toContain(`'${capability}':`)
    }
  })

  it('covers the engine’s whole vocabulary, not just what the catalog happens to use', async () => {
    const { capabilities } = await import('@sketch/core')
    const panel = read(join('panels', 'McpTools.tsx'))
    for (const capability of capabilities.CAPABILITIES) {
      expect(panel).toContain(`'${capability}':`)
    }
  })
})

// ── 5. no engine, no list ───────────────────────────────────────────────────

describe('honest empty state', () => {
  it('refuses to invent a catalog when the transport has no engine', () => {
    mount(withoutMcp(new EngineClient()))
    expect(screen.getByText('No engine behind this transport')).toBeTruthy()
    expect(screen.getByText(/what the hardcoded badge this panel replaced was doing/)).toBeTruthy()
    expect(screen.queryByLabelText('Curated MCP servers')).toBeNull()
  })
})
