// Sketch on your phone, Freebuff-style layout, Sketch branding.
//
// Home is the Agent chat (chat-first): a centred mark, a mode pill and a big
// rounded composer. A slide-in drawer holds New chat / New project, Daily
// usage, Projects, saved Chats and a settings gear. Files is a proper
// explorer with collapsible folders, file sizes and in-app bottom sheets —
// no window.prompt / window.confirm anywhere. Files live in this phone's
// browser storage; the agent talks to a provider the user configures;
// Preview runs HTML/JavaScript in a sandboxed frame. There is no local
// terminal on mobile — Preview says so plainly instead of faking one.

import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  buildFilePath, createFile, deleteFile, fileBytes, fileLines, foldersOf, formatBytes, formatTokens,
  loadFiles, projectFromJson, projectToJson, projectStats, renameFile, saveFiles, starterFiles,
  timeAgo, updateFile, STORE_KEY,
  type MobileFile,
} from './store'
import {
  estimateTokens, firstCodeBlock, loadProvider, maxTurns, saveProvider, sendChat, PROVIDER_KEY,
  type AgentMode, type AgentSpeed, type ChatTurn, type ProviderConfig,
} from './agent'
import {
  applySyncBundle, createSyncBundle, getLastSync, parseSyncBundleJson, setLastSync, syncBundleToJson,
  validateSyncBundle, LAST_SYNC_KEY,
  type LastSyncInfo,
} from './sync'
import { chatTitle, loadChats, newChat, saveChats, upsertChat, CHATS_KEY, LEGACY_CHAT_KEY, type SavedChat } from './chats'
import { clearUsage, loadUsage, recordUsage, USAGE_KEY, type DayUsage } from './usage'

export const APP_VERSION = '1.1.0'

type View = 'chat' | 'files' | 'editor' | 'preview' | 'settings'
type SettingsPage = 'root' | 'general' | 'appearance' | 'model' | 'project' | 'usage' | 'about'

type SheetState =
  | { kind: 'file'; file: MobileFile }
  | { kind: 'newFile' }
  | { kind: 'rename'; file: MobileFile }
  | { kind: 'delete'; file: MobileFile }
  | { kind: 'project' }
  | { kind: 'mode' }
  | { kind: 'attach' }
  | { kind: 'apply'; reply: string }
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; onConfirm: () => void }
  | null

const ACCENTS: Record<string, string> = { Ember: '#f58a50', Sky: '#38bdf8', Mint: '#34d399' }

interface Settings {
  theme: 'dark' | 'light' | 'system'
  accent: string
  fontSize: 'small' | 'medium' | 'large'
}

const SETTINGS_KEY = 'sketch.mobile.settings.v1'

function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null
    if (parsed === null) return { theme: 'dark', accent: 'Ember', fontSize: 'medium' }
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'system' ? parsed.theme : 'dark',
      accent: parsed.accent !== undefined && parsed.accent in ACCENTS ? parsed.accent : 'Ember',
      fontSize: parsed.fontSize === 'small' || parsed.fontSize === 'large' ? parsed.fontSize : 'medium',
    }
  } catch {
    return { theme: 'dark', accent: 'Ember', fontSize: 'medium' }
  }
}

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const MODES: Array<{ id: AgentMode; label: string; pill: string; hint: string }> = [
  { id: 'ask', label: 'Ask', pill: 'Chat only', hint: 'Read-only answers — no file edits proposed.' },
  { id: 'agent', label: 'Agent', pill: 'Agent', hint: 'Proposes code you apply with one tap.' },
  { id: 'auto', label: 'Auto', pill: 'Auto', hint: 'Works through the request in one longer reply.' },
]

const SPEEDS: Array<{ id: AgentSpeed; label: string; hint: string }> = [
  { id: 'normal', label: 'Normal', hint: 'Full reply: last 12 turns of context.' },
  { id: 'turbo', label: 'Turbo', hint: 'Faster and lighter: last 6 turns of context.' },
]

const FILE_TYPES = [
  { ext: 'js', label: 'JavaScript' },
  { ext: 'html', label: 'HTML' },
  { ext: 'md', label: 'Markdown' },
  { ext: 'txt', label: 'Text' },
] as const

type IconName =
  | 'menu' | 'compose' | 'search' | 'folder' | 'chevronDown' | 'chevronRight' | 'chevronLeft'
  | 'plus' | 'send' | 'x' | 'gear' | 'chat' | 'clock' | 'trash' | 'pencil' | 'eye' | 'more'
  | 'check' | 'download' | 'upload' | 'sync' | 'file' | 'back'

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  menu: (<><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>),
  compose: (<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>),
  search: (<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>),
  folder: (<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />),
  chevronDown: (<path d="M6 9l6 6 6-6" />),
  chevronRight: (<path d="M9 6l6 6-6 6" />),
  chevronLeft: (<path d="M15 6l-6 6 6 6" />),
  plus: (<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  send: (<><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></>),
  x: (<><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>),
  gear: (<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>),
  chat: (<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />),
  clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  trash: (<><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></>),
  pencil: (<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />),
  eye: (<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" /></>),
  more: (<><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" /></>),
  check: (<path d="M20 6L9 17l-5-5" />),
  download: (<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>),
  upload: (<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></>),
  sync: (<><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10" /><path d="M1 14l4.6 4.4A9 9 0 0 0 20.5 15" /></>),
  file: (<><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M13 2v7h7" /></>),
  back: (<path d="M15 6l-6 6 6 6" />),
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  )
}

/** File-type tile: a coloured square with a two-letter code — a real icon, not an emoji. */
function FileBadge({ path }: { path: string }): React.JSX.Element {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const kind = ext === 'js' || ext === 'ts' ? 'js' : ext === 'html' || ext === 'css' ? 'html' : ext === 'md' ? 'md' : ext === 'json' ? 'json' : 'txt'
  const label = kind === 'js' ? 'JS' : kind === 'html' ? '<>' : kind === 'md' ? 'M' : kind === 'json' ? '{}' : 'T'
  return <span className={`fileBadge fileBadge-${kind}`} aria-hidden="true">{label}</span>
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="sheetScrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" aria-hidden="true" />
        <div className="sheetHead">
          <h2>{title}</h2>
          <button className="iconBtn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function SheetRow({ icon, label, sub, checked, soon, danger, onClick }: {
  icon: IconName; label: string; sub?: string; checked?: boolean; soon?: boolean; danger?: boolean; onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className={`sheetRow ${danger ? 'sheetRowDanger' : ''}`} onClick={onClick}>
      <span className="sheetRowIcon"><Icon name={icon} /></span>
      <span className="sheetRowText">
        <span className="sheetRowLabel">{label}</span>
        {sub !== undefined && <span className="sheetRowSub">{sub}</span>}
      </span>
      {checked === true && <Icon name="check" />}
      {soon === true && <span className="soonPill">Soon</span>}
    </button>
  )
}

function NewFileSheet({ files, onCreate, onClose }: {
  files: readonly MobileFile[]; onCreate: (path: string) => void; onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [ext, setExt] = useState<string>('js')
  const path = buildFilePath(name, ext)
  const taken = path !== '' && files.some((f) => f.path === path)
  return (
    <Sheet title="New file" onClose={onClose}>
      <label className="field">Name
        <input autoFocus type="text" placeholder="my-file" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="fieldLabel">Type</div>
      <div className="chipRow" role="group" aria-label="File type">
        {FILE_TYPES.map((t) => (
          <button key={t.ext} type="button" className={`chip ${ext === t.ext ? 'chipOn' : ''}`} onClick={() => setExt(t.ext)}>{t.label}</button>
        ))}
      </div>
      <p className="hint">{path === '' ? 'Type a name — nothing is created until you tap Create.' : `Will create: ${path}`}</p>
      {taken && <p className="errorBox" role="alert">A file with that name already exists.</p>}
      <button
        type="button"
        className="primaryBtn blockBtn"
        disabled={path === '' || taken}
        onClick={() => { onCreate(path); onClose() }}
      >
        Create file
      </button>
    </Sheet>
  )
}

function RenameSheet({ file, files, onRename, onClose }: {
  file: MobileFile; files: readonly MobileFile[]; onRename: (path: string) => void; onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState(file.path)
  const clean = name.trim().replace(/^\/+/, '')
  const taken = clean !== '' && clean !== file.path && files.some((f) => f.path === clean)
  return (
    <Sheet title="Rename file" onClose={onClose}>
      <label className="field">Path
        <input autoFocus type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {taken && <p className="errorBox" role="alert">A file with that name already exists.</p>}
      <button
        type="button"
        className="primaryBtn blockBtn"
        disabled={clean === '' || clean === file.path || taken}
        onClick={() => { onRename(clean); onClose() }}
      >
        Save name
      </button>
    </Sheet>
  )
}

function DeleteSheet({ file, onDelete, onClose }: {
  file: MobileFile; onDelete: () => void; onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet title="Delete file" onClose={onClose}>
      <p className="sheetText">Delete <strong>{file.path}</strong>? This cannot be undone. Export the project first if you want to keep a copy.</p>
      <button type="button" className="dangerBtn blockBtn" onClick={() => { onDelete(); onClose() }}>Delete file</button>
      <button type="button" className="secondaryBtn blockBtn" onClick={onClose}>Keep it</button>
    </Sheet>
  )
}

function ModeSheet({ mode, speed, onMode, onSpeed, onClose }: {
  mode: AgentMode; speed: AgentSpeed; onMode: (m: AgentMode) => void; onSpeed: (s: AgentSpeed) => void; onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet title="Chat mode" onClose={onClose}>
      {MODES.map((m) => (
        <SheetRow key={m.id} icon="chat" label={m.label} sub={m.hint} checked={mode === m.id} onClick={() => { onMode(m.id); onClose() }} />
      ))}
      <div className="sheetDivider" />
      {SPEEDS.map((s) => (
        <SheetRow key={s.id} icon="sync" label={s.label} sub={s.hint} checked={speed === s.id} onClick={() => { onSpeed(s.id); onClose() }} />
      ))}
    </Sheet>
  )
}

function AttachSheet({ files, attached, onToggle, onClose }: {
  files: readonly MobileFile[]; attached: readonly string[]; onToggle: (id: string) => void; onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet title="Attach files" onClose={onClose}>
      <p className="hint">Attached files are sent to the model with your message, so it can answer about your code.</p>
      {files.length === 0 && <p className="hint">No files yet — create one from the Files tab first.</p>}
      {files.map((f) => (
        <SheetRow
          key={f.id}
          icon="file"
          label={f.path}
          sub={`${fileLines(f)} lines · ${formatBytes(fileBytes(f))}`}
          checked={attached.includes(f.id)}
          onClick={() => onToggle(f.id)}
        />
      ))}
      <button type="button" className="primaryBtn blockBtn" onClick={onClose}>Done</button>
    </Sheet>
  )
}

function ApplySheet({ reply, onApply, onClose }: {
  reply: string; onApply: (path: string) => void; onClose: () => void
}): React.JSX.Element {
  const block = firstCodeBlock(reply)
  const [path, setPath] = useState(block?.path ?? 'src/app.js')
  return (
    <Sheet title="Apply code to a file" onClose={onClose}>
      <p className="hint">The code from the reply will replace the contents of this file, or create it if it does not exist.</p>
      <label className="field">Save as
        <input autoFocus type="text" value={path} onChange={(e) => setPath(e.target.value)} />
      </label>
      <button
        type="button"
        className="primaryBtn blockBtn"
        disabled={path.trim() === ''}
        onClick={() => { onApply(path.trim().replace(/^\/+/, '')); onClose() }}
      >
        Apply code
      </button>
    </Sheet>
  )
}

function ProjectSheet({ onBlank, onTemplate, onChatOnly, onClose }: {
  onBlank: () => void; onTemplate: () => void; onChatOnly: () => void; onClose: () => void
}): React.JSX.Element {
  const [githubNote, setGithubNote] = useState(false)
  return (
    <Sheet title="Project" onClose={onClose}>
      <SheetRow icon="plus" label="New project" sub="Start blank — your current files are exported first" onClick={onBlank} />
      <SheetRow icon="chat" label="Chat only" sub="A new chat with no project attached" checked onClick={onChatOnly} />
      <SheetRow
        icon="download"
        label="GitHub repository…"
        sub="Import a repo as your project"
        soon
        onClick={() => setGithubNote(true)}
      />
      {githubNote && <p className="hint">GitHub import isn&apos;t built yet — use a template for now, or export a project from the desktop app and import it in Settings → Project.</p>}
      <SheetRow icon="file" label="Start from a template…" sub="index.html + src/app.js + README.md" onClick={onTemplate} />
    </Sheet>
  )
}

function ConfirmSheet({ title, body, confirmLabel, onConfirm, onClose }: {
  title: string; body: string; confirmLabel: string; onConfirm: () => void; onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet title={title} onClose={onClose}>
      <p className="sheetText">{body}</p>
      <button type="button" className="dangerBtn blockBtn" onClick={() => { onConfirm(); onClose() }}>{confirmLabel}</button>
      <button type="button" className="secondaryBtn blockBtn" onClick={onClose}>Cancel</button>
    </Sheet>
  )
}

export default function App(): React.JSX.Element {
  const [files, setFiles] = useState<MobileFile[]>(() => loadFiles())
  const [view, setView] = useState<View>('chat')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerSearch, setDrawerSearch] = useState(false)
  const [drawerQuery, setDrawerQuery] = useState('')
  const [sheet, setSheet] = useState<SheetState>(null)
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('root')
  const [settingsQuery, setSettingsQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [systemLight, setSystemLight] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches,
  )
  const [provider, setProvider] = useState<ProviderConfig>(() => loadProvider())
  const [chats, setChats] = useState<SavedChat[]>(() => loadChats())
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [mode, setMode] = useState<AgentMode>('agent')
  const [speed, setSpeed] = useState<AgentSpeed>('normal')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachedIds, setAttachedIds] = useState<string[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [consoleLines, setConsoleLines] = useState<string[]>([])
  const [lastSync, setLastSyncState] = useState<LastSyncInfo | null>(() => getLastSync())
  const [usage, setUsage] = useState<DayUsage>(() => loadUsage())
  const [filesQuery, setFilesQuery] = useState('')
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  const active = files.find((f) => f.id === activeId) ?? null
  const activeChat = chats.find((c) => c.id === activeChatId) ?? null
  const chat: ChatTurn[] = useMemo(() => activeChat?.turns ?? [], [activeChat])
  const previewFile = files.find((f) => f.id === previewId) ?? files.find((f) => f.path.endsWith('.html')) ?? null
  const effectiveTheme = settings.theme === 'system' ? (systemLight ? 'light' : 'dark') : settings.theme

  useEffect(() => saveFiles(files), [files])
  useEffect(() => saveChats(chats), [chats])
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch { /* settings last for this session only */ }
  }, [settings])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (e: MediaQueryListEvent) => setSystemLight(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat, view])

  const openFile = (file: MobileFile) => {
    setActiveId(file.id)
    setView('editor')
  }

  const startNewChat = () => {
    const c = newChat()
    setChats((current) => [c, ...current])
    setActiveChatId(c.id)
    setAttachedIds([])
    setUsage(recordUsage({ chats: 1 }))
    setView('chat')
    setDrawerOpen(false)
  }

  const openChat = (id: string) => {
    setActiveChatId(id)
    setAttachedIds([])
    setView('chat')
    setDrawerOpen(false)
  }

  const updateChatTurns = (id: string, turns: ChatTurn[]) => {
    setChats((current) => {
      const found = current.find((c) => c.id === id)
      if (found === undefined) return current
      const updated: SavedChat = { ...found, turns, title: chatTitle(turns), updatedAt: Date.now() }
      return upsertChat(current, updated)
    })
  }

  const applyCodeTo = (reply: string, path: string) => {
    const block = firstCodeBlock(reply)
    if (block === null) return
    setFiles((current) => {
      const existing = current.find((f) => f.path === path)
      if (existing) return updateFile(current, existing.id, block.code)
      return [...current, { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, path, content: block.code, updatedAt: Date.now() }]
    })
    setError(null)
  }

  const send = async () => {
    const text = prompt.trim()
    if (text === '' || sending) return
    if (provider.baseUrl.trim() === '' || provider.model.trim() === '') {
      setError('No model configured yet. Add a base URL and model in Settings → Model, then try again.')
      setView('settings')
      setSettingsPage('model')
      return
    }
    let chatId = activeChatId
    if (chatId === null) {
      const c = newChat()
      setChats((current) => [c, ...current])
      setActiveChatId(c.id)
      setUsage(recordUsage({ chats: 1 }))
      chatId = c.id
    }
    const currentTurns = chats.find((c) => c.id === chatId)?.turns ?? []
    const next = [...currentTurns, { role: 'user', content: text } as ChatTurn]
    updateChatTurns(chatId, next)
    setPrompt('')
    setSending(true)
    setError(null)
    try {
      const attached = files.filter((f) => attachedIds.includes(f.id))
      const contextParts = attached.map((f) => `\n\nFile: ${f.path}\n${f.content.slice(0, 4000)}`)
      if (active !== null && !attachedIds.includes(active.id)) {
        contextParts.push(`\n\nOpen file: ${active.path}\n${active.content.slice(0, 4000)}`)
      }
      const reply = await sendChat(provider, next, text + contextParts.join(''), mode, speed)
      updateChatTurns(chatId, [...next, { role: 'assistant', content: reply }])
      setUsage(recordUsage({ tokens: estimateTokens(text) + estimateTokens(reply), calls: 1 }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const startProject = (template: boolean) => {
    setSheet({
      kind: 'confirm',
      title: template ? 'Start from a template' : 'New project',
      body: 'Your current files will be exported as a JSON backup first, then replaced. Continue?',
      confirmLabel: template ? 'Export & start template' : 'Export & start blank',
      onConfirm: () => {
        download('sketch-project.json', projectToJson(files), 'application/json')
        setFiles(template ? starterFiles() : [])
        setActiveId(null)
        setFolderFilter(null)
        setView('files')
      },
    })
  }

  const resetAppData = () => {
    for (const key of [SETTINGS_KEY, STORE_KEY, PROVIDER_KEY, CHATS_KEY, LEGACY_CHAT_KEY, USAGE_KEY, LAST_SYNC_KEY]) {
      try {
        localStorage.removeItem(key)
      } catch { /* key already gone */ }
    }
    clearUsage()
    window.location.reload()
  }

  const contextTokens = useMemo(
    () => chat.reduce((sum, t) => sum + estimateTokens(t.content), 0),
    [chat],
  )
  const accent = ACCENTS[settings.accent] ?? '#f58a50'
  const fontPx = settings.fontSize === 'small' ? 13 : settings.fontSize === 'large' ? 17 : 15
  const editorLines = active === null ? 0 : fileLines(active)
  const stats = useMemo(() => projectStats(files), [files])
  const modePill = MODES.find((m) => m.id === mode)?.pill ?? 'Chat only'
  const attachedFiles = files.filter((f) => attachedIds.includes(f.id))

  const folders = foldersOf(files)
  const visibleFiles = files.filter((f) => {
    if (folderFilter !== null && !(f.path === folderFilter || f.path.startsWith(`${folderFilter}/`))) return false
    if (filesQuery.trim() !== '' && !f.path.toLowerCase().includes(filesQuery.trim().toLowerCase())) return false
    return true
  })
  const recentFiles = [...files].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)

  // Preview: JavaScript runs in a sandboxed frame and posts console output back.
  const previewHtml =
    previewFile === null
      ? ''
      : previewFile.path.endsWith('.js')
        ? `<!doctype html><html><body><script>
            const log = (...a) => parent.postMessage({ sketchConsole: a.map(String).join(' ') }, '*');
            console.log = log; console.error = log; console.warn = log;
            window.onerror = (m) => log('Error: ' + m);
            try { ${previewFile.content.replace(/<\/script>/gi, '<\\/script>')} } catch (e) { log('Error: ' + e.message); }
            log('— finished —');
          <\/script></body></html>`
        : previewFile.content

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { sketchConsole?: string } | null
      if (data === null || typeof data.sketchConsole !== 'string') return
      const line = data.sketchConsole
      setConsoleLines((lines) => [...lines, line])
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const settingPages: Array<{ id: SettingsPage; label: string; value?: string }> = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance', value: settings.theme === 'system' ? 'System' : settings.theme === 'light' ? 'Light' : 'Dark' },
    { id: 'model', label: 'Model provider', value: provider.model.trim() === '' ? 'Not set' : provider.model },
    { id: 'project', label: 'Project' },
    { id: 'usage', label: 'Usage', value: `${usage.calls} requests today` },
    { id: 'about', label: 'About', value: `v${APP_VERSION}` },
  ]

  const drawerChats = chats.filter((c) =>    drawerQuery.trim() === '' || c.title.toLowerCase().includes(drawerQuery.trim().toLowerCase()),
  )
  const drawerFolders = folders.filter((f) =>
    drawerQuery.trim() === '' || f.toLowerCase().includes(drawerQuery.trim().toLowerCase()),
  )
  const usageBarPct = Math.min(100, Math.round((usage.tokens / 10000) * 100))

  return (
    <div
      className="mobileApp"
      data-theme={effectiveTheme}
      style={{ '--accent': accent, '--font-size': `${fontPx}px` } as React.CSSProperties}
    >
      {drawerOpen && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}
      <aside className={`drawer ${drawerOpen ? 'drawerOpen' : ''}`} aria-label="Menu" aria-hidden={!drawerOpen}>
        <div className="drawerBrand">
          <span className="brandMark" aria-hidden="true">{'<>'}</span>
          <span className="brandName">Sketch</span>
          <button className="iconBtn" aria-label="Search chats and projects" onClick={() => setDrawerSearch((v) => !v)}>
            <Icon name="search" />
          </button>
        </div>
        {drawerSearch && (
          <input
            autoFocus
            className="drawerSearch"
            type="search"
            placeholder="Search chats and projects"
            value={drawerQuery}
            onChange={(e) => setDrawerQuery(e.target.value)}
          />
        )}
        <button className="drawerRow" onClick={startNewChat}>
          <Icon name="compose" /><span>New chat</span>
        </button>
        <button className="drawerRow" onClick={() => { setDrawerOpen(false); setSheet({ kind: 'project' }) }}>
          <Icon name="plus" /><span>New project</span>
        </button>
        <div className="drawerRow drawerRowStatic">
          <Icon name="clock" />
          <span>Daily usage</span>
          <span className="drawerRowValue">{usage.chats} chats · {formatTokens(usage.tokens)} tokens</span>
        </div>
        <div className="drawerSection">Projects</div>
        <button
          className="drawerRow drawerSub"
          onClick={() => { setFolderFilter(null); setView('files'); setDrawerOpen(false) }}
        >
          <Icon name="folder" /><span>All files</span>
          <span className="drawerRowValue">{files.length}</span>
        </button>
        {drawerFolders.map((folder) => (
          <button
            key={folder}
            className="drawerRow drawerSub"
            onClick={() => { setFolderFilter(folder); setView('files'); setDrawerOpen(false) }}
          >
            <Icon name="folder" /><span>{folder}/</span>
            <span className="drawerRowValue">{files.filter((f) => f.path.startsWith(`${folder}/`)).length}</span>
          </button>
        ))}
        {drawerFolders.length === 0 && drawerQuery.trim() !== '' && (
          <p className="drawerEmpty">No projects match.</p>
        )}
        <div className="drawerSection">Chats</div>
        {drawerChats.length === 0 && (
          <p className="drawerEmpty">{chats.length === 0 ? 'No chats yet — start one from the home screen.' : 'No chats match.'}</p>
        )}
        {drawerChats.map((c) => (
          <button key={c.id} className="drawerRow drawerSub" onClick={() => openChat(c.id)}>
            <Icon name="chat" />
            <span className="drawerChatTitle">{c.title}</span>
            <span className="drawerRowValue">{timeAgo(c.updatedAt)}</span>
          </button>
        ))}
        <div className="drawerFooter">
          <div className="usageBar">
            <div className="usageBarHead"><span>Today</span><span>{formatTokens(usage.tokens)} tokens · {usage.calls} requests</span></div>
            <div className="usageTrack"><div className="usageFill" style={{ width: `${usageBarPct}%` }} /></div>
          </div>
          <button className="iconBtn" aria-label="Settings" onClick={() => { setSettingsPage('root'); setView('settings'); setDrawerOpen(false) }}>
            <Icon name="gear" />
          </button>
        </div>
      </aside>

      <header className="appHeader">
        {view === 'editor' || view === 'preview' ? (
          <button className="iconBtn" aria-label="Back" onClick={() => setView('files')}>
            <Icon name="chevronLeft" />
          </button>
        ) : view === 'settings' && settingsPage !== 'root' ? (
          <button className="iconBtn" aria-label="Back to Settings" onClick={() => setSettingsPage('root')}>
            <Icon name="chevronLeft" />
          </button>
        ) : (
          <button className="iconBtn" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
            <Icon name="menu" />
          </button>
        )}
        <span className="appTitle">
          {view === 'chat' ? (activeChat?.title ?? 'New chat')
            : view === 'files' ? 'Files'
            : view === 'editor' ? (active?.path.split('/').pop() ?? 'Editor')
            : view === 'preview' ? 'Preview'
            : settingsPage === 'root' ? 'Settings'
            : settingsPage === 'general' ? 'General'
            : settingsPage === 'appearance' ? 'Appearance'
            : settingsPage === 'model' ? 'Model provider'
            : settingsPage === 'project' ? 'Project'
            : settingsPage === 'usage' ? 'Usage'
            : 'About'}
        </span>
        {view === 'chat' && (
          <button className="iconBtn" aria-label="New chat" onClick={startNewChat}><Icon name="compose" /></button>
        )}
        {view === 'files' && (
          <button className="iconBtn" aria-label="New file" onClick={() => setSheet({ kind: 'newFile' })}><Icon name="plus" /></button>
        )}
        {view === 'editor' && active !== null && (
          <button className="iconBtn" aria-label="Preview this file" onClick={() => { setPreviewId(active.id); setView('preview') }}><Icon name="eye" /></button>
        )}
        {view === 'settings' && settingsPage === 'root' && (
          <button className="iconBtn" aria-label="Close settings" onClick={() => setView('chat')}><Icon name="x" /></button>
        )}
      </header>

      <main className="appMain">
        {view === 'chat' && (
          <section aria-label="Agent chat" className="chatTab">
            <div className="chatLog" role="log" aria-label="Agent conversation">
              {chat.length === 0 && (
                <div className="chatHero">
                  <div className="heroMark" aria-hidden="true">{'<>'}</div>
                  <button className="modePill" onClick={() => setSheet({ kind: 'mode' })}>
                    <Icon name="chat" size={16} /> {modePill} <Icon name="chevronDown" size={16} />
                  </button>
                  <p className="heroHint">Ask about your code, or have Sketch propose a change you apply with one tap.</p>
                  {provider.model.trim() === '' && (
                    <p className="warning">No model configured yet — tap the model name in the composer to set one up.</p>
                  )}
                </div>
              )}
              {chat.map((turn, i) => (
                <div key={i} className={turn.role === 'user' ? 'chatUser' : 'chatAgent'}>
                  <div className="chatName">{turn.role === 'user' ? 'You' : 'Sketch'}</div>
                  <div className="chatText">{turn.content}</div>
                  {turn.role === 'assistant' && firstCodeBlock(turn.content) !== null && (
                    <button className="secondaryBtn" onClick={() => setSheet({ kind: 'apply', reply: turn.content })}>Apply code to a file</button>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            {error !== null && <div className="errorBox" role="alert">{error}</div>}
            <div className="composerBox">
              <div className="composerTop">
                <button className="modePill modePillSmall" onClick={() => setSheet({ kind: 'mode' })}>
                  <Icon name="chat" size={16} /> {modePill} <Icon name="chevronDown" size={16} />
                </button>
                <div className="speedSeg" dir="ltr" role="radiogroup" aria-label="Speed">
                  {SPEEDS.map((s) => (
                    <button key={s.id} type="button" role="radio" aria-checked={speed === s.id} className={`segBtn ${speed === s.id ? 'segOn' : ''}`} onClick={() => setSpeed(s.id)}>
                      {s.label}
                    </button>
                  ))}
                </div>
                <span className="composerContext">Context ≈ {contextTokens >= 1000 ? `${(contextTokens / 1000).toFixed(1)}k` : contextTokens} tokens · last {maxTurns(speed)} sent</span>
              </div>
              {attachedFiles.length > 0 && (
                <div className="attachChips">
                  {attachedFiles.map((f) => (
                    <span key={f.id} className="attachChip">
                      <Icon name="file" size={14} /> {f.path.split('/').pop()}
                      <button aria-label={`Remove ${f.path} from context`} onClick={() => setAttachedIds((ids) => ids.filter((id) => id !== f.id))}><Icon name="x" size={14} /></button>
                    </span>
                  ))}
                </div>
              )}
              <div className="composer">
                <textarea
                  aria-label="Message the agent"
                  placeholder={active === null ? 'Ask Sketch…' : `Ask about ${active.path}…`}
                  value={prompt}
                  rows={2}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <div className="composerRow">
                  <button
                    className="modelBtn"
                    onClick={() => { setSettingsPage('model'); setView('settings') }}
                    title={provider.model.trim() === '' ? 'Set up a model provider' : `${provider.model} — tap to change`}
                  >
                    {provider.model.trim() === '' ? 'Set up a model' : provider.model} <Icon name="chevronDown" size={14} />
                  </button>
                  <button className="iconBtn composerPlus" aria-label="Attach a file to this chat" onClick={() => setSheet({ kind: 'attach' })}>
                    <Icon name="plus" />
                  </button>
                  <button className="sendBtn" aria-label="Send" disabled={sending || prompt.trim() === ''} onClick={() => void send()}>
                    <Icon name="send" />
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {view === 'files' && (
          <section aria-label="Files">
            <div className="searchField">
              <Icon name="search" size={18} />
              <input
                type="search"
                placeholder="Search files"
                aria-label="Search files"
                value={filesQuery}
                onChange={(e) => setFilesQuery(e.target.value)}
              />
              {filesQuery !== '' && (
                <button className="iconBtn iconBtnSmall" aria-label="Clear search" onClick={() => setFilesQuery('')}><Icon name="x" size={16} /></button>
              )}
            </div>
            {folderFilter !== null && (
              <button className="filterChip" onClick={() => setFolderFilter(null)}>
                <Icon name="folder" size={14} /> {folderFilter}/ <Icon name="x" size={14} />
              </button>
            )}
            {visibleFiles.length === 0 && (
              <div className="emptyState">
                <h2>{files.length === 0 ? 'No files yet' : 'Nothing matches'}</h2>
                <p>{files.length === 0 ? 'Start with a template, or create your first file.' : 'Try a different search, or clear the folder filter.'}</p>
                {files.length === 0 && (
                  <div className="rowBtns rowBtnsCenter">
                    <button className="primaryBtn" onClick={() => setSheet({ kind: 'newFile' })}>New file</button>
                    <button className="secondaryBtn" onClick={() => startProject(true)}>Start from a template</button>
                  </div>
                )}
              </div>
            )}
            {foldersOf(visibleFiles).map((folder) => (
              <div key={folder} className="folderGroup">
                <button
                  className="folderHead"
                  aria-expanded={!collapsed[folder]}
                  onClick={() => setCollapsed((c) => ({ ...c, [folder]: !c[folder] }))}
                >
                  <Icon name={collapsed[folder] ? 'chevronRight' : 'chevronDown'} size={16} />
                  <Icon name="folder" size={18} />
                  <span>{folder}/</span>
                  <span className="folderCount">{visibleFiles.filter((f) => f.path.startsWith(`${folder}/`)).length}</span>
                </button>
                {!collapsed[folder] && visibleFiles
                  .filter((f) => f.path.startsWith(`${folder}/`) && !f.path.slice(folder.length + 1).includes('/'))
                  .map((f) => (
                    <FileRow key={f.id} file={f} onOpen={() => openFile(f)} onMenu={() => setSheet({ kind: 'file', file: f })} />
                  ))}
              </div>
            ))}
            {visibleFiles.filter((f) => !f.path.includes('/')).map((f) => (
              <FileRow key={f.id} file={f} onOpen={() => openFile(f)} onMenu={() => setSheet({ kind: 'file', file: f })} />
            ))}
            {files.length > 0 && (
              <div className="statsCard">
                <div className="statsRow">
                  <span><strong>{stats.files}</strong> files</span>
                  <span><strong>{stats.lines}</strong> lines</span>
                  <span><strong>{formatBytes(stats.bytes)}</strong> total</span>
                </div>
                <p className="hint">Stored on this phone. Export the project from Settings → Project to keep a copy.</p>
                {recentFiles.length > 0 && (
                  <>
                    <div className="statsLabel">Recent</div>
                    {recentFiles.map((f) => (
                      <button key={f.id} className="recentRow" onClick={() => openFile(f)}>
                        <FileBadge path={f.path} />
                        <span className="recentName">{f.path}</span>
                        <span className="recentMeta">{timeAgo(f.updatedAt)}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {view === 'editor' && (
          <section aria-label="Editor" className="editorTab">
            {active === null ? (
              <div className="emptyState">
                <h2>No file open</h2>
                <p>Pick a file from the Files tab to start editing.</p>
                <button className="primaryBtn" onClick={() => setView('files')}>Open Files</button>
              </div>
            ) : (
              <>
                <div className="editorHead">
                  <span className="editorPath">{active.path}</span>
                  <span className="editorMeta">{editorLines} lines · Saved on this phone</span>
                </div>
                <div className="editorWrap">
                  <pre className="lineNumbers" aria-hidden="true">{Array.from({ length: editorLines }, (_, i) => i + 1).join('\n')}</pre>
                  <textarea
                    className="editor"
                    aria-label={`Editing ${active.path}`}
                    value={active.content}
                    onChange={(e) => setFiles((current) => updateFile(current, active.id, e.target.value))}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                </div>
              </>
            )}
          </section>
        )}

        {view === 'preview' && (
          <section aria-label="Preview">
            <div className="sectionHead">
              <h2>Preview</h2>
              <select
                aria-label="File to preview"
                value={previewFile?.id ?? ''}
                onChange={(e) => {
                  setPreviewId(e.target.value)
                  setConsoleLines([])
                }}
              >
                {files.map((f) => (
                  <option key={f.id} value={f.id}>{f.path}</option>
                ))}
              </select>
            </div>
            <p className="hint">Runs on your phone, in a sandboxed frame. HTML renders live; JavaScript console output appears below. There is no terminal on mobile — commands run in the desktop app.</p>
            {previewFile !== null && (
              <iframe title={`Preview of ${previewFile.path}`} className="previewFrame" sandbox="allow-scripts" srcDoc={previewHtml} />
            )}
            {previewFile?.path.endsWith('.js') && (
              <div className="consoleBox" aria-label="Console output">
                <div className="consoleTitle">Console</div>
                {consoleLines.length === 0 ? <div className="consoleLine">Nothing logged yet.</div> : consoleLines.map((line, i) => <div key={i} className="consoleLine">{line}</div>)}
                <button className="secondaryBtn" onClick={() => setConsoleLines([])}>Clear console</button>
              </div>
            )}
          </section>
        )}

        {view === 'settings' && (
          <section aria-label="Settings">
            {settingsPage === 'root' && (
              <>
                <div className="profileCard">
                  <span className="profileAvatar" aria-hidden="true">{'<>'}</span>
                  <span className="profileText">
                    <span className="profileName">Local profile</span>
                    <span className="profileSub">On this phone · no cloud account</span>
                  </span>
                </div>
                <div className="searchField">
                  <Icon name="search" size={18} />
                  <input
                    type="search"
                    placeholder="Search settings"
                    aria-label="Search settings"
                    value={settingsQuery}
                    onChange={(e) => setSettingsQuery(e.target.value)}
                  />
                  {settingsQuery !== '' && (
                    <button className="iconBtn iconBtnSmall" aria-label="Clear search" onClick={() => setSettingsQuery('')}><Icon name="x" size={16} /></button>
                  )}
                </div>
                <div className="settingsList">
                  {settingPages.filter((p) => settingsQuery.trim() === '' || p.label.toLowerCase().includes(settingsQuery.trim().toLowerCase())).map((p) => (
                    <button key={p.id} className="settingsRow" onClick={() => setSettingsPage(p.id)}>
                      <span>{p.label}</span>
                      {p.value !== undefined && <span className="settingsRowValue">{p.value}</span>}
                      <Icon name="chevronRight" size={18} />
                    </button>
                  ))}
                  {settingPages.filter((p) => settingsQuery.trim() !== '' && !p.label.toLowerCase().includes(settingsQuery.trim().toLowerCase())).length === settingPages.length && (
                    <p className="hint">No settings match that search.</p>
                  )}
                </div>
                <button
                  className="dangerBtn blockBtn"
                  onClick={() => setSheet({
                    kind: 'confirm',
                    title: 'Reset app data',
                    body: 'Delete every file, chat, model setting and usage record stored on this phone? Export your project first if you want to keep a copy.',
                    confirmLabel: 'Reset everything',
                    onConfirm: resetAppData,
                  })}
                >
                  Reset app data
                </button>
              </>
            )}
            {settingsPage === 'general' && (
              <div className="settingsGroup">
                <h2>General</h2>
                <div className="fieldLabel">Text size</div>
                <div className="chipRow" role="group" aria-label="Text size">
                  {(['small', 'medium', 'large'] as const).map((size) => (
                    <button key={size} type="button" className={`chip ${settings.fontSize === size ? 'chipOn' : ''}`} onClick={() => setSettings({ ...settings, fontSize: size })}>
                      {size === 'small' ? 'Small' : size === 'large' ? 'Large' : 'Medium'}
                    </button>
                  ))}
                </div>
                <p className="hint">In chat, press Enter to send and Shift + Enter for a new line. Files and chats stay on this phone unless you export them.</p>
              </div>
            )}
            {settingsPage === 'appearance' && (
              <div className="settingsGroup">
                <h2>Appearance</h2>
                <div className="fieldLabel">Theme</div>
                <div className="chipRow" role="group" aria-label="Theme">
                  {(['system', 'dark', 'light'] as const).map((theme) => (
                    <button key={theme} type="button" className={`chip ${settings.theme === theme ? 'chipOn' : ''}`} onClick={() => setSettings({ ...settings, theme })}>
                      {theme === 'system' ? 'System' : theme === 'dark' ? 'Dark' : 'Light'}
                    </button>
                  ))}
                </div>
                <p className="hint">System follows your phone&apos;s dark / light setting.</p>
                <div className="fieldLabel">Accent</div>
                <div className="chipRow" role="group" aria-label="Accent colour">
                  {Object.keys(ACCENTS).map((name) => (
                    <button key={name} type="button" className={`chip ${settings.accent === name ? 'chipOn' : ''}`} onClick={() => setSettings({ ...settings, accent: name })}>
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {settingsPage === 'model' && (
              <div className="settingsGroup">
                <h2>Model provider</h2>
                <p className="hint">The agent calls this provider directly from your phone. Your key stays in this phone&apos;s browser storage.</p>
                <label className="field">Base URL
                  <input type="url" inputMode="url" placeholder="https://api.openai.com/v1" value={provider.baseUrl} onChange={(e) => setProvider({ ...provider, baseUrl: e.target.value })} />
                </label>
                <label className="field">Model
                  <input type="text" placeholder="gpt-4o-mini" value={provider.model} onChange={(e) => setProvider({ ...provider, model: e.target.value })} />
                </label>
                <label className="field">API key
                  <input type="password" autoComplete="off" placeholder="sk-…" value={provider.apiKey} onChange={(e) => setProvider({ ...provider, apiKey: e.target.value })} />
                </label>
                <button className="primaryBtn blockBtn" onClick={() => { saveProvider(provider); setError(null); setView('chat'); setSettingsPage('root') }}>Save model settings</button>
              </div>
            )}
            {settingsPage === 'project' && (
              <>
                <div className="settingsGroup">
                  <h2>Project</h2>
                  <div className="rowBtns">
                    <button className="secondaryBtn" onClick={() => download('sketch-project.json', projectToJson(files), 'application/json')}>
                      <Icon name="download" size={16} /> Export project
                    </button>
                    <label className="secondaryBtn fileBtn"><Icon name="upload" size={16} /> Import project
                      <input type="file" accept=".json,application/json" hidden onChange={(e) => {
                        const file = e.target.files?.[0]
                        e.target.value = ''
                        if (file === undefined) return
                        void file.text().then((text) => {
                          const imported = projectFromJson(text)
                          if (imported === null) setError('That file is not a Sketch mobile project export.')
                          else setFiles(imported)
                        })
                      }} />
                    </label>
                  </div>
                  {error !== null && <div className="errorBox" role="alert">{error}</div>}
                </div>
                <div className="settingsGroup">
                  <h2>Sync with desktop</h2>
                  <p className="hint">Sync is a file bundle, not live sync: export a v2 bundle here, move it to the desktop (or the other way round), and import it. Newer files win; equal timestamps with different content keep the file already on this phone and are reported.</p>
                  <p className="hint" role="status">
                    {lastSync === null
                      ? 'Never synced yet.'
                      : `Last sync: ${lastSync.fileCount} files · ${new Date(lastSync.exportedAt).toLocaleString()}`}
                  </p>
                  <div className="rowBtns">
                    <button className="secondaryBtn" onClick={() => {
                      void createSyncBundle({ name: 'Sketch mobile project', files }).then((bundle) => {
                        download(`sketch-sync-${bundle.exportedAt.slice(0, 10)}.json`, syncBundleToJson(bundle), 'application/json')
                        const info: LastSyncInfo = { exportedAt: bundle.exportedAt, fileCount: bundle.manifest.fileCount }
                        setLastSync(info)
                        setLastSyncState(info)
                        setError(null)
                      }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                    }}>Export sync bundle (v2)</button>
                    <label className="secondaryBtn fileBtn">Import sync bundle
                      <input type="file" accept=".json,application/json" hidden onChange={(e) => {
                        const file = e.target.files?.[0]
                        e.target.value = ''
                        if (file === undefined) return
                        void file.text().then(async (text) => {
                          const result = await validateSyncBundle(parseSyncBundleJson(text))
                          if (!result.ok || result.bundle === undefined) {
                            setError(`Sync bundle rejected: ${result.errors.join('; ')}`)
                            return
                          }
                          const applied = applySyncBundle(result.bundle, files)
                          setFiles(applied.merged)
                          const info: LastSyncInfo = { exportedAt: result.bundle.exportedAt, fileCount: result.bundle.manifest.fileCount }
                          setLastSync(info)
                          setLastSyncState(info)
                          if (applied.conflicts.length > 0) {
                            setError(`Sync imported: ${applied.added.length} added, ${applied.updated.length} updated. Conflicts kept the file already on this phone: ${applied.conflicts.map((c) => c.path).join(', ')}`)
                          } else {
                            setError(null)
                          }
                        })
                      }} />
                    </label>
                  </div>
                </div>
                <button
                  className="dangerBtn blockBtn"
                  onClick={() => setSheet({
                    kind: 'confirm',
                    title: 'Delete all files',
                    body: 'Delete every file in this project on this phone? Export first if you want to keep a copy.',
                    confirmLabel: 'Delete all files',
                    onConfirm: () => { setFiles([]); setActiveId(null) },
                  })}
                >
                  Delete all files
                </button>
              </>
            )}
            {settingsPage === 'usage' && (
              <div className="settingsGroup">
                <h2>Usage</h2>
                <p className="hint">Counted on this phone only. There is no cloud quota — these are the requests your phone actually sent to your own provider.</p>
                <dl className="statList">
                  <div><dt>Files</dt><dd>{stats.files}</dd></div>
                  <div><dt>Lines of code</dt><dd>{stats.lines}</dd></div>
                  <div><dt>Saved chats</dt><dd>{chats.length}</dd></div>
                  <div><dt>Chats today</dt><dd>{usage.chats}</dd></div>
                  <div><dt>Tokens today</dt><dd>{formatTokens(usage.tokens)}</dd></div>
                  <div><dt>Provider requests today</dt><dd>{usage.calls}</dd></div>
                  <div><dt>Last sync</dt><dd>{lastSync === null ? 'Never' : new Date(lastSync.exportedAt).toLocaleString()}</dd></div>
                </dl>
              </div>
            )}
            {settingsPage === 'about' && (
              <div className="settingsGroup">
                <h2>About</h2>
                <p className="hint">Sketch Mobile {APP_VERSION} — code on your phone. Files, chats and your model key stay on this phone unless you export them. The desktop app runs terminals, git and builds.</p>
                <p className="hint">Design: Asta — charcoal #141414, ember #f58a50.</p>
              </div>
            )}
          </section>
        )}
      </main>

      {sheet !== null && sheet.kind === 'file' && (
        <Sheet title={sheet.file.path} onClose={() => setSheet(null)}>
          <SheetRow icon="pencil" label="Open in Editor" onClick={() => { openFile(sheet.file); setSheet(null) }} />
          <SheetRow icon="eye" label="Preview" onClick={() => { setPreviewId(sheet.file.id); setView('preview'); setSheet(null) }} />
          <SheetRow icon="compose" label="Rename…" onClick={() => setSheet({ kind: 'rename', file: sheet.file })} />
          <SheetRow icon="trash" label="Delete…" danger onClick={() => setSheet({ kind: 'delete', file: sheet.file })} />
        </Sheet>
      )}
      {sheet !== null && sheet.kind === 'newFile' && (
        <NewFileSheet files={files} onCreate={(path) => setFiles((current) => createFile(current, path))} onClose={() => setSheet(null)} />
      )}
      {sheet !== null && sheet.kind === 'rename' && (
        <RenameSheet file={sheet.file} files={files} onRename={(path) => setFiles((current) => renameFile(current, sheet.file.id, path))} onClose={() => setSheet(null)} />
      )}
      {sheet !== null && sheet.kind === 'delete' && (
        <DeleteSheet
          file={sheet.file}
          onDelete={() => {
            setFiles((current) => deleteFile(current, sheet.file.id))
            if (activeId === sheet.file.id) setActiveId(null)
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet !== null && sheet.kind === 'project' && (
        <ProjectSheet
          onBlank={() => { setSheet(null); startProject(false) }}
          onTemplate={() => { setSheet(null); startProject(true) }}
          onChatOnly={() => { setSheet(null); startNewChat() }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet !== null && sheet.kind === 'mode' && (
        <ModeSheet mode={mode} speed={speed} onMode={setMode} onSpeed={setSpeed} onClose={() => setSheet(null)} />
      )}
      {sheet !== null && sheet.kind === 'attach' && (
        <AttachSheet
          files={files}
          attached={attachedIds}
          onToggle={(id) => setAttachedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet !== null && sheet.kind === 'apply' && (
        <ApplySheet reply={sheet.reply} onApply={(path) => applyCodeTo(sheet.reply, path)} onClose={() => setSheet(null)} />
      )}
      {sheet !== null && sheet.kind === 'confirm' && (
        <ConfirmSheet title={sheet.title} body={sheet.body} confirmLabel={sheet.confirmLabel} onConfirm={sheet.onConfirm} onClose={() => setSheet(null)} />
      )}
    </div>
  )
}

function FileRow({ file, onOpen, onMenu }: { file: MobileFile; onOpen: () => void; onMenu: () => void }): React.JSX.Element {
  return (
    <div className="fileRow">
      <button className="fileName" onClick={onOpen} aria-label={`Open ${file.path}`}>
        <FileBadge path={file.path} />
        <span className="fileNameText">
          <span className="fileNameMain">{file.path.split('/').pop()}</span>
          <span className="fileNameMeta">{fileLines(file)} lines · {formatBytes(fileBytes(file))} · {timeAgo(file.updatedAt)}</span>
        </span>
      </button>
      <button className="iconBtn" aria-label={`Options for ${file.path}`} onClick={onMenu}><Icon name="more" /></button>
    </div>
  )
}
