// Small line icons for the kinds of things in the navigator. Drawn in the
// current text colour, so they follow the theme.

import type { ReactNode } from 'react'

export type IconName =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'function'
  | 'sequence'
  | 'column'
  | 'key'
  | 'folder'
  | 'sidebarLeft'
  | 'sidebarRight'
  | 'close'
  | 'group'

const PATHS: Record<IconName, ReactNode> = {
  database: (
    <>
      <ellipse cx="8" cy="3.5" rx="5" ry="2" />
      <path d="M3 3.5v9c0 1.1 2.2 2 5 2s5-.9 5-2v-9" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </>
  ),
  schema: (
    <>
      <path d="M8 2l6 3-6 3-6-3z" />
      <path d="M2 8l6 3 6-3M2 11l6 3 6-3" />
    </>
  ),
  table: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M1.5 6h13M1.5 9.5h13M6 6v7.5" />
    </>
  ),
  view: (
    <>
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  function: <path d="M10.5 2.5c-2 0-2.5 1-2.8 3L6.5 13.5H5M5.5 6.5h5" />,
  sequence: <path d="M5.5 2l-1.5 12M11.5 2L10 14M2.5 5.5h11M2 10.5h11" />,
  column: <path d="M2 4.5h12M2 8h12M2 11.5h8" />,
  key: (
    <>
      <circle cx="5" cy="8" r="2.5" />
      <path d="M7.5 8h7M12.5 8v2.5M10.5 8v1.5" />
    </>
  ),
  folder: <path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z" />,
  sidebarLeft: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
    </>
  ),
  sidebarRight: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  group: (
    <>
      <rect x="2" y="2.5" width="12" height="3" rx="1" />
      <rect x="2" y="6.5" width="12" height="3" rx="1" />
      <rect x="2" y="10.5" width="12" height="3" rx="1" />
    </>
  ),
}

/** A 14px icon for `name`, hidden from screen readers (the label says what it is). */
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`size-3.5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  )
}
