import {
  validateFlow,
  type Flow,
  type FlowCondition,
  type FlowConditionNode,
  type FlowNode,
  type FlowPythonNode,
  type FlowRequestNode,
  type FlowWebhookNode
} from '@vvpost/schemas'
import { HTTP_METHODS, type FlowErrorCode, type FlowNodeResult, type FlowRunEvent, type FlowRunInput, type FlowRunReport, type HttpMethod, type HttpResult, type WebhookEvent, type WebhookSource } from '../types'
import type { AuthEngine } from '../connectors/auth'
import { ConfigError } from '../connectors/errors'
import { sendHeadless, testConnectorAuth } from '../connectors/headless'
import { isBaseFlow } from './inherit'
import { locateProperty } from './locate'
import { joinPath, resolveConnector } from '../connectors/resolve'
import type { LoadedWorkspace } from '../connectors/workspace'
import type { HttpDispatcher } from '../http/dispatcher'
import type { RequestGuard } from '../policy/request-policy'
import type { FlowPluginRunner } from '../plugins/manager'
import { evaluateAssertion, toSubject } from '../scenarios/assert'
import { buildScenarioRequest } from '../scenarios/request'
import { deepFreeze, ExpressionError, Substitutions, type NodeOutput, type NodesTree } from './expressions'
import { headerRecord, runPluginNode } from './plugin-node'
import { scriptEnvironment, scriptFlow, scriptResult, scriptSteps, REQUEST_NODE, type ScriptRequest } from './request-scripts'
import { runPython, type PythonRunOptions } from './python'
import { featureDenial } from '../policy/features'
import { pathMatches, resolveWebhookPath, WEBHOOK_TIMEOUT_MS, webhookOutput } from './webhook'

/** Nós rodando ao mesmo tempo, no máximo. */
export const FLOW_CONCURRENCY = 6

export interface FlowRunContext {
  workspace: LoadedWorkspace
  auth: AuthEngine
  http: Pick<HttpDispatcher, 'send' | 'cancel'>
  signal?: AbortSignal
  onEvent?: (event: FlowRunEvent) => void
  concurrency?: number
  python?: Pick<PythonRunOptions, 'interpreter'>
  /** Tipos de nó e adapters dos plugins ligados (Plugin SDK); sem isso, nós de plugin falham com PLUGIN_UNAVAILABLE. */
  plugins?: FlowPluginRunner
  /** Permissões e limites das requisições dos nós (o MCP passa o da IA). */
  guard?: RequestGuard
  /** Servidor de webhooks dos nós webhook; sem ele, esses nós falham com WEBHOOK_UNAVAILABLE. */
  webhooks?: WebhookSource
  /** Por que não há servidor (porta ocupada...), para a mensagem do nó. */
  webhooksError?: string
  /**
   * Primeiro evento que os nós webhook aceitam: num fluxo disparado por um hook, o evento
   * que disparou. Padrão: o que chegar depois do início da execução.
   */
  webhookSince?: number
  /**
   * Variáveis definidas por scripts da requisição (vv.variables.set): resolvem {{nome}} nas
   * requisições. Os scripts dos nós desta execução acrescentam as deles aqui.
   */
  variables?: Record<string, string>
  /** A resposta completa de cada nó de requisição, para quem roda o fluxo de scripts de uma requisição. */
  onHttpResult?: (nodeId: string, result: HttpResult) => void
  /** Saída de nós de fora deste fluxo que os nós dele enxergam (o fluxo de scripts de um nó de requisição). */
  parentNodes?: NodesTree
}

/** Eventos de webhook da execução: desde quando valem e quais já serviram a um nó. */
interface WebhookRun {
  since: number
  taken: Set<number>
}

interface Graph {
  nodes: Map<string, FlowNode>
  incoming: Map<string, { from: string; branch?: 'true' | 'false' }[]>
  outgoing: Map<string, string[]>
  /** Nomes dos nós anteriores (ancestrais) de cada nó: o que ele enxerga em $nodes. */
  ancestors: Map<string, Set<string>>
}

function buildGraph(flow: Flow): Graph {
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]))
  const incoming = new Map(flow.nodes.map((n) => [n.id, [] as { from: string; branch?: 'true' | 'false' }[]]))
  const outgoing = new Map(flow.nodes.map((n) => [n.id, [] as string[]]))
  for (const e of flow.edges ?? []) {
    incoming.get(e.to)!.push({ from: e.from, ...(e.branch && { branch: e.branch }) })
    outgoing.get(e.from)!.push(e.to)
  }
  const ancestors = new Map<string, Set<string>>()
  const visit = (id: string): Set<string> => {
    const known = ancestors.get(id)
    if (known) return known
    const set = new Set<string>()
    for (const { from } of incoming.get(id)!) {
      set.add(nodes.get(from)!.name)
      for (const name of visit(from)) set.add(name)
    }
    ancestors.set(id, set)
    return set
  }
  for (const id of nodes.keys()) visit(id)
  return { nodes, incoming, outgoing, ancestors }
}

/**
 * Context Engine: roda o fluxo em ordem topológica. Um nó começa quando
 * todos os anteriores terminaram; nós prontos ao mesmo tempo rodam em paralelo. A
 * saída de cada nó é congelada em $nodes.<nome>, e cada nó só enxerga os nós
 * anteriores a ele no grafo, então o resultado não depende de quem terminou primeiro.
 *
 * Um nó roda se pelo menos uma aresta de entrada está ativa (o nó de origem rodou e,
 * numa condição, o ramo é o escolhido) e nenhum nó de origem falhou; sem isso ele é
 * pulado, e o salto se propaga. Um erro não para os ramos independentes.
 */
export async function runFlow(input: FlowRunInput, ctx: FlowRunContext): Promise<FlowRunReport> {
  const startedAt = Date.now()
  const start = performance.now()
  const results: FlowNodeResult[] = []
  const report = (extra: Partial<FlowRunReport> = {}): FlowRunReport => ({
    runId: input.runId,
    flowId: input.flow?.id ?? '',
    startedAt,
    durationMs: Math.round(performance.now() - start),
    results,
    outcome: ctx.signal?.aborted ? 'canceled' : results.some((r) => r.status === 'error') ? 'failed' : 'success',
    ...extra
  })

  const validation = validateFlow(input.flow)
  if (!validation.ok) {
    const issues = validation.issues.slice(0, 5).map((i) => `${i.path || '/'}: ${i.message}`)
    return report({ outcome: 'failed', error: `fluxo inválido: ${issues.join('; ')}` })
  }
  const environmentId = input.environmentId || undefined
  if (environmentId && !ctx.workspace.environments.has(environmentId)) {
    return report({ outcome: 'failed', error: `ambiente "${environmentId}" não existe no workspace` })
  }
  if (isBaseFlow(validation.value)) {
    if (!ctx.workspace.flowSources?.has(validation.value.id)) {
      return report({
        outcome: 'failed',
        error: `o fluxo-base "${validation.value.id}" não está no catálogo do workspace (veja os avisos do workspace); salve o fluxo e rode de novo`
      })
    }
    const result = await runBase(validation.value, environmentId, ctx)
    results.push(result)
    ctx.onEvent?.({ runId: input.runId, type: 'node', nodeId: result.nodeId, status: result.status, result })
    return report()
  }
  const flow = inheritConnector(validation.value)

  const graph = buildGraph(flow)
  const webhookRun: WebhookRun = { since: ctx.webhookSince ?? ctx.webhooks?.cursor() ?? 0, taken: new Set() }
  const done = new Map<string, FlowNodeResult>()
  const outputs = new Map<string, NodeOutput>()
  const started = new Set<string>()
  const inFlight = new Set<string>()
  const limit = Math.max(1, ctx.concurrency ?? FLOW_CONCURRENCY)
  const onAbort = () => inFlight.forEach((id) => ctx.http.cancel(`${input.runId}:${id}`))
  ctx.signal?.addEventListener('abort', onAbort)

  const finish = (result: FlowNodeResult) => {
    done.set(result.nodeId, result)
    results.push(result)
    ctx.onEvent?.({ runId: input.runId, type: 'node', nodeId: result.nodeId, status: result.status, result })
  }

  const edgeActive = (from: string, branch?: 'true' | 'false') => {
    const source = done.get(from)
    if (source?.status !== 'success') return false
    if (branch === undefined) return true
    return String((source.output?.data as { result?: unknown } | undefined)?.result === true) === branch
  }

  /** Pronto: todos os anteriores terminaram. Devolve se roda ou o motivo do salto. */
  const readiness = (id: string): 'wait' | 'run' | { skip: string } => {
    const incoming = graph.incoming.get(id)!
    if (incoming.some((e) => !done.has(e.from))) return 'wait'
    if (incoming.length === 0) return 'run'
    const failed = incoming.find((e) => done.get(e.from)!.status === 'error')
    if (failed) return { skip: `${graph.nodes.get(failed.from)!.name} falhou` }
    if (incoming.some((e) => edgeActive(e.from, e.branch))) return 'run'
    const branch = incoming.find((e) => e.branch !== undefined && done.get(e.from)!.status === 'success')
    return {
      skip: branch
        ? `a condição ${graph.nodes.get(branch.from)!.name} seguiu o ramo ${branch.branch === 'true' ? 'false' : 'true'}`
        : 'nenhum nó anterior rodou'
    }
  }

  const treeFor = (id: string): NodesTree => {
    const tree: Record<string, NodeOutput> = { ...ctx.parentNodes }
    for (const name of graph.ancestors.get(id)!) {
      const output = outputs.get(name)
      if (output) tree[name] = output
    }
    return Object.freeze(tree)
  }

  await new Promise<void>((resolve) => {
    const pump = () => {
      if (ctx.signal?.aborted) {
        if (inFlight.size === 0) resolve()
        return
      }
      // Saltos liberam outros nós na hora; repete até não haver mais nada decidido.
      let progressed = true
      while (progressed) {
        progressed = false
        for (const node of flow.nodes) {
          if (started.has(node.id)) continue
          const state = readiness(node.id)
          if (state === 'wait') continue
          if (state === 'run') {
            if (inFlight.size >= limit) continue
            started.add(node.id)
            inFlight.add(node.id)
            const requestId = `${input.runId}:${node.id}`
            ctx.onEvent?.({ runId: input.runId, type: 'node', nodeId: node.id, status: 'running' })
            const ancestors = ctx.parentNodes ? new Set([...Object.keys(ctx.parentNodes), ...graph.ancestors.get(node.id)!]) : graph.ancestors.get(node.id)!
            void runNode(node, treeFor(node.id), ancestors, requestId, environmentId, flow, ctx, webhookRun)
              .catch((err: Error): FlowNodeResult => ({
                nodeId: node.id,
                name: node.name,
                status: 'error',
                durationMs: 0,
                error: { code: 'NETWORK_ERROR', message: err.message }
              }))
              .then((result) => {
                inFlight.delete(node.id)
                if (result.status === 'success' && result.output) outputs.set(node.name, deepFreeze(result.output))
                finish(result)
                pump()
              })
          } else {
            started.add(node.id)
            finish({ nodeId: node.id, name: node.name, status: 'skipped', durationMs: 0, reason: state.skip })
            progressed = true
          }
        }
      }
      if (inFlight.size === 0) resolve()
    }
    pump()
  })
  ctx.signal?.removeEventListener('abort', onAbort)
  return report()
}

async function runNode(
  node: FlowNode,
  nodes: NodesTree,
  ancestors: ReadonlySet<string>,
  requestId: string,
  environmentId: string | undefined,
  flow: Flow,
  ctx: FlowRunContext,
  webhookRun: WebhookRun
): Promise<FlowNodeResult> {
  const base = { nodeId: node.id, name: node.name }
  const start = performance.now()
  const elapsed = () => Math.round((performance.now() - start) * 100) / 100
  const fail = (code: FlowErrorCode, message: string, extra: Partial<FlowNodeResult> = {}): FlowNodeResult => ({
    ...base,
    status: 'error',
    durationMs: elapsed(),
    error: { code, message },
    ...extra
  })
  const located = (result: FlowNodeResult): FlowNodeResult => {
    if (!result.error || result.error.property) return result
    const property = locateProperty(node, result.error.code, result.error.message)
    return property ? { ...result, error: { ...result.error, property } } : result
  }
  return located(await runNodeIn(node, nodes, ancestors, requestId, environmentId, flow, ctx, webhookRun, base, fail, elapsed))
}

async function runNodeIn(
  node: FlowNode,
  nodes: NodesTree,
  ancestors: ReadonlySet<string>,
  requestId: string,
  environmentId: string | undefined,
  flow: Flow,
  ctx: FlowRunContext,
  webhookRun: WebhookRun,
  base: { nodeId: string; name: string },
  fail: (code: FlowErrorCode, message: string, extra?: Partial<FlowNodeResult>) => FlowNodeResult,
  elapsed: () => number
): Promise<FlowNodeResult> {
  // Nós do fluxo que não são anteriores a este: a mensagem de erro de uma referência a eles diz isso.
  const elsewhere = new Set(flow.nodes.map((n) => n.name).filter((n) => !ancestors.has(n)))
  try {
    switch (node.type) {
      case 'request':
        return await runRequest(node, nodes, ancestors, new Substitutions(nodes, elsewhere), requestId, environmentId, ctx, fail, elapsed)
      case 'condition':
        return runCondition(node, nodes, ancestors, new Substitutions(nodes, elsewhere), fail, elapsed)
      case 'wait':
        await sleep(node.wait.ms, ctx.signal)
        return { ...base, status: 'success', durationMs: elapsed(), output: { data: { waitedMs: node.wait.ms } } }
      case 'webhook':
        return await runWebhookNode(node, nodes, ancestors, new Substitutions(nodes, elsewhere), elsewhere, ctx, webhookRun, fail, elapsed)
      case 'python':
        return await runPythonNode(node, nodes, ctx, fail)
      case 'plugin':
        return await runPluginNode(node, nodes, elsewhere, requestId, environmentId, ctx, fail)
      case 'oauth2':
        // Um fluxo com nó oauth2 é uma base e roda por runBase; aqui ele só chega num fluxo que não é base.
        return fail('CONFIG_ERROR', 'o nó oauth2 só vale num fluxo-base: ele é a auth das requisições que herdam da base')
    }
  } catch (err) {
    if (err instanceof ExpressionError) return fail('EXPRESSION_ERROR', err.message)
    if (err instanceof ConfigError) return fail('CONFIG_ERROR', err.message)
    if (ctx.signal?.aborted) return fail('ABORTED', 'execução cancelada')
    throw err
  }
}

export { isBaseFlow }

/**
 * Rodar uma base é testar a auth dela: o login (ou o OAuth2 de defaults.auth) roda de verdade,
 * com um token novo que fica no mesmo cache das requisições. O token não aparece no resultado,
 * só de onde veio e até quando vale. Sem auth que peça token, não há o que rodar.
 */
async function runBase(flow: Flow, environmentId: string | undefined, ctx: FlowRunContext): Promise<FlowNodeResult> {
  const login = flow.nodes.find((n) => (n.type === 'request' && n.cache) || n.type === 'oauth2')
  const base = { nodeId: login?.id ?? flow.id, name: login?.name ?? flow.name }
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  // O login foi escrito no workspace e não passa pela política (request-policy.ts), mas o ambiente, sim.
  const allowed = ctx.guard?.policy.allowEnvironments
  if (allowed && !allowed.has(environmentId ?? '')) {
    return {
      ...base,
      status: 'error',
      durationMs: 0,
      error: { code: 'POLICY_DENIED', message: `${ctx.guard!.policy.actor} não pode disparar no ambiente "${environmentId ?? ''}"` }
    }
  }
  try {
    const applied = await testConnectorAuth(flow.id, environmentId, { workspace: ctx.workspace, auth: ctx.auth, http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) })
    if (!applied) {
      return {
        ...base,
        status: 'skipped',
        durationMs: 0,
        reason: 'a base não pede token: os headers e a auth dela vão direto nas requisições que herdam dela'
      }
    }
    const { usage } = applied
    return {
      ...base,
      status: 'success',
      durationMs: elapsed(),
      auth: usage,
      output: { data: { result: 'token obtido', from: usage.from, ...(usage.expiresAt !== undefined && { expiresAt: usage.expiresAt }) } }
    }
  } catch (err) {
    const code: FlowErrorCode = err instanceof ConfigError ? 'CONFIG_ERROR' : ctx.signal?.aborted ? 'ABORTED' : 'AUTH_FAILED'
    return { ...base, status: 'error', durationMs: elapsed(), error: { code, message: (err as Error).message } }
  }
}

/**
 * Um fluxo que herda (extends) manda as requisições pela base: o nó de requisição ou de
 * adapter sem conector próprio usa o conector-pai, com a URL base, os headers, a auth, o
 * mTLS e os scripts herdados (docs/flows.md, Herança entre fluxos).
 */
export function inheritConnector(flow: Flow): Flow {
  const parent = flow.extends
  if (!parent) return flow
  return {
    ...flow,
    nodes: flow.nodes.map((n) =>
      n.type === 'request' && !n.request.connector
        ? { ...n, request: { ...n.request, connector: parent } }
        : n.type === 'plugin' && n.plugin.adapter && !n.plugin.connector
          ? { ...n, plugin: { ...n.plugin, connector: parent } }
          : n
    )
  }
}

/** Padrões do polling (flow.json, FlowPoll). */
const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 30_000

async function runRequest(
  node: FlowRequestNode,
  nodes: NodesTree,
  ancestors: ReadonlySet<string>,
  subs: Substitutions,
  requestId: string,
  environmentId: string | undefined,
  ctx: FlowRunContext,
  fail: (code: FlowErrorCode, message: string, extra?: Partial<FlowNodeResult>) => FlowNodeResult,
  elapsed: () => number
): Promise<FlowNodeResult> {
  const r = node.request
  const connector = r.connector ? resolveConnector(r.connector, ctx.workspace.connectors) : undefined
  const endpoint = r.endpoint ? connector?.endpoints.find((e) => e.id === r.endpoint) : undefined
  if (r.endpoint && !endpoint) throw new ConfigError(`o conector "${r.connector}" não tem o endpoint "${r.endpoint}"`)
  const method = r.method ?? endpoint!.method
  const path = r.url ?? endpoint!.path
  // Scripts do endpoint e do conector: o nó vira o fluxo script → requisição → script (fase 13).
  // Os do próprio nó (requestScripts) vêm por último, como os de uma requisição do Quick Request.
  const steps = r.scripts === false ? scriptSteps(undefined, undefined, r.requestScripts) : scriptSteps(connector, endpoint, r.requestScripts)
  if (steps.length) {
    const denial = featureDenial('scripts')
    if (denial) return fail('POLICY_DENIED', denial)
    return runWithScripts(node, nodes, subs, steps, requestId, environmentId, ctx, fail, elapsed)
  }
  const scripted = r.fromScript ? scriptOutput(r.fromScript, nodes, ancestors) : undefined

  // Os campos do nó funcionam como os overrides de um cenário sobre o endpoint (ou sobre method + url).
  const urlEncode = (v: string) => encodeURIComponent(v)
  const mapValues = <T extends string | null>(obj: Record<string, T> | undefined, escape?: (v: string) => string) =>
    obj && Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v === null ? v : subs.text(v, escape)]))
  const overrides = {
    ...(r.headers && { headers: mapValues(r.headers) }),
    ...(r.query && { query: mapValues(r.query, urlEncode) }),
    ...(r.pathParams && { pathParams: rawAware(r.pathParams, r.rawPathParams, (v, raw) => subs.text(v, raw ? undefined : urlEncode)) }),
    ...(r.rawPathParams && { rawPathParams: r.rawPathParams }),
    ...(r.body !== undefined && { body: typeof r.body === 'string' ? subs.text(r.body) : subs.json(r.body) }),
    ...(r.payload && { payload: r.payload })
  }
  const built = buildScenarioRequest(
    {
      id: node.id,
      name: node.name,
      method,
      path: subs.text(path),
      ...(endpoint?.headers && { headers: endpoint.headers }),
      ...(endpoint?.query && { query: endpoint.query }),
      ...(endpoint?.body !== undefined && { body: endpoint.body }),
      ...(endpoint?.payload && { payload: endpoint.payload })
    },
    { overrides }
  )
  // Com conector, a URL mostrada já leva a baseUrl e o basePath (ainda com {{VAR}}), não só o caminho.
  // Com fromScript, a requisição é a que o script pre montou (os {{VAR}} dela ainda resolvem no envio).
  const final = scripted
    ? {
        method: scripted.method,
        url: withQueryParams(scripted.url, scripted.query),
        headers: Object.entries(scripted.headers).map(([name, value]) => ({ name, value })),
        body: scripted.body
      }
    : { method: built.method, url: built.url, headers: built.headers, body: built.body }
  const shown = displayUrl(final.url, subs.extra)
  const request = {
    method: final.method,
    url: connector?.baseUrl !== undefined && !/^[a-z][a-z0-9+.-]*:\/\//i.test(shown) ? withBase(shown, connector.baseUrl, connector.basePath) : shown
  }
  const extra = { ...ctx.variables, ...scripted?.variables, ...subs.extra }
  const send = async () => {
    const result = await sendHeadless(
      {
        id: requestId,
        method: final.method,
        url: final.url,
        headers: final.headers,
        ...(final.body !== undefined && { body: final.body }),
        ...(built.payload && { payload: built.payload }),
        ...(r.timeoutMs && { timeoutMs: r.timeoutMs }),
        ...(r.followRedirects !== undefined && { followRedirects: r.followRedirects }),
        ...(connector && { connectorId: connector.id }),
        ...(environmentId && { environmentId })
      },
      { workspace: ctx.workspace, auth: ctx.auth, http: ctx.http, signal: ctx.signal, ...(ctx.guard && { guard: ctx.guard }) },
      { ...built.options, extra }
    )
    ctx.onHttpResult?.(node.id, result)
    return result
  }

  const poll = r.poll
  const intervalMs = poll?.intervalMs ?? POLL_INTERVAL_MS
  const timeoutMs = poll?.timeoutMs ?? POLL_TIMEOUT_MS
  const maxAttempts = poll ? (poll.maxAttempts ?? Math.floor(timeoutMs / intervalMs) + 1) : 1
  const deadline = performance.now() + timeoutMs
  // A condição do polling lê a tentativa pelo nome do próprio nó, além dos anteriores.
  const visible = new Set([...ancestors, node.name])
  for (let attempt = 1; ; attempt++) {
    const result = await send()
    const extra = { request, ...(result.auth && { auth: result.auth }), ...(poll && { attempts: attempt }) }
    if (!result.ok) return fail(result.error.code, result.error.message, extra)

    const subject = toSubject(result.response)
    const output: NodeOutput = {
      data: subject.body ?? null,
      status: result.response.status,
      headers: headerRecord(result.response.headers),
      durationMs: result.response.timings.totalMs
    }
    const httpError = () =>
      result.response.status >= 400 && !r.ignoreHttpErrors
        ? fail('HTTP_STATUS', `HTTP ${result.response.status} ${result.response.statusText}`.trim(), { ...extra, output })
        : null
    if (!poll) return httpError() ?? { nodeId: node.id, name: node.name, status: 'success', durationMs: elapsed(), output, ...extra }

    const check = evaluateCondition(poll.until, { ...nodes, [node.name]: output }, visible, subs, node.name)
    if (check.passed) return httpError() ?? { nodeId: node.id, name: node.name, status: 'success', durationMs: elapsed(), output, ...extra }
    if (attempt >= maxAttempts || performance.now() + intervalMs > deadline) {
      // Sem maxAttempts, o limite de tentativas é só o tempo dividido pelo intervalo: o motivo é o tempo.
      const why = poll.maxAttempts !== undefined && attempt >= poll.maxAttempts ? `${attempt} tentativa${attempt > 1 ? 's' : ''}` : `${timeoutMs} ms`
      return fail('POLL_TIMEOUT', `a condição do polling não valeu em ${why}: ${check.message}`, { ...extra, output })
    }
    await sleep(intervalMs, ctx.signal)
  }
}

/** A saída de um script pre (javascript.request-script): a requisição que ele montou e as variáveis. */
function scriptOutput(name: string, nodes: NodesTree, ancestors: ReadonlySet<string>): ScriptRequest & { method: HttpMethod; variables: Record<string, string> } {
  if (!ancestors.has(name)) throw new ExpressionError(`fromScript: o nó ${name} não é anterior a este no grafo`)
  const data = nodes[name]?.data as { request?: Partial<ScriptRequest>; variables?: Record<string, string> } | undefined
  const req = data?.request
  if (!req || typeof req.url !== 'string') throw new ExpressionError(`fromScript: ${name} não devolveu uma requisição (é um script pre?)`)
  const method = String(req.method ?? 'GET').toUpperCase()
  if (!(HTTP_METHODS as readonly string[]).includes(method)) throw new ConfigError(`o script ${name} definiu um método HTTP inválido: ${method}`)
  const strings = (obj: unknown) =>
    Object.fromEntries(Object.entries(obj && typeof obj === 'object' ? obj : {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
  return {
    method: method as HttpMethod,
    url: req.url,
    headers: strings(req.headers),
    query: strings(req.query),
    ...(typeof req.body === 'string' && { body: req.body }),
    variables: strings(data?.variables)
  }
}

function withQueryParams(url: string, query: Record<string, string>): string {
  const pairs = Object.entries(query)
  if (!pairs.length) return url
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`
}

/**
 * Nó de requisição de um endpoint (ou conector) com scripts: roda o fluxo script → requisição →
 * script no mesmo motor, com os nós deste fluxo visíveis para a requisição. Os testes que não
 * passam falham o nó (ASSERTION_FAILED), e as variáveis definidas valem para os nós seguintes.
 */
async function runWithScripts(
  node: FlowRequestNode,
  nodes: NodesTree,
  subs: Substitutions,
  steps: ReturnType<typeof scriptSteps>,
  requestId: string,
  environmentId: string | undefined,
  ctx: FlowRunContext,
  fail: (code: FlowErrorCode, message: string, extra?: Partial<FlowNodeResult>) => FlowNodeResult,
  elapsed: () => number
): Promise<FlowNodeResult> {
  const r = node.request
  const connector = r.connector ? resolveConnector(r.connector, ctx.workspace.connectors) : undefined
  const endpoint = r.endpoint ? connector?.endpoints.find((e) => e.id === r.endpoint) : undefined
  const fill = (text: string) => text.replace(/\{\{(\$flow:\d+)\}\}/g, (whole, key: string) => subs.extra[key] ?? whole)
  // O que o primeiro script vê: a requisição do nó com os valores de $nodes já no lugar.
  const built = buildScenarioRequest(
    {
      id: node.id,
      name: node.name,
      method: r.method ?? endpoint!.method,
      path: subs.text(r.url ?? endpoint!.path),
      ...(endpoint?.headers && { headers: endpoint.headers }),
      ...(endpoint?.query && { query: endpoint.query }),
      ...(endpoint?.body !== undefined && { body: endpoint.body })
    },
    {
      overrides: {
        ...(r.headers && { headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, v === null ? v : subs.text(v)])) }),
        ...(r.query && { query: Object.fromEntries(Object.entries(r.query).map(([k, v]) => [k, v === null ? v : subs.text(v, encodeURIComponent)])) }),
        ...(r.pathParams && { pathParams: rawAware(r.pathParams, r.rawPathParams, (v, raw) => subs.text(v, raw ? undefined : encodeURIComponent)) }),
        ...(r.rawPathParams && { rawPathParams: r.rawPathParams }),
        ...(r.body !== undefined && { body: typeof r.body === 'string' ? subs.text(r.body) : subs.json(r.body) })
      }
    }
  )
  const template: ScriptRequest = {
    method: built.method,
    url: fill(built.url),
    headers: Object.fromEntries(built.headers.map((h) => [h.name, fill(h.value)])),
    query: {},
    ...(built.body !== undefined && { body: fill(built.body) })
  }
  const variables = ctx.variables ?? {}
  const { scripts: _scripts, fromScript: _from, requestScripts: _own, ...request } = r
  const flow = scriptFlow({
    request,
    template,
    steps,
    environment: scriptEnvironment(ctx.workspace, environmentId),
    variables
  })
  let response: HttpResult | undefined
  const started = performance.now()
  const report = await runFlow(
    // Ids <execução>:<nó>:<nó do script>: o histórico e o cancelamento acham as requisições pelo prefixo.
    { runId: requestId, flow, ...(environmentId && { environmentId }) },
    { ...ctx, onEvent: undefined, parentNodes: nodes, variables, onHttpResult: (id, result) => id === 'request' && (response = result) }
  )
  const result = scriptResult(flow, steps, report.results, response, Math.round(performance.now() - started))
  const usage = result.scripts!
  Object.assign(variables, usage.variables)
  const inner = report.results.find((x) => x.name === REQUEST_NODE)
  const extra: Partial<FlowNodeResult> = {
    ...(inner?.request && { request: inner.request }),
    ...(inner?.auth && { auth: inner.auth }),
    ...(usage.logs && { logs: usage.logs }),
    ...(usage.tests.length && { tests: usage.tests })
  }
  if (!result.ok) return fail(result.error.code, result.error.message, extra)
  if (!inner?.output) return fail('SCRIPT_ERROR', 'o fluxo dos scripts não devolveu a resposta', extra)
  const output = inner.output
  if (usage.error) return fail('SCRIPT_ERROR', `script ${usage.error.script}: ${usage.error.message}`, { ...extra, output })
  const failedTest = usage.tests.find((t) => !t.passed)
  if (failedTest) return fail('ASSERTION_FAILED', `teste "${failedTest.name}": ${failedTest.message}`, { ...extra, output })
  if (output.status !== undefined && output.status >= 400 && !r.ignoreHttpErrors) {
    return fail('HTTP_STATUS', `HTTP ${output.status}`, { ...extra, output })
  }
  return { nodeId: node.id, name: node.name, status: 'success', durationMs: elapsed(), output, ...extra }
}

function withBase(url: string, baseUrl: string, basePath: string): string {
  const i = url.indexOf('?')
  const joined = joinPath(baseUrl, basePath, i < 0 ? url : url.slice(0, i))
  return i < 0 ? joined : `${joined}${url.slice(i)}`
}

/** Espera que o cancelamento do fluxo interrompe. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A URL mostrada ao renderer: valores de $nodes entram (já são do renderer); {{VAR}} do ambiente não. */
function displayUrl(url: string, extra: Readonly<Record<string, string>>): string {
  return url.replace(/\{\{(\$flow:\d+)\}\}/g, (whole, key: string) => extra[key] ?? whole)
}

/** Avalia uma condição sobre a árvore $nodes; `visible` são os nós que ela pode ler. */
function evaluateCondition(condition: FlowCondition, nodes: NodesTree, visible: ReadonlySet<string>, subs: Substitutions, reader: string) {
  const { target, operator } = condition
  // Um nó anterior que foi pulado só não tem saída (exists dá false); um nó que não é anterior é erro.
  const name = /^\$nodes\.([A-Za-z_][A-Za-z0-9_]*)/.exec(target)?.[1] ?? ''
  if (!visible.has(name)) throw new ExpressionError(`${target}: o nó ${name} não é anterior a ${reader} no grafo`)
  const expected = subs.value(condition.expected)
  // O motor de asserções dos cenários lê body.<caminho>; aqui o "corpo" é a árvore $nodes.
  const path = target.slice('$nodes'.length)
  const assertion = evaluateAssertion(
    { target: `body${path}`, operator, ...(expected !== undefined && { expected }) },
    { status: 0, responseTimeMs: 0, headers: [], body: nodes, bodyIsJson: true, truncated: false }
  )
  return { passed: assertion.passed, message: assertion.message.replaceAll(`body${path}`, target), actual: assertion.actual }
}

/**
 * Espera o primeiro evento do servidor de webhooks que o nó aceita (hook, caminho, método
 * e a condição until sobre o próprio evento), desde o início da execução ou desde o
 * evento que disparou o fluxo. Cada evento serve a um nó só por execução.
 */
async function runWebhookNode(
  node: FlowWebhookNode,
  nodes: NodesTree,
  ancestors: ReadonlySet<string>,
  subs: Substitutions,
  elsewhere: ReadonlySet<string>,
  ctx: FlowRunContext,
  run: WebhookRun,
  fail: (code: FlowErrorCode, message: string, extra?: Partial<FlowNodeResult>) => FlowNodeResult,
  elapsed: () => number
): Promise<FlowNodeResult> {
  const w = node.webhook
  if (!ctx.webhooks) {
    return fail('WEBHOOK_UNAVAILABLE', ctx.webhooksError ?? 'não há servidor de webhooks nesta execução (ligue-o no app ou use vvpost run, que o liga sozinho)')
  }
  const path = w.path !== undefined ? resolveWebhookPath(w.path, nodes, elsewhere) : undefined
  const visible = new Set([...ancestors, node.name])
  // Erros de expressão da condição aparecem já, não depois de esperar o tempo todo.
  if (w.until) evaluateCondition(w.until, { ...nodes, [node.name]: { data: null } }, visible, subs, node.name)
  const accept = (event: WebhookEvent) => {
    if (w.hook !== undefined && event.hookId !== w.hook) return false
    if (path !== undefined && !pathMatches(path, event.path)) return false
    if (w.method !== undefined && event.method !== w.method) return false
    if (!w.until) return true
    try {
      return evaluateCondition(w.until, { ...nodes, [node.name]: webhookOutput(event) }, visible, subs, node.name).passed
    } catch {
      return false
    }
  }
  const timeoutMs = w.timeoutMs ?? WEBHOOK_TIMEOUT_MS
  const event = await ctx.webhooks.wait(accept, { since: run.since, timeoutMs, skip: run.taken, ...(ctx.signal && { signal: ctx.signal }) })
  if (!event) {
    const what = [w.method, w.hook && `hook ${w.hook}`, path].filter(Boolean).join(' ') || 'qualquer evento'
    return fail('WEBHOOK_TIMEOUT', `nenhum evento (${what}${w.until ? ` com ${w.until.target} ${w.until.operator}` : ''}) chegou em ${timeoutMs} ms`)
  }
  run.taken.add(event.id)
  return {
    nodeId: node.id,
    name: node.name,
    status: 'success',
    durationMs: elapsed(),
    output: webhookOutput(event),
    // O que chegou, no lugar da requisição montada dos outros nós.
    ...((HTTP_METHODS as readonly string[]).includes(event.method) && { request: { method: event.method as HttpMethod, url: event.url } })
  }
}

function runCondition(
  node: FlowConditionNode,
  nodes: NodesTree,
  ancestors: ReadonlySet<string>,
  subs: Substitutions,
  fail: (code: FlowErrorCode, message: string, extra?: Partial<FlowNodeResult>) => FlowNodeResult,
  elapsed: () => number
): FlowNodeResult {
  const { passed, message, actual } = evaluateCondition(node.condition, nodes, ancestors, subs, node.name)
  const output = { data: { result: passed, message, ...(actual !== undefined && { actual }) } }
  if (!passed && node.failWhenFalse) return fail('ASSERTION_FAILED', message, { output })
  return { nodeId: node.id, name: node.name, status: 'success', durationMs: elapsed(), output }
}

async function runPythonNode(
  node: FlowPythonNode,
  nodes: NodesTree,
  ctx: FlowRunContext,
  fail: (code: FlowErrorCode, message: string, extra?: Partial<FlowNodeResult>) => FlowNodeResult
): Promise<FlowNodeResult> {
  const denial = featureDenial('pythonNode')
  if (denial) return fail('POLICY_DENIED', denial, { error: { code: 'POLICY_DENIED', message: denial, property: 'python.code' } })
  const outcome = await runPython(node.python.code, nodes, {
    ...(node.python.timeoutMs && { timeoutMs: node.python.timeoutMs }),
    ...(node.python.network && { network: node.python.network }),
    ...(node.python.version && { version: node.python.version }),
    ...(ctx.signal && { signal: ctx.signal }),
    ...ctx.python
  })
  const extra = { ...(outcome.logs && { logs: outcome.logs }), ...(outcome.python && { python: outcome.python }) }
  if (!outcome.ok) {
    const code: FlowErrorCode = outcome.code === 'ABORTED' ? 'ABORTED' : outcome.code === 'TIMEOUT' ? 'TIMEOUT' : outcome.code
    return { ...fail(code, outcome.message, extra), durationMs: outcome.durationMs }
  }
  return { nodeId: node.id, name: node.name, status: 'success', durationMs: outcome.durationMs, output: { data: outcome.output }, ...extra }
}

/** Aplica `fill` em cada pathParam, dizendo se ele está em rawPathParams (vai sem codificar). */
function rawAware(params: Record<string, string>, raw: string[] | undefined, fill: (value: string, raw: boolean) => string): Record<string, string> {
  const set = new Set(raw ?? [])
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, fill(v, set.has(k))]))
}
