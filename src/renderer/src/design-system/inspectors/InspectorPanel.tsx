import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Move, PanelBottomClose, PanelBottomOpen, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useLayoutChoice, usePanelSize } from '../../lib/layout'
import { readPref } from '../../lib/storage'
import { cx } from '../cx'
import { IconButton } from '../primitives/Button'
import { ResizeHandle } from '../layout/ResizeHandle'
import { DOCK_REQUEST, DockGrip, dockEntries, useDock, useDockHost, type DockSide } from '../layout/dock'
import { separator } from '../navigation/menu-entries'
import { useContextMenu } from '../navigation/ContextMenu'

const MIN = 280
const MAX = 720
const DEFAULT = 320
/** Largura mínima que o conteúdo do módulo guarda ao lado do inspector. */
const CONTENT_MIN = 560
/** Abaixo disso (inspector incluso) o inspector vira gaveta por cima do conteúdo. */
const NARROW = CONTENT_MIN + MIN
/** Faixa do conteúdo que a gaveta deixa à mostra. */
const DRAWER_GAP = 48
const RAIL = 36
/** Inspector embaixo: altura padrão, mínima, e o que o conteúdo do módulo guarda acima dele. */
const HEIGHT = { fallback: 260, min: 140, max: 900 }
const CONTENT_MIN_HEIGHT = 160
const SIDES = ['left', 'right', 'bottom'] as const satisfies readonly DockSide[]
const LABEL = 'o inspector'

/**
 * Inspector do módulo: explica o item selecionado. Fica à direita, à esquerda ou embaixo do
 * conteúdo, como uma view do VS Code: o grip do cabeçalho arrasta para outro lado (o overlay mostra
 * onde cai), e o botão de mover e o menu do cabeçalho fazem o mesmo pelo teclado. O lado fica
 * lembrado por `id` no workspace aberto. Recolhe sem desmontar o conteúdo (a seleção e a rolagem ficam) e tem a largura
 * ajustável pela borda esquerda (arrastar, setas com o foco nela, duplo clique volta ao padrão;
 * arrastar bem para a direita recolhe). Largura e estado ficam lembrados por `id` no workspace
 * aberto (lib/layout). Ctrl+B recolhe o inspector do módulo visível.
 *
 * Responsivo: a largura nunca deixa o conteúdo do módulo com menos de
 * 560 px. Quando nem isso cabe (zoom de 150% numa janela de 1280 px, janela estreita), o inspector
 * fica recolhido na faixa da direita e abre como gaveta por cima do conteúdo, sem espremê-lo;
 * Esc ou Ctrl+B fecham a gaveta. A escolha de recolher da janela larga não muda.
 */
export function InspectorPanel(props: {
  id: string
  title: string
  subtitle?: ReactNode
  /** Largura inicial antes de o usuário ajustar (padrão 320 px). */
  defaultWidth?: number
  children: ReactNode
}) {
  // Antes do layout por workspace, a largura e o estado ficavam em inspector.<id>.*: viram o padrão.
  const [legacy] = useState(() => ({
    width: Number(readPref(`inspector.${props.id}.width`)) || props.defaultWidth || DEFAULT,
    collapsed: readPref(`inspector.${props.id}.collapsed`) === '1'
  }))
  const [shown, setShown] = useLayoutChoice(`inspector.${props.id}.shown`, legacy.collapsed ? 'collapsed' : 'open', SHOWN)
  const collapsed = shown === 'collapsed'
  const { size: width, setSize: setWidth, reset } = usePanelSize(`inspector.${props.id}.width`, {
    fallback: Math.min(MAX, Math.max(MIN, legacy.width)),
    min: MIN,
    max: MAX
  })
  const [side, setSide] = useLayoutChoice<(typeof SIDES)[number]>(`inspector.${props.id}.side`, 'right', SIDES)
  const height = usePanelSize(`inspector.${props.id}.height`, HEIGHT)
  // Juntado como aba na lista lateral do módulo (DockablePane com inspector={id}), quando ela existe.
  const [joined, setJoined] = useLayoutChoice(`inspector.${props.id}.joined`, 'no', JOINED)
  const host = useDockHost(props.id)
  const together = joined === 'yes' && host !== null
  const bottom = side === 'bottom'
  // Largura (ao lado) ou altura (embaixo) da área onde o inspector está, ele incluso. 0 enquanto o
  // módulo está oculto.
  const [available, setAvailable] = useState(0)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const ctx = useContextMenu()

  useLayoutEffect(() => {
    const row = root.current?.parentElement
    if (!row) return
    // A área vira coluna com o inspector embaixo; à esquerda, ele vem antes do conteúdo (styles.css).
    row.dataset['dock'] = side
    const measure = () => {
      // Módulo oculto (display: none) mede 0: mantém a última medida conhecida.
      const v = bottom ? row.clientHeight : row.clientWidth
      if (v > 0) setAvailable(v)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => {
      observer.disconnect()
      delete row.dataset['dock']
    }
  }, [side, bottom, together])

  const dock = useDock({
    label: LABEL,
    area: () => root.current?.parentElement ?? null,
    sides: SIDES,
    current: side,
    move: setSide,
    ...(host && {
      join: {
        area: () => host.pane,
        label: host.label,
        run: () => {
          setJoined('yes')
          host.show()
        }
      }
    })
  })

  // "Mover o inspector para..." na paleta: só o inspector do módulo visível responde.
  useEffect(() => {
    const onDock = (e: Event) => {
      const { target, side: next } = (e as CustomEvent<{ target: string; side: DockSide | 'join' }>).detail
      if (target !== 'inspector') return
      if (together) {
        // Juntado: só o do módulo visível (a lista à mostra) sai, para o lado pedido.
        if (!host?.pane.offsetParent || !(SIDES as readonly string[]).includes(next)) return
        setJoined('no')
        setSide(next as (typeof SIDES)[number])
        setShown('open')
      } else if (root.current?.offsetParent) {
        if (next === 'join') {
          if (host) {
            setJoined('yes')
            host.show()
          }
        } else if ((SIDES as readonly string[]).includes(next)) setSide(next as (typeof SIDES)[number])
      }
    }
    window.addEventListener(DOCK_REQUEST, onDock)
    return () => window.removeEventListener(DOCK_REQUEST, onDock)
  }, [setSide, setJoined, setShown, together, host])

  const narrow = !bottom && available > 0 && available < NARROW
  const maxWidth = narrow ? Math.max(RAIL, available - DRAWER_GAP) : Math.min(MAX, Math.max(MIN, available - CONTENT_MIN))
  const shownWidth = available > 0 ? Math.min(width, maxWidth) : width
  const mode: 'inline' | 'rail' | 'drawer' = narrow ? (drawerOpen ? 'drawer' : 'rail') : collapsed ? 'rail' : 'inline'

  // Ao alargar a janela a gaveta some; ao estreitar de novo, começa fechada.
  useEffect(() => {
    if (!narrow) setDrawerOpen(false)
  }, [narrow])

  const toggle = useCallback(() => {
    if (narrow) {
      setDrawerOpen((o) => !o)
      return
    }
    setShown(collapsed ? 'open' : 'collapsed')
  }, [narrow, collapsed, setShown])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Só o inspector do módulo visível responde (os outros módulos ficam montados, ocultos).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'b' && root.current?.offsetParent) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  // A gaveta fecha com Esc. Um clique no conteúdo à mostra não fecha: escolher outra linha
  // atualiza o inspector aberto.
  const drawer = narrow && drawerOpen
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && root.current?.offsetParent) {
        e.preventDefault()
        setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])

  const open = mode !== 'rail'
  const maxHeight = Math.max(HEIGHT.min, available - CONTENT_MIN_HEIGHT)
  const shownHeight = available > 0 ? Math.min(height.size, maxHeight) : height.size
  const moveEntries = () => [
    ...dockEntries(LABEL, SIDES, side, setSide),
    ...(host
      ? [
          separator,
          {
            id: 'dock-join',
            label: `Juntar o inspector a ${host.label}, como aba`,
            run: () => {
              setJoined('yes')
              host.show()
            }
          }
        ]
      : [])
  ]
  const [Close, Open] = bottom ? [PanelBottomClose, PanelBottomOpen] : side === 'left' ? [PanelLeftClose, PanelLeftOpen] : [PanelRightClose, PanelRightOpen]
  if (together) {
    return createPortal(
      <>
        {props.subtitle && <div className="border-b border-border-subtle px-3 py-2 text-xs text-muted">{props.subtitle}</div>}
        {props.children}
      </>,
      host.slot
    )
  }
  return (
    <aside
      ref={root}
      aria-label={props.title}
      data-inspector-mode={mode}
      data-inspector-side={side}
      style={mode === 'inline' ? (bottom ? { height: shownHeight } : { width: shownWidth }) : undefined}
      className={cx(
        'relative flex shrink-0 flex-col border-border bg-panel',
        bottom ? 'w-full border-t' : 'w-9',
        side === 'right' && 'border-l',
        side === 'left' && 'border-r'
      )}
    >
      {ctx.menu}
      {dock.overlay}
      <div
        style={mode === 'drawer' ? { width: shownWidth } : undefined}
        className={
          mode === 'drawer'
            ? cx('absolute inset-y-0 z-30 flex flex-col border-border bg-panel shadow-2xl', side === 'left' ? 'left-0 border-r' : 'right-0 border-l')
            : 'flex min-h-0 flex-1 flex-col'
        }
      >
        {open &&
          (bottom ? (
            <ResizeHandle
              edge="top"
              label="Altura do inspector"
              size={shownHeight}
              min={HEIGHT.min}
              max={maxHeight}
              onResize={(h) => height.setSize(Math.min(h, maxHeight))}
              onReset={height.reset}
              onCollapse={() => setShown('collapsed')}
            />
          ) : (
            <ResizeHandle
              edge={side === 'left' ? 'right' : 'left'}
              label="Largura do inspector"
              size={shownWidth}
              min={Math.min(MIN, maxWidth)}
              max={maxWidth}
              onResize={(w) => setWidth(Math.min(w, maxWidth))}
              onReset={reset}
              {...(!narrow && { onCollapse: () => setShown('collapsed') })}
            />
          ))}
        <div
          className={cx('flex h-9 shrink-0 items-center gap-1 px-1.5', (open || bottom) && 'border-b border-border', !open && !bottom && 'flex-col')}
          {...ctx.bind('Inspector', moveEntries)}
        >
          <IconButton
            label={
              mode === 'drawer'
                ? 'Fechar inspector (Ctrl+B)'
                : open
                  ? 'Recolher inspector (Ctrl+B)'
                  : 'Mostrar inspector (Ctrl+B)'
            }
            aria-expanded={open}
            onClick={toggle}
          >
            {open ? <Close size={15} aria-hidden /> : <Open size={15} aria-hidden />}
          </IconButton>
          {(open || bottom) && (
            <>
              <DockGrip label={LABEL} onPointerDown={dock.onPointerDown} className="-ml-1" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold">{props.title}</div>
              </div>
              <IconButton label="Mover o inspector…" onClick={(e) => ctx.open(e.currentTarget, 'Mover o inspector', moveEntries())}>
                <Move size={14} aria-hidden />
              </IconButton>
            </>
          )}
        </div>
        <div hidden={!open} className="min-h-0 flex-1 overflow-auto">
          {props.subtitle && (
            <div className="border-b border-border-subtle px-3 py-2 text-xs text-muted">{props.subtitle}</div>
          )}
          {props.children}
        </div>
      </div>
    </aside>
  )
}

const SHOWN = ['open', 'collapsed'] as const
const JOINED = ['no', 'yes'] as const
