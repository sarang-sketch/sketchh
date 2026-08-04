// The window's key-store seam: presence in, sentences out, never a value.
//
// The doubles here are shaped like the Rust side (validate the id, answer with a
// bool), because a double that answered with a key would be testing an interface this
// project deliberately does not have.
//
// Validates: Requirements 17.3, 27.3

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  describeKeyFailure,
  describeKeyState,
  readKeyStates,
  type KeyState,
  type KeyStore,
  type ProviderKeyPresence,
} from './keyStore'

const KEY = 'sk-ant-api03-DEADBEEFdeadbeef0123456789abcdefghij'
const HERE = dirname(fileURLToPath(import.meta.url))

function store(
  presence: (ids: string[]) => Promise<ProviderKeyPresence[]>,
): KeyStore {
  return {
    presence,
    save: async () => 'Windows Credential Manager',
    remove: async () => 'Windows Credential Manager',
  }
}

describe('reading key presence', () => {
  it('maps a presence answer onto stored / absent, naming the store', async () => {
    const states = await readKeyStates(
      store(async (ids) =>
        ids.map((id) => ({ id, hasKey: id === 'openai', store: 'Windows Credential Manager' })),
      ),
      ['openai', 'anthropic'],
    )

    expect(states['openai']).toEqual({ status: 'stored', store: 'Windows Credential Manager' })
    expect(states['anthropic']).toEqual({ status: 'absent', store: 'Windows Credential Manager' })
  })

  it('asks nothing when there is nothing to ask about', async () => {
    let called = false
    const states = await readKeyStates(
      store(async () => {
        called = true
        return []
      }),
      [],
    )
    expect(states).toEqual({})
    expect(called).toBe(false)
  })

  it('reports UNKNOWN, not absent, when the store cannot be reached', async () => {
    // The failure this prevents: a browser dev session showing "No key is stored" for
    // every provider, which is a guess presented as a fact (Requirement 27.3).
    const states = await readKeyStates(
      store(async () => {
        throw new Error("not running under Tauri: the native command 'list_providers' is unavailable.")
      }),
      ['openai', 'anthropic'],
    )

    for (const id of ['openai', 'anthropic']) {
      const state = states[id]!
      expect(state.status).toBe('unknown')
      expect(state.status === 'unknown' && state.reason).toMatch(
        /Keys are stored by the operating system/,
      )
    }
  })
})

describe('the sentences a user reads', () => {
  it('says which store, and that a stored key is never read back', () => {
    const stored: KeyState = { status: 'stored', store: 'the macOS Keychain' }
    expect(describeKeyState(stored)).toContain('the macOS Keychain')
    expect(describeKeyState(stored)).toMatch(/never read back/)

    const absent: KeyState = { status: 'absent', store: 'Windows Credential Manager' }
    expect(describeKeyState(absent)).toMatch(/No key is stored/)
    // And it is honest about what an unsaved key does: one request, then gone.
    expect(describeKeyState(absent)).toMatch(/next request only/)
  })

  it('has a sentence for every state, and none of them is empty', () => {
    const states: KeyState[] = [
      { status: 'unknown', reason: 'the store could not be asked' },
      { status: 'absent', store: 'x' },
      { status: 'stored', store: 'x' },
      { status: 'saving' },
      { status: 'removing' },
    ]
    for (const state of states) expect(describeKeyState(state).length).toBeGreaterThan(10)
    // Undefined means "not asked yet" and says so, rather than defaulting to absent.
    expect(describeKeyState(undefined)).toMatch(/Checking/)
  })

  it('names the operation and the provider in a failure, never the key', () => {
    for (const operation of ['read', 'save', 'remove'] as const) {
      const message = describeKeyFailure(operation, 'openai', new Error('os error 1312'))
      expect(message).toContain('openai')
      expect(message).toContain('os error 1312')
      expect(message).not.toContain(KEY)
    }
    // A machine with no keyring gets the OS's reason, not a shrug.
    expect(
      describeKeyFailure(
        'save',
        'openai',
        new Error('no operating system credential store is available: libsecret is not installed'),
      ),
    ).toMatch(/cannot be remembered/)
  })
})

describe('the seam has no way to read a key back (Requirement 17.3)', () => {
  const source = readFileSync(join(HERE, 'keyStore.ts'), 'utf8')
  const bridge = readFileSync(join(HERE, '..', 'ipc', 'bridge.ts'), 'utf8')
  const code = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  it('declares no read operation and invokes no read command', () => {
    const seam = code(source)
    // The interface is presence/save/remove. A `get` here would need a Rust command
    // that returns a key, and that command does not exist by design.
    expect(seam).not.toMatch(/\bget\s*\(/)
    expect(seam).not.toContain('get_api_key')
    expect(seam).not.toContain('read_api_key')

    // THE SETTINGS SEAM STAYS PRESENCE-ONLY. `resolve_api_key` exists for the run path
    // (Requirement 17.4), and this seam must not reach it: a panel that can resolve a key
    // is a panel that can render one.
    expect(seam).not.toContain('resolve_api_key')
    expect(seam).not.toContain('resolveProviderKey')
    expect(seam).not.toContain('resolveApiKeyForRun')

    const wrappers = code(bridge)
    expect(wrappers).not.toContain('get_api_key')
    expect(wrappers).not.toContain('read_api_key')
    // The four that do exist.
    expect(wrappers).toContain("invoke<ProviderKeyPresence[]>('list_providers'")
    expect(wrappers).toContain("invoke<string>('set_api_key'")
    expect(wrappers).toContain("invoke<string>('remove_api_key'")
    expect(wrappers).toContain("invoke<string | null>('resolve_api_key'")
  })

  it('has no state shape with room for a key value', () => {
    // `KeyState` is the only thing the UI stores about a key. If a variant ever grows
    // an `apiKey` or a `preview`, a value has entered the render tree.
    // `\r?\n` on both: this repo is checked out with CRLF on Windows, and a guard that
    // only matches LF would pass or fail by platform rather than by code.
    const declaration = /export type KeyState =[\s\S]*?\r?\n\s*\r?\n/.exec(source)
    expect(declaration).not.toBeNull()
    for (const forbidden of ['apiKey', 'key:', 'preview', 'masked', 'lastFour']) {
      expect(declaration![0], forbidden).not.toContain(forbidden)
    }
  })
})
