import React, { useEffect, useMemo, useRef } from "react"

import { cn } from "@/lib/utils"

interface FlickeringGridProps extends React.HTMLAttributes<HTMLDivElement> {
  squareSize?: number
  gridGap?: number
  flickerChance?: number
  color?: string
  width?: number
  height?: number
  className?: string
  maxOpacity?: number
}

/**
 * One field of squares per cell size, for the life of the page, laid out from the window's top-left corner.
 *
 * Squares are kept by their place in the window, not in the element, and outlive the element: resizing the window, opening
 * the chat list beside the page or coming back to it shows more or less of the same field, where regenerating it on every
 * resize reshuffled the whole thing each time. Values are 0..1 and scaled by maxOpacity when drawn, so a theme change
 * keeps the pattern too.
 */
const fields = new Map<number, { cols: number; rows: number; v: Float32Array }>()

function fieldFor(cell: number, cols: number, rows: number) {
  const have = fields.get(cell)
  if (have && have.cols >= cols && have.rows >= rows) return have
  const next = { cols: Math.max(cols, have?.cols ?? 0), rows: Math.max(rows, have?.rows ?? 0), v: new Float32Array(0) }
  next.v = new Float32Array(next.cols * next.rows)
  for (let i = 0; i < next.v.length; i++) next.v[i] = Math.random()
  // Growing keeps every square that was already there where it was.
  if (have) for (let c = 0; c < have.cols; c++) for (let r = 0; r < have.rows; r++) next.v[c * next.rows + r] = have.v[c * have.rows + r]!
  fields.set(cell, next)
  return next
}

export const FlickeringGrid: React.FC<FlickeringGridProps> = ({
  squareSize = 4,
  gridGap = 6,
  flickerChance = 0.3,
  color = "rgb(0, 0, 0)",
  width,
  height,
  className,
  maxOpacity = 0.3,
  ...props
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const memoizedColor = useMemo(() => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d")
    if (!ctx) return "rgba(255, 0, 0,"
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data)
    return `rgba(${r}, ${g}, ${b},`
  }, [color])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !container || !ctx) return
    const cell = squareSize + gridGap
    // Whether the canvas is on screen, read each tick.
    let inView = true

    /** The squares that fall inside the element, in window cells. */
    const span = () => {
      const r = container.getBoundingClientRect()
      const w = width || container.clientWidth
      const h = height || container.clientHeight
      const c0 = Math.max(0, Math.floor(r.left / cell))
      const r0 = Math.max(0, Math.floor(r.top / cell))
      const c1 = Math.ceil((r.left + w) / cell)
      const r1 = Math.ceil((r.top + h) / cell)
      return { r, w, h, c0, r0, c1, r1, f: fieldFor(cell, c1 + 1, r1 + 1) }
    }

    const draw = (s: ReturnType<typeof span>) => {
      const dpr = window.devicePixelRatio || 1
      // Only a real change of size touches the canvas: setting its size clears it.
      if (canvas.width !== Math.round(s.w * dpr) || canvas.height !== Math.round(s.h * dpr)) {
        canvas.width = Math.round(s.w * dpr)
        canvas.height = Math.round(s.h * dpr)
        canvas.style.width = `${s.w}px`
        canvas.style.height = `${s.h}px`
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      // One colour for the whole field and each square's own alpha: a new colour string per square, thousands a frame, was
      // most of what drawing it cost.
      ctx.fillStyle = `${memoizedColor}1)`
      for (let c = s.c0; c < s.c1; c++) {
        for (let r = s.r0; r < s.r1; r++) {
          ctx.globalAlpha = s.f.v[c * s.f.rows + r]! * maxOpacity
          ctx.fillRect((c * cell - s.r.left) * dpr, (r * cell - s.r.top) * dpr, squareSize * dpr, squareSize * dpr)
        }
      }
      ctx.globalAlpha = 1
    }

    // Measured when it is resized and only then: reading its box every frame, sixty times a second, was most of what an idle
    // home screen cost. Drawn the moment it is resized, not on the next tick: the resize has already cleared it, and a frame
    // in between is a flash.
    let s = span()
    let dpr = window.devicePixelRatio || 1
    const now = () => {
      s = span()
      dpr = window.devicePixelRatio || 1
      draw(s)
    }
    now()

    // The flicker, ten times a second: each tick changes a few of the squares, and only those are drawn again. Clearing a
    // whole pixel around each one first leaves it exactly as a full redraw would, edges and all, at a hundredth of the work
    // (the gap between squares is wider than that pixel, so a neighbour is never touched).
    let lastTime = performance.now()
    const tick = () => {
      // Still while Friday isn't the window in use (awake.ts sets html.asleep): a background flickering behind other apps is
      // a canvas drawn ten times a second for nobody.
      if (!inView || document.hidden || document.documentElement.classList.contains("asleep")) return
      if ((window.devicePixelRatio || 1) !== dpr) return now()
      const time = performance.now()
      const dt = Math.min(0.1, (time - lastTime) / 1000)
      lastTime = time
      const size = squareSize * dpr
      ctx.fillStyle = `${memoizedColor}1)`
      for (let c = s.c0; c < s.c1; c++) {
        for (let r = s.r0; r < s.r1; r++) {
          if (Math.random() >= flickerChance * dt) continue
          const i = c * s.f.rows + r
          s.f.v[i] = Math.random()
          const x = (c * cell - s.r.left) * dpr
          const y = (r * cell - s.r.top) * dpr
          ctx.clearRect(Math.floor(x) - 1, Math.floor(y) - 1, Math.ceil(x + size) - Math.floor(x) + 2, Math.ceil(y + size) - Math.floor(y) + 2)
          ctx.globalAlpha = s.f.v[i]! * maxOpacity
          ctx.fillRect(x, y, size, size)
        }
      }
      ctx.globalAlpha = 1
    }
    // A still field (no flicker, or motion reduced) draws only when it is resized.
    const timer = flickerChance > 0 ? window.setInterval(tick, 100) : 0

    const ro = new ResizeObserver(now)
    ro.observe(container)
    const io = new IntersectionObserver(([entry]) => {
      inView = !!entry?.isIntersecting
    })
    io.observe(canvas)
    return () => {
      clearInterval(timer)
      ro.disconnect()
      io.disconnect()
    }
  }, [squareSize, gridGap, flickerChance, maxOpacity, memoizedColor, width, height])

  return (
    <div ref={containerRef} className={cn(`h-full w-full ${className}`)} {...props}>
      <canvas ref={canvasRef} className="pointer-events-none" />
    </div>
  )
}
