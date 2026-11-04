import './styles/global.css'
import './i18n'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { watchChunkReload } from './app/chunkReload'
import { applyEnvironment } from './app/preferences'
import { applyThemePreference, readThemePreference, watchSystemTheme } from './app/theme'

applyThemePreference(readThemePreference())
watchSystemTheme()
applyEnvironment()
watchChunkReload()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
