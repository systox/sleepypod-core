'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Card, SettingRow, Toggle } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import type { Side } from '@/src/hardware/types'
import { useSideNames } from '@/src/hooks/useSideNames'
import { trpc } from '@/src/utils/trpc'
import { useForkOverview, useForkRefresh } from './useFork'

/** The three switches, each saying what happens with tonight's real times. */
export function SwitchCard({ side }: { side: Side }) {
  const { data } = useForkOverview()
  const refresh = useForkRefresh()
  const lang = langFromPath(usePathname())
  const { sideName } = useSideNames()
  const save = trpc.fork.setSideSettings.useMutation({ onSuccess: refresh })
  if (!data) return null

  const view = data[side]
  const { settings } = view
  // Said against the curve's start, not as clock times: the curve, and so the hours, can change from night to night.
  const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`
  const needsSmart = 'Only works with Smart start on.'
  const set = (patch: Partial<typeof settings>) => save.mutate({ side, patch })

  const other: Side = side === 'left' ? 'right' : 'left'
  const follower = data[other].following?.leader === side ? data[other].following : null
  const lead = view.following
  const following = lead && (lead.why === 'away'
    ? `Away: this side follows ${sideName(lead.leader)}'s curve and Smart start. Its own settings below apply again once it's back.`
    : `Unused side: it follows ${sideName(lead.leader)}'s curve and Smart start. Its own settings below apply once the bed is set up for two.`)
  const followed = follower && (follower.why === 'away'
    ? `While ${sideName(other)} is away, their side follows this curve and Smart start too.`
    : 'The unused side follows this curve and Smart start too.')

  return (
    <Card className="gap-2.5">
      {(following || followed) && <span className="text-[13px] text-fg-2">{following || followed}</span>}
      <SettingRow
        divider={false}
        label="Smart start"
        sub={`Starts the curve when someone gets into bed, instead of at its set time, and ends it after they get up. ${settings.smartStart
          ? `It watches from ${hours(settings.hoursEarly)} before each night's curve start until ${hours(settings.hoursLate)} after it; getting in outside those hours doesn't start it.${data.pod.detection === 'live' ? '' : ' It isn\'t acting yet: set Detection to Live in Tonight settings.'}`
          : 'Off: the curve runs at its set times, whether or not anyone is in bed.'}`}
      >
        <Toggle on={settings.smartStart} label="Smart start" onChange={smartStart => set({ smartStart })} />
      </SettingRow>
      <SettingRow
        divider={false}
        className={settings.smartStart ? undefined : 'opacity-45'}
        label="Conditioning"
        sub={!settings.smartStart
          ? needsSmart
          : settings.warmUp
            ? `At the curve's start time the side comes on, even with nobody in bed, and brings the bed to the curve's opening temperature, warm or cool. It holds there for up to ${hours(settings.warmUpWaitHours)} for someone to get in.`
            : 'The side stays off until someone gets in bed.'}
      >
        <Toggle on={settings.warmUp} label="Conditioning" disabled={!settings.smartStart} onChange={warmUp => set({ warmUp })} />
      </SettingRow>
      <SettingRow
        divider={false}
        className={settings.smartStart ? undefined : 'opacity-45'}
        label="Reading mode"
        sub={!settings.smartStart
          ? needsSmart
          : settings.readingMode
            ? `In bed up to ${hours(settings.hoursEarly)} before the curve's start: about ${settings.minutesToCall} minutes after you get in, the side comes on and holds the curve's first temperature until the start time. Then the curve begins.`
            : `In bed up to ${hours(settings.hoursEarly)} before the curve's start: the whole curve starts about ${settings.minutesToCall} minutes after you get in.`}
      >
        <Toggle on={settings.readingMode} label="Reading mode" disabled={!settings.smartStart} onChange={readingMode => set({ readingMode })} />
      </SettingRow>
      {settings.smartStart && (
        <span className="border-t border-line pt-2.5 text-xs leading-[1.4] text-fg-2">
          <Link href={`/${lang}/tonight?view=settings`}>Change the hours in Tonight settings.</Link>
        </span>
      )}
    </Card>
  )
}
