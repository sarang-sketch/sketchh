import { describe, expect, it } from 'vitest'

import { createFile, deleteFile, foldersOf, projectFromJson, projectToJson, renameFile, updateFile, type MobileFile } from './store'

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
})
