import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary, installGlobalErrorReporter } from './components/ErrorBoundary'
import { persistedColorTheme, persistedAppearance } from './state/AppState'
import { applyAppearance } from './styles/appearance'
import { applyColorScheme, resolveScheme, systemPrefersLight } from './styles/colorTheme'
import './styles/global.css'

// Before anything renders, so the window opens in its theme instead of flashing the other.
const initialScheme = resolveScheme(persistedColorTheme(), systemPrefersLight())
applyAppearance(persistedAppearance(), initialScheme)
applyColorScheme(initialScheme)

// A rejected promise or an error thrown outside React's render path never reaches
// the <ErrorBoundary>, so report those here instead of letting them hit only the
// console. Installed once, at module load, for the window's whole lifetime.
installGlobalErrorReporter()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Outside every provider: a throw in a provider's own render still lands here
        and shows a recovery screen instead of unmounting the tree to a blank window. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
