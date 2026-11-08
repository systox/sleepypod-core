'use client'

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Spot } from './weekLogic'

/** Where a dropped week was let go, on screen, so it can slide from there into place. */
export interface Landing { key: string, left: number, top: number }

const HOLD_MS = 380
const MOVE_PX = 8
const EDGE_PX = 70
const SLIDE: KeyframeAnimationOptions = { duration: 460, easing: 'cubic-bezier(.4, 0, .2, 1)' }
const LIFTED = 'scale(1.04) rotate(-1.2deg)'
const LIFT_SHADOW = '0 14px 30px rgba(0, 0, 0, .3), 0 3px 8px rgba(0, 0, 0, .2)'

const stillMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Parse a `data-well` value ("active:2") into a spot. */
function spotOf(el: HTMLElement): Spot {
  const [list, index] = (el.dataset.well ?? '').split(':')
  return { list: list === 'inactive' ? 'inactive' : 'active', index: Number(index) }
}

interface Press {
  tile: HTMLElement
  from: Spot
  key: string
  x: number
  y: number
  timer: ReturnType<typeof setTimeout>
  clone: HTMLElement | null
  dx: number
  dy: number
  lastY: number
  target: Spot | null
  scroll: number | null
}

/**
 * Hold a week, then drag it. Until the hold completes the page scrolls as
 * usual; after it, the week lifts and follows the finger, and the slot under
 * it is the target. A tap stays a click; `justDragged` tells the click that
 * follows a drop apart from one.
 */
export function useHoldDrag({ box, onDrop }: {
  box: RefObject<HTMLElement | null>
  onDrop: (from: Spot, to: Spot | null, landing: Landing) => void
}) {
  const [dragging, setDragging] = useState<Spot | null>(null)
  const [target, setTarget] = useState<Spot | null>(null)
  const press = useRef<Press | null>(null)
  const droppedAt = useRef(0)
  const handlers = useRef({ onDrop })
  useLayoutEffect(() => {
    handlers.current = { onDrop }
  })

  useEffect(() => {
    const aim = (p: Press) => {
      const wells = [...(box.current?.querySelectorAll<HTMLElement>('[data-well]') ?? [])]
      let best: HTMLElement | null = null
      let bestGap = Infinity
      for (const well of wells) {
        const r = well.getBoundingClientRect()
        const gap = Math.abs(p.lastY - (r.top + r.height / 2))
        if (gap < bestGap) {
          best = well
          bestGap = gap
        }
      }
      const next = best ? spotOf(best) : null
      if (next?.list !== p.target?.list || next?.index !== p.target?.index) {
        p.target = next
        setTarget(next)
      }
    }
    const scrollStep = () => {
      const p = press.current
      if (!p?.clone) return
      const speed = p.lastY < EDGE_PX ? -(EDGE_PX - p.lastY) / 4 : p.lastY > innerHeight - EDGE_PX ? (p.lastY - (innerHeight - EDGE_PX)) / 4 : 0
      if (!speed) {
        p.scroll = null
        return
      }
      scrollBy(0, speed)
      aim(p)
      p.scroll = requestAnimationFrame(scrollStep)
    }
    const finish = (dropped: boolean) => {
      const p = press.current
      press.current = null
      if (!p) return
      clearTimeout(p.timer)
      if (p.scroll !== null) cancelAnimationFrame(p.scroll)
      if (!p.clone) return
      droppedAt.current = Date.now()
      const r = p.clone.getBoundingClientRect()
      const landing = { key: p.key, left: Number.parseFloat(p.clone.style.left) || r.left, top: Number.parseFloat(p.clone.style.top) || r.top }
      p.clone.remove()
      p.tile.style.visibility = ''
      setDragging(null)
      setTarget(null)
      handlers.current.onDrop(p.from, dropped ? p.target : null, landing)
    }
    const move = (e: PointerEvent) => {
      const p = press.current
      if (!p) return
      if (!p.clone) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_PX) {
          clearTimeout(p.timer)
          press.current = null
        }
        return
      }
      p.clone.style.left = `${e.clientX - p.dx}px`
      p.clone.style.top = `${e.clientY - p.dy}px`
      p.lastY = e.clientY
      aim(p)
      if (p.scroll === null) p.scroll = requestAnimationFrame(scrollStep)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    // Once a week is lifted the finger drags it, not the page. Only touches
    // that start in the card are held back, so the rest of the page scrolls freely.
    const holdPage = (e: TouchEvent) => {
      if (press.current?.clone) e.preventDefault()
    }
    const area = box.current
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', cancel)
    area?.addEventListener('touchmove', holdPage, { passive: false })
    return () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', cancel)
      area?.removeEventListener('touchmove', holdPage)
      if (press.current) clearTimeout(press.current.timer)
      press.current?.clone?.remove()
      press.current = null
    }
  }, [box])

  const lift = () => {
    const p = press.current
    if (!p) return
    const r = p.tile.getBoundingClientRect()
    const clone = p.tile.cloneNode(true) as HTMLElement
    clone.removeAttribute('data-slide')
    Object.assign(clone.style, {
      position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, margin: '0', zIndex: '60',
      pointerEvents: 'none', boxShadow: LIFT_SHADOW, transform: stillMotion() ? '' : LIFTED, cursor: 'grabbing',
    })
    clone.classList.add('border-ok-line')
    document.body.appendChild(clone)
    if (!stillMotion()) {
      clone.animate([{ transform: 'none' }, { transform: 'scale(1.07) rotate(-1.6deg)', offset: 0.6 }, { transform: LIFTED }], { duration: 260, easing: 'cubic-bezier(.2, 1.4, .4, 1)' })
    }
    p.tile.style.visibility = 'hidden'
    p.clone = clone
    p.dx = p.x - r.left
    p.dy = p.y - r.top
    navigator.vibrate?.(10)
    setDragging(p.from)
    aim0(p)
  }
  const aim0 = (p: Press) => {
    p.target = p.from
    setTarget(p.from)
  }

  const start = (e: ReactPointerEvent<HTMLElement>, from: Spot, key: string) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || (e.target as HTMLElement).closest('a, button, select, input')) return
    if (press.current) return
    const tile = e.currentTarget
    press.current = {
      tile, from, key, x: e.clientX, y: e.clientY, clone: null, dx: 0, dy: 0, lastY: e.clientY, target: null, scroll: null,
      timer: setTimeout(lift, HOLD_MS),
    }
  }

  // The click a browser may send after a drop isn't a tap on the week.
  const justDragged = () => Date.now() - droppedAt.current < 400

  return { start, dragging, target, justDragged }
}

/** An element's place inside the box, without any transform it's sliding with. */
function placeIn(el: HTMLElement, box: HTMLElement): { x: number, y: number } {
  let x = 0
  let y = 0
  for (let at: Element | null = el; at && at !== box; at = (at as HTMLElement).offsetParent) {
    x += (at as HTMLElement).offsetLeft
    y += (at as HTMLElement).offsetTop
  }
  return { x, y }
}

/**
 * After every change, each `data-slide` element in the box slides from where it
 * was to where it now is, and the box's height eases to its new size, so the
 * page below moves gently instead of all at once. The box must be positioned.
 */
export function useSlide(boxRef: RefObject<HTMLElement | null>, innerRef: RefObject<HTMLElement | null>, landingRef: RefObject<Landing | null>) {
  const lastRef = useRef<{ height: number, places: Map<string, { x: number, y: number }> } | null>(null)
  useLayoutEffect(() => {
    const el = boxRef.current
    const content = innerRef.current
    if (!el || !content) return
    const nodes = [...el.querySelectorAll<HTMLElement>('[data-slide]')]
    const places = new Map(nodes.map(n => [n.dataset.slide as string, placeIn(n, el)]))
    const height = content.offsetHeight
    const before = lastRef.current
    lastRef.current = { height, places }
    const land = landingRef.current
    landingRef.current = null
    if (!before || stillMotion()) return
    if (Math.abs(before.height - height) >= 1) {
      // Growing, the new content would draw over what's below until the box catches up.
      if (height > before.height) el.style.overflow = 'clip'
      el.animate([{ height: `${before.height}px` }, { height: `${height}px` }], SLIDE).onfinish = () => {
        el.style.overflow = ''
      }
    }
    const origin = el.getBoundingClientRect()
    for (const node of nodes) {
      const key = node.dataset.slide as string
      const now = places.get(key) as { x: number, y: number }
      if (land?.key === key) {
        const dx = land.left - origin.left - now.x
        const dy = land.top - origin.top - now.y
        node.animate([{ transform: `translate(${dx}px, ${dy}px) ${LIFTED}` }, { transform: 'none' }], SLIDE)
        continue
      }
      const was = before.places.get(key)
      if (!was) {
        node.animate([{ opacity: 0 }, { opacity: 1 }], SLIDE)
        continue
      }
      const dx = was.x - now.x
      const dy = was.y - now.y
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
        node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], SLIDE)
      }
    }
  })
}
