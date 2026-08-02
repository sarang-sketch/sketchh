import type { MemoryStore } from './store.js'

export type MemoryStoreFactory = (root: string) => MemoryStore

export interface MemoryStoreRegistration {
  id: string
  factory: MemoryStoreFactory
}

function validId(id: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)
}

/** Immutable, host-owned registry of alternative memory stores. */
export class MemoryStoreRegistry {
  readonly #factories = new Map<string, MemoryStoreFactory>()

  constructor(registrations: readonly MemoryStoreRegistration[] = []) {
    for (const registration of registrations) {
      if (!validId(registration.id)) {
        throw new Error(`invalid memory store id ${JSON.stringify(registration.id)}`)
      }
      if (typeof registration.factory !== 'function') {
        throw new Error(`memory store ${registration.id} must provide a factory`)
      }
      const existing = this.#factories.get(registration.id)
      if (existing !== undefined) {
        if (existing === registration.factory) continue
        throw new Error(`conflicting memory store registration: ${registration.id}`)
      }
      this.#factories.set(registration.id, registration.factory)
    }
  }

  ids(): string[] {
    return [...this.#factories.keys()].sort()
  }

  has(id: string): boolean {
    return this.#factories.has(id)
  }

  create(id: string, root: string): MemoryStore {
    const factory = this.#factories.get(id)
    if (factory === undefined) throw new Error(`unknown memory store: ${id}`)
    const store = factory(root)
    if (
      store === null || typeof store !== 'object' ||
      typeof store.add !== 'function' || typeof store.all !== 'function' ||
      typeof store.query !== 'function' || typeof store.get !== 'function' ||
      typeof store.supersede !== 'function'
    ) {
      throw new Error(`memory store factory ${id} returned an invalid store`)
    }
    return store
  }
}
