import { describe, expect, it } from 'vitest'

import {
  buildFilePath, createFile, deleteFile, fileLines, foldersOf, formatBytes, formatTokens, projectFromJson,
  projectStats, projectToJson, renameFile, timeAgo, updateFile,
  type MobileFile,
} from './store'

const files: MobileFile[] = [
  { id: '1', path: 'src/app.js', content: 'a', updatedAt: 1 },
  { id: '2', path: 'index.html', content: 'b', updatedAt: 1 },
]

describe('mobile file store', () => {
  it('creates a file without colliding on names', () => {
    const next = createFile(files, 'index.html')
    expect(next).toHaveLength(3)
    expect(next[2]!.path).toBe('index-2.html')
  })

  it('updates, renames and deletes', () => {
    expect(updateFile(files, '1', 'new')[0]!.content).toBe('new')
    expect(renameFile(files, '1', 'src/main.js')[0]!.path).toBe('src/main.js')
    expect(renameFile(files, '1', 'index.html')).toEqual(files) // name taken: no change
    expect(deleteFile(files, '2')).toHaveLength(1)
  })

  it('lists implied folders', () => {
    expect(foldersOf(files)).toEqual(['src'])
  })

  it('round-trips through JSON and rejects other files', () => {
    const imported = projectFromJson(projectToJson(files))
    expect(imported).toHaveLength(2)
    expect(projectFromJson('{"app":"other"}')).toBeNull()
    expect(projectFromJson('not json')).toBeNull()
  })

  it('never creates an untitled file from a blank name', () => {
    expect(createFile(files, '')).toEqual(files)
    expect(createFile(files, '   ')).toEqual(files)
  })

  it('builds a new-file path with the chosen extension', () => {
    expect(buildFilePath('my-file', 'js')).toBe('my-file.js')
    expect(buildFilePath('src/app.js', 'html')).toBe('src/app.js')
    expect(buildFilePath('', 'js')).toBe('')
    expect(buildFilePath('  notes  ', 'md')).toBe('notes.md')
  })

  it('formats sizes, tokens and relative times', () => {
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5k')
    const now = Date.now()
    expect(timeAgo(now, now)).toBe('just now')
    expect(timeAgo(now - 5 * 60 * 1000, now)).toBe('5m ago')
    expect(timeAgo(now - 3 * 60 * 60 * 1000, now)).toBe('3h ago')
    expect(timeAgo(now - 2 * 24 * 60 * 60 * 1000, now)).toBe('2d ago')
  })

  it('stats count files, lines and bytes', () => {
    const stats = projectStats([
      { id: '1', path: 'a.js', content: 'one\ntwo', updatedAt: 1 },
      { id: '2', path: 'b.txt', content: '', updatedAt: 1 },
    ])
    expect(stats).toEqual({ files: 2, lines: 2, bytes: 7 })
    expect(fileLines({ id: '3', path: 'c', content: '', updatedAt: 1 })).toBe(0)
  })
})
