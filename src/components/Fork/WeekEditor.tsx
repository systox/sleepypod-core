'use client'

import { Check } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { useMemo, useState, type DragEvent } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, InlineError, PageHeader, Pill, SectionLabel, Skeleton, TextField } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { templateSetPoints } from '@/src/components/Schedule/SavedCurveCard'
import { useCurveTemplates, type SavedCurve } from '@/src/hooks/useCurveTemplates'
import type { DayOfWeek } from '@/src/lib/scheduleTime'
import { useSide } from '@/src/providers/SideProvider'
import { formatClock } from '@/src/lib/timeFormat'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import { trpc } from '@/src/utils/trpc'
import { useForkOverview, useForkRefresh } from './useFork'
import { barFor, DAY_SHORT, dayRange, EMPTY_WEEK, sparkline, WEEK_DAYS, type WeekDays } from './weekLogic'

const SELECTIONS: Array<{ label: string, days: DayOfWeek[] }> = [
  { label: 'Every day', days: WEEK_DAYS },
  { label: 'Mon–Fri', days: WEEK_DAYS.slice(0, 5) },
  { label: 'Sat–Sun', days: WEEK_DAYS.slice(5) },
]
const NO_CURVE = 'none'
const sameDays = (a: DayOfWeek[], b: DayOfWeek[]) => a.length === b.length && a.every(d => b.includes(d))

function useClockTime() {
  const timeFormat = useTimeFormat()
  return (time: string) => {
    const [hour, minute] = time.split(':').map(Number)
    return formatClock(new Date(2026, 0, 1, hour, minute), timeFormat)
  }
}

function CurveTile({ curve, selected, disabled, span, onPick, onDragStart }: {
  curve: SavedCurve | null
  selected: boolean
  disabled: boolean
  span: string
  onPick: () => void
  onDragStart: (e: DragEvent) => void
}) {
  return (
    <button
      type="button"
      draggable
      disabled={disabled}
      onClick={onPick}
      onDragStart={onDragStart}
      className={cn(
        'flex min-h-[92px] min-w-0 cursor-pointer flex-col gap-1.5 rounded-card border bg-surface px-3 py-2.5 text-left text-fg disabled:cursor-default disabled:opacity-55 min-[900px]:cursor-grab min-[900px]:disabled:cursor-grab min-[900px]:disabled:opacity-100',
        selected ? 'border-cool' : 'border-line',
      )}
    >
      <span className="text-sm font-medium">{curve?.name ?? 'No curve'}</span>
      <svg viewBox="0 0 150 26" width="100%" height={24} preserveAspectRatio="none" aria-hidden>
        {curve && <polyline points={sparkline(templateSetPoints(curve), 150, 26)} fill="none" stroke="var(--accent-cool)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className="whitespace-nowrap font-mono text-[11px] text-fg-2">{span}</span>
    </button>
  )
}

/** Tap days, then a curve. On a desktop a curve can also be dragged onto a day. */
export function WeekEditor({ id }: { id: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const lang = langFromPath(pathname)
  const { primarySide } = useSide()
  const refresh = useForkRefresh()
  const weeks = trpc.fork.listWeeks.useQuery()
  const overview = useForkOverview(false)
  const { templates } = useCurveTemplates()
  const curves = useMemo(() => new Map((templates ?? []).map(t => [t.id, t])), [templates])
  const clockTime = useClockTime()
  const isNew = id === 'new'
  const week = weeks.data?.find(w => w.id === id)
  const [edits, setEdits] = useState<{ name?: string, days?: WeekDays }>({})
  const name = edits.name ?? week?.name ?? 'New week'
  const days = edits.days ?? week?.days ?? EMPTY_WEEK
  const setDays = (next: WeekDays) => setEdits(current => ({ ...current, days: next }))
  const [selected, setSelected] = useState<DayOfWeek[]>(['monday'])
  const [hover, setHover] = useState<DayOfWeek | null>(null)
  const back = () => router.push(`/${lang}/schedule`)
  const finish = async () => {
    await refresh()
    back()
  }
  const save = trpc.fork.saveWeek.useMutation({ onSuccess: finish })
  const remove = trpc.fork.deleteWeek.useMutation({ onSuccess: finish })

  if (!isNew && !week) {
    if (weeks.isLoading) return <Skeleton className="h-[400px]" />
    return (
      <>
        <PageHeader back="Schedule" onBack={back} title="Week not found" />
        <Card><InlineError>That week is no longer saved. It may have been deleted.</InlineError></Card>
      </>
    )
  }

  const sides = overview.data ? [overview.data.left, overview.data.right] : []
  const onNow = sides.some(s => s.rotation?.thisPresetId === id)
  const inRotation = sides.some(s => s.rotation?.rotation.steps.includes(id))
  const showEarly = WEEK_DAYS.some((day) => {
    const curve = days[day] === null ? undefined : curves.get(days[day] as number)
    return curve !== undefined && Number(curve.bedtime.slice(0, 2)) < 12
  })

  const assign = (id: number | null) => {
    if (selected.length === 0) return
    const next = { ...days }
    for (const day of selected) next[day] = id
    setDays(next)
    const last = Math.max(...selected.map(d => WEEK_DAYS.indexOf(d)))
    setSelected(last < 6 ? [WEEK_DAYS[last + 1]] : [])
  }

  const dragStart = (value: string) => (e: DragEvent) => {
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', value)
  }
  const dropOn = (day: DayOfWeek) => (e: DragEvent) => {
    e.preventDefault()
    setHover(null)
    const value = e.dataTransfer.getData('text/plain')
    if (value) setDays({ ...days, [day]: value === NO_CURVE ? null : Number(value) })
  }

  const spanOf = (curve: SavedCurve | undefined) => (curve ? `${clockTime(curve.bedtime)} → ${clockTime(curve.wake)}` : 'Side stays off')

  return (
    <>
      <PageHeader
        back="Schedule"
        onBack={back}
        title={isNew ? 'Create week' : 'Edit week'}
        right={<Button variant="primary" disabled={save.isPending || name.trim() === ''} onClick={() => save.mutate({ id: isNew ? undefined : id, name, days })}>Save week</Button>}
      />

      <div className="max-w-[320px]">
        <TextField label="Name" mono={false} value={name} onChange={value => setEdits(current => ({ ...current, name: value }))} />
      </div>

      <SectionLabel>Days · Bedtime → wake-up</SectionLabel>
      <div role="group" aria-label="Choose several days" className="grid grid-cols-3 gap-1.5 min-[900px]:flex">
        {SELECTIONS.map(s => (
          <Pill key={s.label} selected={sameDays(selected, s.days)} onClick={() => setSelected(s.days)}>{s.label}</Pill>
        ))}
      </div>

      <div className="grid gap-1.5 min-[900px]:grid-cols-7 min-[900px]:gap-2">
        {WEEK_DAYS.map((day) => {
          const value = days[day]
          const curve = value === null ? undefined : curves.get(value)
          const on = selected.includes(day)
          const bar = barFor(curve)
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              draggable={value !== null}
              onClick={() => setSelected(on ? selected.filter(d => d !== day) : [...selected, day])}
              onDragStart={dragStart(String(value))}
              onDragOver={(e) => {
                e.preventDefault()
                setHover(day)
              }}
              onDragLeave={() => setHover(null)}
              onDrop={dropOn(day)}
              className={cn(
                'flex min-h-[60px] min-w-0 cursor-pointer items-center gap-3 rounded-seg border p-2 text-left text-fg min-[900px]:flex-col min-[900px]:items-stretch min-[900px]:gap-2',
                on || hover === day ? 'border-cool bg-active' : 'border-line bg-transparent',
              )}
            >
              <span className="relative block h-[42px] w-3.5 shrink-0 overflow-hidden rounded-[3px] bg-line-2 min-[900px]:order-1 min-[900px]:h-[170px] min-[900px]:w-full" aria-hidden>
                <span className="absolute inset-x-0 rounded-[3px] bg-cool" style={{ top: `${bar.top}%`, height: `${bar.height}%` }} />
              </span>
              <span className="w-[34px] shrink-0 text-sm font-medium">{DAY_SHORT[day]}</span>
              <span className="flex min-w-0 flex-col gap-0.5 min-[900px]:order-2">
                <span className="truncate text-sm">{value === null ? 'No curve' : curve?.name ?? 'Missing'}</span>
                <span className="font-mono text-xs text-fg-2 min-[900px]:text-[11px]">{value === null || curve ? spanOf(curve) : 'Runs nothing'}</span>
              </span>
              {on && <Check size={16} className="ml-auto shrink-0 text-cool min-[900px]:hidden" aria-hidden />}
            </button>
          )
        })}
      </div>

      {showEarly && <span className="text-xs text-fg-2">Each day means that day&apos;s night, so Mon at 4:00 AM is early Tuesday morning.</span>}

      <SectionLabel className="mt-1">Curves</SectionLabel>
      <span className="text-[13px] text-fg-2">
        {selected.length > 0
          ? `Tap a curve to put it on ${dayRange(selected)}. Tap more days to fill several at once.`
          : 'Tap a day above, then a curve.'}
        <span className="hidden min-[900px]:inline"> You can also drag a curve onto a day.</span>
      </span>
      <div className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-5 min-[900px]:gap-3">
        {[...curves.values()].map(curve => (
          <CurveTile
            key={curve.id}
            curve={curve}
            selected={selected.length > 0 && selected.every(d => days[d] === curve.id)}
            disabled={selected.length === 0}
            span={spanOf(curve)}
            onPick={() => assign(curve.id)}
            onDragStart={dragStart(String(curve.id))}
          />
        ))}
        <CurveTile
          curve={null}
          selected={selected.length > 0 && selected.every(d => days[d] === null)}
          disabled={selected.length === 0}
          span="Side stays off"
          onPick={() => assign(null)}
          onDragStart={dragStart(NO_CURVE)}
        />
      </div>

      {overview.data && (
        <div className="min-[900px]:max-w-[320px]">
          <Button
            full
            onClick={() => {
              const preset = weeks.data?.find(w => w.id === overview.data?.[primarySide].rotation?.thisPresetId)
              if (preset) setDays(preset.days)
            }}
          >
            Copy from this week
          </Button>
        </div>
      )}
      {onNow && <span className="text-xs text-warm">This week is on now, so saving changes its curves right away.</span>}
      {save.error && <InlineError>{save.error.message}</InlineError>}
      {remove.error && <InlineError>{remove.error.message}</InlineError>}
      {!isNew && (inRotation
        ? <span className="text-xs text-fg-2">To delete this week, take it out of the rotation first.</span>
        : <Button variant="ghost" onClick={() => remove.mutate({ id })}>Delete week</Button>)}
    </>
  )
}
