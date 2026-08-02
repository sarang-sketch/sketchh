// Assemble three native package outputs into one deterministic release directory.
// Every byte is rehashed against its package-size manifest before copying. This
// script signs nothing; the tag-only workflow attests the validated output.

import { createHash } from 'node:crypto'
import {
  constants,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const platforms = Object.freeze({
  windows: { bundle: 'nsis', extension: '.exe' },
  macos: { bundle: 'dmg', extension: '.dmg' },
  linux: { bundle: 'appimage', extension: '.AppImage' },
})

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) throw new Error(`--${name} is required`)
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`)
  }
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(segment => segment === '' || segment === '..' || segment === '.')) {
    throw new Error(`${label} must be normalized and contained`)
  }
  return normalized
}

function within(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function digestPattern(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

async function sha256(path) {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`
}

async function filesUnder(root, found = []) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = resolve(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`release input contains a symbolic link: ${path}`)
    if (entry.isDirectory()) await filesUnder(path, found)
    else if (entry.isFile()) found.push(path)
    else throw new Error(`release input contains a special entry: ${path}`)
  }
  return found
}

function parseManifest(bytes, path) {
  let value
  try {
    value = JSON.parse(bytes)
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value?.version !== 1 || value?.passed !== true) {
    throw new Error(`${path} must be a passing package-size manifest version 1`)
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 1) {
    throw new Error(`${path} must describe exactly one installer artifact`)
  }
  if (!Number.isInteger(value.maxBytesExclusive) || value.maxBytesExclusive < 1) {
    throw new Error(`${path} has an invalid exclusive byte budget`)
  }
  return value
}

async function validatePlatform(inputRoot, allFiles, platform) {
  const expected = platforms[platform]
  const manifestName = `package-sizes-${platform}.json`
  const matches = allFiles.filter(path => basename(path) === manifestName)
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${manifestName}, found ${matches.length}`)
  }

  const manifestPath = matches[0]
  const manifestBytes = await readFile(manifestPath)
  const manifest = parseManifest(manifestBytes.toString('utf8'), manifestPath)
  if (manifest.platform !== platform || manifest.bundle !== expected.bundle) {
    throw new Error(`${manifestPath} identity does not match ${platform}/${expected.bundle}`)
  }
  const row = manifest.artifacts[0]
  const sourceRelative = safeRelative(row?.path, `${manifestPath}.artifacts[0].path`)
  if (!sourceRelative.endsWith(expected.extension)) {
    throw new Error(`${platform} installer must end with ${expected.extension}`)
  }
  if (!Number.isInteger(row.bytes) || row.bytes < 1 || !digestPattern(row.sha256)) {
    throw new Error(`${manifestPath} has invalid artifact bytes or digest`)
  }
  if (row.bytes >= manifest.maxBytesExclusive || manifest.largestBytes !== row.bytes) {
    throw new Error(`${manifestPath} does not satisfy its strict package budget`)
  }

  const artifactPath = resolve(dirname(manifestPath), ...sourceRelative.split('/'))
  if (!within(dirname(manifestPath), artifactPath) || !within(inputRoot, artifactPath)) {
    throw new Error(`${manifestPath} artifact escapes its downloaded package root`)
  }
  const info = await stat(artifactPath).catch(() => null)
  if (!info?.isFile()) throw new Error(`missing ${platform} installer: ${artifactPath}`)
  const actualDigest = await sha256(artifactPath)
  if (info.size !== row.bytes || actualDigest !== row.sha256) {
    throw new Error(`${platform} installer bytes do not match ${manifestName}`)
  }
  return {
    platform,
    bundle: expected.bundle,
    artifactPath,
    filename: basename(artifactPath),
    bytes: info.size,
    sha256: actualDigest,
    manifestPath,
    manifestFilename: manifestName,
    manifestBytes,
    manifestSha256: await sha256(manifestPath),
    maxBytesExclusive: manifest.maxBytesExclusive,
  }
}

const inputRoot = resolve(option('input'))
const outputRoot = resolve(option('output'))
const tag = option('tag')
const commit = option('commit').toLowerCase()
const repository = option('repository')

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error('--tag must be a semantic version tag such as v1.2.3')
}
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit must be a full 40-character Git SHA')
const repositoryParts = repository.split('/')
if (
  repositoryParts.length !== 2 ||
  repositoryParts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
) {
  throw new Error('--repository must be owner/name')
}
const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'))
const desktopPackage = JSON.parse(
  await readFile(resolve(repoRoot, 'packages', 'desktop', 'package.json'), 'utf8'),
)
if (packageJson.version !== desktopPackage.version) {
  throw new Error(`root version ${packageJson.version} does not match desktop version ${desktopPackage.version}`)
}
if (tag !== `v${packageJson.version}`) {
  throw new Error(`tag ${tag} does not match package version ${packageJson.version}`)
}
if (within(inputRoot, outputRoot) || within(outputRoot, inputRoot)) {
  throw new Error('release input and output directories must not contain one another')
}
const outputExists = await stat(outputRoot).then(() => true, () => false)
if (outputExists) throw new Error(`release output already exists: ${outputRoot}`)

const allFiles = (await filesUnder(inputRoot)).sort()
const rows = []
for (const platform of Object.keys(platforms)) {
  rows.push(await validatePlatform(inputRoot, allFiles, platform))
}
const expectedInputs = new Set(rows.flatMap(row => [row.artifactPath, row.manifestPath]))
const unexpected = allFiles.filter(path => !expectedInputs.has(path))
if (unexpected.length > 0) {
  throw new Error(`release input contains unexpected files: ${unexpected.join(', ')}`)
}
const names = rows.flatMap(row => [row.filename, row.manifestFilename])
if (new Set(names).size !== names.length) throw new Error('release asset filenames must be unique')

const temporary = `${outputRoot}.${process.pid}.tmp`
await mkdir(dirname(outputRoot), { recursive: true })
await rm(temporary, { recursive: true, force: true })
await mkdir(temporary)
try {
  for (const row of rows) {
    await copyFile(row.artifactPath, resolve(temporary, row.filename), constants.COPYFILE_EXCL)
    await copyFile(row.manifestPath, resolve(temporary, row.manifestFilename), constants.COPYFILE_EXCL)
    const copiedArtifact = resolve(temporary, row.filename)
    const copiedManifest = resolve(temporary, row.manifestFilename)
    const copiedInfo = await stat(copiedArtifact)
    if (copiedInfo.size !== row.bytes || (await sha256(copiedArtifact)) !== row.sha256) {
      throw new Error(`copied ${row.platform} installer no longer matches validated bytes`)
    }
    if ((await sha256(copiedManifest)) !== row.manifestSha256) {
      throw new Error(`copied ${row.platform} size manifest no longer matches validated bytes`)
    }
  }

  const releaseManifest = {
    version: 1,
    tag,
    commit,
    repository,
    artifacts: rows.map(row => ({
      platform: row.platform,
      bundle: row.bundle,
      filename: row.filename,
      bytes: row.bytes,
      sha256: row.sha256,
      sizeManifest: {
        filename: row.manifestFilename,
        sha256: row.manifestSha256,
        maxBytesExclusive: row.maxBytesExclusive,
      },
    })),
  }
  const releaseManifestPath = resolve(temporary, 'release-manifest.json')
  await writeFile(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })

  const releaseFiles = (await filesUnder(temporary)).sort((a, b) => basename(a).localeCompare(basename(b)))
  const sums = []
  for (const path of releaseFiles) {
    const digest = (await sha256(path)).slice('sha256:'.length)
    sums.push(`${digest}  ${basename(path)}`)
  }
  await writeFile(resolve(temporary, 'SHA256SUMS'), `${sums.join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  await rename(temporary, outputRoot)
} catch (error) {
  await rm(temporary, { recursive: true, force: true }).catch(() => {})
  throw error
}

console.log(`release directory: ${outputRoot}`)
console.log(`tag: ${tag}; commit: ${commit}; repository: ${repository}`)
for (const row of rows) console.log(`${row.platform}: ${row.filename} ${row.bytes} ${row.sha256}`)
