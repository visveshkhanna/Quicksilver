// Bringing saved connections over from DBeaver. The scan and the import both
// run in Rust; passwords go from DBeaver's files to the keychain and never
// pass through the UI.

import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../app/icons'
import { Button, Modal } from '../../app/ui'
import { type DbeaverCandidate, type DbeaverScan, dbeaverScan } from '../../ipc/store'
import { closeDialog, errorText, importDbeaver, reveal } from '../../state/app'

/** Whether a candidate can be ticked. */
const importable = (c: DbeaverCandidate) => c.skipped === null && !c.alreadyImported

export function ImportDbeaver() {
  const [scan, setScan] = useState<DbeaverScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [passwords, setPasswords] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    dbeaverScan()
      .then((found) => {
        setScan(found)
        setChosen(new Set(found.candidates.filter(importable).map((c) => c.key)))
      })
      .catch((err) => setError(errorText(err)))
  }, [])

  /** The candidates by folder, top level first. */
  const groups = useMemo(() => {
    const byFolder = new Map<string, DbeaverCandidate[]>()
    for (const c of scan?.candidates ?? []) {
      const key = c.project ?? ''
      byFolder.set(key, [...(byFolder.get(key) ?? []), c])
    }
    return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [scan])

  const toggle = (key: string, on: boolean) =>
    setChosen((s) => {
      const next = new Set(s)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  const available = scan?.candidates.filter(importable) ?? []
  const withPasswords = available.filter((c) => chosen.has(c.key) && c.hasPassword).length

  const run = async () => {
    setBusy(true)
    try {
      const result = await importDbeaver([...chosen], passwords)
      closeDialog()
      const first = result.imported[0]
      if (first) void reveal({ kind: 'connection', profileId: first.id })
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Import from DBeaver" onClose={closeDialog} width={640}>
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-auto p-4">
        {error && (
          <p role="alert" className="m-0 text-[#e5484d]">
            {error}
          </p>
        )}
        {!scan && !error && <p className="m-0 text-muted">Looking for DBeaver’s connections…</p>}
        {scan && !scan.found && (
          <p className="m-0 text-muted">
            No DBeaver workspace was found. Quicksilver looks where DBeaver keeps its data
            (DBeaverData/workspace6) for this user.
          </p>
        )}
        {scan?.found && scan.candidates.length === 0 && (
          <p className="m-0 text-muted">DBeaver has no saved connections.</p>
        )}
        {scan && scan.candidates.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <span>
                {scan.candidates.length} connection{scan.candidates.length === 1 ? '' : 's'} found. Folders
                come across as projects.
              </span>
              <span className="ml-auto flex gap-1">
                <Button small onClick={() => setChosen(new Set(available.map((c) => c.key)))}>
                  All
                </Button>
                <Button small onClick={() => setChosen(new Set())}>
                  None
                </Button>
              </span>
            </div>
            <div className="rounded border border-border">
              {groups.map(([folder, list]) => (
                <div key={folder || '-'}>
                  {folder && (
                    <div className="flex items-center gap-1.5 border-b border-border bg-raised/50 px-2 py-1 text-[12px] font-medium">
                      <Icon name="folder" className="text-muted" />
                      {folder.split('/').join(' / ')}
                    </div>
                  )}
                  {list.map((c) => (
                    <label
                      key={c.key}
                      className={`flex items-center gap-2 border-b border-border/60 px-2 py-1.5 last:border-0 ${
                        importable(c) ? '' : 'opacity-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={chosen.has(c.key)}
                        disabled={!importable(c)}
                        onChange={(e) => toggle(c.key, e.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{c.name}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {c.skipped ?? (c.alreadyImported ? 'Already imported' : c.summary)}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] text-muted">{c.engine ?? ''}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={passwords} onChange={(e) => setPasswords(e.target.checked)} />
              Save their passwords in the OS keychain
              <span className="text-[12px] text-muted">
                ({withPasswords} of the chosen have one; without, you are asked when connecting)
              </span>
            </label>
            {scan.notes.length > 0 && (
              <ul className="m-0 list-disc pl-5 text-[12px] text-muted">
                {scan.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <Button onClick={closeDialog}>Cancel</Button>
        <Button kind="primary" onClick={() => void run()} disabled={busy || chosen.size === 0}>
          {chosen.size === 0 ? 'Import' : `Import ${chosen.size} connection${chosen.size === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Modal>
  )
}
