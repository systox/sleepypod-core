'use client'

import { Button, Card, InlineError } from '@/src/components/ds'
import type { Side } from '@/src/hardware/types'
import { formatClock } from '@/src/lib/timeFormat'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import { trpc } from '@/src/utils/trpc'

/** Offers to move an hour of a curve where presses keep landing. Nothing changes until accepted. */
export function MorningSuggestions({ names }: { names: Record<Side, string> }) {
  const timeFormat = useTimeFormat()
  const utils = trpc.useUtils()
  const { data } = trpc.fork.suggestions.useQuery()
  const answer = trpc.fork.answerSuggestion.useMutation({
    onSuccess: () => Promise.all([utils.fork.suggestions.invalidate(), utils.curveTemplates.list.invalidate(), utils.schedules.getAll.invalidate()]),
  })
  const clock = (time: string) => {
    const [hour, minute] = time.split(':').map(Number)
    return formatClock(new Date(2026, 0, 1, hour, minute), timeFormat)
  }
  if (!data || data.length === 0) return null
  return (
    <div className="flex flex-col gap-2.5">
      {data.map(s => (
        <Card key={s.id} className="gap-2">
          <span className="text-sm">
            {`${names[s.side]}: ${s.delta > 0 ? 'warmer' : 'cooler'} presses between ${clock(s.from)} and ${clock(s.to)} on ${s.nights} of the last ${s.of} nights of ${s.curveName}. ${s.delta > 0 ? 'Raise' : 'Lower'} that hour by ${Math.abs(s.delta)}°F?`}
          </span>
          <div className="flex gap-2">
            <Button variant="primary" disabled={answer.isPending} onClick={() => answer.mutate({ side: s.side, id: s.id, accept: true })}>{s.delta > 0 ? 'Raise it' : 'Lower it'}</Button>
            <Button disabled={answer.isPending} onClick={() => answer.mutate({ side: s.side, id: s.id, accept: false })}>Not now</Button>
          </div>
        </Card>
      ))}
      {answer.error && <InlineError>{answer.error.message}</InlineError>}
    </div>
  )
}

/** Each self-test curve's nights side by side. */
export function SelfTestSummary({ side, name }: { side: Side, name: string }) {
  const { data } = trpc.fork.selfTest.useQuery({ side })
  if (!data || data.every(c => c.nights === 0)) return null
  return (
    <Card className="gap-1.5">
      <span className="sp-label">{`${name} · self-test nights`}</span>
      {data.map((c, i) => (
        <div key={c.curveId} className="flex items-center gap-2 text-[13px]">
          {`${i === 0 ? 'A' : 'B'} · ${c.name ?? 'Curve'}`}
          <span className="ml-auto font-mono text-xs text-fg-2">
            {`${c.nights} night${c.nights === 1 ? '' : 's'} · ${c.pressesPerNight.toFixed(1)} presses · ${c.outsPerNight.toFixed(1)} times up`}
          </span>
        </div>
      ))}
    </Card>
  )
}
