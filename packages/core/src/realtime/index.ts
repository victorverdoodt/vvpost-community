import { request, WebSocket, type Dispatcher } from 'undici'
import type { AuthUsage, HttpHeader, HttpMethod } from '../types'
import type { HttpDispatcher } from '../http/dispatcher'
import { toHttpError } from '../http/dispatcher'
import { isSensitiveName } from '../secrets'
import type { SecretSanitizer } from '../sanitizer'
import { AuthError, ConfigError } from '../connectors/errors'
import { resolveHandshake, type HeadlessContext } from '../connectors/headless'
import { createSseParser } from './sse'
import { argsText, connectFrame, decodeFrame, eventArgs, eventFrame, socketIoTarget } from './socketio'
import { assertFeature } from '../policy/features'

export { createSseParser, type SseEvent } from './sse'
export { decodeFrame, eventArgs, socketIoTarget } from './socketio'

/** Protocolos de conexão persistente do Quick Request (fase 15). */
export const REALTIME_PROTOCOLS = ['websocket', 'sse', 'socketio'] as const
export type RealtimeProtocol = (typeof REALTIME_PROTOCOLS)[number]

/** Uma mensagem passa disto: o resto fica de fora da tela (o tamanho real vai em `bytes`). */
export const MAX_MESSAGE_CHARS = 512 * 1024

export interface RealtimeOpenInput {
  /** Id escolhido por quem abre; os eventos e o envio usam o mesmo. */
  id: string
  protocol: RealtimeProtocol
  /** ws(s)://, http(s)://, ou um caminho relativo à baseUrl do conector. */
  url: string
  headers: HttpHeader[]
  connectorId?: string
  environmentId?: string
  /** SSE: GET (padrão) ou POST com corpo, como as APIs que respondem em stream. */
  method?: HttpMethod
  body?: string
  /** WebSocket: subprotocolos (Sec-WebSocket-Protocol). */
  subprotocols?: string[]
}

export type RealtimeStatus = 'connecting' | 'open' | 'closed' | 'error'

export interface RealtimeMessage {
  /** Ordem dentro da conexão, a partir de 1. */
  seq: number
  at: string
  /** in: do servidor; out: enviada daqui; info: do protocolo (namespace conectado, fechamento). */
  direction: 'in' | 'out' | 'info'
  /** Texto (cortado em MAX_MESSAGE_CHARS); frame binário em base64. */
  data: string
  /** Nome do evento: o event: do SSE e o evento do Socket.IO. */
  event?: string
  bytes: number
  binary?: boolean
  truncated?: boolean
}

export type RealtimeEvent =
  | {
      id: string
      type: 'status'
      status: RealtimeStatus
      at: string
      /** Motivo do fechamento ou do erro, subprotocolo aceito, sid do Socket.IO. */
      detail?: string
      code?: string
      /** A URL da conexão, mascarada. */
      url?: string
      auth?: AuthUsage
    }
  | { id: string; type: 'message'; message: RealtimeMessage }

export interface RealtimeContext extends Omit<HeadlessContext, 'http' | 'guard'> {
  http: Pick<HttpDispatcher, 'send' | 'connectionPool'>
  /** Mascara credenciais no que sai para a tela; aprende os valores dos headers de credencial da abertura. */
  sanitizer?: Pick<SecretSanitizer, 'add' | 'text'>
}

export interface RealtimeConnection {
  readonly id: string
  readonly protocol: RealtimeProtocol
  status(): RealtimeStatus
  /** Envia uma mensagem (WebSocket) ou um evento (Socket.IO); {{VAR}} é resolvido pelo ambiente da abertura. */
  send(message: { data: string; event?: string }): RealtimeMessage
  close(): void
  /** Resolve quando a conexão termina (fechada, recusada ou com erro). */
  readonly done: Promise<void>
}

/**
 * Abre uma conexão realtime (fase 15) com a herança do Quick Request: o conector dá baseUrl,
 * headers, auth e mTLS, e o pool do dispatcher dá proxy e CAs. Tudo o que vai para a tela
 * (mensagens, URL, erros) passa pelo sanitizer. Volta na hora: a abertura e as mensagens
 * chegam por `onEvent`, na ordem.
 */
export function openRealtime(input: RealtimeOpenInput, ctx: RealtimeContext, onEvent: (event: RealtimeEvent) => void): RealtimeConnection {
  assertFeature('protocols')
  const clean = (text: string) => ctx.sanitizer?.text(text) ?? text
  let status: RealtimeStatus = 'connecting'
  let seq = 0
  let finish!: () => void
  const done = new Promise<void>((resolve) => (finish = resolve))
  const now = () => new Date().toISOString()
  const setStatus = (next: RealtimeStatus, extra: Omit<Extract<RealtimeEvent, { type: 'status' }>, 'id' | 'type' | 'status' | 'at'> = {}) => {
    if (status === 'closed' || status === 'error') return
    status = next
    onEvent({ id: input.id, type: 'status', status: next, at: now(), ...extra, ...(extra.detail && { detail: clean(extra.detail) }) })
    if (next === 'closed' || next === 'error') finish()
  }
  const message = (direction: RealtimeMessage['direction'], raw: string | Uint8Array, event?: string): RealtimeMessage => {
    const binary = typeof raw !== 'string'
    const text = binary ? Buffer.from(raw).toString('base64') : raw
    const bytes = binary ? raw.byteLength : Buffer.byteLength(raw)
    const truncated = text.length > MAX_MESSAGE_CHARS
    const m: RealtimeMessage = {
      seq: ++seq,
      at: now(),
      direction,
      data: clean(truncated ? text.slice(0, MAX_MESSAGE_CHARS) : text),
      bytes,
      ...(event !== undefined && { event: clean(event) }),
      ...(binary && { binary }),
      ...(truncated && { truncated })
    }
    onEvent({ id: input.id, type: 'message', message: m })
    return m
  }
  const fail = (err: unknown) => {
    const code = err instanceof ConfigError ? 'CONFIG_ERROR' : err instanceof AuthError ? 'AUTH_FAILED' : toHttpError(err).code
    setStatus('error', { code, detail: (err as Error).message ?? String(err) })
  }

  const abort = new AbortController()
  let transport: { send(text: string): void; close(): void } | null = null
  let interpolate: (text: string) => string = (t) => t
  let namespace = '/'
  setStatus('connecting')

  void (async () => {
    const handshake = await resolveHandshake(
      { url: input.url, headers: input.headers, ...(input.connectorId && { connectorId: input.connectorId }), ...(input.environmentId && { environmentId: input.environmentId }), ...(input.method && { method: input.method }), ...(input.body !== undefined && { body: input.body }) },
      { ...ctx, http: ctx.http, signal: AbortSignal.any([abort.signal, ...(ctx.signal ? [ctx.signal] : [])]) }
    )
    interpolate = handshake.interpolate
    // A credencial da abertura não passa pelo dispatcher que o sanitizer observa: ele aprende aqui.
    for (const h of handshake.headers) {
      if (!handshake.secretHeaders.includes(h.name.toLowerCase()) && !isSensitiveName(h.name)) continue
      ctx.sanitizer?.add(h.value)
      ctx.sanitizer?.add(h.value.replace(/^(Bearer|Basic)\s+/i, ''))
    }
    if (abort.signal.aborted) return setStatus('closed', { detail: 'cancelada antes de abrir' })
    const opened = { url: clean(handshake.url), ...(handshake.auth && { auth: handshake.auth }) }
    const pool = await ctx.http.connectionPool(new URL(handshake.url), handshake.tls)
    if (input.protocol === 'sse') return sse(handshake.url, handshake.headers, pool, opened)
    const target = input.protocol === 'socketio' ? socketIoTarget(handshake.url) : { url: handshake.url.replace(/^http/i, 'ws'), namespace: '/' }
    namespace = target.namespace
    socket(target.url, handshake.headers, pool, { ...opened, url: clean(target.url) })
  })().catch(fail)

  function socket(url: string, headers: HttpHeader[], pool: Dispatcher, opened: { url: string; auth?: AuthUsage }) {
    const io = input.protocol === 'socketio'
    const ws = new WebSocket(url, {
      dispatcher: pool,
      headers: headers.map((h) => [h.name, h.value] as [string, string]),
      ...(!io && input.subprotocols?.length && { protocols: input.subprotocols })
    })
    ws.binaryType = 'arraybuffer'
    let errorText: string | undefined
    transport = { send: (text) => ws.send(text), close: () => ws.close(1000) }
    ws.addEventListener('open', () => {
      // Socket.IO só está aberto quando o namespace confirma a conexão (pacote CONNECT).
      if (!io) setStatus('open', { ...opened, ...(ws.protocol && { detail: `subprotocolo ${ws.protocol}` }) })
    })
    ws.addEventListener('message', (e) => {
      const data = e.data as string | ArrayBuffer
      if (!io) return void message('in', typeof data === 'string' ? data : new Uint8Array(data))
      if (typeof data !== 'string') return void message('info', 'frame binário do Socket.IO ignorado (anexos binários não são suportados)')
      const packet = decodeFrame(data)
      switch (packet.kind) {
        case 'open':
          return ws.send(connectFrame(namespace))
        case 'ping':
          return ws.send('3')
        case 'connect':
          if (packet.namespace === namespace) setStatus('open', { ...opened, detail: `namespace ${namespace}${packet.sid ? ` · sid ${packet.sid}` : ''}` })
          return
        case 'connect_error':
          errorText = `o namespace ${packet.namespace} recusou a conexão: ${packet.message}`
          return ws.close(1000)
        case 'disconnect':
          errorText = undefined
          message('info', `o servidor desconectou o namespace ${packet.namespace}`)
          return ws.close(1000)
        case 'event':
          return void message('in', argsText(packet.args), packet.event)
        case 'ack':
          return void message('in', argsText(packet.args), `ack${packet.ackId !== undefined ? ` #${packet.ackId}` : ''}`)
        case 'close':
          return ws.close(1000)
        default:
          return void message('info', `pacote não suportado: ${packet.raw.slice(0, 200)}`)
      }
    })
    ws.addEventListener('error', (e) => {
      const err = (e as unknown as { error?: Error; message?: string }).error
      errorText = err?.message ?? (e as unknown as { message?: string }).message ?? 'erro na conexão'
    })
    ws.addEventListener('close', (e) => {
      transport = null
      if (status === 'connecting' || (errorText && e.code !== 1000)) return setStatus('error', { code: 'NETWORK_ERROR', detail: errorText ?? `fechada antes de abrir (código ${e.code})` })
      if (errorText) return setStatus('error', { code: 'NETWORK_ERROR', detail: errorText })
      setStatus('closed', { detail: `código ${e.code}${e.reason ? ` · ${e.reason}` : ''}` })
    })
  }

  async function sse(url: string, headers: HttpHeader[], pool: Dispatcher, opened: { url: string; auth?: AuthUsage }) {
    const method = input.method ?? 'GET'
    const out: Record<string, string> = { accept: 'text/event-stream', 'cache-control': 'no-cache' }
    for (const h of headers) out[h.name.toLowerCase()] = h.value
    const body = method === 'GET' || method === 'HEAD' || input.body === undefined ? undefined : interpolate(input.body)
    if (body !== undefined && !out['content-type']) out['content-type'] = /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain; charset=utf-8'
    transport = { send: () => { throw new ConfigError('SSE só recebe: o servidor manda os eventos') }, close: () => abort.abort() }
    try {
      const res = await request(url, { method, headers: out, ...(body !== undefined && { body }), dispatcher: pool, signal: abort.signal })
      const type = String(res.headers['content-type'] ?? '')
      if (res.statusCode >= 300 || !type.includes('text/event-stream')) {
        const text = (await res.body.text()).slice(0, 2000)
        return setStatus('error', {
          code: res.statusCode >= 300 ? 'HTTP_STATUS' : 'NOT_EVENT_STREAM',
          detail: res.statusCode >= 300 ? `HTTP ${res.statusCode}${text ? `: ${text}` : ''}` : `a resposta é ${type || 'sem Content-Type'}, não text/event-stream`
        })
      }
      setStatus('open', { ...opened, detail: `HTTP ${res.statusCode}` })
      const parser = createSseParser((e) => {
        message('in', e.data, e.event)
      })
      const decoder = new TextDecoder()
      for await (const chunk of res.body) parser.feed(decoder.decode(chunk as Buffer, { stream: true }))
      parser.end()
      setStatus('closed', { detail: 'o servidor encerrou o stream' })
    } catch (err) {
      if (abort.signal.aborted) return setStatus('closed', { detail: 'desconectada' })
      fail(err)
    } finally {
      transport = null
    }
  }

  return {
    id: input.id,
    protocol: input.protocol,
    status: () => status,
    send({ data, event }) {
      if (status !== 'open' || !transport) throw new ConfigError('a conexão não está aberta')
      if (input.protocol === 'sse') throw new ConfigError('SSE só recebe: o servidor manda os eventos')
      const text = interpolate(data)
      if (input.protocol === 'socketio') {
        const name = interpolate(event ?? '').trim()
        if (!name) throw new ConfigError('o evento do Socket.IO precisa de um nome')
        transport.send(eventFrame(namespace, name, eventArgs(text)))
        return message('out', text, name)
      }
      transport.send(text)
      return message('out', text)
    },
    close() {
      abort.abort()
      if (transport) transport.close()
      else if (status === 'connecting') setStatus('closed', { detail: 'cancelada antes de abrir' })
    },
    done
  }
}
