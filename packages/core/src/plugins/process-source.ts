import { matchesNetworkRule } from '../sandbox/network-rules'

/**
 * Código do processo de um plugin, rodado com `node -e PROCESS_SOURCE` (ou o Electron
 * com ELECTRON_RUN_AS_NODE=1) e as permissões do Node ligadas: leitura só da pasta do
 * plugin, sem escrita, sem subprocessos, workers, addons nem WASI (host.ts). Fica num
 * texto para funcionar igual no bundle do main process e nos testes.
 *
 * Antes de carregar o plugin, o processo instala a guarda de rede: conexões TCP, TLS,
 * HTTP/2, fetch e WebSocket só vão para os hosts das regras do manifesto (as fixas, no
 * `init`, e as da chamada, como o host do conector); UDP, sockets locais (Unix, pipes
 * nomeados), servidores e consultas DNS de hosts fora das regras são recusados com
 * POLICY_DENIED. A checagem é feita no Socket e de novo no handle nativo (o IP tem de
 * ter vindo de uma consulta DNS permitida). Os pontos trocados ficam congelados, e
 * `process.binding` está fechado pelas permissões do Node.
 *
 * Protocolo (host ⇄ processo), ver protocol.ts:
 * - `init` traz o main e as regras de rede; o processo carrega o main e responde `ready` ou `load-error`;
 * - `invoke` roda nodes[name].run(ctx), adapters[name].send(ctx), exporters[name].export(ctx) ou
 *   publishers[name][ctx.op](ctx) e responde `result`;
 * - ctx.http.send vira uma mensagem `http`, que o host responde com `http-result`;
 * - `cancel` aborta o ctx.signal da chamada;
 * - uma exceção solta vira `fatal` antes de o processo sair.
 * console.* dentro de uma chamada vai para os logs daquela chamada (AsyncLocalStorage).
 */
export const PROCESS_SOURCE = String.raw`
'use strict'
const { AsyncLocalStorage } = require('node:async_hooks')
const { pathToFileURL } = require('node:url')
const util = require('node:util')
const net = require('node:net')
const dns = require('node:dns')
const dgram = require('node:dgram')

const send = process.send.bind(process)
const MAX_LOG_CHARS = 20000
const current = new AsyncLocalStorage()
const calls = new Map()
const pendingHttp = new Map()
let nextHttp = 0
let plugin = null
let staticRules = []
let unrestricted = false

for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID']) delete process.env[name]
// No Windows o libuv sempre acrescenta as variáveis "obrigatórias" do sistema (usuário, pastas, PATH)
// ao ambiente do processo filho; só SYSTEMROOT é preciso (sockets e crypto), o resto sai.
if (process.platform === 'win32') for (const name of Object.keys(process.env)) if (name.toUpperCase() !== 'SYSTEMROOT') delete process.env[name]

function format(args) {
  return util.formatWithOptions({ depth: 4, breakLength: 120 }, ...args)
}

function post(message) {
  try {
    send(message)
  } catch {}
}

function appendLog(call, level, args) {
  const prefix = level === 'log' || level === 'info' ? '' : level + ': '
  if (call.logs.length >= MAX_LOG_CHARS) return
  call.logs += prefix + format(args) + '\n'
  if (call.logs.length > MAX_LOG_CHARS) call.logs = call.logs.slice(0, MAX_LOG_CHARS) + '\n… (logs cortados)\n'
}

// Fora de uma chamada (ex.: no carregamento do módulo), o log vai para o console do main process.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => {
    const call = current.getStore()
    if (call) appendLog(call, level, args)
    else post({ type: 'log', level, text: format(args) })
  }
}

process.on('unhandledRejection', (reason) => {
  const call = current.getStore()
  const text = 'promise rejeitada sem tratamento: ' + (reason && reason.stack ? reason.stack : String(reason))
  if (call) appendLog(call, 'error', [text])
  else post({ type: 'log', level: 'error', text })
})

process.on('uncaughtException', (err) => {
  post({ type: 'fatal', message: err && err.message ? String(err.message) : String(err) })
  process.exitCode = 70
  setImmediate(() => process.exit(70))
})

process.on('disconnect', () => process.exit(0))

function codeError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

// ---- guarda de rede ----

const matchesNetworkRule = ${matchesNetworkRule.toString()}
const UV_EACCES = -13
const allowedIps = new Set()

function rulesNow() {
  const call = current.getStore()
  return call && call.network ? staticRules.concat(call.network) : staticRules
}

function hostAllowed(host, port) {
  if (unrestricted) return true
  const rules = rulesNow()
  for (const rule of rules) if (matchesNetworkRule(rule, host, port)) return true
  return false
}

function denied(what) {
  return codeError(what + ' não está nas permissões de rede do plugin (permissions.network no vvpost-plugin.json)', 'POLICY_DENIED')
}

function lock(target, key, value) {
  Object.defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false })
}

function normalizeIp(address) {
  let a = String(address).toLowerCase()
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7)
  return a
}

function remember(address) {
  allowedIps.add(normalizeIp(address))
}

const originalLookup = dns.lookup

function recordingLookup(base) {
  return function (hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    return base.call(this, hostname, options, (err, address, family) => {
      if (!err) {
        if (Array.isArray(address)) for (const a of address) remember(a.address)
        else if (address) remember(address)
      }
      callback(err, address, family)
    })
  }
}

// DNS: só nomes permitidos são consultados; os IPs que voltam passam a valer para conectar.
const guardedLookup = function lookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  if (!unrestricted && hostname && !net.isIP(String(hostname)) && !hostAllowed(String(hostname))) {
    const err = denied('o host ' + hostname)
    process.nextTick(() => callback(err))
    return {}
  }
  return recordingLookup(originalLookup).call(this, hostname, options, callback)
}
lock(dns, 'lookup', guardedLookup)
const originalPromiseLookup = dns.promises.lookup
lock(dns.promises, 'lookup', async function lookup(hostname, options) {
  if (!unrestricted && hostname && !net.isIP(String(hostname)) && !hostAllowed(String(hostname))) throw denied('o host ' + hostname)
  const result = await originalPromiseLookup.call(this, hostname, options)
  if (Array.isArray(result)) for (const a of result) remember(a.address)
  else if (result && result.address) remember(result.address)
  return result
})

function guardResolver(target, promises) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (!/^(resolve|reverse|lookupService)/.test(key) || typeof target[key] !== 'function') continue
    const original = target[key]
    const wrapped = function (name, ...rest) {
      if (!unrestricted && !hostAllowed(String(name))) {
        const err = denied('a consulta DNS de ' + name)
        if (promises) return Promise.reject(err)
        const cb = rest[rest.length - 1]
        if (typeof cb === 'function') return void process.nextTick(() => cb(err))
        throw err
      }
      return original.call(this, name, ...rest)
    }
    try {
      lock(target, key, wrapped)
    } catch {}
  }
}
guardResolver(dns, false)
guardResolver(dns.promises, true)
for (let proto = dns.Resolver.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) guardResolver(proto, false)
for (let proto = dns.promises.Resolver.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) guardResolver(proto, true)

// Handles nativos (TCP, Pipe, UDP): a última palavra, para quem chegar até eles.
const patchedProtos = new Set()
function guardHandleProto(handle, kind) {
  if (!handle) return
  // TLS: o handle é um TLSWrap que repassa connect ao TCP de baixo (_parent).
  if (handle._parent) guardHandleProto(handle._parent, kind)
  const proto = Object.getPrototypeOf(handle)
  if (!proto || patchedProtos.has(proto)) return
  patchedProtos.add(proto)
  const wrap = (key, check) => {
    const original = proto[key]
    if (typeof original !== 'function') return
    lock(proto, key, function (...args) {
      if (!unrestricted && !check(args)) return UV_EACCES
      return original.apply(this, args)
    })
  }
  if (kind === 'tcp') {
    wrap('connect', (args) => allowedIps.has(normalizeIp(args[1])))
    wrap('connect6', (args) => allowedIps.has(normalizeIp(args[1])))
    wrap('bind', () => false)
    wrap('bind6', () => false)
    wrap('listen', () => false)
    wrap('open', () => false)
  } else {
    for (const key of ['connect', 'connect6', 'bind', 'bind6', 'listen', 'open', 'send', 'send6']) wrap(key, () => false)
  }
}

const originalConnect = net.Socket.prototype.connect
lock(net.Socket.prototype, 'connect', function connect(...args) {
  if (unrestricted) return originalConnect.apply(this, args)
  let first = args[0]
  const normalized = Array.isArray(first)
  let options = normalized ? first[0] : first
  let host
  let port
  let path
  if (options !== null && typeof options === 'object') {
    if (options.path !== undefined && options.path !== null) path = String(options.path)
    else {
      host = options.host === undefined || options.host === null ? 'localhost' : String(options.host)
      port = Number(options.port)
    }
  } else if (typeof options === 'number' || (typeof options === 'string' && /^\d+$/.test(options))) {
    port = Number(options)
    host = typeof args[1] === 'string' ? args[1] : 'localhost'
  } else if (typeof options === 'string') {
    path = options
  }
  const refuse = (err) => {
    process.nextTick(() => this.destroy(err))
    return this
  }
  if (path !== undefined) return refuse(denied('o socket local ' + path))
  if (!hostAllowed(host, port)) return refuse(denied('a conexão a ' + host + (Number.isFinite(port) ? ':' + port : '')))
  if (net.isIP(host)) remember(host)
  else if (options !== null && typeof options === 'object') {
    // O IP que o DNS devolver para um host permitido também fica permitido no handle.
    const withLookup = Object.assign({}, options, { lookup: recordingLookup(options.lookup || originalLookup) })
    if (normalized) first[0] = withLookup
    else args[0] = withLookup
  } else {
    args = [{ port, host, lookup: recordingLookup(originalLookup) }].concat(args.slice(2).filter((a) => typeof a === 'function'))
  }
  const result = originalConnect.apply(this, args)
  guardHandleProto(this._handle, 'tcp')
  return result
})

const originalListen = net.Server.prototype.listen
lock(net.Server.prototype, 'listen', function listen(...args) {
  if (unrestricted) return originalListen.apply(this, args)
  const err = denied('abrir um servidor')
  process.nextTick(() => this.emit('error', err))
  return this
})

for (const key of ['bind', 'connect', 'send', 'addMembership', 'setBroadcast']) {
  const original = dgram.Socket.prototype[key]
  if (typeof original !== 'function') continue
  lock(dgram.Socket.prototype, key, function (...args) {
    if (unrestricted) return original.apply(this, args)
    throw denied('UDP')
  })
}
try {
  const probe = dgram.createSocket('udp4')
  guardHandleProto(probe._handle, 'udp')
  probe.close()
} catch {}
for (const stream of [process.stdout, process.stderr]) {
  if (stream && stream._handle) guardHandleProto(stream._handle, 'pipe')
}
try {
  const inspector = require('node:inspector')
  lock(inspector, 'open', () => {
    throw codeError('o inspector não pode ser aberto num plugin', 'POLICY_DENIED')
  })
} catch {}

// ---- chamadas ----

function normalizeRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('ctx.http.send espera { method, url, headers, body }')
  if (typeof request.url !== 'string' || !request.url.trim()) throw new TypeError('ctx.http.send: url é obrigatória')
  const method = String(request.method || 'GET').toUpperCase()
  const headers = []
  if (Array.isArray(request.headers)) {
    for (const h of request.headers) headers.push({ name: String(h.name), value: String(h.value) })
  } else if (request.headers && typeof request.headers === 'object') {
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && value !== null) headers.push({ name, value: String(value) })
  }
  let body
  if (request.body !== undefined) {
    if (typeof request.body === 'string') body = request.body
    else {
      body = JSON.stringify(request.body)
      if (!headers.some((h) => h.name.toLowerCase() === 'content-type')) headers.push({ name: 'content-type', value: 'application/json' })
    }
  }
  const out = { method, url: request.url, headers }
  if (body !== undefined) out.body = body
  if (typeof request.timeoutMs === 'number' && request.timeoutMs > 0) out.timeoutMs = Math.floor(request.timeoutMs)
  return out
}

function toResponse(result) {
  if (!result.ok) throw codeError(result.error.message, result.error.code)
  const r = result.response
  return Object.freeze({
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
    body: r.body,
    truncated: r.truncated,
    durationMs: r.durationMs,
    json() {
      return JSON.parse(r.body)
    }
  })
}

function makeHttp(call) {
  return Object.freeze({
    send(request) {
      if (call.controller.signal.aborted) return Promise.reject(codeError('chamada cancelada', 'ABORTED'))
      let normalized
      try {
        normalized = normalizeRequest(request)
      } catch (err) {
        return Promise.reject(err)
      }
      const callId = nextHttp++
      return new Promise((resolve, reject) => {
        pendingHttp.set(callId, { resolve, reject })
        post({ type: 'http', id: call.id, callId, request: normalized })
      }).then(toResponse)
    }
  })
}

async function load(entry) {
  let mod = /\.mjs$/i.test(entry) ? await import(pathToFileURL(entry).href) : require(entry)
  if (mod && mod.default && !mod.nodes && !mod.adapters && !mod.exporters && !mod.publishers) mod = mod.default
  if (!mod || typeof mod !== 'object') throw new Error('o main do plugin não exporta um objeto { nodes, adapters, exporters, publishers }')
  return mod
}

const KINDS = {
  node: { map: 'nodes', method: 'run', label: 'nó' },
  adapter: { map: 'adapters', method: 'send', label: 'adapter' },
  exporter: { map: 'exporters', method: 'export', label: 'exportador' },
  // O método do publicador vem em ctx.op (session, plan ou publish); session é opcional.
  publisher: { map: 'publishers', method: null, label: 'publicador' }
}

function implemented(map, method) {
  if (!map || typeof map !== 'object') return []
  return Object.keys(map).filter((k) => map[k] && typeof map[k][method] === 'function')
}

async function invoke(message) {
  const { network, ...context } = message.context
  const call = { id: message.id, controller: new AbortController(), logs: '', network: Array.isArray(network) ? network : null }
  calls.set(call.id, call)
  const reply = (body) => post(Object.assign({ type: 'result', id: call.id, logs: call.logs }, body))
  try {
    await current.run(call, async () => {
      const kind = KINDS[message.kind]
      const impl = kind && plugin[kind.map] && plugin[kind.map][message.name]
      const method = kind && kind.method === null ? context.op : kind && kind.method
      const fn = impl && (kind.method === null && !['session', 'plan', 'publish'].includes(method) ? undefined : impl[method])
      if (typeof fn !== 'function' && kind && kind.method === null && method === 'session' && impl) {
        reply({ ok: true, value: null })
        return
      }
      if (typeof fn !== 'function') throw new Error((kind ? kind.label : message.kind) + ' ' + message.name + ' não está implementado no plugin')
      const ctx = Object.freeze(Object.assign({}, context, {
        signal: call.controller.signal,
        http: makeHttp(call),
        log: (...args) => appendLog(call, 'log', args)
      }))
      const value = await fn.call(impl, ctx)
      let json
      try {
        json = JSON.stringify(value === undefined ? null : value)
      } catch (err) {
        throw new Error('o resultado não é serializável em JSON: ' + err.message)
      }
      reply({ ok: true, value: JSON.parse(json === undefined ? 'null' : json) })
    })
  } catch (err) {
    const error = { message: err && err.message ? String(err.message) : String(err) }
    if (err && typeof err.code === 'string') error.code = err.code
    reply({ ok: false, error })
  } finally {
    calls.delete(call.id)
  }
}

process.on('message', (message) => {
  switch (message.type) {
    case 'init':
      staticRules = Array.isArray(message.network) ? message.network.map(String) : []
      unrestricted = staticRules.includes('*')
      load(message.entry).then(
        (mod) => {
          plugin = mod
          post({ type: 'ready', nodes: implemented(mod.nodes, 'run'), adapters: implemented(mod.adapters, 'send'), exporters: implemented(mod.exporters, 'export'), publishers: implemented(mod.publishers, 'plan').filter((k) => typeof mod.publishers[k].publish === 'function') })
        },
        (err) => post({ type: 'load-error', message: err && err.stack ? String(err.stack) : String(err) })
      )
      break
    case 'invoke':
      void invoke(message)
      break
    case 'cancel': {
      const call = calls.get(message.id)
      if (call) call.controller.abort(codeError('chamada cancelada', 'ABORTED'))
      break
    }
    case 'http-result': {
      const pending = pendingHttp.get(message.callId)
      pendingHttp.delete(message.callId)
      if (pending) pending.resolve(message.result)
      break
    }
  }
})
`
