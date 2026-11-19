import type { RefObject } from 'react'
import { usePanelSize } from '../../lib/layout'
import { ResizeHandle } from './ResizeHandle'

const MIN = 20
const MAX = 80

/**
 * Divisão lado a lado (editor e prévia): a fração do primeiro painel, em %, lembrada por `id` no
 * workspace aberto. O primeiro painel usa `style={{ flex: split.flex }}` e recebe o `SplitHandle`.
 */
export function useSplit(id: string, fallback = 50) {
  const s = usePanelSize(id, { fallback, min: MIN, max: MAX })
  return { ...s, flex: `0 0 ${s.size}%` }
}

/**
 * A borda entre os dois painéis de `useSplit`: dentro do primeiro (`edge="right"`) ou do segundo
 * (`edge="left"`, quando o primeiro é de outra biblioteca, como o Monaco). O painel que a recebe
 * precisa ser `relative`.
 */
export function SplitHandle(props: {
  split: ReturnType<typeof useSplit>
  row: RefObject<HTMLElement | null>
  label: string
  edge?: 'left' | 'right'
}) {
  const width = () => props.row.current?.clientWidth || 1
  const px = (pct: number) => (pct / 100) * width()
  // Na borda esquerda do segundo painel, o tamanho arrastado é o dele: o restante da linha.
  const own = (pct: number) => (props.edge === 'left' ? 100 - pct : pct)
  return (
    <ResizeHandle
      edge={props.edge ?? 'right'}
      label={props.label}
      size={px(own(props.split.size))}
      min={px(MIN)}
      max={px(MAX)}
      onResize={(next) => props.split.setSize(own((next / width()) * 100))}
      onReset={props.split.reset}
    />
  )
}
