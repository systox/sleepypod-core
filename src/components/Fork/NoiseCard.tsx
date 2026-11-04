'use client'

import { Volume2 } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, InlineError, SectionLabel, SelectValue, SettingRow, Slider, StatusDot } from '@/src/components/ds'
import type { NoiseReason } from '@/src/fork/noise'
import type { ForkPodSettings } from '@/src/fork/settings'
import type { Side } from '@/src/hardware/types'
import { useSideNames } from '@/src/hooks/useSideNames'
import { formatClock } from '@/src/lib/timeFormat'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import { trpc } from '@/src/utils/trpc'
import { NumberField } from './ForkSettings'
import { useForkOverview, useForkRefresh } from './useFork'

export interface NoiseView {
  on: boolean
  playing: boolean
  reason: NoiseReason | null
  since: number | null
  problem: string | null
}

const COLORS = [
  { value: 'pink', label: 'Pink' },
  { value: 'brown', label: 'Brown' },
  { value: 'white', label: 'White' },
] as const
const ACTIONS = [
  { value: 'none', label: 'Nothing' },
  { value: 'noise', label: 'White noise on or off' },
] as const
const GESTURES = [
  { key: 'middleSingle', label: 'One press' },
  { key: 'middleDouble', label: 'Two presses' },
  { key: 'middleTriple', label: 'Three presses' },
  { key: 'middleLong', label: 'Long press' },
] as const
const STARTED_BY: Record<NoiseReason, string> = {
  'app': 'from the app',
  'button': 'from the middle button',
  'bedtime': 'at the curve\'s start time',
  'smart-start': 'as someone got into bed',
  'return': 'as someone got back into bed',
}
const STARTS = [
  { value: 'off', label: 'Off' },
  { value: 'clock', label: 'At the curve\'s start time' },
  { value: 'smart', label: 'When someone gets into bed (Smart start)' },
] as const

/** What the chosen way of starting does, in a sentence. */
export function startLine(start: ForkPodSettings['noiseStart'], detection: ForkPodSettings['detection']): string {
  if (start === 'off') return 'Starts only from Play or the middle button.'
  if (start === 'clock') return 'Starts at the curve\'s start time, even if nobody is in bed yet.'
  if (detection !== 'live') return 'Starts at the curve\'s start time for now: starting when someone gets into bed needs Detection set to Live in Tonight settings.'
  return 'Starts as Smart start begins someone\'s curve, a few minutes after they get into bed, even if Reading mode holds the curve until its start time. A sleeper without Smart start gets it at the curve\'s start time. Smart start is set per sleeper on the Schedule page.'
}

function useSetNoise() {
  const refresh = useForkRefresh()
  const utils = trpc.useUtils()
  return trpc.fork.setNoise.useMutation({ onSuccess: () => Promise.all([refresh(), utils.fork.noiseStatus.invalidate()]) })
}

export function noiseLine(noise: NoiseView, volume: number, clock: (at: number) => string): string {
  if (!noise.on) return 'Off'
  const started = noise.since === null ? '' : ` since ${clock(noise.since)}`
  const by = noise.reason ? `, started ${STARTED_BY[noise.reason]}` : ''
  if (volume === 0) return `On but silent: the volume is 0${by}`
  return noise.playing ? `Playing${started}${by}` : `Starting${by}`
}

/** The 3D stage is dark in either theme, so its slider takes the dark colours. */
const STAGE_SLIDER = { '--text-1': '#ececec', '--border-2': '#3a3a3e', '--surface-card': '#0b0b0c' } as CSSProperties

/**
 * The white noise volume as a slider. It saves once the slider is let go, and
 * a playing session changes volume within a few seconds without a break.
 */
function NoiseVolume({ volume, className, style }: { volume: number, className?: string, style?: CSSProperties }) {
  const refresh = useForkRefresh()
  const save = trpc.fork.setPodSettings.useMutation({ onSuccess: refresh })
  const [draft, setDraft] = useState<number | null>(null)
  const commit = (value: number) => {
    if (value === volume) setDraft(null)
    else save.mutate({ patch: { noiseVolume: value } }, { onSettled: () => setDraft(null) })
  }
  const shown = draft ?? volume
  return (
    <span className={cn('inline-flex items-center gap-2', className)} style={className ? { ...STAGE_SLIDER, ...style } : style}>
      <span className="font-mono text-xs tabular-nums">{`Vol ${shown}`}</span>
      <Slider className="w-28 flex-none" label="White noise volume" value={shown} step={5} onChange={setDraft} onCommit={commit} />
      {save.error && <span role="alert" className="text-xs text-danger" title={save.error.message}>Not saved</span>}
    </span>
  )
}

/**
 * White noise on or off now for the Temp screen, with its volume while it
 * plays, and why it isn't playing when the player has failed. The 3D stage
 * passes its own pill look; the card view uses the standard button.
 */
export function NoiseQuickToggle({ className, style }: { className?: string, style?: CSSProperties }) {
  const { data } = useForkOverview()
  const set = useSetNoise()
  if (!data) return null
  const on = data.noise.on
  const label = on ? 'Stop white noise' : 'White noise'
  const toggle = () => set.mutate({ on: !on })
  const volume = on && <NoiseVolume volume={data.pod.noiseVolume} className={className} style={style} />
  const problem = on && !data.noise.playing ? data.noise.problem : null
  if (className) {
    return (
      <>
        <button type="button" className={className} style={style} disabled={set.isPending} onClick={toggle} aria-pressed={on}>
          <Volume2 size={14} />
          {label}
        </button>
        {volume}
        {problem && <span role="alert" className={cn(className, 'cursor-default text-danger hover:bg-transparent')} style={style} title={problem}>Not playing</span>}
      </>
    )
  }
  return (
    <>
      <Button size="sm" icon={Volume2} disabled={set.isPending} onClick={toggle} aria-pressed={on}>
        {label}
      </Button>
      {volume}
      {problem && <InlineError className="basis-full">{`White noise isn't playing. ${problem}`}</InlineError>}
    </>
  )
}

/** White noise from the base's speaker. One speaker, so one setting for the bed. */
export function NoiseCard({ pod, noise, names }: { pod: ForkPodSettings, noise: NoiseView, names: Record<Side, string> }) {
  const refresh = useForkRefresh()
  const timeFormat = useTimeFormat()
  const save = trpc.fork.setPodSettings.useMutation({ onSuccess: refresh })
  const set = useSetNoise()
  const sides = [
    { value: 'either', label: 'Whoever goes to bed first' },
    { value: 'left', label: names.left },
    { value: 'right', label: names.right },
  ] as const
  return (
    <>
      <Card className="gap-2.5">
        <div className="flex items-center gap-2">
          <StatusDot tone={noise.playing ? 'ok' : noise.on ? 'warn' : 'muted'} />
          <span className="text-sm">{noiseLine(noise, pod.noiseVolume, at => formatClock(at, timeFormat))}</span>
          <Button className="ml-auto" variant={noise.on ? 'secondary' : 'primary'} disabled={set.isPending} onClick={() => set.mutate({ on: !noise.on })}>
            {noise.on ? 'Stop' : 'Play'}
          </Button>
        </div>
        <span className="text-[13px] text-fg-2">
          {`It stops once the bed has been empty ${pod.noiseEmptyMinutes} minutes, or after ${pod.noiseMaxHours} hours.`}
        </span>
        {noise.problem && <InlineError>{noise.problem}</InlineError>}
        <SettingRow label="Sound">
          <SelectValue label="Sound" value={pod.noiseColor} options={[...COLORS]} onChange={noiseColor => save.mutate({ patch: { noiseColor } })} />
        </SettingRow>
        <SettingRow label="Volume, 0 to 100">
          <NumberField label="Volume, 0 to 100" value={pod.noiseVolume} step={5} onSave={noiseVolume => save.mutate({ patch: { noiseVolume: Math.round(noiseVolume) } })} />
        </SettingRow>
        <SettingRow label="Fades in and out over, seconds" sub="Fades in when it starts by itself, and fades out whenever it stops. 0 means at once.">
          <NumberField label="Fades in and out over, seconds" value={pod.noiseFadeSeconds} step={5} onSave={noiseFadeSeconds => save.mutate({ patch: { noiseFadeSeconds: Math.round(noiseFadeSeconds) } })} />
        </SettingRow>
      </Card>

      <SectionLabel className="mt-1">White noise at bedtime</SectionLabel>
      <Card className="gap-2.5">
        <SettingRow
          divider={false}
          label="Start white noise"
          sub={`${startLine(pod.noiseStart, pod.detection)}${pod.noiseStart === 'off' ? '' : ' If the bed has been empty long enough to stop it, it starts again when a sleeper gets back into their side while their curve runs, unless someone stopped it by hand that night.'}`}
          className="flex-col items-stretch min-[600px]:flex-row min-[600px]:items-center"
        >
          <SelectValue label="Start white noise" value={pod.noiseStart} options={[...STARTS]} onChange={noiseStart => save.mutate({ patch: { noiseStart } })} />
        </SettingRow>
        {pod.noiseStart !== 'off' && (
          <SettingRow label="Whose curve" sub="Anyone away is left out.">
            <SelectValue label="Whose curve" value={pod.noiseSide} options={[...sides]} onChange={noiseSide => save.mutate({ patch: { noiseSide } })} />
          </SettingRow>
        )}
        <SettingRow label="Waits for someone to get in, minutes" sub="For noise that starts with nobody in bed, at the curve's start time or from Play or the middle button. After that, it stops once the bed has been empty for the time below.">
          <NumberField label="Waits for someone to get in, minutes" value={pod.noiseWaitMinutes} step={5} onSave={noiseWaitMinutes => save.mutate({ patch: { noiseWaitMinutes } })} />
        </SettingRow>
        <SettingRow label="Stops once everyone is out of bed for, minutes">
          <NumberField label="Stops once everyone is out of bed for, minutes" value={pod.noiseEmptyMinutes} onSave={noiseEmptyMinutes => save.mutate({ patch: { noiseEmptyMinutes } })} />
        </SettingRow>
        <SettingRow label="Longest, hours">
          <NumberField label="Longest, hours" value={pod.noiseMaxHours} step={0.5} onSave={noiseMaxHours => save.mutate({ patch: { noiseMaxHours } })} />
        </SettingRow>
      </Card>

      <SectionLabel className="mt-1">Middle button</SectionLabel>
      <Card className="gap-2.5">
        <span className="text-[13px] text-fg-2">What the middle button on either side of the cover does.</span>
        {GESTURES.map(g => (
          <SettingRow key={g.key} label={g.label}>
            <SelectValue label={g.label} value={pod[g.key]} options={[...ACTIONS]} onChange={value => save.mutate({ patch: { [g.key]: value } })} />
          </SettingRow>
        ))}
      </Card>
      {(save.error ?? set.error) && <InlineError>{(save.error ?? set.error)?.message}</InlineError>}
    </>
  )
}

/** All the white noise controls, for the bottom of the Temp screen. */
export function NoiseSection() {
  const { data } = useForkOverview()
  const { leftName, rightName } = useSideNames()
  if (!data) return null
  return (
    <section className="mt-4 flex flex-col gap-2.5" aria-label="White noise">
      <SectionLabel>White noise</SectionLabel>
      <NoiseCard pod={data.pod} noise={data.noise} names={{ left: leftName, right: rightName }} />
    </section>
  )
}
