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
          onOpenAutoFocus={(event) => {
            // A control marked `autoFocus` takes focus instead of the first one.
            const preferred = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
              '[data-autofocus]',
            )
            if (preferred) {
              event.preventDefault()
              preferred.focus()
            }
          }}
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
  className = '',
  small,
  autoFocus,
}: {
  children: ReactNode
  onClick?: () => void
  kind?: 'plain' | 'primary' | 'danger'
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
  className?: string
  /** A compact button for toolbars. */
  small?: boolean
  /** Takes focus when its dialog opens. */
  autoFocus?: boolean
}) {
  const look = {
    plain: 'border border-border bg-raised hover:bg-border/60',
    primary: 'bg-accent-solid text-white hover:brightness-110',
    danger: 'border border-border text-[#e5484d] hover:bg-[#e5484d]/10',
  }[kind]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-autofocus={autoFocus || undefined}
      className={`shrink-0 rounded whitespace-nowrap disabled:opacity-50 ${small ? 'px-2 py-0.5 text-[12px]' : 'px-3 py-1'} ${look} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * The connection's marker colour. Without one it is an empty space of the
 * same size, so names still line up (a hollow ring read as "disconnected").
 */
export function ColorDot({ color, className = '' }: { color: Color | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-2 shrink-0 rounded-full ${className}`}
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
