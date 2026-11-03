'use client'

import { cn } from '@/lib/utils'
import type { SavedCurve } from '@/src/hooks/useCurveTemplates'
import { DAY_SHORT, dayBars, WEEK_DAYS, type WeekDays } from './weekLogic'

/** Seven small bars, one for each day, marking when the side runs on that day. */
export function WeekBars({ days, curves, height = 30, todayIndex = -1, labels = false }: {
  days: WeekDays
  curves: ReadonlyMap<number, SavedCurve>
  height?: number
  todayIndex?: number
  labels?: boolean
}) {
  return (
    <span className="grid w-full grid-cols-7 gap-[3px]" aria-hidden>
      {WEEK_DAYS.map((day, i) => (
        <span key={day} className="flex flex-col items-center gap-1">
          <span className="relative block w-full overflow-hidden rounded-[3px] bg-active" style={{ height }}>
            {dayBars(days, day, curves).map(bar => (
              <span
                key={bar.top}
                className={cn('absolute inset-x-0 rounded-[3px]', i === todayIndex ? 'bg-ok' : 'bg-cool')}
                style={{ top: `${bar.top}%`, height: `${bar.height}%` }}
              />
            ))}
          </span>
          {labels && <span className="font-mono text-[10px] text-fg-2">{DAY_SHORT[day].slice(0, 1)}</span>}
        </span>
      ))}
    </span>
  )
}
