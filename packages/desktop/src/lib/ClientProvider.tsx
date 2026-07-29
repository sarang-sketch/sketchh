// React access to the client seam.
//
// This provider owns the single `SketchClient` instance and the single
// subscription to its event stream. Components read the interface out of context
// and never learn which transport is live. Because the accumulated event log
// lives here, a panel that mounts mid-run still sees the whole run — which is
// what lets the Timeline reconstruct a run from events alone (Req 27.2).
//
// Validates: Requirements 13.1, 13.3, 13.6, 14.2

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { SketchEvent } from './contracts'
import type { PingResult, SketchClient } from './client'
import { createSketchClient } from './factory'

export interface EngineStatus {
  state: 'connecting' | 'ready' | 'error'
  ping: PingResult | null
  /** Populated only in the 'error' state. Named so a panel can say what failed. */
  error: string | null
}

interface ClientContextValue {
  client: SketchClient
  events: SketchEvent[]
  status: EngineStatus
}

const ClientContext = createContext<ClientContextValue | null>(null)

export interface SketchClientProviderProps {
  children: ReactNode
  /** Injected in tests. Production passes nothing and the factory decides. */
  client?: SketchClient
}

export function SketchClientProvider({ children, client: injected }: SketchClientProviderProps) {
  // The factory is called exactly once per provider. No component may do this.
  const client = useMemo(() => injected ?? createSketchClient(), [injected])

  const [events, setEvents] = useState<SketchEvent[]>([])
  const [status, setStatus] = useState<EngineStatus>({
    state: 'connecting',
    ping: null,
    error: null,
  })

  // One subscription for the whole app. Appends in emission order; deduplicates
  // by event id so a transport that redelivers cannot double-render a run.
  const seen = useRef<Set<string>>(new Set())
  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (seen.current.has(event.id)) return
      seen.current.add(event.id)
      setEvents((prev) => [...prev, event])
    })
    return unsubscribe
  }, [client])

  // Startup liveness check (Req 13.6).
  useEffect(() => {
    let cancelled = false
    client
      .ping()
      .then((ping) => {
        if (cancelled) return
        setStatus({
          state: ping.ok ? 'ready' : 'error',
          ping,
          error: ping.ok ? null : `${ping.transport} transport reported not ok`,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus({
          state: 'error',
          ping: null,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const value = useMemo<ClientContextValue>(
    () => ({ client, events, status }),
    [client, events, status],
  )

  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>
}

function useClientContext(): ClientContextValue {
  const ctx = useContext(ClientContext)
  if (!ctx) {
    throw new Error('useSketchClient must be used inside <SketchClientProvider>')
  }
  return ctx
}

/** The engine, as an interface. Never a concrete implementation. */
export function useSketchClient(): SketchClient {
  return useClientContext().client
}

/** Optional variant of useSketchClient that returns null if outside a provider. */
export function useOptionalSketchClient(): SketchClient | null {
  const ctx = useContext(ClientContext)
  return ctx?.client ?? null
}

/** Every event seen so far, in emission order. The Timeline's only input. */
export function useSketchEvents(): SketchEvent[] {
  return useClientContext().events
}

/**
 * Events when there is a provider, an empty log when there is not.
 *
 * For a component that WATCHES the stream rather than existing to render it — the
 * editor reconciling engine writes, for instance. Such a component is still usable
 * (and testable) in a tree with no engine attached; it simply has nothing to
 * reconcile. `useSketchEvents` keeps throwing, so a panel whose whole purpose is the
 * log still fails loudly when it is mounted wrong.
 */
const NO_EVENTS: SketchEvent[] = []
export function useOptionalSketchEvents(): SketchEvent[] {
  return useContext(ClientContext)?.events ?? NO_EVENTS
}

export function useEngineStatus(): EngineStatus {
  return useClientContext().status
}
