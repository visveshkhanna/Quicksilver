// Right-click menus, styled once.

import * as Menu from '@radix-ui/react-context-menu'
import * as Drop from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { KeyCaps } from './Kbd'

export function MenuContent({ children }: { children: ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Content
        collisionPadding={8}
        className="z-50 min-w-48 rounded-md border border-border bg-popover p-1 shadow-xl"
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  )
}

export function MenuItem({
  children,
  onSelect,
  danger,
  keys,
  disabled,
}: {
  children: ReactNode
  onSelect: () => void
  danger?: boolean
  /** A shortcut hint shown at the right. */
  keys?: string
  disabled?: boolean
}) {
  return (
    <Menu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={`flex min-h-7 cursor-default items-center gap-4 rounded px-2 py-1 outline-none data-disabled:opacity-40 data-highlighted:bg-accent/15 ${
        danger ? 'text-danger' : ''
      }`}
    >
      <span className="flex-1">{children}</span>
      {keys && <KeyCaps keys={keys} />}
    </Menu.Item>
  )
}

export const MenuSeparator = () => <Menu.Separator className="my-1 h-px bg-border" />

/** A menu that opens from a button, styled like the right-click menus. */
export function DropMenu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <Drop.Root modal={false}>
      <Drop.Trigger asChild>{trigger}</Drop.Trigger>
      <Drop.Portal>
        <Drop.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 min-w-48 rounded-md border border-border bg-popover p-1 shadow-xl"
        >
          {children}
        </Drop.Content>
      </Drop.Portal>
    </Drop.Root>
  )
}

export function DropItem({ children, onSelect }: { children: ReactNode; onSelect: () => void }) {
  return (
    <Drop.Item
      onSelect={onSelect}
      className="flex min-h-7 cursor-default items-center gap-4 rounded px-2 py-1 outline-none data-highlighted:bg-accent/15"
    >
      {children}
    </Drop.Item>
  )
}
