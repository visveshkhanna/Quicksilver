// Small building blocks shared by every feature.

import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import type { Color } from '../ipc/store'
import { COLORS } from '../lib/target'

/** A dialog: dims the window, traps focus, closes on Escape. */
export function Modal({
  title,
  description,
  onClose,
  children,
  width = 560,
  top = false,
  onEscape,
}: {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  width?: number
  /** Sit near the top, like a palette, instead of centred. */
  top?: boolean
  /** Sees Escape first; call `preventDefault` to keep the dialog open. */
  onEscape?: (event: KeyboardEvent) => void
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          className={`fixed left-1/2 -translate-x-1/2 rounded-lg border border-border bg-bg shadow-2xl outline-none ${
            top ? 'top-[12%]' : 'top-1/2 -translate-y-1/2'
          }`}
          style={{ width: `min(${width}px, calc(100vw - 32px))` }}
          onEscapeKeyDown={onEscape}
        >
          <Dialog.Title className={top ? 'sr-only' : 'border-b border-border px-4 py-3 font-semibold'}>
            {title}
          </Dialog.Title>
          <Dialog.Description className="sr-only">{description ?? title}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Button({
  children,
  onClick,
  kind = 'plain',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode
  onClick?: () => void
  kind?: 'plain' | 'primary' | 'danger'
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
}) {
  const look = {
    plain: 'border border-border bg-raised hover:bg-border/60',
    primary: 'bg-accent text-white hover:brightness-110',
    danger: 'border border-border text-[#e5484d] hover:bg-[#e5484d]/10',
  }[kind]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded px-3 py-1 disabled:opacity-50 ${look}`}
    >
      {children}
    </button>
  )
}

/** The connection's marker colour, or a hollow ring when it has none. */
export function ColorDot({ color, className = '' }: { color: Color | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-2 shrink-0 rounded-full ${color ? '' : 'border border-muted'} ${className}`}
      style={color ? { background: COLORS[color] } : undefined}
    />
  )
}

/** Text with the fuzzy-matched characters emphasised. */
export function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>
  const marks = new Set(positions)
  return (
    <>
      {text.split('').map((ch, i) =>
        marks.has(i) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: characters have no other identity
          <mark key={i} className="bg-transparent font-semibold text-accent">
            {ch}
          </mark>
        ) : (
          ch
        ),
      )}
    </>
  )
}
