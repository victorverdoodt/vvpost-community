import type { HttpRequestInput, HttpResult } from './types'
import type { HttpDispatcher, RequestTrace, SendOptions } from './http/dispatcher'
import { describePayload } from './http/payload'

/** Uma requisição como saiu do dispatcher, com a origem (o modelo com {{VAR}}) e o resultado. */
export interface RecordedExchange {
  id: string
  /** Epoch em ms do disparo. */
  at: number
  /** A requisição antes da herança e da resolução de {{VAR}}; sem `trace`, a própria enviada. */
  trace: RequestTrace
  /** O que foi para a rede: URL final, headers herdados e da auth, corpo resolvido. */
  sent: Pick<HttpRequestInput, 'method' | 'url' | 'headers' | 'body'>
  result: HttpResult
}

/** Acima disso as entradas mais antigas saem: quem não chamou `take` não segura memória para sempre. */
const MAX_PENDING = 2000

export interface RecorderLimits {
  /** false: não guarda nada (histórico desligado em todas as origens). */
  enabled: boolean
  /**
   * Corpos (enviado e recebido) guardados até este tamanho, mais um caractere para quem
   * grava saber que houve corte. O resultado devolvido ao chamador não muda.
   */
  maxBody: number
}

export interface ExchangeRecorder<H> {
  http: H
  /** Tira e devolve as requisições cujo id é `prefix` ou começa com `prefix:`, na ordem do disparo. */
  take(prefix: string): RecordedExchange[]
}

/**
 * Observa um dispatcher para o histórico: guarda, por id, a última tentativa de
 * cada requisição (o retry depois de um 401 substitui a primeira). O fluxo de auth do conector
 * (ids `auth:`) fica de fora: ele carrega a credencial e não é a requisição de ninguém.
 * `limits` é consultado a cada envio: com o histórico desligado nada fica em memória, e um
 * corpo grande fica só até o tamanho que o histórico grava.
 */
export function createExchangeRecorder<H extends Pick<HttpDispatcher, 'send' | 'cancel'>>(
  http: H,
  limits: () => RecorderLimits = () => ({ enabled: true, maxBody: Infinity })
): ExchangeRecorder<H> {
  const pending = new Map<string, RecordedExchange>()
  const wrapped = Object.create(http) as H
  wrapped.send = async (input: HttpRequestInput, options?: SendOptions) => {
    const at = Date.now()
    const result = await http.send(input, options)
    const { enabled, maxBody } = limits()
    if (!input.id.startsWith('auth:') && enabled) {
      const keep = (text: string) => (text.length > maxBody ? text.slice(0, maxBody + 1) : text)
      pending.delete(input.id)
      pending.set(input.id, {
        id: input.id,
        at,
        trace: options?.trace ?? { template: input },
        sent: {
          method: input.method,
          url: input.url,
          headers: input.headers,
          // Do corpo estruturado fica o resumo (campos e caminhos), sem os bytes dos arquivos.
          ...(input.payload ? { body: keep(describePayload(input.payload)) } : input.body !== undefined && { body: keep(input.body) })
        },
        result: result.ok ? { ...result, response: { ...result.response, body: keep(result.response.body) } } : result
      })
      if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!)
    }
    return result
  }
  wrapped.cancel = (id: string) => http.cancel(id)
  return {
    http: wrapped,
    take(prefix) {
      const out: RecordedExchange[] = []
      for (const [id, exchange] of pending) {
        if (id === prefix || id.startsWith(`${prefix}:`)) {
          out.push(exchange)
          pending.delete(id)
        }
      }
      return out
    }
  }
}
