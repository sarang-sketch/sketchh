// Persisted capability authority for installed skills, plus explicit promotion of
// a measured training winner. Registry grants, never skill-authored declarations,
// are what production runs enforce.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { parseCapabilities, type CapabilitySet } from '../capabilities/index.js'
import { loadSkillFile, loadSkills } from '../skills/loader.js'
import type { Skill } from '../types.js'
import { hashSkillDirectory } from './hash.js'

export const INSTALLED_GRANT_VERSION = 1
export const INSTALLED_GRANTS_DIRECTORY = '.grants'

export interface InstalledSkillGrant {
  version: typeof INSTALLED_GRANT_VERSION
  name: string
  sourceDigest: string
  activeDigest: string
  capabilities: CapabilitySet
}

export interface InstalledGrantResult {
  ok: boolean
  grant: InstalledSkillGrant | null
  reason: string | null
}

export function isSafeSkillName(name: string): boolean {
  return (
    name.trim() === name &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  )
}

export function installedSkillsDir(projectRoot: string): string {
  return join(projectRoot, '.sketch', 'skills')
}

export function installedSkillGrantPath(projectRoot: string, name: string): string {
  if (!isSafeSkillName(name)) throw new Error(`unsafe skill name ${JSON.stringify(name)}`)
  return join(installedSkillsDir(projectRoot), INSTALLED_GRANTS_DIRECTORY, `${name}.json`)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

async function atomicWrite(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function serializeGrant(grant: InstalledSkillGrant): string {
  return `${JSON.stringify({
    version: INSTALLED_GRANT_VERSION,
    name: grant.name,
    sourceDigest: grant.sourceDigest,
    activeDigest: grant.activeDigest,
    capabilities: [...grant.capabilities],
  }, null, 2)}\n`
}

export async function writeInstalledSkillGrant(
  projectRoot: string,
  grant: InstalledSkillGrant,
  writeBytes?: (path: string, bytes: Buffer) => Promise<void>,
): Promise<string> {
  if (!isSafeSkillName(grant.name)) throw new Error(`unsafe skill name ${JSON.stringify(grant.name)}`)
  if (!isDigest(grant.sourceDigest) || !isDigest(grant.activeDigest)) {
    throw new Error(`refusing to persist an invalid digest for ${grant.name}`)
  }
  const parsed = parseCapabilities(grant.capabilities)
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const path = installedSkillGrantPath(projectRoot, grant.name)
  const bytes = Buffer.from(serializeGrant({ ...grant, capabilities: parsed.capabilities }), 'utf8')
  if (writeBytes) await writeBytes(path, bytes)
  else await atomicWrite(path, bytes)
  return path
}

function parseGrant(text: string, expectedName: string): InstalledSkillGrant {
  const raw: unknown = JSON.parse(text)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('grant must be a JSON object')
  }
  const value = raw as Record<string, unknown>
  if (value['version'] !== INSTALLED_GRANT_VERSION) throw new Error('unsupported grant version')
  if (value['name'] !== expectedName) throw new Error('grant name does not match the skill')
  if (!isDigest(value['sourceDigest']) || !isDigest(value['activeDigest'])) {
    throw new Error('grant carries an invalid digest')
  }
  if (!Array.isArray(value['capabilities']) || !value['capabilities'].every((item) => typeof item === 'string')) {
    throw new Error('grant capabilities must be strings')
  }
  const parsed = parseCapabilities(value['capabilities'] as string[])
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return {
    version: INSTALLED_GRANT_VERSION,
    name: expectedName,
    sourceDigest: value['sourceDigest'],
    activeDigest: value['activeDigest'],
    capabilities: parsed.capabilities,
  }
}

export function isManagedInstalledSkill(projectRoot: string, skill: Skill): boolean {
  if (!isSafeSkillName(skill.name)) return false
  return resolve(dirname(skill.source)) === resolve(installedSkillsDir(projectRoot), skill.name)
}

/** Read the registry-approved grant and bind it to the bytes normal runs load. */
export async function readInstalledSkillGrant(
  projectRoot: string,
  skill: Skill,
): Promise<InstalledGrantResult> {
  if (!isManagedInstalledSkill(projectRoot, skill)) {
    return { ok: false, grant: null, reason: `${skill.name} is not in the managed installed-skill directory` }
  }

  let grant: InstalledSkillGrant
  const path = installedSkillGrantPath(projectRoot, skill.name)
  try {
    grant = parseGrant(await readFile(path, 'utf8'), skill.name)
  } catch (error) {
    return {
      ok: false,
      grant: null,
      reason: `no valid persisted registry grant for ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const active = await hashSkillDirectory(dirname(skill.source)).catch(() => null)
  if (active === null || active.digest !== grant.activeDigest) {
    return {
      ok: false,
      grant: null,
      reason: `installed bytes for ${skill.name} do not match its persisted active digest; capabilities are denied`,
    }
  }
  return { ok: true, grant, reason: null }
}

export function trainingArtifactPath(projectRoot: string, name: string): string {
  if (!isSafeSkillName(name)) throw new Error(`unsafe skill name ${JSON.stringify(name)}`)
  return join(projectRoot, '.sketch', 'training', name, 'best_skill.md')
}

export interface PromoteSkillResult {
  ok: boolean
  name: string
  path?: string
  digest?: string
  granted?: CapabilitySet
  reason: string | null
}

/** Promote a reviewed training artifact while preserving the installed grant. */
export async function promoteInstalledSkill(
  projectRoot: string,
  name: string,
): Promise<PromoteSkillResult> {
  if (!isSafeSkillName(name)) return { ok: false, name, reason: 'skill name is unsafe' }
  const loaded = await loadSkills(installedSkillsDir(projectRoot))
  const current = loaded.skills.find((skill) => skill.name === name)
  if (!current) {
    return { ok: false, name, reason: `no installed skill named ${JSON.stringify(name)}` }
  }

  const authority = await readInstalledSkillGrant(projectRoot, current)
  if (!authority.ok || authority.grant === null) {
    return { ok: false, name, reason: authority.reason }
  }

  const artifact = trainingArtifactPath(projectRoot, name)
  let candidate: Skill
  let bytes: Buffer
  try {
    candidate = await loadSkillFile(artifact)
    bytes = await readFile(artifact)
  } catch (error) {
    return {
      ok: false,
      name,
      reason: `cannot load the measured training artifact ${artifact}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (candidate.name !== name) {
    return { ok: false, name, reason: `training artifact names ${candidate.name}, expected ${name}` }
  }
  const currentCapabilities = JSON.stringify([...(current.capabilities ?? [])].sort())
  const candidateCapabilities = JSON.stringify([...(candidate.capabilities ?? [])].sort())
  if (candidateCapabilities !== currentCapabilities) {
    return { ok: false, name, reason: 'training artifact attempted to change declared capabilities' }
  }

  const target = join(installedSkillsDir(projectRoot), name, 'SKILL.md')
  await atomicWrite(target, bytes)
  const activeDigest = (await hashSkillDirectory(dirname(target))).digest
  await writeInstalledSkillGrant(projectRoot, {
    ...authority.grant,
    activeDigest,
  })
  return {
    ok: true,
    name,
    path: target,
    digest: activeDigest,
    granted: authority.grant.capabilities,
    reason: null,
  }
}
