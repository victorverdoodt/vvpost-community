// @ts-check
'use strict'

/**
 * Plugin oficial vvpost-plugin-kafka: adapter de protocolo "kafka". Produz uma mensagem,
 * lê as últimas (ou a partir do início, de um horário, de um offset, ou as que chegarem)
 * e lista os tópicos, falando o protocolo do Kafka direto (sem dependências).
 *
 * A conexão vem do conector do nó (permissions.connectorCredentials): a baseUrl
 * (kafka://host:porta em texto puro, kafkas:// em TLS) é o broker de bootstrap, a auth
 * basic vira SASL PLAIN ou SCRAM e a bearer/oauth2 vira OAUTHBEARER; o mTLS do conector
 * vale para todos os brokers. O processo do plugin só conecta ao host do conector e aos
 * do campo Brokers (os que o cluster anuncia, quando são outros).
 */

const { Cluster, KafkaError, RETRIABLE, errorName } = require('./lib/client')
const { WRITABLE } = require('./lib/compression')
const { encodeBatch, decodeBatches } = require('./lib/records')
const { partitionFor } = require('./lib/wire')

/**
 * @typedef {{ operation?: 'produce' | 'consume' | 'topics', topic?: string, key?: string, value?: unknown,
 *   headers?: Record<string, unknown>, partition?: number | null, acks?: 'all' | 'leader' | 'none',
 *   compression?: string, from?: 'last' | 'earliest' | 'latest' | 'timestamp' | 'offset', count?: number,
 *   timestamp?: string | number, offset?: number | string, maxWaitMs?: number, format?: 'auto' | 'json' | 'text' | 'base64',
 *   sasl?: string, brokers?: string }} KafkaConfig
 */

const SCHEMES = /** @type {Record<string, boolean>} */ ({ 'kafka:': false, 'kafkas:': true, 'kafka+ssl:': true, 'kafka+tls:': true })
const ACKS = /** @type {Record<string, number>} */ ({ all: -1, leader: 1, none: 0 })
const MAX_COUNT = 1000
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** @param {string} item @param {number} defaultPort @returns {{ host: string, port: number } | null} */
function parseAddress(item, defaultPort) {
  const m = /^(?:[a-z+]+:\/\/)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?\/?$/i.exec(item.trim())
  if (!m || !m[1] || m[1].startsWith('*')) return null
  return { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : defaultPort }
}

/** @param {any} conn @param {KafkaConfig} config */
function clusterOptions(conn, config) {
  /** @type {URL} */
  let url
  try {
    url = new URL(conn.url)
  } catch {
    throw new KafkaError(`a baseUrl do conector não é uma URL (${conn.url})`, 'CONFIG_ERROR')
  }
  const secure = SCHEMES[url.protocol]
  if (secure === undefined) throw new KafkaError(`a baseUrl do conector precisa ser kafka:// ou kafkas:// (veio ${url.protocol}//)`, 'CONFIG_ERROR')
  const seeds = [{ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 9092) }]
  for (const item of String(config.brokers ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const address = parseAddress(item, seeds[0]?.port ?? 9092)
    if (address && !seeds.some((s) => s.host === address.host && s.port === address.port)) seeds.push(address)
  }
  /** @type {import('./lib/client').SaslConfig | undefined} */
  let sasl
  const auth = conn.auth
  const mechanism = config.sasl || 'auto'
  if (auth?.type === 'basic') sasl = { mechanism, username: auth.username ?? '', password: auth.password ?? '' }
  else if (auth?.token !== undefined) sasl = { mechanism: mechanism === 'auto' ? 'OAUTHBEARER' : mechanism, token: auth.token }
  else if (auth) throw new KafkaError(`a auth ${auth.type} do conector não se aplica ao Kafka (use basic para SASL PLAIN/SCRAM, ou bearer/oauth2 para OAUTHBEARER)`, 'CONFIG_ERROR')
  else if (mechanism !== 'auto') throw new KafkaError(`SASL ${mechanism} precisa de uma auth no conector`, 'CONFIG_ERROR')
  return { seeds, tls: secure ? conn.tls ?? true : conn.tls, ...(sasl && { sasl }) }
}

/** @param {unknown} value @param {string | undefined} format @returns {Buffer | null} */
function toBytes(value, format) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return Buffer.from(value, format === 'base64' ? 'base64' : 'utf8')
  return Buffer.from(JSON.stringify(value), 'utf8')
}

/** @param {Buffer | null} bytes @param {string} format */
function fromBytes(bytes, format) {
  if (bytes === null) return null
  if (format === 'base64') return bytes.toString('base64')
  let text
  try {
    text = utf8.decode(bytes)
  } catch {
    if (format === 'text') return bytes.toString('utf8')
    return { base64: bytes.toString('base64') }
  }
  if (format === 'text') return text
  try {
    return JSON.parse(text)
  } catch {
    if (format === 'json') throw new KafkaError('a mensagem não é JSON (escolha o formato texto ou automático)', 'KAFKA_DECODE')
    return text
  }
}

/** @param {bigint} ms */
const isoOf = (ms) => (ms >= 0n ? new Date(Number(ms)).toISOString() : null)

/** @param {unknown} value @param {string} label */
function toCount(value, label, fallback = 10) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) throw new KafkaError(`${label} precisa ser um inteiro de 1 a ${MAX_COUNT}`, 'CONFIG_ERROR')
  return n
}

/** @param {KafkaConfig} config */
function requireTopic(config) {
  const topic = String(config.topic ?? '').trim()
  if (!topic) throw new KafkaError('informe o tópico', 'CONFIG_ERROR')
  return topic
}

/** @param {Cluster} cluster @param {KafkaConfig} config @param {import('@vvpost/plugin-sdk').AdapterContext} ctx */
async function produce(cluster, config, ctx) {
  const topic = requireTopic(config)
  const codec = WRITABLE[config.compression ?? 'none']
  if (codec === undefined) throw new KafkaError(`compressão ${config.compression} não suportada ao produzir (use none, gzip ou zstd)`, 'CONFIG_ERROR')
  const acks = ACKS[config.acks ?? 'all']
  if (acks === undefined) throw new KafkaError(`acks ${config.acks} inválido`, 'CONFIG_ERROR')
  if (config.headers !== undefined && config.headers !== null && (typeof config.headers !== 'object' || Array.isArray(config.headers))) {
    throw new KafkaError('Headers precisa ser um objeto { "nome": "valor" }', 'CONFIG_ERROR')
  }
  const key = config.key === undefined || config.key === '' ? null : Buffer.from(String(config.key), 'utf8')
  /** @type {[string, Buffer | null][]} */
  const headers = Object.entries(config.headers ?? {}).map(([k, v]) => [k, v === null || v === undefined ? null : Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8')])
  const batch = encodeBatch([{ key, value: toBytes(config.value, config.format), headers }], codec)
  for (let attempt = 0; ; attempt++) {
    const info = await cluster.topic(topic, true)
    /** @type {number} */
    let partition
    if (config.partition !== undefined && config.partition !== null && String(config.partition) !== '') {
      partition = Number(config.partition)
      if (!info.partitions.some((p) => p.partition === partition)) throw new KafkaError(`o tópico ${topic} não tem a partição ${config.partition} (tem ${info.partitions.length})`, 'CONFIG_ERROR')
    } else if (key) partition = partitionFor(key, info.partitions.length)
    else partition = /** @type {number} */ (info.partitions[Math.floor(Math.random() * info.partitions.length)]?.partition)
    const leader = /** @type {import('./lib/client').PartitionInfo} */ (info.partitions.find((p) => p.partition === partition)).leader
    try {
      const result = await cluster.produce(topic, partition, leader, batch, { acks, timeoutMs: Math.max(1000, Math.min(30_000, ctx.timeoutMs)), ...(codec === 4 && { minVersion: 7 }) })
      ctx.log(`Produce em ${topic}[${partition}]${result.offset !== null ? ` → offset ${result.offset}` : ' (acks=none)'}`)
      return {
        topic,
        partition,
        offset: result.offset === null ? null : result.offset.toString(),
        timestamp: result.timestamp === null ? null : isoOf(result.timestamp)
      }
    } catch (err) {
      if (attempt < 2 && RETRIABLE.has(/** @type {any} */ (err).kafkaCode)) continue
      throw err
    }
  }
}

/** @param {unknown} value @returns {bigint} */
function parseTimestamp(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) return BigInt(value)
  const ms = Date.parse(String(value ?? ''))
  if (Number.isNaN(ms)) throw new KafkaError('Horário precisa ser uma data ISO (2026-01-31T12:00:00Z) ou milissegundos desde 1970', 'CONFIG_ERROR')
  return BigInt(ms)
}

/**
 * @param {Cluster} cluster @param {KafkaConfig} config @param {import('@vvpost/plugin-sdk').AdapterContext} ctx
 * @param {{ deadline: number }} limits
 */
async function consume(cluster, config, ctx, limits) {
  const topic = requireTopic(config)
  const count = toCount(config.count, 'Quantidade')
  const from = config.from ?? 'last'
  const format = config.format ?? 'auto'
  if (!['last', 'earliest', 'latest', 'timestamp', 'offset'].includes(from)) throw new KafkaError(`ponto de partida ${from} inválido`, 'CONFIG_ERROR')
  let info = await cluster.topic(topic)
  let partitions = info.partitions
  const hasPartition = config.partition !== undefined && config.partition !== null && String(config.partition) !== ''
  if (hasPartition) {
    partitions = partitions.filter((p) => p.partition === Number(config.partition))
    if (!partitions.length) throw new KafkaError(`o tópico ${topic} não tem a partição ${config.partition} (tem ${info.partitions.length})`, 'CONFIG_ERROR')
  } else if (from === 'offset') throw new KafkaError('ler a partir de um offset precisa da partição', 'CONFIG_ERROR')

  /** @param {import('./lib/client').PartitionInfo[]} list */
  const byLeader = (list) => {
    /** @type {Map<number, number[]>} */
    const groups = new Map()
    for (const p of list) groups.set(p.leader, [...(groups.get(p.leader) ?? []), p.partition])
    return groups
  }
  /** @param {bigint} timestamp */
  const offsetsAt = async (timestamp) => {
    /** @type {Map<number, { offset: bigint, timestamp: bigint }>} */
    const all = new Map()
    for (const [leader, ids] of byLeader(partitions)) {
      for (const [k, v] of await cluster.listOffsets(leader, topic, ids.map((partition) => ({ partition, timestamp })))) all.set(k, v)
    }
    return all
  }
  const ends = await offsetsAt(-1n)
  const starts = await offsetsAt(-2n)
  const at = from === 'timestamp' ? await offsetsAt(parseTimestamp(config.timestamp)) : undefined

  /** @type {Map<number, { next: bigint, stop: bigint | null, taken: number, empty: number }>} */
  const state = new Map()
  for (const p of partitions) {
    const end = /** @type {bigint} */ (ends.get(p.partition)?.offset)
    const start = /** @type {bigint} */ (starts.get(p.partition)?.offset)
    let next = start
    if (from === 'latest') next = end
    else if (from === 'last') next = end - BigInt(count) > start ? end - BigInt(count) : start
    else if (from === 'timestamp') {
      const found = at?.get(p.partition)?.offset ?? -1n
      next = found >= 0n ? found : end
    } else if (from === 'offset') {
      const wanted = BigInt(String(config.offset ?? '0').trim() || '0')
      if (wanted < start || wanted > end) throw new KafkaError(`o offset ${wanted} está fora do que a partição ${p.partition} guarda (${start} a ${end})`, 'KAFKA_OFFSET_OUT_OF_RANGE')
      next = wanted
    }
    state.set(p.partition, { next, stop: from === 'latest' ? null : end, taken: 0, empty: 0 })
  }

  const maxWaitMs = Math.max(0, Math.min(Number(config.maxWaitMs ?? 1000) || 0, 60_000))
  const waitUntil = Math.min(limits.deadline - 200, Date.now() + maxWaitMs)
  /** @type {any[]} */
  const messages = []
  const active = () => partitions.filter((p) => {
    const s = /** @type {NonNullable<ReturnType<typeof state.get>>} */ (state.get(p.partition))
    return s.taken < count && (s.stop === null || s.next < s.stop) && s.empty < 3
  })
  let refreshed = false
  for (;;) {
    const open = active()
    if (!open.length) break
    if (from === 'latest' && (messages.length >= count || Date.now() >= waitUntil)) break
    if (Date.now() >= limits.deadline - 100) break
    for (const [leader, ids] of byLeader(open)) {
      const wait = from === 'latest' ? Math.max(0, Math.min(waitUntil - Date.now(), 5000)) : 100
      const result = await cluster.fetch(leader, topic, ids.map((partition) => ({ partition, offset: /** @type {any} */ (state.get(partition)).next })), { maxWaitMs: wait })
      for (const [partition, res] of result) {
        const s = /** @type {NonNullable<ReturnType<typeof state.get>>} */ (state.get(partition))
        if (res.error) {
          if (RETRIABLE.has(res.error) && !refreshed) {
            refreshed = true
            info = await cluster.topic(topic)
            partitions = info.partitions.filter((p) => state.has(p.partition))
            continue
          }
          throw new KafkaError(`Fetch em ${topic}[${partition}]: ${errorName(res.error)}`, 'KAFKA_ERROR')
        }
        const batches = res.records && res.records.length ? decodeBatches(res.records) : []
        if (!batches.length) {
          if (from !== 'latest') s.empty++
          continue
        }
        s.empty = 0
        for (const batch of batches) {
          for (const rec of batch.records) {
            if (rec.offset < s.next || (s.stop !== null && rec.offset >= s.stop) || s.taken >= count) continue
            s.taken++
            messages.push({
              topic,
              partition,
              offset: rec.offset,
              timestamp: rec.timestamp,
              key: rec.key === null ? null : fromBytes(rec.key, 'text'),
              value: fromBytes(rec.value, format),
              headers: Object.fromEntries(rec.headers.map(([k, v]) => [k, v === null ? null : v.toString('utf8')]))
            })
          }
          if (batch.lastOffset + 1n > s.next) s.next = batch.lastOffset + 1n
        }
      }
    }
  }
  messages.sort((a, b) => (a.timestamp === b.timestamp ? (a.partition - b.partition || (a.offset < b.offset ? -1 : 1)) : a.timestamp < b.timestamp ? -1 : 1))
  const picked = from === 'last' ? messages.slice(-count) : messages.slice(0, count)
  ctx.log(`${picked.length} mensagem(ns) de ${topic} (${partitions.length} partição(ões), a partir de ${from})`)
  return picked.map((m) => ({ ...m, offset: m.offset.toString(), timestamp: isoOf(m.timestamp) }))
}

/** @param {Cluster} cluster @param {KafkaConfig} config */
async function topics(cluster, config) {
  const topic = String(config.topic ?? '').trim()
  const meta = await cluster.metadata(topic ? [topic] : null)
  return {
    clusterId: meta.clusterId,
    controller: meta.controllerId,
    brokers: meta.brokers.map((b) => ({ nodeId: b.nodeId, host: b.host, port: b.port })).sort((a, b) => a.nodeId - b.nodeId),
    topics: meta.topics
      .filter((t) => !topic || t.name === topic)
      .map((t) => ({
        name: t.name,
        ...(t.error && { error: errorName(t.error) }),
        internal: t.internal,
        partitions: t.partitions.map((p) => ({ partition: p.partition, leader: p.leader, replicas: p.replicas, isr: p.isr }))
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** @type {import('@vvpost/plugin-sdk').PluginModule} */
module.exports = {
  adapters: {
    kafka: {
      async send(ctx) {
        const config = /** @type {KafkaConfig} */ (ctx.config)
        const conn = ctx.connection
        if (!conn) throw new KafkaError('escolha um conector com a baseUrl do broker (ex.: kafka://localhost:9092 ou kafkas://broker.example.com:9093)', 'CONFIG_ERROR')
        const limits = { deadline: Date.now() + ctx.timeoutMs, signal: ctx.signal }
        const cluster = new Cluster({ ...clusterOptions(conn, config), limits, clientId: 'vvpost', log: (m) => ctx.log(m) })
        try {
          const operation = config.operation ?? 'produce'
          let data
          if (operation === 'produce') data = await produce(cluster, config, ctx)
          else if (operation === 'consume') data = await consume(cluster, config, ctx, limits)
          else if (operation === 'topics') data = await topics(cluster, config)
          else throw new KafkaError(`operação ${operation} inválida`, 'CONFIG_ERROR')
          return { data, status: 200, headers: cluster.mechanism ? { 'x-kafka-sasl': cluster.mechanism } : {} }
        } finally {
          cluster.close()
        }
      }
    }
  }
}
