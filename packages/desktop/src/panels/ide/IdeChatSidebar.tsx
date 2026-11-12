// Code and Cowork use the same agent session and conversation drafts.
import { useEffect, useId, useState } from 'react'
import styles from './IdeChatSidebar.module.css'
import { Plus, MessageSquare, X, FileCode, Code, AlertTriangle, CheckCircle, Folder, Layers, Brain, Shield, ChevronRight } from '../../components/Icons'
import { SketchMark } from '../../components/SketchMark'
import { useAppState, useAppDispatch } from '../../state/AppState'
import { AgentSessionProvider, useOptionalAgentSession } from '../../lib/AgentSession'
import { Blocker, Composer, MessageList } from '../agent/AgentChat'
import { basename, relativeToRoot } from '../../editor/paths'
import { WORKFLOWS } from '../../workflows/catalog'

const SUGGESTIONS = [
  { id: 'explore', icon: Code, label: 'Explain this project' },
  { id: 'bug', icon: AlertTriangle, label: 'Find and fix a bug' },
  { id: 'tests', icon: CheckCircle, label: 'Write tests' },
] as const

export default function IdeChatSidebar() {
  const shared = useOptionalAgentSession()
  return shared === null
    ? <AgentSessionProvider><IdeChatSidebarView /></AgentSessionProvider>
    : <IdeChatSidebarView />
}

function IdeChatSidebarView() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const session = useOptionalAgentSession()
  const [tab, setTab] = useState<'chat' | 'context'>('chat')
  const id = useId()
  const empty = state.chatMessages.length === 0 && session?.activeRunId == null
  const active = state.activeFile && state.projectRoot ? relativeToRoot(state.projectRoot, state.activeFile) : null
  useEffect(() => {
    if (state.mode === 'ide' && (state.composerFocusNonce > 0 || state.composerSeed !== null)) setTab('chat')
  }, [state.composerFocusNonce, state.composerSeed, state.mode])

  const attach = (path: string) => {
    dispatch({ type: 'SEED_COMPOSER', payload: { text: '', files: [path], preserveText: true } })
    dispatch({ type: 'FOCUS_COMPOSER' })
  }

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Agent views" onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'context' : tab === 'chat' ? 'context' : 'chat'
          setTab(next)
          document.getElementById(id + '-' + next)?.focus()
        }}>
          {(['chat', 'context'] as const).map((view) => <button key={view} id={id + '-' + view} role="tab" tabIndex={tab === view ? 0 : -1} aria-selected={tab === view} aria-controls={id + '-' + view + '-panel'} onClick={() => setTab(view)}>{view === 'chat' ? 'Agent' : 'Context'}</button>)}
        </div>
        <div className={styles.headerControls}>
          <button type="button" className={styles.hdrBtn} title="New chat" aria-label="New chat" disabled={session?.activeRunId != null} onClick={() => { dispatch({ type: 'NEW_CONVERSATION' }); dispatch({ type: 'FOCUS_COMPOSER' }) }}><Plus size={15} /></button>
          <button type="button" className={styles.hdrBtn} title="All conversations" aria-label="All conversations" onClick={() => { dispatch({ type: 'SET_MODE', payload: 'agent' }); dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' }) }}><MessageSquare size={14} /></button>
          <button type="button" className={styles.hdrBtn} title="Close panel" aria-label="Close panel" onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}><X size={14} /></button>
        </div>
      </div>

      <div id={id + '-chat-panel'} role="tabpanel" aria-labelledby={id + '-chat'} hidden={tab !== 'chat'} className={styles.chatPanel}>
        <div className={styles.mainCanvas}>
          {empty ? <div className={styles.emptyState}>
            <SketchMark size={34} />
            <h2>What are we building?</h2>
            <p>Ask about your code or describe a change. Work through it here with Sketch.</p>
            {state.projectRoot !== null && state.appearance.showTips && <div className={styles.suggestions}>
              {SUGGESTIONS.map(({ id: workflowId, icon: Icon, label }) => <button key={workflowId} onClick={() => {
                const workflow = WORKFLOWS.find((w) => w.id === workflowId)!
                dispatch({ type: 'SET_AGENT_PREFS', payload: { mode: workflow.mode } })
                dispatch({ type: 'SEED_COMPOSER', payload: { text: workflow.prompt } })
              }}><Icon size={14} /><span>{label}</span><ChevronRight size={12} /></button>)}
            </div>}
          </div> : <MessageList compact />}
        </div>
        <div className={styles.bottomCardContainer}>
          {active && <button className={styles.activeContext} title="Attach the active file to your message" onClick={() => attach(active)}><FileCode size={12} /><span>{active}</span><Plus size={12} /></button>}
          <Blocker />
          <div className={styles.promptBoxCard}><Composer placeholder="Ask, / for commands, @ for files…" rows={3} compact acceptSeeds /></div>
          {state.appearance.showTips && <div className={styles.composerHint}><span><kbd>Ctrl L</kbd> Focus agent</span><span><kbd>Shift Enter</kbd> New line</span></div>}
        </div>
      </div>

      <div id={id + '-context-panel'} role="tabpanel" aria-labelledby={id + '-context'} hidden={tab !== 'context'} className={styles.contextPanel}>
        <section>
          <h2>Project</h2>
          {state.projectRoot ? <div className={styles.project}><Folder size={18} /><div><strong>{basename(state.projectRoot)}</strong><span>{state.projectRoot}</span></div></div> : <p>Open a project folder to give the agent a workspace.</p>}
          <p>Attach files to guide the next message. The agent can read other files in this project as it works.</p>
        </section>
        <section>
          <div className={styles.sectionHeading}><h2>Open files</h2><span>{state.openFiles.length}</span></div>
          {state.openFiles.length === 0 ? <p>Open a file in the editor, then add it here or use @ in your message.</p> : <div className={styles.contextFiles}>
            {state.openFiles.map((path) => {
              const relative = state.projectRoot ? relativeToRoot(state.projectRoot, path) : path
              return <div className={styles.contextFile} key={path} data-active={path === state.activeFile}>
                <button title={path} onClick={() => dispatch({ type: 'SET_ACTIVE_FILE', payload: path })}><FileCode size={14} /><span>{relative}</span>{state.files[path]?.isDirty && <span className={styles.dirty} aria-label="Unsaved changes">●</span>}</button>
                <button aria-label={'Attach ' + relative} title="Attach to message" onClick={() => attach(relative)}><Plus size={14} /></button>
              </div>
            })}
          </div>}
        </section>
        <section className={styles.resources}>
          <h2>Workspace knowledge</h2>
          <button onClick={() => dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'memory' })}><Brain size={15} /><span>Project memory</span><ChevronRight size={13} /></button>
          <button onClick={() => dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'skills' })}><Code size={15} /><span>Skills & instructions</span><ChevronRight size={13} /></button>
          <button onClick={() => dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'mcp' })}><Layers size={15} /><span>Tools & MCP</span><ChevronRight size={13} /></button>
        </section>
      </div>
      <div className={styles.footer}>
        <button onClick={() => dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'review' })}><Shield size={13} />Review changes</button>
        <button onClick={() => { dispatch({ type: 'SET_MODE', payload: 'agent' }); dispatch({ type: 'SET_AGENT_VIEW', payload: 'workflows' }) }}><Layers size={13} />Workflows</button>
      </div>
    </div>
  )
}
