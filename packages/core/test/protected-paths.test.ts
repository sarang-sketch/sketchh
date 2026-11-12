// Protected paths: files inside the project the agent may still not write (git's own
// folder, Sketch's records, skill grants, secrets) or read (secrets).
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolDispatcher } from '../src/capabilities/index.js'
import { prepareEdit } from '../src/loop/edits.js'
import { projectToolDescriptors } from '../src/tools/index.js'
import { isSecretsFile, readRefusal, writeRefusal } from '../src/tools/protectedPaths.js'

const made: string[] = []

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-protected-'))
  made.push(root)
  await mkdir(join(root, '.git', 'hooks'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'app.ts'), 'export const port = 3000\n')
  await writeFile(join(root, '.env'), 'API_TOKEN=supersecretvalue\n')
  await writeFile(join(root, '.env.example'), 'API_TOKEN=\n')
  return root
}

describe('which paths are protected', () => {
  it('refuses writes to git, Sketch records, skill grants and secrets, in any letter case', () => {
    for (const path of [
      '.git/hooks/pre-commit',
      '.GIT/config',
      'vendor/lib/.git/config',
      '.sketch/events/2026-11-01.jsonl',
      '.sketch/snapshots/run-1/journal.json',
      '.sketch/skills/.grants/deploy.json',
      '.env',
      'config/.env.production',
      '.ENV.local',
      'id_ed25519',
      'certs/server.pem',
    ]) {
      expect(writeRefusal(path), path).not.toBeNull()
    }
  })

  it('leaves ordinary files, templates and skills writable', () => {
    for (const path of [
      'src/app.ts',
      '.env.example',
      '.env.sample',
      '.gitignore',
      '.github/workflows/ci.yml',
      '.sketch/skills/release/SKILL.md',
      '.sketch/commands/review.md',
      'docs/environment.md',
    ]) {
      expect(writeRefusal(path), path).toBeNull()
    }
  })

  it('refuses to read secrets files only', () => {
    expect(readRefusal('.env')).not.toBeNull()
    expect(readRefusal('backend/.env.local')).not.toBeNull()
    expect(readRefusal('.env.example')).toBeNull()
    expect(readRefusal('src/app.ts')).toBeNull()
    expect(isSecretsFile('keys/id_rsa')).toBe(true)
  })
})

describe('the agent cannot get around them', () => {
  it('an edit to a git hook is refused before anything is written', async () => {
    const root = await project()
    const result = await prepareEdit({ path: '.git/hooks/pre-commit', search: '', replace: '#!/bin/sh\necho owned\n' }, { root })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.outcome.reason).toMatch(/git's own folder/)
    await expect(stat(join(root, '.git', 'hooks', 'pre-commit'))).rejects.toThrow()
  })

  it('an edit to .env is refused and the file is unchanged', async () => {
    const root = await project()
    const result = await prepareEdit({ path: '.env', search: 'supersecretvalue', replace: 'changed' }, { root })
    expect(result.ok).toBe(false)
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('API_TOKEN=supersecretvalue\n')
  })

  it('an edit to a normal file still goes through', async () => {
    const root = await project()
    const result = await prepareEdit({ path: 'src/app.ts', search: '3000', replace: '8080' }, { root })
    expect(result.ok).toBe(true)
  })

  it('read_file refuses .env, and search_code does not hand its lines over', async () => {
    const root = await project()
    const tools = new ToolDispatcher({ tools: projectToolDescriptors(), granted: ['fs:read:project'], root })

    const read = await tools.call('read_file', { path: '.env' })
    expect(read.ok).toBe(false)
    expect(read.output).toMatch(/holds secrets/)
    expect(read.output).not.toContain('supersecretvalue')

    const template = await tools.call('read_file', { path: '.env.example' })
    expect(template.ok).toBe(true)

    const search = await tools.call('search_code', { query: 'API_TOKEN' })
    expect(search.output).not.toContain('supersecretvalue')
  })
})
