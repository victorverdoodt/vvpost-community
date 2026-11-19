import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { GripVertical } from 'lucide-react'
import { cx } from '../cx'
import type { ContextMenuEntries } from '../navigation/menu-entries'

/** Onde um painel pode ficar dentro da área dele. */
export type DockSide = 'left' | 'right' | 'top' | 'bottom'

export const DOCK_LABEL: Record<DockSide, string> = {
  left: 'à esquerda',
  right: 'à direita',
  top: 'em cima',
  bottom: 'embaixo'
}

/** Quanto o ponteiro anda antes de o arraste começar (um clique no grip não move nada). */
const DRAG_THRESHOLD = 4

/**
 * O lado onde o painel cai se for solto em (x, y) dentro de `rect`, como o drop overlay do VS Code
 * (editorDropTarget.ts e viewPaneContainer.ts): o terço de cima e o de baixo valem para em cima e
 * embaixo; no meio, a metade esquerda ou direita. Só os lados de `sides` contam.
 */
export function dropSide(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  sides: readonly DockSide[]
): DockSide | null {
  const px = (x - rect.left) / rect.width
  const py = (y - rect.top) / rect.height
  if (px < 0 || px > 1 || py < 0 || py > 1 || !sides.length) return null
  const horizontal = sides.filter((s) => s === 'left' || s === 'right')
  // Sem lado na horizontal, em cima e embaixo dividem a área ao meio.
  const edge = horizontal.length ? 1 / 3 : 1 / 2
  if (sides.includes('top') && py < edge) return 'top'
  if (sides.includes('bottom') && py >= 1 - edge) return 'bottom'
  if (!horizontal.length) return null
  if (horizontal.length === 1) {
    // Só um lado na horizontal: a metade dele; a outra metade não move nada.
    const only = horizontal[0]!
    return (only === 'left' ? px < 0.5 : px >= 0.5) ? only : null
  }
  return px < 0.5 ? 'left' : 'right'
}

/** A parte da área que o overlay pinta para cada lado: metade, como no VS Code. */
const OVERLAY: Record<DockSide, { left: string; top: string; width: string; height: string }> = {
  left: { left: '0', top: '0', width: '50%', height: '100%' },
  right: { left: '50%', top: '0', width: '50%', height: '100%' },
  top: { left: '0', top: '0', width: '100%', height: '50%' },
  bottom: { left: '0', top: '50%', width: '100%', height: '50%' }
}

/**
 * Arrastar um painel para outro lado da área dele (o explorador na janela, o inspector no módulo,
 * a edição da requisição ao lado da resposta). O grip do cabeçalho começa o arraste; o overlay
 * mostra onde o painel vai cair; soltar move, Esc cancela. O mesmo `move` serve ao menu e à paleta
 * ("Mover para..."), para quem não usa o mouse.
 */
export function useDock<S extends DockSide>(opts: {
  /** Nome do painel ("o inspector"). */
  label: string
  /** A área onde os lados valem (medida no início do arraste). */
  area: () => HTMLElement | null
  sides: readonly S[]
  current: S
  move: (side: S) => void
  /**
   * Outro painel onde este pode entrar como aba (o inspector na lista lateral, como as views do VS
   * Code num mesmo container): soltar em cima dele junta.
   */
  join?: { area: () => HTMLElement | null; label: string; run: () => void }
}) {
  const [drag, setDrag] = useState<{ x: number; y: number; rect: DOMRect; join: DOMRect | null; side: S | 'join' | null } | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDrag(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [!!drag])

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const start = { x: e.clientX, y: e.clientY }
    let started = false
    let current: { rect: DOMRect; join: DOMRect | null; side: S | 'join' | null } | null = null
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return
        const area = optsRef.current.area()
        if (!area) return
        started = true
        current = { rect: area.getBoundingClientRect(), join: optsRef.current.join?.area()?.getBoundingClientRect() ?? null, side: null }
        document.body.classList.add('select-none')
        document.body.style.cursor = 'grabbing'
      }
      const j = current!.join
      const inJoin = !!j && j.width > 0 && ev.clientX >= j.left && ev.clientX <= j.right && ev.clientY >= j.top && ev.clientY <= j.bottom
      const side = inJoin ? 'join' : (dropSide(ev.clientX, ev.clientY, current!.rect, optsRef.current.sides) as S | null)
      current = { ...current!, side }
      setDrag({ x: ev.clientX, y: ev.clientY, rect: current.rect, join: current.join, side })
    }
    const end = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
      document.body.classList.remove('select-none')
      document.body.style.removeProperty('cursor')
      setDrag((d) => {
        // Esc já cancelou (d é null): não move.
        if (d && ev.type === 'pointerup' && current?.side === 'join') queueMicrotask(() => optsRef.current.join?.run())
        else if (d && ev.type === 'pointerup' && current?.side && current.side !== optsRef.current.current) {
          const side = current.side as S
          queueMicrotask(() => optsRef.current.move(side))
        }
        return null
      })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }

  const overlay =
    drag &&
    createPortal(
      <>
        {drag.side === 'join' && drag.join && (
          <div
            aria-hidden
            data-dock-target="join"
            className="pointer-events-none fixed z-50 border-2 border-accent bg-accent/15"
            style={{ left: drag.join.left, top: drag.join.top, width: drag.join.width, height: drag.join.height }}
          />
        )}
        <div
          aria-hidden
          className="pointer-events-none fixed z-50"
          style={{ left: drag.rect.left, top: drag.rect.top, width: drag.rect.width, height: drag.rect.height }}
        >
          {drag.side && drag.side !== 'join' && (
            <div
              data-dock-target={drag.side}
              className={cx(
                'absolute border-accent bg-accent/15 transition-all duration-150',
                drag.side === 'left' && 'border-l-2',
                drag.side === 'right' && 'border-r-2',
                drag.side === 'top' && 'border-t-2',
                drag.side === 'bottom' && 'border-b-2'
              )}
              style={OVERLAY[drag.side]}
            />
          )}
        </div>
        <div
          role="status"
          className="pointer-events-none fixed z-50 whitespace-nowrap rounded-[var(--radius-control)] border border-border bg-elevated px-2 py-1 text-xs shadow-lg"
          // Perto da borda direita ou de baixo da janela, o aviso fica do outro lado do cursor.
          style={{
            ...(drag.x + 240 > window.innerWidth ? { right: window.innerWidth - drag.x + 12 } : { left: drag.x + 12 }),
            ...(drag.y + 48 > window.innerHeight ? { bottom: window.innerHeight - drag.y + 12 } : { top: drag.y + 12 })
          }}
        >
          {drag.side === 'join'
            ? `Juntar ${opts.label} como aba em ${opts.join?.label ?? 'outro painel'}`
            : drag.side
            ? drag.side === opts.current
              ? `${capitalize(opts.label)} fica ${DOCK_LABEL[drag.side]}`
              : moveLabel(opts.label, drag.side)
            : 'Solte numa das metades'}
        </div>
      </>,
      document.body
    )

  return { onPointerDown, overlay, dragging: !!drag }
}

/** "Mover o inspector para a esquerda": o texto dos itens de menu e dos comandos da paleta. */
export function moveLabel(label: string, side: DockSide): string {
  const to = { left: 'para a esquerda', right: 'para a direita', top: 'para cima', bottom: 'para baixo' }[side]
  return `Mover ${label} ${to}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** O grip do cabeçalho de um painel: arrastar move o painel; o título explica. */
export function DockGrip(props: { label: string; onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void; children?: ReactNode; className?: string }) {
  return (
    <span
      role="img"
      aria-label={`Arrastar para mover ${props.label}`}
      title={`Arraste para mover ${props.label} (como no VS Code)`}
      onPointerDown={props.onPointerDown}
      className={cx('flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center text-faint hover:text-fg', props.className)}
    >
      {props.children ?? <GripVertical size={13} aria-hidden />}
    </span>
  )
}

/** Os itens "Mover ... para ..." do menu do painel (o caminho do teclado, como o "Move View" do VS Code). */
export function dockEntries<S extends DockSide>(label: string, sides: readonly S[], current: S, move: (side: S) => void): ContextMenuEntries {
  return sides.map((side) => ({
    id: `dock-${side}`,
    label: moveLabel(label, side),
    disabled: side === current,
    run: () => move(side)
  }))
}

/** Avisa o painel visível que a paleta pediu para movê-lo (o painel ouve pelo `target`); join junta como aba. */
export const DOCK_REQUEST = 'vvpost:dock-request'
export function requestDock(target: string, side: DockSide | 'join'): void {
  window.dispatchEvent(new CustomEvent(DOCK_REQUEST, { detail: { target, side } }))
}

/**
 * Onde um painel pode entrar como aba: a lista lateral de um módulo se registra com o id do
 * inspector do módulo, e o inspector, juntado, desenha o conteúdo dele no `slot` (por portal),
 * ainda montado no lugar de sempre na árvore do React (o estado e a seleção ficam).
 */
export interface DockHost {
  /** O painel inteiro (alvo do arraste para juntar). */
  pane: HTMLElement
  /** Onde o conteúdo do painel juntado aparece. */
  slot: HTMLElement
  /** Nome da lista ("a hierarquia de conectores"). */
  label: string
  /** Mostra a aba do painel juntado. */
  show(): void
}

const hosts = new Map<string, DockHost>()
const listeners = new Set<() => void>()
let version = 0
const changed = () => {
  version++
  for (const l of listeners) l()
}

export function registerDockHost(id: string, host: DockHost): () => void {
  hosts.set(id, host)
  changed()
  return () => {
    if (hosts.get(id) === host) {
      hosts.delete(id)
      changed()
    }
  }
}

/** O host registrado para o painel `id` (o inspector do módulo), acompanhando montagens. */
export function useDockHost(id: string): DockHost | null {
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version
  )
  return hosts.get(id) ?? null
}
