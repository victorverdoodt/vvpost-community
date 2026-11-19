import type { Flow } from '@vvpost/schemas'
import type { HttpRequestInput, HttpResult } from '../types'
import type { AuthEngine } from '../connectors/auth'
import type { HeadlessOptions } from '../connectors/headless'
import { resolveConnector } from '../connectors/resolve'
import type { LoadedWorkspace } from '../connectors/workspace'
import type { HttpDispatcher } from '../http/dispatcher'
import type { FlowPluginRunner } from '../plugins/manager'
import { featureDenial } from '../policy/features'
import type { RequestGuard } from '../policy/request-policy'
import { scriptEnvironment, scriptFlow, scriptRequest, scriptResult, scriptSteps, type ScriptStep } from './request-scripts'
import { runFlow } from './run'

export interface ScriptedContext {
  workspace: LoadedWorkspace
  auth: AuthEngine
  http: Pick<HttpDispatcher, 'send' | 'cancel'>
  /** O runtime do vvpost-plugin-javascript; sem ele, o script falha com SCRIPT_ERROR. */
  plugins?: FlowPluginRunner
  signal?: AbortSignal
  guard?: RequestGuard
  /** Variáveis que scripts anteriores definiram (sessão do app, lote de cenários). */
  variables?: Record<string, string>
}

/** Os scripts que valem para a requisição: do conector, do endpoint e os dela. */
export function stepsFor(input: Pick<HttpRequestInput, 'connectorId' | 'endpointId' | 'scripts'>, ws: LoadedWorkspace): ScriptStep[] {
  let connector
  try {
    connector = input.connectorId ? resolveConnector(input.connectorId, ws.connectors) : undefined
  } catch {
    // Conector com erro: o envio normal mostra o erro dele.
    return []
  }
  const endpoint = input.endpointId ? connector?.endpoints.find((e) => e.id === input.endpointId) : undefined
  return scriptSteps(connector, endpoint, input.scripts)
}

/** O fluxo que roda por trás de uma requisição com scripts ("Ver como fluxo"), sem valores do ambiente. */
export function requestScriptFlow(input: HttpRequestInput, ws: LoadedWorkspace, steps = stepsFor(input, ws)): Flow {
  return scriptFlow(
    {
      request: {
        method: input.method,
        url: input.url,
        ...(input.connectorId && { connector: input.connectorId }),
        ...(input.payload && { payload: input.payload }),
        ...(input.timeoutMs && { timeoutMs: input.timeoutMs }),
        ...(input.followRedirects !== undefined && { followRedirects: input.followRedirects })
      },
      template: scriptRequest(input),
      steps
    },
    'flow.request-scripts',
    `Scripts de ${input.method} ${input.url}`.slice(0, 120)
  )
}

/**
 * Envia uma requisição com scripts pelo motor do Flow Studio: o fluxo script → requisição →
 * script roda com o mesmo dispatcher, auth e plugins, e volta como a resposta do nó de
 * requisição com o que os scripts fizeram em `scripts`. null quando nenhum script vale.
 * As requisições do fluxo têm ids `<id da requisição>:<nó>`, achados pelo prefixo no histórico.
 */
export async function sendWithScripts(input: HttpRequestInput, ctx: ScriptedContext, options: HeadlessOptions = {}): Promise<HttpResult | null> {
  const steps = stepsFor(input, ctx.workspace)
  if (!steps.length) return null
  // Scripts desligados pela organização: a requisição não sai sem eles (o pre pode montar a auth).
  const denial = featureDenial('scripts')
  if (denial) return { ok: false, error: { code: 'POLICY_DENIED', message: denial }, timings: { totalMs: 0 } }
  const base = requestScriptFlow(input, ctx.workspace, steps)
  const variables = { ...ctx.variables, ...options.extra }
  const environment = scriptEnvironment(ctx.workspace, input.environmentId)
  // Em execução, os scripts recebem as variáveis do ambiente (segredos como {{NOME}}) e as da sessão.
  const flow = scriptFlow(
    {
      request: (base.nodes.find((n) => n.type === 'request') as Extract<Flow['nodes'][number], { type: 'request' }>).request,
      template: scriptRequest(input),
      steps,
      environment,
      variables
    },
    base.id,
    base.name
  )
  let response: HttpResult | undefined
  const started = performance.now()
  const report = await runFlow(
    { runId: input.id, flow, ...(input.environmentId && { environmentId: input.environmentId }) },
    {
      workspace: ctx.workspace,
      auth: ctx.auth,
      http: ctx.http,
      ...(ctx.plugins && { plugins: ctx.plugins }),
      ...(ctx.signal && { signal: ctx.signal }),
      ...(ctx.guard && { guard: ctx.guard }),
      variables,
      onHttpResult: (id, result) => {
        if (id === 'request') response = result
      }
    }
  )
  if (report.error && !response) {
    return { ok: false, error: { code: 'SCRIPT_ERROR', message: report.error }, timings: { totalMs: report.durationMs } }
  }
  return scriptResult(flow, steps, report.results, response, Math.round(performance.now() - started))
}
