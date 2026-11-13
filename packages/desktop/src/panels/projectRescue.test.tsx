// Project Rescue: the analyzer over fixtures (never the real repo), plus the
// panel rendering those findings. Secrets are named, never quoted.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { analyzeProject, type RescueFile } from './projectRescue'
import { ProjectRescue } from './ProjectRescue'

afterEach(cleanup)

const pkg: RescueFile = { path: 'package.json', size: 400, content: '{"name": "x"}' }

describe('analyzeProject', () => {
  it('flags a lockfile without package.json as an error', () => {
    const { findings, summary } = analyzeProject({
      files: [{ path: 'package-lock.json', size: 1000, content: '{}' }],
    })
    expect(summary.error).toBe(1)
    expect(findings[0].title).toContain('Lockfile without package.json')
  })

  it('warns when package.json has no lockfile, and stays quiet with one', () => {
    const noLock = analyzeProject({ files: [pkg] })
    expect(noLock.findings.some((f) => f.title === 'No lockfile')).toBe(true)
    const withLock = analyzeProject({
      files: [pkg, { path: 'pnpm-lock.yaml', size: 10, content: '' }],
    })
    expect(withLock.findings.some((f) => f.title === 'No lockfile')).toBe(false)
  })

  it('flags files over 1 MB and counts TODO/FIXME per file', () => {
    const { findings } = analyzeProject({
      files: [
        pkg,
        { path: 'package-lock.json', size: 10, content: '' },
        { path: 'assets/big.bin', size: 2_500_000 },
        {
          path: 'src/a.ts',
          size: 100,
          content: '// TODO one\n// TODO two\n// FIXME three\n// TODO four\n// TODO five\n',
        },
        { path: 'src/b.ts', size: 50, content: '// TODO just one\n' },
      ],
    })
    const large = findings.find((f) => f.title === 'Large file')
    expect(large?.file).toBe('assets/big.bin')
    expect(large?.detail).toContain('2.5 MB')
    const many = findings.find((f) => f.file === 'src/a.ts')
    expect(many?.severity).toBe('warn')
    expect(many?.detail).toContain('4 TODO(s), 1 FIXME(s)')
    const one = findings.find((f) => f.file === 'src/b.ts')
    expect(one?.severity).toBe('info')
  })

  it('flags extensionless files and binary files, and skips TODO scanning for binary content', () => {
    const { findings } = analyzeProject({
      files: [
        pkg,
        { path: 'package-lock.json', size: 10, content: '' },
        { path: 'Makefile', size: 20, content: 'all:\n' },
        { path: 'logo.png', size: 5000 },
        { path: 'weird.dat', size: 10, content: 'a\0b // TODO hidden\n' },
      ],
    })
    expect(findings.some((f) => f.title === 'File with no extension' && f.file === 'Makefile')).toBe(true)
    expect(findings.some((f) => f.title === 'Binary file' && f.file === 'logo.png')).toBe(true)
    expect(findings.some((f) => f.title === 'Binary-looking content' && f.file === 'weird.dat')).toBe(true)
    // The TODO inside binary-looking content is not reported.
    expect(findings.some((f) => f.file === 'weird.dat' && f.title.includes('TODO'))).toBe(false)
  })

  it('names a .env file as a secret risk and never shows its content', () => {
    const secret = 'API_KEY=super-secret-value'
    const { findings } = analyzeProject({
      files: [pkg, { path: 'package-lock.json', size: 10, content: '' }, { path: '.env', size: 30, content: secret }],
    })
    const env = findings.find((f) => f.title.startsWith('Secret risk'))
    expect(env?.severity).toBe('error')
    expect(env?.file).toBe('.env')
    expect(JSON.stringify(findings)).not.toContain('super-secret-value')
  })

  it('flags empty src dirs only when the caller passes directory paths', () => {
    const withDirs = analyzeProject({
      files: [pkg, { path: 'package-lock.json', size: 10, content: '' }, { path: 'src/app.ts', size: 10 }],
      dirs: ['src', 'src/empty-module'],
    })
    expect(withDirs.findings.some((f) => f.title === 'Empty src directory' && f.file === 'src/empty-module')).toBe(true)
    expect(withDirs.findings.some((f) => f.file === 'src')).toBe(false)
    const withoutDirs = analyzeProject({ files: [pkg] })
    expect(withoutDirs.findings.some((f) => f.title === 'Empty src directory')).toBe(false)
  })

  it('reads git status text when supplied', () => {
    const { findings } = analyzeProject({ files: [pkg], gitStatus: 'fatal: not a git repository' })
    expect(findings.some((f) => f.title === 'Not a git repository')).toBe(true)
  })

  it('sorts errors before warnings before notes and summarises counts', () => {
    const { findings, summary } = analyzeProject({
      files: [{ path: '.env', size: 5 }, { path: 'huge.dat', size: 2_000_000 }],
    })
    const order = findings.map((f) => f.severity)
    const sorted = [...order].sort((a, b) => ({ error: 0, warn: 1, info: 2 })[a] - ({ error: 0, warn: 1, info: 2 })[b])
    expect(order).toEqual(sorted)
    expect(summary.total).toBe(summary.error + summary.warn + summary.info)
    expect(summary.error).toBeGreaterThan(0)
  })
})

describe('ProjectRescue panel', () => {
  it('renders findings grouped by severity', () => {
    render(
      <ProjectRescue
        files={[
          pkg,
          { path: 'package-lock.json', size: 10, content: '' },
          { path: '.env', size: 5, content: 'K=v' },
        ]}
      />,
    )
    expect(screen.getByText(/1 error\(s\)/)).toBeTruthy()
    expect(screen.getByLabelText('Errors')).toBeTruthy()
    expect(screen.getByText('Secret risk: .env file present')).toBeTruthy()
    expect(screen.queryByText(/super-secret/)).toBeNull()
  })

  it('shows an empty state when no files are passed', () => {
    render(<ProjectRescue files={[]} />)
    expect(screen.getByText('No files to analyse')).toBeTruthy()
  })

  it('says so when the tree is clean', () => {
    render(
      <ProjectRescue
        files={[pkg, { path: 'package-lock.json', size: 10, content: '' }, { path: 'src/a.ts', size: 10, content: 'export {}\n' }]}
      />,
    )
    expect(screen.getByText('No issues found')).toBeTruthy()
  })
})
