import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { cx } from '../cx'

export type ToastTone = 'success' | 'info' | 'warning' | 'danger'

interface ToastItem {
  id: number
  tone: ToastTone
  message: string
}

type Notify = (message: string, tone?: ToastTone) => void

const ToastContext = createContext<Notify>(() => {})

/** Confirmações, alertas e erros curtos, no canto inferior direito, acima da barra de status. */
export function useToast(): Notify {
  return useContext(ToastContext)
}

const TTL_MS = 4000
const icons = { success: CircleCheck, info: Info, warning: TriangleAlert, danger: CircleAlert }
const colors = { success: 'text-success', info: 'text-info', warning: 'text-warning', danger: 'text-danger' }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const next = useRef(1)
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), [])
  const notify = useCallback<Notify>((message, tone = 'info') => {
    const id = next.current++
    setItems((all) => [...all.slice(-3), { id, tone, message }])
  }, [])
  const value = useMemo(() => notify, [notify])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live sem role="status": os painéis usam role="status" para o próprio resultado. */}
      <div aria-live="polite" className="pointer-events-none fixed right-3 bottom-10 z-50 flex w-80 flex-col gap-2">
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, item.tone === 'danger' ? TTL_MS * 2 : TTL_MS)
    return () => clearTimeout(timer)
  }, [item, onDismiss])
  const Icon = icons[item.tone]
  return (
    <div className="pointer-events-auto flex items-start gap-2 rounded-[var(--radius-card)] bg-elevated p-3 text-xs text-fg shadow-[var(--shadow-overlay)]">
      <Icon size={16} className={cx('mt-px shrink-0', colors[item.tone])} aria-hidden />
      <p className="min-w-0 flex-1 break-words">{item.message}</p>
      <button type="button" onClick={onDismiss} aria-label="Dispensar aviso" className="text-muted hover:text-fg">
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}
