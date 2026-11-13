// Service worker registration for Sketch Mobile.
//
// Registered only in production builds (`import.meta.env.PROD`), so `npm run
// dev` and the test suite never try to install a worker. Registration is
// best-effort: if the browser has no service worker support, or registration
// fails, this resolves to null and the app works exactly as before — online
// only. The worker itself lives in public/sw.js (cache name
// `sketch-mobile-v1`) and is copied verbatim into the build output by Vite.

export interface ServiceWorkerDeps {
  navigator?: Navigator
  production?: boolean
}

export async function registerServiceWorker(deps: ServiceWorkerDeps = {}): Promise<ServiceWorkerRegistration | null> {
  const nav = deps.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined)
  const production = deps.production ?? import.meta.env.PROD
  if (!production || nav === undefined || !('serviceWorker' in nav)) return null
  try {
    return await nav.serviceWorker.register('/sw.js')
  } catch {
    return null
  }
}
