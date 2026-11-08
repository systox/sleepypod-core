'use client'

import { Pencil, Plus, RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, InlineError, SelectValue, Toggle } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import type { Side } from '@/src/hardware/types'
import { useCurveTemplates, type SavedCurve } from '@/src/hooks/useCurveTemplates'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import { trpc } from '@/src/utils/trpc'
import { useForkOverview, useForkRefresh } from './useFork'
import { WeekBars } from './WeekBars'
import { anchorAfter, dayDate, makeThisWeek, mondayOf, moveSpot, repeatText, stepOf, stepsFrom, weekDates, weekSummary, type Spot, type WeekDays, type WeekLists } from './weekLogic'
import { useHoldDrag, useSlide, type Landing } from './weekMotion'

const CHANGE_TIMES = ['12:00', '14:00', '16:00', '18:00']

interface Preset { id: string, name: string, days: WeekDays }

/**
 * For the Schedule page's curve list: whether tonight's curve shows its chart
 * in its own place in the list instead of in a card above it, which weeks of
 * the side's rotation run each curve, and whether that rotation is running.
 */
export function useCurveWeeks(side: Side): { mergeTonight: boolean, rotationRuns: boolean, weeksOf: (curveId: number) => string[] } {
  const overview = useForkOverview()
  const weeks = trpc.fork.listWeeks.useQuery()
  const rotation = overview.data?.[side].rotation?.rotation ?? null
  const presets = weeks.data ?? []
  return {
    mergeTonight: true,
    rotationRuns: rotation !== null && !rotation.paused,
    weeksOf: curveId => [...new Set(rotation?.steps ?? [])]
      .map(id => presets.find(p => p.id === id))
      .filter((p): p is Preset => p !== undefined && Object.values(p.days).includes(curveId))
      .map(p => p.name),
  }
}

function WeekTile({ preset, curves, current, slide, href, onPointerDown, onClick }: {
  preset: Preset
  curves: ReadonlyMap<number, SavedCurve>
  current: boolean
  slide: string
  href: string
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
  onClick: () => void
}) {
  return (
    <div
      data-slide={slide}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('a')) onClick()
      }}
      onContextMenu={e => e.preventDefault()}
      className={cn('flex cursor-grab select-none flex-col gap-2 rounded-seg border bg-app px-3 py-2.5', current ? 'border-ok-line' : 'border-line')}
      style={{ touchAction: 'pan-y', WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
    >
      <span className="flex items-center gap-2">
        <span className="text-[15px] font-medium">{preset.name}</span>
        <Link href={href} aria-label={`Edit ${preset.name}`} className="ml-auto flex text-icon">
          <Pencil size={15} aria-hidden />
        </Link>
      </span>
      <WeekBars days={preset.days} curves={curves} todayIndex={current ? (new Date().getDay() + 6) % 7 : -1} />
      <span className="font-mono text-xs leading-[1.4] text-fg-2">{weekSummary(preset.days, curves)}</span>
    </div>
  )
}

/**
 * A side's weeks in one card: the rotation from this week on, each in a slot
 * that keeps its dates, then the weeks out of the rotation. Hold a week and
 * drag it to reorder for good; the slot marked current is this week.
 */
export function WeeksCard({ side }: { side: Side }) {
  const lang = langFromPath(usePathname())
  const router = useRouter()
  const overview = useForkOverview()
  const refresh = useForkRefresh()
  const { formatTime } = useTimeFormatter()
  const weeks = trpc.fork.listWeeks.useQuery()
  const { templates } = useCurveTemplates()
  const curves = useMemo(() => new Map((templates ?? []).map(t => [t.id, t])), [templates])
  // The order shown while a drop saves, so the weeks don't jump back and forth.
  // Cleared after every save, once the Pod's order has been read back.
  const [pending, setPending] = useState<WeekLists | null>(null)
  const save = trpc.fork.saveRotation.useMutation({ onSuccess: refresh, onSettled: () => setPending(null) })
  const [, redraw] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const landing = useRef<Landing | null>(null)

  const view = overview.data?.[side].rotation ?? null
  const rotation = view?.rotation ?? null
  const week = view?.week ?? 0
  const presets: Preset[] = weeks.data ?? []
  const shown = rotation ? makeThisWeek(rotation.steps, stepOf(week, rotation.steps.length)) : []
  const lists: WeekLists = pending ?? { active: shown, inactive: presets.filter(p => !shown.includes(p.id)).map(p => p.id) }
  const anchor = rotation ? anchorAfter(rotation.anchorDate, week) : mondayOf(new Date())
  const presetOf = (id: string) => presets.find(p => p.id === id)
  const nameOf = (id: string) => presetOf(id)?.name ?? 'Missing'
  const base = `/${lang}/schedule/weeks`

  const drop = (from: Spot, to: Spot | null, at: Landing) => {
    landing.current = at
    // The weeks may have changed under the drag (the week turned over, or a save failed): then nothing moves.
    const id = at.key.split(':')[1]
    const next = to && lists[from.list][from.index] === id ? moveSpot(lists, from, to) : null
    if (!next || !to) {
      // Back where it came from: a render, so it slides there from the release point.
      redraw(n => n + 1)
      return
    }
    // The dropped copy's key in the new order, so a week used twice lands as the copy that moved.
    const place = to.list === 'active' ? Math.min(to.index, next.active.length - 1) : next.active.length
    landing.current = { ...at, key: `w:${id}:${next.active.slice(0, place).filter(other => other === id).length}` }
    setPending(next)
    save.mutate({
      side,
      rotation: rotation
        ? { ...rotation, steps: stepsFrom(next.active, week) }
        : { steps: next.active, anchorDate: mondayOf(new Date()), changeTime: '16:00', paused: true },
    })
  }
  const { start, dragging, target, justDragged } = useHoldDrag({ box, onDrop: drop })
  const open = (id: string) => {
    if (!justDragged()) router.push(`${base}/${id}`)
  }
  useSlide(box, inner, landing)

  // Each copy of a week keeps its own key, so a week in two slots slides as two.
  const seen = new Map<string, number>()
  const keyOf = (id: string) => {
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    return `w:${id}:${n}`
  }
  const isTarget = (spot: Spot) => dragging !== null && target?.list === spot.list && target.index === spot.index
  const well = (spot: Spot, filled: boolean) => cn(
    'rounded-seg',
    !filled && 'min-h-[72px] border border-dashed border-line-2',
    isTarget(spot) && 'bg-ok/10 outline outline-1 outline-dashed outline-ok',
  )
  const tile = (id: string, spot: Spot, current: boolean) => {
    const preset = presetOf(id)
    const key = keyOf(id)
    return preset && (
      <WeekTile
        preset={preset}
        curves={curves}
        current={current}
        slide={key}
        href={`${base}/${id}`}
        // One save at a time: each is built from the order the Pod last gave back.
        onPointerDown={(e) => {
          if (!save.isPending) start(e, spot, key)
        }}
        onClick={() => open(id)}
      />
    )
  }
  const slot = (i: number, content: ReactNode) => (
    <div key={`slot-${i}`} className="flex flex-col gap-1.5">
      <span data-slide={`d:${i}`} className="flex items-center gap-2 pl-0.5 font-mono text-xs text-fg-2">
        {weekDates(anchor, i)}
        {i === 0 && (
          <span className="flex items-center gap-1.5 text-ok">
            <span className="size-1.5 rounded-full bg-ok" aria-hidden />
            current
          </span>
        )}
      </span>
      {content}
    </div>
  )

  const running = rotation !== null && !rotation.paused
  const n = lists.active.length
  // A week from Inactive can also go after the last one.
  const endSlot = dragging?.list === 'inactive' && n > 0

  return (
    <div ref={box} className="relative">
      <div ref={inner}>
        <Card className="gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] font-medium">Weeks</span>
            {rotation && (
              <span className="ml-auto flex">
                <Toggle
                  size="md"
                  on={!rotation.paused}
                  disabled={save.isPending}
                  label="Run this rotation"
                  onChange={on => save.mutate({ side, rotation: { ...rotation, paused: !on } })}
                />
              </span>
            )}
          </div>
          {presets.length > 0
            ? <span className="-mt-1 text-[13px] text-fg-2">Tap and hold then drag to reorder.</span>
            : <span className="-mt-1 text-[13px] text-fg-2">Create a week to start a rotation.</span>}

          <div className={cn('flex flex-col gap-2.5', rotation?.paused && 'opacity-50')}>
            {lists.active.map((id, i) => slot(i, (
              <div data-well={`active:${i}`} className={well({ list: 'active', index: i }, true)}>
                {tile(id, { list: 'active', index: i }, i === 0)}
              </div>
            )))}
            {n === 0 && presets.length > 0 && slot(0, <div data-well="active:0" data-slide="first" className={well({ list: 'active', index: 0 }, false)} />)}
            {endSlot && slot(n, <div data-well={`active:${n}`} className={well({ list: 'active', index: n }, false)} />)}
          </div>

          {presets.length > 0 && (
            <>
              <span data-slide="inactive" className="flex items-center gap-2.5 font-mono text-[11px] tracking-[0.08em] text-fg-2 uppercase after:h-px after:flex-1 after:bg-line">
                Inactive
              </span>
              <div className="flex flex-col gap-2.5">
                {lists.inactive.map((id, i) => (
                  <div key={id} data-well={`inactive:${i}`} className={well({ list: 'inactive', index: i }, true)}>
                    {tile(id, { list: 'inactive', index: i }, false)}
                  </div>
                ))}
                <div data-well={`inactive:${lists.inactive.length}`} data-slide="empty" className={well({ list: 'inactive', index: lists.inactive.length }, false)} />
              </div>
            </>
          )}

          {n > 0 && (
            <div data-slide="foot" className="flex flex-col gap-2 border-t border-line pt-3 font-mono text-xs text-fg-2">
              <span className="flex items-center gap-2">
                <RotateCcw size={12} aria-hidden />
                {rotation?.paused
                  ? `Paused: ${nameOf(lists.active[0])} stays on`
                  : `${repeatText(n)} · ${nameOf(lists.active[0])} again ${dayDate(anchor, n)}`}
              </span>
              {rotation && (
                <span className="flex flex-wrap items-center gap-2">
                  Changes Mondays at
                  <SelectValue
                    label="Change time"
                    value={rotation.changeTime}
                    options={CHANGE_TIMES.map(value => ({ value, label: formatTime(value) }))}
                    disabled={save.isPending}
                    onChange={changeTime => save.mutate({ side, rotation: { ...rotation, changeTime } })}
                  />
                </span>
              )}
              {running && <span className="font-sans">Moving a curve&apos;s days by hand lasts until the next change.</span>}
            </div>
          )}

          <Link href={`${base}/new`} data-slide="create" className="text-fg no-underline hover:no-underline">
            <Button variant="dashed" icon={Plus} full tabIndex={-1}>Create week</Button>
          </Link>

          {save.error && <InlineError>{save.error.message}</InlineError>}
        </Card>
      </div>
    </div>
  )
}
