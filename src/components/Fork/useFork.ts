'use client'

import { trpc } from '@/src/utils/trpc'

/** The fork's whole state, shared by the Tonight page and the Schedule cards. */
export function useForkOverview(refetchInterval: number | false = 30_000) {
  return trpc.fork.overview.useQuery(undefined, { refetchInterval, staleTime: 10_000 })
}

export function useForkRefresh(): () => Promise<void> {
  const utils = trpc.useUtils()
  return async () => {
    await Promise.all([
      utils.fork.overview.invalidate(),
      utils.fork.listWeeks.invalidate(),
      utils.curveTemplates.list.invalidate(),
      utils.schedules.getAll.invalidate(),
      utils.schedules.getByDay.invalidate(),
    ])
  }
}
