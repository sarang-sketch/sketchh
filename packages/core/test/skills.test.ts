// Loader tests against REAL temp directories on disk — no fs mocks.
//
// Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.6

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadProjectContext,
  loadSkillFile,
  loadSkillFolder,
  loadSkillFolderLayout,
  loadSkills,
} from '../src/skills/index.js'
import type { Skill } from '../src/types.js'

const created: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-skills-'))
  created.push(dir)
  return dir
}

async function write(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('loadSkillFile', () => {
  it('loads a valid SKILL.md into a Skill', async () => {
    const root = await makeTmp()
    const dir = join(root, 'reviewer')
    await mkdir(dir)
    const path = join(dir, 'SKILL.md')
    await write(
      path,
      [
        '---',
        'name: code-reviewer',
        'description: Reviews diffs for defects',
        'capabilities: [read, write]',
        '---',
        '',
        'Review the diff carefully.',
        '',
      ].join('\n'),
    )

    const skill = await loadSkillFile(path)
    expect(skill).toEqual<Skill>({
      name: 'code-reviewer',
      description: 'Reviews diffs for defects',
      body: 'Review the diff carefully.',
      source: path,
      capabilities: ['read', 'write'],
    })
  })

  it('falls back to the containing directory name when frontmatter has no name', async () => {
    const root = await makeTmp()
    const dir = join(root, 'fallback-name')
    await mkdir(dir)
    const path = join(dir, 'SKILL.md')
    await write(path, ['---', 'description: no name here', '---', 'Body.'].join('\n'))

    const skill = await loadSkillFile(path)
    expect(skill.name).toBe('fallback-name')
    expect(skill.description).toBe('no name here')
    expect(skill.capabilities).toBeUndefined()
  })

  it('rejects a malformed SKILL.md with an error naming the file', async () => {
    const root = await makeTmp()
    const path = join(root, 'SKILL.md')
    await write(path, '---\nname: broken\nnever closed\n')

    await expect(loadSkillFile(path)).rejects.toThrow(path)
    await expect(loadSkillFile(path)).rejects.toThrow(/unterminated frontmatter/i)
  })
})

describe('loadProjectContext', () => {
  it('reads AGENTS.md and CLAUDE.md when both are present', async () => {
    const root = await makeTmp()
    await write(join(root, 'AGENTS.md'), 'agent rules\n')
    await write(join(root, 'CLAUDE.md'), 'claude rules\n')

    expect(await loadProjectContext(root)).toEqual({
      agents: 'agent rules\n',
      claude: 'claude rules\n',
    })
  })

  it('yields empty strings when both are absent', async () => {
    const root = await makeTmp()
    expect(await loadProjectContext(root)).toEqual({ agents: '', claude: '' })
  })
})

describe('loadSkillFolder', () => {
  it('produces the same Skill shape as an equivalent SKILL.md', async () => {
    const root = await makeTmp()

    // Folder layout.
    const folder = join(root, 'folder-skill')
    await mkdir(join(folder, 'prompts'), { recursive: true })
    await mkdir(join(folder, 'workflows'), { recursive: true })
    await write(
      join(folder, 'skill.json'),
      JSON.stringify({
        name: 'tester',
        description: 'Writes tests',
        capabilities: ['read', 'write'],
      }),
    )
    await write(join(folder, 'README.md'), 'Overview line.\n')
    await write(join(folder, 'prompts', '01-plan.md'), 'Plan the tests.\n')
    await write(join(folder, 'prompts', '02-write.md'), 'Write the tests.\n')
    await write(join(folder, 'workflows', 'ci.md'), 'not part of the body\n')

    // Equivalent single-file skill.
    const fileDir = join(root, 'file-skill')
    await mkdir(fileDir)
    const filePath = join(fileDir, 'SKILL.md')
    await write(
      filePath,
      [
        '---',
        'name: tester',
        'description: Writes tests',
        'capabilities:',
        '  - read',
        '  - write',
        '---',
        '',
        'Overview line.',
        '',
        'Plan the tests.',
        '',
        'Write the tests.',
        '',
      ].join('\n'),
    )

    const fromFolder = await loadSkillFolder(folder)
    const fromFile = await loadSkillFile(filePath)

    // Same keys, same values everywhere except the source path.
    expect(Object.keys(fromFolder).sort()).toEqual(Object.keys(fromFile).sort())
    expect({ ...fromFolder, source: '' }).toEqual({ ...fromFile, source: '' })
    expect(fromFolder.body).toBe('Overview line.\n\nPlan the tests.\n\nWrite the tests.')
    expect(fromFolder.source).toBe(join(folder, 'skill.json'))
  })

  it('handles a folder missing every optional subdirectory', async () => {
    const root = await makeTmp()
    const folder = join(root, 'bare')
    await mkdir(folder)
    await write(join(folder, 'skill.json'), JSON.stringify({ description: 'bare skill' }))

    const skill = await loadSkillFolder(folder)
    expect(skill).toEqual<Skill>({
      name: 'bare',
      description: 'bare skill',
      body: '',
      source: join(folder, 'skill.json'),
    })

    const layout = await loadSkillFolderLayout(folder)
    expect(layout).toEqual({
      readme: '',
      prompts: [],
      workflows: [],
      tools: [],
      tests: [],
      examples: [],
    })
  })

  it('rejects a malformed skill.json with an error naming the file', async () => {
    const root = await makeTmp()
    const folder = join(root, 'bad-json')
    await mkdir(folder)
    await write(join(folder, 'skill.json'), '{ not json')

    await expect(loadSkillFolder(folder)).rejects.toThrow(join(folder, 'skill.json'))
  })
})

describe('loadSkills', () => {
  it('loads both formats and never lets one bad skill block the others', async () => {
    const root = await makeTmp()

    const good = join(root, 'good')
    await mkdir(good)
    await write(
      join(good, 'SKILL.md'),
      ['---', 'name: good-skill', 'description: fine', '---', 'Do the thing.'].join('\n'),
    )

    const folder = join(root, 'folder')
    await mkdir(folder)
    await write(join(folder, 'skill.json'), JSON.stringify({ name: 'folder-skill' }))
    await write(join(folder, 'README.md'), 'From a folder.')

    const bad = join(root, 'bad')
    await mkdir(bad)
    const badPath = join(bad, 'SKILL.md')
    await write(badPath, ['---', 'meta:', '  nested: oops', '---', 'Body.'].join('\n'))

    const { skills, diagnostics } = await loadSkills(root)

    expect(skills.map((s) => s.name)).toEqual(['folder-skill', 'good-skill'])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain(badPath)
    expect(diagnostics[0]).toMatch(/nested maps are not supported/i)
  })

  it('loads a SKILL.md sitting directly in the scanned directory', async () => {
    const root = await makeTmp()
    await write(join(root, 'SKILL.md'), ['---', 'name: top-level', '---', 'Body.'].join('\n'))

    const { skills, diagnostics } = await loadSkills(root)
    expect(skills.map((s) => s.name)).toEqual(['top-level'])
    expect(diagnostics).toEqual([])
  })

  it('returns nothing for a directory that does not exist', async () => {
    const root = await makeTmp()
    expect(await loadSkills(join(root, 'nope'))).toEqual({ skills: [], diagnostics: [] })
  })
})
