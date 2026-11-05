import './styles/global.css'
import { startI18n } from './i18n'
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

function mount() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// The app mounts once the starting locale's catalogs are in, so the first frame is in its language.
// A chunk that fails to load still mounts the app (`watchChunkReload` handles the stale-deploy case).
void startI18n().then(mount, mount)
