import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`)
  }
  const segments = value.replaceAll('\\', '/').split('/')
  if (segments.includes('..')) throw new Error(`${label} must not escape its root`)
  return value
}

function parseBudget(value, platform) {
  if (value?.version !== 1 || value?.unit !== 'bytes') throw new Error('unsupported package budget schema')
  const row = value.platforms?.[platform]
  if (!row || typeof row !== 'object') throw new Error(`no package budget for platform ${platform}`)
  safeRelative(row.artifactDir, `${platform}.artifactDir`)
  if (!Array.isArray(row.extensions) || row.extensions.length === 0 ||
      row.extensions.some(extension => typeof extension !== 'string' || !extension.startsWith('.'))) {
    throw new Error(`${platform}.extensions must be a non-empty suffix list`)
  }
  if (!Number.isInteger(row.maxBytesExclusive) || row.maxBytesExclusive < 1) {
    throw new Error(`${platform}.maxBytesExclusive must be a positive integer`)
  }
  if (typeof row.bundle !== 'string' || row.bundle.trim() === '') throw new Error(`${platform}.bundle is required`)
  return row
}

async function collectFiles(root, extensions, found = []) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`package output contains a symbolic link: ${path}`)
    if (entry.isDirectory()) await collectFiles(path, extensions, found)
    else if (entry.isFile() && extensions.some(extension => entry.name.endsWith(extension))) found.push(path)
    else if (!entry.isFile()) throw new Error(`package output contains a special entry: ${path}`)
  }
  return found
}

const platform = option('platform')
if (!platform) throw new Error('--platform is required')
const bundleRoot = resolve(option('bundle-root', join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle')))
const budgetFile = resolve(option('budget-file', join(desktopRoot, 'packaging', 'budgets.json')))
const budgetConfig = JSON.parse(await readFile(budgetFile, 'utf8'))
const budget = parseBudget(budgetConfig, platform)
const artifactRoot = join(bundleRoot, safeRelative(budget.artifactDir, `${platform}.artifactDir`))
const paths = (await collectFiles(artifactRoot, budget.extensions)).sort()
if (paths.length === 0) throw new Error(`no ${platform} ${budget.bundle} artifact found under ${artifactRoot}`)

const artifacts = []
for (const path of paths) {
  const info = await stat(path)
  const digest = createHash('sha256').update(await readFile(path)).digest('hex')
  artifacts.push({
    path: relative(bundleRoot, path).split(sep).join('/'),
    bytes: info.size,
    sha256: `sha256:${digest}`,
  })
}
const largestBytes = Math.max(...artifacts.map(artifact => artifact.bytes))
const passed = largestBytes < budget.maxBytesExclusive
const manifest = {
  version: 1,
  measuredAt: new Date().toISOString(),
  platform,
  bundle: budget.bundle,
  basis: budgetConfig.basis ?? null,
  maxBytesExclusive: budget.maxBytesExclusive,
  largestBytes,
  passed,
  artifacts,
}
const manifestPath = resolve(option('manifest', join(bundleRoot, `package-sizes-${platform}.json`)))
await mkdir(dirname(manifestPath), { recursive: true })
const temporary = `${manifestPath}.${process.pid}.tmp`
try {
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rm(manifestPath, { force: true })
  await rename(temporary, manifestPath)
} catch (error) {
  await rm(temporary, { force: true }).catch(() => {})
  throw error
}

for (const artifact of artifacts) {
  console.log(`${artifact.path}: ${artifact.bytes} bytes (${artifact.sha256})`)
}
console.log(`largest: ${largestBytes} bytes; budget: < ${budget.maxBytesExclusive} bytes`)
console.log(`manifest: ${manifestPath}`)
if (!passed) throw new Error(`${platform} package is ${largestBytes} bytes; must be < ${budget.maxBytesExclusive} bytes`)
