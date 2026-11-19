import { useEffect, useRef } from 'react'
import { FindBar, type FindState } from '../design-system/find/FindBar'
import { useDomFind } from '../design-system/find/useDomFind'

/**
 * A busca da tela (Ctrl+F / Cmd+F fora de um editor): procura no texto do módulo ativo ou da
 * documentação aberta, como o localizar do navegador, numa barra flutuante no canto da área
 * principal. Os editores e o corpo da resposta têm a busca deles, que vale quando o foco está neles.
 */
export function PageFind(props: {
  root: HTMLElement | null
  state: FindState
  onChange: (state: FindState) => void
  onClose: () => void
  /** Muda a cada Ctrl+F: com a barra já aberta, volta o foco ao campo com o termo selecionado. */
  focusSignal: number
}) {
  const { count, current } = useDomFind(props.root, props.state)
  const input = useRef<HTMLInputElement>(null)
  // Quem chamou a busca recebe o foco de volta ao fechar.
  const returnTo = useRef<Element | null>(null)
  useEffect(() => {
    returnTo.current = document.activeElement
  }, [])
  useEffect(() => {
    input.current?.select()
  }, [props.focusSignal])

  return (
    <div className="absolute top-[3.25rem] right-4 z-30 w-[min(28rem,calc(100%-2rem))] overflow-hidden rounded-[var(--radius-card)] border border-border bg-elevated shadow-[var(--shadow-overlay)]">
      <FindBar
        label="Buscar na tela"
        className="border-b-0"
        state={props.state}
        onChange={props.onChange}
        onClose={() => {
          props.onClose()
          if (returnTo.current instanceof HTMLElement) returnTo.current.focus()
        }}
        count={count}
        current={current}
        inputRef={input}
      />
    </div>
  )
}
