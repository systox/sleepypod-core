'use client'

import { useState } from 'react'
import { Button, Card, InlineError, SectionLabel, SegmentedControl, SelectValue, SettingRow, Toggle } from '@/src/components/ds'
import type { ForkPodSettings, ForkSideSettings } from '@/src/fork/settings'
import type { Side } from '@/src/hardware/types'
import { trpc } from '@/src/utils/trpc'
import { useForkRefresh } from './useFork'

type SideNumber = {
  [K in keyof ForkSideSettings]: ForkSideSettings[K] extends number ? K : never
}[keyof ForkSideSettings]
type PodNumber = {
  [K in keyof ForkPodSettings]: ForkPodSettings[K] extends number ? K : never
}[keyof ForkPodSettings]

const SIDE_ROWS: Array<{ key: SideNumber, label: string, sub?: string, step?: number }> = [
  { key: 'hoursEarly', label: 'Hours early that count as tonight', step: 0.5 },
  { key: 'hoursLate', label: 'Hours late that count as tonight', step: 0.5 },
  { key: 'warmUpWaitHours', label: 'How long Warm up waits for someone', step: 0.5 },
  { key: 'minutesToCall', label: 'Minutes to call in or out' },
  { key: 'weightRise', label: 'Weight above empty that counts as a body' },
  { key: 'vibrationLimit', label: 'Vibration that counts as a body', step: 10_000 },
  { key: 'otherSideShare', label: 'Share of the other side\'s weight landing here', step: 0.05 },
  { key: 'warmestF', label: 'Warmest allowed, °F' },
  { key: 'endOutMinutes', label: 'Minutes out before the end of the night' },
  { key: 'earliestEndHours', label: 'Earliest end, hours of curve', sub: 'Not counting time out of bed', step: 0.5 },
  { key: 'backstopHours', label: 'Backstop, hours after the curve begins', sub: 'Restarts after over an hour out', step: 0.5 },
  { key: 'minimumGapHours', label: 'Minimum gap after a full run, hours', step: 0.5 },
  { key: 'falseStartWithinMinutes', label: 'False start: leaves within, minutes' },
  { key: 'falseStartOutMinutes', label: 'False start: stays out for, minutes' },
  { key: 'shortRunHours', label: 'Hours of curve before a run uses up the night', step: 0.5 },
  { key: 'moveAcrossMinutes', label: 'Moving-across window, minutes' },
]

const POD_ROWS: Array<{ key: PodNumber, label: string, step?: number }> = [
  { key: 'smoothRatePerHour', label: 'Smooth return speed, °F an hour', step: 0.1 },
  { key: 'smoothMaxHours', label: 'Longest fade, hours', step: 0.5 },
  { key: 'pressWaitSeconds', label: 'Wait after a press, seconds' },
  { key: 'ownershipStaleMinutes', label: 'Weekly takeover, minutes' },
  { key: 'timerRefreshHours', label: 'Timer refresh, hours', step: 0.5 },
  { key: 'maxFailedStartups', label: 'Failed startups before stopping' },
]

const DETECTION = [
  { value: 'off', label: 'Off' },
  { value: 'watch', label: 'Watch-only' },
  { value: 'live', label: 'Live' },
] as const

function NumberField({ value, step = 1, label, onSave }: { value: number, step?: number, label: string, onSave: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      aria-label={label}
      step={step}
      value={draft ?? value}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== '' && Number.isFinite(Number(draft))) onSave(Number(draft))
        setDraft(null)
      }}
      className="w-[96px] rounded-ctl border border-line-2 bg-transparent px-2 py-1 text-right font-mono text-[13px] text-fg outline-none"
    />
  )
}

/** Every number in the design, each with sleepypod's own controls. */
export function ForkSettings({ pod, left, right, names }: {
  pod: ForkPodSettings
  left: ForkSideSettings
  right: ForkSideSettings
  names: { left: string, right: string }
}) {
  const refresh = useForkRefresh()
  const [side, setSide] = useState<Side>('left')
  const saveSide = trpc.fork.setSideSettings.useMutation({ onSuccess: refresh })
  const savePod = trpc.fork.setPodSettings.useMutation({ onSuccess: refresh })
  const markEmpty = trpc.fork.markBedEmpty.useMutation({ onSuccess: refresh })
  const settings = side === 'left' ? left : right
  const steps = settings.tripStepMinutes
  const error = saveSide.error ?? savePod.error

  return (
    <>
      {error && <InlineError>{error.message}</InlineError>}
      <SectionLabel>Pod</SectionLabel>
      <Card className="gap-2.5">
        <SettingRow divider={false} label="Detection" sub="Set Live only after the 7 watch-only nights pass.">
          <SelectValue label="Detection" value={pod.detection} options={[...DETECTION]} onChange={detection => savePod.mutate({ patch: { detection } })} />
        </SettingRow>
        {POD_ROWS.map(row => (
          <SettingRow key={row.key} label={row.label}>
            <NumberField label={row.label} value={pod[row.key]} step={row.step} onSave={value => savePod.mutate({ patch: { [row.key]: value } })} />
          </SettingRow>
        ))}
        <SettingRow label="A press restarts a closed side" sub="Leave off until the bench test shows a press on an off side is seen.">
          <Toggle on={pod.pressStartsClosedSide} label="A press restarts a closed side" onChange={pressStartsClosedSide => savePod.mutate({ patch: { pressStartsClosedSide } })} />
        </SettingRow>
        <SettingRow label="Bed is empty now" sub="Use after changing bedding, with nobody on the bed.">
          <Button disabled={markEmpty.isPending} onClick={() => markEmpty.mutate()}>Mark empty</Button>
        </SettingRow>
      </Card>

      <SectionLabel className="mt-1">Each side</SectionLabel>
      <SegmentedControl
        ariaLabel="Side"
        options={[{ value: 'left', label: names.left }, { value: 'right', label: names.right }]}
        value={side}
        onChange={setSide}
      />
      <Card className="gap-2.5" key={side}>
        {SIDE_ROWS.map((row, i) => (
          <SettingRow key={row.key} divider={i > 0} label={row.label} sub={row.sub}>
            <NumberField label={row.label} value={settings[row.key]} step={row.step} onSave={value => saveSide.mutate({ side, patch: { [row.key]: value } })} />
          </SettingRow>
        ))}
        {(['Trip: nothing changes up to, minutes', 'Trip: pause up to, minutes', 'Trip: back within, minutes'] as const).map((label, i) => (
          <SettingRow key={label} label={label}>
            <NumberField
              label={label}
              value={steps[i]}
              onSave={(value) => {
                const next = [...steps] as [number, number, number]
                next[i] = value
                saveSide.mutate({ side, patch: { tripStepMinutes: next } })
              }}
            />
          </SettingRow>
        ))}
      </Card>
    </>
  )
}
