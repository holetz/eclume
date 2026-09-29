import './styles/global.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { applyEnvironment } from './app/preferences'
import { applyThemePreference, readThemePreference, watchSystemTheme } from './app/theme'

applyThemePreference(readThemePreference())
watchSystemTheme()
applyEnvironment()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
