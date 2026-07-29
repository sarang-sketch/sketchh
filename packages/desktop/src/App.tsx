import { AppLayout } from './components/AppLayout'
import { AppStateProvider } from './state/AppState'
import { SketchClientProvider } from './lib/ClientProvider'
import { GitProvider } from './git/GitProvider'

export function App() {
  return (
    // The client seam wraps the app: one client, one event subscription, chosen by
    // the factory. Nothing below this point knows which transport is live.
    <SketchClientProvider>
      <AppStateProvider>
        {/* One git owner for the window: the Source Control panel lists the changes
            and the status bar names the branch, both from the same status. Inside
            AppStateProvider because it needs the open project root, and inside the
            client provider because it reaches git through the engine seam. */}
        <GitProvider>
          <AppLayout />
        </GitProvider>
      </AppStateProvider>
    </SketchClientProvider>
  )
}
