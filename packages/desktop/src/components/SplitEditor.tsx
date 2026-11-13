// Split editor: two CodeEditor panes side by side, with a Split / Single
// toggle. Props-driven; it imports no AppState.
//
// ── KNOWN LIMIT, READ BEFORE WIRING ──────────────────────────────────────────
// `CodeEditor` (editor/CodeEditor.tsx) takes no path/content/onChange props:
// it projects `AppState.activeFile` onto Monaco and reports edits through
// `UPDATE_FILE_CONTENT`. So the two panes below both show the active file
// until CodeEditor gains per-pane props (see CHAT_HANDOFF.md). The pane
// headers still name the intended file for each side, and `onClose` / the
// toggle already work per pane — but per-pane content is NOT implemented
// here, and this file does not claim it is. `onChange` is part of the
// props contract for that future wiring; it is intentionally not called
// yet because there is no per-pane edit event to call it from.

import { useState } from 'react'

import { CodeEditor } from '../editor/CodeEditor'

export interface SplitPane {
  path: string
  content: string
}

export interface SplitEditorProps {
  left: SplitPane | null
  right: SplitPane | null
  /** Called when a pane's content changes — wired once CodeEditor takes per-pane props. */
  onChange: (path: string, content: string) => void
  onClose: (path: string) => void
}

export function SplitEditor({ left, right, onChange, onClose }: SplitEditorProps) {
  void onChange // See the header note: no per-pane edit event exists yet.
  const [mode, setMode] = useState<'split' | 'single'>('split')
  const both = left !== null && right !== null
  const effectiveMode = both ? mode : 'single'
  const visible: Array<{ pane: SplitPane; side: 'left' | 'right' }> = []
  if (effectiveMode === 'split') {
    if (left !== null) visible.push({ pane: left, side: 'left' })
    if (right !== null) visible.push({ pane: right, side: 'right' })
  } else if (left !== null) {
    visible.push({ pane: left, side: 'left' })
  } else if (right !== null) {
    visible.push({ pane: right, side: 'right' })
  }

  return (
    <div data-testid="split-editor" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div role="toolbar" aria-label="Split editor">
        <button
          type="button"
          onClick={() => setMode(mode === 'split' ? 'single' : 'split')}
          disabled={!both}
          title={both ? 'Toggle split / single pane' : 'Split needs two files open'}
        >
          {effectiveMode === 'split' ? 'Single' : 'Split vertical'}
        </button>
      </div>
      {visible.length === 0 ? (
        <p>No file open.</p>
      ) : (
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {visible.map(({ pane, side }) => (
            <div
              key={pane.path}
              data-testid={`split-pane-${side}`}
              data-path={pane.path}
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{pane.path}</span>
                <button type="button" aria-label={`Close ${pane.path}`} onClick={() => onClose(pane.path)}>
                  Close
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <CodeEditor />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default SplitEditor
