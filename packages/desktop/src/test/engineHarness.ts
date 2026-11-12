// TEST-ONLY. A real-disk file layer and an in-process engine client, so a panel test
// can drive the REAL engine methods (fs-*, git-*, term-*) against a real temporary
// folder instead of a scripted double. Nothing under src/ outside tests imports this.
//
// `nodeFileIo` mirrors the Tauri commands' shape and refusals: paths are contained in
// the root, folders list before files, and dotfiles, node_modules, target and dist are
// skipped, as src-tauri/src/main.rs does.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { METHODS, type MethodContext } from '@sketch/core'

import type { FileIo } from '../editor/fileIo'
import { createEventBus, type EventHandler, type PingResult, type SketchClient } from '../lib/client'

function contained(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(resolve(root), absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `This file is outside the folder you have open in Sketch, so it cannot be reached from here:\n  file: ${path}\n  open folder: ${root}`,
    )
  }
  return absolute
}

export function nodeFileIo(): FileIo {
  return {
    async readFile(root, path) {
      return readFile(contained(root, path), 'utf8')
    },
    async writeFile(root, path, content) {
      const target = contained(root, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    },
    async readDir(root, path) {
      const dir = contained(root, path)
      const entries = await readdir(dir, { withFileTypes: true })
      return entries
        .filter((e) => !e.name.startsWith('.') && !['node_modules', 'target', 'dist'].includes(e.name))
        .map((e) => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.isDir ? -1 : 1))
    },
    async pickFolder() {
      return null
    },
  }
}

function methodContext(): MethodContext {
  return {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: process.env,
    cwd: () => process.cwd(),
  }
}

type Params = Record<string, unknown>

/** The engine, in process: every call dispatches the same METHODS the sidecar does. */
export function engineClient(overrides: Partial<SketchClient> = {}): SketchClient {
  const bus = createEventBus()
  const ctx = methodContext()
  const call = <T,>(method: string, params: object): Promise<T> => METHODS[method]!(params as Params, ctx) as Promise<T>
  const client: SketchClient = {
    transport: 'stdio',
    ping: (): Promise<PingResult> => Promise.resolve({ ok: true, version: 'test', transport: 'stdio' }),
    run: () => Promise.reject(new Error('no runs in this test')),
    reply: () => Promise.reject(new Error('no runs in this test')),
    cancel: () => Promise.reject(new Error('no runs in this test')),
    eval: () => Promise.resolve([]),
    subscribe: (handler: EventHandler) => bus.subscribe(handler),
    gitStatus: (p) => call('git-status', p),
    gitDiff: async (p) => (await call<{ diff: string }>('git-diff', p)).diff,
    gitStage: (p) => call('git-stage', p),
    gitUnstage: (p) => call('git-unstage', p),
    gitCommit: (p) => call('git-commit', p),
    gitDiscard: (p) => call('git-discard', p),
    gitBranches: (p) => call('git-branches', p),
    gitSwitch: (p) => call('git-switch', p),
    gitPush: (p) => call('git-push', p),
    gitPull: (p) => call('git-pull', p),
    gitFetch: (p) => call('git-fetch', p),
    gitLog: (p) => call('git-log', p),
    providerCatalog: () => Promise.reject(new Error('not used')),
    saveProviderSettings: () => Promise.reject(new Error('not used')),
    testProvider: () => Promise.reject(new Error('not used')),
    termStart: (p) => call('term-start', p),
    termRead: (p) => call('term-read', p),
    termWrite: (p) => call('term-write', p),
    termKill: (p) => call('term-kill', p),
    fsCreateFile: (p) => call('fs-create-file', p),
    fsCreateFolder: (p) => call('fs-create-folder', p),
    fsRename: (p) => call('fs-rename', { root: p.root, source: p.from, target: p.to }),
    fsDelete: (p) => call('fs-delete', p),
    ...overrides,
  }
  return client
}

/** Forward slashes, upper-case drive: the editor's canonical spelling of a temp path. */
export function canonical(path: string): string {
  const forward = path.split(sep).join('/')
  return /^[a-z]:\//.test(forward) ? forward[0]!.toUpperCase() + forward.slice(1) : forward
}
