// Credential store abstraction.
// The real desktop app injects a keytar-backed implementation (OS keychain).
// This interface keeps the engine testable and free of a hard keytar dependency.

export interface CredentialStore {
  get(providerId: string): Promise<string | null>
  set(providerId: string, apiKey: string): Promise<void>
  delete(providerId: string): Promise<void>
}

const SERVICE = 'sketch'

// keytar-backed store. keytar is injected so the engine has no hard native dependency
// and remains unit-testable. See src-tauri integration for the real wiring.
export interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
}

export class KeychainCredentialStore implements CredentialStore {
  constructor(private keytar: KeytarLike) {}

  get(providerId: string): Promise<string | null> {
    return this.keytar.getPassword(SERVICE, providerId)
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    if (!apiKey) throw new Error('Refusing to store an empty API key')
    await this.keytar.setPassword(SERVICE, providerId, apiKey)
  }

  async delete(providerId: string): Promise<void> {
    await this.keytar.deletePassword(SERVICE, providerId)
  }
}

// In-memory store for tests and ephemeral sessions. Never persists to disk.
export class MemoryCredentialStore implements CredentialStore {
  private store = new Map<string, string>()

  async get(providerId: string): Promise<string | null> {
    return this.store.get(providerId) ?? null
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    if (!apiKey) throw new Error('Refusing to store an empty API key')
    this.store.set(providerId, apiKey)
  }

  async delete(providerId: string): Promise<void> {
    this.store.delete(providerId)
  }
}
