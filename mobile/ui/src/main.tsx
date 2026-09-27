import './styles/fonts.css'
import './styles/eclume.css'
import './styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App.tsx'
import { PonteContexto } from './ponte/ponte.ts'
import { ponteTauri } from './ponte/tauri.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PonteContexto.Provider value={ponteTauri}>
      <App />
    </PonteContexto.Provider>
  </StrictMode>,
)
