import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { headerMismatch, ProtocolError, requestedVersion } from './protocol'
import { handleText, RpcError, type JsonRpcResponse, type McpServer } from './server'

/** Porta padrão do transporte HTTP/SSE (o mock de Secret Managers usa a 4460). */
export const DEFAULT_MCP_PORT = 4470
/** Mensagem maior que isto é recusada: nenhuma chamada legítima de ferramenta chega perto. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const KEEPALIVE_MS = 25_000

/**
 * Transporte stdio do MCP: uma mensagem JSON-RPC por linha. stdout é só do
 * protocolo; qualquer log vai para stderr. Resolve quando a entrada fecha.
 */
export function serveStdio(server: McpServer, input: Readable, output: Writable): Promise<void> {
  return new Promise((resolve) => {
    let buffer = ''
    let pending = Promise.resolve()
    const write = (payload: unknown) => {
      if (payload !== null) output.write(`${JSON.stringify(payload)}\n`)
    }
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_MESSAGE_BYTES && !buffer.includes('\n')) {
        buffer = ''
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'mensagem grande demais' } })
        return
      }
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        // Cada mensagem é tratada sem bloquear as próximas (ping no meio de um lote de cenários).
        const done = handleText(server, line).then(write)
        pending = pending.then(() => done).catch(() => {})
      }
    })
    input.on('end', () => void pending.finally(resolve))
    input.on('close', () => void pending.finally(resolve))
  })
}

export interface HttpTransportOptions {
  port?: number
  /** Só endereços de loopback: o servidor dá acesso às APIs do workspace com as credenciais do usuário. */
  host?: '127.0.0.1' | '::1' | 'localhost'
  /** Exige Authorization: Bearer <token> em toda requisição. */
  token?: string
  log?: (line: string) => void
}

export interface RunningHttpTransport {
  url: string
  port: number
  close(): Promise<void>
}

/**
 * Transportes HTTP do MCP, no mesmo servidor:
 * - Streamable HTTP (2025-03-26+): POST /mcp com a mensagem, resposta em JSON. Na era moderna (2026-07-28+),
 *   os headers MCP-Protocol-Version, Mcp-Method e Mcp-Name têm de bater com o corpo, e os erros de protocolo
 *   voltam com o status HTTP da spec (400 versão ou header, 404 método).
 * - HTTP+SSE (2024-11-05): GET /sse abre o stream e anuncia /messages?sessionId=...,
 *   onde o cliente faz POST; as respostas voltam pelo stream.
 * Só escuta em loopback e recusa Host e Origin que não sejam locais (DNS rebinding).
 */
export async function serveHttp(server: McpServer, options: HttpTransportOptions = {}): Promise<RunningHttpTransport> {
  const host = options.host ?? '127.0.0.1'
  const log = options.log ?? (() => {})
  const sessions = new Map<string, ServerResponse>()

  const http: Server = createServer((req, res) => {
    void route(req, res).catch((err: Error) => {
      log(`erro no transporte HTTP: ${server.sanitizer.text(err.message)}`)
      if (!res.headersSent) send(res, 500, { error: 'erro interno' })
      else res.end()
    })
  })

  async function route(req: IncomingMessage, res: ServerResponse) {
    if (!isLocalHost(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
      return send(res, 403, { error: 'origem não permitida' })
    }
    if (options.token && !checkToken(req.headers.authorization, options.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      return send(res, 401, { error: 'token ausente ou inválido' })
    }
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/mcp') {
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body === null) return send(res, 413, { error: 'mensagem grande demais' })
        const controller = new AbortController()
        res.on('close', () => !res.writableFinished && controller.abort())
        let message: unknown
        try {
          message = JSON.parse(body)
        } catch {
          return send(res, 200, await handleText(server, body))
        }
        const mismatch = headerMismatch(req.headers, message)
        if (mismatch) {
          const id = (message as { id?: JsonRpcResponse['id'] }).id ?? null
          return send(res, 400, { jsonrpc: '2.0', id, error: { code: ProtocolError.HeaderMismatch, message: mismatch } })
        }
        const reply = await server.handle(message, controller.signal)
        if (reply === null) {
          res.writeHead(202).end()
          return
        }
        return send(res, modernStatus(message, reply), reply)
      }
      if (req.method === 'DELETE') return void res.writeHead(200).end()
      res.setHeader('Allow', 'POST, DELETE')
      return send(res, 405, { error: 'use POST' })
    }

    if (url.pathname === '/sse' && req.method === 'GET') {
      const id = randomUUID()
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      })
      res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`)
      sessions.set(id, res)
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS)
      req.on('close', () => {
        clearInterval(keepalive)
        sessions.delete(id)
      })
      return
    }

    if (url.pathname === '/messages' && req.method === 'POST') {
      const stream = sessions.get(url.searchParams.get('sessionId') ?? '')
      if (!stream) return send(res, 404, { error: 'sessão SSE não encontrada; abra GET /sse de novo' })
      const body = await readBody(req)
      if (body === null) return send(res, 413, { error: 'mensagem grande demais' })
      res.writeHead(202).end()
      const reply = await handleText(server, body)
      if (reply !== null && !stream.writableEnded) stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
      return
    }

    if (url.pathname === '/' && req.method === 'GET') {
      return send(res, 200, { name: 'vvpost', transports: { streamableHttp: '/mcp', sse: '/sse' } })
    }
    send(res, 404, { error: 'não encontrado' })
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? DEFAULT_MCP_PORT, host, () => {
      http.off('error', reject)
      resolve()
    })
  })
  const { port } = http.address() as AddressInfo
  const shown = host === '::1' ? '[::1]' : host
  return {
    url: `http://${shown}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of sessions.values()) stream.end()
        sessions.clear()
        http.close(() => resolve())
        http.closeAllConnections()
      })
  }
}

/** Na era moderna, o erro de versão vai com 400 e o de método com 404, para o cliente reconhecer o servidor moderno. */
function modernStatus(message: unknown, reply: JsonRpcResponse | JsonRpcResponse[]): number {
  if (Array.isArray(reply) || !reply.error || Array.isArray(message)) return 200
  const code = reply.error.code
  if (code === ProtocolError.UnsupportedProtocolVersion) return 400
  if (requestedVersion((message as { params?: unknown }).params) === undefined) return 200
  return code === RpcError.MethodNotFound ? 404 : 200
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload))
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_MESSAGE_BYTES) tooBig = true
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function hostnameOf(value: string): string {
  return value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0]!
}

function isLocalHost(host: string | undefined): boolean {
  return !!host && LOCAL_HOSTNAMES.has(hostnameOf(host.toLowerCase()))
}

/** Clientes MCP não mandam Origin; um navegador sempre manda. Só páginas locais passam. */
function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const url = new URL(origin)
    return LOCAL_HOSTNAMES.has(url.hostname) || LOCAL_HOSTNAMES.has(`[${url.hostname}]`)
  } catch {
    return false
  }
}

function checkToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? '')?.[1] ?? '')
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
