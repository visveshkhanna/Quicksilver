import { useState } from 'react'
import { Button } from '../../app/ui'
import type { PlanNode } from '../../ipc/types'
import { copyText } from '../../lib/clipboard'
import { errorText, type PlanState, say } from '../../state/app'

/** A statement's plan as a tree, costliest steps easy to spot. */
export function PlanView({ plan }: { plan: PlanState }) {
  if (plan.status === 'loading') return <p className="px-3 py-2 text-muted">Explaining…</p>
  if (plan.status === 'failed') {
    return (
      <div role="alert" className="m-2 rounded border border-[#e5484d]/40 bg-[#e5484d]/8 px-3 py-2">
        <p className="font-semibold text-[#e5484d]">{plan.error}</p>
      </div>
    )
  }
  const top = Math.max(0, ...plan.plan.roots.map((r) => r.cost ?? 0))
  return (
    <section aria-label="Query plan" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-[12px] text-muted">
        <span className="truncate">Plan only: the statement was not run.</span>
        <Button
          small
          className="ml-auto"
          onClick={() =>
            copyText(plan.plan.raw)
              .then(() => say('Copied the plan'))
              .catch((err) => say(errorText(err), true))
          }
        >
          Copy as text
        </Button>
      </div>
      <ul
        aria-label="Plan steps"
        className="m-0 min-h-0 flex-1 list-none overflow-auto p-2 font-mono text-[12px]"
      >
        {plan.plan.roots.map((node, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: plan steps are positional
          <Step key={i} node={node} depth={0} top={top} />
        ))}
      </ul>
    </section>
  )
}

function Step({ node, depth, top }: { node: PlanNode; depth: number; top: number }) {
  const [open, setOpen] = useState(false)
  const share = top > 0 && node.cost !== null ? node.cost / top : 0
  return (
    <li>
      <button
        type="button"
        aria-expanded={node.details.length > 0 ? open : undefined}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-raised"
        style={{ paddingLeft: 4 + depth * 16 }}
      >
        <span className="w-3 shrink-0 text-[10px] text-muted">
          {node.details.length > 0 ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        {node.rows !== null && (
          <span className="shrink-0 text-muted">{Math.round(node.rows).toLocaleString()} rows</span>
        )}
        {node.cost !== null && (
          <span className="flex w-36 shrink-0 items-center gap-1.5">
            <span className="h-1.5 flex-1 overflow-hidden rounded bg-raised">
              <span className="block h-full bg-accent/70" style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
            <span className="w-16 text-right text-muted">{node.cost.toFixed(1)}</span>
          </span>
        )}
      </button>
      {open && node.details.length > 0 && (
        <dl className="m-0 py-1 text-[11px]" style={{ paddingLeft: 26 + depth * 16 }}>
          {node.details.map((d) => (
            <div key={d.name} className="flex gap-2">
              <dt className="shrink-0 text-muted">{d.name}</dt>
              <dd className="m-0 break-all">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {node.children.length > 0 && (
        <ul className="m-0 list-none p-0">
          {node.children.map((child, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: plan steps are positional
            <Step key={i} node={child} depth={depth + 1} top={top} />
          ))}
        </ul>
      )}
    </li>
  )
}
