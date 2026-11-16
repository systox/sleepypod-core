import { AlarmClock, BedDouble, Moon, MoonStar, Sunrise, type LucideIcon } from 'lucide-react'

export interface PhaseName {
  name: string
  icon: LucideIcon
}

const MINUTE_OF_DAY = (time: string) => {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/** Deep sleep comes mostly in the first hours of any sleep, night or day. */
const DEEP_MINUTES = 4 * 60
const PRE_WAKE_MINUTES = 2 * 60

/**
 * A name and icon for each of a curve's set points, given their "HH:MM" times
 * in curve order: the first is bedtime and the last is wake; between them a
 * point is named by how far it sits into the sleep, so the names fit a
 * daytime sleep too and adding a point leaves the others' names alone.
 */
export function phaseNames(times: string[]): PhaseName[] {
  // Minutes since the first point, counting on past midnight.
  const offsets: number[] = []
  for (const time of times) {
    const minute = MINUTE_OF_DAY(time)
    const previous = offsets.length ? offsets[offsets.length - 1] : null
    if (previous === null) offsets.push(0)
    else {
      const start = MINUTE_OF_DAY(times[0])
      let offset = (minute - start + 1440) % 1440
      while (offset < previous) offset += 1440
      offsets.push(offset)
    }
  }
  const wake = offsets[offsets.length - 1]
  return offsets.map((offset, i): PhaseName => {
    if (i === 0) return { name: 'Bedtime', icon: BedDouble }
    if (i === offsets.length - 1) return { name: 'Wake', icon: AlarmClock }
    if (wake - offset <= PRE_WAKE_MINUTES) return { name: 'Pre-wake', icon: Sunrise }
    if (offset < DEEP_MINUTES) return { name: 'Deep', icon: Moon }
    return { name: 'Light', icon: MoonStar }
  })
}
