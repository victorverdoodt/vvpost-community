import { useRef } from 'react'
import { cx } from '../cx'

export type ResizeEdge = 'left' | 'right' | 'top' | 'bottom'

/** Quanto abaixo do mínimo o arraste precisa ir para recolher o painel (como no VS Code). */
const COLLAPSE_SLACK = 0.5
const STEP = 16

/**
 * Borda arrastável de um painel: fica sobre a borda `edge` do elemento pai (que precisa ser
 * `relative`). Arrastar ajusta o tamanho; setas (Shift: passo maior), Home e End também, com o
 * foco nela; duplo clique volta ao padrão. Com `onCollapse`, arrastar bem abaixo do mínimo recolhe
 * o painel. O tamanho em si fica com quem usa (lib/layout lembra por workspace).
 */
export function ResizeHandle(props: {
  edge: ResizeEdge
  label: string
  size: number
  min: number
  max: number
  onResize: (next: number) => void
  onReset?: () => void
  onCollapse?: () => void
  className?: string
}) {
  const drag = useRef<{ start: number; size: number } | null>(null)
  const vertical = props.edge === 'left' || props.edge === 'right'
  // Direção em que o painel cresce: borda direita/inferior cresce para frente, esquerda/superior para trás.
  const sign = props.edge === 'right' || props.edge === 'bottom' ? 1 : -1
  const max = Math.max(props.min, props.max)

  const end = (el: HTMLElement, id: number) => {
    drag.current = null
    if (el.hasPointerCapture(id)) el.releasePointerCapture(id)
    document.body.style.removeProperty('cursor')
    document.body.classList.remove('select-none')
  }

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={props.label}
      aria-valuemin={props.min}
      aria-valuemax={max}
      aria-valuenow={Math.round(props.size)}
      tabIndex={0}
      title={props.onReset ? `${props.label} (duplo clique volta ao padrão)` : props.label}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { start: vertical ? e.clientX : e.clientY, size: props.size }
        document.body.style.cursor = vertical ? 'col-resize' : 'row-resize'
        document.body.classList.add('select-none')
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const raw = d.size + sign * ((vertical ? e.clientX : e.clientY) - d.start)
        if (props.onCollapse && raw < props.min * COLLAPSE_SLACK) {
          end(e.currentTarget, e.pointerId)
          props.onCollapse()
          return
        }
        props.onResize(Math.min(max, Math.max(props.min, raw)))
      }}
      onPointerUp={(e) => end(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => end(e.currentTarget, e.pointerId)}
      onDoubleClick={props.onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? STEP * 4 : STEP
        const grow = vertical ? (sign > 0 ? 'ArrowRight' : 'ArrowLeft') : sign > 0 ? 'ArrowDown' : 'ArrowUp'
        const shrink = vertical ? (sign > 0 ? 'ArrowLeft' : 'ArrowRight') : sign > 0 ? 'ArrowUp' : 'ArrowDown'
        const next =
          e.key === grow ? props.size + step : e.key === shrink ? props.size - step : e.key === 'Home' ? props.min : e.key === 'End' ? max : null
        if (next === null) {
          if (e.key === 'Enter' && props.onReset) {
            e.preventDefault()
            props.onReset()
          }
          return
        }
        e.preventDefault()
        props.onResize(Math.min(max, Math.max(props.min, next)))
      }}
      className={cx(
        'absolute z-10 touch-none transition-colors delay-150 hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:outline-none',
        vertical ? 'inset-y-0 w-1.5 cursor-col-resize' : 'inset-x-0 h-1.5 cursor-row-resize',
        props.edge === 'left' && '-left-[3px]',
        props.edge === 'right' && '-right-[3px]',
        props.edge === 'top' && '-top-[3px]',
        props.edge === 'bottom' && '-bottom-[3px]',
        props.className
      )}
    />
  )
}
