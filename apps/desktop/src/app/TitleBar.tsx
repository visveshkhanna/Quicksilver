import { Kbd } from './Kbd'

/**
 * The breadcrumb for the tab in front (connection ▸ database ▸ schema), its
 * mode, and the database switcher hint. Empty until phase 4 wires tabs to
 * targets.
 */
export function TitleBar() {
  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
      <span className="font-semibold">Quicksilver</span>
      <span className="text-muted">No connection</span>
      <span className="ml-auto flex items-center gap-2 text-muted">
        Switch database <Kbd id="switch-database" />
      </span>
    </header>
  )
}
