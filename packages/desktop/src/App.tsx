import { AppLayout } from './components/AppLayout'
import { AppStateProvider } from './state/AppState'
import { SketchClientProvider } from './lib/ClientProvider'

export function App() {
  return (
    // The client seam wraps the app: one client, one event subscription, chosen by
    // the factory. Nothing below this point knows which transport is live.
    <SketchClientProvider>
      <AppStateProvider>
        <AppLayout />
      </AppStateProvider>
    </SketchClientProvider>
  )
}
