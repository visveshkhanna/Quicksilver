import { binding, currentPlatform, formatKeys } from '../keymap/keymap'

const platform = currentPlatform()

/** A shortcut hint, spelled for the current platform. */
export function Kbd({ id }: { id: string }) {
  return (
    <kbd className="rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted">
      {formatKeys(binding(id).keys, platform)}
    </kbd>
  )
}
