'use client'

import { TONE_VAR, tempTone } from '@/src/components/Schedule/scheduleFormat'
import type { PhaseName } from './phaseNames'

/**
 * The left half of a curve editor row: the point's icon in its temperature's
 * colour (grey where the side turns off), its name, and below them its time
 * (tap to edit) and whether it powers the side on or off.
 */
export function PhaseLabel({ phase, time, autoLabel, temperature, disabled, onTap }: {
  phase: PhaseName
  time: string
  autoLabel: 'on' | 'off' | null
  temperature: number
  disabled: boolean
  onTap: () => void
}) {
  const Icon = phase.icon
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Icon size={18} className="shrink-0" style={{ color: autoLabel === 'off' ? 'var(--text-3)' : TONE_VAR[tempTone(temperature)] }} aria-hidden />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-fg">{phase.name}</span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-fg-2">
          <button
            type="button"
            onClick={onTap}
            disabled={disabled}
            aria-label={`Edit set point ${time}`}
            className="cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-left font-mono text-fg-2 hover:text-fg disabled:cursor-default"
          >
            {time}
          </button>
          {autoLabel && <span className="truncate">{autoLabel === 'on' ? 'Power on' : 'Power off'}</span>}
        </span>
      </div>
    </div>
  )
}
