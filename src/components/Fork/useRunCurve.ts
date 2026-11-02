'use client'

import type { CurvePoint } from '@/src/components/TempScreen/timelineLogic'
import type { Side } from '@/src/hardware/types'
import { trpc } from '@/src/utils/trpc'

const MINUTE = 60_000

/** Tonight's moved curve while Smart start is running one, or null. */
export function useRunCurve(side: Side): CurvePoint[] | null {
  const { data } = trpc.fork.overview.useQuery(undefined, { staleTime: 30_000, refetchInterval: 60_000 })
  const run = data?.[side].run
  if (!run?.points || run.curveZeroAt === null) return null
  const zero = run.curveZeroAt
  return run.points.map(p => ({ at: zero + p.offset * MINUTE, temperature: p.temperature }))
}
