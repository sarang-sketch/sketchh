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

/** The name registered with Monaco, used by `CodeEditor`. */
export const SKETCH_THEME = 'sketch-dark'

/**
 * Workers are same-origin module scripts emitted by Vite's `?worker` transform —
 * not `blob:` URLs, which the app's CSP would refuse.
 */
;(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker(): Worker {
    return new EditorWorker()
  },
}

// The palette is lifted from the hand-written syntax spans this editor replaces, so
// real tokenization looks like what the shell already looked like.
monaco.editor.defineTheme(SKETCH_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'e5e5e5' },
    { token: 'comment', foreground: '737373', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'f43f5e' },
    { token: 'string', foreground: '34d399' },
    { token: 'number', foreground: 'fbbf24' },
    { token: 'type', foreground: 'fbbf24' },
    { token: 'type.identifier', foreground: 'fbbf24' },
    { token: 'function', foreground: '38bdf8' },
    { token: 'variable', foreground: 'e5e5e5' },
    { token: 'delimiter', foreground: 'a3a3a3' },
    { token: 'tag', foreground: 'f43f5e' },
    { token: 'attribute.name', foreground: '38bdf8' },
    { token: 'attribute.value', foreground: '34d399' },
  ],
  colors: {
    'editor.background': '#121212',
    'editor.foreground': '#e5e5e5',
    'editorLineNumber.foreground': '#525252',
    'editorLineNumber.activeForeground': '#a3a3a3',
    'editorGutter.background': '#121212',
    'editor.lineHighlightBackground': '#171717',
    'editor.selectionBackground': '#2d3f4f',
    'editorCursor.foreground': '#ea580c',
    'editorWidget.background': '#171717',
    'editorWidget.border': '#262626',
    'editorIndentGuide.background1': '#262626',
    'scrollbarSlider.background': '#26262699',
  },
})

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
    getModel: (path) => monaco.editor.getModel(monaco.Uri.file(path)),
    createModel: (value, language, path) =>
      monaco.editor.createModel(value, language, monaco.Uri.file(path)),
    create: (container, options) => monaco.editor.create(container, options),
  },
}

export default monaco
