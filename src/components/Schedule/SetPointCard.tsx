'use client'

import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'

import { Trash2 } from 'lucide-react'
import { GhostIcon, Stepper } from '@/src/components/ds'
import { PhaseLabel } from '@/src/components/Fork/PhaseLabel'
import type { PhaseName } from '@/src/components/Fork/phaseNames'

import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { displayToSetpointF, setpointFToDisplay } from '@/src/lib/tempUtils'

export interface EditorSetPoint {
  id: number
  time: string
  /** °F */
  temperature: number
}

const MIN_TEMP = 55
const MAX_TEMP = 110

interface SetPointCardProps {
  point: EditorSetPoint
  /** Receives the new temperature in °F. */
  onSetTemp: (id: number, temperatureF: number) => void
  onDelete: (id: number) => void
  /** Tapping the time opens the set-point editor. */
  onTapTime: (point: EditorSetPoint) => void
  disabled?: boolean
  /** Marks the point that drives the Pod's auto power-on / power-off. */
  autoLabel?: 'on' | 'off' | null
  /** Fork: the point's place in the night, shown as an icon and name above its time. */
  phase?: PhaseName
}

/**
 * Editor row: tone dot, time, power on/off label, temperature stepper
 * (in the user's unit, stored as °F) and delete.
 */
export function SetPointCard({
  point,
  onSetTemp,
  onDelete,
  onTapTime,
  disabled = false,
  autoLabel = null,
  phase,
}: SetPointCardProps) {
  const { formatTime } = useTimeFormatter()
  const { unit } = useTemperatureUnit()
  const display = Math.round(setpointFToDisplay(point.temperature, unit) ?? point.temperature)
  const time = formatTime(point.time)

  return (
    <div className="flex items-center gap-3 border-t border-line pt-3" data-testid="set-point-row">
      <PhaseLabel phase={phase} time={time} autoLabel={autoLabel} temperature={point.temperature} disabled={disabled} onTap={() => onTapTime(point)} />
      <div className="flex shrink-0 items-center gap-2.5">
        <Stepper
          value={display}
          min={Math.round(setpointFToDisplay(MIN_TEMP, unit) ?? MIN_TEMP)}
          max={Math.round(setpointFToDisplay(MAX_TEMP, unit) ?? MAX_TEMP)}
          disabled={disabled}
          label={`temperature at ${time}`}
          onChange={v => onSetTemp(point.id, Math.max(MIN_TEMP, Math.min(MAX_TEMP, Math.round(displayToSetpointF(v, unit) ?? point.temperature))))}
        />
        <GhostIcon
          icon={Trash2}
          size={15}
          label={`Delete set point ${time}`}
          className="-mr-2 text-fg-3 hover:text-danger"
          disabled={disabled}
          onClick={() => onDelete(point.id)}
        />
      </div>
    </div>
  )
}
