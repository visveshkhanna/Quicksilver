import { useEffect, useState } from 'react'
import { type AppInfo, appInfo } from '../ipc/commands'
import { activeTab, dismissNotice, useApp } from '../state/app'

/** Rows, timing, target and mode for the front tab; messages; the version. */
export function StatusBar() {
  const [info, setInfo] = useState<AppInfo | null | undefined>(undefined)
  const message = useApp((s) => s.message)
  const notices = useApp((s) => s.notices)
  const tab = useApp((s) => activeTab(s))
  const profile = useApp((s) => s.profiles.find((p) => p.id === tab?.profileId))

  useEffect(() => {
    appInfo()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  const run = tab?.run
  const last = run?.statements[run.statements.length - 1]?.outcome
  const parts: string[] = []
  if (run?.status === 'running') parts.push('Running…')
  else if (last) {
    parts.push(
      last.rowsAffected !== null
        ? `${last.rowsAffected.toLocaleString()} affected`
        : `${last.rowsReturned.toLocaleString()} row${last.rowsReturned === 1 ? '' : 's'}${last.capped ? ' (capped)' : ''}`,
    )
    if (run?.elapsedMs !== null && run?.elapsedMs !== undefined) parts.push(`${Math.round(run.elapsedMs)} ms`)
  }
  if (profile) parts.push(`${profile.name}${tab?.database ? `/${tab.database}` : ''}`)
  if (profile) parts.push({ readOnly: 'read-only', readWrite: 'read-write', full: 'full' }[profile.mode])

  const backend =
    info === undefined ? 'Starting…' : info === null ? 'No backend (browser preview)' : `v${info.version}`
  const notice = notices[0]

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11px] text-muted">
      <span>{parts.join(' · ') || 'Ready'}</span>
      {message && (
        <span role="status" className={message.error ? 'text-[#e5484d]' : ''}>
          {message.text}
        </span>
      )}
      {notice && (
        <button type="button" onClick={() => dismissNotice(0)} className="text-[#e2a336]" title="Dismiss">
          {notice.kind === 'recovered'
            ? `${notice.file} could not be read; it was kept as ${notice.keptAs}.`
            : `${notice.file} is from a newer Quicksilver; changes are not saved to it.`}
        </button>
      )}
      <span className="ml-auto">{backend}</span>
    </footer>
  )
}
