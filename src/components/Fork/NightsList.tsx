'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, Skeleton } from '@/src/components/ds'
import { formatClock } from '@/src/lib/timeFormat'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import { trpc } from '@/src/utils/trpc'
import { MorningSuggestions, SelfTestSummary } from './MorningSuggestions'
import { groupNights } from './tonightLogic'

const DAY_MS = 86_400_000
const SHOW_DAYS = 14

/** Past nights: in and out times and presses, with a "wrong" button for each. */
export function NightsList({ names, now }: { names: { left: string, right: string }, now: number }) {
  const timeFormat = useTimeFormat()
  const utils = trpc.useUtils()
  const [range] = useState(() => ({ from: now - SHOW_DAYS * DAY_MS, to: now + DAY_MS }))
  const { data, isLoading } = trpc.fork.nights.useQuery(range)
  const mark = trpc.fork.markWrong.useMutation({ onSuccess: () => utils.fork.nights.invalidate() })
  const rows = useMemo(() => groupNights(data?.events ?? []), [data])

  if (isLoading) return <Skeleton className="h-[200px]" />
  if (rows.length === 0) return <Card><span className="text-[13px] text-fg-2">No nights logged yet. Detection has to be on to log them.</span></Card>
  return (
    <div className="flex flex-col gap-2.5">
      <MorningSuggestions names={names} />
      <SelfTestSummary side="left" name={names.left} />
      <SelfTestSummary side="right" name={names.right} />
      {rows.map(row => (
        <Card key={row.key} className="gap-1.5">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{new Date(row.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <span className="sp-label">{row.side === 'left' ? names.left : names.right}</span>
            <span className="ml-auto font-mono text-xs text-fg-2">{`${row.presses} press${row.presses === 1 ? '' : 'es'}`}</span>
          </div>
          {row.events.map((event) => {
            const wrong = data?.wrong.includes(event.id)
            return (
              <div key={event.id} className={cn('flex items-center gap-2 font-mono text-xs', wrong ? 'text-fg-3 line-through' : 'text-fg-2')}>
                {`${event.kind === 'in' ? 'In' : 'Out'} ${formatClock(event.ts, timeFormat)}`}
                {!wrong && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => mark.mutate({ id: event.id })}>Wrong</Button>}
              </div>
            )
          })}
        </Card>
      ))}
    </div>
  )
}
