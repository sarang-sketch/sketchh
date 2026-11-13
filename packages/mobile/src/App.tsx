// Sketch on your phone.
//
// Tabs: Files, Editor, Agent, Preview, Settings. Files live in this phone's
// browser storage; the agent talks to a provider the user configures; Preview
// runs HTML/JavaScript in a sandboxed frame on the phone. There is no local
// terminal on mobile — Preview says so plainly instead of faking one.

import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  createFile, deleteFile, foldersOf, loadFiles, projectFromJson, projectToJson, renameFile, saveFiles, updateFile,
  type MobileFile,
} from './store'
import {
  estimateTokens, firstCodeBlock, loadProvider, maxTurns, saveProvider, sendChat,
  type AgentMode, type AgentSpeed, type ChatTurn, type ProviderConfig,
} from './agent'
import {
  applySyncBundle, createSyncBundle, getLastSync, parseSyncBundleJson, setLastSync, syncBundleToJson, validateSyncBundle,
  type LastSyncInfo,
} from './sync'

type Tab = 'files' | 'editor' | 'agent' | 'preview' | 'settings'

const ACCENTS: Record<string, string> = { Ember: '#f58a50', Sky: '#38bdf8', Mint: '#34d399' }

interface Settings {
  theme: 'dark' | 'light'
  accent: string
  fontSize: 'small' | 'medium' | 'large'
}

const SETTINGS_KEY = 'sketch.mobile.settings.v1'
const CHAT_KEY = 'sketch.mobile.chat.v1'

function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null
    if (parsed === null) return { theme: 'dark', accent: 'Ember', fontSize: 'medium' }
    return {
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      accent: parsed.accent !== undefined && parsed.accent in ACCENTS ? parsed.accent : 'Ember',
      fontSize: parsed.fontSize === 'small' || parsed.fontSize === 'large' ? parsed.fontSize : 'medium',
    }
  } catch {
    return { theme: 'dark', accent: 'Ember', fontSize: 'medium' }
  }
}

function loadChat(): ChatTurn[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_KEY) ?? '[]') as ChatTurn[]
    return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.content === 'string') : []
  } catch {
    return []
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

const MODES: Array<{ id: AgentMode; label: string; hint: string }> = [
  { id: 'ask', label: 'Ask', hint: 'Read-only answers — no file edits proposed.' },
  { id: 'agent', label: 'Agent', hint: 'Proposes code you apply with one tap.' },
  { id: 'auto', label: 'Auto', hint: 'Works through the request in one longer reply.' },
]

const SPEEDS: Array<{ id: AgentSpeed; label: string; hint: string }> = [
  { id: 'normal', label: 'Normal', hint: 'Full reply: last 12 turns of context.' },
  { id: 'turbo', label: 'Turbo', hint: 'Faster and lighter: last 6 turns of context.' },
]

export default function App(): React.JSX.Element {
  const [files, setFiles] = useState<MobileFile[]>(() => loadFiles())
  const [tab, setTab] = useState<Tab>('files')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [provider, setProvider] = useState<ProviderConfig>(() => loadProvider())
  const [chat, setChat] = useState<ChatTurn[]>(loadChat)
  const [mode, setMode] = useState<AgentMode>('agent')
  const [speed, setSpeed] = useState<AgentSpeed>('normal')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [consoleLines, setConsoleLines] = useState<string[]>([])
  const [lastSync, setLastSyncState] = useState<LastSyncInfo | null>(() => getLastSync())
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  const active = files.find((f) => f.id === activeId) ?? null
  const previewFile = files.find((f) => f.id === previewId) ?? files.find((f) => f.path.endsWith('.html')) ?? null

  useEffect(() => saveFiles(files), [files])
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch { /* settings last for this session only */ }
  }, [settings])
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(chat))
    } catch { /* chat lasts for this session only */ }
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat])

  const openFile = (file: MobileFile) => {
    setActiveId(file.id)
    setTab('editor')
  }

  const applyCode = (reply: string) => {
    const block = firstCodeBlock(reply)
    if (block === null) return
    const path = block.path ?? window.prompt('Save this code as which file? (e.g. src/app.js)', 'src/app.js')
    if (path === null || path.trim() === '') return
    const clean = path.trim().replace(/^\/+/, '')
    setFiles((current) => {
      const existing = current.find((f) => f.path === clean)
      if (existing) return updateFile(current, existing.id, block.code)
      return [...current, { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, path: clean, content: block.code, updatedAt: Date.now() }]
    })
    setError(null)
  }

  const send = async () => {
    const text = prompt.trim()
    if (text === '' || sending) return
    if (provider.baseUrl.trim() === '' || provider.model.trim() === '') {
      setError('No model configured yet. Add a base URL and model in Settings → Model, then try again.')
      setTab('settings')
      return
    }
    const next = [...chat, { role: 'user', content: text } as ChatTurn]
    setChat(next)
    setPrompt('')
    setSending(true)
    setError(null)
    try {
      const context = active === null ? '' : `\n\nOpen file: ${active.path}\n${active.content.slice(0, 4000)}`
      const reply = await sendChat(provider, next, text + context, mode, speed)
      setChat([...next, { role: 'assistant', content: reply }])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const contextTokens = useMemo(
    () => chat.reduce((sum, t) => sum + estimateTokens(t.content), 0),
    [chat],
  )
  const accent = ACCENTS[settings.accent] ?? '#f58a50'
  const fontPx = settings.fontSize === 'small' ? 13 : settings.fontSize === 'large' ? 17 : 15
  const editorLines = active === null ? 0 : active.content.split('\n').length

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

  return (
    <div
      className="mobileApp"
      data-theme={settings.theme}
      style={{ '--accent': accent, '--font-size': `${fontPx}px` } as React.CSSProperties}
    >
      <header className="appHeader">
        <span className="appMark" aria-hidden="true">{'<>'}</span>
        <span className="appTitle">Sketch</span>
        <span className="appSubtitle">{tab === 'agent' ? `Context ≈ ${contextTokens >= 1000 ? `${(contextTokens / 1000).toFixed(1)}k` : contextTokens} tokens · last ${maxTurns(speed)} sent` : 'Code on your phone'}</span>
      </header>

      <main className="appMain">
        {tab === 'files' && (
          <section aria-label="Files">
            <div className="sectionHead">
              <h1>Files</h1>
              <button
                className="primaryBtn"
                onClick={() => {
                  const name = window.prompt('New file name (e.g. src/app.js)', 'untitled.txt')
                  if (name !== null) setFiles((current) => createFile(current, name))
                }}
              >
                + New file
              </button>
            </div>
            <p className="hint">Stored on this phone. Export the project from Settings to keep a copy.</p>
            {foldersOf(files).map((folder) => (
              <div key={folder} className="folderGroup">
                <div className="folderName">{folder}/</div>
                {files.filter((f) => f.path.startsWith(`${folder}/`) && !f.path.slice(folder.length + 1).includes('/')).map((f) => (
                  <FileRow key={f.id} file={f} onOpen={() => openFile(f)} onRename={() => {
                    const name = window.prompt('Rename file', f.path)
                    if (name !== null) setFiles((current) => renameFile(current, f.id, name))
                  }} onDelete={() => {
                    if (window.confirm(`Delete ${f.path}? This cannot be undone.`)) {
                      setFiles((current) => deleteFile(current, f.id))
                      if (activeId === f.id) setActiveId(null)
                    }
                  }} />
                ))}
              </div>
            ))}
            {files.filter((f) => !f.path.includes('/')).map((f) => (
              <FileRow key={f.id} file={f} onOpen={() => openFile(f)} onRename={() => {
                const name = window.prompt('Rename file', f.path)
                if (name !== null) setFiles((current) => renameFile(current, f.id, name))
              }} onDelete={() => {
                if (window.confirm(`Delete ${f.path}? This cannot be undone.`)) {
                  setFiles((current) => deleteFile(current, f.id))
                  if (activeId === f.id) setActiveId(null)
                }
              }} />
            ))}
          </section>
        )}

        {tab === 'editor' && (
          <section aria-label="Editor" className="editorTab">
            {active === null ? (
              <div className="emptyState">
                <h1>No file open</h1>
                <p>Pick a file from the Files tab to start editing.</p>
                <button className="primaryBtn" onClick={() => setTab('files')}>Open Files</button>
              </div>
            ) : (
              <>
                <div className="editorHead">
                  <span className="editorPath">{active.path}</span>
                  <span className="editorMeta">{editorLines} lines · saved on this phone</span>
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

        {tab === 'agent' && (
          <section aria-label="Agent chat" className="agentTab">
            <div className="chatLog" role="log" aria-label="Agent conversation">
              {chat.length === 0 && (
                <div className="emptyState">
                  <h1>What should we build?</h1>
                  <p>Ask about your code, or have the agent propose a change you apply with one tap.</p>
                  {provider.model.trim() === '' && <p className="warning">No model configured yet — add one in Settings → Model.</p>}
                </div>
              )}
              {chat.map((turn, i) => (
                <div key={i} className={turn.role === 'user' ? 'chatUser' : 'chatAgent'}>
                  <div className="chatName">{turn.role === 'user' ? 'You' : 'Sketch'}</div>
                  <div className="chatText">{turn.content}</div>
                  {turn.role === 'assistant' && firstCodeBlock(turn.content) !== null && (
                    <button className="secondaryBtn" onClick={() => applyCode(turn.content)}>Apply code to a file</button>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            {error !== null && <div className="errorBox" role="alert">{error}</div>}
            <div className="composer">
              <div className="speedRow" dir="ltr" role="radiogroup" aria-label="Speed">
                {SPEEDS.map((s) => (
                  <button key={s.id} type="button" role="radio" aria-checked={speed === s.id} className={`pillBtn ${speed === s.id ? 'pillOn' : ''}`} title={s.hint} onClick={() => setSpeed(s.id)}>
                    {s.label}
                  </button>
                ))}
                <span className="speedDivider" aria-hidden="true" />
                {MODES.map((m) => (
                  <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={`pillBtn ${mode === m.id ? 'pillOn' : ''}`} title={m.hint} onClick={() => setMode(m.id)}>
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="composerRow">
                <textarea
                  aria-label="Message the agent"
                  placeholder={active === null ? 'Ask the agent…' : `Ask about ${active.path}…`}
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
                <button className="sendBtn" aria-label="Send" disabled={sending || prompt.trim() === ''} onClick={() => void send()}>
                  {sending ? '…' : '↑'}
                </button>
              </div>
              <div className="composerMeta">
                {provider.model.trim() === '' ? 'No model configured' : `Model: ${provider.model}`} · {speed === 'turbo' ? 'Turbo — last 6 turns' : 'Normal — last 12 turns'}
              </div>
            </div>
          </section>
        )}

        {tab === 'preview' && (
          <section aria-label="Preview">
            <div className="sectionHead">
              <h1>Preview</h1>
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

        {tab === 'settings' && (
          <section aria-label="Settings">
            <h1>Settings</h1>
            <div className="settingsGroup">
              <h2>Appearance</h2>
              <label className="field">Theme
                <select value={settings.theme} onChange={(e) => setSettings({ ...settings, theme: e.target.value as Settings['theme'] })}>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <label className="field">Accent
                <select value={settings.accent} onChange={(e) => setSettings({ ...settings, accent: e.target.value })}>
                  {Object.keys(ACCENTS).map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="field">Text size
                <select value={settings.fontSize} onChange={(e) => setSettings({ ...settings, fontSize: e.target.value as Settings['fontSize'] })}>
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
              </label>
            </div>
            <div className="settingsGroup">
              <h2>Model</h2>
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
              <button className="primaryBtn" onClick={() => { saveProvider(provider); setError(null); setTab('agent') }}>Save model settings</button>
            </div>
            <div className="settingsGroup">
              <h2>Project</h2>
              <div className="rowBtns">
                <button className="secondaryBtn" onClick={() => download('sketch-project.json', projectToJson(files), 'application/json')}>Export project</button>
                <label className="secondaryBtn fileBtn">Import project
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
              <button className="dangerBtn" onClick={() => {
                if (window.confirm('Delete every file in this project on this phone? Export first if you want to keep a copy.')) {
                  setFiles([])
                  setActiveId(null)
                }
              }}>Delete all files</button>
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
            <p className="hint">Sketch Mobile 0.1.0 — files and chats stay on this phone unless you export them. The desktop app runs terminals, git and builds.</p>
          </section>
        )}
      </main>

      <nav className="bottomNav" aria-label="Sections">
        {([
          { id: 'files', label: 'Files' },
          { id: 'editor', label: 'Editor' },
          { id: 'agent', label: 'Agent' },
          { id: 'preview', label: 'Preview' },
          { id: 'settings', label: 'Settings' },
        ] as const).map((item) => (
          <button key={item.id} type="button" className={`navBtn ${tab === item.id ? 'navOn' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  )
}

function FileRow({ file, onOpen, onRename, onDelete }: { file: MobileFile; onOpen: () => void; onRename: () => void; onDelete: () => void }): React.JSX.Element {
  return (
    <div className="fileRow">
      <button className="fileName" onClick={onOpen} aria-label={`Open ${file.path}`}>
        <span className="fileIcon" aria-hidden="true">{file.path.endsWith('.md') ? 'M' : file.path.endsWith('.html') ? '<>' : file.path.endsWith('.js') ? 'JS' : '≡'}</span>
        {file.path.split('/').pop()}
      </button>
      <button className="iconBtn" aria-label={`Rename ${file.path}`} onClick={onRename}>✎</button>
      <button className="iconBtn" aria-label={`Delete ${file.path}`} onClick={onDelete}>🗑</button>
    </div>
  )
}
