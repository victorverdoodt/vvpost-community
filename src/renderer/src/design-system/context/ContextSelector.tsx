import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cx } from '../cx'

export interface ContextField {
  /** Rótulo curto em caixa alta acima do campo (CONECTOR, AMBIENTE). */
  label: string
  ariaLabel: string
  value: string
  options: { value: string; label: string; disabled?: boolean }[]
  onChange: (value: string) => void
  /** Chamado ao focar, para reler o workspace antes de abrir a lista. */
  onFocus?: () => void
  icon?: ReactNode
  /** Ponto colorido do ambiente/escopo (verde: pronto, amarelo: incompleto). */
  status?: 'ok' | 'warn' | 'error'
  disabled?: boolean
  width?: string
}

const dots = { ok: 'bg-success', warn: 'bg-warning', error: 'bg-danger' }

/**
 * Conector, ambiente e escopo atual de um módulo (Quick, Tests, Connectors). Os campos são
 * selects nativos (teclado e leitores de tela de graça) vestidos com o visual do design system.
 */
export function ContextSelector(props: {
  fields: ContextField[]
  children?: ReactNode
  label?: string
  /** Janela baixa: sem os rótulos acima dos campos (o nome fica na dica) e campos que encolhem numa linha. */
  compact?: boolean
}) {
  return (
    <div
      role="group"
      aria-label={props.label ?? 'Contexto'}
      className={cx('flex min-w-0 flex-wrap items-end', props.compact ? 'gap-2' : 'gap-3')}
    >
      {props.fields.map((f) => (
        <label
          key={f.ariaLabel}
          title={props.compact ? f.label : undefined}
          className={cx(
            'flex min-w-0 flex-col gap-1',
            props.compact ? 'max-w-56 min-w-28 flex-1 basis-36' : (f.width ?? 'w-56')
          )}
        >
          <span
            className={cx('text-[10px] font-medium tracking-wider text-muted uppercase', props.compact && 'sr-only')}
          >
            {f.label}
          </span>
          <span className="relative flex items-center">
            {(f.icon || f.status) && (
              <span className="pointer-events-none absolute left-2 flex items-center text-muted">
                {f.status ? <span aria-hidden className={`h-2 w-2 rounded-full ${dots[f.status]}`} /> : f.icon}
              </span>
            )}
            <select
              aria-label={f.ariaLabel}
              value={f.value}
              disabled={f.disabled}
              onFocus={f.onFocus}
              onChange={(e) => f.onChange(e.target.value)}
              className={cx(
                'h-8 w-full appearance-none truncate border bg-elevated pr-7 text-xs disabled:opacity-50',
                f.icon || f.status ? 'pl-7' : 'pl-2.5'
              )}
            >
              {f.options.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-2 text-muted" />
          </span>
        </label>
      ))}
      {props.children}
    </div>
  )
}
