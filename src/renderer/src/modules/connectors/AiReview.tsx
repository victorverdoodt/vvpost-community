import { useCallback, useEffect, useState } from 'react'
import { Bot, Check, ChevronRight } from 'lucide-react'
import type { AiReviewItem } from '@shared/ipc'
import { Badge, Button, cx } from '../../design-system'
import { WORKSPACE_CHANGED } from '../../panels/useWorkspace'

/**
 * Alterações que a IA fez pelo MCP e que esperam o usuário (docs/mcp.md, "Regras da
 * escrita pela IA"): auth e destino de conectores e código de fluxos. Até a revisão, a
 * IA só monta as requisições deles. Antes, revisar era salvar cada conector no editor
 * ou rodar --approve-review no terminal; aqui o usuário vê o que confirma e aprova.
 * Com a política do agente da organização mandando aprovar no console do Control Plane,
 * o app só mostra o que espera e o pedido aberto lá.
 */
export function AiReviewBanner(props: {
  onOpenConnector: (id: string) => void
  onApproved: () => void
  /** Sem alterações pendentes: o texto que aparece no lugar (no Catálogo, nada aparece). */
  emptyText?: string
}) {
  const [items, setItems] = useState<AiReviewItem[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.vvpost.listAiReview().then((r) => {
      if (r.ok) setItems(r.value)
      else setError(r.message)
    })
  }, [])

  useEffect(() => {
    reload()
    window.addEventListener('focus', reload)
    window.addEventListener(WORKSPACE_CHANGED, reload)
    return () => {
      window.removeEventListener('focus', reload)
      window.removeEventListener(WORKSPACE_CHANGED, reload)
    }
  }, [reload])

  const approve = (keys?: string[]) =>
    void window.vvpost.approveAiReview(keys).then((r) => {
      if (!r.ok) return setError(r.message)
      setError(null)
      reload()
      props.onApproved()
    })

  if (!items.length) return props.emptyText ? <p className="px-4 py-2 text-xs text-muted">{props.emptyText}</p> : null
  const central = items.some((i) => i.central)
  const requests = [...new Set(items.map((i) => i.request).filter((r): r is number => r !== undefined))]
  return (
    <section aria-label="Alterações da IA para revisar" className="shrink-0 border-b border-border bg-warning/5 px-4 py-2 text-xs">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-fg"
        >
          <ChevronRight size={12} className={cx('shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
          <Bot size={14} className="shrink-0 text-warning" aria-hidden />
          <span className="truncate">
            {items.length === 1 ? '1 alteração feita pela IA aguarda' : `${items.length} alterações feitas pela IA aguardam`}{' '}
            {central
              ? `aprovação no console do Control Plane${requests.length ? ` (pedido ${requests.map((r) => `#${r}`).join(', ')})` : ''}, como manda a política da organização.`
              : 'sua revisão.'}{' '}
            Até lá, a IA só monta as requisições, sem disparar.
          </span>
        </button>
        {!central && (
          <Button size="sm" variant="primary" icon={<Check size={14} aria-hidden />} onClick={() => approve()}>
            Aprovar todas
          </Button>
        )}
      </div>
      {error && <p className="mt-1 text-danger">{error}</p>}
      {open && (
        <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-auto">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-2 rounded-[var(--radius-control)] bg-surface px-2 py-1.5">
              <Badge tone={item.kind === 'flow' ? 'info' : 'warning'}>{item.kind === 'flow' ? 'fluxo' : 'conector'}</Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-fg" title={item.id}>
                  {item.name ?? item.id}
                </p>
                <p className="truncate text-muted" title={item.reason}>
                  {item.reason ?? (item.kind === 'flow' ? 'nós de código escritos pela IA' : 'auth, destino ou credenciais alterados pela IA')}
                  {' · '}
                  {new Date(item.at).toLocaleString('pt-BR')}
                </p>
              </div>
              {item.kind === 'connector' && (
                <Button size="sm" onClick={() => props.onOpenConnector(item.id)}>
                  Ver
                </Button>
              )}
              {!central && (
                <Button size="sm" onClick={() => approve([item.key])}>
                  Aprovar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
