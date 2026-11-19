import type { HttpHeader, WebhookEvent } from '../types'
import { readRequired, stringify, type NodeOutput, type NodesTree } from './expressions'

/** Quanto um nó webhook espera, sem timeoutMs (flow.json, FlowWebhook). */
export const WEBHOOK_TIMEOUT_MS = 60_000

/**
 * Um caminho de hook ou de nó casa com o caminho recebido: exato (a barra do fim não
 * conta) ou, terminado em /*, o prefixo e tudo abaixo dele.
 */
export function pathMatches(pattern: string, path: string): boolean {
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
  if (pattern.endsWith('/*')) {
    const base = trim(pattern.slice(0, -2)) || '/'
    const target = trim(path)
    return base === '/' || target === base || target.startsWith(`${base}/`)
  }
  return trim(pattern) === trim(path)
}

/**
 * Especificidade de um caminho de hook: exato vence /*, e entre dois /* vence o mais
 * longo. Usado pelo servidor para escolher o hook de um evento.
 */
export function pathSpecificity(pattern: string): number {
  return pattern.endsWith('/*') ? pattern.length : 100_000 + pattern.length
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** O caminho do nó com os {{ $nodes... }} trocados pelos valores (codificados para URL). */
export function resolveWebhookPath(path: string, nodes: NodesTree, elsewhere?: ReadonlySet<string>): string {
  return path.replace(TEMPLATE, (whole, inner: string) =>
    inner.trim().startsWith('$nodes') ? encodeURIComponent(stringify(readRequired(inner, nodes, elsewhere))) : whole
  )
}

function headerRecord(headers: readonly HttpHeader[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { name, value } of headers) {
    const key = name.toLowerCase()
    out[key] = key in out ? `${out[key]}, ${value}` : value
  }
  return out
}

function contentType(headers: readonly HttpHeader[]): string {
  return (headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '').split(';')[0]!.trim().toLowerCase()
}

/**
 * O corpo como o fluxo o lê: JSON vira valor, formulário vira objeto, binário fica em
 * base64 e o resto é texto. Um JSON inválido continua texto (o evento é de depuração).
 */
export function webhookBody(event: Pick<WebhookEvent, 'headers' | 'body' | 'bodyBase64'>): unknown {
  if (event.bodyBase64 !== undefined) return event.bodyBase64
  const type = contentType(event.headers)
  if (event.body === '') return null
  if (type === 'application/json' || type.endsWith('+json') || (!type && /^\s*[[{]/.test(event.body))) {
    try {
      return JSON.parse(event.body) as unknown
    } catch {
      return event.body
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const form: Record<string, string | string[]> = {}
    for (const [k, v] of new URLSearchParams(event.body)) {
      const prev = form[k]
      form[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v]
    }
    return form
  }
  return event.body
}

/** O que um nó webhook põe em $nodes.<nome>: data com o evento lido, headers com os recebidos. */
export function webhookOutput(event: WebhookEvent): NodeOutput {
  const headers = headerRecord(event.headers)
  return {
    data: {
      id: event.id,
      receivedAt: event.receivedAt,
      method: event.method,
      path: event.path,
      query: event.query,
      headers,
      body: webhookBody(event),
      ...(event.hookId && { hook: event.hookId })
    },
    headers
  }
}
