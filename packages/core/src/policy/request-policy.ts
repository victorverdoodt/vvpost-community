import type { HttpMethod } from '../types'

/**
 * Permissões e limites de quem dispara requisições sem um humano olhando cada uma
 *: a IA pelo MCP e os plugins. Valem para a requisição
 * do chamador, já com a herança aplicada; o fluxo de auth do conector (token
 * endpoint, login) foi escrito no workspace e não passa por aqui.
 */
export interface RequestPolicy {
  /** Quem dispara, para as mensagens: "a IA (MCP)", "o plugin acme". */
  actor: string
  /** Métodos permitidos; ausente: todos. */
  allowMethods?: ReadonlySet<HttpMethod>
  /**
   * Origens permitidas ("https://api.exemplo.com", "https://*.exemplo.com",
   * "http://localhost:*"); ausente: qualquer uma.
   */
  allowOrigins?: readonly string[]
  /** Ambientes em que pode disparar ("" é sem ambiente); ausente: todos. */
  allowEnvironments?: ReadonlySet<string>
  /** Total de requisições na vida do guard (uma chamada de ferramenta, uma execução de nó). */
  maxRequests?: number
  /** Janela deslizante: no máximo `requests` em `perMs`. */
  rate?: { requests: number; perMs: number }
  /** Requisições ao mesmo tempo; as outras esperam a vez. */
  maxConcurrent?: number
  /** Teto do timeout pedido pelo chamador. */
  maxTimeoutMs?: number
}

export interface PolicyRequest {
  method: HttpMethod
  url: string
  environmentId?: string
  timeoutMs?: number
}

export type PolicyDecision = { ok: true; timeoutMs?: number; release: () => void } | { ok: false; message: string }

export interface RequestGuard {
  readonly policy: RequestPolicy
  /**
   * Confere a requisição e espera a vez dela. Com ok, `release` precisa ser chamado
   * quando a resposta chegar; `timeoutMs` é o timeout já limitado pelo teto.
   */
  admit(request: PolicyRequest, signal?: AbortSignal): Promise<PolicyDecision>
  /** Quantas requisições passaram. */
  readonly count: number
}

/** Limites padrão da IA pelo MCP: um agente em laço não vira teste de carga. */
export const MCP_POLICY_DEFAULTS = {
  rate: { requests: 60, perMs: 60_000 },
  maxConcurrent: 4,
  maxTimeoutMs: 60_000
} as const satisfies Partial<RequestPolicy>

/**
 * Limites padrão dos disparos por webhook (um guard por servidor): um remetente em laço,
 * ou um fluxo que manda evento para o próprio servidor, não vira teste de carga.
 */
export const WEBHOOK_POLICY_DEFAULTS = {
  rate: { requests: 60, perMs: 60_000 },
  maxConcurrent: 4,
  maxTimeoutMs: 60_000
} as const satisfies Partial<RequestPolicy>

/** Limites padrão de uma execução de nó de plugin. */
export const PLUGIN_POLICY_DEFAULTS = {
  maxRequests: 100,
  maxConcurrent: 6,
  maxTimeoutMs: 120_000
} as const satisfies Partial<RequestPolicy>

export function createRequestGuard(policy: RequestPolicy, now: () => number = Date.now): RequestGuard {
  const origins = policy.allowOrigins?.map(parseOriginPattern)
  const recent: number[] = []
  const waiting: (() => void)[] = []
  let active = 0
  let count = 0

  function check(req: PolicyRequest): string | null {
    if (policy.allowMethods && !policy.allowMethods.has(req.method)) {
      return `${policy.actor} não pode usar ${req.method} (permitidos: ${[...policy.allowMethods].join(', ') || 'nenhum'})`
    }
    const env = req.environmentId ?? ''
    if (policy.allowEnvironments && !policy.allowEnvironments.has(env)) {
      return `${policy.actor} não pode disparar no ambiente ${env ? `"${env}"` : '(sem ambiente)'}`
    }
    if (origins) {
      let url: URL
      try {
        url = new URL(req.url)
      } catch {
        return `URL inválida: ${req.url}`
      }
      if (!origins.some((o) => o(url))) return `${policy.actor} não pode enviar para ${url.origin} (fora das origens permitidas)`
    }
    if (policy.maxRequests !== undefined && count >= policy.maxRequests) {
      return `${policy.actor} passou do limite de ${policy.maxRequests} requisições por execução`
    }
    if (policy.rate) {
      const cutoff = now() - policy.rate.perMs
      while (recent.length && recent[0]! <= cutoff) recent.shift()
      if (recent.length >= policy.rate.requests) {
        const wait = Math.ceil((recent[0]! + policy.rate.perMs - now()) / 1000)
        return `${policy.actor} passou do limite de ${policy.rate.requests} requisições em ${policy.rate.perMs / 1000} s; tente de novo em ${wait} s`
      }
    }
    return null
  }

  /** Reserva uma vaga de concorrência; a vaga de quem termina passa direto para o próximo da fila. */
  async function acquire(signal?: AbortSignal): Promise<boolean> {
    if (policy.maxConcurrent === undefined || active < policy.maxConcurrent) {
      active++
      return true
    }
    return new Promise((resolve) => {
      const go = () => {
        signal?.removeEventListener('abort', cancel)
        resolve(true)
      }
      const cancel = () => {
        const i = waiting.indexOf(go)
        if (i >= 0) waiting.splice(i, 1)
        resolve(false)
      }
      waiting.push(go)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  function releaseSlot(): void {
    const next = waiting.shift()
    if (next) next()
    else active--
  }

  return {
    policy,
    get count() {
      return count
    },
    async admit(req, signal) {
      // Conferido antes e depois da fila: um limite alcançado enquanto esperava também vale.
      const early = check(req)
      if (early) return { ok: false, message: early }
      if (!(await acquire(signal))) return { ok: false, message: 'Requisição cancelada' }
      const late = check(req)
      if (late) {
        releaseSlot()
        return { ok: false, message: late }
      }
      count++
      if (policy.rate) recent.push(now())
      let released = false
      const timeoutMs =
        policy.maxTimeoutMs === undefined ? req.timeoutMs : Math.min(req.timeoutMs ?? policy.maxTimeoutMs, policy.maxTimeoutMs)
      return {
        ok: true,
        ...(timeoutMs !== undefined && { timeoutMs }),
        release() {
          if (released) return
          released = true
          releaseSlot()
        }
      }
    }
  }
}

/**
 * "https://api.exemplo.com" (origem exata), "https://*.exemplo.com" (subdomínios,
 * não o domínio puro) e "http://localhost:*" (qualquer porta). Sem porta, vale a
 * padrão do esquema.
 */
export function parseOriginPattern(pattern: string): (url: URL) => boolean {
  const m = /^(https?):\/\/(\*\.)?([^/:*]+)(?::(\d+|\*))?\/?$/i.exec(pattern.trim())
  if (!m) throw new Error(`origem inválida "${pattern}": use https://host, https://*.dominio ou http://host:porta`)
  const [, scheme, wildcard, host, port] = m
  const defaultPort = scheme!.toLowerCase() === 'https' ? '443' : '80'
  const wantPort = port ?? defaultPort
  const wantHost = host!.toLowerCase()
  return (url) => {
    if (url.protocol !== `${scheme!.toLowerCase()}:`) return false
    const urlPort = url.port || defaultPort
    if (wantPort !== '*' && urlPort !== wantPort) return false
    const h = url.hostname.toLowerCase()
    return wildcard ? h.endsWith(`.${wantHost}`) : h === wantHost
  }
}
