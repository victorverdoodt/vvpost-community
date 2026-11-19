import { useRef, type ReactNode } from 'react'
import { cx } from '../cx'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  /** Nome acessível quando o rótulo não é texto puro. */
  title?: string
  disabled?: boolean
}

/**
 * Abas internas de um painel (Params, Headers, Body...). Setas trocam de aba. `idPrefix` liga cada
 * aba ao seu painel (`${idPrefix}-panel-${id}`) quando o painel usa `TabPanel`.
 *
 * Três níveis com cara própria: as abas de requisição/arquivo são `WorkspaceTabs`
 * (barra no topo); o conteúdo que se edita usa `line` (sublinhado); a resposta, `segmented`
 * (botões preenchidos), para não confundir o que se envia com o que voltou.
 */
export function Tabs<T extends string>(props: {
  value: T
  onChange: (id: T) => void
  tabs: TabItem<T>[]
  label: string
  idPrefix?: string
  right?: ReactNode
  className?: string
  variant?: 'line' | 'segmented'
}) {
  const segmented = props.variant === 'segmented'
  const list = useRef<HTMLDivElement>(null)
  const enabled = props.tabs.filter((t) => !t.disabled)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = enabled.findIndex((t) => t.id === props.value)
    let next: TabItem<T> | undefined
    if (e.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length]
    else if (e.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length]
    if (!next) return
    e.preventDefault()
    props.onChange(next.id)
    list.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
  }
  return (
    <div className={cx('flex h-9 shrink-0 items-stretch border-b border-border px-2', props.className)}>
      <div
        ref={list}
        role="tablist"
        aria-label={props.label}
        onKeyDown={onKeyDown}
        data-variant={segmented ? 'segmented' : 'line'}
        className={cx(
          'flex',
          segmented
            ? 'my-1.5 items-center gap-0.5 rounded-[var(--radius-control)] bg-elevated p-0.5'
            : 'items-stretch gap-1'
        )}
      >
        {props.tabs.map((t) => {
          const active = t.id === props.value
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab={t.id}
              aria-selected={active}
              aria-controls={props.idPrefix ? `${props.idPrefix}-panel-${t.id}` : undefined}
              aria-label={t.title}
              tabIndex={active ? 0 : -1}
              disabled={t.disabled}
              onClick={() => props.onChange(t.id)}
              className={cx(
                'relative px-2.5 text-xs transition-colors disabled:opacity-40',
                segmented && 'h-full rounded-[calc(var(--radius-control)-2px)]',
                segmented && active && 'bg-surface font-medium shadow-sm',
                active ? 'text-fg' : 'text-muted hover:text-fg'
              )}
            >
              {t.label}
              {active && !segmented && (
                <span aria-hidden className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" />
              )}
            </button>
          )
        })}
      </div>
      {props.right && <div className="ml-auto flex min-w-0 items-center gap-3">{props.right}</div>}
    </div>
  )
}
