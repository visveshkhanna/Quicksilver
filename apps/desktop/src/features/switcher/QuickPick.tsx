import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Highlighted, Modal } from '../../app/ui'
import { currentPlatform } from '../../keymap/keymap'
import { fuzzyFilter } from '../../lib/fuzzy'

export type PickItem = {
  id: string
  label: string
  /** Shown after the label, dimmed, and searched too. */
  detail?: string
  /** Shown at the right (a shortcut, a badge). */
  aside?: ReactNode
  /** Shown before the label (a colour dot). */
  lead?: ReactNode
}

const platform = currentPlatform()
const MAX_SHOWN = 200

/**
 * A search box over a list: type to filter (fuzzy), arrows to move, `Enter`
 * to pick, `Mod+Enter` for the alternative pick, `Escape` to close.
 */
export function QuickPick({
  title,
  placeholder,
  items,
  onPick,
  onClose,
  empty,
  footer,
}: {
  title: string
  placeholder: string
  items: PickItem[]
  onPick: (item: PickItem, alternative: boolean) => void
  onClose: () => void
  empty: string
  footer?: ReactNode
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const matches = useMemo(
    () =>
      fuzzyFilter(items, query, (i) => (i.detail ? `${i.label} ${i.detail}` : i.label)).slice(0, MAX_SHOWN),
    [items, query],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the highlighted row changes
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const pick = (at: number, alternative: boolean) => {
    const found = matches[at]
    if (found) onPick(found.item, alternative)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const mod = platform === 'mac' ? event.metaKey : event.ctrlKey
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault()
      setIndex((i) => Math.min(i + 1, matches.length - 1))
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(index, mod)
    }
  }

  return (
    <Modal title={title} onClose={onClose} top width={620}>
      <input
        // biome-ignore lint/a11y/noAutofocus: a palette is for typing into
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setIndex(0)
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={title}
        role="combobox"
        aria-expanded
        aria-controls="quick-pick-list"
        aria-activedescendant={matches[index] ? `pick-${index}` : undefined}
        className="w-full border-b border-border bg-transparent px-4 py-3 text-[14px] outline-none"
      />
      <div
        ref={list}
        id="quick-pick-list"
        role="listbox"
        aria-label={title}
        className="max-h-[50vh] overflow-auto py-1"
      >
        {matches.length === 0 && <p className="px-4 py-3 text-muted">{empty}</p>}
        {matches.map(({ item, match }, i) => {
          const labelPositions = match.positions.filter((p) => p < item.label.length)
          return (
            <div
              key={item.id}
              id={`pick-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === index}
              onMouseMove={() => setIndex(i)}
              onClick={(e) => pick(i, platform === 'mac' ? e.metaKey : e.ctrlKey)}
              onKeyDown={() => {}}
              className={`flex cursor-pointer items-center gap-2 px-4 py-1.5 ${i === index ? 'bg-accent/15' : ''}`}
            >
              {item.lead}
              <span className="truncate">
                <Highlighted text={item.label} positions={labelPositions} />
              </span>
              {item.detail && <span className="truncate text-muted">{item.detail}</span>}
              {item.aside && <span className="ml-auto shrink-0">{item.aside}</span>}
            </div>
          )
        })}
      </div>
      {footer && (
        <div className="flex items-center gap-1 border-t border-border px-4 py-2 text-[11px] text-muted">
          {footer}
        </div>
      )}
    </Modal>
  )
}
