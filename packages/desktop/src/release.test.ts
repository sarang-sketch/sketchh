import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
const repo = path.resolve(__dirname, '../../..')
const script = path.join(repo, 'packages/desktop/scripts/assemble-release.mjs')
const commit = '0123456789abcdef0123456789abcdef01234567'
const definitions = {
  windows: { bundle: 'nsis', dir: 'nsis', file: 'Sketch_0.1.0_x64-setup.exe' },
  macos: { bundle: 'dmg', dir: 'dmg', file: 'Sketch_0.1.0_x64.dmg' },
  linux: { bundle: 'appimage', dir: 'appimage', file: 'Sketch_0.1.0_amd64.AppImage' },
} as const

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function sha(bytes: Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sketch-release-'))
  roots.push(root)
  const input = path.join(root, 'input')
  const output = path.join(root, 'output')
  mkdirSync(input)
  for (const [platform, row] of Object.entries(definitions)) {
    const artifactRoot = path.join(input, `sketch-${platform}-${commit}`)
    const bytes = Buffer.from(`native-${platform}-artifact\n`)
    mkdirSync(path.join(artifactRoot, row.dir), { recursive: true })
    writeFileSync(path.join(artifactRoot, row.dir, row.file), bytes)
    writeFileSync(path.join(artifactRoot, `package-sizes-${platform}.json`), JSON.stringify({
      version: 1,
      platform,
      bundle: row.bundle,
      maxBytesExclusive: 100_000_000,
      largestBytes: bytes.length,
      passed: true,
      artifacts: [{ path: `${row.dir}/${row.file}`, bytes: bytes.length, sha256: sha(bytes) }],
    }))
  }

  const run = () => spawnSync(process.execPath, [
    script,
    '--input', input,
    '--output', output,
    '--tag', 'v0.1.0',
    '--commit', commit,
    '--repository', 'owner/sketch',
  ], { encoding: 'utf8' })
  return { root, input, output, run }
}

function platformRoot(test: ReturnType<typeof fixture>, platform: keyof typeof definitions) {
  return path.join(test.input, `sketch-${platform}-${commit}`)
}

describe('Phase 12.3 release assembly', () => {
  it('re-hashes exactly one package per platform and emits deterministic release metadata', () => {
    const test = fixture()
    const first = test.run()
    expect(first.status, first.stderr).toBe(0)

    const manifest = JSON.parse(readFileSync(path.join(test.output, 'release-manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      version: 1,
      tag: 'v0.1.0',
      commit,
      repository: 'owner/sketch',
    })
    expect(manifest.artifacts.map((row: { platform: string }) => row.platform)).toEqual([
      'windows', 'macos', 'linux',
    ])
    expect(readFileSync(path.join(test.output, 'SHA256SUMS'), 'utf8').trim().split('\n')).toHaveLength(7)
    expect(Object.keys(manifest)).not.toContain('generatedAt')
  })

  it('refuses an installer changed after its package-size manifest was written', () => {
    const test = fixture()
    const row = definitions.windows
    const artifact = path.join(platformRoot(test, 'windows'), row.dir, row.file)
    const changed = readFileSync(artifact)
    changed[0] = changed[0]! ^ 0xff
    writeFileSync(artifact, changed)
    const result = test.run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('installer bytes do not match')
  })

  it('refuses missing and duplicate platform manifests', () => {
    const missing = fixture()
    rmSync(path.join(platformRoot(missing, 'linux'), 'package-sizes-linux.json'))
    expect(missing.run().status).not.toBe(0)

    const duplicate = fixture()
    const extra = path.join(duplicate.input, 'duplicate')
    mkdirSync(extra)
    cpSync(
      path.join(platformRoot(duplicate, 'macos'), 'package-sizes-macos.json'),
      path.join(extra, 'package-sizes-macos.json'),
    )
    const result = duplicate.run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('expected exactly one package-sizes-macos.json, found 2')
  })

  it('refuses traversal in an artifact path and leaves no output', () => {
    const test = fixture()
    const manifestPath = path.join(platformRoot(test, 'windows'), 'package-sizes-windows.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.artifacts[0].path = '../outside.exe'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = test.run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('must be normalized and contained')
    expect(() => readFileSync(path.join(test.output, 'release-manifest.json'))).toThrow()
  })

  it('binds release identity to semver, the package version, a full commit, and repository', () => {
    const test = fixture()
    const args = [script, '--input', test.input, '--output', test.output]
    const run = (...identity: string[]) => spawnSync(process.execPath, [...args, ...identity], { encoding: 'utf8' })
    expect(run('--tag', 'latest', '--commit', commit, '--repository', 'owner/sketch').status).not.toBe(0)
    expect(run('--tag', 'v9.9.9', '--commit', commit, '--repository', 'owner/sketch').stderr)
      .toContain('does not match package version')
    expect(run('--tag', 'v0.1.0', '--commit', 'short', '--repository', 'owner/sketch').status).not.toBe(0)
    expect(run('--tag', 'v0.1.0', '--commit', commit, '--repository', '../escape').status).not.toBe(0)
  })
})

describe('Phase 12.3 release workflow policy', () => {
  it('publishes only a successful version-tag matrix with narrowly scoped provenance permissions', () => {
    const workflow = readFileSync(path.join(repo, '.github/workflows/package.yml'), 'utf8')
    const release = workflow.slice(workflow.indexOf('\n  release:'))
    expect(release).toContain('needs: package')
    expect(release).toContain("github.event_name == 'push'")
    expect(release).toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(release).toContain('contents: write')
    expect(release).toContain('id-token: write')
    expect(release).toContain('attestations: write')
    expect(release).toContain('actions/attest-build-provenance@v3')
    expect(release).toContain('gh attestation verify')
    expect(release).toContain('gh release create')
    expect(release).toContain('--verify-tag')
    expect(release).not.toContain('if: always()')
    expect(workflow.slice(0, workflow.indexOf('\n  release:'))).toContain('contents: read')
  })
})
