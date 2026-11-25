import { isTauri } from '@tauri-apps/api/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { boot, errorText, say } from './state/app'
import { loadPanelLayout } from './state/layoutStorage'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root element')

async function start() {
  // In a plain browser (`pnpm dev:web`) there is no backend to load from.
  if (isTauri()) {
    try {
      await Promise.all([boot(), loadPanelLayout()])
    } catch (err) {
      say(`Could not load saved state: ${errorText(err)}`, true)
    }
  }
  createRoot(root as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
