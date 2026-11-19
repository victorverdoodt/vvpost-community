import { useEffect, type ReactNode } from 'react'
import { track } from '../../lib/ux-study'
import { CircleAlert, CircleSlash } from 'lucide-react'
import { cx } from '../cx'
import { Badge } from '../primitives/Badge'
import { describeError } from './errors'

/**
 * Padrão único de erro: título, causa, categoria e localização, e a
 * próxima ação. Os módulos passam o código e a mensagem do motor; a categoria, a cor e a dica vêm
 * de describeError, então o mesmo erro tem a mesma cara em todo lugar.
 */
export function ErrorNotice(props: {
  /** O que falhou, do ponto de vista do usuário ("Falha ao executar a requisição"). */
  title: string
  code: string
  /** Causa, como o motor descreveu. */
  message: string
  /** Onde: ambiente, nó, cenário, arquivo. */
  location?: string
  /** Próxima ação; sem ela, a dica padrão da categoria. */
  hint?: ReactNode
  /** Botões da próxima ação. */
  actions?: ReactNode
  compact?: boolean
  className?: string
}) {
  const d = describeError(props.code)
  // Teste com usuários: quais erros as pessoas viram, por categoria (sem a mensagem).
  useEffect(() => track('error-shown', { code: props.code, category: d.category }), [props.code, d.category])
  const Icon = d.tone === 'neutral' ? CircleSlash : CircleAlert
  return (
    <div
      role="alert"
      className={cx(
        'flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-card)] border text-xs',
        d.tone === 'neutral' ? 'border-border bg-elevated' : 'border-danger/35 bg-danger/10',
        props.compact ? 'p-2' : 'p-3',
        props.className
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Icon size={14} aria-hidden className={cx('shrink-0', d.tone === 'neutral' ? 'text-muted' : 'text-danger')} />
        <span className="font-semibold text-fg">{props.title}</span>
        <Badge tone={d.tone}>{d.category}</Badge>
        {props.location && <Badge>{props.location}</Badge>}
        <span className="font-mono text-[11px] text-faint">{props.code}</span>
      </div>
      <p className="break-words text-fg/90">{props.message}</p>
      <p className="text-muted">{props.hint ?? d.hint}</p>
      {props.actions && <div className="flex flex-wrap gap-2 pt-1">{props.actions}</div>}
    </div>
  )
}
