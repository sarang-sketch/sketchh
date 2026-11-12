// Clone a repository and open it — the welcome screen's "Clone Repository" button,
// which used to do nothing at all.
//
// The engine does the clone (`git-clone`): one shell-less `git clone` into a NEW
// folder, with the address validated and credential prompts disabled, so the button
// can never be pointed at a folder that already holds the user's files.

import { useEffect, useState } from 'react'
import { useSketchClient } from '../lib/ClientProvider'
import { useFileIo } from '../editor/FileIoProvider'
import { useAppDispatch, useAppState } from '../state/AppState'
import { AlertCircle, Folder, Package, X } from './Icons'
import styles from './settings/ConnectWizard.module.css'

function parentOf(path: string | null): string {
  if (!path) return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut > 0 ? trimmed.slice(0, cut) : ''
}

function nameFromUrl(url: string): string {
  return url.trim().replace(/[/\\]+$/, '').split(/[/:\\]/).pop()?.replace(/\.git$/i, '') ?? ''
}

export function CloneDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const client = useSketchClient()
  const io = useFileIo()
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setParent((current) => current || parentOf(state.projectRoot) || parentOf(state.workspaces[0]?.path ?? null))
      setProblem(null)
    }
  }, [open, state.projectRoot, state.workspaces])

  if (!open) return null

  const pick = async () => {
    try {
      const chosen = await io.pickFolder()
      if (chosen) setParent(chosen)
    } catch (err) {
      setProblem(`Could not open the folder picker: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const clone = async () => {
    if (client.gitClone === undefined) {
      setProblem(`The ${client.transport} transport cannot clone repositories.`)
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const result = await client.gitClone({ url: url.trim(), parent: parent.trim() })
      dispatch({ type: 'SET_PROJECT_ROOT', payload: result.path })
      setUrl('')
      onClose()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const name = nameFromUrl(url)
  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Clone a repository" style={{ width: 'min(560px, calc(100vw - 48px))' }}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Clone a repository</div>
            <div className={styles.subtitle}>Copies a Git repository into a new folder and opens it.</div>
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={16} />
          </button>
        </div>
        <div className={styles.body}>
          {problem && (
            <div className={styles.problem} role="alert">
              <AlertCircle size={14} />
              <span>{problem}</span>
            </div>
          )}
          <div className={styles.form}>
            <label className={styles.field}>
              <span>Repository address</span>
              <input
                className={styles.input}
                placeholder="https://github.com/owner/repo.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-label="Repository address"
                autoFocus
              />
            </label>
            <label className={styles.field}>
              <span>Put it inside</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className={styles.input}
                  style={{ flex: 1 }}
                  placeholder="C:\\Users\\you\\Projects"
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                  aria-label="Parent folder"
                />
                <button className={styles.secondary} onClick={() => void pick()}>
                  <Folder size={13} /> Browse
                </button>
              </div>
            </label>
            {name && parent && (
              <div className={styles.muted}>
                Will create <code>{parent.replace(/[\\/]+$/, '')}{parent.includes('\\') ? '\\' : '/'}{name}</code>
              </div>
            )}
            <div className={styles.fine}>Private repositories need Git credentials set up on this computer first.</div>
            <div className={styles.actions}>
              <button className={styles.secondary} onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className={styles.primary} onClick={() => void clone()} disabled={busy || url.trim() === '' || parent.trim() === ''}>
                <Package size={13} /> {busy ? 'Cloning…' : 'Clone and open'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CloneDialog
