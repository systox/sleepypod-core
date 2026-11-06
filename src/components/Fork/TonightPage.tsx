'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMemo } from 'react'
import { Button, Card, InlineError, PageHeader, SectionLabel, SegmentedControl, Skeleton, StatusDot } from '@/src/components/ds'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import type { Side } from '@/src/hardware/types'
import { formatSetpointF } from '@/src/lib/tempUtils'
import { formatClock } from '@/src/lib/timeFormat'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import { trpc } from '@/src/utils/trpc'
import { ForkSettings } from './ForkSettings'
import { describeSide, nextStep, type SideView } from './tonightLogic'
import { NightsList } from './NightsList'
import { TonightChart } from './TonightChart'
import { useForkOverview, useForkRefresh } from './useFork'

const VIEWS = [
  { value: 'tonight', label: 'Tonight' },
  { value: 'nights', label: 'Nights' },
  { value: 'settings', label: 'Settings' },
] as const
type View = typeof VIEWS[number]['value']

/** How long the Tonight page says a side came back on after a restart. */
const RESUMED_SHOWN_MS = 12 * 3_600_000

function SideCard({ side, name, otherName, view, now }: { side: Side, name: string, otherName: string, view: SideView, now: number }) {
  const refresh = useForkRefresh()
  const timeFormat = useTimeFormat()
  const weeks = trpc.fork.listWeeks.useQuery()
  const command = trpc.fork.command.useMutation({ onSuccess: refresh })
  const { unit } = useTemperatureUnit()
  const clock = (at: number) => formatClock(at, timeFormat)
  const { run } = view
  const running = run.phase === 'running' || run.phase === 'reading' || run.phase === 'warming'
  const inGap = run.fullRunEndedAt !== null && now < run.fullRunEndedAt + view.settings.minimumGapHours * 3_600_000
  const weekId = view.rotation?.thisPresetId
  const weekName = weeks.data?.find(w => w.id === weekId)?.name
  const step = nextStep(view, now)

  return (
    <Card className="gap-3">
      <div className="flex items-center gap-2">
        <span className="sp-label">{name}</span>
        {weekName && <span className="ml-auto font-mono text-xs text-fg-2">{weekName}</span>}
      </div>
      <span className="text-[15px] font-medium">{describeSide(view, now, clock)}</span>
      {view.fade
        ? <span className="text-[13px] text-fg-2">{`Easing back to ${formatSetpointF(view.fade.curve, unit)} by ${clock(view.fade.by)}`}</span>
        : step && <span className="text-[13px] text-fg-2">{`Next: ${formatSetpointF(step.temperature, unit)} at ${clock(step.at)}`}</span>}
      {run.note && <span className="text-[13px] text-fg-2">{run.note}</span>}
      {view.following && (
        <span className="text-[13px] text-fg-2">
          {`The whole bed is ${otherName}'s while ${view.following.why === 'away' ? 'this side\'s sleeper is away' : 'it is set up for one'}: both halves run ${otherName}'s curve and Smart start, and the buttons on either half change both.`}
        </span>
      )}
      {view.resumedAt !== null && now - view.resumedAt < RESUMED_SHOWN_MS && (
        <span className="text-[13px] text-fg-2">{`Turned back on at ${clock(view.resumedAt)}: it was on when the Pod lost power or restarted.`}</span>
      )}
      {view.settings.surfaceMode !== 'off' && (
        <span className="text-[13px] text-fg-2">
          {`Surface ${view.surface.reading === null ? 'unknown' : formatSetpointF(view.surface.reading, unit)} · range ${formatSetpointF(view.settings.surfaceLowF, unit)} to ${formatSetpointF(view.settings.surfaceHighF, unit)}`
            + (view.settings.surfaceMode === 'watch' ? ' · watching only' : view.surface.offset !== 0 ? ` · water ${view.surface.offset > 0 ? '+' : ''}${view.surface.offset}°F` : '')}
        </span>
      )}
      <TonightChart side={side} view={view} now={now} />
      {view.settings.smartStart && !view.following && (
        <div className="flex flex-wrap gap-2">
          {!running && !inGap && <Button disabled={command.isPending} onClick={() => command.mutate({ side, command: 'start-new' })}>Start</Button>}
          {!running && inGap && (
            <>
              <Button disabled={command.isPending} onClick={() => command.mutate({ side, command: 'start-back' })}>Back to Bed</Button>
              <Button disabled={command.isPending} onClick={() => command.mutate({ side, command: 'start-new' })}>New Night</Button>
            </>
          )}
          {run.phase === 'reading' && <Button disabled={command.isPending} onClick={() => command.mutate({ side, command: 'sleep-now' })}>Sleep Now</Button>}
          {running && <Button disabled={command.isPending} onClick={() => command.mutate({ side, command: 'stop' })}>Stop</Button>}
        </div>
      )}
      {command.error && <InlineError>{command.error.message}</InlineError>}
    </Card>
  )
}

/** Each side's state in words, past nights, and every number in the design. */
export function TonightPage() {
  const { data, error, isLoading } = useForkOverview(15_000)
  const { leftName, rightName } = useSideNames()
  const sideNames = { left: leftName, right: rightName }
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const param = params.get('view')
  const view: View = useMemo(() => VIEWS.find(v => v.value === param)?.value ?? 'tonight', [param])
  const health = data?.health

  return (
    <>
      <PageHeader
        title="Tonight"
        middle={<SegmentedControl ariaLabel="View" options={[...VIEWS]} value={view} onChange={next => router.replace(`${pathname}?view=${next}`)} />}
      />
      {isLoading && <Skeleton className="h-[240px]" />}
      {error && <Card><InlineError>{`Failed to load: ${error.message}`}</InlineError></Card>}
      {health && (health.disabled || !health.running) && (
        <Card><InlineError>{health.disabled ?? 'The service isn\'t running, so the weekly schedule is in charge.'}</InlineError></Card>
      )}
      {data && (data.left.settings.smartStart || data.right.settings.smartStart) && (data.dailyJobs.prime || data.dailyJobs.reboot) && (
        <Card>
          <InlineError>Daily priming or reboot is on. They run at fixed times without checking the bed, so they can land on someone&apos;s sleep.</InlineError>
        </Card>
      )}
      {data && view === 'tonight' && (
        <>
          <div className="grid gap-3.5 min-[900px]:grid-cols-2 min-[900px]:gap-3">
            <SideCard side="left" name={sideNames.left} otherName={sideNames.right} view={data.left} now={data.now} />
            <SideCard side="right" name={sideNames.right} otherName={sideNames.left} view={data.right} now={data.now} />
          </div>
          <SectionLabel className="mt-1">Detection</SectionLabel>
          <div className="flex items-center gap-2 font-mono text-xs text-fg-2">
            <StatusDot tone={health?.sensorsFresh ? 'ok' : 'warn'} />
            {`${data.pod.detection === 'off' ? 'Off' : data.pod.detection === 'watch' ? 'Watch-only' : 'Live'} · ${health?.sensorsFresh ? 'sensors reporting' : 'sensors blind'}`}
          </div>
          {data.pod.detection === 'live' || <span className="text-[13px] text-fg-2">Smart start only acts while detection is live. Set it in Settings once the watch-only nights pass.</span>}
        </>
      )}
      {data && view === 'nights' && <NightsList names={sideNames} now={data.now} />}
      {data && view === 'settings' && <ForkSettings pod={data.pod} left={data.left.settings} right={data.right.settings} names={sideNames} />}
    </>
  )
}
