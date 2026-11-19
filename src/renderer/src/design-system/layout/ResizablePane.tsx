import { useRef, type CSSProperties, type ReactNode } from 'react'
import { usePanelSize } from '../../lib/layout'
import { cx } from '../cx'
import { ResizeHandle, type ResizeEdge } from './ResizeHandle'

/**
 * Painel com uma borda arrastável (`edge`): a largura (borda esquerda ou direita) ou a altura
 * (superior ou inferior) fica lembrada por `id` no workspace aberto (lib/layout). Em `unit: '%'` o
 * tamanho é uma fração do elemento pai, para a divisão acompanhar a janela (requisição e resposta).
 */
export function ResizablePane(props: {
  id: string
  edge: ResizeEdge
  /** Nome da borda para leitores de tela ("Largura da lista de testes"). */
  label: string
  defaultSize: number
  min: number
  max: number
  unit?: 'px' | '%'
  as?: 'aside' | 'nav' | 'section' | 'div'
  /** Classes do painel (o elemento `as`). */
  className?: string
  /** Classes do invólucro que leva a largura/altura e a borda arrastável (margens, por exemplo). */
  outerClassName?: string
  style?: CSSProperties
  hidden?: boolean
  onCollapse?: () => void
  'aria-label'?: string
  role?: string
  children: ReactNode
}) {
  const unit = props.unit ?? 'px'
  const { size, setSize, reset } = usePanelSize(props.id, { fallback: props.defaultSize, min: props.min, max: props.max })
  const root = useRef<HTMLDivElement>(null)
  const horizontal = props.edge === 'left' || props.edge === 'right'
  const dim = horizontal ? 'width' : 'height'
  // Em %, a borda trabalha em px: converte pelo tamanho atual do pai.
  const parentPx = () => {
    const parent = root.current?.parentElement
    return (parent && (horizontal ? parent.clientWidth : parent.clientHeight)) || 1
  }
  const toPx = (v: number) => (unit === '%' ? (v / 100) * parentPx() : v)
  const fromPx = (px: number) => (unit === '%' ? (px / parentPx()) * 100 : px)
  const Tag = props.as ?? 'div'
  // O painel rola por dentro; a borda fica no invólucro, fora da rolagem.
  return (
    <div
      ref={root}
      hidden={props.hidden}
      style={{ [dim]: unit === '%' ? `${size}%` : size }}
      className={cx('relative flex shrink-0', props.outerClassName)}
    >
      <Tag aria-label={props['aria-label']} role={props.role} style={props.style} className={cx('min-h-0 min-w-0 flex-1', props.className)}>
        {props.children}
      </Tag>
      <ResizeHandle
        edge={props.edge}
        label={props.label}
        size={toPx(size)}
        min={toPx(props.min)}
        max={toPx(props.max)}
        onResize={(px) => setSize(fromPx(px))}
        onReset={reset}
        {...(props.onCollapse && { onCollapse: props.onCollapse })}
      />
    </div>
  )
}
