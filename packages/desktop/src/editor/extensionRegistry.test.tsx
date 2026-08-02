import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { AppStateProvider, makeFileEntry } from '../state/AppState'
import CodeEditor from './CodeEditor'
import {
  activateEditorTheme,
  EditorExtensionRegistry,
  registerEditorLanguage,
  registerEditorTheme,
  SKETCH_THEME,
  type EditorThemeDefinition,
} from './extensionRegistry'
import { createMonacoDouble } from './monacoDouble'
import { prepareMonaco } from './monacoSetup'

const HOST_THEME: EditorThemeDefinition = {
  base: 'vs-dark',
  inherit: true,
  rules: [{ token: 'keyword', foreground: 'abcdef' }],
  colors: { 'editor.background': '#010203' },
}

const HOST_LANGUAGE = {
  extensions: ['.hostlang'],
  rules: [
    { regex: '\\b(?:host|extension)\\b', token: 'keyword' },
    { regex: '"[^"\\n]*"', token: 'string' },
  ],
} as const

const FILE = 'C:/app/example.hostlang'

afterEach(() => {
  activateEditorTheme(SKETCH_THEME)
  cleanup()
})

describe('desktop editor extension registry', () => {
  it('loads a host theme and a real language tokenizer through production setup', async () => {
    registerEditorTheme('host-dark', HOST_THEME)
    registerEditorLanguage('host-language', HOST_LANGUAGE)
    activateEditorTheme('host-dark')
    const monaco = createMonacoDouble()

    render(
      <AppStateProvider initial={{
        mode: 'ide',
        projectRoot: 'C:/app',
        openFiles: [FILE],
        activeFile: FILE,
        files: { [FILE]: makeFileEntry(FILE, 'host source') },
      }}>
        <CodeEditor loader={() => Promise.resolve(prepareMonaco(monaco.api))} />
      </AppStateProvider>,
    )

    await waitFor(() => expect(monaco.editors).toHaveLength(1))
    expect(monaco.definedThemes.get('host-dark')).toEqual(HOST_THEME)
    expect(monaco.definedThemes.has(SKETCH_THEME)).toBe(true)
    expect(monaco.registeredLanguages.get('host-language')).toEqual({
      extensions: ['.hostlang'],
      rules: HOST_LANGUAGE.rules,
    })
    expect(monaco.lastEditor().options.theme).toBe('host-dark')
    expect(monaco.model(FILE).language).toBe('host-language')
  })


  it('accepts equivalent repeats and refuses conflicting registrations', () => {
    const registry = new EditorExtensionRegistry()
    registry.registerTheme('host-theme', HOST_THEME)
    registry.registerTheme('host-theme', {
      inherit: true,
      base: 'vs-dark',
      colors: { 'editor.background': '#010203' },
      rules: [{ foreground: 'abcdef', token: 'keyword' }],
    })
    registry.registerLanguage('host-language', ['host'])
    registry.registerLanguage('host-language', ['.HOST'])
    registry.registerLanguageDefinition('host-grammar', HOST_LANGUAGE)
    registry.registerLanguageDefinition('host-grammar', {
      extensions: ['HOSTLANG'],
      rules: HOST_LANGUAGE.rules.map((rule) => ({ ...rule })),
    })

    expect(() => registry.registerTheme('host-theme', {
      ...HOST_THEME,
      colors: { 'editor.background': '#ffffff' },
    })).toThrow(/different definition/)
    expect(() => registry.registerLanguage('other-language', ['host'])).toThrow(
      /already mapped/,
    )
    expect(() => registry.registerLanguageDefinition('host-grammar', {
      ...HOST_LANGUAGE,
      rules: [{ regex: '.', token: 'different' }],
    })).toThrow(/different definition/)
  })

  it('retains every built-in language mapping', () => {
    const registry = new EditorExtensionRegistry()
    const expected: Record<string, string> = {
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
    for (const [extension, language] of Object.entries(expected)) {
      expect(registry.languageForExtension(extension)).toBe(language)
    }
  })

  it('validates theme ids, language ids, and extensions', () => {
    const registry = new EditorExtensionRegistry()
    expect(() => registry.registerTheme('not valid', HOST_THEME)).toThrow(/theme id/)
    expect(() => registry.registerLanguage('not valid', ['ok'])).toThrow(/language id/)
    expect(() => registry.registerLanguage('valid', [])).toThrow(/at least one/)
    expect(() => registry.registerLanguage('valid', ['*.bad'])).toThrow(/file extension/)
    expect(() => registry.registerLanguageDefinition('valid', {
      extensions: ['host'],
      rules: [{ regex: '[', token: 'bad' }],
    })).toThrow(/invalid regex/)
    expect(() => registry.registerLanguageDefinition('valid', {
      extensions: ['host'],
      rules: [],
    })).toThrow(/tokenizer rules/)
    expect(() => registry.activateTheme('missing')).toThrow(/not registered/)
  })
})
