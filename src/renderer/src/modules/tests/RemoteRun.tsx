import { useCallback, useEffect, useRef, useState } from 'react'
import { Server, X } from 'lucide-react'
import type { RemoteRun, RemoteRunPreview, RemoteRunSelection, RemoteRunStatus, RemoteRunTarget, ScenarioRunReport } from '@shared/ipc'
import { Badge, Button, IconButton, useToast, type Tone } from '../../design-system'

const POLL_MS = 1000
const MAX_LINES = 500
const FINAL: ReadonlySet<RemoteRunStatus> = new Set(['passed', 'failed', 'error', 'canceled', 'lost'])

const STATUS: Record<RemoteRunStatus, { label: string; tone: Tone }> = {
  queued: { label: 'na fila', tone: 'neutral' },
  running: { label: 'rodando', tone: 'info' },
  passed: { label: 'passou', tone: 'success' },
  failed: { label: 'falhou', tone: 'danger' },
  error: { label: 'erro', tone: 'danger' },
  canceled: { label: 'cancelada', tone: 'warning' },
  lost: { label: 'runner sumiu', tone: 'warning' }
}

/** Projeto do Control Plane para execuções remotas; null sem VVPost Enterprise com Control Plane. */
export function useRemoteRunTarget(): RemoteRunTarget | null {
  const [target, setTarget] = useState<RemoteRunTarget | null>(null)
  useEffect(() => {
    const load = () => void window.vvpost.getRemoteRunTarget().then(setTarget)
    load()
    // O login acontece pela barra de status (Cloud Proxy): ao voltar para a janela, confere de novo.
    window.addEventListener('focus', load)
    const timer = setInterval(load, 10_000)
    return () => {
      window.removeEventListener('focus', load)
      clearInterval(timer)
    }
  }, [])
  return target
}

/**
 * Execução remota num Execution Runner: envia o workspace aberto (sem segredos)
 * para a fila do Control Plane, acompanha a saída do CLI no runner e, no fim, entrega o
 * relatório dos cenários para a matriz, no mesmo formato de uma execução local.
 */
export function useRemoteRun(onReports: (reports: ScenarioRunReport[]) => void) {
  const notify = useToast()
  const [run, setRun] = useState<RemoteRun | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const after = useRef(0)
  const report = useRef(onReports)
  report.current = onReports

  const start = useCallback(
    async (selection: RemoteRunSelection) => {
      const res = await window.vvpost.startRemoteRun(selection)
      if (!res.ok) {
        notify(res.message, 'danger')
        return
      }
      after.current = 0
      setLines([])
      setRun(res.value)
    },
    [notify]
  )

  const active = run !== null && !FINAL.has(run.status)
  useEffect(() => {
    if (!run || !active) return
    let stopped = false
    const tick = async () => {
      const res = await window.vvpost.pollRemoteRun(run.id, after.current)
      if (stopped) return
      if (!res.ok) {
        notify(res.message, 'danger')
        return
      }
      const { events, report: final } = res.value
      if (events.length) {
        after.current = events[events.length - 1]!.seq
        const fresh = events.flatMap((e) => (e.kind === 'log' && Array.isArray(e.data['lines']) ? (e.data['lines'] as unknown[]).map(String) : []))
        if (fresh.length) setLines((prev) => [...prev, ...fresh].slice(-MAX_LINES))
      }
      if (FINAL.has(res.value.run.status) && final?.scenarios) report.current(final.scenarios)
      setRun(res.value.run)
    }
    const timer = setInterval(() => void tick(), POLL_MS)
    void tick()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [run?.id, active, notify])

  const cancel = useCallback(async () => {
    if (!run) return
    const res = await window.vvpost.cancelRemoteRun(run.id)
    if (!res.ok) notify(res.message, 'danger')
    else setRun(res.value)
  }, [run, notify])

  return { run, lines, active, start, cancel, dismiss: () => setRun(null) }
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`)

/**
 * O texto da confirmação antes de enviar: destino, projeto, ambientes, conectores e o
 * contexto de segredos, só com nomes.
 */
export function describeRemoteRun(p: RemoteRunPreview, scope: string): string {
  const envs = p.environments.length
    ? p.environments
        .map((e) => (e.secrets.length ? `${e.name} (segredos resolvidos no runner: ${e.secrets.join(', ')})` : `${e.name} (sem segredos)`))
        .join('; ')
    : 'nenhum (o runner roda sem --env)'
  return [
    `Destino: Execution Runner de ${p.source}.`,
    `Projeto: ${p.workspace}, ${p.files} ${p.files === 1 ? 'arquivo' : 'arquivos'} (${kb(p.bytes)})${p.compartilhado ? `, ${p.compartilhado} do Compartilhado` : ''}${p.otherProjects ? `, ${p.otherProjects} de outros projetos` : ''}${p.shared ? `, ${p.shared} do catálogo da organização` : ''}.`,
    `Ambientes: ${envs}.`,
    `Conectores: ${p.connectors.map((c) => c.name).join(', ') || 'nenhum'}. Escopo: ${scope}.`,
    'Os valores dos segredos não saem desta máquina: no runner, eles vêm do broker de segredos ou do próprio runner.'
  ].join('\n')
}

/** Botão da barra dos testes: dispara no runner; sem sessão, explica como entrar. */
export function RemoteRunButton(props: { target: RemoteRunTarget; disabled: boolean; onClick: () => void }) {
  const { target } = props
  return (
    <Button
      icon={<Server size={14} aria-hidden />}
      disabled={props.disabled || !target.signedIn}
      onClick={props.onClick}
      title={
        target.signedIn
          ? `Rodar no Execution Runner do projeto ${target.source}: o workspace vai sem segredos, e os valores vêm do runner ou do broker.`
          : (target.hint ?? 'Entre no Control Plane para rodar nos runners.')
      }
    >
      Rodar no runner
    </Button>
  )
}

/** Faixa com o estado da execução remota, a saída do CLI no runner e o cancelamento. */
export function RemoteRunStrip(props: {
  run: RemoteRun
  lines: string[]
  active: boolean
  source: string
  onCancel: () => void
  onDismiss: () => void
}) {
  const { run } = props
  const [open, setOpen] = useState(true)
  const log = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [props.lines.length, open])
  const status = STATUS[run.status]
  return (
    <section aria-label="Execução remota" className="shrink-0 border-b border-border-subtle px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Server size={13} className="text-muted" aria-hidden />
        <span className="text-fg">Runner</span>
        <span className="font-mono text-muted">#{run.id}</span>
        <Badge tone={status.tone}>{run.cancelRequested && props.active ? 'cancelando' : status.label}</Badge>
        <span className="truncate text-muted" title={`Control Plane ${props.source}`}>
          {props.source}
        </span>
        {run.exitCode !== null && <span className="font-mono text-muted">código {run.exitCode}</span>}
        {run.error && <span className="truncate text-danger" title={run.error}>{run.error}</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Ocultar saída' : `Ver saída (${props.lines.length})`}
          </Button>
          {props.active ? (
            <Button size="sm" variant="danger" disabled={run.cancelRequested} onClick={props.onCancel}>
              Cancelar no runner
            </Button>
          ) : (
            <IconButton label="Fechar execução remota" onClick={props.onDismiss}>
              <X size={13} aria-hidden />
            </IconButton>
          )}
        </div>
      </div>
      {open && (
        <pre
          ref={log}
          role="log"
          aria-label="Saída do CLI no runner"
          tabIndex={0}
          className="mt-2 max-h-40 overflow-auto rounded-[var(--radius-control)] border border-border-subtle bg-surface p-2 font-mono text-[11px] leading-4 text-muted"
        >
          {props.lines.length ? props.lines.join('\n') : props.active ? 'Esperando o runner…' : '(sem saída)'}
        </pre>
      )}
    </section>
  )
}
