// Validates: Requirements 15.1, 15.2

import { describe, it, expect } from 'vitest'
import {
  basename,
  canonicalPath,
  isAbsolutePath,
  isWithinRoot,
  languageForPath,
  pathSegments,
  relativeToRoot,
  toAbsolutePath,
} from './paths'

const ROOT = 'C:/Users/me/app'

describe('canonicalPath', () => {
  it('gives one key to every Windows spelling of one file', () => {
    const spellings = [
      'C:\\Users\\me\\app\\src\\App.tsx',
      'c:/Users/me/app/src/App.tsx',
      'C:/Users/me/app//src/App.tsx',
      'C:/Users/me/app/src/./App.tsx',
      'C:/Users/me/app/lib/../src/App.tsx',
    ]
    const keys = new Set(spellings.map(canonicalPath))
    // One key, or the model map holds several models for one file — trap T11.
    expect([...keys]).toEqual(['C:/Users/me/app/src/App.tsx'])
  })

  it('is idempotent', () => {
    for (const input of ['C:\\a\\b', '/usr/local/bin', '//server/share/x', 'src/App.tsx']) {
      expect(canonicalPath(canonicalPath(input))).toBe(canonicalPath(input))
    }
  })

  it('keeps POSIX and UNC roots intact', () => {
    expect(canonicalPath('/usr//local/./bin')).toBe('/usr/local/bin')
    expect(canonicalPath('\\\\server\\share\\file.txt')).toBe('//server/share/file.txt')
  })

  it('recognizes absolute paths in both families', () => {
    expect(isAbsolutePath('C:\\x')).toBe(true)
    expect(isAbsolutePath('/x')).toBe(true)
    expect(isAbsolutePath('src/App.tsx')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })
})

describe('toAbsolutePath', () => {
  it('resolves the project-relative paths the engine reports', () => {
    // `edit_accepted` carries the path the model asked for, which is relative.
    expect(toAbsolutePath(ROOT, 'src/App.tsx')).toBe('C:/Users/me/app/src/App.tsx')
    expect(toAbsolutePath(ROOT, './src/App.tsx')).toBe('C:/Users/me/app/src/App.tsx')
  })

  it('leaves an absolute path absolute, whatever its spelling', () => {
    expect(toAbsolutePath(ROOT, 'c:\\Users\\me\\app\\src\\App.tsx')).toBe(
      'C:/Users/me/app/src/App.tsx',
    )
  })
})

describe('isWithinRoot', () => {
  it('accepts files under the root regardless of drive-letter case', () => {
    expect(isWithinRoot(ROOT, 'c:/users/me/app/src/App.tsx'.replace('users', 'Users'))).toBe(true)
    expect(isWithinRoot('c:\\Users\\me\\app', 'C:/Users/me/app/src/App.tsx')).toBe(true)
  })

  it('refuses a sibling directory that merely shares a prefix', () => {
    expect(isWithinRoot(ROOT, 'C:/Users/me/app-other/secret.txt')).toBe(false)
    expect(isWithinRoot(ROOT, 'C:/Users/me/secret.txt')).toBe(false)
  })
})

describe('display helpers', () => {
  it('derives the breadcrumb from the real root', () => {
    expect(relativeToRoot(ROOT, 'C:/Users/me/app/src/App.tsx')).toBe('src/App.tsx')
    expect(pathSegments(ROOT, 'C:/Users/me/app/src/App.tsx')).toEqual(['src', 'App.tsx'])
    expect(basename('C:\\Users\\me\\app\\src\\App.tsx')).toBe('App.tsx')
  })
})

describe('languageForPath', () => {
  it('maps the extensions whose grammars are registered', () => {
    expect(languageForPath('a/App.tsx')).toBe('typescript')
    expect(languageForPath('a/styles.css')).toBe('css')
    expect(languageForPath('a/main.rs')).toBe('rust')
    expect(languageForPath('a/Dockerfile')).toBe('dockerfile')
  })

  it('falls back to plaintext rather than guessing a wrong grammar', () => {
    expect(languageForPath('a/LICENSE')).toBe('plaintext')
    expect(languageForPath('a/data.unknownext')).toBe('plaintext')
  })
})
