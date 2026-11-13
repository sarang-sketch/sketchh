// Breakpoint store: pure helpers. A breakpoint is only a record —
// { file, line, condition? } — kept in a list the panel (or later, a real
// debug adapter) can read. Nothing here starts a debugger, steps, pauses,
// or inspects variables: Sketchh has no debug adapter yet, and this file
// must not pretend otherwise.

export interface Breakpoint {
  /** Stable id: `${file}:${line}`. One breakpoint per file+line. */
  id: string
  file: string
  /** 1-based line number. */
  line: number
  /** Optional condition; an empty condition is stored as "no condition". */
  condition?: string
}

export function breakpointId(file: string, line: number): string {
  return `${file}:${line}`
}

function sortBreakpoints(list: readonly Breakpoint[]): Breakpoint[] {
  return [...list].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/**
 * Add a breakpoint, or update the condition of the one already on that
 * line. Invalid input (empty file, line < 1, non-integer line) is ignored
 * and the list is returned unchanged.
 */
export function addBreakpoint(
  list: readonly Breakpoint[],
  breakpoint: { file: string; line: number; condition?: string },
): Breakpoint[] {
  const file = breakpoint.file.trim()
  const line = breakpoint.line
  if (file === '' || !Number.isInteger(line) || line < 1) return [...list]
  const condition = breakpoint.condition?.trim() === '' ? undefined : breakpoint.condition?.trim()
  const id = breakpointId(file, line)
  const existing = list.find((b) => b.id === id)
  if (existing !== undefined) {
    return sortBreakpoints(
      list.map((b) => (b.id === id ? { ...b, ...(condition === undefined ? {} : { condition }) } : b)),
    )
  }
  const entry: Breakpoint = { id, file, line }
  if (condition !== undefined) entry.condition = condition
  return sortBreakpoints([...list, entry])
}

export function removeBreakpoint(list: readonly Breakpoint[], id: string): Breakpoint[] {
  return list.filter((b) => b.id !== id)
}

/** Toggle: present → removed, absent → added (invalid input is a no-op). */
export function toggleBreakpoint(
  list: readonly Breakpoint[],
  breakpoint: { file: string; line: number; condition?: string },
): Breakpoint[] {
  const file = breakpoint.file.trim()
  if (file === '' || !Number.isInteger(breakpoint.line) || breakpoint.line < 1) return [...list]
  const id = breakpointId(file, breakpoint.line)
  return list.some((b) => b.id === id) ? removeBreakpoint(list, id) : addBreakpoint(list, breakpoint)
}

export function breakpointsForFile(list: readonly Breakpoint[], file: string): Breakpoint[] {
  return sortBreakpoints(list.filter((b) => b.file === file))
}

export function breakpointCount(list: readonly Breakpoint[]): number {
  return list.length
}
