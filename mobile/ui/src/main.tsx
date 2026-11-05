import './styles/fonts.css'
import './styles/eclume.css'
import './styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App.tsx'
import { BridgeContext } from './bridge/bridge.ts'
import { tauriBridge } from './bridge/tauri.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BridgeContext.Provider value={tauriBridge}>
      <App />
    </BridgeContext.Provider>
  </StrictMode>,
)
