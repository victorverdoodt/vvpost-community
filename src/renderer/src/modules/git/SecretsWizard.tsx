import { useMemo, useState } from 'react'
import type { MissingSecret, WorkspaceState } from '@shared/ipc'
import { buttonClass as buttonClassFor } from '../../design-system'

const buttonClass = buttonClassFor('secondary', 'md')
const primaryClass = buttonClassFor('primary', 'md')

/**
 * Wizard de onboarding: um passo por ambiente com segredos pendentes. Os valores
 * vão direto para o arquivo local de segredos no main process e nunca voltam.
 */
export function SecretsWizard(props: {
  missing: MissingSecret[]
  onDone: (state: WorkspaceState | null, error?: string) => void
}) {
  const steps = useMemo(() => {
    const byEnv = new Map<string, MissingSecret[]>()
    for (const m of props.missing) byEnv.set(m.environmentId, [...(byEnv.get(m.environmentId) ?? []), m])
    return [...byEnv.values()]
  }, [props.missing])
  const [step, setStep] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)

  const key = (m: MissingSecret) => `${m.environmentId}\u0000${m.variable}`
  const current = steps[step] ?? []
  const last = step === steps.length - 1
  const filled = props.missing.filter((m) => values[key(m)]).length

  const finish = async () => {
    setBusy(true)
    try {
      const payload = props.missing
        .filter((m) => values[key(m)])
        .map((m) => ({ environmentId: m.environmentId, variable: m.variable, value: values[key(m)]! }))
      if (payload.length === 0) return props.onDone(null)
      const result = await window.vvpost.saveSecrets(payload)
      setValues({})
      props.onDone(result.ok ? result.value : null, result.ok ? undefined : result.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/80 p-6">
      <div
        role="dialog"
        aria-label="Configurar segredos"
        className="flex max-h-full w-full max-w-xl flex-col rounded-lg border border-border bg-panel shadow-xl"
      >
        <header className="border-b border-border px-5 py-4">
          <div className="text-xs text-muted">
            Passo {step + 1} de {steps.length}
          </div>
          <h2 className="mt-1 text-base font-semibold">Segredos de {current[0]?.environmentName}</h2>
          <p className="mt-1 text-xs text-muted">
            Este workspace usa segredos que não vão para o Git. Os valores ficam só nesta máquina, em{' '}
            cofre local, cifrado e fora da pasta do projeto. Deixe em branco para preencher depois.
          </p>
        </header>
        <div className="flex min-h-0 flex-col gap-4 overflow-auto px-5 py-4">
          {current.map((m) => (
            <label key={key(m)} className="flex flex-col gap-1">
              <span className="font-mono text-sm">{m.variable}</span>
              {m.description && <span className="text-xs text-muted">{m.description}</span>}
              <input
                type={reveal ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                placeholder={m.placeholder ?? 'Valor do segredo'}
                value={values[key(m)] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [key(m)]: e.target.value }))}
                className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
              />
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
            Mostrar valores
          </label>
        </div>
        <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
          <span className="text-xs text-muted">
            {filled} de {props.missing.length} preenchido(s)
          </span>
          <div className="ml-auto flex gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => props.onDone(null)}>
              Depois
            </button>
            {step > 0 && (
              <button type="button" className={buttonClass} disabled={busy} onClick={() => setStep(step - 1)}>
                Voltar
              </button>
            )}
            {last ? (
              <button type="button" className={primaryClass} disabled={busy} onClick={() => void finish()}>
                Concluir
              </button>
            ) : (
              <button type="button" className={primaryClass} onClick={() => setStep(step + 1)}>
                Próximo
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
