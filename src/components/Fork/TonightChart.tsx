'use client'

import { useMemo } from 'react'
import type { Side } from '@/src/hardware/types'
import { trpc } from '@/src/utils/trpc'
import type { SideView } from './tonightLogic'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const WIDTH = 300
const HEIGHT = 80
const PAD = 4

/** Tonight's curve against the measured surface, with presses and time out of bed. */
export function TonightChart({ side, view, now }: { side: Side, view: SideView, now: number }) {
  const { run, tonight } = view
  const points = run.points ?? tonight?.points ?? null
  const zero = run.curveZeroAt ?? tonight?.bedtime ?? null
  const start = zero === null ? null : Math.min(zero, now)
  const length = points ? points[points.length - 1].offset * MINUTE : 0
  const end = zero === null ? null : Math.max(zero + length, now)
  const range = useMemo(() => (start === null || end === null
    ? null
    : {
        startDate: new Date(start - start % (5 * MINUTE)),
        endDate: new Date(end - end % (5 * MINUTE) + 5 * MINUTE),
      }), [start, end])
  const surface = trpc.environment.getBedTemp.useQuery(
    { ...range, limit: 1000, unit: 'F' },
    { enabled: range !== null && Boolean(run.points), refetchInterval: 60_000 },
  )
  const events = trpc.fork.nights.useQuery(
    { from: range?.startDate.getTime() ?? 0, to: (range?.endDate.getTime() ?? 0) + HOUR },
    { enabled: range !== null, refetchInterval: 60_000 },
  )

  if (!points || zero === null || start === null || end === null) return null

  const measured = (surface.data ?? [])
    .map(r => ({ at: new Date(r.timestamp).getTime(), temperature: side === 'left' ? r.leftCenterTemp : r.rightCenterTemp }))
    .filter((r): r is { at: number, temperature: number } => r.temperature !== null)
    .sort((a, b) => a.at - b.at)
  const curve = points.map(p => ({ at: zero + p.offset * MINUTE, temperature: p.temperature }))
  const temps = [...curve, ...measured].map(p => p.temperature)
  const low = Math.min(...temps)
  const high = Math.max(...temps, low + 1)
  const x = (at: number) => ((at - start) / Math.max(1, end - start) * WIDTH).toFixed(1)
  const y = (t: number) => ((high - t) / (high - low) * (HEIGHT - PAD * 2) + PAD).toFixed(1)
  const line = (series: Array<{ at: number, temperature: number }>) => series.map(p => `${x(p.at)},${y(p.temperature)}`).join(' ')
  const sideEvents = (events.data?.events ?? []).filter(e => e.side === side)
  const presses = sideEvents.filter(e => e.kind === 'press')
  const outs = sideEvents.filter(e => e.kind === 'out').map((out) => {
    const back = sideEvents.find(e => e.kind === 'in' && e.ts > out.ts)
    return { from: out.ts, to: back?.ts ?? now }
  })

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} preserveAspectRatio="none" role="img" aria-label="Tonight's curve and measured surface">
      {outs.map(o => (
        <rect key={o.from} x={x(o.from)} y={0} width={Math.max(1, Number(x(o.to)) - Number(x(o.from)))} height={HEIGHT} fill="var(--surface-active)" />
      ))}
      <polyline points={line(measured)} fill="none" stroke="var(--accent-warm)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <polyline points={line(curve)} fill="none" stroke="var(--accent-cool)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {presses.map(p => (
        <line key={p.id} x1={x(p.ts)} x2={x(p.ts)} y1={HEIGHT - 8} y2={HEIGHT} stroke="var(--text-1)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ))}
      <line x1={x(now)} x2={x(now)} y1={0} y2={HEIGHT} stroke="var(--text-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
