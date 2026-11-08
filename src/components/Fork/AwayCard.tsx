'use client'

import { useLayoutEffect, useRef } from 'react'
import { Card, CardHeader, InlineError, SelectValue, SettingRow, Toggle } from '@/src/components/ds'
import type { Side } from '@/src/hardware/types'
import { formatClock, type TimeFormat } from '@/src/lib/timeFormat'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import { trpc } from '@/src/utils/trpc'
import { useForkOverview, useForkRefresh } from './useFork'

type ZoneMode = 'off' | 'follow' | 'independent'

interface Sleeper { name: string, away: boolean, awayReturn: string | null }

/** What the card needs to word itself, gathered from the settings and the fork's state. */
export interface AwayFacts {
  sleepers: Record<Side, Sleeper>
  zoneMode: ZoneMode
  /** The bed is set up for one sleeper, so the same choice covers its empty side. */
  solo: boolean
  smartStart: Record<Side, boolean>
}

const other = (side: Side): Side => side === 'left' ? 'right' : 'left'

/** The return time in words, such as "Sat, Nov 7, 4:00 PM". */
export function returnWords(iso: string, timeFormat: TimeFormat): string {
  const at = new Date(iso)
  return `${at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${formatClock(at, timeFormat)}`
}

/** What switching a sleeper away does, or how long they're away for. */
export function awayLine(side: Side, facts: AwayFacts, timeFormat: TimeFormat): string {
  const { name, away, awayReturn } = facts.sleepers[side]
  if (!away) return `Pauses ${name}'s alarms and sleep tracking. ${name}'s curves and settings stay saved.`
  return awayReturn && new Date(awayReturn).getTime() > Date.now()
    ? `Away until ${returnWords(awayReturn, timeFormat)}. Then ${name}'s own curve and settings apply again.`
    : 'Away until switched off, or until the time set below.'
}

/** The away side's choices, named for the sleeper at home when only one is away. */
export function zoneOptions(facts: AwayFacts): Array<{ value: ZoneMode, label: string }> {
  const away = (['left', 'right'] as const).filter(side => facts.sleepers[side].away)
  const home = away.length === 1 ? facts.sleepers[other(away[0])].name : null
  return [
    { value: 'off', label: 'Turns off' },
    { value: 'follow', label: home ? `Matches ${home}'s side` : 'Matches the other side' },
    { value: 'independent', label: 'Keeps its own curve' },
  ]
}

/** The choice's name: whose side it is, when only one sleeper is away. */
export function zoneLabel(facts: AwayFacts): string {
  const away = (['left', 'right'] as const).filter(side => facts.sleepers[side].away)
  return away.length === 1 ? `${facts.sleepers[away[0]].name}'s side while away` : 'The away sleeper\'s side'
}

/** What the chosen setting does, with tonight's names when someone is away. */
export function zoneLine(facts: AwayFacts): string {
  return facts.solo ? `${awayZoneLine(facts)} The same choice sets the empty side of this bed, which is set up for one sleeper.` : awayZoneLine(facts)
}

function awayZoneLine(facts: AwayFacts): string {
  const away = (['left', 'right'] as const).filter(side => facts.sleepers[side].away)
  if (away.length === 2) return 'Both sleepers are away, so both sides stay off whatever this is set to.'
  if (away.length === 0) {
    if (facts.zoneMode === 'off') return 'Nobody is away. When someone is, their side stays off.'
    if (facts.zoneMode === 'follow') return 'Nobody is away. When someone is, the whole bed becomes the home sleeper\'s: both halves run their curve, and either half\'s buttons change both.'
    return 'Nobody is away. When someone is, their side keeps running its own curve.'
  }
  const gone = away[0]
  const homeSide = other(gone)
  const { name } = facts.sleepers[gone]
  const home = facts.sleepers[homeSide].name
  if (facts.zoneMode === 'off') return `${name}'s side stays off until ${name} is back.`
  if (facts.zoneMode === 'independent') return `${name}'s side keeps running ${name}'s own curve, as if ${name} were home.`
  return facts.smartStart[homeSide]
    ? `The whole bed is ${home}'s until ${name} is back: both halves run ${home}'s curve, starting and ending with ${home}'s Smart start, and either half's buttons change both.`
    : `The whole bed is ${home}'s until ${name} is back: both halves run ${home}'s curve at its set times, and either half's buttons change both.`
}

/** The value a datetime-local field shows for an ISO time, in this browser's time zone. */
function fieldValue(iso: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/**
 * Away mode for the sleeper picked on the Schedule page, with what their side
 * does while they're gone. An away sleeper is listed here from either
 * sleeper's page, so the way back is never on the other tab.
 */
export function AwayCard({ side, both }: { side: Side, both: boolean }) {
  const timeFormat = useTimeFormat()
  const { data: settings } = trpc.settings.getAll.useQuery({}, { staleTime: 30_000 })
  const { data: fork } = useForkOverview()
  const utils = trpc.useUtils()
  const refresh = useForkRefresh()
  // A change here reshapes the page above (curve cards, the side's notes), so the
  // card is held where it sat on screen until the page has caught up.
  const card = useRef<HTMLDivElement>(null)
  const anchor = useRef<number | null>(null)
  const holdPlace = () => {
    anchor.current = card.current?.getBoundingClientRect().top ?? null
  }
  useLayoutEffect(() => {
    if (anchor.current === null || !card.current) return
    const moved = card.current.getBoundingClientRect().top - anchor.current
    if (Math.abs(moved) >= 1) scrollerOf(card.current).scrollBy(0, moved)
  })
  const done = {
    onSuccess: () => Promise.all([utils.settings.getAll.invalidate(), refresh()]),
    onSettled: () => requestAnimationFrame(() => {
      anchor.current = null
    }),
  }
  const saveSide = trpc.settings.updateSide.useMutation(done)
  const saveDevice = trpc.settings.updateDevice.useMutation(done)
  if (!settings) return null

  const sleeper = (s: Side): Sleeper => ({
    name: settings.sides[s].name || (s === 'left' ? 'Left' : 'Right'),
    away: settings.sides[s].awayMode,
    awayReturn: settings.sides[s].awayReturn ?? null,
  })
  const facts: AwayFacts = {
    sleepers: { left: sleeper('left'), right: sleeper('right') },
    zoneMode: (settings.device.unusedZoneMode ?? 'off') as ZoneMode,
    solo: (settings.device.bedMode ?? 'two') !== 'two',
    smartStart: { left: fork?.left.settings.smartStart ?? false, right: fork?.right.settings.smartStart ?? false },
  }
  // Whoever is away first: they're the one most likely being looked for.
  const shown: Side[] = (both ? ['left', 'right'] as Side[] : facts.sleepers[other(side)].away ? [side, other(side)] : [side])
    .sort((a, b) => Number(facts.sleepers[b].away) - Number(facts.sleepers[a].away))
  const zone = zoneLabel(facts)
  const busy = saveSide.isPending || saveDevice.isPending
  const error = saveSide.error ?? saveDevice.error

  return (
    <div ref={card}>
      <Card className="gap-2.5">
        <CardHeader title="Away" subtitle="For nights a sleeper isn't here. Their curves and settings stay as they are." />
        {shown.map((s) => {
          const { name, away, awayReturn } = facts.sleepers[s]
          return (
            <div key={s} className="flex flex-col gap-2">
              <SettingRow divider={false} label={`${name} is away`} sub={awayLine(s, facts, timeFormat)}>
                <Toggle
                  on={away}
                  label={`${name} is away`}
                  disabled={busy}
                  // Switching back clears the return time, or its job would later switch the side on again.
                  onChange={(next) => {
                    holdPlace()
                    saveSide.mutate(next ? { side: s, awayMode: true } : { side: s, awayMode: false, awayReturn: null })
                  }}
                />
              </SettingRow>
              {away && (
                <SettingRow divider={false} label="Back" className="flex-col items-stretch min-[600px]:flex-row min-[600px]:items-center">
                  <input
                    key={awayReturn ?? 'none'}
                    aria-label={`When ${name} is back`}
                    type="datetime-local"
                    className="rounded-ctl border border-line-2 bg-field px-2 py-1 text-sm"
                    defaultValue={fieldValue(awayReturn)}
                    disabled={busy}
                    onBlur={(event) => {
                      const value = event.target.value
                      const next = value ? new Date(value).toISOString() : null
                      if (next === awayReturn) return
                      holdPlace()
                      saveSide.mutate({ side: s, awayReturn: next })
                    }}
                  />
                </SettingRow>
              )}
            </div>
          )
        })}
        <SettingRow
          divider={false}
          label={zone}
          sub={zoneLine(facts)}
          className="flex-col items-stretch min-[600px]:flex-row min-[600px]:items-center"
        >
          <SelectValue
            label={zone}
            value={facts.zoneMode}
            options={zoneOptions(facts)}
            onChange={(unusedZoneMode) => {
              holdPlace()
              saveDevice.mutate({ unusedZoneMode })
            }}
            disabled={busy}
          />
        </SettingRow>
        {error && <InlineError>{error.message}</InlineError>}
      </Card>
    </div>
  )
}

/** The nearest box that scrolls this element, or the page itself. */
function scrollerOf(el: HTMLElement): Element {
  for (let box = el.parentElement; box; box = box.parentElement) {
    const { overflowY } = getComputedStyle(box)
    if ((overflowY === 'auto' || overflowY === 'scroll') && box.scrollHeight > box.clientHeight) return box
  }
  return document.scrollingElement ?? document.documentElement
}
