'use client'

import { Card, InlineError, SettingRow, SelectValue, StatusDot } from '@/src/components/ds'
import type { ForkPodSettings } from '@/src/fork/settings'
import type { Side } from '@/src/hardware/types'
import { trpc } from '@/src/utils/trpc'
import { NumberField } from './ForkSettings'
import { useForkRefresh } from './useFork'

const MODES = [
  { value: 'off', label: 'Off' },
  { value: 'in-bed', label: 'While in bed' },
  { value: 'on', label: 'On' },
] as const
const COLORS = [
  { value: 'pink', label: 'Pink' },
  { value: 'brown', label: 'Brown' },
  { value: 'white', label: 'White' },
] as const

/** White noise from the base's speaker. One speaker, so one setting for the bed. */
export function NoiseCard({ pod, noise, names }: {
  pod: ForkPodSettings
  noise: { playing: boolean, problem: string | null }
  names: Record<Side, string>
}) {
  const refresh = useForkRefresh()
  const save = trpc.fork.setPodSettings.useMutation({ onSuccess: refresh })
  const sides = [
    { value: 'either', label: 'Either side' },
    { value: 'left', label: names.left },
    { value: 'right', label: names.right },
  ] as const
  return (
    <Card className="gap-2.5">
      <div className="flex items-center gap-2 font-mono text-xs text-fg-2">
        <StatusDot tone={noise.playing ? 'ok' : 'warn'} />
        {noise.playing ? 'Playing' : 'Not playing'}
      </div>
      <SettingRow divider={false} label="White noise">
        <SelectValue label="White noise" value={pod.noiseMode} options={[...MODES]} onChange={noiseMode => save.mutate({ patch: { noiseMode } })} />
      </SettingRow>
      {pod.noiseMode === 'in-bed' && (
        <SettingRow label="Whose bed starts it">
          <SelectValue label="Whose bed starts it" value={pod.noiseSide} options={[...sides]} onChange={noiseSide => save.mutate({ patch: { noiseSide } })} />
        </SettingRow>
      )}
      <SettingRow label="Sound">
        <SelectValue label="Sound" value={pod.noiseColor} options={[...COLORS]} onChange={noiseColor => save.mutate({ patch: { noiseColor } })} />
      </SettingRow>
      <SettingRow label="Volume, 0 to 100">
        <NumberField label="Volume, 0 to 100" value={pod.noiseVolume} step={5} onSave={noiseVolume => save.mutate({ patch: { noiseVolume: Math.round(noiseVolume) } })} />
      </SettingRow>
      {noise.problem && <InlineError>{noise.problem}</InlineError>}
      {save.error && <InlineError>{save.error.message}</InlineError>}
    </Card>
  )
}
