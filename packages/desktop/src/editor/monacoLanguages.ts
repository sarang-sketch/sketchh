// IntelliSense for the web languages: completions, hover, signature help, go to
// definition, rename, formatting and problems for TypeScript, JavaScript, JSON, CSS,
// SCSS, Less and HTML — Monaco's own language services, the ones VS Code is built on.
//
// LOADED ON FIRST USE. This module is imported dynamically by monacoRuntime.ts when the
// "Language features" setting is on, so a user who turns it off never downloads the
// services; their workers (the TypeScript one is the largest piece of Monaco) load only
// when a file of that language is first opened.
//
// WHAT THE EDITOR CAN AND CANNOT SEE. The in-editor TypeScript service knows the files
// that are OPEN, not `node_modules` and not the rest of the project. Left alone it would
// mark every `import x from 'react'` as "Cannot find module" and every JSX tag as having
// an implicit `any` type — dozens of false problems per file. Those diagnostics, and only
// those, are switched off below; everything else (syntax errors, type errors inside the
// file, wrong argument counts) is reported. The project's real `tsc` stays the authority
// and runs in Test Results.

import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main'
// Side effects: each contribution registers its language on `monaco.languages`.
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'
import 'monaco-editor/esm/vs/language/json/monaco.contribution'
import 'monaco-editor/esm/vs/language/css/monaco.contribution'
import 'monaco-editor/esm/vs/language/html/monaco.contribution'

const ts = monaco.languages.typescript
const json = monaco.languages.json
const css = monaco.languages.css
const html = monaco.languages.html

/** Diagnostics that only mean "the editor cannot see the rest of the project". */
export const PROJECT_CONTEXT_DIAGNOSTICS: readonly number[] = [
  2307, // Cannot find module 'x' or its corresponding type declarations.
  2792, // Cannot find module 'x'. Did you mean to set the 'moduleResolution' option…
  7016, // Could not find a declaration file for module 'x'.
  2304, // Cannot find name 'x' (globals from @types the editor has not loaded).
  2503, // Cannot find namespace 'x'.
  2580, // Cannot find name 'require'. Do you need to install type definitions for node?
  2582, // Cannot find name 'describe'. Do you need to install type definitions for a test runner?
  2593, // The same, for Jest or Mocha globals.
  2591, // Cannot find name 'x'. Do you need to install type definitions for node? (tsconfig types)
  2875, // This JSX tag requires the module path 'react/jsx-runtime' to exist…
  7026, // JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.
  2786, // 'X' cannot be used as a JSX component (its type comes from an unresolved module).
  1259, // Module can only be default-imported using the 'esModuleInterop' flag.
  2732, // Cannot find module 'x.json'. Consider using '--resolveJsonModule'.
]

let configured = false

function configure(): void {
  if (configured) return
  configured = true
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
      checkJs: false,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      isolatedModules: true,
      skipLibCheck: true,
      noEmit: true,
      lib: ['esnext', 'dom', 'dom.iterable'],
    })
    defaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [...PROJECT_CONTEXT_DIAGNOSTICS],
    })
    // Every open file is visible to the others: go to definition and completions work
    // across open tabs, not only inside one file.
    defaults.setEagerModelSync(true)
  }
  json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    // tsconfig.json, .vscode settings and many configs are JSON with comments.
    allowComments: true,
    trailingCommas: 'warning',
    // Fetching a remote JSON schema is a network call the app does not make.
    enableSchemaRequest: false,
    schemas: [],
  })
}

type ModeConfig = Record<string, boolean>

function modeConfig(enabled: boolean, keys: string[]): ModeConfig {
  return Object.fromEntries(keys.map((key) => [key, enabled]))
}

const TS_FEATURES = [
  'completionItems', 'hovers', 'documentSymbols', 'definitions', 'references', 'documentHighlights',
  'rename', 'diagnostics', 'documentRangeFormattingEdits', 'signatureHelp', 'onTypeFormattingEdits',
  'codeActions', 'inlayHints',
]
const JSON_FEATURES = [
  'documentFormattingEdits', 'documentRangeFormattingEdits', 'completionItems', 'hovers', 'documentSymbols',
  'tokens', 'colors', 'foldingRanges', 'diagnostics', 'selectionRanges',
]
const CSS_FEATURES = [
  'completionItems', 'hovers', 'documentSymbols', 'definitions', 'references', 'documentHighlights', 'rename',
  'colors', 'foldingRanges', 'diagnostics', 'selectionRanges', 'documentFormattingEdits', 'documentRangeFormattingEdits',
]
const HTML_FEATURES = [
  'completionItems', 'hovers', 'documentSymbols', 'links', 'documentHighlights', 'rename', 'colors',
  'foldingRanges', 'selectionRanges', 'diagnostics', 'documentFormattingEdits', 'documentRangeFormattingEdits',
]

/** Switch the services on or off without a reload. */
export function setLanguageServices(enabled: boolean): void {
  configure()
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setModeConfiguration(modeConfig(enabled, TS_FEATURES))
  }
  // `tokens` is JSON's syntax colouring, which has no separate grammar: it stays on.
  json.jsonDefaults.setModeConfiguration({ ...modeConfig(enabled, JSON_FEATURES), tokens: true })
  for (const defaults of [css.cssDefaults, css.scssDefaults, css.lessDefaults]) {
    defaults.setModeConfiguration(modeConfig(enabled, CSS_FEATURES))
  }
  html.htmlDefaults.setModeConfiguration(modeConfig(enabled, HTML_FEATURES))
  if (!enabled) {
    // Turning the services off also clears the problems they had reported.
    for (const model of monaco.editor.getModels()) {
      for (const owner of ['typescript', 'javascript', 'json', 'css', 'scss', 'less', 'html']) {
        monaco.editor.setModelMarkers(model, owner, [])
      }
    }
  }
}
