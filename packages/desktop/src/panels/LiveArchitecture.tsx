// Live Architecture — the seven generated views, as the generator reported them
// (Requirements 19.3, 27.1).
//
// WHAT IT SHOWS: exactly what `architecture` answered. The seven views arrive from
// packages/core/src/context/architecture.ts over the client seam, each carrying its
// Mermaid source, its availability, its reason, its evidence and its truncation
// flag. Nothing on this screen is computed from anything else, and no view is
// invented, reordered or re-derived here.
//
// THE RULE THIS PANEL EXISTS TO KEEP: a view with `available: false` shows its
// REASON, not an empty diagram box and not a spinner. The generator refuses to draw
// a diagram it has no evidence for — an API view guessed from import edges, a
// database view with no schema in the repository — and a UI that answered that
// refusal with a blank frame would put the lie back. So the unavailable branch
// below renders the sentence the engine wrote and no drawing surface at all.
//
// HEURISTIC VIEWS LOOK HEURISTIC: every view's evidence (source, items found, files
// inspected) is on screen, and a view whose derivation is pattern-matched carries
// the generator's own caveat next to it. A truncated view says so.
//
// HOW THE DIAGRAM IS DRAWN, AND WHY NOT WITH MERMAID: see the note at the top of
// ../architecture/flowchart.ts. Short version — mermaid's API returns an SVG string
// that only `innerHTML` can mount, diagram labels are repository content and
// therefore attacker-influenced, and this window's CSP still allows inline script.
// The source is parsed and laid out locally instead, and every label is a TEXT NODE
// inside an SVG element. No HTML is built from diagram content anywhere in this file.
// The raw Mermaid text is one click away for anyone who wants to paste it elsewhere.
//
// FOUR HONEST NOTHINGS: no folder open; a transport with no engine behind it; no
// graph indexed yet, with the offer to index; and a failed generation, naming the
// reason (Requirements 27.3, 27.5).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Layers, Refresh } from '../components/Icons';
import { useSketchClient } from '../lib/ClientProvider';
import { useAppState } from '../state/AppState';
import type { ArchitectureResult } from '../lib/client';
import type { ArchitectureView, ArchitectureViewKind } from '../lib/contracts';
import {
  LABEL_LINE_HEIGHT,
  LABEL_PAD_X,
  LABEL_PAD_Y,
  layoutFlowchart,
  parseFlowchart,
} from '../architecture/flowchart';
import styles from './LiveArchitecture.module.css';

/** What the panel is waiting on. Never null at the same time as an in-flight call. */
type Busy = 'reading' | 'indexing' | null;

export function LiveArchitecture() {
  const { projectRoot } = useAppState();
  const client = useSketchClient();

  const [result, setResult] = useState<ArchitectureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [selected, setSelected] = useState<ArchitectureViewKind | null>(null);
  const [showSource, setShowSource] = useState(false);

  /**
   * Generation id. A result for a superseded call — a different project, an older
   * refresh — is discarded rather than allowed to overwrite a newer one.
   */
  const generation = useRef(0);

  /** Whether the live transport can answer at all. */
  const canDerive = client.architecture !== undefined;

  const generate = useCallback(
    async (root: string, index: boolean) => {
      const call = client.architecture;
      if (call === undefined) return;
      generation.current += 1;
      const ticket = generation.current;
      setBusy(index ? 'indexing' : 'reading');
      setError(null);
      try {
        const answer = await call.call(client, { root, ...(index ? { index: true } : {}) });
        if (generation.current !== ticket) return;
        setResult(answer);
      } catch (err) {
        if (generation.current !== ticket) return;
        // The result is dropped: a diagram set from a previous attempt sitting under
        // a failure message would be undated and unexplained.
        setResult(null);
        setError(
          `The architecture views could not be generated: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        if (generation.current === ticket) setBusy(null);
      }
    },
    [client],
  );

  // Reading the persisted graph and the files it lists is local work — no network,
  // by construction (Requirement 19.5) — so it may happen on mount. INDEXING never
  // does: it walks the whole project, and that is the user's decision.
  useEffect(() => {
    if (projectRoot === null) {
      setResult(null);
      setError(null);
      return;
    }
    void generate(projectRoot, false);
  }, [generate, projectRoot]);

  const views = result?.diagrams.views ?? [];

  /**
   * The view on screen. Defaults to the first one with real evidence, so opening the
   * panel lands on something drawn rather than on a reason.
   */
  const view = useMemo((): ArchitectureView | null => {
    if (views.length === 0) return null;
    const chosen = views.find((candidate) => candidate.kind === selected);
    return chosen ?? views.find((candidate) => candidate.available) ?? views[0]!;
  }, [selected, views]);

  if (projectRoot === null) {
    return (
      <div className={styles.panel}>
        <Toolbar busy={busy} onRefresh={null} />
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No folder opened</div>
          <div className={styles.emptyDetail}>
            Every view here is derived from the repository graph of an open project. Open a
            folder and the seven views are generated from it, locally.
          </div>
        </div>
      </div>
    );
  }

  if (!canDerive) {
    return (
      <div className={styles.panel}>
        <Toolbar busy={busy} onRefresh={null} />
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No engine behind this transport</div>
          <div className={styles.emptyDetail}>
            The <code>{client.transport}</code> transport does not implement{' '}
            <code>architecture</code>, so there is nothing to derive the views from. Start
            the app under Tauri, or with the dev bridge, to reach a real engine.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <Toolbar busy={busy} onRefresh={() => void generate(projectRoot, false)} />

      {error !== null && (
        <div className={styles.error} role="alert">
          <AlertCircle size={13} />
          <span>{error}</span>
        </div>
      )}

      {busy !== null && result === null && error === null && (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>
            {busy === 'indexing' ? 'Indexing the project…' : 'Deriving the views…'}
          </div>
          <div className={styles.emptyDetail}>
            Reading the persisted graph and the files it lists. Nothing leaves this machine.
          </div>
        </div>
      )}

      {result !== null && !result.graphPresent && (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No repository graph indexed yet</div>
          <div className={styles.emptyDetail}>
            {/* The engine's own sentence, not a paraphrase of it. */}
            {views[0]?.reason ?? 'The graph has not been built for this project.'}.
          </div>
          <div className={styles.path}>{result.graphPath}</div>
          <div className={styles.actions}>
            <button
              className={styles.actionBtn}
              disabled={busy !== null}
              onClick={() => void generate(projectRoot, true)}
            >
              {busy === 'indexing' ? 'Indexing…' : 'Index this project'}
            </button>
          </div>
          <div className={styles.emptyDetail}>
            Indexing walks the project once, hashes each file, and writes the graph next to
            it. It makes no network request.
          </div>
        </div>
      )}

      {result !== null && result.graphPresent && view !== null && (
        <>
          <div className={styles.summary}>
            {result.diagrams.graphFiles} indexed file(s), {result.diagrams.sourcesRead} read for
            source evidence. {result.diagrams.available.length} of {views.length} view(s) have
            evidence. Format: {result.diagrams.format}, digest{' '}
            {result.diagrams.digest.slice(0, 12)}.
            {result.indexed !== undefined &&
              ` Indexed just now: ${result.indexed.added} added, ${result.indexed.changed} changed, ${result.indexed.reused} reused, ${result.indexed.removed} removed.`}
          </div>

          <div className={styles.tabs} role="tablist" aria-label="Architecture views">
            {views.map((candidate) => (
              <button
                key={candidate.kind}
                role="tab"
                aria-selected={candidate.kind === view.kind}
                className={`${styles.tab} ${candidate.kind === view.kind ? styles.tabActive : ''}`}
                data-view={candidate.kind}
                data-available={candidate.available ? 'yes' : 'no'}
                onClick={() => {
                  setSelected(candidate.kind);
                  setShowSource(false);
                }}
              >
                <span>{candidate.title}</span>
                {/* The availability of a view is visible BEFORE it is opened, so the
                    tab strip cannot imply seven diagrams exist. */}
                <span
                  className={candidate.available ? styles.tabMarkAvailable : styles.tabMark}
                  aria-label={candidate.available ? 'has evidence' : 'unavailable'}
                >
                  {candidate.available ? `${candidate.nodes}` : 'n/a'}
                </span>
              </button>
            ))}
          </div>

          <div className={styles.view} role="tabpanel" data-view={view.kind}>
            <ViewBody
              view={view}
              showSource={showSource}
              onToggleSource={() => setShowSource((current) => !current)}
              onReindex={() => void generate(projectRoot, true)}
              busy={busy}
            />
          </div>
        </>
      )}
    </div>
  );
}

interface ToolbarProps {
  busy: Busy;
  onRefresh: (() => void) | null;
}

function Toolbar({ busy, onRefresh }: ToolbarProps) {
  return (
    <div className={styles.toolbar}>
      <Layers size={13} />
      <span className={styles.toolbarTitle}>Live Architecture</span>
      {onRefresh !== null && (
        <button
          className={styles.iconBtn}
          onClick={onRefresh}
          disabled={busy !== null}
          aria-label="Regenerate the architecture views"
          title="Regenerate from the persisted graph"
        >
          <Refresh size={14} />
        </button>
      )}
    </div>
  );
}

interface ViewBodyProps {
  view: ArchitectureView;
  showSource: boolean;
  onToggleSource: () => void;
  onReindex: () => void;
  busy: Busy;
}

function ViewBody({ view, showSource, onToggleSource, onReindex, busy }: ViewBodyProps) {
  // Parsed here rather than in the parent so switching tabs does not re-parse the
  // other six. Same source, same layout, every time.
  const chart = useMemo(
    () => (view.available ? parseFlowchart(view.mermaid) : null),
    [view.available, view.mermaid],
  );
  const layout = useMemo(() => (chart === null ? null : layoutFlowchart(chart)), [chart]);

  return (
    <>
      <div className={styles.viewHead}>
        <span className={styles.viewTitle}>{view.title}</span>
        {view.available ? (
          <span className={styles.counts}>
            {view.nodes} node(s), {view.edges} edge(s)
          </span>
        ) : (
          <span className={styles.counts}>No diagram: nothing was found to draw one from.</span>
        )}
      </div>

      {!view.available ? (
        // THE REASON, IN PLACE OF A DIAGRAM. No drawing surface is rendered here at
        // all — see the note at the top of this file.
        <div className={styles.unavailable}>
          <span className={styles.unavailableLabel}>Unavailable.</span>
          <span>{view.reason}.</span>
        </div>
      ) : (
        <>
          {view.truncated && (
            <div className={styles.truncated}>
              Truncated: this view hit the generator&apos;s per-view cap, so the diagram below
              is part of the graph, not all of it. The counts above are what is drawn.
            </div>
          )}
          {chart !== null && chart.notes.length > 0 && (
            <ul className={styles.notes}>
              {chart.notes.map((note, index) => (
                <li key={`${index}-${note}`}>{note}</li>
              ))}
            </ul>
          )}
          {layout !== null && <Diagram view={view} layout={layout} />}
          {chart !== null && chart.unparsed.length > 0 && (
            <div className={styles.truncated} role="alert">
              {chart.unparsed.length} line(s) of the generated source were not recognised by
              this renderer and are not drawn. The source itself is unchanged — open it below.
            </div>
          )}
          <div className={styles.actions}>
            <button className={styles.actionBtn} onClick={onToggleSource}>
              {showSource ? 'Hide Mermaid source' : 'Show Mermaid source'}
            </button>
            <button className={styles.actionBtn} disabled={busy !== null} onClick={onReindex}>
              {busy === 'indexing' ? 'Re-indexing…' : 'Re-index and regenerate'}
            </button>
          </div>
          {showSource && (
            // Text, in a text node. The whole reason there is no HTML in this path.
            <pre className={styles.source}>{view.mermaid}</pre>
          )}
        </>
      )}

      <div className={styles.evidence}>
        <span>
          <span className={styles.evidenceLabel}>Evidence:</span> {view.evidence.source} —{' '}
          {view.evidence.found} item(s) from {view.evidence.inspected} file(s) inspected.
        </span>
        {view.evidence.caveat !== null && (
          <span>
            <span className={styles.evidenceLabel}>Caveat:</span> {view.evidence.caveat}.
          </span>
        )}
      </div>
    </>
  );
}

interface DiagramProps {
  view: ArchitectureView;
  layout: ReturnType<typeof layoutFlowchart>;
}

/**
 * The diagram, as SVG elements. Every label is a text node; nothing here builds
 * markup from a string.
 */
function Diagram({ view, layout }: DiagramProps) {
  const arrowId = `sketch-arch-arrow-${view.kind}`;
  return (
    <div className={styles.diagram}>
      <svg
        className={styles.svg}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`${view.title}: ${view.nodes} node(s) and ${view.edges} edge(s), drawn from the generated Mermaid source`}
        data-diagram={view.kind}
      >
        <defs>
          <marker
            id={arrowId}
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 z" fill="currentColor" className={styles.edgeText} />
          </marker>
        </defs>
        {layout.edges.map((edge, index) => (
          <g key={`${edge.from}-${edge.to}-${index}`}>
            <line
              className={styles.edgeLine}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              markerEnd={`url(#${arrowId})`}
            />
            {edge.label !== null && (
              <text
                className={styles.edgeText}
                x={edge.labelX}
                y={edge.labelY - 3}
                textAnchor="middle"
              >
                {edge.label}
              </text>
            )}
          </g>
        ))}
        {layout.nodes.map((node) => (
          <g key={node.id}>
            <rect
              className={styles.nodeBox}
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={3}
            />
            <text className={styles.nodeText} x={node.x + LABEL_PAD_X} y={node.y + LABEL_PAD_Y}>
              {node.label.map((line, index) => (
                <tspan
                  key={`${index}-${line}`}
                  x={node.x + LABEL_PAD_X}
                  dy={index === 0 ? LABEL_LINE_HEIGHT - 3 : LABEL_LINE_HEIGHT}
                >
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default LiveArchitecture;
