// The `SecretStore` seam: what the engine may do with a secret, and what it must not
// be ABLE to do.
//
// The interesting assertions here are the negative ones. Requirement 17.3 is not
// "core delegates storage"; it is "core cannot store". A test that only exercised
// `MemorySecretStore.set` would pass just as happily on a version of this module that
// had grown a file store next to it, so the guards below read the SOURCE of
// src/secrets/ and assert there is no filesystem import and no native-keychain shape
// anywhere in it.
//
// Validates: Requirements 17.3, 17.4

import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  EmptySecretError,
  InvalidSecretIdError,
  MemorySecretStore,
  NoSecretStoreError,
  SECRET_ID_PATTERN,
  assertSecretId,
  isValidSecretId,
  unavailableSecretStore,
} from '../src/secrets/store.js'
import { resolveProviderConfig, toProviderConfig } from '../src/settings/providerSettings.js'
import type { ProviderSettingsEntry } from '../src/settings/providerSettings.js'
import type { SecretStore } from '../src/types.js'

const KEY = 'sk-ant-api03-DEADBEEFdeadbeef0123456789abcdefghij'

const OPENAI: ProviderSettingsEntry = {
  id: 'openai',
  kind: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  label: 'OpenAI',
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

describe('the identifier rule is the same one the host enforces', () => {
  it('accepts the provider ids the catalog actually uses', () => {
    for (const id of ['openai', 'azure-openai', 'llama.cpp', 'github_models', 'a', '9x']) {
      expect(isValidSecretId(id), id).toBe(true)
      expect(assertSecretId(`  ${id}  `)).toBe(id)
    }
  })

  it('refuses anything that could address a different credential record', () => {
    // An id becomes an account name in a C-string-shaped OS interface. A separator, a
    // NUL, or a newline in it is a way to name something other than what was asked
    // for, so the refusal is here rather than at the OS boundary.
    for (const id of [
      '',
      '   ',
      '-leading',
      '.dotfirst',
      'has space',
      'has/slash',
      'has\\backslash',
      'has:colon',
      'nul\0byte',
      'new\nline',
      'unicode-Ünïcode',
      'a'.repeat(129),
    ]) {
      expect(isValidSecretId(id), JSON.stringify(id)).toBe(false)
      expect(() => assertSecretId(id)).toThrow(InvalidSecretIdError)
    }
    expect(isValidSecretId('a'.repeat(128))).toBe(true)
  })

  it('is a single anchored pattern, so it cannot match a substring of a longer id', () => {
    expect(SECRET_ID_PATTERN.source.startsWith('^')).toBe(true)
    expect(SECRET_ID_PATTERN.source.endsWith('$')).toBe(true)
    expect(SECRET_ID_PATTERN.global).toBe(false)
  })
})

describe('MemorySecretStore is memory, and provably nothing else', () => {
  it('round-trips a secret and forgets it on del', async () => {
    const store = new MemorySecretStore()
    expect(await store.get('openai')).toBeNull()

    await store.set('openai', KEY)
    expect(await store.get('openai')).toBe(KEY)
    expect(store.ids()).toEqual(['openai'])
    expect(store.size).toBe(1)

    await store.del('openai')
    expect(await store.get('openai')).toBeNull()
    // Deleting what is not there is the requested state, not an error.
    await store.del('openai')
  })

  it('refuses an empty value, because removal is del', async () => {
    const store = new MemorySecretStore()
    await expect(store.set('openai', '')).rejects.toThrow(EmptySecretError)
    expect(store.size).toBe(0)
  })

  it('validates the id on every operation, not just on set', async () => {
    const store = new MemorySecretStore()
    await expect(store.get('has space')).rejects.toThrow(InvalidSecretIdError)
    await expect(store.set('has/slash', KEY)).rejects.toThrow(InvalidSecretIdError)
    await expect(store.del('nul\0byte')).rejects.toThrow(InvalidSecretIdError)
  })

  it('exposes ids and a count, and nothing that hands back a value in bulk', () => {
    const store = new MemorySecretStore() as unknown as Record<string, unknown>
    for (const forbidden of ['values', 'entries', 'all', 'dump', 'toJSON']) {
      expect(store[forbidden], forbidden).toBeUndefined()
    }
  })
})

describe('the core cannot persist a secret (Requirement 17.3)', () => {
  it('has no filesystem, process or network import anywhere under src/secrets', async () => {
    const dir = join(SRC, 'secrets')
    const files = (await readdir(dir)).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)

    for (const name of files) {
      const source = await readFile(join(dir, name), 'utf8')
      // Strip comments: this module DOCUMENTS what it refuses to do, and a raw text
      // search cannot tell the explanation from the thing being explained.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      for (const forbidden of [
        'node:fs',
        'node:child_process',
        'node:http',
        'node:https',
        'node:net',
        'writeFile',
        'appendFile',
        'keytar',
        'credential-manager',
        'libsecret',
        'security find-generic-password',
      ]) {
        expect(code, `${name} references ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('no longer ships the keytar-shaped credential store', async () => {
    // `providers/credentials.ts` carried a `KeychainCredentialStore` built around an
    // injected `KeytarLike` — storage code in a package that must not be able to
    // store, describing a native dependency the package is not allowed to have.
    const providerFiles = await readdir(join(SRC, 'providers'))
    expect(providerFiles).not.toContain('credentials.ts')

    const index = await readFile(join(SRC, 'providers', 'index.ts'), 'utf8')
    const code = index.replace(/^[ \t]*\/\/.*$/gm, '')
    expect(code).not.toContain('KeychainCredentialStore')
    expect(code).not.toContain('KeytarLike')
    expect(code).not.toContain('MemoryCredentialStore')
  })

  it('refuses loudly by default rather than behaving like an empty keychain', async () => {
    const store = unavailableSecretStore()
    // A default that returned null from `get` and swallowed `set` would look exactly
    // like a working store with nothing in it. Silence is the failure mode here.
    await expect(store.get('openai')).rejects.toThrow(NoSecretStoreError)
    await expect(store.set('openai', KEY)).rejects.toThrow(NoSecretStoreError)
    await expect(store.del('openai')).rejects.toThrow(NoSecretStoreError)

    const message = await store.set('openai', KEY).catch((e: Error) => e.message)
    expect(message).toContain('openai')
    expect(message).not.toContain(KEY)
  })
})

describe('a key reaches the engine at invocation time only (Requirement 17.4)', () => {
  it('builds a config with the resolved key and leaves the entry untouched', async () => {
    const store = new MemorySecretStore()
    await store.set('openai', KEY)

    const config = await resolveProviderConfig(OPENAI, store)
    expect(config.apiKey).toBe(KEY)
    // The persisted entry is unchanged: the key is on the call, not on the record.
    expect(JSON.stringify(OPENAI)).not.toContain(KEY)
    expect(Object.keys(OPENAI).sort()).toEqual(['baseUrl', 'id', 'kind', 'label', 'model'])

    // And two resolutions are two independent objects: nothing is cached between them.
    const again = await resolveProviderConfig(OPENAI, store)
    expect(again).not.toBe(config)
  })

  it('omits the key entirely when the store has none, rather than sending an empty one', async () => {
    const config = await resolveProviderConfig(OPENAI, new MemorySecretStore())
    expect('apiKey' in config).toBe(false)
    // Same shape as the explicit no-key call, so a local endpoint behaves identically
    // whether or not a store is present.
    expect(config).toEqual(toProviderConfig(OPENAI))
  })

  it('names the provider when the store fails, and adds nothing of its own', async () => {
    const broken: SecretStore = {
      async get() {
        throw new Error('the credential store refused the read (os error 1312)')
      },
      async set() {},
      async del() {},
    }
    const message = await resolveProviderConfig(OPENAI, broken).catch((e: Error) => e.message)
    expect(message).toContain("provider 'openai'")
    // The store's own words are kept — a vaguer message would hide which OS failure
    // this was — and nothing about the value is added, because the resolver never
    // reaches one on this path.
    expect(message).toContain('os error 1312')
    expect(message).not.toContain(KEY)
  })

  it('cannot be serialized into a log by a caller that dumps its dependencies', async () => {
    const store = new MemorySecretStore()
    await store.set('openai', KEY)
    // The rows are a `#private` field, so a diagnostic that stringifies the engine's
    // dependency bag — a crash reporter, a debug dump — gets `{}` rather than a
    // keychain.
    expect(JSON.stringify(store)).toBe('{}')
    expect(JSON.stringify({ secrets: store })).not.toContain(KEY)
  })
})
