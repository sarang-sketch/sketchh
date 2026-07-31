// Mermaid flowchart source → nodes, edges, and a position for each.
//
// ── WHY THIS EXISTS INSTEAD OF A MERMAID DEPENDENCY ─────────────────────────
//
// The generator emits Mermaid TEXT (packages/core/src/context/architecture.ts) and
// leaves rendering to whoever displays it. Three constraints decided what "display"
// means here:
//
//   1. `mermaid`'s render API hands back an SVG STRING, which can only reach the
//      document through `innerHTML`. This window's CSP still carries
//      script-src 'unsafe-inline', and diagram labels are repository content —
//      file paths, declaration names, route paths — so they are attacker-influenced.
//      Injecting HTML built from them is the one thing that must not happen.
//   2. Monaco is already a 3.3 MB lazy chunk. Mermaid is the same order of
//      magnitude, for seven small flowcharts.
//   3. The build must work offline, and a new dependency cannot be installed
//      offline.
//
// So the source is parsed and laid out here, and rendered as SVG ELEMENTS with
// labels as TEXT NODES (see LiveArchitecture.tsx). No HTML is ever constructed from
// diagram content. The parser accepts exactly the subset the generator emits and
// REPORTS anything it does not recognise in `unparsed` — a renderer that silently
// dropped lines would quietly show a smaller graph than the source describes, which
// is the same class of lie the generator refuses to tell.
//
// Layout is a plain layered assignment: depth by longest path, order within a depth
// taken from the source order (which the generator already sorted). Deterministic
// for fixed input, like everything upstream of it.
//
// Validates: Requirements 19.3, 27.1

export interface FlowchartNode {
  id: string
  /** Label lines, decoded. `<br/>` in the source is a line break, not markup. */
  label: string[]
}

export interface FlowchartEdge {
  from: string
  to: string
  /** Edge label, decoded. Null when the source had none. */
  label: string | null
}

export interface Flowchart {
  direction: 'TD' | 'LR'
  /** `%%` comment lines, in source order. The generator states truncation here. */
  notes: string[]
  nodes: FlowchartNode[]
  edges: FlowchartEdge[]
  /**
   * Lines the parser did not understand, and edges naming an undeclared node.
   * Surfaced by the panel rather than dropped.
   */
  unparsed: string[]
}

const RE_HEADER = /^flowchart\s+(TD|LR|TB|BT|RL)\s*$/
const RE_NOTE = /^%%\s?(.*)$/
const RE_NODE = /^([A-Za-z0-9_]+)\["([\s\S]*)"\]$/
const RE_EDGE = /^([A-Za-z0-9_]+)\s*-->\s*(?:\|"([\s\S]*)"\|\s*)?([A-Za-z0-9_]+)$/

/**
 * Undo the two escapes `mermaidLabel` applies. Both directions are text-only: the
 * result is used as a string, never as markup, so `<br/>` becomes a LINE BREAK and
 * nothing else in the label is interpreted.
 */
export function decodeLabel(text: string): string[] {
  return text.split(/<br\s*\/?>/).map((line) => line.replaceAll('#quot;', '"'))
}

/** Parse the flowchart subset the generator emits. Never throws. */
export function parseFlowchart(source: string): Flowchart {
  const chart: Flowchart = {
    direction: 'TD',
    notes: [],
    nodes: [],
    edges: [],
    unparsed: [],
  }
  const declared = new Set<string>()
  let sawHeader = false

  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line === '') continue

    if (!sawHeader) {
      const header = RE_HEADER.exec(line)
      if (header !== null) {
        sawHeader = true
        // Only the two the generator emits get a layout; anything else is drawn
        // top-down rather than guessed at.
        chart.direction = header[1] === 'LR' ? 'LR' : 'TD'
        continue
      }
    }

    const note = RE_NOTE.exec(line)
    if (note !== null) {
      chart.notes.push(note[1] ?? '')
      continue
    }

    const node = RE_NODE.exec(line)
    if (node !== null) {
      const id = node[1]!
      if (declared.has(id)) {
        chart.unparsed.push(line)
        continue
      }
      declared.add(id)
      chart.nodes.push({ id, label: decodeLabel(node[2] ?? '') })
      continue
    }

    const edge = RE_EDGE.exec(line)
    if (edge !== null) {
      chart.edges.push({
        from: edge[1]!,
        to: edge[3]!,
        label: edge[2] === undefined ? null : decodeLabel(edge[2]).join(' '),
      })
      continue
    }

    chart.unparsed.push(line)
  }

  // An edge to a node that was never declared cannot be drawn. Reported, not hidden.
  const drawable: FlowchartEdge[] = []
  for (const edge of chart.edges) {
    if (declared.has(edge.from) && declared.has(edge.to)) drawable.push(edge)
    else chart.unparsed.push(`${edge.from} --> ${edge.to}`)
  }
  chart.edges = drawable

  return chart
}

// ── layout ──────────────────────────────────────────────────────────────────

export interface PositionedNode extends FlowchartNode {
  x: number
  y: number
  width: number
  height: number
}

export interface PositionedEdge extends FlowchartEdge {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Midpoint, where the label sits. */
  labelX: number
  labelY: number
}

export interface FlowchartLayout {
  direction: 'TD' | 'LR'
  width: number
  height: number
  nodes: PositionedNode[]
  edges: PositionedEdge[]
}

/**
 * Geometry. Character width is an ESTIMATE for the bundled monospace face — a box
 * one character too wide is cosmetic, and measuring text would mean a hidden DOM
 * pass per label on every render.
 */
const CHAR_WIDTH = 6.4
/** Exported so the renderer places label lines where the boxes were sized for. */
export const LABEL_LINE_HEIGHT = 14
export const LABEL_PAD_X = 10
export const LABEL_PAD_Y = 8
const LINE_HEIGHT = LABEL_LINE_HEIGHT
const PAD_X = LABEL_PAD_X
const PAD_Y = LABEL_PAD_Y
const MIN_NODE_WIDTH = 56
const MAX_NODE_WIDTH = 340
const LAYER_GAP = 56
const SIBLING_GAP = 14
const MARGIN = 12

function nodeWidth(label: string[]): number {
  const longest = label.reduce((max, line) => Math.max(max, line.length), 0)
  return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, longest * CHAR_WIDTH + PAD_X * 2))
}

function nodeHeight(label: string[]): number {
  return Math.max(1, label.length) * LINE_HEIGHT + PAD_Y * 2
}

/**
 * Longest-path depth over the edge set.
 *
 * A dependency graph can contain a cycle (`a` imports `b` imports `a`), and a
 * layered layout has no answer for one. The edge that closes the cycle is left out
 * of the DEPTH calculation only — it is still drawn — which keeps every node placed
 * exactly once instead of recursing forever.
 */
function depths(nodes: readonly FlowchartNode[], edges: readonly FlowchartEdge[]): Map<string, number> {
  const predecessors = new Map<string, string[]>()
  for (const node of nodes) predecessors.set(node.id, [])
  for (const edge of edges) predecessors.get(edge.to)!.push(edge.from)

  const depth = new Map<string, number>()
  const visiting = new Set<string>()

  const resolveDepth = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    let best = 0
    for (const predecessor of predecessors.get(id) ?? []) {
      best = Math.max(best, resolveDepth(predecessor) + 1)
    }
    visiting.delete(id)
    depth.set(id, best)
    return best
  }

  for (const node of nodes) resolveDepth(node.id)
  return depth
}

/**
 * Place every node and every edge. Pure: same input, same numbers, on any host.
 *
 * `LR` puts depth on the x axis, `TD` on the y axis. Within a depth, nodes keep
 * their source order — the generator already sorted that, so the picture is as
 * stable as the text it came from.
 */
export function layoutFlowchart(chart: Flowchart): FlowchartLayout {
  const depth = depths(chart.nodes, chart.edges)
  const horizontal = chart.direction === 'LR'

  const layers: FlowchartNode[][] = []
  for (const node of chart.nodes) {
    const index = depth.get(node.id) ?? 0
    while (layers.length <= index) layers.push([])
    layers[index]!.push(node)
  }

  const placed = new Map<string, PositionedNode>()
  let cursor = MARGIN
  let across = MARGIN

  for (const layer of layers) {
    const widths = layer.map((node) => nodeWidth(node.label))
    const heights = layer.map((node) => nodeHeight(node.label))
    const layerExtent = horizontal
      ? Math.max(0, ...widths)
      : Math.max(0, ...heights)

    let offset = MARGIN
    layer.forEach((node, index) => {
      const width = widths[index]!
      const height = heights[index]!
      const positioned: PositionedNode = horizontal
        ? { ...node, x: cursor, y: offset, width, height }
        : { ...node, x: offset, y: cursor, width, height }
      placed.set(node.id, positioned)
      offset += (horizontal ? height : width) + SIBLING_GAP
    })

    across = Math.max(across, offset - SIBLING_GAP + MARGIN)
    cursor += layerExtent + LAYER_GAP
  }

  const nodes = chart.nodes.map((node) => placed.get(node.id)!)

  const edges: PositionedEdge[] = chart.edges.map((edge) => {
    const from = placed.get(edge.from)!
    const to = placed.get(edge.to)!
    // A forward edge leaves the trailing face and lands on the leading one. An edge
    // that runs backwards (a cycle) is drawn centre to centre, because there is no
    // face that makes it read as forward.
    const forward = horizontal ? to.x > from.x : to.y > from.y
    const x1 = horizontal && forward ? from.x + from.width : from.x + from.width / 2
    const y1 = !horizontal && forward ? from.y + from.height : from.y + from.height / 2
    const x2 = horizontal && forward ? to.x : to.x + to.width / 2
    const y2 = !horizontal && forward ? to.y : to.y + to.height / 2
    return {
      ...edge,
      x1,
      y1,
      x2,
      y2,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2,
    }
  })

  const extent = cursor - LAYER_GAP + MARGIN
  return {
    direction: chart.direction,
    width: horizontal ? extent : across,
    height: horizontal ? across : extent,
    nodes,
    edges,
  }
}
