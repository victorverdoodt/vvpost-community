import { Check, X } from 'lucide-react'
import type { ScriptUsage } from '@shared/ipc'
import { formatMs } from '../format'
import { Badge } from '../primitives/Badge'

/** Rótulo da aba de testes: "Testes (2/3)" ou "Scripts" quando nenhum teste rodou. */
export function scriptTabLabel(scripts: ScriptUsage): string {
  const passed = scripts.tests.filter((t) => t.passed).length
  return scripts.tests.length ? `Testes (${passed}/${scripts.tests.length})` : 'Scripts'
}

const origin = (from: string) => (from === 'request' ? 'da requisição' : from === 'endpoint' ? 'do endpoint' : `do conector ${from}`)

/**
 * O que os scripts pre e post fizeram (fase 13): os testes de vv.test, o erro de um script, os
 * console.log e as variáveis que ficaram para as próximas requisições.
 */
export function ScriptReport({ scripts }: { scripts: ScriptUsage }) {
  const variables = Object.entries(scripts.variables)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 text-xs" aria-label="Resultado dos scripts">
      <p className="text-muted">
        {scripts.ran.length ? `Rodaram ${scripts.ran.join(', ')} em ${formatMs(scripts.durationMs)}.` : 'Nenhum script rodou.'}
      </p>
      {scripts.error && (
        <p role="alert" className="rounded-[var(--radius-control)] border border-danger/35 bg-danger/12 px-2 py-1.5 text-danger">
          O script {scripts.error.script} falhou: {scripts.error.message}
        </p>
      )}
      {scripts.tests.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Testes">
          {scripts.tests.map((t, i) => (
            <li key={i} className="flex items-start gap-2">
              {t.passed ? (
                <Check size={14} aria-label="passou" className="mt-0.5 shrink-0 text-success" />
              ) : (
                <X size={14} aria-label="falhou" className="mt-0.5 shrink-0 text-danger" />
              )}
              <span className="min-w-0 flex-1">
                <span className="font-medium">{t.name}</span>
                {!t.passed && t.message && <span className="block text-danger">{t.message}</span>}
              </span>
              <span className="shrink-0 text-faint">{origin(t.from)}</span>
            </li>
          ))}
        </ul>
      )}
      {variables.length > 0 && (
        <section aria-label="Variáveis dos scripts">
          <h3 className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">Variáveis</h3>
          <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-0.5 font-mono">
            {variables.map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="truncate text-muted">{name}</dt>
                <dd className="truncate">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-1 text-faint">Valem como {'{{nome}}'} nas próximas requisições deste ambiente, até fechar o app.</p>
        </section>
      )}
      {scripts.logs && (
        <section aria-label="Console dos scripts">
          <h3 className="mb-1 flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted uppercase">
            Console <Badge>{scripts.logs.split('\n').length}</Badge>
          </h3>
          <pre className="overflow-auto rounded-[var(--radius-control)] bg-elevated p-2 font-mono whitespace-pre-wrap">{scripts.logs}</pre>
        </section>
      )}
    </div>
  )
}
