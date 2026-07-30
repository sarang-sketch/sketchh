// The architecture generator — seven views derived from the persisted repository
// graph (Requirement 19.1–19.5).
//
// ── WHAT IT READS, AND NOTHING ELSE ──────────────────────────────────────────
//
// Two inputs, both local: `.sketch/index/graph.json` (repo-graph.ts) and the
// bytes of the files that graph already lists. There is no second walker and no
// second import parser here — the graph's resolved `imports` edges ARE the
// dependency evidence, and `extractSignatures` (signatures.ts) is the only
// declaration reader. No network, ever (19.5): the generator makes no request,
// and every function in this file is a pure derivation over text.
//
// ── THE FORMAT IS MERMAID SOURCE, AS TEXT ───────────────────────────────────
//
// Every view renders to a Mermaid `flowchart`. Mermaid is plain text, so it
// diffs, it can be asserted on by string comparison, it renders in the desktop
// package (or GitHub, or a docs site), and it costs `packages/core` exactly zero
// runtime dependencies — which is a hard constraint here. Rendering is somebody
// else's problem on purpose. `erDiagram`/`classDiagram` were passed over so all
// seven views share one renderer and one determinism story.
//
// ── DETERMINISM IS THE POINT (19.4) ─────────────────────────────────────────
//
// For a fixed graph the output is byte-identical, every time, on every host:
//
//   * every collection is sorted before it is emitted, with a locale-independent
//     comparator (`localeCompare` varies by host locale and would make the bytes
//     machine-dependent);
//   * no `Map` or `Set` iteration order reaches the output — maps are read
//     through a sorted array of their keys;
//   * node ids (`n0`, `n1`, …) are assigned from the sorted node order, so they
//     are a function of the content, not of discovery order;
//   * nothing carries a timestamp, an absolute path, or a random id.
//
// A diagram that churns on rebuild makes its own diff useless, which would
// defeat the entire reason for generating it from the graph.
//
// ── HONESTY: A VIEW WITH NO EVIDENCE SAYS SO ────────────────────────────────
//
// This is the rule that matters most in this file. Several of these views need
// knowledge the graph does not have. An "API view" inferred from import edges is
// a guess; a "database view" with no schema in the repository is a bigger guess.
// So every view is either derived from NAMED, COUNTABLE evidence or it is
// returned with `available: false`, an empty `mermaid` string, and a `reason`
// that states what was searched for and not found. A plausible-looking diagram
// built from nothing is worse than no diagram: it is documentation that lies.
//
// Evidence per view:
//
//   folder-tree  paths in the graph                            (structural, exact)
//   dependency   resolved `imports` edges in the graph          (exact)
//   system       those same edges, aggregated by module         (exact + a stated
//                                                                grouping rule)
//   component    public declarations from `extractSignatures`   (heuristic scan)
//   call-graph   textual call sites of imported declarations    (heuristic, no
//                                                                type resolution)
//   api          route registrations found in source            (heuristic)
//   database     SQL DDL / Prisma models found in source        (heuristic)
//
// The heuristic ones carry a `caveat` string naming the limit. Where the scan
// finds nothing, the view is unavailable — it does not fall back to inference.
//
// ── THE EVENT ────────────────────────────────────────────────────────────────
//
// One `diagram_updated` per generation (19.2), carrying a per-view summary:
// kind, availability, the unavailability reason, node/edge counts, and the
// evidence record. `diagram_updated` already exists in the contract (types.ts);
// nothing is invented here. One event per generation rather than one per view
// keeps the log readable — the seven views are regenerated together, always.
//
// Validates: Requirements 19.1, 19.2, 19.3, 19.4, 19.5

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventInput } from '../events/store.js'
import { contentHash } from './embedding-cache.js'
import { loadRepoGraph, graphPath, type RepoGraph } from './repo-graph.js'
import {
  extractSignatures,
  languageOf,
  stripNoise,
  type Declaration,
  type SignatureLanguage,
} from './signatures.js'

/** Bumped when the emitted shape changes. */
export const ARCHITECTURE_VERSION = 1

/** The one diagram format. Plain text, no runtime dependency. */
export const DIAGRAM_FORMAT = 'mermaid'

export type ArchitectureViewKind =
  | 'system'
  | 'api'
  | 'database'
  | 'component'
  | 'dependency'
  | 'folder-tree'
  | 'call-graph'

/** Fixed emission order. Requirement 19.1 lists exactly these seven. */
export const ARCHITECTURE_VIEWS: readonly ArchitectureViewKind[] = [
  'system',
  'api',
  'database',
  'component',
  'dependency',
  'folder-tree',
  'call-graph',
]

/** Where a view's content came from, in numbers a test can assert on. */
export interface ViewEvidence {
  /** Named source of truth, e.g. `graph.imports` or `source scan: route registrations`. */
  source: string
  /** Evidence items found: edges, routes, tables, declarations, call sites. */
  found: number
  /** Files actually inspected while looking for it. */
  inspected: number
  /** Stated limit when the derivation is pattern-matched rather than resolved. */
  caveat: string | null
}

export interface ArchitectureView {
  kind: ArchitectureViewKind
  title: string
  /** Mermaid source. Empty string exactly when `available` is false. */
  mermaid: string
  available: boolean
  /** Why there is no diagram. Null exactly when `available` is true. */
  reason: string | null
  evidence: ViewEvidence
  /** Nodes emitted (after any cap). */
  nodes: number
  /** Edges emitted (after any cap). */
  edges: number
  /** True when a cap dropped nodes or edges; the Mermaid text says so too. */
  truncated: boolean
}

export interface ArchitectureDiagrams {
  version: number
  format: typeof DIAGRAM_FORMAT
  /** Files in the graph the views were derived from. */
  graphFiles: number
  /** Files whose bytes were read for the source-scanning views. */
  sourcesRead: number
  /** Views in `ARCHITECTURE_VIEWS` order. */
  views: ArchitectureView[]
  /** Kinds with real evidence, sorted. */
  available: ArchitectureViewKind[]
  /** Kinds reported unavailable, sorted. */
  unavailable: ArchitectureViewKind[]
  /** sha256 of `renderArchitectureDocument(result)`. The diffable identity. */
  digest: string
}

export interface GenerateArchitectureOptions {
  /** The graph. Omitted means load `<baseDir>/.sketch/index/graph.json`. */
  graph?: RepoGraph | null
  /** Project root, used to read file bytes. Required for the scanning views. */
  root?: string
  /** Where `.sketch/` lives. Defaults to `root`. */
  baseDir?: string
  /** File-read seam. Returns null when unreadable. Defaults to real `readFile`. */
  readSource?: (absolutePath: string, relativePath: string) => Promise<string | null>
  /** Node cap per view. */
  maxNodes?: number
  /** Edge cap per view. */
  maxEdges?: number
  /** Optional event sink for `diagram_updated`. */
  events?: { emit(event: EventInput): Promise<void> | void }
  runId?: string
}

export const DEFAULT_MAX_NODES = 200
export const DEFAULT_MAX_EDGES = 400
/** Files larger than this are not scanned; the reason strings count them. */
export const MAX_SOURCE_BYTES = 512 * 1024

/**
 * Extensions whose bytes are read. Everything else is left alone: the scanning
 * views have no pattern for it, so reading it would only cost time.
 */
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.pyi',
  '.sql',
  '.prisma',
])

/**
 * Directories that hold modules rather than being one. A file's module is its
 * first path segment, unless that segment is one of these, in which case it is
 * the first two. Stated here because the system view's grouping is a CHOICE, and
 * an unstated grouping rule is indistinguishable from a guess.
 */
const CONTAINER_DIRECTORIES = new Set(['src', 'lib', 'libs', 'packages', 'apps', 'app', 'pkg'])

/** Locale-independent ordering. `localeCompare` would make output host-dependent. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ── the one renderer ────────────────────────────────────────────────────────

interface DiagramNode {
  /** Stable identity. Sorted; ids are assigned from this order. */
  key: string
  label: string
}

interface DiagramEdge {
  from: string
  to: string
  label?: string
}

interface RenderedDiagram {
  mermaid: string
  nodes: number
  edges: number
  truncated: boolean
}

/**
 * Escape a label for a Mermaid quoted node. Quotes become the HTML entity
 * Mermaid understands; newlines become `<br/>`.
 */
function mermaidLabel(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/\r?\n/g, '<br/>')
}

/**
 * Render nodes and edges as a Mermaid flowchart.
 *
 * THE SINGLE ORDERING AUTHORITY. Sorting happens here, once, for every view:
 * nodes by key, edges by (from, to, label), with node ids assigned from the
 * sorted node order. Call sites deliberately do NOT pre-sort — a second sort
 * upstream would be redundant, and redundant guards are the ones that hide a
 * broken one. Removing the sort below makes discovery order leak into the ids of
 * every view at once, which the determinism tests observe.
 *
 * Caps drop the tail of those sorted orders — deterministic, and announced in a
 * comment line so a truncated diagram never reads as complete.
 */
function renderFlowchart(
  direction: 'TD' | 'LR',
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  notes: readonly string[],
  maxNodes: number,
  maxEdges: number
): RenderedDiagram {
  const sortedNodes = [...nodes].sort((a, b) => compareText(a.key, b.key))
  const sortedEdges = [...edges].sort(
    (a, b) =>
      compareText(a.from, b.from) ||
      compareText(a.to, b.to) ||
      compareText(a.label ?? '', b.label ?? '')
  )

  let truncated = false
  let keptNodes = sortedNodes
  if (sortedNodes.length > maxNodes) {
    // The node cap prefers CONNECTED nodes. Slicing the sorted node list blindly
    // filters away most edges and leaves a capped diagram that is a list of boxes
    // with nothing between them — technically truncated, practically useless. The
    // selection is still a pure function of sorted order, and the surviving nodes
    // are emitted in that same order, so ids stay content-derived.
    const connected = new Set<string>()
    for (const edge of sortedEdges.slice(0, maxEdges)) {
      connected.add(edge.from)
      connected.add(edge.to)
    }
    const keptKeys = new Set<string>()
    for (const node of sortedNodes) {
      if (connected.has(node.key) && keptKeys.size < maxNodes) keptKeys.add(node.key)
    }
    for (const node of sortedNodes) {
      if (keptKeys.size < maxNodes) keptKeys.add(node.key)
    }
    keptNodes = sortedNodes.filter(node => keptKeys.has(node.key))
    truncated = true
  }

  const ids = new Map<string, string>()
  keptNodes.forEach((node, index) => ids.set(node.key, `n${index}`))

  const drawable = sortedEdges.filter(e => ids.has(e.from) && ids.has(e.to))
  const keptEdges = drawable.slice(0, maxEdges)
  if (keptEdges.length < drawable.length) truncated = true

  const lines: string[] = [`flowchart ${direction}`]
  for (const note of notes) lines.push(`  %% ${note}`)
  if (keptNodes.length < sortedNodes.length) {
    lines.push(`  %% truncated: ${keptNodes.length} of ${sortedNodes.length} nodes shown`)
  }
  if (keptEdges.length < sortedEdges.length) {
    // Counted against ALL edges, not just the drawable ones: an edge dropped
    // because the node cap removed an endpoint is still a dropped edge.
    lines.push(`  %% truncated: ${keptEdges.length} of ${sortedEdges.length} edges shown`)
  }
  for (const node of keptNodes) {
    lines.push(`  ${ids.get(node.key)!}["${mermaidLabel(node.label)}"]`)
  }
  for (const edge of keptEdges) {
    const from = ids.get(edge.from)!
    const to = ids.get(edge.to)!
    lines.push(
      edge.label === undefined || edge.label === ''
        ? `  ${from} --> ${to}`
        : `  ${from} -->|"${mermaidLabel(edge.label)}"| ${to}`
    )
  }
  return {
    mermaid: `${lines.join('\n')}\n`,
    nodes: keptNodes.length,
    edges: keptEdges.length,
    truncated,
  }
}

/** An unavailable view: no diagram, and a reason that names what was missing. */
function unavailable(
  kind: ArchitectureViewKind,
  title: string,
  reason: string,
  evidence: ViewEvidence
): ArchitectureView {
  return {
    kind,
    title,
    mermaid: '',
    available: false,
    reason,
    evidence,
    nodes: 0,
    edges: 0,
    truncated: false,
  }
}

function availableView(
  kind: ArchitectureViewKind,
  title: string,
  rendered: RenderedDiagram,
  evidence: ViewEvidence
): ArchitectureView {
  return {
    kind,
    title,
    mermaid: rendered.mermaid,
    available: true,
    reason: null,
    evidence,
    nodes: rendered.nodes,
    edges: rendered.edges,
    truncated: rendered.truncated,
  }
}

// ── source material ─────────────────────────────────────────────────────────

export interface SourceFile {
  path: string
  extension: string
  text: string
  language: SignatureLanguage
}

interface SourceSet {
  /** Sorted by path. */
  files: SourceFile[]
  /** Files in the graph whose extension is scanned at all. */
  candidates: number
  /** Candidates that could not be read, or were over the size cap. */
  skipped: number
}

async function readSources(
  graph: RepoGraph,
  options: GenerateArchitectureOptions
): Promise<SourceSet> {
  const root = options.root
  const read =
    options.readSource ??
    (async (absolute: string): Promise<string | null> => {
      try {
        return await readFile(absolute, 'utf8')
      } catch {
        return null
      }
    })

  const files: SourceFile[] = []
  let candidates = 0
  let skipped = 0

  // `graph.files` is already sorted by path (repo-graph normalises it), and the
  // reads happen in that order, so nothing about the result depends on IO timing.
  for (const file of graph.files) {
    if (!SCANNED_EXTENSIONS.has(file.extension)) continue
    candidates++
    if (file.size > MAX_SOURCE_BYTES) {
      skipped++
      continue
    }
    if (root === undefined) {
      skipped++
      continue
    }
    const text = await read(join(root, file.path), file.path)
    if (text === null) {
      skipped++
      continue
    }
    files.push({
      path: file.path,
      extension: file.extension,
      text,
      language: languageOf(file.path),
    })
  }

  files.sort((a, b) => compareText(a.path, b.path))
  return { files, candidates, skipped }
}

/** The module a file belongs to, under the stated grouping rule. */
export function moduleOf(path: string): string {
  const parts = path.split('/')
  if (parts.length === 1) return '(root)'
  if (CONTAINER_DIRECTORIES.has(parts[0]!) && parts.length > 2) {
    return `${parts[0]!}/${parts[1]!}`
  }
  return parts[0]!
}

/**
 * Declarations that form a module's public surface: `export`-prefixed in the
 * JavaScript family, top-level and not underscore-prefixed in Python. These are
 * the only names another file could plausibly import, so they are the only ones
 * the component and call-graph views consider.
 */
export function publicDeclarations(source: SourceFile): Declaration[] {
  const extraction = extractSignatures(source.path, source.text, { includeDoc: false })
  if (!extraction.supported) return []
  const kept = extraction.declarations.filter(declaration => {
    if (extraction.language === 'python') {
      return !declaration.name.startsWith('_') && !/^[ \t]/.test(declaration.signature)
    }
    return /^\s*export\b/.test(declaration.signature)
  })
  return kept.sort(
    (a, b) => compareText(a.name, b.name) || compareText(a.kind, b.kind) || a.line - b.line
  )
}

// ── 1. folder tree — structural, always real when the graph has files ────────

function folderTreeView(
  graph: RepoGraph,
  maxNodes: number,
  maxEdges: number
): ArchitectureView {
  const evidence: ViewEvidence = {
    source: 'graph.files[].path',
    found: graph.fileCount,
    inspected: graph.fileCount,
    caveat: null,
  }
  if (graph.files.length === 0) {
    return unavailable(
      'folder-tree',
      'Folder tree',
      'the graph contains no files, so there is no tree to draw',
      evidence
    )
  }

  const ROOT = '\u0000root'
  const nodes = new Map<string, string>([[ROOT, '.']])
  const edges: DiagramEdge[] = []
  const seenEdges = new Set<string>()

  const addEdge = (from: string, to: string): void => {
    const key = `${from}\u0000${to}`
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    edges.push({ from, to })
  }

  for (const file of graph.files) {
    const parts = file.path.split('/')
    let parent = ROOT
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/')
      // Directory keys sort above their files by construction: the trailing '/'
      // is part of the key, not just the label.
      const key = `${dir}/`
      if (!nodes.has(key)) nodes.set(key, `${parts[i]!}/`)
      addEdge(parent, key)
      parent = key
    }
    nodes.set(file.path, parts[parts.length - 1]!)
    addEdge(parent, file.path)
  }

  const rendered = renderFlowchart(
    'TD',
    [...nodes.keys()].map(key => ({ key, label: nodes.get(key)! })),
    edges,
    ['folder tree: every path in the graph'],
    maxNodes,
    maxEdges
  )
  return availableView('folder-tree', 'Folder tree', rendered, evidence)
}

// ── 2. dependency — the graph's own resolved edges ───────────────────────────

function dependencyView(
  graph: RepoGraph,
  maxNodes: number,
  maxEdges: number
): ArchitectureView {
  const edges: DiagramEdge[] = []
  const touched = new Set<string>()
  let specifiers = 0

  for (const file of graph.files) {
    specifiers += file.specifiers.length
    for (const target of file.imports) {
      edges.push({ from: file.path, to: target })
      touched.add(file.path)
      touched.add(target)
    }
  }

  const evidence: ViewEvidence = {
    source: 'graph.files[].imports (resolved import edges)',
    found: edges.length,
    inspected: graph.fileCount,
    caveat: null,
  }

  if (edges.length === 0) {
    return unavailable(
      'dependency',
      'Dependency graph',
      `no resolved import edges: ${graph.fileCount} indexed file(s) carried ${specifiers} ` +
        `import specifier(s), none of which resolved to another file inside the project. ` +
        `Drawing a dependency diagram here would mean inventing edges`,
      evidence
    )
  }

  const rendered = renderFlowchart(
    'LR',
    [...touched].map(key => ({ key, label: key })),
    edges,
    ['dependency: file -> imported file, from the graph\'s resolved edges'],
    maxNodes,
    maxEdges
  )
  return availableView('dependency', 'Dependency graph', rendered, evidence)
}

// ── 3. system — the same edges, aggregated by module ────────────────────────

function systemView(graph: RepoGraph, maxNodes: number, maxEdges: number): ArchitectureView {
  const modules = new Map<string, number>()
  const crossEdges = new Map<string, number>()

  for (const file of graph.files) {
    const from = moduleOf(file.path)
    modules.set(from, (modules.get(from) ?? 0) + 1)
    for (const target of file.imports) {
      const to = moduleOf(target)
      if (to === from) continue
      const key = `${from}\u0000${to}`
      crossEdges.set(key, (crossEdges.get(key) ?? 0) + 1)
    }
  }

  const evidence: ViewEvidence = {
    source: 'graph.files[].imports aggregated by module (first path segment, or first two under a container directory)',
    found: crossEdges.size,
    inspected: graph.fileCount,
    caveat:
      'the module boundary is a path convention, not a declared one: a repository that ' +
      'groups differently will group differently here',
  }

  if (modules.size < 2 || crossEdges.size === 0) {
    return unavailable(
      'system',
      'System view',
      `no cross-module structure to show: ${modules.size} module(s) and ` +
        `${crossEdges.size} module-to-module edge(s) were derived from the graph. ` +
        `A single box, or boxes with no edges between them, would state nothing the ` +
        `folder tree does not already state`,
      evidence
    )
  }

  const nodes = [...modules.keys()].map(key => ({
    key,
    label: `${key}\n${modules.get(key)!} file(s)`,
  }))

  const edges: DiagramEdge[] = [...crossEdges.keys()].map(key => {
    const [from, to] = key.split('\u0000') as [string, string]
    const count = crossEdges.get(key)!
    return { from, to, label: `${count} import(s)` }
  })

  const rendered = renderFlowchart(
    'LR',
    nodes,
    edges,
    ['system: modules and the import edges between them'],
    maxNodes,
    maxEdges
  )
  return availableView('system', 'System view', rendered, evidence)
}

// ── 4. component — modules and the declarations they expose ─────────────────

/** Declaration names per file, computed once and shared by two views. */
type DeclarationIndex = Map<string, Declaration[]>

function buildDeclarationIndex(sources: SourceSet): DeclarationIndex {
  const index: DeclarationIndex = new Map()
  for (const source of sources.files) {
    const declarations = publicDeclarations(source)
    if (declarations.length > 0) index.set(source.path, declarations)
  }
  return index
}

const COMPONENT_NAMES_SHOWN = 4

function componentView(
  graph: RepoGraph,
  sources: SourceSet,
  declarations: DeclarationIndex,
  maxNodes: number,
  maxEdges: number
): ArchitectureView {
  let total = 0
  for (const list of declarations.values()) total += list.length

  const supported = sources.files.filter(f => f.language !== 'unsupported').length
  const evidence: ViewEvidence = {
    source: 'signatures.extractSignatures — public declarations per file',
    found: total,
    inspected: sources.files.length,
    caveat:
      'the signature scanner is a line-oriented heuristic with no type resolution, ' +
      'so a declaration it cannot bound is absent rather than approximated',
  }

  if (declarations.size === 0) {
    return unavailable(
      'component',
      'Component view',
      `no public declarations found: ${sources.files.length} file(s) were read, ` +
        `${supported} in a language the signature extractor supports ` +
        `(javascript-family, python), and none yielded an exported declaration. ` +
        `There is no component surface to draw`,
      evidence
    )
  }

  const paths = [...declarations.keys()]
  const nodes: DiagramNode[] = paths.map(path => {
    const list = declarations.get(path)!
    const shown = list.slice(0, COMPONENT_NAMES_SHOWN).map(d => `${d.kind} ${d.name}`)
    const rest = list.length - shown.length
    const tail = rest > 0 ? `\n+${rest} more` : ''
    return { key: path, label: `${path}\n${shown.join('\n')}${tail}` }
  })

  const component = new Set(paths)
  const edges: DiagramEdge[] = []
  for (const file of graph.files) {
    if (!component.has(file.path)) continue
    for (const target of file.imports) {
      if (component.has(target)) edges.push({ from: file.path, to: target })
    }
  }

  const rendered = renderFlowchart(
    'LR',
    nodes,
    edges,
    ['component: files with a public surface, and the imports between them'],
    maxNodes,
    maxEdges
  )
  return availableView('component', 'Component view', rendered, evidence)
}

// ── 5. call graph — textual call sites, at file-to-declaration granularity ──

/**
 * Declarations searched per imported file. A cap, because the search is
 * (callers × imports × names) and a generated module can export thousands.
 */
const MAX_CALLEE_NAMES = 40

/** Kinds that can appear at a call site: `f(…)`, `new C(…)`, `o.m(…)`. */
const CALLABLE_KINDS = new Set(['function', 'method', 'class'])

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Count occurrences of `name(` in text, ignoring the contents of comments and
 * string literals. `stripNoise` blanks those out while preserving length, which
 * is exactly what keeps a name inside a doc comment from counting as a call.
 */
function countCallSites(strippedText: string, name: string): number {
  const pattern = new RegExp(`\\b${escapeForRegex(name)}\\s*\\(`, 'g')
  let count = 0
  while (pattern.exec(strippedText) !== null) count++
  return count
}

function callGraphView(
  graph: RepoGraph,
  sources: SourceSet,
  declarations: DeclarationIndex,
  maxNodes: number,
  maxEdges: number
): ArchitectureView {
  const importsOf = new Map<string, readonly string[]>()
  for (const file of graph.files) importsOf.set(file.path, file.imports)

  const nodes = new Map<string, string>()
  const edges: DiagramEdge[] = []
  let namesSearched = 0
  let callSites = 0
  let edgesInspected = 0

  for (const source of sources.files) {
    const targets = importsOf.get(source.path) ?? []
    if (targets.length === 0) continue
    const stripped = stripText(source.text)

    for (const target of targets) {
      const list = declarations.get(target)
      if (list === undefined) continue
      edgesInspected++
      const callable = list
        .filter(d => CALLABLE_KINDS.has(d.kind))
        .slice(0, MAX_CALLEE_NAMES)

      for (const declaration of callable) {
        namesSearched++
        const count = countCallSites(stripped, declaration.name)
        if (count === 0) continue
        callSites += count
        const callerKey = `caller\u0000${source.path}`
        const calleeKey = `callee\u0000${target}\u0000${declaration.name}`
        nodes.set(callerKey, source.path)
        nodes.set(calleeKey, `${declaration.name}()\n${target}`)
        edges.push({
          from: callerKey,
          to: calleeKey,
          label: `${count} call site(s)`,
        })
      }
    }
  }

  const evidence: ViewEvidence = {
    source: 'source scan: `name(` occurrences matched against declarations exported by imported files',
    found: callSites,
    inspected: sources.files.length,
    caveat:
      'textual, not resolved: an edge means the caller file mentions the name in call ' +
      'position outside comments and strings. The caller is the FILE, not the enclosing ' +
      'function, because the signature scanner reports where a declaration starts and ' +
      'not where it ends — attributing to an enclosing function would be a guess. ' +
      'Aliased imports, dynamic dispatch and same-named locals are not distinguished',
  }

  if (edges.length === 0) {
    return unavailable(
      'call-graph',
      'Call graph',
      `no call sites matched: ${edgesInspected} import edge(s) into files with a public ` +
        `surface were inspected and ${namesSearched} imported declaration name(s) were ` +
        `searched, with 0 textual call occurrences. Without a call site there is no call ` +
        `to draw, and import edges alone are the dependency view, not this one`,
      evidence
    )
  }

  const rendered = renderFlowchart(
    'LR',
    [...nodes.keys()].map(key => ({ key, label: nodes.get(key)! })),
    edges,
    ['call graph: calling file -> called declaration (textual match)'],
    maxNodes,
    maxEdges
  )
  return availableView('call-graph', 'Call graph', rendered, evidence)
}

/** `stripNoise` over a whole text, preserving line structure. */
function stripText(text: string): string {
  return text
    .split('\n')
    .map(line => stripNoise(line))
    .join('\n')
}

// ── 6. API — route registrations, or nothing ────────────────────────────────

/**
 * `<receiver>.<verb>('/path'` — the shape every mainstream JavaScript HTTP
 * framework registers a route with. Group 1 is the CODE PREFIX up to the open
 * paren; see `isCodePosition`. The path literal must start with `/`, which is
 * what keeps `cache.get('key')` from being read as a route.
 */
const RE_JS_ROUTE =
  /\b([A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*)(['"`])(\/[^'"`\n]*)\3/g

/** `@app.route("/path")`, `@router.get("/path")` — the Python decorator forms. */
const RE_PY_ROUTE =
  /^(\s*@\s*([A-Za-z_][\w.]*)\s*\.\s*(route|get|post|put|patch|delete|head|options)\s*\(\s*)(['"])(\/[^'"\n]*)\4/

/**
 * True when the span `[start, end)` of `raw` is CODE rather than the inside of a
 * string literal or a comment.
 *
 * This check is what separates a route registration from a sentence about one.
 * `stripNoise` blanks string, template and comment CONTENT while preserving
 * length, so a span that survives it unchanged was code. Without this rule the
 * generator reads its own documentation — and the string literals in its own
 * tests — as an API surface, which is exactly the fabricated diagram this file
 * refuses to emit. The route PATH is deliberately not subject to the rule: a path
 * is a literal, so of course it is blanked.
 */
function isCodePosition(raw: string, stripped: string, start: number, end: number): boolean {
  return raw.slice(start, end) === stripped.slice(start, end)
}

/**
 * Lines that are prose. Route and schema scanning reads RAW lines — the evidence
 * lives inside string literals, so `stripNoise` cannot be used — and this is the
 * cheap defence against a commented-out route being reported as live.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('--')
  )
}

interface Route {
  method: string
  path: string
  receiver: string
  file: string
}

function findRoutes(sources: SourceSet): Route[] {
  const routes: Route[] = []
  for (const source of sources.files) {
    if (source.language === 'unsupported') continue
    for (const line of source.text.split('\n')) {
      if (isCommentLine(line)) continue
      const stripped = stripNoise(line)

      if (source.language === 'python') {
        const decorator = RE_PY_ROUTE.exec(line)
        if (decorator === null) continue
        if (!isCodePosition(line, stripped, 0, decorator[1]!.length)) continue
        routes.push({
          method: decorator[3]! === 'route' ? 'ANY' : decorator[3]!.toUpperCase(),
          path: decorator[5]!,
          receiver: decorator[2]!,
          file: source.path,
        })
        continue
      }

      RE_JS_ROUTE.lastIndex = 0
      for (const match of line.matchAll(RE_JS_ROUTE)) {
        const start = match.index ?? 0
        if (!isCodePosition(line, stripped, start, start + match[1]!.length)) continue
        routes.push({
          method: match[2]!.toUpperCase(),
          path: match[4]!,
          receiver: /^[A-Za-z_$][\w$]*/.exec(match[1]!)![0],
          file: source.path,
        })
      }
    }
  }
  return routes.sort(
    (a, b) =>
      compareText(a.path, b.path) ||
      compareText(a.method, b.method) ||
      compareText(a.file, b.file)
  )
}

function apiView(sources: SourceSet, maxNodes: number, maxEdges: number): ArchitectureView {
  const routes = findRoutes(sources)
  const evidence: ViewEvidence = {
    source:
      'source scan: verb calls in code position with a literal path starting with a slash, and Python route decorators',
    found: routes.length,
    inspected: sources.files.length,
    caveat:
      'pattern-matched, so a framework that registers routes some other way (a config ' +
      'table, a generated router, an annotation this scanner has no pattern for) is invisible ' +
      'here rather than approximated. The registration must appear in code position: prose ' +
      'about a route, and a route inside a string literal or a test fixture, does not count',
  }

  if (routes.length === 0) {
    return unavailable(
      'api',
      'API view',
      `no API surface found: ${sources.files.length} source file(s) were searched for verb ` +
        `calls in code position carrying a literal path that begins with a slash, and for ` +
        `Python route decorators, and none matched. An API view inferred from import edges ` +
        `alone would be a guess dressed as a diagram, so no diagram is emitted`,
      evidence
    )
  }

  const nodes = new Map<string, string>()
  const edges: DiagramEdge[] = []
  for (const route of routes) {
    const fileKey = `file\u0000${route.file}`
    const routeKey = `route\u0000${route.path}\u0000${route.method}\u0000${route.file}`
    nodes.set(fileKey, route.file)
    nodes.set(routeKey, `${route.method} ${route.path}`)
    edges.push({ from: fileKey, to: routeKey, label: route.receiver })
  }

  const rendered = renderFlowchart(
    'LR',
    [...nodes.keys()].map(key => ({ key, label: nodes.get(key)! })),
    edges,
    ['API: file -> route it registers, labelled with the receiver'],
    maxNodes,
    maxEdges
  )
  return availableView('api', 'API view', rendered, evidence)
}

// ── 7. database — a schema, or nothing ──────────────────────────────────────
//
// This is the view most likely to be fabricated by a generator that wants seven
// boxes. There is no schema parser in this package and no ORM introspection, so
// the only acceptable input is a schema written down in the repository AS a
// schema: a `.sql` file, or a `.prisma` model block. No schema means no database
// view — NOT a diagram of files whose names contain the word "db".
//
// DDL embedded in a source string is deliberately NOT evidence. A line-oriented
// scanner cannot tell `db.exec("CREATE TABLE …")` from a comment or a sentence
// mentioning CREATE TABLE — the first draft of this file read its own prose and
// invented a table called `statement` from it. Restricting the evidence to
// schema files is the honest version of that tradeoff: real embedded DDL is
// reported as absent rather than approximated, and the caveat says so.

const RE_CREATE_TABLE =
  /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?([A-Za-z_][\w$.]*)[`"\]]?/i
const RE_REFERENCES = /\breferences\s+[`"[]?([A-Za-z_][\w$.]*)[`"\]]?/i
const RE_PRISMA_MODEL = /^\s*model\s+([A-Za-z_]\w*)\s*\{/
const RE_PRISMA_FIELD = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)/

interface SchemaTable {
  /** Lower-cased identity, so `Users` and `users` are one table. */
  key: string
  /** As written at the first occurrence, in sorted file order. */
  name: string
  source: string
  origin: 'sql' | 'prisma'
}

interface Schema {
  tables: Map<string, SchemaTable>
  /** `fromKey\u0000toKey` → label. */
  relations: Map<string, string>
  sqlFiles: number
  prismaFiles: number
}

function readSchema(sources: SourceSet): Schema {
  const tables = new Map<string, SchemaTable>()
  const relations = new Map<string, string>()
  let sqlFiles = 0
  let prismaFiles = 0

  for (const source of sources.files) {
    if (source.extension === '.sql') sqlFiles++
    else if (source.extension === '.prisma') prismaFiles++
    // Schema files only. See the note above this section.
    else continue

    if (source.extension === '.prisma') {
      // Two passes: models first, then fields, because a relation can point at a
      // model declared further down the file.
      const lines = source.text.split('\n')
      const declared: { name: string; start: number }[] = []
      for (let i = 0; i < lines.length; i++) {
        const model = RE_PRISMA_MODEL.exec(lines[i]!)
        if (model === null) continue
        declared.push({ name: model[1]!, start: i })
        const key = model[1]!.toLowerCase()
        if (!tables.has(key)) {
          tables.set(key, { key, name: model[1]!, source: source.path, origin: 'prisma' })
        }
      }
      for (const model of declared) {
        for (let i = model.start + 1; i < lines.length; i++) {
          if (RE_PRISMA_MODEL.test(lines[i]!)) break
          if (lines[i]!.trim() === '}') break
          if (isCommentLine(lines[i]!)) continue
          const field = RE_PRISMA_FIELD.exec(lines[i]!)
          if (field === null) continue
          const targetKey = field[2]!.replace(/[[\]?]/g, '').toLowerCase()
          if (targetKey === model.name.toLowerCase()) continue
          if (!tables.has(targetKey)) continue
          relations.set(`${model.name.toLowerCase()}\u0000${targetKey}`, 'relation')
        }
      }
      continue
    }

    // SQL DDL in a `.sql` file. `current` tracks the table a `REFERENCES` clause
    // belongs to, which is why the lines are read in order.
    let current: string | null = null
    for (const line of source.text.split('\n')) {
      if (isCommentLine(line)) continue
      const created = RE_CREATE_TABLE.exec(line)
      if (created !== null) {
        const key = created[1]!.toLowerCase()
        current = key
        if (!tables.has(key)) {
          tables.set(key, { key, name: created[1]!, source: source.path, origin: 'sql' })
        }
      }
      const reference = RE_REFERENCES.exec(line)
      if (reference !== null && current !== null) {
        const targetKey = reference[1]!.toLowerCase()
        if (targetKey !== current) {
          relations.set(`${current}\u0000${targetKey}`, 'references')
        }
      }
    }
  }

  return { tables, relations, sqlFiles, prismaFiles }
}

function databaseView(
  sources: SourceSet,
  maxNodes: number,
  maxEdges: number
): ArchitectureView {
  const schema = readSchema(sources)
  const evidence: ViewEvidence = {
    source: 'schema files only: table declarations in .sql files and Prisma model blocks',
    found: schema.tables.size,
    inspected: schema.sqlFiles + schema.prismaFiles,
    caveat:
      'only a schema written down as a schema is evidence. DDL embedded in a source string, ' +
      'tables created by a migration tool at runtime, and ORM dialects this scanner has no ' +
      'pattern for are all absent rather than inferred',
  }

  if (schema.tables.size === 0) {
    return unavailable(
      'database',
      'Database view',
      `no schema found: ${schema.sqlFiles} .sql and ${schema.prismaFiles} .prisma file(s) are ` +
        `indexed, and no table declaration or Prisma model block was found in them. Source ` +
        `files are not searched, because prose about a schema is indistinguishable from a ` +
        `schema inside a string literal. A database view without a schema source would be ` +
        `invented outright, so no diagram is emitted`,
      evidence
    )
  }

  const nodes: DiagramNode[] = [...schema.tables.keys()].map(key => {
    const table = schema.tables.get(key)!
    return { key, label: `${table.name}\n${table.origin}: ${table.source}` }
  })

  const edges: DiagramEdge[] = [...schema.relations.keys()].map(key => {
    const [from, to] = key.split('\u0000') as [string, string]
    return { from, to, label: schema.relations.get(key)! }
  })

  const rendered = renderFlowchart(
    'LR',
    nodes,
    edges,
    ['database: declared tables and models, with the relations declared between them'],
    maxNodes,
    maxEdges
  )
  return availableView('database', 'Database view', rendered, evidence)
}

// ── the generator ───────────────────────────────────────────────────────────

/**
 * Derive all seven views. Pure over (graph, file bytes): no network, no clock,
 * no randomness, and no `Map` iteration order in the output.
 *
 * A missing graph is not an error — every view comes back unavailable with the
 * reason naming the path that was looked for.
 */
export async function generateArchitecture(
  options: GenerateArchitectureOptions = {}
): Promise<ArchitectureDiagrams> {
  const baseDir = options.baseDir ?? options.root
  const graph =
    options.graph !== undefined
      ? options.graph
      : baseDir === undefined
        ? null
        : await loadRepoGraph(baseDir)

  const maxNodes = Math.max(1, options.maxNodes ?? DEFAULT_MAX_NODES)
  const maxEdges = Math.max(1, options.maxEdges ?? DEFAULT_MAX_EDGES)

  let views: ArchitectureView[]
  let sources: SourceSet = { files: [], candidates: 0, skipped: 0 }
  let graphFiles = 0

  if (graph === null) {
    const where = baseDir === undefined ? '(no baseDir supplied)' : graphPath(baseDir)
    const reason =
      `no repository graph: nothing readable at ${where}. Every view here is derived ` +
      `from the graph, so with no graph there is nothing to derive and nothing is drawn`
    const evidence: ViewEvidence = {
      source: 'graph.json',
      found: 0,
      inspected: 0,
      caveat: null,
    }
    views = ARCHITECTURE_VIEWS.map(kind => unavailable(kind, titleOf(kind), reason, evidence))
  } else {
    graphFiles = graph.fileCount
    sources = await readSources(graph, options)
    const declarations = buildDeclarationIndex(sources)

    // Built in ARCHITECTURE_VIEWS order so the array itself is deterministic.
    const byKind: Record<ArchitectureViewKind, ArchitectureView> = {
      system: systemView(graph, maxNodes, maxEdges),
      api: apiView(sources, maxNodes, maxEdges),
      database: databaseView(sources, maxNodes, maxEdges),
      component: componentView(graph, sources, declarations, maxNodes, maxEdges),
      dependency: dependencyView(graph, maxNodes, maxEdges),
      'folder-tree': folderTreeView(graph, maxNodes, maxEdges),
      'call-graph': callGraphView(graph, sources, declarations, maxNodes, maxEdges),
    }
    views = ARCHITECTURE_VIEWS.map(kind => byKind[kind])
  }

  const available = views
    .filter(v => v.available)
    .map(v => v.kind)
    .sort(compareText)
  const unavailableKinds = views
    .filter(v => !v.available)
    .map(v => v.kind)
    .sort(compareText)

  const result: ArchitectureDiagrams = {
    version: ARCHITECTURE_VERSION,
    format: DIAGRAM_FORMAT,
    graphFiles,
    sourcesRead: sources.files.length,
    views,
    available,
    unavailable: unavailableKinds,
    digest: '',
  }
  result.digest = contentHash(renderArchitectureDocument(result))

  await options.events?.emit({
    runId: options.runId ?? 'architecture',
    kind: 'diagram_updated',
    payload: {
      component: 'architecture',
      format: DIAGRAM_FORMAT,
      version: ARCHITECTURE_VERSION,
      digest: result.digest,
      graphFiles,
      sourcesRead: sources.files.length,
      sourceCandidates: sources.candidates,
      sourcesSkipped: sources.skipped,
      available,
      unavailable: unavailableKinds,
      views: views.map(view => ({
        kind: view.kind,
        available: view.available,
        reason: view.reason,
        nodes: view.nodes,
        edges: view.edges,
        truncated: view.truncated,
        evidence: view.evidence,
      })),
    },
  })

  return result
}

/** Human-readable title per view. */
export function titleOf(kind: ArchitectureViewKind): string {
  switch (kind) {
    case 'system':
      return 'System view'
    case 'api':
      return 'API view'
    case 'database':
      return 'Database view'
    case 'component':
      return 'Component view'
    case 'dependency':
      return 'Dependency graph'
    case 'folder-tree':
      return 'Folder tree'
    case 'call-graph':
      return 'Call graph'
  }
}

/**
 * The whole result as one Markdown document: a fenced Mermaid block per
 * available view, and for an unavailable one the stated reason INSTEAD of a
 * diagram. This is the diffable artifact — `digest` is its hash — and it is what
 * a docs section (task 13.3) or the Live Architecture panel renders.
 */
export function renderArchitectureDocument(result: ArchitectureDiagrams): string {
  const lines: string[] = [
    '# Architecture',
    '',
    `Generated from the repository graph: ${result.graphFiles} indexed file(s), ` +
      `${result.sourcesRead} read for source evidence. Format: ${result.format}. ` +
      'Derived locally with no network access.',
    '',
  ]

  for (const view of result.views) {
    lines.push(`## ${view.title}`, '')
    lines.push(
      `Evidence: ${view.evidence.source} — ${view.evidence.found} item(s) from ` +
        `${view.evidence.inspected} file(s) inspected.`,
      ''
    )
    if (view.evidence.caveat !== null) {
      lines.push(`Caveat: ${view.evidence.caveat}.`, '')
    }
    if (!view.available) {
      // No diagram, and no diagram-shaped placeholder either.
      lines.push(`**Unavailable.** ${view.reason}.`, '')
      continue
    }
    lines.push(`${view.nodes} node(s), ${view.edges} edge(s).`, '')
    lines.push('```mermaid', view.mermaid.replace(/\n$/, ''), '```', '')
  }

  return `${lines.join('\n')}`
}
