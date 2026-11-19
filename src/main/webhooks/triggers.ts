import type { WebhookHook } from '@vvpost/schemas'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import type { LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { isProtectedEnvironment } from '@vvpost/core/policy/protected'
import type { FlowCatalog, FlowRunInput, FlowRunReport, ScenarioRunInput, ScenarioRunReport, WebhookEvent, WebhookTriggerResult } from '@vvpost/core/types'
import { flowReviewKey, markUnreviewedFlows, readReviewMarks } from '../project/review'
import type { WebhookInbox } from './inbox'

/** Disparos rodando ao mesmo tempo e esperando a vez, no máximo; além disso o evento é pulado. */
export const TRIGGER_CONCURRENCY = 2
export const TRIGGER_QUEUE = 20

export interface TriggerJob {
  event: WebhookEvent
  hook: WebhookHook
  /** Ambiente da execução ("" sem ambiente). */
  environmentId: string
}

export type TriggerOutcome = Pick<WebhookTriggerResult, 'status' | 'message' | 'historyRunId'>

/**
 * Fila dos disparos dos hooks: no máximo TRIGGER_CONCURRENCY ao mesmo tempo e TRIGGER_QUEUE
 * esperando, para um remetente em rajada não empilhar execuções sem fim. O estado de cada
 * disparo fica no próprio evento (queued, running e o resultado).
 */
export function createTriggerQueue(options: {
  inbox: WebhookInbox
  /** Ambiente padrão dos disparos (o do arquivo, ou o primeiro do workspace). */
  environment: string | null
  run: (job: TriggerJob, signal: AbortSignal) => Promise<TriggerOutcome>
  concurrency?: number
  maxQueued?: number
}) {
  const { inbox } = options
  const concurrency = options.concurrency ?? TRIGGER_CONCURRENCY
  const maxQueued = options.maxQueued ?? TRIGGER_QUEUE
  const queue: TriggerJob[] = []
  const controller = new AbortController()
  let running = 0

  const set = (job: TriggerJob, patch: Partial<WebhookTriggerResult>) => {
    const t = job.hook.trigger!
    const base: WebhookTriggerResult = {
      kind: t.flow !== undefined ? 'flow' : 'scenarios',
      target: t.flow ?? t.connector ?? '',
      environmentId: job.environmentId,
      status: 'queued'
    }
    const current = inbox.get(job.event.id)?.trigger ?? base
    inbox.update(job.event.id, { trigger: { ...current, ...patch } })
  }

  const pump = () => {
    while (running < concurrency && queue.length && !controller.signal.aborted) {
      const job = queue.shift()!
      running++
      set(job, { status: 'running' })
      const start = performance.now()
      void options
        .run(job, controller.signal)
        .catch((err: Error): TriggerOutcome => ({ status: 'error', message: err.message }))
        .then((outcome) => set(job, { ...outcome, durationMs: Math.round(performance.now() - start) }))
        .finally(() => {
          running--
          pump()
        })
    }
  }

  return {
    enqueue(event: WebhookEvent, hook: WebhookHook) {
      if (!hook.trigger) return
      const environmentId = hook.trigger.environment ?? options.environment ?? ''
      const job = { event, hook, environmentId }
      if (queue.length >= maxQueued) {
        set(job, { status: 'skipped', message: `fila de disparos cheia (${maxQueued} esperando): evento não disparou` })
        return
      }
      set(job, { status: 'queued' })
      queue.push(job)
      pump()
    },
    /** Cancela o que está rodando e descarta a fila (servidor desligado). */
    close() {
      controller.abort()
      for (const job of queue.splice(0)) set(job, { status: 'skipped', message: 'servidor de webhooks desligado' })
    }
  }
}

export interface TriggerRuntime {
  workspaceDir: string
  loadWorkspace(): Promise<LoadedWorkspace>
  loadFlows(): Promise<FlowCatalog>
  runFlow(input: FlowRunInput, ws: LoadedWorkspace, opts: { signal: AbortSignal; webhookSince: number }): Promise<FlowRunReport>
  runScenarios(input: ScenarioRunInput, ws: LoadedWorkspace, signal: AbortSignal): Promise<ScenarioRunReport>
}

export interface TriggerRun extends TriggerOutcome {
  report?: { kind: 'flow'; report: FlowRunReport; name: string } | { kind: 'scenarios'; report: ScenarioRunReport; name: string }
}

/**
 * Roda o disparo de um hook pelo motor, igual no app e no CLI. Como a IA pode ter escrito o
 * fluxo ou mexido na auth de um conector, vale a mesma revisão do MCP: fluxo com
 * código não revisado, ou conector com auth ou destino alterados pela IA, não dispara.
 */
export async function runTrigger(job: TriggerJob, rt: TriggerRuntime, signal: AbortSignal): Promise<TriggerRun> {
  const t = job.hook.trigger!
  const ws = await rt.loadWorkspace()
  if (job.environmentId && !ws.environments.has(job.environmentId)) {
    return { status: 'error', message: `ambiente "${job.environmentId}" não existe no workspace` }
  }
  // Disparo sem ninguém olhando não vai a um ambiente protegido: lá, cada disparo é confirmado no app.
  const env = job.environmentId ? ws.environments.get(job.environmentId) : undefined
  if (isProtectedEnvironment(env)) {
    return { status: 'skipped', message: `"${env!.name}" é um ambiente protegido (produção): o disparo automático não roda lá. "protected": false no arquivo do ambiente libera` }
  }
  await markUnreviewedFlows(rt.workspaceDir)
  const marks = await readReviewMarks(rt.workspaceDir)
  const pendingReview = (ids: Iterable<string>) => {
    const pending = [...new Set(ids)].filter((id) => marks[id])
    return pending.length
      ? `${pending.map((id) => `"${id}"`).join(', ')} teve auth, destino ou credenciais alterados pela IA e espera a revisão no Catálogo`
      : null
  }

  if (t.flow !== undefined) {
    const found = (await rt.loadFlows()).flows.find((f) => f.flow.id === t.flow)
    if (!found) return { status: 'error', message: `fluxo "${t.flow}" não existe no workspace` }
    if (marks[flowReviewKey(found.flow.id)]) {
      return { status: 'skipped', message: `"${found.flow.id}" tem nós de código escritos ou mudados pela IA e espera a revisão no Flow Studio` }
    }
    const review = pendingReview(found.flow.nodes.flatMap((n) => (n.type === 'request' && n.request.connector ? [n.request.connector] : [])))
    if (review) return { status: 'skipped', message: review }
    const report = await rt.runFlow(
      { runId: `webhook:${job.event.id}:${found.flow.id}`, flow: found.flow, ...(job.environmentId && { environmentId: job.environmentId }) },
      ws,
      { signal, webhookSince: job.event.id }
    )
    const status = report.outcome === 'success' ? 'passed' : report.outcome === 'canceled' ? 'skipped' : report.error ? 'error' : 'failed'
    const failed = report.results.find((r) => r.status === 'error')
    return {
      status,
      ...((report.error ?? failed) && { message: report.error ?? `${failed!.name}: ${failed!.error?.message ?? 'falhou'}` }),
      report: { kind: 'flow', report, name: found.flow.name }
    }
  }

  const connectorId = t.connector!
  if (!ws.connectors.has(connectorId)) return { status: 'error', message: `conector "${connectorId}" não existe no workspace` }
  const review = pendingReview([connectorId])
  if (review) return { status: 'skipped', message: review }
  const scenarioKeys = t.scenarios ? expandScenarios(ws, connectorId, t.scenarios) : undefined
  if (scenarioKeys && !scenarioKeys.length) return { status: 'error', message: `nenhum cenário de "${connectorId}" corresponde a ${t.scenarios!.join(', ')}` }
  const report = await rt.runScenarios(
    { runId: `webhook:${job.event.id}:${connectorId}`, connectorId, environmentIds: [job.environmentId], ...(scenarioKeys && { scenarioKeys }) },
    ws,
    signal
  )
  const name = ws.connectors.get(connectorId)?.name ?? connectorId
  const { passed, failed, error } = report.totals
  return {
    status: report.error ? 'error' : report.canceled ? 'skipped' : failed || error ? 'failed' : 'passed',
    message: report.error ?? `${passed} passaram, ${failed} falharam, ${error} com erro`,
    report: { kind: 'scenarios', report, name }
  }
}

/** "<endpoint>" vira todos os cenários dele; "<endpoint>/<cenário>" fica como está. */
function expandScenarios(ws: LoadedWorkspace, connectorId: string, filters: readonly string[]): string[] {
  const keys = new Set(filters.filter((f) => f.includes('/')))
  const endpoints = new Set(filters.filter((f) => !f.includes('/')))
  if (endpoints.size) {
    try {
      for (const e of resolveConnector(connectorId, ws.connectors).endpoints) {
        if (endpoints.has(e.id)) for (const s of e.scenarios ?? []) keys.add(`${e.id}/${s.id}`)
      }
    } catch {
      // Herança com problema: o lote devolve o erro.
    }
  }
  return [...keys]
}
