/** The right panel: the selected row in full, or the selected object's details. */
export function Inspector() {
  return (
    <aside className="flex h-full flex-col bg-panel" aria-label="Inspector">
      <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Inspector
      </div>
      <p className="p-3 text-muted">Select a row or an object to see it here.</p>
    </aside>
  )
}
