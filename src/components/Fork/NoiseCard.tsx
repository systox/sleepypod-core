'use client'

import { useState } from 'react'
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
  'bedtime': 'for bed hours',
  'smart-start': 'as someone got into bed',
}
const TRIGGERS = [
  { value: 'off', label: 'Manual' },
  { value: 'clock', label: 'Scheduled' },
  { value: 'smart', label: 'Smart' },
] as const

/** What the trigger does. Manual needs no words. */
export function triggerLine(pod: Pick<ForkPodSettings, 'noiseStart' | 'detection' | 'noiseMaxHours'>, minutes: string): string {
  if (pod.noiseStart === 'off') return ''
  if (pod.noiseStart === 'clock') return 'Runs during bed hours.'
  const live = pod.detection === 'live' ? '' : ' Needs Detection set to Live in Tonight settings.'
  return `Starts ${minutes} minutes after you get into bed. Pauses and resumes with presence detection. Maximum ${pod.noiseMaxHours} hours.${live}`
}

/** The Smart start minutes of the sleepers whose bedtimes count, as one number or a range. */
export function minutesToStart(values: number[]): string {
  const low = Math.min(...values)
  const high = Math.max(...values)
  return low === high ? `${low}` : `${low} to ${high}`
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

/**
 * The white noise volume as a slider. It saves once the slider is let go, and
 * a playing session changes volume within a few seconds without a break.
 */
function NoiseVolume({ volume }: { volume: number }) {
  const refresh = useForkRefresh()
  const save = trpc.fork.setPodSettings.useMutation({ onSuccess: refresh })
  const [draft, setDraft] = useState<number | null>(null)
  const commit = (value: number) => {
    if (value === volume) setDraft(null)
    else save.mutate({ patch: { noiseVolume: value } }, { onSettled: () => setDraft(null) })
  }
  const shown = draft ?? volume
  return (
    <span className="flex items-center gap-3">
      <Slider className="w-36 flex-none" label="White noise volume" value={shown} step={1} onChange={setDraft} onCommit={commit} />
      <span className="w-7 text-right font-mono text-xs tabular-nums">{shown}</span>
      {save.error && <span role="alert" className="text-xs text-danger" title={save.error.message}>Not saved</span>}
    </span>
  )
}

/** White noise from the base's speaker. One speaker, so one setting for the bed. */
export function NoiseCard({ pod, noise, names, minutes }: { pod: ForkPodSettings, noise: NoiseView, names: Record<Side, string>, minutes: string }) {
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
          {noise.reason === 'bedtime' ? 'It stops when bed hours end.' : `It stops once the bed has been empty ${pod.noiseEmptyMinutes} minutes, or after ${pod.noiseMaxHours} hours.`}
        </span>
        {noise.problem && <InlineError>{noise.problem}</InlineError>}
        <SettingRow label="Sound">
          <SelectValue label="Sound" value={pod.noiseColor} options={[...COLORS]} onChange={noiseColor => save.mutate({ patch: { noiseColor } })} />
        </SettingRow>
        <SettingRow label="Volume">
          <NoiseVolume volume={pod.noiseVolume} />
        </SettingRow>
        <SettingRow label="Fades in and out over, seconds" sub="Fades in when it starts by itself, and fades out whenever it stops. 0 means at once.">
          <NumberField label="Fades in and out over, seconds" value={pod.noiseFadeSeconds} step={5} onSave={noiseFadeSeconds => save.mutate({ patch: { noiseFadeSeconds: Math.round(noiseFadeSeconds) } })} />
        </SettingRow>
      </Card>

      <SectionLabel className="mt-1">White noise at bedtime</SectionLabel>
      <Card className="gap-2.5">
        <SettingRow
          divider={false}
          label="Trigger"
          sub={triggerLine(pod, minutes) || undefined}
        >
          <SelectValue label="Trigger" value={pod.noiseStart} options={[...TRIGGERS]} onChange={noiseStart => save.mutate({ patch: { noiseStart } })} />
        </SettingRow>
        {pod.noiseStart !== 'off' && (
          <SettingRow label="Whose curve" sub="Anyone away is left out.">
            <SelectValue label="Whose curve" value={pod.noiseSide} options={[...sides]} onChange={noiseSide => save.mutate({ patch: { noiseSide } })} />
          </SettingRow>
        )}
        <SettingRow label="Waits for someone to get in, minutes" sub="When started by hand with nobody in bed.">
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

/** All the white noise controls, for the Base page: the speaker is the base's. */
export function NoiseSection() {
  const { data } = useForkOverview()
  const { leftName, rightName } = useSideNames()
  if (!data) return null
  return (
    <section className="mt-4 flex flex-col gap-2.5" aria-label="White noise">
      <SectionLabel>White noise</SectionLabel>
      <NoiseCard
        pod={data.pod}
        noise={data.noise}
        names={{ left: leftName, right: rightName }}
        minutes={minutesToStart((data.pod.noiseSide === 'either' ? ['left', 'right'] as const : [data.pod.noiseSide]).map(side => data[side].settings.minutesToCall))}
      />
    </section>
  )
}
