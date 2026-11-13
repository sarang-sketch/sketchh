// Debugger panel — honest basics only.
//
// What it does: records breakpoints (file + line + optional condition) and
// offers "Launch with inspector", which hands a `{ runtime: 'node',
// inspectPort }` config to the provided `onLaunch` callback and shows the
// inspector URL to open in a browser.
//
// What it does NOT do: step, pause, inspect variables, or show a call
// stack. Sketchh has no debug adapter, so the panel says that in its own
// copy ("Breakpoints are recorded; stepping is not implemented yet") rather
// than drawing a fake debugger. Props-driven, no client calls, so it renders
// anywhere — including in tests — without a backend.

import { useState } from 'react'

import {
  addBreakpoint,
  removeBreakpoint,
  type Breakpoint,
} from './debuggerStore'

export const DEFAULT_INSPECT_PORT = 9229

export interface DebuggerLaunchConfig {
  runtime: 'node'
  inspectPort: number
}

export interface DebuggerPanelProps {
  /** Breakpoints the panel starts with (it owns the list after that). */
  initialBreakpoints?: Breakpoint[]
  /** Called when the breakpoint list changes. */
  onBreakpointsChange?: (breakpoints: Breakpoint[]) => void
  /** Called with the launch config when "Launch with inspector" is pressed. */
  onLaunch?: (config: DebuggerLaunchConfig) => void
  /** Node inspector port. Defaults to 9229. */
  inspectPort?: number
}

export function inspectorUrl(port: number): string {
  return `http://127.0.0.1:${port}/json`
}

export function DebuggerPanel({ initialBreakpoints = [], onBreakpointsChange, onLaunch, inspectPort = DEFAULT_INSPECT_PORT }: DebuggerPanelProps) {
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>(initialBreakpoints)
  const [file, setFile] = useState('')
  const [line, setLine] = useState('')
  const [condition, setCondition] = useState('')
  const [launched, setLaunched] = useState(false)

  const update = (next: Breakpoint[]) => {
    setBreakpoints(next)
    onBreakpointsChange?.(next)
  }

  const add = () => {
    const parsed = Number(line)
    const next = addBreakpoint(breakpoints, { file, line: parsed, condition })
    if (next.length === breakpoints.length && !breakpoints.some((b) => b.file === file.trim() && b.line === parsed)) return
    update(next)
    setLine('')
    setCondition('')
  }

  const launch = () => {
    const config: DebuggerLaunchConfig = { runtime: 'node', inspectPort }
    onLaunch?.(config)
    setLaunched(true)
  }

  return (
    <div data-testid="debugger-panel">
      <h2>Debugger</h2>
      <p>
        Breakpoints are recorded; stepping is not implemented yet. This panel does not connect to a debugger —
        it keeps a list of breakpoints and can launch Node with the inspector enabled.
      </p>

      <section aria-label="Add breakpoint">
        <label>
          File
          <input aria-label="Breakpoint file" value={file} onChange={(event) => setFile(event.target.value)} placeholder="src/index.ts" />
        </label>
        <label>
          Line
          <input aria-label="Breakpoint line" value={line} onChange={(event) => setLine(event.target.value)} inputMode="numeric" placeholder="42" />
        </label>
        <label>
          Condition (optional)
          <input aria-label="Breakpoint condition" value={condition} onChange={(event) => setCondition(event.target.value)} placeholder="x > 0" />
        </label>
        <button type="button" onClick={add}>Add breakpoint</button>
      </section>

      <section aria-label="Breakpoints">
        <h3>Breakpoints ({breakpoints.length})</h3>
        {breakpoints.length === 0 ? (
          <p>No breakpoints recorded yet.</p>
        ) : (
          <ul>
            {breakpoints.map((b) => (
              <li key={b.id}>
                <span>{b.file}:{b.line}</span>
                {b.condition !== undefined && <span> — when {b.condition}</span>}
                <button type="button" aria-label={`Remove breakpoint ${b.file}:${b.line}`} onClick={() => update(removeBreakpoint(breakpoints, b.id))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Launch">
        <button type="button" onClick={launch}>Launch with inspector</button>
        {launched && (
          <p>
            Inspector URL — open this in a browser after the launch:
            <code>{inspectorUrl(inspectPort)}</code>
          </p>
        )}
        {!launched && <p>Inspector URL (after launch): <code>{inspectorUrl(inspectPort)}</code></p>}
        <p>Launches Node with <code>--inspect={inspectPort}</code>. Stepping, pausing and variable inspection are not available in this panel.</p>
      </section>
    </div>
  )
}

export default DebuggerPanel
