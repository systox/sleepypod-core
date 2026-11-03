import { db } from '@/src/db'
import { deviceSettings } from '@/src/db/schema'

export function deviceTimezone(): string {
  return db.select().from(deviceSettings).limit(1).all()[0]?.timezone || 'America/Los_Angeles'
}
