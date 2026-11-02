'use client'

import { Card } from '@/src/components/ds'
import type { Side } from '@/src/hardware/types'
import { trpc } from '@/src/utils/trpc'
import { useForkOverview } from './useFork'

/** The Both view: each side's week and what comes next. Editing needs one side. */
export function BothRotation({ names }: { names: Record<Side, string> }) {
  const { data } = useForkOverview()
  const weeks = trpc.fork.listWeeks.useQuery()
  const nameOf = (id: string) => weeks.data?.find(w => w.id === id)?.name ?? 'Missing'
  const rows = (['left', 'right'] as const).flatMap((side) => {
    const view = data?.[side].rotation
    if (!view) return []
    const { rotation, week, thisPresetId } = view
    const n = rotation.steps.length
    const next = rotation.steps[(((week + 1) % n) + n) % n]
    return [{ side, text: `${nameOf(thisPresetId)} · next ${nameOf(next)}${rotation.paused ? ' · paused' : ''}` }]
  })
  if (rows.length === 0) return null
  return (
    <Card className="gap-1.5">
      <span className="sp-label">Rotation</span>
      {rows.map(row => (
        <div key={row.side} className="flex items-center gap-2 text-[13px]">
          {names[row.side]}
          <span className="ml-auto font-mono text-xs text-fg-2">{row.text}</span>
        </div>
      ))}
    </Card>
  )
}
