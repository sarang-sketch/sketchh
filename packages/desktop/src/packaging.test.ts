import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
const repo = path.resolve(__dirname, '../../..')
const script = path.join(repo, 'packages/desktop/scripts/check-package-size.mjs')

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function fixture(maxBytesExclusive = 10) {
  const root = mkdtempSync(path.join(tmpdir(), 'sketch-package-'))
  roots.push(root)
  const bundleRoot = path.join(root, 'bundle')
  const artifactDir = path.join(bundleRoot, 'nsis')
  mkdirSync(artifactDir, { recursive: true })
  const budget = path.join(root, 'budgets.json')
  const manifest = path.join(root, 'manifest.json')
  writeFileSync(budget, JSON.stringify({
    version: 1, unit: 'bytes', platforms: {
      windows: { bundle: 'nsis', artifactDir: 'nsis', extensions: ['.exe'], maxBytesExclusive },
    },
  }))
  const run = () => spawnSync(process.execPath, [script, '--platform', 'windows', '--bundle-root', bundleRoot,
    '--budget-file', budget, '--manifest', manifest], { encoding: 'utf8' })
  return { artifactDir, manifest, run }
}

describe('Phase 12.1 package size gate', () => {
  it('refuses missing artifacts and treats the documented ceiling as exclusive', () => {
    const test = fixture()
    expect(test.run().status).not.toBe(0)
    writeFileSync(path.join(test.artifactDir, 'Sketch.exe'), Buffer.alloc(9))
    expect(test.run().status).toBe(0)
    const report = JSON.parse(readFileSync(test.manifest, 'utf8'))
    expect(report.largestBytes).toBe(9)
    expect(report.maxBytesExclusive).toBe(10)
    expect(report.passed).toBe(true)
    writeFileSync(path.join(test.artifactDir, 'Sketch.exe'), Buffer.alloc(10))
    const boundary = test.run()
    expect(boundary.status).not.toBe(0)
    expect(boundary.stderr).toContain('must be < 10 bytes')
  })

  it('ships native jobs for all three operating systems with no renamed foreign runtime', () => {
    const workflow = readFileSync(path.join(repo, '.github/workflows/package.yml'), 'utf8')
    for (const platform of ['windows', 'macos', 'linux']) {
      expect(workflow).toContain(`platform: ${platform}`)
      expect(workflow).toContain(`package:${platform}`)
      expect(workflow).toContain(`--platform \${{ matrix.platform }}`)
    }
    expect(workflow).toContain('npm run verify:sidecar')
    expect(workflow).toContain('npm run package:size')
    expect(workflow).toContain('actions/upload-artifact@v4')
    expect(workflow).not.toContain('SKETCH_TARGET_TRIPLE')
  })

  it('pins the PRD budget and keeps the Tauri 2 configuration packageable', () => {
    const budgets = JSON.parse(readFileSync(path.join(repo, 'packages/desktop/packaging/budgets.json'), 'utf8'))
    for (const platform of ['windows', 'macos', 'linux']) {
      expect(budgets.platforms[platform].maxBytesExclusive).toBe(100_000_000)
    }
    const tauri = JSON.parse(readFileSync(path.join(repo, 'packages/desktop/src-tauri/tauri.conf.json'), 'utf8'))
    expect(tauri.identifier).not.toMatch(/\.app$/)
    expect(tauri.app.windows[0]).not.toHaveProperty('name')
    const documentation = readFileSync(path.join(repo, 'PACKAGING.md'), 'utf8')
    expect(documentation).toContain('strictly less than 100,000,000 bytes')
    expect(documentation).toContain('only a successful native job')
    expect(documentation).toContain('Task 12.1 remains evidence-gated')
  })
})