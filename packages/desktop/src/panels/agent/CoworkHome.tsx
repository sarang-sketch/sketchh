import type { ReactNode } from 'react'
import { useAppDispatch, useAppState } from '../../state/AppState'
import { useFileActions } from '../../editor/useFileActions'
import { basename } from '../../editor/paths'
import { ArrowUp, ChevronDown, Code, Folder, Layers, Palette, Puzzle, Search, Shield, Sparkles } from '../../components/Icons'
import { SketchMark } from '../../components/SketchMark'
import { WORKFLOWS } from '../../workflows/catalog'
import { Composer } from './Composer'
import styles from './CoworkHome.module.css'

const starters = [
  { id: 'feature', icon: Code, subtitle: 'Turn an idea into working code.' },
  { id: 'bug', icon: Sparkles, subtitle: 'Find the cause and make it right.' },
  { id: 'explore', icon: Search, subtitle: 'Get to know your codebase.' },
  { id: 'review', icon: Shield, subtitle: 'A fresh look at your changes.' },
] as const

export function CoworkHome({ blocker }: { blocker?: ReactNode }) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const files = useFileActions()
  return (
    <div className={styles.canvas + ' dottedCanvas'}>
      <header className={styles.toolbar}><span><Sparkles size={15} />Cowork</span><button onClick={() => dispatch({ type: 'OPEN_SETTINGS', payload: 'appearance' })}><Palette size={14} />Personalize</button></header>
      <div className={styles.content}>
        <div className={styles.heading}><SketchMark size={40} /><h1>What will you work on today?</h1><p>Plan a feature, explore your project, or hand off the busywork.</p></div>
        <div className={styles.composer}>
          <Composer placeholder="Describe a task, @ a file, or / a command…" rows={3} compact={false} acceptSeeds surface="agent" />
          <div className={styles.contextRow}>
            <button className={styles.folder} onClick={() => void files.openFolder()} title={state.projectRoot ?? 'Choose a project folder'}><Folder size={14} /><span>{state.projectRoot ? basename(state.projectRoot) : 'Choose a project'}</span><ChevronDown size={12} /></button>
            <span className={styles.hint}>Enter to send <span>Shift + Enter for a new line</span></span>
          </div>
        </div>
        <div className={styles.blocker}>{blocker}</div>
        {state.appearance.showTips && <section className={styles.starters} aria-label="Task starters">
          <div className={styles.sectionTitle}><span>A place to start</span><button onClick={() => dispatch({ type: 'SET_AGENT_VIEW', payload: 'workflows' })}>All workflows <ArrowUp size={12} className={styles.linkArrow} /></button></div>
          <div className={styles.starterGrid}>{starters.map(({ id, icon: Icon, subtitle }) => {
            const workflow = WORKFLOWS.find((w) => w.id === id)!
            return <button key={id} className={styles.starter} onClick={() => { dispatch({ type: 'SET_AGENT_PREFS', payload: { mode: workflow.mode } }); dispatch({ type: 'SEED_COMPOSER', payload: { text: workflow.prompt } }) }}><span className={styles.starterIcon}><Icon size={18} /></span><span><strong>{workflow.title}</strong><small>{subtitle}</small></span><ArrowUp size={13} className={styles.starterArrow} /></button>
          })}</div>
        </section>}
        {state.workspaces.length > 0 && <section className={styles.recentProjects} aria-label="Recent projects"><div className={styles.sectionTitle}><span>Pick up where you left off</span><button onClick={() => dispatch({ type: 'SET_AGENT_VIEW', payload: 'projects' })}>All projects</button></div>{state.workspaces.slice(0, 3).map((project) => <button key={project.path} className={styles.project} onClick={() => void files.openFolderPath(project.path)}><Folder size={15} /><span>{project.name}</span><small>{project.path}</small>{project.path === state.projectRoot && <b>Open</b>}</button>)}</section>}
        <footer className={styles.footer}><span>Your workspace. Your way.</span><div><button onClick={() => dispatch({ type: 'SET_AGENT_VIEW', payload: 'customize' })}><Puzzle size={13} />Add skills</button><button onClick={() => dispatch({ type: 'SET_AGENT_VIEW', payload: 'tools' })}><Layers size={13} />Connect tools</button></div></footer>
      </div>
    </div>
  )
}
