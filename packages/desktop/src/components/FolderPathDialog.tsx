// Open a folder by typing its path — for when there is no native folder picker.
//
// The desktop app uses the operating system's picker. A browser session on the dev
// bridge has no such picker (it is a Tauri capability), but the engine can still work
// in any folder it is given, so rather than a dead button this asks for the path.

import { useEffect, useState } from 'react'
import { isComposing } from '../lib/keys'
import { useAppDispatch } from '../state/AppState'
import { Folder, X } from './Icons'
import styles from './settings/ConnectWizard.module.css'

export function FolderPathDialog() {
  const dispatch = useAppDispatch()
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('sketch:open-folder-path', show)
    return () => window.removeEventListener('sketch:open-folder-path', show)
  }, [])

  if (!open) return null
  const submit = () => {
    const value = path.trim().replace(/^["']|["']$/g, '')
    if (value === '') return
    dispatch({ type: 'SET_PROJECT_ROOT', payload: value })
    setOpen(false)
  }

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Open a folder" style={{ width: 'min(520px, calc(100vw - 48px))' }}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Open a folder</div>
            <div className={styles.subtitle}>There is no folder picker here, so type the folder's full path.</div>
          </div>
          <button className={styles.close} onClick={() => setOpen(false)} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.form}>
            <label className={styles.field}>
              <span>Folder path</span>
              <input
                className={styles.input}
                autoFocus
                placeholder="C:\\Users\\you\\Projects\\my-app"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isComposing(e)) submit()
                }}
                aria-label="Folder path"
              />
            </label>
            <div className={styles.actions}>
              <button className={styles.secondary} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className={styles.primary} disabled={path.trim() === ''} onClick={submit}>
                <Folder size={13} /> Open
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default FolderPathDialog
