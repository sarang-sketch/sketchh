// Phase 5 gate, the UI half — "prove diagrams render", on the fifty-file fixture.
//
// The core gate (`packages/core/test/phase5-gate.test.ts`) measures the context
// claims of Requirement 18.7 and asserts the generator produces deterministic
// Mermaid for the same fixture. What it cannot assert is that anything is DRAWN: core
// has no renderer, by design. This file closes that half.
//
// ONE REAL CHAIN, no mocks anywhere in it:
//
//   fifty real files on disk
//     → the real `architecture` RPC method, dispatched from the real `METHODS`
//       table in process (the same table the sidecar and the dev bridge dispatch)
//     → the real walker, chunker and import extractor via `buildRepoGraph`
//     → the real generator's seven views as Mermaid text
//     → the real local parser and layout (`src/architecture/flowchart.ts`)
//     → SVG elements in the document, counted
//
// THE ASSERTIONS THAT CARRY IT:
//   * every view the generator called available is drawn, with as many `<rect>`
//     boxes as it reported nodes — so "renders" means geometry in the document, not
//     a heading and an empty frame;
//   * every label in the document is a TEXT NODE, and no diagram-derived HTML is
//     built anywhere (the parser and the panel are read as source and checked);
//   * a view the generator called unavailable draws NOTHING and shows its reason;
//   * the same fixture twice produces the same picture — determinism is visible on
//     screen, not only in the digest (Requirement 19.4).
//
// The fixture is regenerated here rather than imported: it is test data in another
// package's test directory, and reaching across for it would couple two suites
// together. It is the same shape — ten domains, five files each — and the file count
// is asserted, so a drift in either copy is loud.
//
// Offline, no key, no network: every step above is a derivation over local text.
//
// Validates: Requirements 19.3, 19.4, 19.5, 27.1

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METHODS, type MethodContext } from '@sketch/core'

import { LiveArchitecture } from './panels/LiveArchitecture'
import { SketchClientProvider } from './lib/ClientProvider'
import {
  createEventBus,
  type ArchitectureResult,
  type EventHandler,
  type PingResult,
  type SketchClient,
} from './lib/client'
import { AppStateProvider } from './state/AppState'

// ── the fifty-file fixture ──────────────────────────────────────────────────

const DOMAINS = [
  'auth',
  'billing',
  'catalog',
  'delivery',
  'inventory',
  'notifications',
  'payments',
  'reporting',
  'scheduling',
  'shipping',
] as const

const KINDS = ['config', 'handler', 'model', 'service', 'util'] as const

/**
 * `reporting` trades its `util.ts` for a `schema.sql`, so the file count stays at
 * fifty while the database view has the only evidence it will accept: a schema
 * written down in the repository AS a schema. See the section note in
 * `packages/core/src/context/architecture.ts` on why embedded DDL is not evidence.
 */
const SCHEMA_DOMAIN = 'reporting'

function kindsFor(domain: string): readonly string[] {
  return domain === SCHEMA_DOMAIN
    ? ['config', 'handler', 'model', 'service', 'schema.sql']
    : KINDS
}

const EXPECTED_FILES = DOMAINS.length * KINDS.length

const tmpDirs: string[] = []

function title(word: string): string {
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`
}

/**
 * Ten domains × five files. `service.ts` imports the other files in its domain and
 * calls across the boundary, so the dependency and call-graph views have real edges
 * to draw rather than a scatter of isolated boxes.
 *
 * WHERE THIS FIXTURE DIFFERS FROM THE CORE GATE'S, AND WHY. The core gate measures
 * retrieval, so its fifty files are deliberately plain: one vocabulary per domain, no
 * cross-domain imports, nothing to confuse a relevance measurement. This one measures
 * DRAWING, so it carries the evidence the remaining three views require and refuse to
 * fake — route registrations for the API view, a `.sql` schema for the database view,
 * and one import that crosses a module boundary for the system view. Same file count,
 * different question. Both numbers are asserted, so neither copy can drift silently.
 */
function sourceFor(domain: string, kind: string): string {
  const type = title(domain)
  switch (kind) {
    case 'schema.sql':
      return [
        '-- Reporting warehouse schema.',
        'CREATE TABLE report_run (',
        '  id TEXT PRIMARY KEY,',
        '  started_at INTEGER NOT NULL,',
        '  state TEXT NOT NULL',
        ');',
        '',
        'CREATE TABLE report_column (',
        '  id TEXT PRIMARY KEY,',
        '  run_id TEXT NOT NULL REFERENCES report_run(id),',
        '  heading TEXT NOT NULL',
        ');',
        '',
      ].join('\n')
    case 'config':
      return [
        `// Configuration for the ${domain} domain.`,
        `export const ${domain.toUpperCase()}_PREFIX = '${domain}-'`,
        `export const ${domain.toUpperCase()}_MAX_ATTEMPTS = 3`,
        `export function ${domain}Config(): { prefix: string } {`,
        `  return { prefix: ${domain.toUpperCase()}_PREFIX }`,
        '}',
        '',
      ].join('\n')
    case 'model':
      return [
        `export interface ${type}Row {`,
        '  readonly id: string',
        '  readonly state: string',
        '}',
        `export function empty${type}Rows(): ${type}Row[] {`,
        '  return []',
        '}',
        '',
      ].join('\n')
    case 'util':
      return [
        `export function normalise${type}Id(raw: string): string {`,
        '  return raw.trim().toLowerCase()',
        '}',
        '',
      ].join('\n')
    case 'service': {
      const local = domain === SCHEMA_DOMAIN ? [] : [`import { normalise${type}Id } from './util.js'`]
      // ONE import that crosses a module boundary, so the system view has a real
      // cross-module edge instead of ten islands.
      const crossing = domain === 'payments' ? ["import { loadBilling } from '../billing/service.js'"] : []
      const filter =
        domain === SCHEMA_DOMAIN
          ? '  return rows.filter((row) => row.id.startsWith(config.prefix))'
          : `  return rows.filter((row) => normalise${type}Id(row.id).startsWith(config.prefix))`
      return [
        `import { ${domain}Config } from './config.js'`,
        `import { empty${type}Rows, type ${type}Row } from './model.js'`,
        ...local,
        ...crossing,
        `export function load${type}(rows: readonly ${type}Row[]): ${type}Row[] {`,
        `  const config = ${domain}Config()`,
        `  if (rows.length === 0) return empty${type}Rows()`,
        ...(domain === 'payments' ? ['  void loadBilling([])'] : []),
        filter,
        '}',
        '',
      ].join('\n')
    }
    case 'handler':
      return [
        `import { load${type} } from './service.js'`,
        `import type { ${type}Row } from './model.js'`,
        '',
        `// HTTP surface for the ${domain} domain.`,
        `export function register${type}Routes(router: {`,
        '  get(path: string, handler: () => unknown): void',
        '  post(path: string, handler: () => unknown): void',
        '}): void {',
        `  router.get('/${domain}', () => handle${type}List([]))`,
        `  router.post('/${domain}', () => handle${type}List([]))`,
        '}',
        '',
        `export function handle${type}List(rows: readonly ${type}Row[]): string[] {`,
        `  return load${type}(rows).map((row) => row.state)`,
        '}',
        '',
      ].join('\n')
    default:
      throw new Error(`no source for kind ${kind}`)
  }
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'sketch-phase5-ui-'))
  tmpDirs.push(root)
  for (const domain of DOMAINS) {
    mkdirSync(join(root, 'src', domain), { recursive: true })
    for (const kind of kindsFor(domain)) {
      const name = kind.includes('.') ? kind : `${kind}.ts`
      writeFileSync(join(root, 'src', domain, name), sourceFor(domain, kind), 'utf8')
    }
  }
  return root
}

afterAll(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A locked temp directory on Windows is not a test failure.
    }
  }
})

afterEach(() => {
  cleanup()
})

// ── the real engine, in process ─────────────────────────────────────────────

function methodContext(): MethodContext {
  return {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => process.cwd(),
  }
}

class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  private readonly ctx = methodContext()

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('this gate never starts a run'))
  }
  /** This panel starts no run, so it has none to stop. */
  
/** This surface starts no interactive run, so nothing awaits an answer. */

reply(): Promise<never> {
  return Promise.reject(new Error('this surface never answers a question'))
}

cancel(): Promise<never> {
    return Promise.reject(new Error('this surface never cancels a run'))
  }

  eval(): Promise<never[]> {
    return Promise.resolve([])
  }
  subscribe(handler: EventHandler) {
    return this.bus.subscribe(handler)
  }
  gitStatus(): Promise<never> {
    return Promise.reject(new Error('this gate never reads git'))
  }
  gitDiff(): Promise<never> {
    return Promise.reject(new Error('this gate never reads git'))
  }
  gitStage(): Promise<never> {
    return Promise.reject(new Error('this gate never reads git'))
  }
  gitUnstage(): Promise<never> {
    return Promise.reject(new Error('this gate never reads git'))
  }
  gitCommit(): Promise<never> {
    return Promise.reject(new Error('this gate never reads git'))
  }
  providerCatalog(): Promise<never> {
    return Promise.reject(new Error('this gate never reads provider settings'))
  }
  saveProviderSettings(): Promise<never> {
    return Promise.reject(new Error('this gate never writes provider settings'))
  }
  testProvider(): Promise<never> {
    return Promise.reject(new Error('this gate never tests a provider'))
  }

  architecture(params: { root: string; index?: boolean }): Promise<ArchitectureResult> {
    return METHODS['architecture']!(
      { root: params.root, ...(params.index === true ? { index: true } : {}) },
      this.ctx,
    ) as Promise<ArchitectureResult>
  }
}

function mount(root: string, client: SketchClient) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <LiveArchitecture />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

/** Index through the panel's own offer, then wait for the tab strip. */
async function openIndexed(root: string): Promise<ArchitectureResult> {
  const client = new EngineClient()
  // The engine answer is captured directly as well: every assertion below compares
  // what is DRAWN against what the generator SAID, not against a hardcoded number.
  const answer = await client.architecture({ root, index: true })
  mount(root, client)
  await waitFor(() => expect(screen.getByRole('tablist')).toBeDefined(), { timeout: 10_000 })
  return answer
}

function currentPanel(): HTMLElement {
  const panel = document.querySelector('[role="tabpanel"]')
  if (panel === null) throw new Error('no tabpanel rendered')
  return panel as HTMLElement
}

function svgOf(panel: HTMLElement): SVGSVGElement | null {
  return panel.querySelector('svg')
}

// ── the gate ────────────────────────────────────────────────────────────────

describe('Phase 5 gate (UI) — diagrams render from the fifty-file fixture', () => {
  it('indexes fifty files and draws every view the generator called available', async () => {
    const root = makeFixture()
    const answer = await openIndexed(root)

    expect(answer.graphPresent).toBe(true)
    expect(answer.indexed?.indexed).toBe(EXPECTED_FILES)
    expect(EXPECTED_FILES).toBe(50)
    expect(answer.diagrams.views).toHaveLength(7)
    // All SEVEN, on this fixture: it carries route registrations, a `.sql` schema and
    // a cross-module import precisely so that no view has to be excused. If a view
    // regresses to unavailable here, its evidence rule changed.
    expect(answer.diagrams.available.length).toBe(7)

    const drawn: string[] = []
    for (const view of answer.diagrams.views) {
      // Open the view through its tab, exactly as a user would.
      const tab = document.querySelector(`[data-view="${view.kind}"]`)
      expect(tab, `no tab for ${view.kind}`).not.toBeNull()
      ;(tab as HTMLElement).click()
      await waitFor(() =>
        expect(currentPanel().getAttribute('data-view')).toBe(view.kind),
      )

      const panel = currentPanel()
      const svg = svgOf(panel)

      if (!view.available) {
        // The honesty rule: a reason, and NO drawing surface at all.
        expect(svg, `${view.kind} drew an empty diagram`).toBeNull()
        expect(panel.textContent).toContain(view.reason)
        continue
      }

      expect(svg, `${view.kind} reported ${view.nodes} nodes but drew no svg`).not.toBeNull()
      // Geometry, counted: one box per node the generator reported.
      expect(svg!.querySelectorAll('rect').length, view.kind).toBe(view.nodes)
      // Every label reached the document as text.
      expect(svg!.querySelectorAll('text').length).toBeGreaterThan(0)
      expect(svg!.getAttribute('width')).not.toBe('0')
      drawn.push(`${view.kind}:${view.nodes}n/${view.edges}e`)
    }

    // eslint-disable-next-line no-console
    console.log(
      `[phase 5 gate/ui] ${EXPECTED_FILES} files indexed; drawn ${drawn.length}/7 views — ${drawn.join(', ')}`,
    )
    expect(drawn.length).toBe(answer.diagrams.available.length)
  })

  it('draws the dependency edges the graph really contains', async () => {
    const root = makeFixture()
    const answer = await openIndexed(root)

    const dependency = answer.diagrams.views.find((view) => view.kind === 'dependency')!
    expect(dependency.available).toBe(true)
    // `service.ts` imports three files in its domain, ten times over, so the edge
    // count cannot be an artefact of a single lucky file.
    expect(dependency.edges).toBeGreaterThan(10)
    ;(document.querySelector('[data-view="dependency"]') as HTMLElement).click()
    await waitFor(() => expect(currentPanel().getAttribute('data-view')).toBe('dependency'))

    const svg = svgOf(currentPanel())!
    expect(svg.querySelectorAll('line').length).toBe(dependency.edges)
    // An arrowhead marker, so direction is visible rather than implied.
    expect(svg.querySelector('marker')).not.toBeNull()
  })

  it('draws the same picture twice for the same fixture (19.4)', async () => {
    const first = makeFixture()
    const firstAnswer = await openIndexed(first)
    const firstSvg = svgOf(currentPanel())!.outerHTML
    cleanup()

    // A second, independent copy of the identical tree in a different directory: the
    // digest must match and so must the pixels, which is what "diffable" has to mean
    // for a diagram someone reviews.
    const second = makeFixture()
    const secondAnswer = await openIndexed(second)
    const secondSvg = svgOf(currentPanel())!.outerHTML

    expect(secondAnswer.diagrams.digest).toBe(firstAnswer.diagrams.digest)
    expect(secondSvg).toBe(firstSvg)
  })

  it('builds no HTML from diagram content anywhere in the render path', () => {
    // Labels are file paths and declaration names — repository content, and therefore
    // attacker-influenced. This window's CSP still allows inline script, so an
    // innerHTML sink in this path would be the whole game.
    const here = dirname(fileURLToPath(import.meta.url))
    for (const relative of ['panels/LiveArchitecture.tsx', 'architecture/flowchart.ts']) {
      const source = readFileSync(join(here, relative), 'utf8')
      expect(source, relative).not.toContain('dangerouslySetInnerHTML')
      expect(source, relative).not.toMatch(/\.innerHTML\s*=/)
      expect(source, relative).not.toContain('insertAdjacentHTML')
      // And no mermaid dependency crept in to render the text for us.
      expect(source, relative).not.toMatch(/from\s+['"]mermaid['"]/)
    }
  })
})
