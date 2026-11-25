import { Kbd } from '../../app/Kbd'

/**
 * The left navigator: every saved connection, grouped by project, expanding
 * to databases, schemas and objects. Empty until phase 3 stores profiles.
 */
export function Navigator() {
  return (
    <nav className="flex h-full flex-col bg-panel" aria-label="Connections">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <input
          type="search"
          placeholder="Filter connections…"
          aria-label="Filter connections"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent"
        />
        <Kbd id="focus-navigator" />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-muted">
        <p>No connections yet.</p>
        <button
          type="button"
          disabled
          className="rounded bg-accent px-3 py-1 text-white opacity-60"
          title="Arrives in phase 4"
        >
          New connection
        </button>
      </div>
    </nav>
  )
}
