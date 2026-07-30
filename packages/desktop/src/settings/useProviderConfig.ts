// One place that reads provider configuration over the client seam.
//
// Two surfaces need it — the Provider Settings panel and the model picker in the
// prompt box — and neither may keep its own copy: a picker that remembered a
// provider the settings panel had just deleted is exactly the class of lie this
// task removes.
//
// WHAT IT READS: the engine's `provider-catalog` method, which answers with the
// registry matrix (`PROVIDER_CATALOG`) plus whatever is in the KEY-FREE
// `~/.sketch/providers.json`. No key is involved anywhere on this path.
//
// WHAT IT DOES NOT DO: it never runs a connection test. Reading a local file is
// not a network call; testing an endpoint is, and that only ever happens because
// a user clicked (Requirement 17.1).
//
// Validates: Requirements 17.1, 17.2, 27.1

import { useCallback, useEffect, useState } from 'react'

import { useSketchClient } from '../lib/ClientProvider'
import { useAppDispatch, useAppState } from '../state/AppState'

export interface ProviderConfigLoader {
  /** True while the first (or a requested) read is in flight. */
  loading: boolean
  /** Read again from disk. Discards stale connection-test verdicts by design. */
  reload: () => Promise<void>
}

/**
 * Load provider configuration into `AppState`.
 *
 * `auto: 'once'` (the default) loads only when nothing has been loaded yet, so a
 * secondary consumer mounting later cannot wipe a fresh test verdict. `auto:
 * 'never'` leaves the caller to invoke `reload` itself.
 */
export function useProviderConfig(
  options: { auto?: 'once' | 'never' } = {},
): ProviderConfigLoader {
  const auto = options.auto ?? 'once'
  const client = useSketchClient()
  const dispatch = useAppDispatch()
  const state = useAppState()
  const [loading, setLoading] = useState(auto === 'once' && state.providerSettingsPath === null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const answer = await client.providerCatalog()
      dispatch({
        type: 'PROVIDER_SETTINGS_LOADED',
        payload: {
          catalog: answer.catalog,
          providers: answer.settings.providers,
          selected: answer.settings.selected,
          path: answer.path,
          notice: answer.diagnostic ?? null,
        },
      })
    } catch (err) {
      // A dead engine is NAMED. It is not an empty provider list, and it is not a
      // provider list invented to fill the gap (Requirements 27.3, 27.5).
      dispatch({
        type: 'PROVIDER_SETTINGS_NOTICE',
        payload: `Provider settings could not be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      })
    } finally {
      setLoading(false)
    }
  }, [client, dispatch])

  const alreadyLoaded = state.providerSettingsPath !== null

  useEffect(() => {
    if (auto === 'never' || alreadyLoaded) return
    void reload()
  }, [auto, alreadyLoaded, reload])

  return { loading, reload }
}
