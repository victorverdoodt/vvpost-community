import type { Endpoint, ResponseExample, Scenario } from '@vvpost/schemas'
import type { HttpResult, ScenarioResult, ScenarioRunInput, ScenarioRunReport } from '../types'
import type { AuthEngine } from '../connectors/auth'
import { ConfigError } from '../connectors/errors'
import { sendHeadless } from '../connectors/headless'
import type { RequestGuard } from '../policy/request-policy'
import { resolveConnector } from '../connectors/resolve'
import type { LoadedWorkspace } from '../connectors/workspace'
import type { HttpDispatcher } from '../http/dispatcher'
import type { FlowPluginRunner } from '../plugins/manager'
import { evaluateAssertion, readTarget, toSubject } from './assert'
import { iterationValues, MAX_DATA_ROWS } from './data'
import { buildScenarioRequest } from './request'
import { accessCheckScenario, ACCESS_CHECK_ID } from './access'
import { sendWithScripts, stepsFor } from '../flows/scripted-send'

/** Requisições do lote em paralelo. Baixo de propósito: não é teste de carga, e a ordem fica legível nos logs da API. */
export const SCENARIO_CONCURRENCY = 4
const BODY_PREVIEW_CHARS = 4000

export interface ScenarioRunContext {
  workspace: LoadedWorkspace
  auth: AuthEngine
  http: Pick<HttpDispatcher, 'send' | 'cancel'>
  signal?: AbortSignal
  concurrency?: number
  /** Permissões e limites do chamador (a IA pelo MCP); ausente quando quem dispara é o usuário. */
  guard?: RequestGuard
  /** Carrega os plugins ligados; só é chamado se um endpoint do lote usa adapter de plugin. */
  plugins?: () => Promise<FlowPluginRunner>
}

interface Job {
  endpoint: Endpoint
  scenario: Scenario
  environmentId: string
  /** Linha do arquivo de dados (a partir de 1) e as variáveis dela; ausente sem `data`. */
  iteration?: { n: number; values: Record<string, string> }
  /** Jobs de dependsOn (mesmo ambiente e mesma iteração). */
  deps: Job[]
  /** Resolve quando o job termina, para quem depende dele. */
  done: Promise<ScenarioResult>
  settle(result: ScenarioResult): void
}

const keyOf = (endpointId: string, scenarioId: string) => `${endpointId}/${scenarioId}`

/**
 * Disparo em lote dos cenários: cada cenário do conector roda uma vez por
 * ambiente escolhido, pelo mesmo caminho do Quick Request (dispatcher Undici e auth
 * headless, com o token em cache dividido entre os cenários). O resultado vem na
 * ordem ambiente → endpoint → cenário, pronto para a matriz.
 *
 * Um cenário com dependsOn roda depois dos cenários de que depende, no mesmo
 * ambiente (que entram no lote mesmo fora do filtro), e lê o que eles capturaram
 * com {{$capture.<nome>}}. Se um deles não passar, ele não é enviado.
 *
 * Com `data`, o lote inteiro roda uma vez por linha do arquivo (em cada ambiente), com as
 * colunas da linha como variáveis; dependsOn e capture ficam dentro da mesma iteração.
 */
export async function runScenarios(input: ScenarioRunInput, ctx: ScenarioRunContext): Promise<ScenarioRunReport> {
  const startedAt = Date.now()
  const start = performance.now()
  const report = (results: ScenarioResult[], extra: Partial<ScenarioRunReport> = {}): ScenarioRunReport => ({
    runId: input.runId,
    connectorId: input.connectorId,
    startedAt,
    durationMs: Math.round(performance.now() - start),
    results,
    totals: {
      passed: results.filter((r) => r.outcome === 'passed').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
      error: results.filter((r) => r.outcome === 'error').length
    },
    canceled: !!ctx.signal?.aborted,
    ...(input.data && { data: { ...(input.data.name && { name: input.data.name }), iterations: input.data.rows.length } }),
    ...extra
  })

  let endpoints: Endpoint[]
  try {
    endpoints = resolveConnector(input.connectorId, ctx.workspace.connectors).endpoints
  } catch (err) {
    if (err instanceof ConfigError) return report([], { error: err.message })
    throw err
  }
  const environmentIds = input.environmentIds?.length ? input.environmentIds : ['']
  const missingEnv = environmentIds.find((id) => id && !ctx.workspace.environments.has(id))
  if (missingEnv) return report([], { error: `ambiente "${missingEnv}" não existe no workspace` })
  if (input.data && input.data.rows.length === 0) return report([], { error: 'o arquivo de dados não tem nenhuma linha' })
  if (input.data && input.data.rows.length > MAX_DATA_ROWS) {
    return report([], { error: `o arquivo de dados tem ${input.data.rows.length} linhas; o máximo por execução é ${MAX_DATA_ROWS}` })
  }
  const iterations = input.data ? input.data.rows.map((row, i) => ({ n: i + 1, values: iterationValues(row, i + 1) })) : [undefined]

  const endpointFilter = input.endpointIds && new Set(input.endpointIds)
  const scenarioFilter = input.scenarioKeys && new Set(input.scenarioKeys)
  const all = new Map<string, { endpoint: Endpoint; scenario: Scenario }>()
  for (const endpoint of endpoints) {
    // O gate de acesso (requiresAuth) vem depois dos cenários do endpoint; com scenarioKeys, só pedido pelo nome.
    const access = input.accessCheck === false ? undefined : accessCheckScenario(endpoint)
    for (const scenario of [...(endpoint.scenarios ?? []), ...(access ? [access] : [])]) all.set(keyOf(endpoint.id, scenario.id), { endpoint, scenario })
  }
  const selected = new Set<string>()
  for (const [key, { endpoint }] of all) {
    if (endpointFilter && !endpointFilter.has(endpoint.id)) continue
    if (scenarioFilter && !scenarioFilter.has(key)) continue
    selected.add(key)
  }
  // As dependências entram no lote mesmo fora do filtro; ciclo ou cenário inexistente é erro do lote.
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (key: string, path: string[]): string | undefined => {
    if (state.get(key) === 'done') return
    if (state.get(key) === 'visiting') return `dependsOn em ciclo: ${[...path, key].join(' → ')}`
    const entry = all.get(key)
    if (!entry) return `${path.at(-1)} depende de ${key}, que não existe em "${input.connectorId}"`
    state.set(key, 'visiting')
    for (const dep of entry.scenario.dependsOn ?? []) {
      const problem = visit(dep, [...path, key])
      if (problem) return problem
    }
    state.set(key, 'done')
    order.push(key)
  }
  for (const key of selected) {
    const problem = visit(key, [])
    if (problem) return report([], { error: problem })
  }
  const included = new Set(order)

  // Na ordem da matriz (iteração → ambiente → endpoint → cenário); a execução segue a ordem das dependências.
  const jobs: Job[] = []
  const byKey = new Map<string, Job>()
  const scope = (job: Pick<Job, 'environmentId' | 'iteration'>) => `${job.iteration?.n ?? 0}\0${job.environmentId}`
  for (const iteration of iterations) {
    for (const environmentId of environmentIds) {
      for (const [key, { endpoint, scenario }] of all) {
        if (!included.has(key)) continue
        let settle!: (r: ScenarioResult) => void
        const done = new Promise<ScenarioResult>((resolve) => (settle = resolve))
        const job: Job = { endpoint, scenario, environmentId, ...(iteration && { iteration }), deps: [], done, settle }
        jobs.push(job)
        byKey.set(`${scope(job)}\0${key}`, job)
      }
    }
  }
  for (const job of jobs) job.deps = (job.scenario.dependsOn ?? []).map((dep) => byKey.get(`${scope(job)}\0${dep}`)!)
  // Uma iteração começa antes da seguinte; dentro dela, a ordem das dependências.
  const rank = new Map(order.map((key, i) => [key, i]))
  const queue = jobs
    .map((job, index) => ({ job, index }))
    .sort(
      (a, b) =>
        (a.job.iteration?.n ?? 0) - (b.job.iteration?.n ?? 0) ||
        rank.get(keyOf(a.job.endpoint.id, a.job.scenario.id))! - rank.get(keyOf(b.job.endpoint.id, b.job.scenario.id))! ||
        a.index - b.index
    )

  const results: (ScenarioResult | undefined)[] = new Array(jobs.length)
  const inFlight = new Set<string>()
  const onAbort = () => inFlight.forEach((id) => ctx.http.cancel(id))
  ctx.signal?.addEventListener('abort', onAbort)
  let next = 0
  const worker = async () => {
    // A fila está em ordem de dependência: quem um job espera já foi pego por outro worker antes.
    while (next < queue.length && !ctx.signal?.aborted) {
      const { job, index } = queue[next++]!
      const id = `${input.runId}:${index}`
      inFlight.add(id)
      try {
        // Um erro inesperado num cenário não pode levar embora o resultado dos outros.
        results[index] = await runAfterDeps(id, input.connectorId, job, ctx).catch(
          (err: Error): ScenarioResult => ({
            endpointId: job.endpoint.id,
            scenarioId: job.scenario.id,
            environmentId: job.environmentId,
            ...(job.iteration && { iteration: job.iteration.n }),
            outcome: 'error',
            request: { method: job.endpoint.method, url: job.endpoint.path },
            durationMs: 0,
            error: { code: 'NETWORK_ERROR', message: err.message },
            assertions: []
          })
        )
      } finally {
        inFlight.delete(id)
        job.settle(results[index] ?? abortedResult(job))
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(ctx.concurrency ?? SCENARIO_CONCURRENCY, jobs.length) }, worker))
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort)
  }
  // Cancelado: o que já estava em voo volta como ABORTED; o que nem começou fica de fora.
  return report(results.filter((r): r is ScenarioResult => r !== undefined))
}

function abortedResult(job: Job): ScenarioResult {
  return {
    endpointId: job.endpoint.id,
    scenarioId: job.scenario.id,
    environmentId: job.environmentId,
    ...(job.iteration && { iteration: job.iteration.n }),
    outcome: 'error',
    request: { method: job.endpoint.method, url: job.endpoint.path },
    durationMs: 0,
    error: { code: 'ABORTED', message: 'execução cancelada' },
    assertions: []
  }
}

/** Espera os cenários de dependsOn; com todos passando, roda com o que eles capturaram em {{$capture.<nome>}}. */
async function runAfterDeps(id: string, connectorId: string, job: Job, ctx: ScenarioRunContext): Promise<ScenarioResult> {
  const deps = await Promise.all(job.deps.map((d) => d.done))
  const failed = deps.find((d) => d.outcome !== 'passed')
  if (failed) {
    return {
      endpointId: job.endpoint.id,
      scenarioId: job.scenario.id,
      environmentId: job.environmentId,
      ...(job.iteration && { iteration: job.iteration.n }),
      outcome: 'error',
      request: { method: job.endpoint.method, url: job.endpoint.path },
      durationMs: 0,
      error: {
        code: 'DEPENDENCY_FAILED',
        message: `depende de ${keyOf(failed.endpointId, failed.scenarioId)}, que ${failed.outcome === 'failed' ? 'falhou' : 'deu erro'}; não foi enviado`
      },
      assertions: []
    }
  }
  // Também o que as dependências das dependências capturaram (A → B → C leva os valores de A até C);
  // todas já terminaram, e a captura mais próxima vence num nome repetido.
  const captures: Record<string, string> = {}
  const seen = new Set<Job>()
  const collect = async (j: Job): Promise<void> => {
    if (seen.has(j)) return
    seen.add(j)
    for (const d of j.deps) await collect(d)
    Object.assign(captures, (await j.done).captures)
  }
  for (const d of job.deps) await collect(d)
  const extra = { ...job.iteration?.values, ...Object.fromEntries(Object.entries(captures).map(([k, v]) => [`$capture.${k}`, v])) }
  return runOne(id, connectorId, job, ctx, extra)
}

async function runOne(
  id: string,
  connectorId: string,
  job: Job,
  ctx: ScenarioRunContext,
  extra: Record<string, string> = {}
): Promise<ScenarioResult> {
  const { endpoint, scenario, environmentId } = job
  const base: Pick<ScenarioResult, 'endpointId' | 'scenarioId' | 'environmentId' | 'iteration' | 'requestId'> = {
    endpointId: endpoint.id,
    scenarioId: scenario.id,
    environmentId,
    ...(job.iteration && { iteration: job.iteration.n })
  }
  if (endpoint.plugin) {
    base.requestId = id
    return evaluate(base, { method: endpoint.method, url: endpoint.path }, scenario, environmentId, await runPluginScenario(id, connectorId, job, ctx, extra), job.iteration?.values, endpoint.examples)
  }
  let built
  try {
    built = buildScenarioRequest(endpoint, scenario)
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    return {
      ...base,
      outcome: 'error',
      request: { method: endpoint.method, url: endpoint.path },
      durationMs: 0,
      error: { code: 'CONFIG_ERROR', message: err.message },
      assertions: []
    }
  }
  const request = { method: built.method, url: built.url }
  base.requestId = id
  const input = {
    id,
    method: built.method,
    url: built.url,
    headers: built.headers,
    ...(built.body !== undefined && { body: built.body }),
    ...(built.payload && { payload: built.payload }),
    connectorId,
    endpointId: endpoint.id,
    ...(environmentId && { environmentId })
  }
  const headless = { workspace: ctx.workspace, auth: ctx.auth, http: ctx.http, signal: ctx.signal, ...(ctx.guard && { guard: ctx.guard }) }
  const options = Object.keys(extra).length ? { ...built.options, extra } : built.options
  // Scripts do endpoint e do conector: a requisição roda como o fluxo script → requisição → script.
  const scripted =
    stepsFor(input, ctx.workspace).length > 0
      ? await sendWithScripts(input, { ...headless, ...(ctx.plugins && { plugins: await ctx.plugins() }) }, options)
      : null
  const result = scripted ?? (await sendHeadless(input, headless, options))
  return evaluate(base, request, scenario, environmentId, result, job.iteration?.values, endpoint.examples)
}

/** Endpoint com plugin: a config do endpoint com overrides.config por cima (null tira o campo), pelo adapter. */
async function runPluginScenario(id: string, connectorId: string, job: Job, ctx: ScenarioRunContext, extra: Record<string, string>): Promise<HttpResult> {
  const plugin = job.endpoint.plugin!
  const config: Record<string, unknown> = { ...plugin.config }
  for (const [key, value] of Object.entries(job.scenario.overrides?.config ?? {})) {
    if (value === null) delete config[key]
    else config[key] = value
  }
  const { runAdapterRequest } = await import('../flows/adapter-request')
  return runAdapterRequest(
    {
      id,
      adapter: plugin.adapter,
      config,
      connectorId,
      ...(job.environmentId && { environmentId: job.environmentId }),
      ...(plugin.timeoutMs && { timeoutMs: plugin.timeoutMs }),
      ...(Object.keys(extra).length && { values: extra })
    },
    {
      workspace: ctx.workspace,
      auth: ctx.auth,
      http: ctx.http,
      ...(ctx.signal && { signal: ctx.signal }),
      ...(ctx.plugins && { plugins: await ctx.plugins() })
    }
  )
}

/** Asserções e capture sobre a resposta (de HTTP ou de um adapter). */
function evaluate(
  base: Pick<ScenarioResult, 'endpointId' | 'scenarioId' | 'environmentId' | 'iteration' | 'requestId'>,
  request: ScenarioResult['request'],
  scenario: Scenario,
  environmentId: string,
  result: HttpResult,
  data?: Readonly<Record<string, string>>,
  examples?: readonly ResponseExample[]
): ScenarioResult {
  if (!result.ok) {
    return {
      ...base,
      outcome: 'error',
      request,
      durationMs: result.timings.totalMs,
      error: result.error,
      ...(result.auth && { auth: result.auth }),
      assertions: []
    }
  }
  const { response } = result
  const subject = toSubject(response)
  // Expectativa por ambiente: uma asserção com environments só vale neles.
  const assertions = scenario.assertions
    .filter((a) => !a.environments || a.environments.includes(environmentId))
    .map((a) => evaluateAssertion(data ? withData(a, data) : a, subject, examples))
  // Os testes dos scripts post (vv.test) entram como asserções do cenário.
  for (const t of result.scripts?.tests ?? []) {
    assertions.push({ target: `test: ${t.name}`, operator: 'equals', expected: true, actual: t.passed, passed: t.passed, message: t.passed ? `${t.name}: passou` : `${t.name}: ${t.message}` })
  }
  if (result.scripts?.error) {
    const { script, message } = result.scripts.error
    assertions.push({ target: `test: ${script}`, operator: 'equals', expected: true, actual: false, passed: false, message: `script ${script} falhou: ${message}` })
  }
  const captures: Record<string, string> = {}
  for (const [name, target] of Object.entries(scenario.capture ?? {})) {
    const { value } = readTarget(target, subject)
    if (value !== undefined) captures[name] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return {
    ...base,
    outcome: assertions.every((a) => a.passed) ? 'passed' : 'failed',
    request,
    status: response.status,
    durationMs: response.timings.totalMs,
    ...(result.auth && { auth: result.auth }),
    assertions,
    ...(Object.keys(captures).length && { captures }),
    bodyPreview: response.body.length > BODY_PREVIEW_CHARS ? `${response.body.slice(0, BODY_PREVIEW_CHARS)}…` : response.body,
    responseHeaders: response.headers
  }
}

/**
 * Esperado de uma iteração: "{{coluna}}" sozinho vira o valor da linha com o tipo do JSON
 * (30 é número, true é booleano), e {{coluna}} no meio de um texto é trocado como texto.
 * Só as colunas do arquivo entram; outro {{...}} fica como está.
 */
function withData<T extends { expected?: unknown }>(assertion: T, data: Readonly<Record<string, string>>): T {
  const { expected } = assertion
  if (typeof expected !== 'string' || !expected.includes('{{')) return assertion
  const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(expected)
  if (whole && data[whole[1]!] !== undefined) {
    const raw = data[whole[1]!]!
    let typed: unknown = raw
    try {
      typed = raw.trim() === '' ? raw : JSON.parse(raw)
    } catch {
      // Texto puro: compara como texto.
    }
    return { ...assertion, expected: typed }
  }
  return { ...assertion, expected: expected.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, name: string) => data[name] ?? all) }
}
