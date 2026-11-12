import { useState } from 'react'
import { useAppDispatch, useAppState } from '../../state/AppState'
import { useFileActions } from '../../editor/useFileActions'
import { canonicalPath } from '../../editor/paths'
import { CloneDialog } from '../../components/CloneDialog'
import { ArrowUp, Code, Folder, GitBranch, MessageSquare, Plus, Search, X } from '../../components/Icons'
import styles from './CoworkProjects.module.css'

export function CoworkProjects() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const files = useFileActions()
  const [query, setQuery] = useState('')
  const [clone, setClone] = useState(false)
  const projects = state.workspaces.filter((p) => (p.name + ' ' + p.path).toLowerCase().includes(query.trim().toLowerCase()))
  const open = async (path: string, mode: 'agent' | 'ide') => {
    if (!await files.openFolderPath(path)) return
    dispatch({ type: 'SET_MODE', payload: mode })
    if (mode === 'agent') { dispatch({ type: 'NEW_CONVERSATION' }); dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' }) }
  }
  return <section className={styles.page} aria-label="Projects">
    <header className={styles.header}><div><span>Cowork / Projects</span><h1>Everything starts with a workspace.</h1><p>Your projects stay in their folders. Pick one up from here.</p></div><button className={styles.primary} onClick={() => void files.openFolder()}><Plus size={16} />Open folder</button></header>
    <div className={styles.toolbar}><label><Search size={15} /><input aria-label="Search projects" placeholder="Find a project…" value={query} onChange={(e) => setQuery(e.target.value)} /></label><button onClick={() => setClone(true)}><GitBranch size={14} />Clone repository</button></div>
    <div className={styles.projects}>{projects.map((project) => {
      const active = state.projectRoot !== null && canonicalPath(project.path) === canonicalPath(state.projectRoot)
      const conversations = state.conversations.filter((c) => c.root && canonicalPath(c.root) === canonicalPath(project.path)).length
      return <article key={project.path} className={styles.project}><div className={styles.projectTop}><span className={styles.icon}><Folder size={22} /></span>{active && <span className={styles.active}>Current workspace</span>}<button aria-label={'Remove ' + project.name + ' from recent projects'} title="Remove from recent projects" onClick={() => dispatch({ type: 'FORGET_WORKSPACE', payload: project.path })}><X size={14} /></button></div><h2>{project.name}</h2><p title={project.path}>{project.path}</p><span className={styles.count}><MessageSquare size={12} />{conversations} {conversations === 1 ? 'conversation' : 'conversations'}</span><div className={styles.actions}><button onClick={() => void open(project.path, 'agent')}>New task<ArrowUp size={13} /></button><button onClick={() => void open(project.path, 'ide')}><Code size={14} />Open in Code</button></div></article>
    })}</div>
    {projects.length === 0 && <div className={styles.empty}><Folder size={36} /><h2>{query ? 'No matching projects' : 'Your next project belongs here.'}</h2><p>{query ? 'Try a different name or folder path.' : 'Open an existing folder or clone a repository. Your code and conversations come together in one place.'}</p><button className={styles.primary} onClick={() => query ? setQuery('') : void files.openFolder()}>{query ? 'Clear search' : 'Choose a folder'}</button></div>}
    {clone && <CloneDialog open onClose={() => setClone(false)} />}
  </section>
}
