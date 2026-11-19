import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/**
 * Seção recolhível do InspectorPanel (Authentication, Inherited, Headers...). O estado de
 * aberta/fechada é local; o conteúdo continua montado para não perder seleção nem rolagem.
 */
export function InspectorSection(props: {
  title: string
  count?: number
  actions?: ReactNode
  defaultOpen?: boolean
  /** Âncora para rolar até a seção (ex.: "Inspecionar resposta"). */
  id?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  return (
    <section id={props.id} className="border-b border-border-subtle last:border-b-0">
      <div className="flex h-8 items-center gap-1 px-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium text-fg"
        >
          {open ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
          <span className="truncate">{props.title}</span>
          {props.count !== undefined && <span className="text-muted">({props.count})</span>}
        </button>
        {props.actions}
      </div>
      <div hidden={!open} className="px-3 pb-3">
        {props.children}
      </div>
    </section>
  )
}

/** Linha chave/valor das seções do inspector. */
export function Field(props: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr_auto] items-baseline gap-2 py-1 text-xs">
      <span className="truncate text-muted">{props.label}</span>
      <span className="min-w-0 truncate text-fg">{props.children}</span>
      {props.aside ?? <span />}
    </div>
  )
}
