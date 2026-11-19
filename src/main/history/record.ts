import type {
  FlowNodeResult,
  FlowRunReport,
  HistoryOutcome,
  HttpRequestInput,
  HttpResult,
  RemoteRun,
  ScenarioResult,
  ScenarioRunReport
} from '@shared/ipc'
import type { RecordedExchange } from '@vvpost/core/recorder'
import type { NewHistoryExchange, NewHistoryRun } from './store'

/**
 * Do que o motor devolve (relatórios) e do que o dispatcher viu (RecordedExchange) para o
 * formato do histórico. Aqui nada é mascarado nem cortado: o store aplica o nível e as
 * máscaras na gravação, num lugar só.
 */

const statusOutcome = (status: number | null): HistoryOutcome =>
  status === null ? 'error' : status >= 400 ? 'failed' : 'passed'

/** Requisição do dispatcher: modelo, o que foi para a rede e a resposta. */
function fromRecorded(
  x: RecordedExchange | undefined,
  input: Pick<HttpRequestInput, 'method' | 'url' | 'headers' | 'body' | 'payload' | 'connectorId' | 'environmentId' | 'prepareFlowId' | 'endpointId' | 'scripts'>,
  result: HttpResult | undefined
): NewHistoryExchange {
  const r = x?.result ?? result
  const t = x?.trace
  const template = t?.template ?? { ...input }
  const noBody = template.method === 'GET' || template.method === 'HEAD'
  return {
    createdAt: x?.at ?? Date.now(),
    method: template.method,
    url: template.url,
    status: r?.ok ? r.response.status : null,
    errorCode: r && !r.ok ? r.error.code : null,
    errorMessage: r && !r.ok ? r.error.message : null,
    durationMs: r ? (r.ok ? r.response.timings.totalMs : r.timings.totalMs) : 0,
    sizeBytes: r?.ok ? r.response.sizeBytes : null,
    connectorId: template.connectorId ?? null,
    environmentId: template.environmentId ?? null,
    template: {
      headers: template.headers,
      body: noBody ? null : (template.body ?? null),
      ...(!noBody && template.payload && { payload: template.payload }),
      ...(t?.inheritHeaders === false && { inheritHeaders: false }),
      ...(t?.dropHeaders?.length && { dropHeaders: t.dropHeaders }),
      ...(t?.anonymous && { anonymous: true }),
      ...(t?.extra && { extra: t.extra }),
      ...(template.prepareFlowId && { prepareFlowId: template.prepareFlowId }),
      ...(template.endpointId && { endpointId: template.endpointId }),
      ...((template.scripts?.pre?.trim() || template.scripts?.post?.trim()) && { scripts: template.scripts })
    },
    ...(x && { sent: { url: x.sent.url, headers: x.sent.headers, body: noBody ? null : (x.sent.body ?? null) } }),
    ...(r?.ok && { response: r.response }),
    ...(r && !r.ok && { timings: r.timings }),
    ...(r?.auth && { auth: r.auth })
  }
}

/** Uma requisição do Quick Request (ou refeita a partir do histórico). */
export function requestRun(input: HttpRequestInput, result: HttpResult, recorded: RecordedExchange | undefined, replayOf?: number): NewHistoryRun {
  const exchange = { ...fromRecorded(recorded, input, result) }
  exchange.outcome = statusOutcome(exchange.status)
  return {
    createdAt: exchange.createdAt,
    source: 'request',
    title: `${input.method} ${input.url}`,
    outcome: exchange.outcome,
    status: exchange.status,
    errorCode: exchange.errorCode,
    durationMs: exchange.durationMs,
    connectorId: input.connectorId ?? null,
    environmentId: input.environmentId ?? null,
    ...(replayOf !== undefined && { replayOf }),
    exchanges: [exchange]
  }
}

/** As requisições de um lote de cenários, com as asserções de cada uma. */
export function scenarioExchanges(report: ScenarioRunReport, recorded: RecordedExchange[]): NewHistoryExchange[] {
  const byId = new Map(recorded.map((x) => [x.id, x]))
  return report.results.map((r: ScenarioResult) => {
    const x = r.requestId ? byId.get(r.requestId) : undefined
    const base = fromRecorded(
      x,
      { method: r.request.method, url: r.request.url, headers: [], connectorId: report.connectorId, ...(r.environmentId && { environmentId: r.environmentId }) },
      undefined
    )
    // Sem a requisição do dispatcher (cenário que nem foi montado) não há modelo para reproduzir.
    const { template: _t, ...withoutTemplate } = base
    return {
      ...(x ? base : withoutTemplate),
      label: `${r.endpointId}/${r.scenarioId}${r.iteration !== undefined ? ` #${r.iteration}` : ''}`,
      ref: { endpointId: r.endpointId, scenarioId: r.scenarioId },
      outcome: r.outcome,
      // O relatório é a fonte do status e do erro (inclui o que nem chegou ao dispatcher).
      status: r.status ?? null,
      errorCode: r.error?.code ?? null,
      errorMessage: r.error?.message ?? null,
      durationMs: r.durationMs,
      ...(r.auth && { auth: r.auth }),
      assertions: r.assertions
    }
  })
}

export function scenarioRun(report: ScenarioRunReport, recorded: RecordedExchange[], title?: string): NewHistoryRun {
  const envs = [...new Set(report.results.map((r) => r.environmentId).filter(Boolean))]
  const outcome: HistoryOutcome = report.canceled
    ? 'canceled'
    : report.error !== undefined || report.totals.error
      ? 'error'
      : report.totals.failed
        ? 'failed'
        : 'passed'
  return {
    createdAt: report.startedAt,
    source: 'scenarios',
    title: title ?? `Cenários de ${report.connectorId}`,
    outcome,
    errorCode: report.error !== undefined ? 'CONFIG_ERROR' : null,
    durationMs: report.durationMs,
    connectorId: report.connectorId,
    environmentId: envs.length === 1 ? envs[0]! : null,
    totals: report.totals,
    report: { meta: { environments: envs, canceled: report.canceled, ...(report.error !== undefined && { error: report.error }) } },
    exchanges: scenarioExchanges(report, recorded)
  }
}

const REMOTE_OUTCOME: Record<RemoteRun['status'], HistoryOutcome> = {
  queued: 'error',
  running: 'error',
  passed: 'passed',
  failed: 'failed',
  error: 'error',
  canceled: 'canceled',
  lost: 'error'
}

/**
 * Uma execução que terminou num Execution Runner: os cenários do relatório do runner,
 * marcados como remotos. As requisições não passaram pelo dispatcher daqui, então nenhuma é
 * reproduzível; ficam status, erro e asserções de cada cenário.
 */
export function remoteRun(
  run: RemoteRun,
  source: string,
  reports: ScenarioRunReport[],
  names: ReadonlyMap<string, string>
): NewHistoryRun {
  const totals = reports.reduce(
    (t, r) => ({ passed: t.passed + r.totals.passed, failed: t.failed + r.totals.failed, error: t.error + r.totals.error }),
    { passed: 0, failed: 0, error: 0 }
  )
  const connectors = [...new Set(reports.map((r) => r.connectorId))]
  const envs = [...new Set(reports.flatMap((r) => r.results.map((x) => x.environmentId)).filter(Boolean))]
  const what =
    connectors.length === 1
      ? `Cenários de ${names.get(connectors[0]!) ?? connectors[0]}`
      : connectors.length
        ? `Cenários de ${connectors.length} conectores`
        : 'Execução remota'
  const started = reports.length ? Math.min(...reports.map((r) => r.startedAt)) : Date.parse(run.createdAt) || Date.now()
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN
  return {
    createdAt: started,
    source: 'scenarios',
    title: `${what} no runner #${run.id}`,
    outcome: REMOTE_OUTCOME[run.status],
    errorCode: run.status === 'lost' ? 'RUNNER_LOST' : run.status === 'error' ? 'RUNNER_ERROR' : null,
    durationMs: Number.isFinite(finished) ? Math.max(0, finished - started) : reports.reduce((n, r) => n + r.durationMs, 0),
    connectorId: connectors.length === 1 ? connectors[0]! : null,
    environmentId: envs.length === 1 ? envs[0]! : null,
    totals: reports.length ? totals : null,
    report: {
      meta: {
        environments: envs,
        canceled: run.status === 'canceled',
        runner: { status: run.status, exitCode: run.exitCode, requestedBy: run.requestedBy, ...(run.error && { error: run.error }) }
      }
    },
    remote: { runId: run.id, source },
    exchanges: reports.flatMap((r) => scenarioExchanges(r, []))
  }
}

/** Nós do fluxo no relatório: saída só em `full`, logs e requisição a partir de `headers`. */
function flowReportParts(report: FlowRunReport) {
  const strip = ({ output: _o, logs: _l, request: _r, ...rest }: FlowNodeResult) => rest
  return {
    meta: { outcome: report.outcome, ...(report.error !== undefined && { error: report.error }), nodes: report.results.map(strip) },
    headers: { nodes: report.results.map(({ output: _o, ...rest }) => rest) },
    full: { nodes: report.results }
  }
}

/** As requisições dos nós de requisição e de plugin, na ordem do disparo. */
export function flowExchanges(report: FlowRunReport, recorded: RecordedExchange[], environmentId: string): NewHistoryExchange[] {
  const out: NewHistoryExchange[] = []
  const nodes = new Map(report.results.map((n) => [n.nodeId, n]))
  const logged = new Set<string>()
  for (const x of [...recorded].sort((a, b) => a.at - b.at)) {
    const nodeId = x.id.slice(report.runId.length + 1).split(':')[0] ?? ''
    const node = nodes.get(nodeId)
    // Um nó de plugin pode disparar várias requisições: os logs dele vão só na primeira.
    const logs = node?.logs && !logged.has(nodeId) ? node.logs : undefined
    if (logs) logged.add(nodeId)
    const exchange = fromRecorded(x, x.trace.template, undefined)
    out.push({
      ...exchange,
      label: node?.name ?? nodeId,
      ref: { nodeId },
      outcome: statusOutcome(exchange.status),
      ...(!exchange.environmentId && environmentId && { environmentId }),
      ...(logs && { logs })
    })
  }
  return out
}

export function flowRun(report: FlowRunReport, recorded: RecordedExchange[], environmentId: string, title?: string): NewHistoryRun {
  const outcome: HistoryOutcome =
    report.outcome === 'canceled' ? 'canceled' : report.error !== undefined ? 'error' : report.outcome === 'success' ? 'passed' : 'failed'
  return {
    createdAt: report.startedAt,
    source: 'flow',
    title: title ?? `Fluxo ${report.flowId}`,
    outcome,
    errorCode: report.error !== undefined ? 'CONFIG_ERROR' : null,
    durationMs: report.durationMs,
    environmentId: environmentId || null,
    flowId: report.flowId,
    totals: {
      passed: report.results.filter((n) => n.status === 'success').length,
      failed: report.results.filter((n) => n.status === 'error').length,
      error: 0
    },
    report: flowReportParts(report),
    exchanges: flowExchanges(report, recorded, environmentId)
  }
}

/** Um `vvpost run` inteiro: os lotes de cenários e os fluxos, com as requisições de todos. */
export function cliRun(
  result: {
    startedAt: number
    durationMs: number
    environments: string[]
    scenarios: ScenarioRunReport[]
    flows: { file: string; environmentId: string; report: FlowRunReport }[]
    canceled: boolean
  },
  summary: { outcome: 'passed' | 'failed' | 'error' | 'canceled'; scenarios: { passed: number; failed: number; error: number }; flows: { success: number; failed: number } },
  recorded: RecordedExchange[],
  title: string
): NewHistoryRun {
  const claimed = new Set<string>()
  const exchanges: NewHistoryExchange[] = []
  for (const report of result.scenarios) {
    const ids = new Set(report.results.map((r) => r.requestId).filter((id): id is string => !!id))
    const mine = recorded.filter((x) => ids.has(x.id))
    for (const x of mine) claimed.add(x.id)
    exchanges.push(...scenarioExchanges(report, mine))
  }
  for (const { report, environmentId } of result.flows) {
    const mine = recorded.filter((x) => !claimed.has(x.id) && x.id.startsWith(`${report.runId}:`))
    for (const x of mine) claimed.add(x.id)
    exchanges.push(...flowExchanges(report, mine, environmentId))
  }
  const flows = result.flows.map((f) => ({ file: f.file, environmentId: f.environmentId, ...flowReportParts(f.report) }))
  return {
    createdAt: result.startedAt,
    source: 'cli',
    title,
    outcome: summary.outcome,
    durationMs: result.durationMs,
    environmentId: result.environments.length === 1 ? result.environments[0]! : null,
    totals: {
      passed: summary.scenarios.passed + summary.flows.success,
      failed: summary.scenarios.failed + summary.flows.failed,
      error: summary.scenarios.error
    },
    report: {
      meta: {
        environments: result.environments,
        summary,
        batches: result.scenarios.map((r) => ({ connectorId: r.connectorId, totals: r.totals, ...(r.error !== undefined && { error: r.error }) })),
        flows: flows.map((f) => ({ file: f.file, environmentId: f.environmentId, ...f.meta }))
      },
      headers: { flows: flows.map((f) => ({ file: f.file, environmentId: f.environmentId, ...f.meta, ...f.headers })) },
      full: { flows: flows.map((f) => ({ file: f.file, environmentId: f.environmentId, ...f.meta, ...f.full })) }
    },
    exchanges
  }
}
