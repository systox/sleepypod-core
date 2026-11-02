'use client'

import { useCallback } from 'react'
import { SelectValue, Toggle } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'

const DEFAULT_HOLD_MINUTES = 30

export const FORK_HOLD_OPTIONS: ReadonlyArray<{ value: number, label: string }> = [
  { value: 0, label: 'Off' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hr' },
  { value: 120, label: '2 hr' },
]

/** The saved Hold after adjustment, so presses, the app and HomeKit all read one value. */
export function useHoldSetting(): [number, (minutes: number) => void] {
  const utils = trpc.useUtils()
  const overview = trpc.fork.overview.useQuery(undefined, { staleTime: 30_000 })
  const save = trpc.fork.setPodSettings.useMutation({ onSuccess: () => utils.fork.overview.invalidate() })
  const { mutate } = save
  const set = useCallback((holdMinutes: number) => mutate({ patch: { holdMinutes } }), [mutate])
  return [save.variables?.patch.holdMinutes ?? overview.data?.pod.holdMinutes ?? DEFAULT_HOLD_MINUTES, set]
}

/** Hold after adjustment, with Smooth return shown only when a hold length is chosen. */
export function HoldRow({ holdMinutes, onDurationChange }: {
  holdMinutes: number
  onDurationChange: (minutes: number) => void
}) {
  const utils = trpc.useUtils()
  const overview = trpc.fork.overview.useQuery(undefined, { staleTime: 30_000 })
  const save = trpc.fork.setPodSettings.useMutation({ onSuccess: () => utils.fork.overview.invalidate() })
  const pod = overview.data?.pod
  const smooth = save.variables?.patch.smoothReturn ?? pod?.smoothReturn ?? false
  const stepMinutes = Math.round(60 / (pod?.smoothRatePerHour ?? 2.7))

  return (
    <div className="mt-auto flex flex-col gap-2 border-t border-line pt-3 text-sm text-fg-2 min-[900px]:text-[13px]">
      <div className="flex items-center gap-3">
        Hold after adjustment
        <SelectValue className="ml-auto" label="Temperature hold duration" value={holdMinutes} options={FORK_HOLD_OPTIONS} onChange={onDurationChange} />
      </div>
      {holdMinutes > 0
        ? (
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                Smooth return
                <span className="text-xs leading-[1.35]">
                  {smooth
                    ? `When the hold ends, moves back to the curve 1° every ${stepMinutes} minutes`
                    : 'When the hold ends, goes straight back to the curve'}
                </span>
              </div>
              <Toggle className="ml-auto shrink-0" on={smooth} label="Smooth return" onChange={smoothReturn => save.mutate({ patch: { smoothReturn } })} />
            </div>
          )
        : <span className="text-xs">Your change lasts until the curve&apos;s next step</span>}
    </div>
  )
}
