import { Kbd } from '../../app/Kbd'
import { binding } from '../../keymap/keymap'

const HINTS = ['switch-database', 'go-to-object', 'command-palette', 'new-tab']

/** The tab strip, editor and result grid. Shows the welcome hints until tabs exist. */
export function Workspace() {
  return (
    <main className="flex h-full flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-end border-b border-border bg-panel px-2" role="tablist" />
      <div className="flex flex-1 items-center justify-center">
        <dl className="grid grid-cols-[auto_auto] items-center gap-x-6 gap-y-2 text-muted">
          {HINTS.map((id) => (
            <div key={id} className="contents">
              <dt className="text-right">{binding(id).title}</dt>
              <dd className="m-0">
                <Kbd id={id} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </main>
  )
}
