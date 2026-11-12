import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from 'react'

export interface ComposerDraft { text: string; files: string[] }
const EMPTY: ComposerDraft = { text: '', files: [] }

/** Session-only drafts. Keystrokes update composers without repainting the workbench. */
export function createDraftStore() {
  const drafts = new Map<string, ComposerDraft>()
  const listeners = new Set<() => void>()
  return {
    get: (key: string) => drafts.get(key) ?? EMPTY,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    update(key: string, edit: (draft: ComposerDraft) => ComposerDraft) {
      const previous = drafts.get(key) ?? EMPTY
      const next = edit(previous)
      if (next.text === previous.text && next.files === previous.files) return
      drafts.delete(key)
      if (next.text || next.files.length) drafts.set(key, next)
      // Keep recent unsent work bounded. Nothing is written to localStorage or sent.
      if (drafts.size > 100) drafts.delete(drafts.keys().next().value!)
      for (const notify of listeners) notify()
    },
  }
}

const DraftContext = createContext<{ store: ReturnType<typeof createDraftStore>; draftKey: string } | null>(null)

export function ComposerDraftsProvider({ draftKey, children }: { draftKey: string; children: ReactNode }) {
  const [store] = useState(createDraftStore)
  const value = useMemo(() => ({ store, draftKey }), [store, draftKey])
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>
}

export function useComposerDraft() {
  const context = useContext(DraftContext)
  if (context === null) throw new Error('Composer drafts require AppStateProvider')
  const { store, draftKey } = context
  const getSnapshot = useCallback(() => store.get(draftKey), [store, draftKey])
  const draft = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
  const setText = useCallback((value: SetStateAction<string>) => {
    store.update(draftKey, (current) => ({ ...current, text: typeof value === 'function' ? value(current.text) : value }))
  }, [store, draftKey])
  const setAttached = useCallback((value: SetStateAction<string[]>) => {
    store.update(draftKey, (current) => ({ ...current, files: typeof value === 'function' ? value(current.files) : value }))
  }, [store, draftKey])
  return { text: draft.text, attached: draft.files, setText, setAttached }
}
