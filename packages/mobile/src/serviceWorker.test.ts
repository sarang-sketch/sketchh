import { describe, expect, it, vi } from 'vitest'

import { registerServiceWorker } from './serviceWorker'

// The worker source itself, read as text: the file must exist, carry the
// versioned cache name and install a fetch handler.
import swSource from '../public/sw.js?raw'

describe('service worker file', () => {
  it('exists with the versioned cache name and a fetch handler', () => {
    expect(typeof swSource).toBe('string')
    expect(swSource).toContain('sketch-mobile-v1')
    expect(swSource).toContain("addEventListener('fetch'")
    expect(swSource).toContain("addEventListener('install'")
    expect(swSource).toContain("addEventListener('activate'")
    expect(swSource).toContain('chat/completions')
  })
})

describe('registerServiceWorker', () => {
  it('registers /sw.js in production when service workers are supported', async () => {
    const registration = { scope: '/' } as ServiceWorkerRegistration
    const register = vi.fn(async () => registration)
    const nav = { serviceWorker: { register } } as unknown as Navigator
    await expect(registerServiceWorker({ navigator: nav, production: true })).resolves.toBe(registration)
    expect(register).toHaveBeenCalledWith('/sw.js')
  })

  it('does nothing without service worker support', async () => {
    const nav = {} as Navigator
    await expect(registerServiceWorker({ navigator: nav, production: true })).resolves.toBeNull()
  })

  it('does nothing outside production builds', async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration)
    const nav = { serviceWorker: { register } } as unknown as Navigator
    await expect(registerServiceWorker({ navigator: nav, production: false })).resolves.toBeNull()
    expect(register).not.toHaveBeenCalled()
  })

  it('returns null when registration fails', async () => {
    const register = vi.fn(async () => {
      throw new Error('denied')
    })
    const nav = { serviceWorker: { register } } as unknown as Navigator
    await expect(registerServiceWorker({ navigator: nav, production: true })).resolves.toBeNull()
  })
})
