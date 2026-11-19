import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert, CircleSlash, Loader2, ShieldBan, Unplug, Wrench, X } from 'lucide-react'
import { cx } from '../cx'
import type { FailureKind } from '../feedback/errors'

export type Outcome = 'passed' | 'failed' | 'error'

const outcomeStyle: Record<Outcome, string> = {
  passed: 'border-success/35 bg-success/10 text-success',
  failed: 'border-danger/35 bg-danger/10 text-danger',
  // Não rodou (configuração, rede): a mesma cor dos erros nos outros módulos, sem preenchimento
  // para não se confundir com a asserção que falhou.
  error: 'border-danger/50 border-dashed bg-transparent text-danger'
}

const outcomeIcon = { passed: Check, failed: X, error: CircleAlert }

/**
 * Quem não chegou a ter resposta, pelo motivo: rede em vermelho tracejado,
 * configuração em amarelo, política em azul com o escudo. A asserção que falhou é o vermelho cheio.
 */
const kindStyle: Partial<Record<FailureKind, string>> = {
  transport: outcomeStyle.error,
  config: 'border-warning/60 border-dashed bg-transparent text-warning',
  policy: 'border-info/50 bg-info/10 text-info',
  canceled: 'border-border border-dashed bg-transparent text-muted'
}
const kindIcon = { assertion: X, transport: Unplug, config: Wrench, policy: ShieldBan, canceled: CircleSlash }

/**
 * Célula de resultado (Tests, histórico, nós de fluxo): ícone e texto além da cor, botão quando
 * abre o detalhe. Sem resultado mostra um traço; em execução, o indicador de andamento.
 */
export function OutcomeCell(props: {
  outcome?: Outcome
  pending?: boolean
  text?: string
  label: string
  title?: string
  active?: boolean
  onClick?: () => void
  /** Com outcome "error": por que não rodou (rede, configuração, política). */
  kind?: FailureKind
}) {
  if (props.pending)
    return (
      <span className="inline-flex items-center text-muted" aria-label={`${props.label}: rodando`}>
        <Loader2 size={14} className="animate-spin" aria-hidden />
      </span>
    )
  if (!props.outcome) return <span className="text-faint">—</span>
  const kind = props.outcome === 'error' ? props.kind : undefined
  const Icon = kind ? kindIcon[kind] : outcomeIcon[props.outcome]
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.onClick ? props.active : undefined}
      onClick={props.onClick}
      title={props.title}
      className={cx(
        'inline-flex min-w-20 items-center justify-center gap-1 rounded border px-2 py-0.5 font-mono text-xs',
        (kind && kindStyle[kind]) || outcomeStyle[props.outcome],
        props.active && 'ring-1 ring-accent'
      )}
    >
      <Icon size={12} aria-hidden />
      {props.text}
    </button>
  )
}

/** Totais de uma execução em lote, com texto além da cor. */
export function OutcomeTotals(props: {
  passed: number
  failed: number
  error: number
  children?: ReactNode
  dim?: boolean
}) {
  return (
    <div
      className={cx('flex flex-wrap items-center gap-3 font-mono text-xs', props.dim && 'opacity-60')}
      aria-label="Resumo da execução"
    >
      <span className="flex items-center gap-1 text-success">
        <Check size={12} aria-hidden />
        {props.passed} passaram
      </span>
      <span className={cx('flex items-center gap-1', props.failed ? 'text-danger' : 'text-muted')}>
        <X size={12} aria-hidden />
        {props.failed} falharam
      </span>
      <span className={cx('flex items-center gap-1', props.error ? 'text-danger' : 'text-muted')}>
        <CircleAlert size={12} aria-hidden />
        {props.error} com erro
      </span>
      {props.children}
    </div>
  )
}

export interface AssertionRow {
  passed: boolean
  label: string
  message: string
}

/** Valor de uma asserção como aparece lado a lado: texto entre aspas, o resto em JSON. */
function showValue(value: unknown): string {
  if (value === undefined) return '(ausente)'
  if (typeof value === 'string') return JSON.stringify(value)
  return JSON.stringify(value, null, 2) ?? String(value)
}

/**
 * A primeira asserção que falhou, em destaque: o alvo e o operador, esperado e
 * recebido lado a lado e a mensagem do motor. As outras ficam recolhidas em "Ver todas".
 */
export function FailedAssertion(props: { label: string; expected: unknown; actual: unknown; message: string; showExpected?: boolean }) {
  return (
    <div role="group" aria-label="Primeira asserção que falhou" className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-danger/35 bg-danger/10 p-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-danger">
        <X size={12} aria-hidden />
        <span className="font-mono">{props.label}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {props.showExpected !== false && (
          <div className="min-w-0">
            <div className="text-[10px] font-medium tracking-wider text-muted uppercase">Esperado</div>
            <pre aria-label="Esperado" className="mt-0.5 max-h-40 overflow-auto rounded border border-border-subtle bg-elevated p-1.5 font-mono break-all whitespace-pre-wrap text-fg">
              {showValue(props.expected)}
            </pre>
          </div>
        )}
        <div className={cx('min-w-0', props.showExpected === false && 'col-span-2')}>
          <div className="text-[10px] font-medium tracking-wider text-muted uppercase">Recebido</div>
          <pre aria-label="Recebido" className="mt-0.5 max-h-40 overflow-auto rounded border border-danger/35 bg-elevated p-1.5 font-mono break-all whitespace-pre-wrap text-danger">
            {showValue(props.actual)}
          </pre>
        </div>
      </div>
      <p className="text-fg/90">{props.message}</p>
    </div>
  )
}

/** Lista recolhível: começa fechada quando há uma falha em destaque acima dela. */
export function Collapsible(props: { label: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 py-1 text-xs text-muted hover:text-fg"
      >
        <Chevron size={12} aria-hidden />
        {props.label}
      </button>
      {open && props.children}
    </div>
  )
}

/** Asserções de um resultado: alvo e operador, e a mensagem com esperado e recebido. */
export function AssertionList({ rows }: { rows: AssertionRow[] }) {
  return (
    <table className="w-full font-mono text-xs" aria-label="Asserções">
      <tbody>
        {rows.map((a, i) => (
          <tr key={i} className="border-b border-border-subtle align-top last:border-b-0">
            <td className={cx('w-5 py-1', a.passed ? 'text-success' : 'text-danger')}>
              {a.passed ? <Check size={12} aria-label="passou" /> : <X size={12} aria-label="falhou" />}
            </td>
            <td className="w-2/5 py-1 pr-3 text-muted">{a.label}</td>
            <td className={cx('py-1 break-all', !a.passed && 'text-danger')}>{a.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Classes da tabela densa do design system (cabeçalho fixo, linhas de 32 px). */
export const table = {
  root: 'w-full border-collapse text-xs',
  head: 'sticky top-0 z-[1] bg-panel text-left text-[11px] text-muted',
  th: 'px-3 py-2 font-medium',
  row: 'border-t border-border-subtle align-top hover:bg-elevated/50',
  group: 'border-t border-border bg-elevated/60',
  td: 'px-3 py-2'
}
