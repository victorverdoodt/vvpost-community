import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../primitives/Button'

interface Ask {
  title: string
  message?: string
  /** Com `label`, pede um texto (renomear, novo nome); sem, só confirma. */
  label?: string
  initial?: string
  confirmLabel: string
  danger?: boolean
  /** Motivo para recusar o texto (aparece embaixo do campo). */
  validate?: (value: string) => string | undefined
  resolve: (value: string | null) => void
}

/**
 * Diálogo de confirmação e de texto dos menus de contexto (renomear, excluir, descartar).
 * `const dialog = usePromptDialog()`; `await dialog.confirm({...})` ou `await dialog.prompt({...})`
 * e `{dialog.element}` no componente. Enter confirma, Esc cancela, o foco volta para quem abriu.
 */
export function usePromptDialog() {
  const [ask, setAsk] = useState<Ask | null>(null)

  const prompt = useCallback(
    (a: Omit<Ask, 'resolve' | 'confirmLabel'> & { label: string; confirmLabel?: string }) =>
      new Promise<string | null>((resolve) => setAsk({ confirmLabel: 'Salvar', ...a, resolve })),
    []
  )
  const confirm = useCallback(
    (a: Omit<Ask, 'resolve' | 'label' | 'initial' | 'validate'>) =>
      new Promise<boolean>((resolve) => setAsk({ ...a, resolve: (v) => resolve(v !== null) })),
    []
  )

  const element = ask ? (
    <PromptDialog
      ask={ask}
      onDone={(value) => {
        setAsk(null)
        ask.resolve(value)
      }}
    />
  ) : null
  return { prompt, confirm, element }
}

function PromptDialog({ ask, onDone }: { ask: Ask; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(ask.initial ?? '')
  const input = useRef<HTMLInputElement>(null)
  const ok = useRef<HTMLButtonElement>(null)
  const restore = useRef(document.activeElement as HTMLElement | null)
  const problem = ask.label !== undefined ? (value.trim() ? ask.validate?.(value.trim()) : 'Preencha o campo.') : undefined

  useEffect(() => {
    if (input.current) {
      input.current.focus()
      input.current.select()
    } else ok.current?.focus()
    const back = restore.current
    return () => back?.focus()
  }, [])

  const submit = () => {
    if (problem) return
    onDone(ask.label !== undefined ? value.trim() : '')
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[18vh]" onMouseDown={() => onDone(null)}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={ask.title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onDone(null)
          }
        }}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="flex w-[min(28rem,90vw)] flex-col gap-3 rounded-[var(--radius-card)] bg-elevated p-4 text-xs shadow-[var(--shadow-overlay)]"
      >
        <h2 className="text-[13px] font-semibold text-fg">{ask.title}</h2>
        {ask.message && <p className="whitespace-pre-line text-muted">{ask.message}</p>}
        {ask.label !== undefined && (
          <label className="flex flex-col gap-1">
            <span className="text-muted">{ask.label}</span>
            <input
              ref={input}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={!!problem}
              spellCheck={false}
              className="h-8 border px-2 font-mono"
            />
            {problem && value.trim() && <span className="text-danger">{problem}</span>}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => onDone(null)}>
            Cancelar
          </Button>
          <Button ref={ok} type="submit" size="sm" variant={ask.danger ? 'danger' : 'primary'} disabled={!!problem}>
            {ask.confirmLabel}
          </Button>
        </div>
      </form>
    </div>
  )
}
