// Skill and project-context loading.
//
// Two on-disk formats are supported and both normalize to the SAME `Skill`
// shape, so nothing downstream can tell which one a skill came from:
//
//   1. `SKILL.md` — YAML-subset frontmatter (see ./frontmatter.ts) + markdown body.
//   2. A folder containing `skill.json`, with `README.md`, `prompts/`,
//      `workflows/`, `tools/`, `tests/`, and `examples/` alongside it.
//      `skill.json` supplies name/description/capabilities; `README.md` plus
//      the concatenated contents of `prompts/` supply the body. The remaining
//      subdirectories are part of the layout and are enumerated by
//      `loadSkillFolderLayout`, but they are not folded into the prompt body —
//      they are addressed by path at execution time.
//
// A malformed skill must never abort a run: `loadSkills` records a diagnostic
// naming the file and the problem, omits that skill, and keeps loading the rest.
//
// Only `node:fs/promises` and `node:path` are used. No glob, no YAML library.
//
// Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.6

import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { ProjectContext, Skill } from '../types.js'
import { parseFrontmatter } from './frontmatter.js'

const SKILL_FILE = 'SKILL.md'
const SKILL_MANIFEST = 'skill.json'
const README = 'README.md'
const PROMPTS = 'prompts'

/** The outcome of scanning a directory: what loaded, and what did not. */
export interface SkillLoadResult {
  skills: Skill[]
  diagnostics: string[]
}

/** The folder-layout inventory. Paths are absolute; missing dirs are empty. */
export interface SkillFolderLayout {
  readme: string
  prompts: string[]
  workflows: string[]
  tools: string[]
  tests: string[]
  examples: string[]
}

/** Read a file, or return null when it does not exist. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** List files in a subdirectory, sorted; an absent directory lists as empty. */
async function listFiles(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(dir, e.name))
    .sort()
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Normalize a frontmatter or manifest capabilities value to string[]. */
function normalizeCapabilities(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === 'string').map((v) => v.trim())
    return out.filter((v) => v !== '')
  }
  if (typeof value === 'string') {
    const out = value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '')
    return out.length > 0 ? out : undefined
  }
  return undefined
}

/**
 * Load one `SKILL.md` into a `Skill`.
 *
 * `name` comes from frontmatter and falls back to the containing directory
 * name. `body` is everything after the frontmatter block. `source` is `path`.
 *
 * Throws an `Error` whose message names the file and the problem when the
 * frontmatter is malformed. `loadSkills` catches this and turns it into a
 * diagnostic; direct callers get a loud failure.
 */
export async function loadSkillFile(path: string): Promise<Skill> {
  const text = await readFile(path, 'utf8')
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) {
    throw new Error(`${path}: ${parsed.error}`)
  }

  const { data, body } = parsed

  const nameValue = data['name']
  const fromFrontmatter = typeof nameValue === 'string' ? nameValue.trim() : ''
  const name = fromFrontmatter !== '' ? fromFrontmatter : basename(dirname(path))

  const descriptionValue = data['description']
  const description = typeof descriptionValue === 'string' ? descriptionValue.trim() : ''

  const capabilities = normalizeCapabilities(data['capabilities'])

  const skill: Skill = { name, description, body: body.trim(), source: path }
  if (capabilities && capabilities.length > 0) skill.capabilities = capabilities
  return skill
}

/**
 * Read `AGENTS.md` and `CLAUDE.md` from a project root. Missing files yield
 * empty strings, never errors — most projects have neither.
 */
export async function loadProjectContext(root: string): Promise<ProjectContext> {
  const [agents, claude] = await Promise.all([
    readIfPresent(join(root, 'AGENTS.md')),
    readIfPresent(join(root, 'CLAUDE.md')),
  ])
  return { agents: agents ?? '', claude: claude ?? '' }
}

/**
 * Enumerate the folder layout. Every optional subdirectory is tolerated as
 * absent; `readme` is the empty string when there is no `README.md`.
 */
export async function loadSkillFolderLayout(dir: string): Promise<SkillFolderLayout> {
  const [readme, prompts, workflows, tools, tests, examples] = await Promise.all([
    readIfPresent(join(dir, README)),
    listFiles(join(dir, PROMPTS)),
    listFiles(join(dir, 'workflows')),
    listFiles(join(dir, 'tools')),
    listFiles(join(dir, 'tests')),
    listFiles(join(dir, 'examples')),
  ])
  return { readme: readme ?? '', prompts, workflows, tools, tests, examples }
}

/**
 * Load the `skill.json` folder layout into the same `Skill` shape a `SKILL.md`
 * produces. `source` is the path to the manifest.
 *
 * Throws an `Error` naming the file when `skill.json` is missing or unparsable.
 */
export async function loadSkillFolder(dir: string): Promise<Skill> {
  const manifestPath = join(dir, SKILL_MANIFEST)
  const text = await readIfPresent(manifestPath)
  if (text === null) {
    throw new Error(`${manifestPath}: missing ${SKILL_MANIFEST}`)
  }

  let manifest: Record<string, unknown>
  try {
    const raw: unknown = JSON.parse(text)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('expected a JSON object')
    }
    manifest = raw as Record<string, unknown>
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(`${manifestPath}: malformed ${SKILL_MANIFEST}: ${reason}`)
  }

  const nameValue = manifest['name']
  const name =
    typeof nameValue === 'string' && nameValue.trim() !== '' ? nameValue.trim() : basename(dir)

  const descriptionValue = manifest['description']
  const description = typeof descriptionValue === 'string' ? descriptionValue.trim() : ''

  const capabilities = normalizeCapabilities(manifest['capabilities'])

  const layout = await loadSkillFolderLayout(dir)
  const parts: string[] = []
  if (layout.readme.trim() !== '') parts.push(layout.readme.trim())
  for (const prompt of layout.prompts) {
    const content = await readIfPresent(prompt)
    if (content !== null && content.trim() !== '') parts.push(content.trim())
  }

  const skill: Skill = {
    name,
    description,
    body: parts.join('\n\n'),
    source: manifestPath,
  }
  if (capabilities && capabilities.length > 0) skill.capabilities = capabilities
  return skill
}

/**
 * Discover both skill formats directly under `dir`.
 *
 * Recognized:
 *   - `dir/SKILL.md`
 *   - `dir/<child>/SKILL.md`
 *   - `dir/<child>/skill.json`
 *
 * A skill that fails to load contributes a diagnostic naming its file and the
 * problem, and is omitted from `skills`. One bad skill never prevents the
 * others from loading. A missing `dir` is not an error — it just has no skills.
 */
export async function loadSkills(dir: string): Promise<SkillLoadResult> {
  const skills: Skill[] = []
  const diagnostics: string[] = []

  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { skills, diagnostics }
  }

  const record = async (load: () => Promise<Skill>): Promise<void> => {
    try {
      skills.push(await load())
    } catch (e) {
      diagnostics.push(e instanceof Error ? e.message : String(e))
    }
  }

  for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name)

    if (entry.isFile()) {
      if (entry.name.toLowerCase() === SKILL_FILE.toLowerCase()) {
        await record(() => loadSkillFile(full))
      }
      continue
    }

    if (!entry.isDirectory() && !(await isDirectory(full))) continue

    if (await isFile(join(full, SKILL_FILE))) {
      await record(() => loadSkillFile(join(full, SKILL_FILE)))
      continue
    }
    if (await isFile(join(full, SKILL_MANIFEST))) {
      await record(() => loadSkillFolder(full))
    }
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { skills, diagnostics }
}
