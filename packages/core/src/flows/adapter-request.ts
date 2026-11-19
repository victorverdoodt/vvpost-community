import { STATUS_CODES } from 'node:http'
import type { FlowPluginNode } from '@vvpost/schemas'
import type { FlowErrorCode, FlowNodeResult, HttpErrorCode, HttpHeader, HttpResult } from '../types'
import type { AuthEngine } from '../connectors/auth'
import { ConfigError } from '../connectors/errors'
import type { LoadedWorkspace } from '../connectors/workspace'
import type { HttpDispatcher } from '../http/dispatcher'
import type { FlowPluginRunner } from '../plugins/manager'
import { ExpressionError } from './expressions'
import { runPluginNode } from './plugin-node'

/**
 * Protocolo de plugin fora do Flow Studio (Quick Request e cenários): a chamada passa pelo
 * mesmo caminho do nó de plugin com adapter (sandbox, regras de rede, credenciais do
 * conector, limites do ctx.http) e a saída { data, status, headers } vira uma resposta
 * HTTP, para o visualizador de resposta e as asserções dos cenários.
 */

export interface AdapterRequestInput {
  /** Id da chamada; as requisições do plugin pelo host saem como `<id>:<n>`. */
  id: string
  adapter: string
  config?: Record<string, unknown>
  connectorId?: string
  environmentId?: string
  timeoutMs?: number
  /** Valores para {{nome}} nos textos da config (o capture de um cenário: {{$capture.token}}). */
  values?: Record<string, string>
}

export interface AdapterRequestContext {
  workspace: LoadedWorkspace
  auth: AuthEngine
  http: Pick<HttpDispatcher, 'send' | 'cancel'>
  /** Sem plugins carregados, a chamada volta com PLUGIN_UNAVAILABLE. */
  plugins?: FlowPluginRunner
  signal?: AbortSignal
}

const HTTP_CODES = new Set<string>([
  'INVALID_URL',
  'ABORTED',
  'TIMEOUT',
  'CONNECTION_REFUSED',
  'DNS_FAILURE',
  'TLS_FAILURE',
  'INVALID_REQUEST',
  'NETWORK_ERROR',
  'AUTH_FAILED',
  'CONFIG_ERROR',
  'POLICY_DENIED',
  'PREPARE_FAILED',
  'PLUGIN_UNAVAILABLE',
  'PLUGIN_ERROR',
  'PLUGIN_CRASHED'
] satisfies HttpErrorCode[])

const toHttpCode = (code: FlowErrorCode): HttpErrorCode =>
  HTTP_CODES.has(code) ? (code as HttpErrorCode) : code === 'EXPRESSION_ERROR' ? 'CONFIG_ERROR' : 'PLUGIN_ERROR'

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Troca {{nome}} pelos valores em todo texto da config; o resto (como {{VAR}} do ambiente) fica. */
function fill(value: unknown, values: Record<string, string>, used: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(TEMPLATE, (whole, name: string) => {
      if (!Object.hasOwn(values, name)) return whole
      used.add(values[name]!)
      return values[name]!
    })
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, values, used))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, values, used)]))
  return value
}

/** Chama o adapter `input.adapter` com a config e devolve o resultado no formato do Quick Request. */
export async function runAdapterRequest(input: AdapterRequestInput, ctx: AdapterRequestContext): Promise<HttpResult> {
  const used = new Set<string>()
  const config = input.config && input.values ? (fill(input.config, input.values, used) as Record<string, unknown>) : input.config
  const node: FlowPluginNode = {
    id: 'request',
    name: input.adapter,
    type: 'plugin',
    plugin: {
      adapter: input.adapter,
      ...(input.connectorId && { connector: input.connectorId }),
      ...(config && { config }),
      ...(input.timeoutMs && { timeoutMs: input.timeoutMs }),
      // 4xx/5xx é uma resposta como no HTTP: quem decide é quem lê (o usuário, as asserções).
      ignoreHttpErrors: true
    }
  }
  const fail = (code: FlowErrorCode, message: string, extra?: Partial<FlowNodeResult>): FlowNodeResult => ({
    nodeId: node.id,
    name: node.name,
    status: 'error',
    durationMs: 0,
    error: { code, message },
    ...extra
  })
  let result: FlowNodeResult
  try {
    result = await runPluginNode(
      node,
      {},
      new Set(),
      input.id,
      input.environmentId,
      {
        workspace: ctx.workspace,
        auth: ctx.auth,
        http: ctx.http,
        ...(ctx.signal && { signal: ctx.signal }),
        ...(ctx.plugins && { plugins: ctx.plugins })
      },
      fail,
      { tainted: used }
    )
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ExpressionError) result = fail('CONFIG_ERROR', err.message)
    else if (ctx.signal?.aborted) result = fail('ABORTED', 'execução cancelada')
    else throw err
  }

  const plugin = { adapter: input.adapter, ...(result.logs && { logs: result.logs }) }
  const auth = result.auth && { auth: result.auth }
  if (result.status !== 'success' || !result.output) {
    const error = result.error ?? { code: 'PLUGIN_ERROR' as const, message: 'o adapter não devolveu resultado' }
    const code = ctx.signal?.aborted ? 'ABORTED' : toHttpCode(error.code)
    return { ok: false, error: { code, message: error.message }, timings: { totalMs: result.durationMs }, plugin, ...auth }
  }

  const { data, status = 200, headers = {}, durationMs = result.durationMs } = result.output
  const list: HttpHeader[] = Object.entries(headers).map(([name, value]) => ({ name, value }))
  // data em texto vai como está; o resto vira JSON, e a resposta se mostra como JSON.
  const body = typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2)
  if (typeof data !== 'string' && !Object.hasOwn(headers, 'content-type')) list.push({ name: 'content-type', value: 'application/json' })
  return {
    ok: true,
    response: {
      status,
      statusText: STATUS_CODES[status] ?? '',
      headers: list,
      body,
      sizeBytes: Buffer.byteLength(body),
      truncated: false,
      timings: { ttfbMs: durationMs, downloadMs: 0, totalMs: durationMs }
    },
    plugin,
    ...auth
  }
}
