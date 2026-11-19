import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Move } from 'lucide-react'
import { useLayoutChoice } from '../../lib/layout'
import { cx } from '../cx'
import { IconButton } from '../primitives/Button'
import { separator, type ContextMenuEntries } from '../navigation/menu-entries'
import { useContextMenu } from '../navigation/ContextMenu'
import { DOCK_LABEL, DOCK_REQUEST, DockGrip, dockEntries, registerDockHost, requestDock, useDock, type DockSide } from './dock'
import { ResizablePane } from './ResizablePane'

const SIDES = ['left', 'right'] as const satisfies readonly DockSide[]
const TABS = ['list', 'inspector'] as const
const JOINED = ['no', 'yes'] as const
/** Para onde o inspector juntado pode sair (os lados dele no módulo). */
const INSPECTOR_SIDES = ['right', 'left', 'bottom'] as const satisfies readonly DockSide[]

/** Bordas que o chamador põe do lado do conteúdo: elas acompanham o lado da lista. */
const SIDE_BORDER = /^border-[rl]$/
const BORDER_COLOR = /^border-border(-subtle)?$/

/**
 * Lista lateral de um módulo (a hierarquia do Catálogo, os endpoints dos Cenários e do Flow Studio,
 * as mudanças do Git, o sumário da Documentação) que se move como uma view do VS Code: o grip do
 * cabeçalho arrasta para o outro lado, o botão de mover e o menu fazem o mesmo pelo teclado, e a
 * paleta ("Mover a lista lateral...") move a do módulo visível. Com `inspector`, o inspector do
 * módulo pode entrar aqui como aba (arrastando o grip dele para cima da lista, ou pela paleta), e as
 * duas views dividem o mesmo lugar. Lado, aba e junção ficam lembrados por `id` no workspace
 * aberto (lib/layout), como a largura.
 */
export function DockablePane(props: {
  id: string
  /** Título do cabeçalho e da aba ("Conectores"). */
  title: string
  /** Nome do painel nas mensagens ("a hierarquia de conectores"). */
  dockLabel: string
  /** Id do InspectorPanel do módulo que pode entrar como aba. */
  inspector?: string
  /** Botões a mais no cabeçalho (recolher, por exemplo). */
  actions?: ReactNode
  /** false: a paleta não move esta lista (uma lista dentro de um editor, não a do módulo). */
  palette?: boolean
  /** Rótulo da borda de largura ("Largura da hierarquia de conectores"). */
  label: string
  defaultSize: number
  min: number
  max: number
  as?: 'aside' | 'nav' | 'section' | 'div'
  className?: string
  outerClassName?: string
  hidden?: boolean
  onCollapse?: () => void
  'aria-label'?: string
  role?: string
  children: ReactNode
}) {
  const [side, setSide] = useLayoutChoice<(typeof SIDES)[number]>(`pane.${props.id}.side`, 'left', SIDES)
  const [tab, setTab] = useLayoutChoice<(typeof TABS)[number]>(`pane.${props.id}.tab`, 'list', TABS)
  // O mesmo id que o InspectorPanel lê: os dois acompanham a junção pelo LAYOUT_CHANGED.
  const [joined] = useLayoutChoice<(typeof JOINED)[number]>(`inspector.${props.inspector ?? '-'}.joined`, 'no', JOINED)
  const together = !!props.inspector && joined === 'yes'
  const showing = together ? tab : 'list'
  const pane = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const ctx = useContextMenu()
  // pane → painel do ResizablePane → invólucro dele → a linha do módulo, onde os lados valem.
  const row = () => pane.current?.parentElement?.parentElement?.parentElement ?? null

  const dock = useDock({ label: props.dockLabel, area: row, sides: SIDES, current: side, move: setSide })

  // O inspector do módulo procura este painel para entrar como aba.
  useLayoutEffect(() => {
    if (!props.inspector || !pane.current || !slot.current) return
    return registerDockHost(props.inspector, { pane: pane.current, slot: slot.current, label: props.dockLabel, show: () => setTab('inspector') })
  }, [props.inspector, props.dockLabel, setTab])

  useEffect(() => {
    if (props.palette === false) return
    const onDock = (e: Event) => {
      const { target, side: next } = (e as CustomEvent<{ target: string; side: string }>).detail
      if (target === 'side-list' && pane.current?.offsetParent && (SIDES as readonly string[]).includes(next)) setSide(next as (typeof SIDES)[number])
    }
    window.addEventListener(DOCK_REQUEST, onDock)
    return () => window.removeEventListener(DOCK_REQUEST, onDock)
  }, [props.palette, setSide])

  const entries = (): ContextMenuEntries => [
    ...dockEntries(props.dockLabel, SIDES, side, setSide),
    ...(props.inspector
      ? [
          separator,
          ...(together
            ? INSPECTOR_SIDES.map((s) => ({ id: `split-${s}`, label: `Separar o inspector (${DOCK_LABEL[s]})`, run: () => requestDock('inspector', s) }))
            : [{ id: 'join', label: 'Juntar o inspector aqui, como aba', run: () => requestDock('inspector', 'join') }])
        ]
      : [])
  ]

  // A borda do lado do conteúdo vai para o invólucro e troca de lado com a lista.
  const classes = (props.className ?? '').split(/\s+/).filter(Boolean)
  const hasBorder = classes.some((c) => SIDE_BORDER.test(c))
  const color = classes.find((c) => BORDER_COLOR.test(c)) ?? 'border-border-subtle'
  const inner = classes.filter((c) => !SIDE_BORDER.test(c) && !BORDER_COLOR.test(c)).join(' ')
  const Tag = props.as ?? 'div'

  return (
    <ResizablePane
      id={props.id}
      edge={side === 'left' ? 'right' : 'left'}
      label={props.label}
      defaultSize={props.defaultSize}
      min={props.min}
      max={props.max}
      className={cx('flex flex-col', hasBorder && color, hasBorder && (side === 'left' ? 'border-r' : 'border-l'))}
      outerClassName={cx(props.outerClassName, side === 'right' && 'order-2')}
      {...(props.hidden !== undefined && { hidden: props.hidden })}
      {...(props.onCollapse && { onCollapse: props.onCollapse })}
    >
      <div ref={pane} data-pane-side={side} data-pane-id={props.id} className="flex min-h-0 flex-1 flex-col">
        {ctx.menu}
        {dock.overlay}
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border-subtle px-1 text-xs" {...ctx.bind(props.title, entries)}>
          <DockGrip label={props.dockLabel} onPointerDown={dock.onPointerDown} />
          {together ? (
            <div role="tablist" aria-label={`Abas de ${props.title}`} className="flex min-w-0 flex-1 gap-0.5">
              {(
                [
                  ['list', props.title],
                  ['inspector', 'Inspector']
                ] as const
              ).map(([id, title]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={showing === id}
                  onClick={() => setTab(id)}
                  className={cx(
                    'truncate rounded-[var(--radius-control)] px-1.5 py-0.5 font-semibold',
                    showing === id ? 'bg-elevated text-fg' : 'text-muted hover:text-fg'
                  )}
                >
                  {title}
                </button>
              ))}
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate font-semibold">{props.title}</span>
          )}
          {props.actions}
          <IconButton label={`Mover ${props.dockLabel}…`} onClick={(e) => ctx.open(e.currentTarget, `Mover ${props.dockLabel}`, entries())}>
            <Move size={13} aria-hidden />
          </IconButton>
        </div>
        <Tag hidden={showing !== 'list'} aria-label={props['aria-label']} role={props.role} className={cx('min-h-0 min-w-0 flex-1', inner)}>
          {props.children}
        </Tag>
        {/* O inspector juntado desenha aqui (por portal). */}
        <div ref={slot} hidden={showing !== 'inspector'} role={together ? 'tabpanel' : undefined} aria-label="Inspector" className="flex min-h-0 flex-1 flex-col overflow-auto" />
      </div>
    </ResizablePane>
  )
}
