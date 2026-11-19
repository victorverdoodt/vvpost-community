import { useRef } from 'react'
import { cx } from '../cx'

export interface SegmentOption<T extends string> {
  value: T
  label: string
  /** Dica do segmento (o motivo, quando desabilitado). */
  title?: string
  disabled?: boolean
}

/**
 * Escolha exclusiva entre poucas opções na mesma linha (ex.: Mock/Proxy na barra de status).
 * É um radiogroup: Tab entra no selecionado e as setas trocam, pulando os desabilitados.
 */
export function SegmentedControl<T extends string>(props: {
  value: T
  onChange: (value: T) => void
  options: SegmentOption<T>[]
  label: string
  disabled?: boolean
  size?: 'xs' | 'sm'
  className?: string
}) {
  const group = useRef<HTMLDivElement>(null)
  const enabled = props.options.filter((o) => !o.disabled)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (props.disabled) return
    const i = enabled.findIndex((o) => o.value === props.value)
    let next: SegmentOption<T> | undefined
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(i + 1) % enabled.length]
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[(i - 1 + enabled.length) % enabled.length]
    if (!next || next.value === props.value) return
    e.preventDefault()
    props.onChange(next.value)
    group.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus()
  }
  const xs = props.size === 'xs'
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={props.label}
      aria-disabled={props.disabled || undefined}
      onKeyDown={onKeyDown}
      className={cx('inline-flex items-stretch rounded-[var(--radius-control)] border border-border bg-surface p-px', props.className)}
    >
      {props.options.map((o) => {
        const selected = o.value === props.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-value={o.value}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            title={o.title}
            disabled={props.disabled || o.disabled}
            onClick={() => !selected && props.onChange(o.value)}
            className={cx(
              'rounded-[calc(var(--radius-control)-1px)] font-medium whitespace-nowrap transition-colors disabled:opacity-50',
              xs ? 'px-1.5 text-[10px] leading-4' : 'h-6 px-2 text-xs',
              selected ? 'bg-border text-fg shadow-sm' : 'text-muted hover:text-fg'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
