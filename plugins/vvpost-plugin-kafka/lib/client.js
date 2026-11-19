// @ts-check
'use strict'

/**
 * Cliente do protocolo do Kafka: uma conexão TCP (ou TLS) por broker, com ApiVersions,
 * SASL (PLAIN, SCRAM-SHA-256/512 e OAUTHBEARER), Metadata, Produce, ListOffsets e Fetch
 * nas versões sem campos "flexíveis" (as que todo broker desde o 1.0 entende).
 */

const crypto = require('node:crypto')
const net = require('node:net')
const tls = require('node:tls')
const { KafkaError, Writer, Reader } = require('./wire')

const API = { Produce: 0, Fetch: 1, ListOffsets: 2, Metadata: 3, SaslHandshake: 17, ApiVersions: 18, SaslAuthenticate: 36 }
/** Versões que o plugin sabe escrever e ler, por API: [mínima, máxima]. */
const SUPPORTED = /** @type {Record<number, [number, number]>} */ ({
  [API.Produce]: [3, 8],
  [API.Fetch]: [4, 11],
  [API.ListOffsets]: [1, 5],
  [API.Metadata]: [1, 8],
  [API.SaslHandshake]: [1, 1],
  [API.SaslAuthenticate]: [0, 1]
})
const API_NAMES = Object.fromEntries(Object.entries(API).map(([k, v]) => [v, k]))

const ERRORS = /** @type {Record<number, string>} */ ({
  [-1]: 'UNKNOWN_SERVER_ERROR', 1: 'OFFSET_OUT_OF_RANGE', 2: 'CORRUPT_MESSAGE', 3: 'UNKNOWN_TOPIC_OR_PARTITION',
  4: 'INVALID_FETCH_SIZE', 5: 'LEADER_NOT_AVAILABLE', 6: 'NOT_LEADER_OR_FOLLOWER', 7: 'REQUEST_TIMED_OUT',
  10: 'MESSAGE_TOO_LARGE', 15: 'COORDINATOR_NOT_AVAILABLE', 17: 'INVALID_TOPIC_EXCEPTION', 18: 'RECORD_LIST_TOO_LARGE',
  19: 'NOT_ENOUGH_REPLICAS', 20: 'NOT_ENOUGH_REPLICAS_AFTER_APPEND', 21: 'INVALID_REQUIRED_ACKS',
  29: 'TOPIC_AUTHORIZATION_FAILED', 31: 'CLUSTER_AUTHORIZATION_FAILED', 32: 'INVALID_TIMESTAMP',
  33: 'UNSUPPORTED_SASL_MECHANISM', 34: 'ILLEGAL_SASL_STATE', 35: 'UNSUPPORTED_VERSION', 43: 'POLICY_VIOLATION',
  58: 'SASL_AUTHENTICATION_FAILED', 74: 'FENCED_LEADER_EPOCH', 75: 'UNKNOWN_LEADER_EPOCH',
  76: 'UNSUPPORTED_COMPRESSION_TYPE', 87: 'INVALID_RECORD', 100: 'UNKNOWN_TOPIC_ID'
})
/** Erros que se resolvem com metadata nova (líder trocou, tópico acabou de ser criado). */
const RETRIABLE = new Set([3, 5, 6, 74, 75])

/** @param {number} code */
const errorName = (code) => ERRORS[code] ?? `erro ${code}`

/** @param {number} code @param {string} what */
function kafkaError(code, what, message = '') {
  return Object.assign(new KafkaError(`${what}: ${errorName(code)}${message ? ` (${message})` : ''}`, 'KAFKA_ERROR'), { kafkaCode: code })
}

/**
 * @typedef {{ host: string, port: number }} Address
 * @typedef {{ ca?: string, cert?: string, key?: string, pfx?: string, passphrase?: string }} TlsMaterial
 * @typedef {{ mechanism: string, username?: string, password?: string, token?: string }} SaslConfig
 * @typedef {{ deadline: number, signal?: AbortSignal }} Limits
 */

/** Tempo que sobra até o prazo da chamada. @param {Limits} limits */
function remaining(limits) {
  return Math.max(0, limits.deadline - Date.now())
}

class Connection {
  /**
   * @param {Address} address @param {{ tls?: TlsMaterial | true, limits: Limits, clientId: string }} options
   * @returns {Promise<Connection>}
   */
  static open(address, options) {
    return new Promise((resolve, reject) => {
      const { limits } = options
      if (limits.signal?.aborted) return reject(new KafkaError('cancelado', 'CANCELLED'))
      const material = options.tls === true ? {} : options.tls
      const servername = net.isIP(address.host) ? undefined : address.host
      /** @type {net.Socket} */
      let socket
      try {
        socket = material
        ? tls.connect({
            host: address.host,
            port: address.port,
            ...(servername && { servername }),
            ...(material.ca && { ca: material.ca }),
            ...(material.cert && { cert: material.cert }),
            ...(material.key && { key: material.key }),
            ...(material.pfx && { pfx: Buffer.from(material.pfx, 'base64') }),
            ...(material.passphrase && { passphrase: material.passphrase })
          })
          : net.connect({ host: address.host, port: address.port })
      } catch (err) {
        return reject(connectError(/** @type {Error} */ (err), address))
      }
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new KafkaError(`o broker ${address.host}:${address.port} não respondeu a tempo`, 'TIMEOUT'))
      }, remaining(limits))
      const fail = (/** @type {Error} */ err) => {
        clearTimeout(timer)
        reject(connectError(err, address))
      }
      socket.once('error', fail)
      socket.once(material ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer)
        socket.off('error', fail)
        resolve(new Connection(socket, address, options))
      })
    })
  }

  /** @param {net.Socket} socket @param {Address} address @param {{ limits: Limits, clientId: string }} options */
  constructor(socket, address, options) {
    this.socket = socket
    this.address = address
    this.limits = options.limits
    this.clientId = options.clientId
    this.correlation = 0
    /** @type {Map<number, { resolve: (r: Reader) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    /** @type {Map<number, [number, number]>} */
    this.versions = new Map()
    /** @type {Error | null} */
    this.closed = null
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      while (buffer.length >= 4) {
        const size = buffer.readInt32BE(0)
        if (buffer.length < 4 + size) break
        const frame = buffer.subarray(4, 4 + size)
        buffer = buffer.subarray(4 + size)
        const correlation = frame.readInt32BE(0)
        const waiting = this.pending.get(correlation)
        if (!waiting) continue
        this.pending.delete(correlation)
        clearTimeout(waiting.timer)
        waiting.resolve(new Reader(frame, 4))
      }
    })
    const end = (/** @type {Error} */ err) => {
      this.closed ??= err
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer)
        waiting.reject(err)
      }
      this.pending.clear()
    }
    socket.on('error', (err) => end(connectError(err, address)))
    socket.on('close', () => end(new KafkaError(`o broker ${address.host}:${address.port} fechou a conexão`, 'KAFKA_DISCONNECTED')))
    this.onAbort = () => socket.destroy(new KafkaError('cancelado', 'CANCELLED'))
    this.limits.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  /**
   * Uma requisição com header v1 (api_key, api_version, correlation_id, client_id).
   * @param {number} apiKey @param {number} version @param {Buffer} body @returns {Promise<Reader>}
   */
  request(apiKey, version, body, expectResponse = true) {
    if (this.closed) return Promise.reject(this.closed)
    const correlation = (this.correlation = (this.correlation + 1) & 0x7fffffff)
    const header = new Writer().int16(apiKey).int16(version).int32(correlation).string(this.clientId).build()
    const size = Buffer.alloc(4)
    size.writeInt32BE(header.length + body.length)
    return new Promise((resolve, reject) => {
      if (expectResponse) {
        const timer = setTimeout(() => {
          this.pending.delete(correlation)
          reject(new KafkaError(`${API_NAMES[apiKey] ?? apiKey}: o broker ${this.address.host}:${this.address.port} não respondeu a tempo`, 'TIMEOUT'))
        }, remaining(this.limits))
        this.pending.set(correlation, { resolve, reject, timer })
      }
      this.socket.write(Buffer.concat([size, header, body]), (err) => {
        if (err) reject(connectError(err, this.address))
        else if (!expectResponse) resolve(new Reader(Buffer.alloc(0)))
      })
    })
  }

  /** Versão a usar para a API: a maior que o plugin e o broker entendem. @param {number} apiKey */
  version(apiKey) {
    const [min, max] = /** @type {[number, number]} */ (SUPPORTED[apiKey])
    const broker = this.versions.get(apiKey)
    if (!broker || broker[1] < min || broker[0] > max) {
      throw new KafkaError(
        `o broker ${this.address.host}:${this.address.port} não aceita ${API_NAMES[apiKey]} v${min}-${max} (Kafka 1.0 ou mais novo é preciso)`,
        'KAFKA_UNSUPPORTED'
      )
    }
    return Math.min(max, broker[1])
  }

  async apiVersions() {
    const r = await this.request(API.ApiVersions, 0, Buffer.alloc(0))
    const code = r.int16()
    if (code) throw kafkaError(code, 'ApiVersions')
    for (const [key, min, max] of r.array((x) => /** @type {[number, number, number]} */ ([x.int16(), x.int16(), x.int16()]))) this.versions.set(key, [min, max])
  }

  close() {
    this.limits.signal?.removeEventListener('abort', this.onAbort)
    this.socket.destroy()
  }
}

/** @param {Error} err @param {Address} address */
function connectError(err, address) {
  const code = /** @type {any} */ (err).code
  if (err instanceof KafkaError) return err
  if (code === 'POLICY_DENIED') {
    return new KafkaError(
      `${err.message}. Brokers anunciados pelo cluster precisam estar no conector ou no campo Brokers do nó (${address.host}:${address.port})`,
      'POLICY_DENIED'
    )
  }
  return new KafkaError(`broker ${address.host}:${address.port}: ${err.message}`, code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED' : 'KAFKA_DISCONNECTED')
}

/** @param {string} name */
const saslName = (name) => name.replace(/=/g, '=3D').replace(/,/g, '=2C')

/** @param {Connection} conn @param {Buffer} bytes @param {number} version @returns {Promise<Buffer>} */
async function saslAuthenticate(conn, bytes, version) {
  const r = await conn.request(API.SaslAuthenticate, version, new Writer().bytes(bytes).build())
  const code = r.int16()
  const message = r.string()
  const reply = r.bytes() ?? Buffer.alloc(0)
  if (code) throw new KafkaError(`autenticação SASL recusada: ${message || errorName(code)}`, 'AUTH_FAILED')
  return reply
}

/** SCRAM (RFC 5802) sobre SaslAuthenticate. @param {Connection} conn @param {'sha256' | 'sha512'} hash @param {SaslConfig} sasl @param {number} version */
async function scram(conn, hash, sasl, version) {
  const nonce = crypto.randomBytes(24).toString('base64')
  const first = `n=${saslName(sasl.username ?? '')},r=${nonce}`
  const serverFirst = (await saslAuthenticate(conn, Buffer.from(`n,,${first}`), version)).toString('utf8')
  const fields = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]))
  if (!fields.r?.startsWith(nonce) || !fields.s || !fields.i) throw new KafkaError('resposta SCRAM inválida do broker', 'AUTH_FAILED')
  const iterations = Number(fields.i)
  if (!(iterations >= 1 && iterations <= 1_000_000)) throw new KafkaError('SCRAM com iterações inválidas', 'AUTH_FAILED')
  const salted = crypto.pbkdf2Sync((sasl.password ?? '').normalize('NFKC'), Buffer.from(fields.s, 'base64'), iterations, hash === 'sha256' ? 32 : 64, hash)
  const hmac = (/** @type {Buffer} */ key, /** @type {string} */ text) => crypto.createHmac(hash, key).update(text).digest()
  const clientKey = hmac(salted, 'Client Key')
  const storedKey = crypto.createHash(hash).update(clientKey).digest()
  const withoutProof = `c=biws,r=${fields.r}`
  const authMessage = `${first},${serverFirst},${withoutProof}`
  const signature = hmac(storedKey, authMessage)
  const proof = Buffer.from(clientKey.map((b, i) => b ^ /** @type {number} */ (signature[i])))
  const serverFinal = (await saslAuthenticate(conn, Buffer.from(`${withoutProof},p=${proof.toString('base64')}`), version)).toString('utf8')
  const expected = hmac(hmac(salted, 'Server Key'), authMessage).toString('base64')
  if (serverFinal !== `v=${expected}`) throw new KafkaError('o broker não provou conhecer a senha (assinatura SCRAM do servidor não confere)', 'AUTH_FAILED')
}

/** Prefere PLAIN (o mais comum em serviços gerenciados), depois SCRAM. */
const BASIC_PREFERENCE = ['PLAIN', 'SCRAM-SHA-512', 'SCRAM-SHA-256']

/** @param {Connection} conn @param {SaslConfig} sasl */
async function authenticate(conn, sasl) {
  const handshake = async (/** @type {string} */ mechanism) => {
    const r = await conn.request(API.SaslHandshake, conn.version(API.SaslHandshake), new Writer().string(mechanism).build())
    const code = r.int16()
    const enabled = r.array((x) => /** @type {string} */ (x.string()))
    return { code, enabled }
  }
  let mechanism = sasl.mechanism === 'auto' ? (sasl.token !== undefined ? 'OAUTHBEARER' : 'PLAIN') : sasl.mechanism
  let { code, enabled } = await handshake(mechanism)
  if (code === 33 && sasl.mechanism === 'auto' && sasl.token === undefined) {
    const pick = BASIC_PREFERENCE.find((m) => enabled.includes(m))
    if (pick) {
      mechanism = pick
      ;({ code, enabled } = await handshake(mechanism))
    }
  }
  if (code === 33) throw new KafkaError(`o broker não aceita SASL ${mechanism} (aceita: ${enabled.join(', ') || 'nenhum'})`, 'AUTH_FAILED')
  if (code) throw kafkaError(code, 'SaslHandshake')
  const version = conn.version(API.SaslAuthenticate)
  if (mechanism === 'PLAIN') {
    await saslAuthenticate(conn, Buffer.from(`\0${sasl.username ?? ''}\0${sasl.password ?? ''}`, 'utf8'), version)
  } else if (mechanism === 'SCRAM-SHA-256' || mechanism === 'SCRAM-SHA-512') {
    await scram(conn, mechanism === 'SCRAM-SHA-256' ? 'sha256' : 'sha512', sasl, version)
  } else if (mechanism === 'OAUTHBEARER') {
    if (!sasl.token) throw new KafkaError('OAUTHBEARER precisa de um token (auth bearer ou oauth2 no conector)', 'AUTH_FAILED')
    await saslAuthenticate(conn, Buffer.from(`n,,\x01auth=Bearer ${sasl.token}\x01\x01`, 'utf8'), version)
  } else throw new KafkaError(`mecanismo SASL ${mechanism} não suportado`, 'CONFIG_ERROR')
  return mechanism
}

/**
 * @typedef {{ nodeId: number, host: string, port: number }} BrokerInfo
 * @typedef {{ partition: number, leader: number, leaderEpoch: number, replicas: number[], isr: number[], offline: number[], error: number }} PartitionInfo
 * @typedef {{ name: string, internal: boolean, error: number, partitions: PartitionInfo[] }} TopicInfo
 * @typedef {{ brokers: BrokerInfo[], clusterId: string | null, controllerId: number, topics: TopicInfo[] }} Metadata
 */

class Cluster {
  /**
   * @param {{ seeds: Address[], tls?: TlsMaterial | true, sasl?: SaslConfig, limits: Limits, clientId?: string, log?: (msg: string) => void }} options
   */
  constructor(options) {
    this.options = options
    this.clientId = options.clientId ?? 'vvpost'
    this.log = options.log ?? (() => {})
    /** @type {Map<string, Promise<Connection>>} */
    this.connections = new Map()
    /** @type {Map<number, BrokerInfo>} */
    this.brokers = new Map()
    /** @type {string | undefined} */
    this.mechanism = undefined
  }

  /** @param {Address} address */
  connect(address) {
    const key = `${address.host}:${address.port}`
    let conn = this.connections.get(key)
    if (!conn) {
      conn = (async () => {
        const c = await Connection.open(address, { tls: this.options.tls, limits: this.options.limits, clientId: this.clientId })
        try {
          await c.apiVersions()
          if (this.options.sasl) this.mechanism = await authenticate(c, this.options.sasl)
        } catch (err) {
          c.close()
          throw err
        }
        return c
      })()
      this.connections.set(key, conn)
      conn.catch(() => this.connections.delete(key))
    }
    return conn
  }

  /** Conexão com qualquer broker: o primeiro endereço de bootstrap que responder. */
  async any() {
    /** @type {Error | undefined} */
    let last
    for (const seed of this.options.seeds) {
      try {
        return await this.connect(seed)
      } catch (err) {
        last = /** @type {Error} */ (err)
        if (['AUTH_FAILED', 'CANCELLED', 'POLICY_DENIED'].includes(/** @type {any} */ (err).code)) throw err
      }
    }
    throw last ?? new KafkaError('nenhum broker para conectar', 'CONFIG_ERROR')
  }

  /** @param {number} nodeId */
  async broker(nodeId) {
    const info = this.brokers.get(nodeId)
    if (!info) throw new KafkaError(`o broker ${nodeId} não está na metadata do cluster`, 'KAFKA_ERROR')
    return this.connect(info)
  }

  /** @param {string[] | null} topics @returns {Promise<Metadata>} */
  async metadata(topics, autoCreate = false) {
    const conn = await this.any()
    const v = conn.version(API.Metadata)
    const w = new Writer().array(topics, (x, t) => x.string(t))
    if (v >= 4) w.bool(autoCreate)
    if (v >= 8) w.bool(false).bool(false)
    const r = await conn.request(API.Metadata, v, w.build())
    if (v >= 3) r.int32()
    const brokers = r.array((x) => {
      const b = { nodeId: x.int32(), host: /** @type {string} */ (x.string()), port: x.int32() }
      x.string()
      return b
    })
    const clusterId = v >= 2 ? r.string() : null
    const controllerId = r.int32()
    const topicList = r.array((x) => {
      const error = x.int16()
      const name = /** @type {string} */ (x.string())
      const internal = x.bool()
      const partitions = x.array((p) => {
        const info = { error: p.int16(), partition: p.int32(), leader: p.int32(), leaderEpoch: v >= 7 ? p.int32() : -1, replicas: p.array((q) => q.int32()), isr: p.array((q) => q.int32()), offline: v >= 5 ? p.array((q) => q.int32()) : [] }
        return info
      })
      if (v >= 8) x.int32()
      return { name, internal, error, partitions: partitions.sort((a, b) => a.partition - b.partition) }
    })
    for (const b of brokers) this.brokers.set(b.nodeId, b)
    return { brokers, clusterId, controllerId, topics: topicList }
  }

  /**
   * Metadata de um tópico, esperando o líder quando ele acabou de ser criado.
   * @param {string} topic @returns {Promise<TopicInfo>}
   */
  async topic(topic, autoCreate = false) {
    for (let attempt = 0; ; attempt++) {
      const meta = await this.metadata([topic], autoCreate)
      const info = meta.topics.find((t) => t.name === topic)
      const error = info?.error ?? 3
      const ready = info && !error && info.partitions.length && info.partitions.every((p) => p.leader >= 0)
      if (ready) return info
      if (!RETRIABLE.has(error || 5) || (error === 3 && !autoCreate) || attempt >= 10 || remaining(this.options.limits) < 300) {
        if (error === 3) throw new KafkaError(`o tópico ${topic} não existe`, 'KAFKA_UNKNOWN_TOPIC')
        throw kafkaError(error || 5, `tópico ${topic}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }

  /**
   * Produce de um batch numa partição.
   * @param {string} topic @param {number} partition @param {number} leader @param {Buffer} batch
   * @param {{ acks: number, timeoutMs: number, minVersion?: number }} options
   */
  async produce(topic, partition, leader, batch, options) {
    const conn = await this.broker(leader)
    const v = conn.version(API.Produce)
    if (options.minVersion && v < options.minVersion) throw new KafkaError(`o broker não aceita esta compressão (precisa de Produce v${options.minVersion})`, 'KAFKA_UNSUPPORTED')
    const body = new Writer()
      .string(null)
      .int16(options.acks)
      .int32(options.timeoutMs)
      .array([topic], (w, t) => w.string(t).array([partition], (x, p) => x.int32(p).bytes(batch)))
      .build()
    if (options.acks === 0) {
      await conn.request(API.Produce, v, body, false)
      return { offset: null, timestamp: null }
    }
    const r = await conn.request(API.Produce, v, body)
    const [res] = r.array((x) => {
      x.string()
      return x.array((p) => {
        const out = { partition: p.int32(), error: p.int16(), offset: p.int64(), logAppendTime: p.int64(), logStart: v >= 5 ? p.int64() : -1n, message: /** @type {string | null} */ (null) }
        if (v >= 8) {
          const recordErrors = p.array((e) => [e.int32(), e.string()])
          out.message = p.string() ?? (recordErrors[0]?.[1] ? String(recordErrors[0][1]) : null)
        }
        return out
      })[0]
    })
    if (!res) throw new KafkaError('resposta de Produce vazia', 'KAFKA_PROTOCOL')
    if (res.error) throw kafkaError(res.error, `Produce em ${topic}[${partition}]`, res.message ?? '')
    return { offset: res.offset, timestamp: res.logAppendTime >= 0n ? res.logAppendTime : null }
  }

  /**
   * Offsets por timestamp (-1 fim, -2 início) das partições de um líder.
   * @param {number} leader @param {string} topic @param {{ partition: number, timestamp: bigint }[]} partitions
   * @returns {Promise<Map<number, { offset: bigint, timestamp: bigint }>>}
   */
  async listOffsets(leader, topic, partitions) {
    const conn = await this.broker(leader)
    const v = conn.version(API.ListOffsets)
    const w = new Writer().int32(-1)
    if (v >= 2) w.int8(0)
    w.array([topic], (x, t) =>
      x.string(t).array(partitions, (y, p) => {
        y.int32(p.partition)
        if (v >= 4) y.int32(-1)
        y.int64(p.timestamp)
      })
    )
    const r = await conn.request(API.ListOffsets, v, w.build())
    if (v >= 2) r.int32()
    /** @type {Map<number, { offset: bigint, timestamp: bigint }>} */
    const out = new Map()
    r.array((x) => {
      x.string()
      x.array((p) => {
        const partition = p.int32()
        const error = p.int16()
        const timestamp = p.int64()
        const offset = p.int64()
        if (v >= 4) p.int32()
        if (error) throw kafkaError(error, `ListOffsets em ${topic}[${partition}]`)
        out.set(partition, { offset, timestamp })
      })
    })
    return out
  }

  /**
   * Um Fetch das partições de um líder a partir dos offsets dados.
   * @param {number} leader @param {string} topic @param {{ partition: number, offset: bigint }[]} partitions
   * @param {{ maxWaitMs: number, minBytes?: number, partitionMaxBytes?: number }} options
   * @returns {Promise<Map<number, { error: number, highWatermark: bigint, records: Buffer | null }>>}
   */
  async fetch(leader, topic, partitions, options) {
    const conn = await this.broker(leader)
    const v = conn.version(API.Fetch)
    const w = new Writer().int32(-1).int32(options.maxWaitMs).int32(options.minBytes ?? 1).int32(64 << 20).int8(0)
    if (v >= 7) w.int32(0).int32(-1)
    w.array([topic], (x, t) =>
      x.string(t).array(partitions, (y, p) => {
        y.int32(p.partition)
        if (v >= 9) y.int32(-1)
        y.int64(p.offset)
        if (v >= 5) y.int64(-1)
        y.int32(options.partitionMaxBytes ?? 4 << 20)
      })
    )
    if (v >= 7) w.array([], () => {})
    if (v >= 11) w.string('')
    const r = await conn.request(API.Fetch, v, w.build())
    r.int32()
    if (v >= 7) {
      const code = r.int16()
      r.int32()
      if (code) throw kafkaError(code, 'Fetch')
    }
    /** @type {Map<number, { error: number, highWatermark: bigint, records: Buffer | null }>} */
    const out = new Map()
    r.array((x) => {
      x.string()
      x.array((p) => {
        const partition = p.int32()
        const error = p.int16()
        const highWatermark = p.int64()
        p.int64() // last_stable_offset
        if (v >= 5) p.int64()
        const aborted = p.int32()
        for (let i = 0; i < aborted; i++) {
          p.int64()
          p.int64()
        }
        if (v >= 11) p.int32()
        out.set(partition, { error, highWatermark, records: p.bytes() })
      })
    })
    return out
  }

  close() {
    for (const conn of this.connections.values()) conn.then((c) => c.close(), () => {})
    this.connections.clear()
  }
}

module.exports = { Cluster, Connection, KafkaError, API, errorName, RETRIABLE }
