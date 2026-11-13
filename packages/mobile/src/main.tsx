import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerServiceWorker } from './serviceWorker'

// Production only (the helper checks import.meta.env.PROD), best-effort:
// if registration fails the app still works, online only.
void registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
