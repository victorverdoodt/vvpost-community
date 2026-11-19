import { useEffect, useState } from 'react'
import { RefreshCw, Wand2 } from 'lucide-react'
import type { LintFindingView, LintReport } from '@shared/ipc'
import { cx, IconButton, InspectorSection, usePromptDialog } from '../../design-system'
import { navigate } from '../../lib/navigate'
import { openDoc } from '../../app/workspace/docs'

const TONE: Record<LintFindingView['severity'], string> = { error: 'text-danger', warn: 'text-warning', info: 'text-info', hint: 'text-muted' }
const LABEL: Record<LintFindingView['severity'], string> = { error: 'erro', warn: 'aviso', info: 'info', hint: 'dica' }
const SHOWN = 100

/**
 * Painel de problemas do lint (docs/lint.md) no Inspector do Catálogo: as regras do ruleset do time
 * (.vvpost/ruleset.yaml) ou do vvpost:recommended, com ir para o conector, endpoint, cenário,
 * ambiente, fluxo ou página (o C4 que ficou velho, a citação que sumiu) de cada achado. Relê
 * junto com o catálogo (`version`).
 */
export function LintPanel(props: { version: number; onSelectEndpoint: (connectorId: string, endpointId?: string) => void }) {
  const [report, setReport] = useState<LintReport | null>(null)
  const [error, setError] = useState('')
  const [runs, setRuns] = useState(0)
  const [fixing, setFixing] = useState(false)
  const dialog = usePromptDialog()

  useEffect(() => {
    let live = true
    void window.vvpost.lintWorkspace().then((r) => {
      if (!live) return
      if (r.ok) {
        setReport(r.value)
        setError('')
      } else setError(r.message)
    })
    return () => void (live = false)
  }, [props.version, runs])

  if (!report && !error) return null
  const findings = report?.findings ?? []
  const s = report?.summary

  const go = (f: LintFindingView) => {
    const t = f.target
    if (!t) return
    if (t.kind === 'connector') props.onSelectEndpoint(t.connectorId)
    else if (t.kind === 'endpoint') props.onSelectEndpoint(t.connectorId, t.endpointId)
    else if (t.kind === 'scenario') navigate({ module: 'scenarios', connectorId: t.connectorId, endpointId: t.endpointId, scenarioId: t.scenarioId, action: 'edit' })
    else if (t.kind === 'environment') navigate({ module: 'secrets', environmentId: t.environmentId, ...(t.variable && { variable: t.variable }) })
    else if (t.kind === 'flow') navigate({ module: 'flows', flowId: t.flowId, file: t.file })
    else openDoc(/\.mmd$/i.test(t.file) ? { kind: 'diagram', file: t.file } : { kind: 'markdown', file: t.file })
  }

  // Os diagramas de arquitetura que divergem do catálogo: o VVPost mostra o plano e grava com confirmação.
  const fixDiagrams = async () => {
    setFixing(true)
    try {
      const plan = await window.vvpost.fixDiagrams(false)
      if (!plan.ok) return setError(plan.message)
      if (!plan.value?.total) return setRuns((n) => n + 1)
      const summary = plan.value.files
        .map((f) => [`${f.file}:`, ...f.removed.map((l) => `- ${l.trim()}`), ...f.added.map((l) => `+ ${l.trim()}`)].join('\n'))
        .join('\n\n')
      const ok = await dialog.confirm({ title: `Corrigir ${plan.value.total} divergência(s) nos diagramas?`, message: summary, confirmLabel: 'Corrigir' })
      if (!ok) return
      const done = await window.vvpost.fixDiagrams(true)
      if (!done.ok) setError(done.message)
      setRuns((n) => n + 1)
    } finally {
      setFixing(false)
    }
  }

  return (
    <>
      {dialog.element}
      <InspectorSection
        title="Lint"
        count={findings.length}
        defaultOpen={(s?.error ?? 0) > 0}
        actions={
          <>
            {(report?.fixable ?? 0) > 0 && (
              <IconButton label={`Corrigir os diagramas (${report!.fixable})`} onClick={() => void fixDiagrams()} disabled={fixing}>
                <Wand2 size={12} aria-hidden />
              </IconButton>
            )}
            <IconButton label="Rodar o lint de novo" onClick={() => setRuns((n) => n + 1)}>
              <RefreshCw size={12} aria-hidden />
            </IconButton>
          </>
        }
      >
        <div className="flex flex-col gap-1.5 text-xs">
          {error && <p className="text-danger">{error}</p>}
          {report && (
            <p className="text-muted">
              {s!.error} erros, {s!.warn} avisos, {s!.info} infos · {report.ruleset ?? 'vvpost:recommended'}
            </p>
          )}
          {report?.issues.map((issue, n) => (
            <p key={`i${n}`} className="text-warning">
              {issue}
            </p>
          ))}
          {findings.slice(0, SHOWN).map((f, n) => (
            <button
              key={n}
              type="button"
              onClick={() => go(f)}
              disabled={!f.target}
              title={f.hint ?? f.message}
              className="flex flex-col items-start rounded px-1 py-0.5 text-left hover:bg-border/60 disabled:hover:bg-transparent"
            >
              <span>
                <span className={cx('font-medium', TONE[f.severity])}>{LABEL[f.severity]}</span> <span className="font-mono text-muted">{f.code}</span>
              </span>
              <span className="text-fg">
                {f.label ? `${f.label}: ` : ''}
                {f.message}
              </span>
              <span className="font-mono text-[10px] text-muted">
                {f.file}
                {f.line !== undefined ? `:${f.line}` : ''}
              </span>
            </button>
          ))}
          {findings.length > SHOWN && <p className="text-muted">e mais {findings.length - SHOWN}: vvpost lint mostra todos</p>}
        </div>
      </InspectorSection>
    </>
  )
}
