// The real Monaco, assembled by hand.
//
// ---------------------------------------------------------------------------
// WHY THE RAW API AND NOT `@monaco-editor/react`
// ---------------------------------------------------------------------------
// Two reasons, both structural:
//
//  1. The wrapper owns model lifecycle. It creates and keeps models from its own
//     `path`/`value` props and decides when to dispose them. Requirement 15.1 asks
//     for an explicit `Map<path, model>` and Requirement 15.2 forbids a second
//     cache — so the one thing we must control is exactly the thing the wrapper
//     takes over. `ModelRegistry` is that map, and it can only be authoritative if
//     nothing else creates models.
//  2. The wrapper's default loader fetches Monaco from a CDN at runtime. This app is
//     local-first and ships a real CSP (`default-src 'self'`), so a CDN fetch is
//     both offline-hostile and blocked. Bundling through Vite is the only honest
//     option here.
//
// ---------------------------------------------------------------------------
// WHAT IS INCLUDED, AND WHAT IS DELIBERATELY NOT
// ---------------------------------------------------------------------------
// `edcore.main` is the full standalone editor — find/replace, folding, multi-cursor,
// bracket matching, minimap, the command palette — plus the API. It contains NO
// languages, so each grammar is imported explicitly below.
//
// NOT INCLUDED: the four language SERVICES (`typescript`, `json`, `css`, `html`
// under `esm/vs/language/`) and their web workers. That is a deliberate trade, and
// what it costs is worth stating plainly:
//
//   kept  — syntax highlighting for every language listed below (Monarch grammars
//           run on the UI thread), bracket/indent rules, comment toggling,
//           find/replace, folding, word-based completion from the open buffer.
//   lost  — TypeScript/JavaScript IntelliSense, type errors, hover types,
//           go-to-definition; JSON schema validation; CSS/HTML validation.
//
// The reason: those four services roughly triple the editor payload (the TS service
// alone is the single largest piece of Monaco), and they would type-check the open
// file against Monaco's own in-memory compiler — a THIRD opinion about the project,
// disagreeing with the repository's real `tsc` and with the engine's verify stage.
// Requirement 4 makes the verify contract the authority on whether code is correct,
// and Requirement 15.5 puts completions on the engine's ghost-completion path (task
// 3.5), not on a bundled compiler. Adding them later is a one-line import plus a
// worker entry if that trade ever stops making sense.
//
// The one worker that IS shipped is `editor.worker`, which Monaco uses off the UI
// thread for diff computation and link/word detection. Without it Monaco logs a
// failure on first use.

import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
// The language services' workers. Each is its own chunk, fetched the first time a file
// of that language opens — and never, if language features are switched off.
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

// Grammars only — each of these is a Monarch tokenizer, not a language service.
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution'
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution'
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution'
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution'
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution'
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution'

import type { MonacoApi } from './monacoApi'
export { SKETCH_THEME } from './extensionRegistry'

/**
 * Workers are same-origin module scripts emitted by Vite's `?worker` transform —
 * not `blob:` URLs, which the app's CSP would refuse.
 */
;(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      default:
        return new EditorWorker()
    }
  },
}

let languageServices: Promise<typeof import('./monacoLanguages')> | null = null

/**
 * The real Monaco, behind the narrow api the editor talks to (./monacoApi.ts).
 *
 * The namespace itself cannot BE that api, and the reason is worth stating: Monaco's
 * `createModel` takes a `monaco.Uri`, a class with eight fields. Declaring that
 * parameter honestly in `MonacoApi` would drag the whole `Uri` class into the seam
 * and into every test double; declaring it as a small `{ toString(): string }`
 * makes the namespace un-assignable, because a function that only accepts a real
 * `Uri` cannot stand in for one that must accept any small URI-ish object. So the
 * api is keyed by PATH, and this object is the only place `Uri.file` is called.
 *
 * These four lines are still the compile-time drift check the annotation used to be:
 * they call the real `getModel`, `createModel` and `create` with real arguments, so a
 * Monaco upgrade that changes any of those signatures — or an option name that stops
 * existing — fails `tsc` here rather than failing in front of a user.
 */
export const monacoApi: MonacoApi = {
  editor: {
    defineTheme: (name, definition) => monaco.editor.defineTheme(name, definition),
    setTheme: (name) => monaco.editor.setTheme(name),
    getModel: (path) => monaco.editor.getModel(monaco.Uri.file(path)),
    createModel: (value, language, path) =>
      monaco.editor.createModel(value, language, monaco.Uri.file(path)),
    // No uri: Monaco gives it an `inmemory://` one, which no file can ever have.
    createScratchModel: (value, language) => monaco.editor.createModel(value, language),
    create: (container, options) => monaco.editor.create(container, options),
    // An adapter rather than the widget itself: Monaco's `setModel` also accepts a
    // view model, so its signature cannot stand in for the narrower one in the seam.
    // The models handed to it are always real Monaco models — `createModel` and
    // `createScratchModel` above are the only places this app gets one from.
    createDiffEditor: (container, options) => {
      const diff = monaco.editor.createDiffEditor(container, options)
      return {
        setModel: (model) =>
          diff.setModel(
            model === null
              ? null
              : {
                  original: model.original as unknown as monaco.editor.ITextModel,
                  modified: model.modified as unknown as monaco.editor.ITextModel,
                },
          ),
        updateOptions: (next) => diff.updateOptions(next),
        goToDiff: (target) => diff.goToDiff(target),
        getLineChanges: () => diff.getLineChanges(),
        onDidUpdateDiff: (listener) => diff.onDidUpdateDiff(() => listener()),
        focusModified: () => diff.getModifiedEditor().focus(),
        layout: () => diff.layout(),
        dispose: () => diff.dispose(),
      }
    },
    onDidChangeMarkers: (listener) =>
      monaco.editor.onDidChangeMarkers((uris) => listener(uris.map((uri) => uri.fsPath || uri.path))),
    getMarkers: (path) =>
      monaco.editor.getModelMarkers({ resource: monaco.Uri.file(path) }).map((marker) => ({
        severity: marker.severity,
        message: marker.message,
        startLineNumber: marker.startLineNumber,
        startColumn: marker.startColumn,
        endLineNumber: marker.endLineNumber,
        endColumn: marker.endColumn,
        ...(marker.source !== undefined ? { source: marker.source } : {}),
        ...(marker.code !== undefined ? { code: typeof marker.code === 'string' ? marker.code : { value: marker.code.value } } : {}),
      })),
  },
  languageServices: {
    async setEnabled(enabled) {
      // Never loaded until someone wants them; once loaded, switched by configuration.
      if (!enabled && languageServices === null) return
      languageServices ??= import('./monacoLanguages')
      const mod = await languageServices
      mod.setLanguageServices(enabled)
    },
  },
  languages: {
    register: (definition) => monaco.languages.register(definition),
    setMonarchTokensProvider: (id, rules) =>
      monaco.languages.setMonarchTokensProvider(id, {
        tokenizer: {
          root: rules.map((rule) => [new RegExp(rule.regex), rule.token]),
        },
      }),
    // Ghost text through Monaco's own inline-suggest widget. Monaco asks on every
    // pause and cancels the token when the user types on; awaiting the debounce and
    // re-checking the token is what turns "a request per keystroke" into "a request
    // per pause". The token's cancellation is forwarded as an AbortSignal so the
    // engine call is abandoned too.
    registerInlineCompletions: (provide, options = {}) =>
      monaco.languages.registerInlineCompletionsProvider('*', {
        async provideInlineCompletions(model, position, _context, token) {
          const controller = new AbortController()
          const subscription = token.onCancellationRequested(() => controller.abort())
          try {
            await new Promise((resolve) => setTimeout(resolve, options.debounceMs ?? 350))
            if (token.isCancellationRequested) return { items: [] }
            const content = model.getValue()
            const cursorOffset = model.getOffsetAt(position)
            const text = await provide({
              path: model.uri.fsPath || model.uri.path,
              language: model.getLanguageId(),
              content,
              cursorOffset,
              signal: controller.signal,
            })
            if (text === null || text === '' || token.isCancellationRequested) return { items: [] }
            return {
              items: [
                {
                  insertText: text,
                  range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                },
              ],
            }
          } catch {
            return { items: [] }
          } finally {
            subscription.dispose()
          }
        },
        freeInlineCompletions() {},
      }),
  },
  addEditorAction: (editor, action) =>
    (editor as unknown as monaco.editor.IStandaloneCodeEditor).addAction({
      id: action.id,
      label: action.label,
      ...(action.keybindings !== undefined ? { keybindings: action.keybindings } : {}),
      ...(action.contextMenuGroupId !== undefined ? { contextMenuGroupId: action.contextMenuGroupId } : {}),
      ...(action.contextMenuOrder !== undefined ? { contextMenuOrder: action.contextMenuOrder } : {}),
      run: () => action.run(),
    }),
  keys: {
    ctrlCmd: monaco.KeyMod.CtrlCmd,
    shift: monaco.KeyMod.Shift,
    alt: monaco.KeyMod.Alt,
    keyL: monaco.KeyCode.KeyL,
    keyK: monaco.KeyCode.KeyK,
    keyI: monaco.KeyCode.KeyI,
    backslash: monaco.KeyCode.Backslash,
    f5: monaco.KeyCode.F5,
  },
}

export default monaco
