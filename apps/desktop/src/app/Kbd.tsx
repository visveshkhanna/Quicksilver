import { currentPlatform, formatKeys, keysFor } from '../keymap/keymap'
import { useApp } from '../state/app'

const platform = currentPlatform()

/** A shortcut hint for binding `id`, as the user has it bound, spelled for the platform. */
export function Kbd({ id }: { id: string }) {
  const keys = useApp((s) => keysFor(id, s.overrides))
  if (keys === '') return null
  return <KeyCaps keys={keys} />
}

/** Keys such as `Mod+K`, spelled for the platform. */
export function KeyCaps({ keys }: { keys: string }) {
  return (
    <kbd className="whitespace-nowrap rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted">
      {formatKeys(keys, platform)}
    </kbd>
  )
}

/** Keys such as `Mod+K` as plain text for a tooltip, or `''` when unbound. */
export function shortcutLabel(keys: string): string {
  return keys === '' ? '' : formatKeys(keys, platform)
}
