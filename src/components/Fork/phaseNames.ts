import { AlarmClock, BedDouble, Moon, MoonStar, Sunrise, type LucideIcon } from 'lucide-react'

export interface PhaseName {
  name: string
  icon: LucideIcon
}

/**
 * A name and icon for each of a curve's set points, in time order, as the
 * iPhone app's old schedule screen named them: the first is bedtime, the last
 * is wake, the one before wake is pre-wake, and those between are the night.
 */
export function phaseName(index: number, count: number): PhaseName {
  if (index === 0) return { name: 'Bedtime', icon: BedDouble }
  if (index === count - 1) return { name: 'Wake', icon: AlarmClock }
  if (index === count - 2 && count >= 4) return { name: 'Pre-wake', icon: Sunrise }
  if (index === 1) return { name: 'Deep', icon: Moon }
  if (index === 2) return { name: 'Late night', icon: MoonStar }
  return { name: `Phase ${index + 1}`, icon: MoonStar }
}
