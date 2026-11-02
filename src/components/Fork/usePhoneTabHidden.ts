'use client'

import type { NavId } from '@/src/components/AppShell/navItems'
import { trpc } from '@/src/utils/trpc'

/**
 * Phones already have 7 tabs, so an eighth would run off the screen. Once
 * Smart start is on, Tonight takes Autopilot's slot. Until then it stays out
 * of the way, and Settings and the sidebar still reach it.
 */
export function usePhoneTabHidden(): NavId {
  const { data } = trpc.fork.overview.useQuery(undefined, { staleTime: 60_000 })
  return data?.left.settings.smartStart || data?.right.settings.smartStart ? 'autopilot' : 'tonight'
}
