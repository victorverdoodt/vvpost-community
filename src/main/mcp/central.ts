import { basename } from 'node:path'
import type { HttpMethod } from '@shared/ipc'
import { MCP_POLICY_DEFAULTS, type RequestPolicy } from '@vvpost/core/policy/request-policy'
import type { AgentPolicyState, AgentReviewRequest, AgentSession, AgentToolCallEvent } from '../enterprise/control-plane'
import { applyApprovedReview, reviewSnapshot, setReviewRequest } from '../project/review'
import { EnterpriseModuleMissingError, loadEnterpriseModule, type EnterpriseSecretsModule, type OrganizationRef } from '../secret-engine/backend'

/**
 * Política do agente vinda do Control Plane (módulo Enterprise), aplicada por cima das flags locais
 * do mcp.js (docs/mcp.md, "Política central"). A central só restringe: cada limite é o mais
 * restrito entre o que a flag pediu e o que a política manda. Sem política válida (sem login,
 * Control Plane fora, cache vencido), o servidor fica no modo mais restrito: lê o catálogo e os
 * documentos, mas não envia nada para as APIs nem grava no projeto.
 */

/** O que as flags locais (ou o app) pediram. */
export interface LocalAgentLimits {
  readOnly?: boolean
  noWrite?: boolean
  allowMethods?: ReadonlySet<HttpMethod>
  allowEnvironments?: ReadonlySet<string>
  limits?: Pick<RequestPolicy, 'rate' | 'maxConcurrent' | 'maxTimeoutMs'>
}

export interface EffectiveAgentPolicy {
  readOnly: boolean
  noWrite: boolean
  allowMethods?: ReadonlySet<HttpMethod>
  allowEnvironments?: ReadonlySet<string>
  limits: { rate: { requests: number; perMs: number }; maxConcurrent: number; maxTimeoutMs: number }
  /** Ambientes protegidos pela política, além dos marcados no arquivo (ou que parecem produção). */
  protectedEnvironments?: ReadonlySet<string>
  /** A revisão de auth, destino e código é aprovada no console; a local é recusada. */
  centralReview: boolean
  /** A política liga a detecção de dados pessoais pelo formato. */
  piiDetect: boolean
  /** Por que a política central restringiu, para as mensagens de erro; ausente quando não restringe nada. */
  restrictedBy?: string
  /** Muda quando os limites mudam: o servidor recria o guard (taxa e concorrência). */
  key: string
}

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function intersect<T>(a: ReadonlySet<T> | undefined, b: ReadonlySet<T> | undefined): ReadonlySet<T> | undefined {
  if (!a) return b
  if (!b) return a
  return new Set([...a].filter((x) => b.has(x)))
}

/** O que vale agora: as flags locais cruzadas com a política central. */
export function effectiveAgentPolicy(local: LocalAgentLimits, state: AgentPolicyState): EffectiveAgentPolicy {
  const base = {
    rate: local.limits?.rate ?? MCP_POLICY_DEFAULTS.rate,
    maxConcurrent: local.limits?.maxConcurrent ?? MCP_POLICY_DEFAULTS.maxConcurrent,
    maxTimeoutMs: local.limits?.maxTimeoutMs ?? MCP_POLICY_DEFAULTS.maxTimeoutMs
  }
  let out: Omit<EffectiveAgentPolicy, 'key'>
  if (state.status === 'unavailable') {
    out = {
      readOnly: true,
      noWrite: true,
      allowMethods: new Set(),
      allowEnvironments: new Set(),
      limits: base,
      centralReview: true,
      piiDetect: true,
      restrictedBy: `política do agente indisponível (${state.reason}): modo mais restrito até o Control Plane responder`
    }
  } else if (state.status === 'none') {
    out = {
      readOnly: !!local.readOnly,
      noWrite: !!local.noWrite,
      ...(local.allowMethods && { allowMethods: local.allowMethods }),
      ...(local.allowEnvironments && { allowEnvironments: local.allowEnvironments }),
      limits: base,
      centralReview: false,
      piiDetect: false
    }
  } else {
    const p = state.policy
    const methods = p.allowMethods && new Set(p.allowMethods.map((m) => m.toUpperCase()).filter((m): m is HttpMethod => METHODS.includes(m as HttpMethod)))
    const rate = p.requestsPerMinute !== undefined && p.requestsPerMinute < base.rate.requests * (60_000 / base.rate.perMs) ? { requests: p.requestsPerMinute, perMs: 60_000 } : base.rate
    const allowMethods = intersect(local.allowMethods, methods)
    const allowEnvironments = intersect(local.allowEnvironments, p.allowEnvironments && new Set(p.allowEnvironments))
    out = {
      readOnly: !!local.readOnly || p.readOnly === true,
      noWrite: !!local.noWrite || p.noWrite === true,
      ...(allowMethods && { allowMethods }),
      ...(allowEnvironments && { allowEnvironments }),
      limits: { ...base, rate, maxConcurrent: Math.min(base.maxConcurrent, p.maxConcurrent ?? Infinity) },
      ...(p.protectedEnvironments?.length && { protectedEnvironments: new Set(p.protectedEnvironments) }),
      centralReview: (p.reviewApprovers?.length ?? 0) > 0,
      piiDetect: p.piiDetection === true,
      restrictedBy: `política do agente do Control Plane (${state.source})`
    }
  }
  const list = (s: ReadonlySet<string> | undefined) => (s ? [...s].sort().join(',') : '*')
  const key = [out.readOnly, out.noWrite, list(out.allowMethods), list(out.allowEnvironments), out.limits.rate.requests, out.limits.rate.perMs, out.limits.maxConcurrent, out.limits.maxTimeoutMs].join('|')
  return { ...out, key }
}

/**
 * Sessão do agente com o Control Plane, se o módulo Enterprise trouxer uma e a organização usar
 * Control Plane; null nos outros casos (o MCP segue só com as flags locais). Um módulo que existe
 * mas falha ao abrir a sessão não deixa o MCP sem política: lança, e quem chamou fica restrito.
 */
export async function openAgentSession(
  context: { surface: 'stdio' | 'app'; openExternal?: (url: string) => Promise<void> },
  load: () => Promise<EnterpriseSecretsModule> = loadEnterpriseModule,
  declared: OrganizationRef | null = null
): Promise<AgentSession | null> {
  // Com o workspace declarando a organização, não há "sem política": ou ela vale, ou o MCP fica
  // no modo mais restrito, inclusive no build Community.
  const host = declared && new URL(declared.controlPlane).host
  let mod: EnterpriseSecretsModule
  try {
    mod = await load()
  } catch (err) {
    if (!(err instanceof EnterpriseModuleMissingError)) throw err
    return host ? unavailableSession(`o workspace exige a política da organização (${host}) e o módulo VVPost Enterprise não está instalado`) : null
  }
  if (declared) {
    if (!mod.organization) return unavailableSession(`o workspace declara a organização (${host}), mas o módulo VVPost Enterprise instalado é anterior à configuração pelo Control Plane; atualize-o`)
    mod.organization.use(declared)
  }
  const session = (await mod.controlPlane?.agent?.open(context)) ?? null
  return session ?? (host ? unavailableSession(`o workspace exige a política da organização (${host}), que o módulo Enterprise não abriu`) : null)
}

/** Sessão que não deu para abrir: o MCP fica no modo mais restrito e diz por quê. */
export function unavailableSession(reason: string): AgentSession {
  return {
    state: () => ({ status: 'unavailable', reason }),
    ready: async () => ({ status: 'unavailable', reason }),
    record: () => {},
    requestReview: async () => {
      throw new Error(reason)
    },
    reviews: async () => [],
    close: async () => {}
  }
}

/** O que o servidor MCP usa da política central (createMcpServer). */
export interface CentralAgentPolicy {
  /** Lido a cada chamada de ferramenta. */
  state(): AgentPolicyState
  /** Uma chamada terminou (vai para a trilha central). */
  record(event: AgentToolCallEvent): void
  /** Aplica aprovações do console e abre pedidos para o que está pendente. Nunca lança. */
  syncReviews(workspaceDir: string): Promise<void>
}

/** Intervalo mínimo entre duas conferências de revisão no mesmo projeto. */
const REVIEW_SYNC_MS = 15_000

export function centralAgentPolicy(session: AgentSession, log: (line: string) => void = () => {}, now: () => number = Date.now): CentralAgentPolicy {
  const lastSync = new Map<string, number>()
  const running = new Map<string, Promise<void>>()

  async function sync(dir: string): Promise<void> {
    const state = session.state()
    if (state.status !== 'active' || !state.policy.reviewApprovers?.length) return
    const items = await reviewSnapshot(dir)
    if (!items.length) return
    const ids = [...new Set(items.map((i) => i.request).filter((id): id is number => id !== undefined))]
    const requests = new Map<number, AgentReviewRequest>((ids.length ? await session.reviews(ids) : []).map((r) => [r.id, r]))
    for (const r of requests.values()) {
      if (r.status !== 'approved') continue
      const { applied, stale } = await applyApprovedReview(dir, r.items)
      if (applied.length) log(`revisão #${r.id} aprovada no console${r.decidedBy ? ` por ${r.decidedBy}` : ''}: ${applied.join(', ')}`)
      if (stale.length) log(`revisão #${r.id} aprovada, mas ${stale.join(', ')} mudou depois do pedido: continua pendente`)
    }
    // Pedido novo para o que não tem pedido, ou cujo pedido cobre outro conteúdo (a IA mudou depois).
    const pending = await reviewSnapshot(dir)
    const needs = pending.filter((i) => {
      const r = i.request === undefined ? undefined : requests.get(i.request)
      return !r || !r.items.some((x) => x.key === i.key && x.hash === i.hash)
    })
    if (!needs.length) return
    const created = await session.requestReview({
      workspace: basename(dir),
      items: needs.map(({ key, kind, reason, hash, detail }) => ({ key, kind, hash, ...(reason && { reason }), ...(detail && { detail }) }))
    })
    await setReviewRequest(dir, needs.map((i) => i.key), created.id)
    log(`pedido de revisão #${created.id} aberto no console${created.url ? `: ${created.url}` : ''} (${needs.map((i) => i.key).join(', ')})`)
  }

  return {
    state: () => session.state(),
    record: (event) => session.record({ ...event, at: new Date(now()).toISOString() }),
    syncReviews(dir) {
      const pending = running.get(dir)
      if (pending) return pending
      if (now() - (lastSync.get(dir) ?? -Infinity) < REVIEW_SYNC_MS) return Promise.resolve()
      lastSync.set(dir, now())
      const run = sync(dir)
        .catch((err: Error) => log(`revisão central: ${err.message}`))
        .finally(() => running.delete(dir))
      running.set(dir, run)
      return run
    }
  }
}

/** Identificador que pode ir para a trilha: ids de conector, endpoint, ambiente e projeto, nada além. */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/
const id = (v: unknown): string | undefined => (typeof v === 'string' && ID.test(v) ? v : undefined)

/**
 * O evento de uma chamada de ferramenta: só os identificadores que a chamada escolheu e o
 * resultado. Os argumentos de corpo, headers, overrides e valores nunca entram.
 */
export function toolCallEvent(
  tool: string,
  args: Record<string, unknown>,
  surface: AgentToolCallEvent['surface'],
  result: { ms: number; errorCode?: string }
): AgentToolCallEvent {
  const request = args['request'] && typeof args['request'] === 'object' ? (args['request'] as Record<string, unknown>) : {}
  const envs = [
    ...(Array.isArray(args['environmentIds']) ? args['environmentIds'] : []),
    ...(args['environmentId'] !== undefined ? [args['environmentId']] : [])
  ]
    .map(id)
    .filter((e): e is string => e !== undefined)
  const workspaceProject = id(args['project'])
  const connectorId = id(args['connectorId'])
  const endpointId = id(args['endpointId']) ?? id(request['endpointId'])
  const flowId = id(args['flowId'])
  const denied = result.errorCode === 'BLOCKED' || result.errorCode === 'POLICY_DENIED'
  return {
    kind: 'mcpToolCall',
    action: tool,
    surface,
    ...(workspaceProject && { workspaceProject }),
    ...(connectorId && { connectorId }),
    ...(endpointId && { endpointId }),
    ...(flowId && { flowId }),
    ...(envs.length && { environments: [...new Set(envs)].slice(0, 20) }),
    outcome: result.errorCode === undefined ? 'ok' : denied ? 'denied' : 'error',
    ...(result.errorCode !== undefined && { errorCode: result.errorCode.slice(0, 64) }),
    durationMs: Math.max(0, Math.round(result.ms))
  }
}
