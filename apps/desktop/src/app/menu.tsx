// Right-click menus, styled once.

import * as Menu from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import { KeyCaps } from './Kbd'

export function MenuContent({ children }: { children: ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Content className="z-50 min-w-48 rounded-md border border-border bg-bg p-1 shadow-xl">
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
      className={`flex cursor-default items-center gap-4 rounded px-2 py-1 outline-none data-disabled:opacity-40 data-highlighted:bg-accent/15 ${
        danger ? 'text-[#e5484d]' : ''
      }`}
    >
      <span className="flex-1">{children}</span>
      {keys && <KeyCaps keys={keys} />}
    </Menu.Item>
  )
}

export const MenuSeparator = () => <Menu.Separator className="my-1 h-px bg-border" />
