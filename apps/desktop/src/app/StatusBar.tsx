import { useEffect, useState } from 'react'
import { type AppInfo, appInfo } from '../ipc/commands'

/** Rows, timing, target and mode for the tab in front; the app version until then. */
export function StatusBar() {
  const [info, setInfo] = useState<AppInfo | null | undefined>(undefined)

  useEffect(() => {
    appInfo()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  const backend =
    info === undefined ? 'Starting…' : info === null ? 'No backend (browser preview)' : `v${info.version}`

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11px] text-muted">
      <span>Ready</span>
      <span className="ml-auto">{backend}</span>
    </footer>
  )
}
