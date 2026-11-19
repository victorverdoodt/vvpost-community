import type { HttpHeader, HttpMethod } from '../types'

/** Mensagens entre o host e o processo de um plugin (o lado do plugin está em process-source.ts). */

export type ContributionKind = 'node' | 'adapter' | 'exporter' | 'publisher'

/** O que o processo do plugin recebe como ctx (signal, http e log são montados lá dentro). */
export interface InvocationContext {
  config: Record<string, unknown>
  nodes: Record<string, unknown>
  node: { id: string; name: string }
  timeoutMs: number
  connector?: string
  /** Conexão resolvida do conector, só para plugins com permissions.connectorCredentials. */
  connection?: import('../connectors/headless').ConnectorConnection
  /** Regras de rede desta chamada (o host do conector, os hosts de um campo); não chegam ao ctx. */
  network?: string[]
  /** Num exportador: o pacote da documentação (bundle), o histórico (changelog) e a exportação anterior (previous). */
  bundle?: unknown
  changelog?: unknown
  previous?: unknown
  /** Num publicador: o que chamar (session, plan ou publish), o destino e, no publish, o plano e a confirmação. */
  op?: 'session' | 'plan' | 'publish'
  target?: unknown
  plan?: unknown
  approval?: unknown
}

/** Requisição já normalizada pelo processo do plugin a partir de ctx.http.send. */
export interface PluginHttpRequest {
  method: string
  url: string
  headers: HttpHeader[]
  body?: string
  timeoutMs?: number
}

/** Resposta como vai ao plugin: sem nada da auth além do que o servidor devolveu. */
export type PluginHttpResult =
  | {
      ok: true
      response: {
        status: number
        statusText: string
        headers: Record<string, string>
        body: string
        truncated: boolean
        durationMs: number
      }
    }
  | { ok: false; error: { code: string; message: string } }

export type HostToWorker =
  | { type: 'init'; entry: string; network: string[] }
  | { type: 'invoke'; id: number; kind: ContributionKind; name: string; context: InvocationContext }
  | { type: 'cancel'; id: number }
  | { type: 'http-result'; callId: number; result: PluginHttpResult }

export type WorkerToHost =
  | { type: 'ready'; nodes: string[]; adapters: string[]; exporters?: string[]; publishers?: string[] }
  | { type: 'load-error'; message: string }
  | { type: 'fatal'; message: string }
  | { type: 'log'; level: string; text: string }
  | { type: 'http'; id: number; callId: number; request: PluginHttpRequest }
  | ({ type: 'result'; id: number; logs: string } & (
      | { ok: true; value: unknown }
      | { ok: false; error: { message: string; code?: string } }
    ))

export const isHttpMethod = (method: string): method is HttpMethod =>
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)
