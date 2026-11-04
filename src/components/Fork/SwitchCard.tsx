'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Card, SettingRow, Toggle } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import type { Side } from '@/src/hardware/types'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatClock } from '@/src/lib/timeFormat'
import { formatSetpointF } from '@/src/lib/tempUtils'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import { trpc } from '@/src/utils/trpc'
import { useForkOverview, useForkRefresh } from './useFork'

/** The three switches, each saying what happens with tonight's real times. */
export function SwitchCard({ side }: { side: Side }) {
  const { data } = useForkOverview()
  const refresh = useForkRefresh()
  const timeFormat = useTimeFormat()
  const { unit } = useTemperatureUnit()
  const lang = langFromPath(usePathname())
  const save = trpc.fork.setSideSettings.useMutation({ onSuccess: refresh })
  if (!data) return null

  const view = data[side]
  const { settings, upcoming } = view
  const clock = (at: number) => formatClock(at, timeFormat)
  const bed = upcoming ? clock(upcoming.bedtime) : 'bedtime'
  const opens = upcoming ? clock(upcoming.windowStart) : 'the window opens'
  const closes = upcoming ? clock(upcoming.windowEnd) : 'the window closes'
  const first = upcoming ? formatSetpointF(upcoming.firstTemperature, unit) : 'the first temperature'
  const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`
  const needsSmart = 'Only works with Smart start on.'
  const set = (patch: Partial<typeof settings>) => save.mutate({ side, patch })

  return (
    <Card className="gap-2.5">
      <SettingRow
        divider={false}
        label="Smart start"
        sub={`Starts the curve when someone gets into bed, instead of at its set time, and ends it after they get up. ${settings.smartStart
          ? `It watches from ${opens} to ${closes}; getting in outside those hours doesn't start it.${data.pod.detection === 'live' ? '' : ' It isn\'t acting yet: set Detection to Live in Tonight settings.'}`
          : 'Off: the curve runs at its set times, whether or not anyone is in bed.'}`}
      >
        <Toggle on={settings.smartStart} label="Smart start" onChange={smartStart => set({ smartStart })} />
      </SettingRow>
      <SettingRow
        divider={false}
        className={settings.smartStart ? undefined : 'opacity-45'}
        label="Warm up"
        sub={!settings.smartStart
          ? needsSmart
          : settings.warmUp
            ? `At ${bed} the side comes on, even with nobody in bed, and waits at ${first} for up to ${hours(settings.warmUpWaitHours)}.`
            : 'The side stays off until someone gets in bed.'}
      >
        <Toggle on={settings.warmUp} label="Warm up" disabled={!settings.smartStart} onChange={warmUp => set({ warmUp })} />
      </SettingRow>
      <SettingRow
        divider={false}
        className={settings.smartStart ? undefined : 'opacity-45'}
        label="Reading mode"
        sub={!settings.smartStart
          ? needsSmart
          : settings.readingMode
            ? `In bed between ${opens} and ${bed}: about 5 minutes after you get in, the side comes on and holds ${first} until ${bed}. Then the curve begins.`
            : `In bed between ${opens} and ${bed}: the whole curve starts about 5 minutes after you get in.`}
      >
        <Toggle on={settings.readingMode} label="Reading mode" disabled={!settings.smartStart} onChange={readingMode => set({ readingMode })} />
      </SettingRow>
      {settings.smartStart && (
        <span className="border-t border-line pt-2.5 text-xs leading-[1.4] text-fg-2">
          {`Smart start counts from ${hours(settings.hoursEarly)} before bedtime to ${hours(settings.hoursLate)} after. `}
          <Link href={`/${lang}/tonight?view=settings`}>Change the hours in Tonight settings.</Link>
        </span>
      )}
    </Card>
  )
}
