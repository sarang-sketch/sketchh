// Local, synchronous extension points for the desktop editor.
// Host code may register themes and filename-extension mappings before creating an
// editor. This registry never discovers, downloads, or executes plugins.

export interface EditorThemeRule {
  token: string
  foreground?: string
  background?: string
  fontStyle?: string
}

export interface EditorThemeDefinition {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
  inherit: boolean
  rules: EditorThemeRule[]
  colors: Record<string, string>
  encodedTokensColors?: string[]
}

export interface RegisteredEditorTheme {
  id: string
  definition: EditorThemeDefinition
}

/** A safe declarative subset of a Monaco Monarch tokenizer rule. */
export interface EditorLanguageRule {
  /** JavaScript regular-expression source, compiled by the Monaco runtime. */
  regex: string
  /** Monaco token class, for example `keyword` or `string`. */
  token: string
}

export interface EditorLanguageDefinition {
  /** Filename extensions, with or without a leading dot. */
  extensions: readonly string[]
  /** Root-state rules, evaluated in declaration order. */
  rules: readonly EditorLanguageRule[]
}

export interface RegisteredEditorLanguage {
  id: string
  extensions: string[]
  rules: EditorLanguageRule[]
}

export const SKETCH_THEME = 'sketch-dark'

const VALID_ID = /^[A-Za-z][A-Za-z0-9._-]*$/
const VALID_EXTENSION = /^[A-Za-z0-9][A-Za-z0-9+_-]*$/

function requireId(kind: string, id: string): string {
  if (!VALID_ID.test(id)) {
    throw new Error(`${kind} id must start with a letter and contain only letters, numbers, '.', '_' or '-': ${JSON.stringify(id)}`)
  }
  return id
}

function normalizeExtension(extension: string): string {
  const normalized = (extension.startsWith('.') ? extension.slice(1) : extension).toLowerCase()
  if (!VALID_EXTENSION.test(normalized)) {
    throw new Error(`file extension must contain only letters, numbers, '+', '_' or '-': ${JSON.stringify(extension)}`)
  }
  return normalized
}

function cloneTheme(definition: EditorThemeDefinition): EditorThemeDefinition {
  return {
    ...definition,
    rules: definition.rules.map((rule) => ({ ...rule })),
    colors: { ...definition.colors },
    encodedTokensColors: definition.encodedTokensColors
      ? [...definition.encodedTokensColors]
      : undefined,
  }
}

function cloneLanguage(definition: EditorLanguageDefinition): Omit<RegisteredEditorLanguage, 'id'> {
  return {
    extensions: definition.extensions.map(normalizeExtension),
    rules: definition.rules.map((rule) => ({ ...rule })),
  }
}

function validateLanguage(id: string, definition: EditorLanguageDefinition): void {
  requireId('language', id)
  if (definition.extensions.length === 0) throw new Error('at least one file extension is required')
  if (definition.rules.length === 0) throw new Error(`language ${JSON.stringify(id)} must provide tokenizer rules`)
  for (const [index, rule] of definition.rules.entries()) {
    if (typeof rule.regex !== 'string' || rule.regex === '') {
      throw new Error(`language ${JSON.stringify(id)} rule ${index} must provide a regex source`)
    }
    try {
      new RegExp(rule.regex)
    } catch {
      throw new Error(`language ${JSON.stringify(id)} rule ${index} has an invalid regex`)
    }
    if (typeof rule.token !== 'string' || rule.token.trim() === '') {
      throw new Error(`language ${JSON.stringify(id)} rule ${index} must provide a token`)
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const SKETCH_DARK_THEME: EditorThemeDefinition = {
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
}

export const SKETCH_LIGHT_THEME_ID = 'sketch-light'

/** The light theme: the dark theme's hues, deepened to read on white (WCAG AA). */
export const SKETCH_LIGHT_THEME: EditorThemeDefinition = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '1f1f1f' },
    { token: 'comment', foreground: '6b6b6b', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'be123c' },
    { token: 'string', foreground: '047857' },
    { token: 'number', foreground: 'a3480b' },
    { token: 'type', foreground: '9a3412' },
    { token: 'type.identifier', foreground: '9a3412' },
    { token: 'function', foreground: '0369a1' },
    { token: 'variable', foreground: '1f1f1f' },
    { token: 'delimiter', foreground: '525252' },
    { token: 'tag', foreground: 'be123c' },
    { token: 'attribute.name', foreground: '0369a1' },
    { token: 'attribute.value', foreground: '047857' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#1f1f1f',
    'editorLineNumber.foreground': '#a3a3a3',
    'editorLineNumber.activeForeground': '#404040',
    'editorGutter.background': '#ffffff',
    'editor.lineHighlightBackground': '#f5f5f5',
    'editor.selectionBackground': '#add6ff',
    'editorCursor.foreground': '#ea580c',
    'editorWidget.background': '#f8f8f8',
    'editorWidget.border': '#e5e5e5',
    'editorIndentGuide.background1': '#e5e5e5',
    'scrollbarSlider.background': '#c4c4c499',
  },
}

const BUILTIN_LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown',
  py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml', sql: 'sql',
  c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  kt: 'kotlin', dockerfile: 'dockerfile',
}

export class EditorExtensionRegistry {
  private readonly themes = new Map<string, EditorThemeDefinition>()
  private readonly languages = new Map<string, string>()
  private readonly languageDefinitions = new Map<string, Omit<RegisteredEditorLanguage, 'id'>>()
  private activeThemeId = SKETCH_THEME

  constructor() {
    this.themes.set(SKETCH_THEME, cloneTheme(SKETCH_DARK_THEME))
    this.themes.set(SKETCH_LIGHT_THEME_ID, cloneTheme(SKETCH_LIGHT_THEME))
    for (const [extension, languageId] of Object.entries(BUILTIN_LANGUAGES)) {
      this.languages.set(extension, languageId)
    }
  }

  registerTheme(id: string, definition: EditorThemeDefinition): void {
    requireId('theme', id)
    if (!definition || !Array.isArray(definition.rules) || !definition.colors) {
      throw new Error(`theme ${JSON.stringify(id)} must provide rules and colors`)
    }
    const copy = cloneTheme(definition)
    const existing = this.themes.get(id)
    if (existing) {
      if (existing === definition || canonicalJson(existing) === canonicalJson(copy)) return
      throw new Error(`theme ${JSON.stringify(id)} is already registered with a different definition`)
    }
    this.themes.set(id, copy)
  }

  registerLanguage(languageId: string, extensions: readonly string[]): void {
    requireId('language', languageId)
    if (extensions.length === 0) throw new Error('at least one file extension is required')
    const normalized = extensions.map(normalizeExtension)
    for (const extension of normalized) {
      const existing = this.languages.get(extension)
      if (existing && existing !== languageId) {
        throw new Error(`extension ${JSON.stringify(extension)} is already mapped to ${JSON.stringify(existing)}`)
      }
    }
    for (const extension of normalized) this.languages.set(extension, languageId)
  }

  registerLanguageDefinition(languageId: string, definition: EditorLanguageDefinition): void {
    validateLanguage(languageId, definition)
    const copy = cloneLanguage(definition)
    const existing = this.languageDefinitions.get(languageId)
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(copy)) return
      throw new Error(`language ${JSON.stringify(languageId)} is already registered with a different definition`)
    }
    // Validate every extension conflict before mutating either map.
    for (const extension of copy.extensions) {
      const mapped = this.languages.get(extension)
      if (mapped && mapped !== languageId) {
        throw new Error(`extension ${JSON.stringify(extension)} is already mapped to ${JSON.stringify(mapped)}`)
      }
    }
    this.languageDefinitions.set(languageId, copy)
    for (const extension of copy.extensions) this.languages.set(extension, languageId)
  }

  activateTheme(id: string): void {
    requireId('theme', id)
    if (!this.themes.has(id)) throw new Error(`theme ${JSON.stringify(id)} is not registered`)
    this.activeThemeId = id
  }

  get activeTheme(): string {
    return this.activeThemeId
  }

  languageForExtension(extension: string): string | undefined {
    return this.languages.get(normalizeExtension(extension))
  }

  registeredThemes(): RegisteredEditorTheme[] {
    return [...this.themes].map(([id, definition]) => ({ id, definition: cloneTheme(definition) }))
  }

  registeredLanguages(): RegisteredEditorLanguage[] {
    return [...this.languageDefinitions].map(([id, definition]) => ({
      id,
      extensions: definition.extensions.map((extension) => `.${extension}`),
      rules: definition.rules.map((rule) => ({ ...rule })),
    }))
  }
}

/** The process-local registry consumed by the production Monaco loader and models. */
export const editorExtensionRegistry = new EditorExtensionRegistry()

export function registerEditorTheme(id: string, definition: EditorThemeDefinition): void {
  editorExtensionRegistry.registerTheme(id, definition)
}

export function registerLanguageExtensions(languageId: string, extensions: readonly string[]): void {
  editorExtensionRegistry.registerLanguage(languageId, extensions)
}

/** Register a non-built-in language and its real Monarch tokenizer. */
export function registerEditorLanguage(
  languageId: string,
  definition: EditorLanguageDefinition,
): void {
  editorExtensionRegistry.registerLanguageDefinition(languageId, definition)
}

export function activateEditorTheme(id: string): void {
  editorExtensionRegistry.activateTheme(id)
}
