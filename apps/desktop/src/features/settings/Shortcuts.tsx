import { useState } from 'react'
import { KeyCaps } from '../../app/Kbd'
import { Button, Modal } from '../../app/ui'
import {
  BINDINGS,
  type Binding,
  conflictFor,
  currentPlatform,
  eventToKeys,
  GRID_FIXED_KEYS,
  keysFor,
  NAVIGATOR_FIXED_KEYS,
  reservedFor,
  TAB_JUMP_KEYS,
} from '../../keymap/keymap'
import { closeDialog, setOverride, useApp } from '../../state/app'

const platform = currentPlatform()

/** Every shortcut, with a way to rebind it. */
export function Shortcuts() {
  const overrides = useApp((s) => s.overrides)
  const [recording, setRecording] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const row = (b: Binding) => {
    const keys = keysFor(b.id, overrides)
    const changed = b.id in overrides
    return (
      <tr key={b.id} className="border-b border-border/60 last:border-0">
        <td className="px-2 py-1.5">{b.title}</td>
        <td className="px-2 py-1.5 text-right">
          {recording === b.id ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: recording starts on click
              autoFocus
              readOnly
              aria-label={`New shortcut for ${b.title}`}
              placeholder="Press keys… (Esc to stop)"
              onBlur={() => setRecording(null)}
              onKeyDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (e.key === 'Escape') {
                  setRecording(null)
                  return
                }
                const next = eventToKeys(e.nativeEvent, platform)
                if (!next) return
                const reserved = reservedFor(next, b.scope)
                if (reserved) {
                  setWarning(`Those keys are kept for ${reserved}. Pick others.`)
                  return
                }
                const clash = conflictFor(b.id, next, overrides)
                if (clash) {
                  setWarning(`That is already “${clash.title}”. Pick other keys or change that one first.`)
                  return
                }
                setWarning(null)
                setOverride(b.id, next === b.keys ? null : next)
                setRecording(null)
              }}
              className="w-44 rounded border border-accent bg-bg px-2 py-0.5 text-[12px] outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setWarning(null)
                setRecording(b.id)
              }}
              aria-label={`Change shortcut for ${b.title}`}
              className="rounded px-1 hover:bg-raised"
            >
              {keys ? <KeyCaps keys={keys} /> : <span className="text-muted">none</span>}
            </button>
          )}
        </td>
        <td className="w-28 px-1 text-right whitespace-nowrap">
          {keys !== '' && (
            <button
              type="button"
              onClick={() => setOverride(b.id, b.keys === '' ? null : '')}
              aria-label={`Remove the shortcut for ${b.title}`}
              className="mr-2 text-[12px] text-muted hover:text-fg hover:underline"
            >
              Remove
            </button>
          )}
          {changed && (
            <button
              type="button"
              onClick={() => setOverride(b.id, null)}
              className="text-[12px] text-accent hover:underline"
            >
              Reset
            </button>
          )}
        </td>
      </tr>
    )
  }

  return (
    <Modal
      title="Keyboard shortcuts"
      onClose={closeDialog}
      width={560}
      onEscape={(e) => {
        // Escape while recording stops recording, not the dialog.
        if (recording) {
          e.preventDefault()
          setRecording(null)
        }
      }}
    >
      <div className="max-h-[65vh] overflow-auto p-2">
        <table className="w-full border-collapse">
          <tbody>
            <Heading>Everywhere</Heading>
            {BINDINGS.filter((b) => !b.scope).map(row)}
            <tr>
              <td className="px-2 py-1.5">Jump to tab 1–9</td>
              <td className="px-2 py-1.5 text-right">
                <KeyCaps keys={TAB_JUMP_KEYS} />
              </td>
              <td />
            </tr>
            <Heading>In the navigator</Heading>
            {NAVIGATOR_FIXED_KEYS.map(([keys, title]) => (
              <tr key={keys} className="border-b border-border/60 last:border-0">
                <td className="px-2 py-1.5">{title}</td>
                <td className="px-2 py-1.5 text-right">
                  <KeyCaps keys={keys} />
                </td>
                <td />
              </tr>
            ))}
            <Heading>In the results grid</Heading>
            {BINDINGS.filter((b) => b.scope === 'grid').map(row)}
            {GRID_FIXED_KEYS.map(([keys, title]) => (
              <tr key={keys} className="border-b border-border/60 last:border-0">
                <td className="px-2 py-1.5">{title}</td>
                <td className="px-2 py-1.5 text-right text-[12px] text-muted">{keys}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <p role="status" className="min-w-0 flex-1 text-[12px] text-danger">
          {warning}
        </p>
        <Button kind="primary" onClick={closeDialog}>
          Done
        </Button>
      </div>
    </Modal>
  )
}

function Heading({ children }: { children: string }) {
  return (
    <tr>
      <th
        colSpan={3}
        className="px-2 pt-3 pb-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted"
      >
        {children}
      </th>
    </tr>
  )
}
