declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}

/**
 * Vite's `?worker` transform: the default export is a constructor for a same-origin
 * module worker. Declared here rather than pulling in all of `vite/client`.
 */
declare module '*?worker' {
  const WorkerConstructor: new () => Worker
  export default WorkerConstructor
}

/**
 * Monaco ships types only for `esm/vs/editor/editor.api`. `edcore.main` is the same
 * API plus the editor's own contributions (find, folding, multi-cursor…), so it is
 * declared as a re-export of the typed entry. See editor/monacoRuntime.ts for why
 * that entry is the one we build against.
 */
declare module 'monaco-editor/esm/vs/editor/edcore.main' {
  export * from 'monaco-editor'
}
