import { useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppState } from '../state/AppState'
import { Check, Code, Columns, Eye, Layout, Palette, PanelBottom, PanelLeft, PanelRight } from './Icons'
import styles from './LayoutMenu.module.css'

export function LayoutMenu() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
    const down = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key) }
  }, [open])
  const run = (action: () => void) => { action(); setOpen(false); trigger.current?.focus() }
  const togglePanel = (action: Parameters<typeof dispatch>[0], visible: boolean) => {
    if (state.focusMode) {
      dispatch({ type: 'TOGGLE_FOCUS_MODE' })
      if (!visible) dispatch(action)
    } else dispatch(action)
  }
  return (
    <div className={styles.wrap} ref={ref} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
      <button ref={trigger} type="button" className={styles.trigger} aria-label="Customize layout" title="Customize layout" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Layout size={15} /></button>
      {open && <div className={styles.menu} role="menu" aria-label="Workspace layout" onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'))
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      }}>
        <div className={styles.title}>Your workspace</div>
        <button role="menuitem" onClick={() => run(() => dispatch({ type: 'TOGGLE_FOCUS_MODE' }))}><Eye size={15} /><span>{state.focusMode ? 'Exit focus mode' : 'Enter focus mode'}</span><kbd>Ctrl ⇧ L</kbd></button>
        <button role="menuitemcheckbox" aria-checked={!state.focusMode && (state.mode === 'ide' ? state.ideActivePanel !== null : !state.sidebarCollapsed)} onClick={() => togglePanel({ type: state.mode === 'ide' ? 'TOGGLE_IDE_SIDE_PANEL' : 'TOGGLE_SIDEBAR' }, state.mode === 'ide' ? state.ideActivePanel !== null : !state.sidebarCollapsed)}><PanelLeft size={15} /><span>Sidebar</span>{!state.focusMode && (state.mode === 'ide' ? state.ideActivePanel !== null : !state.sidebarCollapsed) && <Check size={13} />}</button>
        {state.mode === 'ide' && <>
          <button role="menuitemcheckbox" aria-checked={!state.focusMode && !state.rightPanelCollapsed} onClick={() => togglePanel({ type: 'TOGGLE_RIGHT_PANEL' }, !state.rightPanelCollapsed)}><PanelRight size={15} /><span>Agent panel</span>{!state.focusMode && !state.rightPanelCollapsed && <Check size={13} />}</button>
          <button role="menuitemcheckbox" aria-checked={!state.focusMode && state.bottomPanelOpen} onClick={() => togglePanel({ type: 'TOGGLE_BOTTOM_PANEL' }, state.bottomPanelOpen)}><PanelBottom size={15} /><span>Terminal & problems</span>{!state.focusMode && state.bottomPanelOpen && <Check size={13} />}</button>
        </>}
        <div className={styles.separator} />
        <div className={styles.title}>Code layouts</div>
        {([{ id: 'balanced', label: 'Build', description: 'Editor, agent and terminal', icon: Code }, { id: 'review', label: 'Review', description: 'Changes beside your code', icon: Columns }, { id: 'write', label: 'Write', description: 'An uncluttered editor', icon: Eye }] as const).map(({ id, label, description, icon: Icon }) => <button key={id} role="menuitem" onClick={() => run(() => dispatch({ type: 'APPLY_LAYOUT_PRESET', payload: id }))}><Icon size={15} /><span>{label}<small>{description}</small></span></button>)}
        <div className={styles.separator} />
        <button role="menuitem" onClick={() => run(() => dispatch({ type: 'OPEN_SETTINGS', payload: 'appearance' }))}><Palette size={15} /><span>Appearance & customization</span></button>
      </div>}
    </div>
  )
}
