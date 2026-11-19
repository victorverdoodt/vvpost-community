import type { ReactNode } from 'react'
import { cx } from '../cx'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'cyan'

const tones: Record<Tone, string> = {
  neutral: 'border-border bg-elevated text-muted',
  accent: 'border-accent/35 bg-accent/12 text-accent',
  success: 'border-success/35 bg-success/12 text-success',
  warning: 'border-warning/35 bg-warning/12 text-warning',
  danger: 'border-danger/35 bg-danger/12 text-danger',
  info: 'border-info/35 bg-info/12 text-info',
  cyan: 'border-cyan/35 bg-cyan/12 text-cyan'
}

/** Cor de texto do tom, para ícones e valores soltos fora de um Badge. */
export const toneText: Record<Tone, string> = {
  neutral: 'text-muted',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  cyan: 'text-cyan'
}

export function Badge(props: { tone?: Tone; children: ReactNode; title?: string; className?: string; mono?: boolean }) {
  return (
    <span
      title={props.title}
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] leading-none font-medium whitespace-nowrap',
        props.mono && 'font-mono',
        tones[props.tone ?? 'neutral'],
        props.className
      )}
    >
      {props.children}
    </span>
  )
}

const methodTones: Record<string, Tone> = {
  GET: 'success',
  POST: 'accent',
  PUT: 'warning',
  PATCH: 'cyan',
  DELETE: 'danger',
  HEAD: 'info',
  OPTIONS: 'neutral'
}

/** Método HTTP com a cor da convenção (GET verde, POST violeta, DELETE vermelho...). */
export function MethodBadge({ method, className }: { method: string; className?: string }) {
  const m = method.toUpperCase()
  return (
    <Badge mono tone={methodTones[m] ?? 'neutral'} className={cx('justify-center', className)}>
      {m}
    </Badge>
  )
}

/** Tom de um status HTTP: 2xx sucesso, 3xx info, 4xx aviso, 5xx erro. */
export function statusTone(status: number): Tone {
  if (status >= 500) return 'danger'
  if (status >= 400) return 'warning'
  if (status >= 300) return 'info'
  if (status >= 200) return 'success'
  return 'neutral'
}

export type InheritanceKind = 'inherited' | 'overridden' | 'local' | 'missing'

const inheritance: Record<InheritanceKind, { label: string; prep: string; tone: Tone; icon: string }> = {
  inherited: { label: 'herdado', prep: 'de', tone: 'neutral', icon: '↧' },
  overridden: { label: 'sobrescreve', prep: '', tone: 'warning', icon: '↻' },
  local: { label: 'definido aqui', prep: '', tone: 'accent', icon: '•' },
  missing: { label: 'ausente', prep: 'em', tone: 'danger', icon: '!' }
}

/**
 * Origem de um valor na cascata de conectores (contrato do design system), sempre em texto além
 * da cor: "herdado de Corporate Base", "sobrescreve Corporate Base", "definido aqui" ou
 * "ausente". `from` é a origem (ou, em `overridden`, quem perdeu o valor) quando há uma.
 */
export function InheritanceBadge({ kind, from }: { kind: InheritanceKind; from?: string }) {
  const def = inheritance[kind]
  const text = from ? [def.label, def.prep, from].filter(Boolean).join(' ') : def.label
  return (
    <Badge tone={def.tone} title={text} className="max-w-full">
      <span aria-hidden>{def.icon}</span>
      <span className="truncate">{text}</span>
    </Badge>
  )
}
