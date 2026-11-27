import { useEffect } from 'react'
import { Icon } from '../../app/icons'
import { shortcutLabel } from '../../app/Kbd'
import { keysFor } from '../../keymap/keymap'
import { loadNode, type NodeRef, nodeKey, profileById, togglePanel, useApp } from '../../state/app'

/** The right panel: the selected row in full, or the selected object's details. */
export function Inspector() {
  const selection = useApp((s) => s.selection)
  const keys = useApp((s) => shortcutLabel(keysFor('toggle-inspector', s.overrides)))
  return (
    <aside className="flex h-full flex-col bg-panel" aria-label="Inspector">
      <div className="flex items-center border-b border-border py-1.5 pr-1.5 pl-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Inspector
        <button
          type="button"
          aria-label="Hide the inspector"
          title={keys ? `Hide the inspector (${keys})` : 'Hide the inspector'}
          onClick={() => togglePanel('inspector')}
          className="ml-auto rounded p-0.5 hover:bg-raised hover:text-fg"
        >
          <Icon name="close" className="size-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!selection && <p className="p-3 text-muted">Select a row or an object to see it here.</p>}
        {selection?.kind === 'row' && (
          <dl className="m-0 p-3">
            {selection.columns.map((c, i) => {
              const value = selection.row[i] ?? null
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns can share names
                <div key={i} className="mb-2.5">
                  <dt className="flex gap-1.5 text-[11px] text-muted">
                    <span className="font-semibold text-fg">{c.name}</span>
                    {c.dbType}
                  </dt>
                  <dd
                    className={`m-0 font-mono text-[12px] whitespace-pre-wrap select-text ${
                      c.typeTag === 'json' || c.typeTag === 'bytes' ? 'break-all' : '[overflow-wrap:anywhere]'
                    }`}
                  >
                    {value === null ? (
                      <span className="text-muted italic">NULL</span>
                    ) : value === '' ? (
                      <span className="text-muted italic">empty string</span>
                    ) : (
                      pretty(value, c.typeTag)
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
        )}
        {selection?.kind === 'node' && <NodeDetails node={selection.node} />}
      </div>
    </aside>
  )
}

function pretty(value: string, tag: string): string {
  if (tag !== 'json') return value
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function NodeDetails({ node }: { node: NodeRef }) {
  const profile = profileById(node.profileId)
  const loaded = useApp((s) => s.tree[nodeKey(node)])
  useEffect(() => {
    if (node.kind === 'object') void loadNode(node)
  }, [node])
  if (!profile) return null
  const rows: [string, string][] = []
  if (node.kind === 'connection') {
    rows.push(['Connection', profile.name], ['Engine', profile.engine])
    if (profile.path) rows.push(['File', profile.path])
    else
      rows.push(
        ['Host', `${profile.host ?? ''}${profile.port ? `:${profile.port}` : ''}`],
        ['User', profile.user ?? ''],
      )
    rows.push(['Mode', { readOnly: 'read-only', readWrite: 'read-write', full: 'full' }[profile.mode]])
    if (!profile.path) rows.push(['TLS', profile.sslMode])
  } else if (node.kind === 'database') {
    rows.push(['Database', node.database], ['Connection', profile.name])
  } else if (node.kind === 'schema') {
    rows.push(['Schema', node.schema], ['Database', node.database])
  } else if (node.kind === 'object') {
    rows.push(
      ['Name', node.object.name],
      ['Kind', node.object.kind],
      ['Schema', node.schema],
      ['Database', node.database],
    )
  } else {
    rows.push(['Schema', node.schema])
  }
  return (
    <div className="p-3">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="m-0 truncate select-text" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {node.kind === 'object' && loaded?.status === 'ready' && loaded.columns && (
        <table className="mt-3 w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 font-normal">Column</th>
              <th className="py-1 font-normal">Type</th>
            </tr>
          </thead>
          <tbody>
            {loaded.columns.map((c) => (
              <tr key={c.name} className="border-t border-border/60">
                <td className="py-1 pr-2 align-top [overflow-wrap:anywhere]">
                  {c.name}
                  {c.primaryKeyPosition !== null && (
                    <span className="ml-1 text-[10px] font-semibold text-accent">PK</span>
                  )}
                </td>
                <td className="py-1 align-top text-muted">
                  {c.dbType}
                  {!c.nullable && (
                    <span className="ml-1 rounded bg-raised px-1 text-[10px] whitespace-nowrap">
                      not null
                    </span>
                  )}
                  {c.default !== null && <span className="block truncate">default {c.default}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
