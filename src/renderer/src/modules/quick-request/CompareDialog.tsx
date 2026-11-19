import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { HttpResult } from '@shared/ipc'
import { formatMs, IconButton } from '../../design-system'
import { DiffView } from '../git/DiffView'

const describe = (r: HttpResult) =>
  r.ok ? `${r.response.status} ${r.response.statusText} · ${formatMs(r.response.timings.totalMs)}` : r.error.code

const bodyOf = (r: HttpResult) => (r.ok ? r.response.body : `${r.error.code}: ${r.error.message}`)

/** "Comparar com a resposta anterior": o corpo das duas respostas da aba, lado a lado. */
export function CompareDialog(props: { before: HttpResult; after: HttpResult; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => close.current?.focus(), [])
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-8" onMouseDown={props.onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Comparar respostas"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
        className="flex max-h-full w-[min(64rem,95vw)] flex-col overflow-hidden rounded-[var(--radius-card)] bg-panel shadow-[var(--shadow-overlay)]"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <span className="font-semibold">Comparar com a resposta anterior</span>
          <span className="flex-1" />
          <IconButton ref={close} label="Fechar" onClick={props.onClose}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
        <DiffView
          diff={{ path: 'resposta', before: bodyOf(props.before), after: bodyOf(props.after) }}
          labels={[`Anterior · ${describe(props.before)}`, `Atual · ${describe(props.after)}`]}
        />
      </div>
    </div>
  )
}
