import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer, type TlsOptions } from 'node:tls'

/**
 * Broker Kafka de mentira para os testes do vvpost-plugin-kafka: um nó só, as versões que o
 * plugin fala (ApiVersions v0, Metadata v8, Produce v8, ListOffsets v5, Fetch v11,
 * SaslHandshake v1, SaslAuthenticate v1), SASL PLAIN e SCRAM-SHA-256 de verdade, e os
 * batches guardados como chegam (o offset base é reescrito). O plugin também foi
 * conferido contra um Kafka 3.9 real (ver docs/plugins.md).
 */

const require = createRequire(import.meta.url)
const { Writer, Reader } = require('../../plugins/vvpost-plugin-kafka/lib/wire.js')

interface Stored {
  base: bigint
  last: bigint
  timestamp: bigint
  bytes: Buffer
}

export interface FakeKafka {
  port: number
  /** Batches por tópico e partição. */
  topics: Map<string, Stored[][]>
  /** Requisições recebidas (api_key/versão) e o client_id. */
  requests: { apiKey: number; version: number; clientId: string | null }[]
  close(): Promise<void>
}

export interface FakeKafkaOptions {
  /** Host anunciado na metadata (padrão: 127.0.0.1). */
  advertisedHost?: string
  /** Exige SASL com estes usuários (PLAIN e SCRAM-SHA-256). */
  users?: Record<string, string>
  partitions?: number
  /** Escuta em TLS (com requestCert, exige o certificado do cliente). */
  tls?: TlsOptions
}

const VERSIONS: [number, number, number][] = [
  [0, 3, 8],
  [1, 4, 11],
  [2, 1, 5],
  [3, 1, 8],
  [17, 1, 1],
  [18, 0, 0],
  [36, 0, 1]
]

export async function startFakeKafka(options: FakeKafkaOptions = {}): Promise<FakeKafka> {
  const topics = new Map<string, Stored[][]>()
  const requests: FakeKafka['requests'] = []
  const sockets = new Set<Socket>()
  const partitionsPerTopic = options.partitions ?? 3
  let port = 0

  const ensure = (name: string): Stored[][] => {
    let t = topics.get(name)
    if (!t) {
      t = Array.from({ length: partitionsPerTopic }, () => [])
      topics.set(name, t)
    }
    return t
  }
  const endOffset = (log: Stored[]) => (log.length ? log[log.length - 1]!.last + 1n : 0n)

  const handler = (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let authenticated = !options.users
    let mechanism = ''
    let scram: { first: string; serverFirst: string; nonce: string; salted: Buffer; user: string } | null = null
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32BE(0)) {
        const frame = buffer.subarray(4, 4 + buffer.readInt32BE(0))
        buffer = buffer.subarray(4 + frame.length)
        const r = new Reader(frame)
        const apiKey = r.int16()
        const version = r.int16()
        const correlation = r.int32()
        const clientId = r.string()
        requests.push({ apiKey, version, clientId })
        const w = new Writer().int32(correlation)
        if (!authenticated && ![17, 18, 36].includes(apiKey)) {
          socket.destroy()
          return
        }
        if (apiKey === 18) {
          w.int16(0).array(VERSIONS, (x: any, [k, min, max]: number[]) => x.int16(k).int16(min).int16(max))
        } else if (apiKey === 17) {
          mechanism = r.string()
          const enabled = ['PLAIN', 'SCRAM-SHA-256']
          w.int16(enabled.includes(mechanism) ? 0 : 33).array(enabled, (x: any, m: string) => x.string(m))
        } else if (apiKey === 36) {
          const bytes: Buffer = r.bytes()
          let error = 0
          let reply = Buffer.alloc(0)
          if (mechanism === 'PLAIN') {
            const [, user, pass] = bytes.toString('utf8').split('\0')
            if (options.users?.[user!] === pass) authenticated = true
            else error = 58
          } else if (!scram) {
            const first = bytes.toString('utf8').slice(3)
            const fields = Object.fromEntries(first.split(',').map((p) => [p[0], p.slice(2)]))
            const nonce = `${fields.r}${randomBytes(8).toString('hex')}`
            const salt = randomBytes(16)
            const serverFirst = `r=${nonce},s=${salt.toString('base64')},i=4096`
            const password = options.users?.[fields.n!] ?? randomBytes(8).toString('hex')
            scram = { first, serverFirst, nonce, salted: pbkdf2Sync(password, salt, 4096, 32, 'sha256'), user: fields.n! }
            reply = Buffer.from(serverFirst)
          } else {
            const final = bytes.toString('utf8')
            const proof = Buffer.from(final.slice(final.indexOf(',p=') + 3), 'base64')
            const authMessage = `${scram.first},${scram.serverFirst},${final.slice(0, final.indexOf(',p='))}`
            const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest()
            const storedKey = createHash('sha256').update(hmac(scram.salted, 'Client Key')).digest()
            const signature = hmac(storedKey, authMessage)
            const clientKey = Buffer.from(proof.map((b, i) => b ^ signature[i]!))
            if (createHash('sha256').update(clientKey).digest().equals(storedKey)) {
              authenticated = true
              reply = Buffer.from(`v=${hmac(hmac(scram.salted, 'Server Key'), authMessage).toString('base64')}`)
            } else error = 58
          }
          w.int16(error).string(error ? 'Authentication failed: Invalid username or password' : null).bytes(reply)
          if (version >= 1) w.int64(0)
        } else if (apiKey === 3) {
          const n = r.int32()
          const names: string[] | null = n < 0 ? null : Array.from({ length: n }, () => r.string())
          const auto = r.bool()
          if (names && auto) names.forEach(ensure)
          const list = names ?? [...topics.keys()]
          const out = new Writer().int32(correlation).int32(0)
            .array([1], (x: any) => x.int32(1).string(options.advertisedHost ?? '127.0.0.1').int32(port).string(null))
            .string('fake-cluster')
            .int32(1)
            .array(list, (x: any, name: string) => {
              const t = topics.get(name)
              x.int16(t ? 0 : 3).string(name).bool(false)
              x.array(t ? t.map((_, i) => i) : [], (y: any, i: number) => y.int16(0).int32(i).int32(1).int32(0).array([1], (z: any, n: number) => z.int32(n)).array([1], (z: any, n: number) => z.int32(n)).array([], () => {}))
              x.int32(-2147483648)
            })
            .int32(-2147483648)
          send(socket, out.build())
          continue
        } else if (apiKey === 0) {
          r.string()
          const acks = r.int16()
          r.int32()
          const results: [string, [number, number, bigint][]][] = r.array((x: any) => {
            const name: string = x.string()
            const t = topics.get(name)
            return [name, x.array((y: any) => {
              const partition: number = y.int32()
              const bytes: Buffer = Buffer.from(y.bytes())
              const log = t?.[partition]
              if (!log) return [partition, 3, -1n]
              if (name === 'proibido') return [partition, 29, -1n]
              const base = endOffset(log)
              bytes.writeBigInt64BE(base, 0)
              const lastDelta = bytes.readInt32BE(23)
              log.push({ base, last: base + BigInt(lastDelta), timestamp: bytes.readBigInt64BE(27), bytes })
              return [partition, 0, base]
            })]
          })
          if (acks === 0) continue
          w.array(results, (x: any, [name, parts]: [string, [number, number, bigint][]]) =>
            x.string(name).array(parts, (y: any, [p, e, o]: [number, number, bigint]) => y.int32(p).int16(e).int64(o).int64(-1).int64(0).array([], () => {}).string(null))
          ).int32(0)
        } else if (apiKey === 2) {
          r.int32()
          r.int8()
          const results = r.array((x: any) => {
            const name: string = x.string()
            const log = topics.get(name)
            return [name, x.array((y: any) => {
              const partition: number = y.int32()
              y.int32()
              const ts: bigint = y.int64()
              const entries = log?.[partition]
              if (!entries) return [partition, 3, -1n, -1n]
              if (ts === -2n) return [partition, 0, -1n, entries[0]?.base ?? 0n]
              if (ts === -1n) return [partition, 0, -1n, endOffset(entries)]
              const hit = entries.find((s) => s.timestamp >= ts)
              return [partition, 0, hit ? hit.timestamp : -1n, hit ? hit.base : -1n]
            })]
          })
          w.int32(0).array(results, (x: any, [name, parts]: [string, any[]]) =>
            x.string(name).array(parts, (y: any, [p, e, ts, o]: [number, number, bigint, bigint]) => y.int32(p).int16(e).int64(ts).int64(o).int32(0))
          )
        } else if (apiKey === 1) {
          r.int32()
          r.int32()
          r.int32()
          r.int32()
          r.int8()
          r.int32()
          r.int32()
          const results = r.array((x: any) => {
            const name: string = x.string()
            const log = topics.get(name)
            return [name, x.array((y: any) => {
              const partition: number = y.int32()
              y.int32()
              const offset: bigint = y.int64()
              y.int64()
              y.int32()
              const entries = log?.[partition]
              if (!entries) return [partition, 3, -1n, null]
              const bytes = Buffer.concat(entries.filter((s) => s.last >= offset).map((s) => s.bytes))
              return [partition, 0, endOffset(entries), bytes]
            })]
          })
          w.int32(0).int16(0).int32(0).array(results, (x: any, [name, parts]: [string, any[]]) =>
            x.string(name).array(parts, (y: any, [p, e, hw, bytes]: [number, number, bigint, Buffer | null]) =>
              y.int32(p).int16(e).int64(hw).int64(hw).int64(0).array([], () => {}).int32(-1).bytes(bytes)
            )
          )
        } else {
          socket.destroy()
          return
        }
        send(socket, w.build())
      }
    })
  }
  const server: Server = options.tls ? createTlsServer(options.tls, handler) : createServer(handler)

  await new Promise<void>((resolve) => server.listen(0, resolve))
  port = (server.address() as AddressInfo).port
  return {
    port,
    topics,
    requests,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

function send(socket: Socket, body: Buffer): void {
  const size = Buffer.alloc(4)
  size.writeInt32BE(body.length)
  socket.write(Buffer.concat([size, body]))
}
