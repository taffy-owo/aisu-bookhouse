import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './modules/reader/styles/wenkai.css'
import { App } from './app/App'
import { isLegacyDesktopShell } from './shared/desktopShell'
import { installAssetLoadRecovery } from './shared/utils/assetLoadRecovery'

// Capture the Electron-only marker before an auth redirect can remove the
// query string. This keeps the compact shell across client-side navigation.
isLegacyDesktopShell()
installAssetLoadRecovery()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
