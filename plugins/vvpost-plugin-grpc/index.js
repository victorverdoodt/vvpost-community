// @ts-check
'use strict'

/**
 * Plugin oficial vvpost-plugin-grpc: adapter de protocolo "grpc". Chamadas unárias e de
 * streaming (cliente, servidor e bidirecional, com as mensagens enviadas de uma vez) sobre
 * HTTP/2, com os tipos de um .proto colado no nó ou lidos do servidor pelo reflection.
 *
 * A conexão vem do conector do nó (permissions.connectorCredentials): a baseUrl
 * (grpc://host:porta em texto puro, grpcs:// em TLS), os headers herdados com a auth
 * (viram metadata) e o mTLS. O processo do plugin só conecta ao host do conector.
 */

const { Registry, encode, decode, ProtoError } = require('./lib/protobuf')
const { listServices, loadByReflection } = require('./lib/reflection')
const { call, GrpcError } = require('./lib/transport')

/** Reflection por servidor e serviço, para não repetir a cada chamada (o processo vive enquanto há uso). */
const REFLECTION_TTL_MS = 60_000
/** @type {Map<string, { at: number, registry: Promise<Registry> }>} */
const reflected = new Map()

/** @param {unknown} value */
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * @typedef {{ service: string, method: string, message?: unknown, proto?: string, metadata?: Record<string, unknown>,
 *   emitDefaults?: boolean }} GrpcConfig
 */

/**
 * @param {import('@vvpost/plugin-sdk').AdapterContext} ctx @param {string} service
 * @param {Parameters<typeof listServices>[0]} target
 */
function registryFor(ctx, service, target) {
  const config = /** @type {GrpcConfig} */ (ctx.config)
  if (config.proto && config.proto.trim()) return Promise.resolve(new Registry().addProto(config.proto, 'colado no nó.proto').resolve())
  const key = `${target.url}\0${service}`
  const cached = reflected.get(key)
  if (cached && Date.now() - cached.at < REFLECTION_TTL_MS) return cached.registry
  const registry = (async () => {
    let symbol = service.replace(/^\./, '')
    // Nome curto (Greeter): o reflection precisa do nome completo, que vem da lista de serviços.
    if (!symbol.includes('.')) {
      const names = await listServices(target)
      const matches = names.filter((/** @type {string} */ n) => n === symbol || n.endsWith(`.${symbol}`))
      if (matches.length > 1) throw new ProtoError(`o nome ${service} é ambíguo: ${matches.join(', ')}`, 'GRPC_SERVICE_NOT_FOUND')
      if (!matches.length) throw new ProtoError(`serviço ${service} não encontrado${names.length ? ` (disponíveis: ${names.join(', ')})` : ''}`, 'GRPC_SERVICE_NOT_FOUND')
      symbol = /** @type {string} */ (matches[0])
    }
    try {
      return await loadByReflection(target, symbol, (msg) => ctx.log(msg))
    } catch (err) {
      if (/** @type {any} */ (err).code !== 'GRPC_SERVICE_NOT_FOUND') throw err
      const names = await listServices(target).catch(() => [])
      throw new ProtoError(`serviço ${service} não encontrado${names.length ? ` (disponíveis: ${names.join(', ')})` : ''}`, 'GRPC_SERVICE_NOT_FOUND')
    }
  })()
  reflected.set(key, { at: Date.now(), registry })
  registry.catch(() => reflected.delete(key))
  return registry
}

/** @type {import('@vvpost/plugin-sdk').PluginModule} */
module.exports = {
  adapters: {
    grpc: {
      async send(ctx) {
        const config = /** @type {GrpcConfig} */ (ctx.config)
        const conn = ctx.connection
        if (!conn) throw new GrpcError('escolha um conector com a baseUrl do servidor gRPC (ex.: grpc://localhost:50051 ou grpcs://api.example.com)', 'CONFIG_ERROR')
        if (config.metadata !== undefined && !isObject(config.metadata)) throw new GrpcError('Metadata precisa ser um objeto { "nome": "valor" }', 'CONFIG_ERROR')
        /** @type {Record<string, string>} */
        const metadata = { ...conn.headers }
        for (const [k, v] of Object.entries(config.metadata ?? {})) if (v !== undefined && v !== null) metadata[k.toLowerCase()] = String(v)
        const target = { url: conn.url, metadata, timeoutMs: ctx.timeoutMs, signal: ctx.signal, ...(conn.tls && { tls: conn.tls }) }

        const registry = await registryFor(ctx, config.service, target)
        const { service, method } = registry.method(config.service, config.method)
        const input = config.message === undefined || config.message === null || config.message === '' ? {} : config.message
        const inputs = method.clientStreaming ? (Array.isArray(input) ? input : [input]) : [input]
        if (!method.clientStreaming && Array.isArray(input)) {
          throw new ProtoError(`${service.fullName}/${method.name} recebe uma mensagem só; uma lista só vale para client streaming`, 'PROTO_ENCODE')
        }
        const messages = inputs.map((m, i) => encode(registry, method.input, m, inputs.length > 1 ? `message[${i}]` : 'message'))
        const path = `/${service.fullName}/${method.name}`
        ctx.log(`${path} (${method.clientStreaming ? 'stream' : 'unary'} → ${method.serverStreaming ? 'stream' : 'unary'})`)
        const result = await call({ ...target, path, messages })
        const options = { emitDefaults: config.emitDefaults !== false }
        const decoded = result.messages.map((m) => decode(registry, method.output, m, options))
        /** @type {Record<string, string>} */
        const headers = { ...result.headers, ...result.trailers, 'grpc-status': String(result.status) }
        if (result.message) headers['grpc-message'] = result.message
        if (result.status !== 0) {
          return {
            data: { code: result.statusName, message: result.message, ...(decoded.length && { messages: decoded }) },
            status: result.httpStatus,
            headers
          }
        }
        return { data: method.serverStreaming ? decoded : decoded[0] ?? null, status: 200, headers }
      }
    }
  }
}
