/**
 * A tripwire for upstream merges (docs/fork/one-big-side.md, section 3.4).
 *
 * While the bed is one side, every control on the empty half must reach the
 * home side. A new upstream path that writes a half's temperature or power
 * would act on the empty half alone, and nothing would conflict at the merge.
 * So this counts, per stock file, the calls that can write a half. A changed
 * count fails here: look at the new call, decide whether it needs the side
 * redirect (`controlSideOf`) or is right as it is (section 6 of the plan
 * says why each existing path is redirected or left alone), then update the
 * count. The counts carry no judgement; they only make a merge stop and look.
 * They count controller acquisitions, not each call made through a held
 * controller, so they catch a new path, not every new call on an old one.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const WRITE_CALLS = /getTemperatureController\(\)|\.setTemperature\(|\.setPower\(/g

function stockCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const name = relative('.', path).split(sep).join('/')
      if (entry.isDirectory()) {
        if (entry.name === 'tests' || entry.name === '__tests__' || name === 'src/fork') continue
        walk(path)
      }
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const found = readFileSync(path, 'utf8').match(WRITE_CALLS)?.length ?? 0
        if (found > 0) counts[name] = found
      }
    }
  }
  walk('src')
  return counts
}

/** Counted as merged into pod5 on 2026-11-05 (upstream/main 3e969a11). */
const EXPECTED: Record<string, number> = {
  'src/automation/instance.ts': 1,
  'src/hardware/client.ts': 6,
  'src/hardware/gestureActionHandler.ts': 4,
  'src/hardware/pumpStallGuard.ts': 7,
  'src/hardware/sharedClient.ts': 1,
  'src/homekit/accessories/sideController.ts': 3,
  'src/mcp/tools/control.ts': 2,
  'src/scheduler/jobManager.ts': 10,
  'src/server/routers/device.ts': 6,
  'src/server/routers/pumpAlerts.ts': 1,
  'src/server/routers/runOnce.ts': 2,
  'src/services/autoOffWatcher.ts': 1,
  'src/services/autoOnWatcher.ts': 1,
  'src/services/temperatureKeepalive.ts': 1,
  'src/streaming/mqttBridge.ts': 2,
  'src/temperature/instance.ts': 5,
}

describe('stock calls that can write a half', () => {
  it('are the ones section 6 of the one-big-side plan accounts for', () => {
    expect(stockCounts()).toEqual(EXPECTED)
  })
})
