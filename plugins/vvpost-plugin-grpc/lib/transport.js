// @ts-check
'use strict'

/**
 * Uma chamada gRPC sobre HTTP/2 (node:http2): manda as mensagens (5 bytes de prefixo:
 * compressão + tamanho), fecha o envio e junta as respostas, os headers e os trailers.
 * grpc:// e http:// vão em texto puro (h2c, prior knowledge); grpcs:// e https:// em TLS.
 */

const http2 = require('node:http2')
const zlib = require('node:zlib')

const STATUS_NAMES = [
  'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
  'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED',
  'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'
]
/** Status do gRPC → HTTP equivalente (o que o nó usa para falhar com HTTP_STATUS). */
const HTTP_EQUIVALENT = [200, 499, 500, 400, 504, 404, 409, 403, 429, 400, 409, 400, 501, 500, 503, 500, 401]
/** Headers que a chamada controla e que o metadata não pode trocar. */
const RESERVED = new Set(['content-type', 'te', 'host', 'connection', 'grpc-timeout', 'user-agent', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-connection'])

class GrpcError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/** @param {string} url */
function authorityOf(url) {
  const parsed = new URL(url)
  const secure = parsed.protocol === 'grpcs:' || parsed.protocol === 'https:'
  if (!['grpc:', 'grpcs:', 'http:', 'https:'].includes(parsed.protocol)) {
    throw new GrpcError(`a baseUrl do conector precisa ser grpc://, grpcs://, http:// ou https:// (veio ${parsed.protocol}//)`, 'CONFIG_ERROR')
  }
  const port = parsed.port || (secure ? '443' : '80')
  return { authority: `${secure ? 'https' : 'http'}://${parsed.hostname}:${port}`, secure, servername: parsed.hostname.replace(/^\[|\]$/g, ''), prefix: parsed.pathname.replace(/\/+$/, '') }
}

/** @param {Buffer} message */
function frame(message) {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(message.length, 1)
  return Buffer.concat([head, message])
}

/** @param {Buffer} data @param {string | undefined} encoding @returns {Buffer[]} */
function unframe(data, encoding) {
  /** @type {Buffer[]} */
  const out = []
  let pos = 0
  while (pos + 5 <= data.length) {
    const compressed = data[pos] === 1
    const length = data.readUInt32BE(pos + 1)
    if (pos + 5 + length > data.length) throw new GrpcError('resposta gRPC truncada', 'GRPC_PROTOCOL')
    let message = data.subarray(pos + 5, pos + 5 + length)
    if (compressed) {
      if (encoding === 'gzip') message = zlib.gunzipSync(message)
      else if (encoding === 'deflate') message = zlib.inflateSync(message)
      else throw new GrpcError(`mensagem comprimida com ${encoding ?? 'codificação desconhecida'}, que o plugin não lê`, 'GRPC_PROTOCOL')
    }
    out.push(Buffer.from(message))
    pos += 5 + length
  }
  if (pos !== data.length) throw new GrpcError('resposta gRPC com bytes sobrando', 'GRPC_PROTOCOL')
  return out
}

/** @param {string} value */
function decodeGrpcMessage(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * @typedef {{ ca?: string, cert?: string, key?: string, pfx?: string, passphrase?: string }} TlsMaterial
 * @typedef {{ url: string, path: string, metadata?: Record<string, string>, messages: Buffer[], timeoutMs: number,
 *   signal?: AbortSignal, tls?: TlsMaterial }} CallOptions
 * @typedef {{ status: number, statusName: string, message: string, headers: Record<string, string>,
 *   trailers: Record<string, string>, messages: Buffer[], httpStatus: number }} CallResult
 */

/** @param {CallOptions} options @returns {Promise<CallResult>} */
function call(options) {
  const target = authorityOf(options.url)
  return new Promise((resolve, reject) => {
    /** @type {import('node:http2').SecureClientSessionOptions} */
    const sessionOptions = {}
    if (target.secure) {
      sessionOptions.servername = target.servername
      if (options.tls?.ca) sessionOptions.ca = options.tls.ca
      if (options.tls?.cert) sessionOptions.cert = options.tls.cert
      if (options.tls?.key) sessionOptions.key = options.tls.key
      if (options.tls?.pfx) sessionOptions.pfx = Buffer.from(options.tls.pfx, 'base64')
      if (options.tls?.passphrase) sessionOptions.passphrase = options.tls.passphrase
    }
    let settled = false
    const session = http2.connect(target.authority, sessionOptions)
    /** @param {Error} err */
    const fail = (err) => {
      if (settled) return
      settled = true
      session.destroy()
      reject(err)
    }
    const onAbort = () => fail(new GrpcError('chamada cancelada', 'ABORTED'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    session.on('error', (err) => fail(new GrpcError(`não foi possível conectar a ${target.authority}: ${err.message}`, /** @type {any} */ (err).code ?? 'CONNECTION_ERROR')))

    /** @type {Record<string, string>} */
    const headers = {
      ':method': 'POST',
      ':path': `${target.prefix}${options.path}`,
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-timeout': `${Math.max(1, Math.floor(options.timeoutMs))}m`,
      'grpc-accept-encoding': 'identity,gzip,deflate',
      'user-agent': 'vvpost-plugin-grpc/1.0'
    }
    for (const [name, value] of Object.entries(options.metadata ?? {})) {
      const key = name.toLowerCase()
      if (key.startsWith(':') || RESERVED.has(key)) continue
      headers[key] = value
    }
    const req = session.request(headers)
    /** @type {Record<string, string>} */
    let responseHeaders = {}
    /** @type {Record<string, string>} */
    let trailers = {}
    /** @type {Buffer[]} */
    const chunks = []
    let httpStatus = 0
    /** @param {import('node:http2').IncomingHttpHeaders} h */
    const plain = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith(':')).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]))
    req.on('response', (h) => {
      httpStatus = Number(h[':status'])
      responseHeaders = plain(h)
    })
    req.on('trailers', (h) => {
      trailers = plain(h)
    })
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('error', (err) => fail(new GrpcError(err.message, /** @type {any} */ (err).code ?? 'GRPC_PROTOCOL')))
    req.on('end', () => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      session.close()
      // Trailers-only: o status vem nos headers.
      const statusText = trailers['grpc-status'] ?? responseHeaders['grpc-status']
      const message = decodeGrpcMessage(trailers['grpc-message'] ?? responseHeaders['grpc-message'] ?? '')
      if (statusText === undefined) {
        const why = httpStatus && httpStatus !== 200 ? `HTTP ${httpStatus}` : 'sem grpc-status'
        return reject(new GrpcError(`o servidor não respondeu como gRPC (${why})`, 'GRPC_PROTOCOL'))
      }
      const status = Number(statusText)
      let messages
      try {
        messages = unframe(Buffer.concat(chunks), responseHeaders['grpc-encoding'])
      } catch (err) {
        return reject(err)
      }
      resolve({
        status,
        statusName: STATUS_NAMES[status] ?? `STATUS_${status}`,
        message,
        headers: responseHeaders,
        trailers,
        messages,
        httpStatus: HTTP_EQUIVALENT[status] ?? 500
      })
    })
    for (const m of options.messages) req.write(frame(m))
    req.end()
  })
}

module.exports = { call, frame, unframe, GrpcError, STATUS_NAMES, HTTP_EQUIVALENT }
