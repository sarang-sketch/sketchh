import { useEffect, useMemo, useState } from 'react'
import { useAppDispatch, useAppState, scrubSecrets, type AgentMode } from '../../state/AppState'
import { useOptionalAgentSession } from '../../lib/AgentSession'
import { useConfirm } from '../../components/ConfirmDialog'
import { AlertTriangle, ArrowUp, Bookmark, Check, Code, FileText, Layers, Pencil, Plus, Search, Shield, Trash, X } from '../../components/Icons'
import { WORKFLOWS, WORKFLOWS_STORAGE_KEY, MAX_PERSONAL_WORKFLOWS, normalizeWorkflows, type Workflow, type WorkflowCategory } from '../../workflows/catalog'
import styles from './WorkflowLibrary.module.css'

const categories = ['All', 'Build', 'Review', 'Research', 'Writing', 'Organize', 'Personal'] as const
const icons = { Build: Code, Review: Shield, Research: Search, Writing: FileText, Organize: Layers }
const newWorkflow = (): Workflow => ({ id: 'personal-' + crypto.randomUUID(), title: '', description: '', category: 'Build', mode: 'agent', prompt: '', personal: true })
function readSaved(): Workflow[] {
  try { return normalizeWorkflows(JSON.parse(localStorage.getItem(WORKFLOWS_STORAGE_KEY) ?? '[]')) } catch { return [] }
}

export function WorkflowLibrary() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const session = useOptionalAgentSession()
  const confirm = useConfirm()
  const [saved, setSaved] = useState(readSaved)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('All')
  const [selected, setSelected] = useState<Workflow | null>(null)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const busy = session?.activeRunId != null
  useEffect(() => {
    const update = (event: StorageEvent) => { if (event.key === WORKFLOWS_STORAGE_KEY) setSaved(readSaved()) }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [])
  const workflows = useMemo(() => [...saved, ...WORKFLOWS].filter((w) =>
    (category === 'All' || (category === 'Personal' ? w.personal : w.category === category)) &&
    (w.title + ' ' + w.description + ' ' + w.category).toLowerCase().includes(query.trim().toLowerCase())), [saved, query, category])
  const persist = (next: Workflow[]): boolean => {
    try { localStorage.setItem(WORKFLOWS_STORAGE_KEY, JSON.stringify(next)); setSaved(next); setError(''); return true }
    catch { setError('Your browser could not save this workflow. Free some local storage and try again.'); return false }
  }
  const save = () => {
    if (!selected?.title.trim() || !selected.prompt.trim()) { setError('Give your workflow a name and instructions.'); return }
    const value = { ...selected, title: scrubSecrets(selected.title.trim()), description: scrubSecrets(selected.description.trim()), prompt: scrubSecrets(selected.prompt), personal: true }
    const exists = saved.some((w) => w.id === value.id)
    if (!exists && saved.length >= MAX_PERSONAL_WORKFLOWS) { setError('You have 48 saved workflows. Remove one before adding another.'); return }
    if (persist(normalizeWorkflows(exists ? saved.map((w) => w.id === value.id ? value : w) : [value, ...saved]))) { setSelected(value); setEditing(false); setNotice('Workflow saved on this device.'); }
  }
  const remove = async (workflow: Workflow) => {
    const answer = await confirm({ title: 'Delete workflow?', message: 'Remove “' + workflow.title + '” from your personal workflows?', buttons: [{ id: 'delete', label: 'Delete workflow', kind: 'danger' }, { id: 'cancel', label: 'Cancel', kind: 'secondary' }], cancelId: 'cancel' })
    if (answer === 'delete' && persist(saved.filter((w) => w.id !== workflow.id))) { setSelected(null); setNotice('Workflow deleted.'); }
  }
  const prepare = () => {
    if (!selected || busy || !selected.prompt.trim()) return
    dispatch({ type: 'NEW_CONVERSATION' })
    dispatch({ type: 'SET_AGENT_PREFS', payload: { mode: selected.mode } })
    dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' })
    dispatch({ type: 'SEED_COMPOSER', payload: { text: selected.prompt } })
  }
  const pick = (workflow: Workflow, edit = false) => { setSelected({ ...workflow }); setEditing(edit); setError(''); setNotice('') }

  return (
    <section className={styles.page} aria-label="Workflow library">
      <header className={styles.header}><div><span className={styles.breadcrumb}>Cowork / Workflows</span><h1>Good work starts with a good brief.</h1><p>Reusable starting points for your next task. Make any of them your own.</p></div><button className={styles.primary} onClick={() => pick(newWorkflow(), true)}><Plus size={15} />Create workflow</button></header>
      <div className={styles.toolbar}><div className={styles.search}><Search size={15} /><input aria-label="Search workflows" placeholder="Find a workflow…" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button aria-label="Clear workflow search" onClick={() => setQuery('')}><X size={13} /></button>}</div><span>{saved.length} personal {saved.length === 1 ? 'workflow' : 'workflows'}</span></div>
      <div className={styles.filters} aria-label="Workflow categories">{categories.map((c) => <button key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}</div>
      {notice && <p className={styles.notice} role="status"><Check size={14} />{notice}</p>}
      <div className={styles.workspace}>
        <div className={styles.grid}>
          {workflows.map((w) => { const Icon = icons[w.category]; return <button key={w.id} className={styles.card} aria-pressed={selected?.id === w.id} onClick={() => pick(w)}><span className={styles.cardTop}><span className={styles.cardIcon}><Icon size={19} /></span>{w.personal && <Bookmark size={13} />}<span className={styles.mode}>{w.mode === 'ask' ? 'Read only' : w.mode === 'auto' ? 'Autonomous' : 'Agent'}</span></span><strong>{w.title}</strong><span className={styles.description}>{w.description || 'Your reusable instructions.'}</span><span className={styles.category}>{w.category}<span>View workflow</span></span></button> })}
          {workflows.length === 0 && <div className={styles.empty}><Search size={26} /><h2>{category === 'Personal' && saved.length === 0 ? 'Your way of working, saved.' : 'No matching workflows'}</h2><p>{category === 'Personal' && saved.length === 0 ? 'Create a workflow for the instructions you find yourself repeating.' : 'Try another search or category.'}</p><button className={styles.secondary} onClick={() => category === 'Personal' && !saved.length ? pick(newWorkflow(), true) : (setCategory('All'), setQuery(''))}>{category === 'Personal' && !saved.length ? 'Create your first workflow' : 'Clear filters'}</button></div>}
        </div>
        {selected && <aside className={styles.detail} aria-label={editing ? 'Edit workflow' : 'Workflow details'}>
          <div className={styles.detailHeading}><span>{editing ? (saved.some((w) => w.id === selected.id) ? 'Edit workflow' : 'New workflow') : 'Make it your own'}</span><button aria-label="Close workflow details" onClick={() => { setSelected(null); setError('') }}><X size={16} /></button></div>
          {editing ? <>
            <label>Workflow name<input autoFocus maxLength={80} value={selected.title} placeholder="e.g. My weekly code review" onChange={(e) => setSelected({ ...selected, title: e.target.value })} /></label>
            <label>Description<input maxLength={180} value={selected.description} placeholder="What does this help you do?" onChange={(e) => setSelected({ ...selected, description: e.target.value })} /></label>
            <label>Category<select value={selected.category} onChange={(e) => setSelected({ ...selected, category: e.target.value as WorkflowCategory })}>{categories.filter((c) => c !== 'All' && c !== 'Personal').map((c) => <option key={c}>{c}</option>)}</select></label>
          </> : <><h2>{selected.title}</h2><p>{selected.description}</p></>}
          <label>Instructions<textarea aria-label="Workflow instructions" value={selected.prompt} maxLength={20_000} rows={9} onChange={(e) => setSelected({ ...selected, prompt: e.target.value })} /></label>
          <label>Mode<select aria-label="Workflow mode" value={selected.mode} onChange={(e) => setSelected({ ...selected, mode: e.target.value as AgentMode })}><option value="ask">Ask — read only</option><option value="agent">Agent — edit with command approvals</option><option value="auto">Auto — work autonomously</option></select></label>
          <p className={styles.note}>{editing ? 'Stored locally. You can edit these instructions any time.' : 'Opens a new task with these instructions. Review your prompt before sending.'}</p>
          {error && <p className={styles.error} role="alert"><AlertTriangle size={14} />{error}</p>}
          {busy && !editing && <p className={styles.note}>Finish or stop the current run before starting a new task.</p>}
          <button className={styles.primary} disabled={editing ? !selected.title.trim() || !selected.prompt.trim() : busy || !selected.prompt.trim()} onClick={editing ? save : prepare}>{editing ? <Check size={15} /> : <ArrowUp size={15} />}{editing ? 'Save workflow' : 'Use workflow'}</button>
          {!editing && <div className={styles.detailActions}><button onClick={() => pick(selected.personal ? selected : { ...selected, id: newWorkflow().id, personal: true }, true)}><Pencil size={13} />{selected.personal ? 'Edit workflow' : 'Save a personal copy'}</button>{selected.personal && <button aria-label="Delete workflow" onClick={() => void remove(selected)}><Trash size={14} /></button>}</div>}
        </aside>}
      </div>
      {state.projectRoot === null && <p className={styles.footnote}>You can explore workflows now. Choose a project folder when you are ready to run one.</p>}
    </section>
  )
}
