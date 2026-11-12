/** Place a fixed popover inside the viewport, opening above a bottom-edge control. */
export function popoverPosition(anchor: { left: number; top: number; bottom: number }, viewport: { width: number; height: number }) {
  const gap = 6, margin = 8
  const width = Math.min(360, Math.max(0, viewport.width - margin * 2))
  const above = Math.max(0, anchor.top - margin - gap)
  const below = Math.max(0, viewport.height - anchor.bottom - margin - gap)
  const up = below < 300 && above > below
  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - width - margin)),
    width,
    maxHeight: Math.min(440, up ? above : below),
    top: up ? undefined : Math.max(margin, anchor.bottom + gap),
    bottom: up ? Math.max(margin, viewport.height - anchor.top + gap) : undefined,
    placement: up ? 'above' as const : 'below' as const,
  }
}
