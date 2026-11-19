import type { FlowPluginNode, PluginField } from '@vvpost/schemas'
import type { AuthUsage, FlowErrorCode, FlowNodeResult, HttpHeader, HttpMethod } from '../types'
import { AuthError, ConfigError } from '../connectors/errors'
import { resolveConnection, sendHeadless, type ConnectorConnection } from '../connectors/headless'
import { resolveConnector } from '../connectors/resolve'
import { interpolate } from '../connectors/template'
import { environmentValues } from '../connectors/workspace'
import { callNetworkRules } from '../sandbox/network-rules'
import type { FlowPluginRunner } from '../plugins/manager'
import { PLUGIN_POLICY_DEFAULTS, createRequestGuard } from '../policy/request-policy'
import { isHttpMethod, type PluginHttpRequest, type PluginHttpResult } from '../plugins/protocol'
import { exactReference, readRequired, stringify, type NodeOutput, type NodesTree } from './expressions'
import type { FlowRunContext } from './run'

/** Tempo padrão de uma chamada de plugin. */
export const PLUGIN_TIMEOUT_MS = 30_000

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Headers da resposta por nome em minúsculas; repetidos são juntados com ", ". */
export function headerRecord(headers: HttpHeader[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { name, value } of headers) {
    const key = name.toLowerCase()
    out[key] = key in out ? `${out[key]}, ${value}` : value
  }
  return out
}

/** Todo texto dentro de um valor que contém "{{": dado de resposta que não pode virar {{VAR}} do ambiente. */
function collectTemplated(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (value.includes('{{')) into.add(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectTemplated(v, into)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectTemplated(v, into)
  }
}

/**
 * {{ $nodes... }} na configuração: um texto que é só a referência vira o valor (com o
 * tipo dele); no meio de um texto, entra como texto. {{VAR}} do ambiente fica como
 * está: só o host resolve, ao enviar uma requisição do plugin. Textos vindos de
 * $nodes que contêm "{{" vão para `tainted`, para não serem interpolados no envio.
 */
export function resolveTemplates(
  value: unknown,
  nodes: NodesTree,
  elsewhere: ReadonlySet<string>,
  tainted: Set<string>
): unknown {
  if (typeof value === 'string') {
    const exact = exactReference(value)
    if (exact !== undefined) {
      const resolved = readRequired(exact, nodes, elsewhere)
      collectTemplated(resolved, tainted)
      return resolved
    }
    return value.replace(TEMPLATE, (whole, inner: string) => {
      if (!inner.trim().startsWith('$nodes')) return whole
      const text = stringify(readRequired(inner, nodes, elsewhere))
      collectTemplated(text, tainted)
      return text
    })
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, nodes, elsewhere, tainted))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, nodes, elsewhere, tainted)]))
  }
  return value
}

/** Config do nó com os defaults do manifesto, as referências resolvidas e o tipo de cada campo conferido. */
export function buildPluginConfig(
  fields: readonly PluginField[],
  raw: Record<string, unknown> | undefined,
  nodes: NodesTree,
  elsewhere: ReadonlySet<string>,
  tainted: Set<string>
): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const field of fields) {
    let value = raw && Object.hasOwn(raw, field.key) ? raw[field.key] : field.default
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new ConfigError(`o campo "${field.label}" é obrigatório`)
      continue
    }
    if (field.templates !== false) value = resolveTemplates(value, nodes, elsewhere, tainted)
    const problem = typeProblem(field, value)
    if (problem) throw new ConfigError(`o campo "${field.label}" ${problem}`)
    config[field.key] = value
  }
  return config
}

function typeProblem(field: PluginField, value: unknown): string | null {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'code':
      return typeof value === 'string' ? null : 'precisa ser texto'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'precisa ser um número'
    case 'boolean':
      return typeof value === 'boolean' ? null : 'precisa ser true ou false'
    case 'select':
      return field.options?.some((o) => o.value === value) ? null : `precisa ser um de ${field.options?.map((o) => o.value).join(', ')}`
    case 'json':
      return null
  }
}

/**
 * Troca cada texto vindo de $nodes que contém "{{" por um marcador já resolvido,
 * para o envio não interpolar de novo: um "{{API_TOKEN}}" devolvido por uma API não
 * vira o segredo do ambiente (a mesma regra do nó de requisição).
 */
function shield(text: string, tainted: ReadonlySet<string>, extra: Record<string, string>): string {
  let out = text
  for (const value of tainted) {
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])) {
      if (!out.includes(form)) continue
      const key = `$plugin:${Object.keys(extra).length}`
      extra[key] = form
      out = out.split(form).join(`{{${key}}}`)
    }
  }
  return out
}

/** Roda um nó de plugin: resolve a contribuição, monta a config e chama o processo do plugin. */
export async function runPluginNode(
  node: FlowPluginNode,
  nodes: NodesTree,
  elsewhere: ReadonlySet<string>,
  requestId: string,
  environmentId: string | undefined,
  ctx: FlowRunContext,
  fail: (code: FlowErrorCode, message: string, extra?: Partial<FlowNodeResult>) => FlowNodeResult,
  /** Textos vindos de respostas que já estão na config (capture de um cenário): também não viram {{VAR}} no envio. */
  options: { tainted?: Iterable<string> } = {}
): Promise<FlowNodeResult> {
  const p = node.plugin
  const kind = p.node ? 'node' : 'adapter'
  const name = (p.node ?? p.adapter)!
  const found = ctx.plugins ? ctx.plugins.find(kind, name) : 'nenhum plugin carregado'
  if (typeof found === 'string') return fail('PLUGIN_UNAVAILABLE', found)
  if ('denied' in found) return fail('POLICY_DENIED', found.denied)
  const connector = p.connector ? resolveConnector(p.connector, ctx.workspace.connectors) : undefined

  // Textos com "{{" na saída dos nós anteriores: chegam ao plugin pela config ou por ctx.nodes, e não podem virar {{VAR}} no envio.
  const tainted = new Set<string>()
  collectTemplated(nodes, tainted)
  for (const text of options.tainted ?? []) collectTemplated(text, tainted)
  const config = buildPluginConfig(found.contribution.fields, p.config, nodes, elsewhere, tainted)
  const timeoutMs = p.timeoutMs ?? PLUGIN_TIMEOUT_MS
  // Regras de rede da chamada: "connector" vira o host da baseUrl resolvida, "config:<campo>" os hosts do campo.
  let network: string[] | undefined
  if (found.network.some((r) => r === 'connector' || r.startsWith('config:'))) {
    let baseUrl: string | undefined
    if (connector?.baseUrl !== undefined) {
      const { values, missingSecrets } = environmentValues(ctx.workspace, environmentId)
      try {
        baseUrl = interpolate(connector.baseUrl, { values, missingSecrets })
      } catch {
        baseUrl = undefined
      }
    }
    network = callNetworkRules(found.network, config, baseUrl)
  }

  // Limites por execução do nó: um plugin em laço não dispara sem fim pelo host.
  const guard = createRequestGuard({ actor: `o plugin ${found.pluginId}`, ...PLUGIN_POLICY_DEFAULTS })
  let sent = 0
  let lastRequest: { method: HttpMethod; url: string } | undefined
  let lastAuth: AuthUsage | undefined
  const onHttp = async (request: PluginHttpRequest, signal: AbortSignal): Promise<PluginHttpResult> => {
    if (!isHttpMethod(request.method)) return { ok: false, error: { code: 'INVALID_REQUEST', message: `método HTTP inválido: ${request.method}` } }
    const id = `${requestId}:${sent++}`
    const extra: Record<string, string> = {}
    const onAbort = () => ctx.http.cancel(id)
    signal.addEventListener('abort', onAbort, { once: true })
    lastRequest = { method: request.method, url: request.url }
    try {
      const result = await sendHeadless(
        {
          id,
          method: request.method,
          url: shield(request.url, tainted, extra),
          headers: request.headers.map((h) => ({ name: h.name, value: shield(h.value, tainted, extra) })),
          ...(request.body !== undefined && { body: shield(request.body, tainted, extra) }),
          ...(request.timeoutMs && { timeoutMs: request.timeoutMs }),
          ...(connector && { connectorId: connector.id }),
          ...(environmentId && { environmentId })
        },
        { workspace: ctx.workspace, auth: ctx.auth, http: ctx.http, signal, guard },
        { extra }
      )
      if (result.auth) lastAuth = result.auth
      if (!result.ok) return { ok: false, error: result.error }
      const r = result.response
      return {
        ok: true,
        response: {
          status: r.status,
          statusText: r.statusText,
          headers: headerRecord(r.headers),
          body: r.body,
          truncated: r.truncated,
          durationMs: r.timings.totalMs
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  // Protocolo próprio (gRPC, Kafka): o adapter recebe a conexão resolvida do conector, e só conecta aos hosts do nó.
  let connection: ConnectorConnection | undefined
  if (kind === 'adapter' && found.connectorCredentials && connector) {
    try {
      connection = await resolveConnection(connector.id, environmentId, { workspace: ctx.workspace, auth: ctx.auth, http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) })
    } catch (err) {
      if (err instanceof AuthError) return fail('AUTH_FAILED', err.message)
      throw err
    }
  }

  const outcome = await ctx.plugins!.invoke(found.pluginId, {
    kind,
    name,
    context: {
      config,
      nodes: nodes as Record<string, NodeOutput>,
      node: { id: node.id, name: node.name },
      timeoutMs,
      ...(connector && { connector: connector.id }),
      ...(network && { network }),
      ...(connection && { connection })
    },
    ...(ctx.signal && { signal: ctx.signal }),
    onHttp
  })
  const extra: Partial<FlowNodeResult> = {
    ...(outcome.logs && { logs: outcome.logs }),
    ...(lastRequest && { request: lastRequest }),
    ...(lastAuth && { auth: lastAuth })
  }
  if (!outcome.ok) return { ...fail(outcome.code, outcome.message, extra), durationMs: outcome.durationMs }

  const base = { nodeId: node.id, name: node.name, status: 'success' as const, durationMs: outcome.durationMs, ...extra }
  if (kind === 'node') return { ...base, output: { data: outcome.value } }

  // Adapter: { data, status?, headers? }, como a saída de uma requisição.
  const value = outcome.value as { data?: unknown; status?: unknown; headers?: unknown } | null
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('data' in value)) {
    return { ...fail('PLUGIN_ERROR', `o adapter ${name} devolveu algo sem "data"`, extra), durationMs: outcome.durationMs }
  }
  const status = typeof value.status === 'number' ? value.status : undefined
  const headers =
    value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
      ? Object.fromEntries(Object.entries(value.headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
      : undefined
  const output: NodeOutput = {
    data: value.data ?? null,
    ...(status !== undefined && { status }),
    ...(headers && { headers }),
    durationMs: outcome.durationMs
  }
  if (status !== undefined && status >= 400 && !p.ignoreHttpErrors) {
    return { ...fail('HTTP_STATUS', `HTTP ${status}`, { ...extra, output }), durationMs: outcome.durationMs }
  }
  return { ...base, output }
}
