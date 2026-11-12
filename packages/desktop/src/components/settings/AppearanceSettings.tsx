import type { ReactNode } from 'react'
import { useAppDispatch, useAppState } from '../../state/AppState'
import { ACCENT_PRESETS, DEFAULT_APPEARANCE, type AppearanceSettings as Preferences } from '../../styles/appearance'
import { Check, Code, Columns, Eye, Moon, Palette, Sun } from '../Icons'
import { SketchMark } from '../SketchMark'
import { useConfirm } from '../ConfirmDialog'
import styles from './AppearanceSettings.module.css'

function Row({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return <div className={styles.row}><div><span className={styles.rowTitle}>{title}</span>{detail && <p>{detail}</p>}</div><div className={styles.control}>{children}</div></div>
}

export function AppearanceSettings() {
  const { appearance: s, editorSettings, focusMode } = useAppState()
  const dispatch = useAppDispatch()
  const confirm = useConfirm()
  const set = (payload: Partial<Preferences>) => dispatch({ type: 'SET_APPEARANCE', payload })
  const toggle = (key: 'showStatusBar' | 'showTips' | 'reduceMotion', label: string) => (
    <button type="button" role="switch" aria-label={label} aria-checked={s[key]} className={styles.switch} onClick={() => set({ [key]: !s[key] })}><span /></button>
  )
  const reset = async () => {
    const answer = await confirm({ title: 'Reset appearance?', message: 'Restore the original colors and workspace layout preferences.', buttons: [{ id: 'reset', label: 'Reset appearance', kind: 'primary' }, { id: 'cancel', label: 'Cancel', kind: 'secondary' }], cancelId: 'cancel' })
    if (answer === 'reset') set(DEFAULT_APPEARANCE)
  }

  return (
    <section className={styles.pane} aria-label="Appearance preferences">
      <header className={styles.heading}><div><h2>Appearance</h2><p>A workspace that feels like yours. Changes apply as you choose.</p></div><Palette size={22} /></header>
      <div className={styles.preview} aria-hidden="true">
        <div className={styles.previewTop}><SketchMark size={17} /><span>sketch</span><div /><span>Cowork</span><span>Code</span></div>
        <div className={styles.previewBody}><div className={styles.previewNav}><i /><i /><i /></div><div className={styles.previewMain}><span>Your space to make things.</span><div className={styles.previewComposer}><span>Start with an idea…</span><b><Check size={12} /></b></div></div></div>
      </div>

      <h3>Color & theme</h3>
      <div className={styles.themeChoices} aria-label="Color theme">
        {([{ id: 'dark', label: 'Dark', icon: Moon }, { id: 'light', label: 'Light', icon: Sun }, { id: 'system', label: 'System', icon: Columns }] as const).map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={styles.choice} aria-pressed={editorSettings.colorTheme === id} onClick={() => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { colorTheme: id } })}><Icon size={17} /><span>{label}</span>{editorSettings.colorTheme === id && <Check size={13} />}</button>
        ))}
      </div>
      <Row title="Surface" detail="A subtle character for your light and dark themes.">
        <select aria-label="Surface palette" value={s.surface} onChange={(e) => set({ surface: e.target.value as Preferences['surface'] })}><option value="graphite">Graphite</option><option value="midnight">Midnight</option><option value="warm">Warm stone</option></select>
      </Row>
      <Row title="Accent color" detail="Choose a favorite, or pick any color.">
        <div className={styles.swatches}>
          {ACCENT_PRESETS.map((accent) => <button key={accent.name} type="button" aria-label={accent.name + ' accent'} aria-pressed={s.accentColor === accent.color} title={accent.name} className={styles.swatch} style={{ '--swatch': accent.color } as React.CSSProperties} onClick={() => set({ accentColor: accent.color })}>{s.accentColor === accent.color && <Check size={14} />}</button>)}
          <label className={styles.customColor} title="Custom accent color"><Palette size={16} /><input type="color" aria-label="Custom accent color" value={s.accentColor} onChange={(e) => set({ accentColor: e.target.value })} /></label>
        </div>
      </Row>

      <h3>Space & type</h3>
      <Row title="Interface density" detail="Choose how much breathing room your controls have."><select aria-label="Interface density" value={s.density} onChange={(e) => set({ density: e.target.value as Preferences['density'] })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></Row>
      <Row title="Interface font"><select aria-label="Interface font" value={s.uiFont} onChange={(e) => set({ uiFont: e.target.value as Preferences['uiFont'] })}><option value="inter">Inter</option><option value="system">System</option></select></Row>
      <Row title="Interface text size" detail="Code text size has its own control in Editor settings."><div className={styles.range}><input aria-label="Interface text size" type="range" min={12} max={16} step={1} value={s.uiFontSize} onChange={(e) => set({ uiFontSize: Number(e.target.value) })} /><output>{s.uiFontSize} px</output></div></Row>
      <Row title="Conversation width"><select aria-label="Conversation width" value={s.chatWidth} onChange={(e) => set({ chatWidth: e.target.value as Preferences['chatWidth'] })}><option value="comfortable">Focused</option><option value="wide">Wide</option></select></Row>
      <Row title="Cowork background"><select aria-label="Cowork background" value={s.canvas} onChange={(e) => set({ canvas: e.target.value as Preferences['canvas'] })}><option value="plain">Plain</option><option value="dots">Subtle dots</option><option value="grid">Grid</option></select></Row>

      <h3>Arrange your workspace</h3>
      <div className={styles.presets}>
        {([{ id: 'balanced', name: 'Build', icon: Code }, { id: 'review', name: 'Review', icon: Columns }, { id: 'write', name: 'Write', icon: Eye }] as const).map(({ id, name, icon: Icon }) => <button key={id} type="button" onClick={() => dispatch({ type: 'APPLY_LAYOUT_PRESET', payload: id })}><Icon size={16} /><span>{name} layout</span></button>)}
      </div>
      <Row title="Project sidebar"><select aria-label="Project sidebar position" value={s.sidebarPosition} onChange={(e) => set({ sidebarPosition: e.target.value as Preferences['sidebarPosition'] })}><option value="left">Left</option><option value="right">Right</option></select></Row>
      <Row title="Code agent panel"><select aria-label="Agent panel position" value={s.agentPosition} onChange={(e) => set({ agentPosition: e.target.value as Preferences['agentPosition'] })}><option value="right">Right</option><option value="left">Left</option></select></Row>
      <Row title="Activity bar"><select aria-label="Activity bar position" value={s.activityBar} onChange={(e) => set({ activityBar: e.target.value as Preferences['activityBar'] })}><option value="side">Side</option><option value="top">Top</option><option value="hidden">Hidden</option></select></Row>
      <Row title="Focus mode" detail="Temporarily hide panels. Your layout returns when you exit."><button type="button" className={styles.secondary} onClick={() => dispatch({ type: 'TOGGLE_FOCUS_MODE' })}>{focusMode ? 'Exit focus mode' : 'Enter focus mode'}</button></Row>
      <Row title="Status bar">{toggle('showStatusBar', 'Show status bar')}</Row>
      <Row title="Welcome suggestions">{toggle('showTips', 'Show welcome suggestions')}</Row>
      <Row title="Reduce motion" detail="System accessibility preferences are always respected.">{toggle('reduceMotion', 'Reduce motion')}</Row>
      <footer className={styles.footer}><span>Saved on this device</span><button type="button" onClick={() => void reset()}>Reset appearance</button></footer>
    </section>
  )
}
