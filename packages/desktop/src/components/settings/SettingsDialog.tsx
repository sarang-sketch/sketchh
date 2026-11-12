// Settings, as a dialog both surfaces can open.
//
// Before this, the only settings surface was a side panel in the Code view: from
// Cowork, the model picker's "Provider settings" button dispatched a panel change to
// a view that was not on screen, so a first-time user staring at "No model
// configured" had no visible way to configure one.

import { useEffect, useRef, useState } from 'react'
import { ProviderSettings } from '../../panels/ProviderSettings'
import { useEngineStatus, useSketchClient } from '../../lib/ClientProvider'
import {
  useAppDispatch,
  useAppState,
  DEFAULT_AGENT_PREFS,
  DEFAULT_EDITOR_SETTINGS,
  type AgentPrefs,
  type EditorSettings,
  type SettingsTab,
} from '../../state/AppState'
import { forgetTrustedFolder, trustedFolders } from '../../terminal/trust'
import { useConfirm } from '../ConfirmDialog'
import { openExternal } from '../Markdown'
import { Code, Copy, Cpu, Download, ExternalLink, Info, Key, Keyboard, Lock, Palette, Shield, X } from '../Icons'
import { AppearanceSettings } from './AppearanceSettings'
import { SHORTCUTS } from '../../shortcuts'
import {
  serializeSettingsExport,
  parseSettingsImport,
  diffSettings,
  type SettingsChange,
} from '../../settingsIo'
import { LocalModels } from './LocalModels'
import { PrivacySettings } from './PrivacySettings'
import styles from './SettingsDialog.module.css'

// B-009: every tab's name matches its content, and nothing appears under two names.
// Was: a single 'about' tab mislabelled "Shortcuts & privacy" that held a "Privacy &
// safety" section AND the keyboard reference — two names for privacy, and shortcuts
// buried under "privacy". Now: Privacy owns all privacy; Shortcuts owns the reference;
// About owns version, engine status, where data lives, and settings export/import.
const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Cpu }> = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'models', label: 'Models', icon: Key },
  { id: 'agent', label: 'Agent', icon: Cpu },
  { id: 'editor', label: 'Editor', icon: Code },
  { id: 'privacy', label: 'Privacy', icon: Lock },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'about', label: 'About', icon: Info },
]

const REPO_URL = 'https://github.com/sarang-sketch/sketch'

/**
 * Restore-defaults that asks first when it would discard non-default values (invariant
 * 3). `isDefault` decides whether anything would be lost; if nothing differs the reset
 * is a no-op and skips the prompt. No reset here ever touches API keys or provider
 * config — these sections hold only UI preferences.
 */
function useResetSection() {
  const confirm = useConfirm()
  return async (section: string, isDefault: boolean, apply: () => void) => {
    if (isDefault) return // already at defaults: nothing to discard, nothing to ask.
    const answer = await confirm({
      title: `Restore ${section} defaults?`,
      message: `This resets every ${section} setting to its default and discards your current values. It does not touch your API keys or connected providers.`,
      buttons: [
        { id: 'reset', label: 'Restore defaults', kind: 'danger' },
        { id: 'cancel', label: 'Cancel', kind: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (answer === 'reset') apply()
  }
}

function sameSettings<T extends object>(a: T, b: T): boolean {
  return (Object.keys(b) as Array<keyof T>).every((k) => a[k] === b[k])
}

/** True when the agent prefs already equal the defaults (ignoring the user's MCP list). */
function agentIsDefault(p: AgentPrefs): boolean {
  return (
    p.mode === DEFAULT_AGENT_PREFS.mode &&
    p.autoApply === DEFAULT_AGENT_PREFS.autoApply &&
    p.maxIterations === DEFAULT_AGENT_PREFS.maxIterations &&
    p.maxUsd === DEFAULT_AGENT_PREFS.maxUsd &&
    p.verifyChanges === DEFAULT_AGENT_PREFS.verifyChanges
  )
}

function EditorSettingsPane() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const resetSection = useResetSection()
  const s = state.editorSettings
  const set = (patch: Partial<EditorSettings>) => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: patch })
  const [trusted, setTrusted] = useState<string[]>(() => trustedFolders())

  const toggle = (key: keyof EditorSettings, title: string, detail: string) => (
    <div className={styles.option}>
      <div className={styles.optionText}>
        <div className={styles.optionTitle}>{title}</div>
        <div className={styles.optionDetail}>{detail}</div>
      </div>
      <label className={styles.switch}>
        <input type="checkbox" checked={Boolean(s[key])} onChange={(e) => set({ [key]: e.target.checked } as Partial<EditorSettings>)} aria-label={title} />
        <span />
      </label>
    </div>
  )

  return (
    <div className={styles.section}>
      <h2 className={styles.h2}>Editor</h2>
      <p className={styles.lead}>How code looks and behaves in the Code view. Changes apply immediately.</p>

      <div className={styles.option}>
        <div className={styles.optionText}>
          <div className={styles.optionTitle}>Color theme</div>
          <div className={styles.optionDetail}>The whole window, the code editor and the terminal. "Match system" follows your operating system's light or dark mode.</div>
        </div>
        <select className={styles.select} value={s.colorTheme} onChange={(e) => set({ colorTheme: e.target.value as EditorSettings['colorTheme'] })} aria-label="Color theme">
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">Match system</option>
        </select>
      </div>

      <div className={styles.option}>
        <div className={styles.optionText}>
          <div className={styles.optionTitle}>Font size</div>
          <div className={styles.optionDetail}>Ctrl+= and Ctrl+- change it from the editor too.</div>
        </div>
        <input className={styles.number} type="number" min={8} max={32} value={s.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} aria-label="Font size" />
      </div>

      <div className={styles.option}>
        <div className={styles.optionText}>
          <div className={styles.optionTitle}>Indentation</div>
          <div className={styles.optionDetail}>Tab size, and whether Tab inserts spaces.</div>
        </div>
        <div className={styles.inline}>
          <select className={styles.select} value={s.tabSize} onChange={(e) => set({ tabSize: Number(e.target.value) })} aria-label="Tab size">
            {[2, 3, 4, 8].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <select className={styles.select} value={s.insertSpaces ? 'spaces' : 'tabs'} onChange={(e) => set({ insertSpaces: e.target.value === 'spaces' })} aria-label="Indent with">
            <option value="spaces">Spaces</option>
            <option value="tabs">Tabs</option>
          </select>
        </div>
      </div>

      <div className={styles.option}>
        <div className={styles.optionText}>
          <div className={styles.optionTitle}>Auto save</div>
          <div className={styles.optionDetail}>Save without pressing Ctrl+S: a second after you stop typing, or when you switch away.</div>
        </div>
        <select className={styles.select} value={s.autoSave} onChange={(e) => set({ autoSave: e.target.value as EditorSettings['autoSave'] })} aria-label="Auto save">
          <option value="off">Off</option>
          <option value="afterDelay">After a short delay</option>
          <option value="onFocusChange">When focus changes</option>
        </select>
      </div>

      {toggle('formatOnSave', 'Format on save', 'Run the language formatter (TypeScript, JavaScript, JSON, CSS, HTML) before each save.')}
      {toggle('languageFeatures', 'Language features (IntelliSense)', 'Completions, hover, go to definition, rename and problems for TypeScript, JavaScript, JSON, CSS and HTML.')}
      {toggle('wordWrap', 'Word wrap', 'Wrap long lines to the width of the editor (Alt+Z).')}
      {toggle('minimap', 'Minimap', 'The overview of the file at the right edge of the editor.')}
      {toggle('stickyScroll', 'Sticky scroll', 'Keep the enclosing function or class header pinned at the top while scrolling.')}
      {toggle('bracketPairColorization', 'Bracket pair colours', 'Colour matching brackets and show their guides.')}

      <div className={styles.option}>
        <div className={styles.optionText}>
          <div className={styles.optionTitle}>Line numbers</div>
        </div>
        <select className={styles.select} value={s.lineNumbers} onChange={(e) => set({ lineNumbers: e.target.value as EditorSettings['lineNumbers'] })} aria-label="Line numbers">
          <option value="on">On</option>
          <option value="relative">Relative</option>
          <option value="off">Off</option>
        </select>
      </div>

      <div className={styles.option}>
        <div className={styles.optionText}>
          <div className={styles.optionTitle}>Show whitespace</div>
        </div>
        <select className={styles.select} value={s.renderWhitespace} onChange={(e) => set({ renderWhitespace: e.target.value as EditorSettings['renderWhitespace'] })} aria-label="Show whitespace">
          <option value="none">Never</option>
          <option value="selection">In the selection</option>
          <option value="all">Always</option>
        </select>
      </div>

      <h2 className={styles.h2}>Terminal</h2>
      <p className={styles.lead}>
        Folders where the terminal runs commands without asking first. Remove one to be asked again.
      </p>
      {trusted.length === 0 ? (
        <p className={styles.fine}>None yet. The terminal asks the first time you run a command in a folder.</p>
      ) : (
        <ul className={styles.trustList}>
          {trusted.map((folder) => (
            <li key={folder}>
              <code>{folder}</code>
              <button
                className={styles.secondary}
                onClick={() => {
                  forgetTrustedFolder(folder)
                  setTrusted(trustedFolders())
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        className={styles.secondary}
        onClick={() =>
          void resetSection('editor', sameSettings(s, DEFAULT_EDITOR_SETTINGS), () =>
            dispatch({ type: 'SET_EDITOR_SETTINGS', payload: DEFAULT_EDITOR_SETTINGS }),
          )
        }
      >
        Restore defaults
      </button>
    </div>
  )
}

export function SettingsDialog() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const status = useEngineStatus()
  const resetSection = useResetSection()
  const dialogRef = useRef<HTMLDivElement>(null)
  // The element that had focus before the dialog opened, so focus returns there on close
  // (invariant 1: keyboard-usable, focus trapped then returned).
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!state.settingsOpen) return
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
    // Move focus into the dialog so Tab stays inside it from the start.
    const node = dialogRef.current
    const focusFirst = () => {
      const focusable = node?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      focusable?.focus()
    }
    focusFirst()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dispatch({ type: 'CLOSE_SETTINGS' })
        return
      }
      // Focus trap: Tab and Shift+Tab cycle within the dialog, never out of it.
      if (event.key === 'Tab' && node) {
        const items = Array.from(
          node.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null || el === document.activeElement)
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (event.shiftKey && active === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      // Return focus to where it was, on close/unmount.
      restoreFocusRef.current?.focus?.()
    }
  }, [dispatch, state.settingsOpen])

  if (!state.settingsOpen) return null
  const close = () => dispatch({ type: 'CLOSE_SETTINGS' })
  const prefs = state.agentPrefs

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label="Settings">
        <nav className={styles.nav}>
          <div className={styles.navTitle}>Settings</div>
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                className={`${styles.navItem} ${state.settingsTab === tab.id ? styles.navActive : ''}`}
                onClick={() => dispatch({ type: 'OPEN_SETTINGS', payload: tab.id })}
                aria-current={state.settingsTab === tab.id ? 'page' : undefined}
              >
                <Icon size={14} /> {tab.label}
              </button>
            )
          })}
          <div className={styles.navFoot}>
            Engine: {status.state === 'ready' ? `ready · v${status.ping?.version ?? '?'}` : status.state === 'error' ? 'not running' : 'starting…'}
          </div>
        </nav>

        <div className={styles.content}>
          <button className={styles.close} onClick={close} aria-label="Close settings">
            <X size={16} />
          </button>

          {state.settingsTab === 'models' && (
            <div className={styles.section}>
              <div className={styles.sectionHead}>
                <div>
                  <h2 className={styles.h2}>Models & providers</h2>
                  <p className={styles.lead}>
                    Connect an account or paste an API key. Keys are kept in your operating system's credential store.
                  </p>
                </div>
                <button className={styles.primary} onClick={() => dispatch({ type: 'OPEN_CONNECT' })}>
                  <Key size={13} /> Connect a model
                </button>
              </div>
              <LocalModels />
              <div className={styles.panelHost}>
                <ProviderSettings />
              </div>
            </div>
          )}

          {state.settingsTab === 'agent' && (
            <div className={styles.section}>
              <h2 className={styles.h2}>Agent</h2>
              <p className={styles.lead}>How the agent works on your project. These apply to the next run.</p>

              <div className={styles.option}>
                <div className={styles.optionText}>
                  <div className={styles.optionTitle}>Apply edits automatically</div>
                  <div className={styles.optionDetail}>
                    On: the agent writes files as it works and checks the result; each run has an Undo button that restores
                    the files it changed (no Git needed). Off: every change is proposed for you to accept or reject first.
                  </div>
                </div>
                <label className={styles.switch}>
                  <input
                    type="checkbox"
                    checked={prefs.autoApply}
                    onChange={(e) => dispatch({ type: 'SET_AGENT_PREFS', payload: { autoApply: e.target.checked } })}
                    aria-label="Apply edits automatically"
                  />
                  <span />
                </label>
              </div>

              <div className={styles.option}>
                <div className={styles.optionText}>
                  <div className={styles.optionTitle}>Check changes with the project's own tests</div>
                  <div className={styles.optionDetail}>
                    After applying edits, run the project's checks (from verify.yaml, or its test / lint / typecheck / build
                    scripts) so a run only counts as done when they pass. This runs the project's scripts on this computer.
                  </div>
                </div>
                <label className={styles.switch}>
                  <input
                    type="checkbox"
                    checked={prefs.verifyChanges}
                    onChange={(e) => dispatch({ type: 'SET_AGENT_PREFS', payload: { verifyChanges: e.target.checked } })}
                    aria-label="Check changes with the project's own tests"
                  />
                  <span />
                </label>
              </div>

              <div className={styles.option}>
                <div className={styles.optionText}>
                  <div className={styles.optionTitle}>Maximum steps per run</div>
                  <div className={styles.optionDetail}>
                    Each step is one model call. Reading files uses steps too. A run that reaches the limit stops and says so.
                  </div>
                </div>
                <input
                  className={styles.number}
                  type="number"
                  min={4}
                  max={100}
                  value={prefs.maxIterations}
                  onChange={(e) => dispatch({ type: 'SET_AGENT_PREFS', payload: { maxIterations: Number(e.target.value) } })}
                  aria-label="Maximum steps per run"
                />
              </div>

              <div className={styles.option}>
                <div className={styles.optionText}>
                  <div className={styles.optionTitle}>Spend ceiling per run (USD)</div>
                  <div className={styles.optionDetail}>
                    Checked before every model call, so a run cannot overspend. Applies to providers with published prices;
                    a token ceiling and the step limit bound every other provider, including local ones.
                  </div>
                </div>
                <input
                  className={styles.number}
                  type="number"
                  min={0.05}
                  max={100}
                  step={0.25}
                  value={prefs.maxUsd}
                  onChange={(e) => dispatch({ type: 'SET_AGENT_PREFS', payload: { maxUsd: Number(e.target.value) } })}
                  aria-label="Spend ceiling per run in US dollars"
                />
              </div>

              <div className={styles.option}>
                <div className={styles.optionText}>
                  <div className={styles.optionTitle}>Loop protection</div>
                  <div className={styles.optionDetail}>
                    Always on. A model that repeats the same action is warned after 3 repeats and stopped after 5, so a stuck
                    run cannot run up a bill.
                  </div>
                </div>
                <span className={styles.always}>On</span>
              </div>

              <button
                className={styles.secondary}
                onClick={() =>
                  void resetSection('agent', agentIsDefault(prefs), () =>
                    dispatch({ type: 'SET_AGENT_PREFS', payload: DEFAULT_AGENT_PREFS }),
                  )
                }
              >
                Restore defaults
              </button>
            </div>
          )}

          {state.settingsTab === 'appearance' && <AppearanceSettings />}
          {state.settingsTab === 'editor' && <EditorSettingsPane />}

          {state.settingsTab === 'privacy' && (
            <div className={styles.section}>
              <h2 className={styles.h2}>Privacy</h2>
              <p className={styles.lead}>Offline Mode, what Sketch sent where, and the data it keeps on this computer.</p>
              <PrivacySettings />
              {/* B-009: the "Privacy & safety" statements that used to sit under the
                  mislabelled "Shortcuts & privacy" tab now live here, with the rest of
                  privacy, so privacy appears under exactly one name. */}
              <h2 className={styles.h2}>Privacy &amp; safety</h2>
              <ul className={styles.facts}>
                <li>
                  <Shield size={13} /> <span><strong>No account, no usage reporting, no Sketch server.</strong> The only thing that leaves your
                  computer is the request to the model provider you connected.</span>
                </li>
                <li>
                  <Key size={13} /> <span><strong>Keys stay in your OS credential store</strong> (Windows Credential Manager, macOS Keychain,
                  or the Secret Service). They are never written to a settings file and are scrubbed from every log.</span>
                </li>
                <li>
                  <Info size={13} /> <span><strong>The agent works only inside the folder you open.</strong> Reading costs a permission every
                  run holds; edits outside the folder — including through links — are refused.</span>
                </li>
                <li>
                  <Cpu size={13} /> <span><strong>Every run is recorded</strong> in the folder's <code>.sketch/</code> log: what the model was
                  asked, what it read, what it changed, and what it cost. Open Timeline to replay one.</span>
                </li>
              </ul>
            </div>
          )}

          {state.settingsTab === 'shortcuts' && (
            <div className={styles.section}>
              <h2 className={styles.h2}>Keyboard shortcuts</h2>
              <p className={styles.lead}>
                Every shortcut Sketch binds. Ctrl is Cmd on macOS. This list is generated from the same table the app
                binds, so it only ever shows shortcuts that work.
              </p>
              <div className={styles.shortcutTable} role="table" aria-label="Keyboard shortcuts">
                {SHORTCUTS.map((s) => (
                  <div key={s.keys} className={styles.shortcutRow} role="row">
                    <span role="cell">{s.what}</span>
                    <kbd role="cell">{s.keys}</kbd>
                  </div>
                ))}
              </div>
            </div>
          )}

          {state.settingsTab === 'about' && (
            <AboutPane status={status} editor={state.editorSettings} agent={prefs} />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * About: version, engine status, where data lives, and settings export/import (W9
 * invariant 8b). Export copies a versioned, KEY-FREE JSON of the UI settings; import
 * validates a pasted blob, shows exactly what will change, confirms, and applies — never
 * a key, never provider config.
 */
function AboutPane({
  status,
  editor,
  agent,
}: {
  status: ReturnType<typeof useEngineStatus>
  editor: EditorSettings
  agent: AgentPrefs
}) {
  const dispatch = useAppDispatch()
  const client = useSketchClient()
  const { appearance } = useAppState()
  const [copied, setCopied] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [paste, setPaste] = useState('')
  const [preview, setPreview] = useState<SettingsChange[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)

  const copyExport = async () => {
    const text = serializeSettingsExport(editor, agent, appearance)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Could not copy to the clipboard. Your browser or window blocked clipboard access.')
    }
  }

  // Review step: parse + diff, show what would change. Apply is a separate click.
  const review = () => {
    setError(null)
    setApplied(false)
    const result = parseSettingsImport(paste)
    if (!result.ok) {
      setPreview(null)
      setError(result.error)
      return
    }
    const changes = diffSettings({ editor, agent, appearance }, result.parsed)
    setPreview(changes)
  }

  const apply = () => {
    const result = parseSettingsImport(paste)
    if (!result.ok) {
      setError(result.error)
      return
    }
    dispatch({ type: 'IMPORT_SETTINGS', payload: result.parsed })
    setApplied(true)
    setPreview(null)
    setPaste('')
    window.setTimeout(() => {
      setImportOpen(false)
      setApplied(false)
    }, 1200)
  }

  return (
    <div className={styles.section}>
      <h2 className={styles.h2}>About Sketch</h2>
      <ul className={styles.facts}>
        <li>
          <Info size={13} />{' '}
          <span>
            <strong>Engine</strong>:{' '}
            {status.state === 'ready'
              ? `ready, version ${status.ping?.version ?? 'unknown'}`
              : status.state === 'error'
                ? 'not running'
                : 'starting…'}
            {' · '}connected over <code>{client.transport}</code>
          </span>
        </li>
        <li>
          <Shield size={13} />{' '}
          <span>
            <strong>Where your data lives</strong>: settings, sign-ins and installed skills in your home folder's{' '}
            <code>.sketch/</code>; chats, open folders and window layout in this window's local storage; API keys in your
            operating system's credential store. See the Privacy tab for the exact paths and what left this computer.
          </span>
        </li>
      </ul>

      <h2 className={styles.h2}>Export &amp; import settings</h2>
      <p className={styles.lead}>
        Copy your editor, agent and theme preferences as JSON to move them to another computer, then paste them here to
        apply. The export never contains an API key or any provider, and importing never changes them.
      </p>
      <div className={styles.links}>
        <button className={styles.secondary} onClick={() => void copyExport()}>
          <Copy size={12} /> {copied ? 'Copied' : 'Copy settings'}
        </button>
        <button
          className={styles.secondary}
          onClick={() => {
            setImportOpen((v) => !v)
            setError(null)
            setPreview(null)
            setApplied(false)
          }}
          aria-expanded={importOpen}
        >
          <Download size={12} /> Import settings
        </button>
      </div>

      {importOpen && (
        <div className={styles.importBox}>
          <label className={styles.importLabel} htmlFor="settings-import">
            Paste exported settings JSON
          </label>
          <textarea
            id="settings-import"
            className={styles.importArea}
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value)
              setPreview(null)
              setError(null)
            }}
            placeholder='{ "kind": "sketch-settings", "version": 1, … }'
            rows={5}
            spellCheck={false}
          />
          {error !== null && (
            <p className={styles.importError} role="alert">
              {error}
            </p>
          )}
          {preview !== null && (
            <div className={styles.importPreview} role="status">
              {preview.length === 0 ? (
                <p className={styles.fine}>These settings match what you already have. Nothing would change.</p>
              ) : (
                <>
                  <p className={styles.fine}>{preview.length} setting{preview.length === 1 ? '' : 's'} would change:</p>
                  <ul className={styles.importList}>
                    {preview.map((c) => (
                      <li key={`${c.section}:${c.label}`}>
                        <strong>{c.section}</strong> · {c.label}: <code>{c.from}</code> → <code>{c.to}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {applied && (
            <p className={styles.importOk} role="status">
              Settings imported.
            </p>
          )}
          <div className={styles.links}>
            {preview === null ? (
              <button className={styles.secondary} onClick={review} disabled={paste.trim() === ''}>
                Review changes
              </button>
            ) : (
              <button className={styles.primary} onClick={apply} disabled={preview.length === 0}>
                Apply {preview.length} change{preview.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </div>
      )}

      <h2 className={styles.h2}>Project</h2>
      <div className={styles.links}>
        <button className={styles.secondary} onClick={() => void openExternal(REPO_URL)}>
          <ExternalLink size={12} /> Source code
        </button>
        <button className={styles.secondary} onClick={() => void openExternal(`${REPO_URL}/issues/new/choose`)}>
          <ExternalLink size={12} /> Report a problem
        </button>
      </div>
      <p className={styles.fine}>Sketch is free and open source under the Apache-2.0 license.</p>
    </div>
  )
}

export default SettingsDialog
