import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Flow, FlowNode } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { runFlow } from '@vvpost/core/flows/run'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { PluginManager } from '@vvpost/core/plugins/manager'
import { startFakeKafka, type FakeKafka } from './helpers/fake-kafka'
import { createTestPki } from './helpers/test-pki'

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')
const require = createRequire(import.meta.url)
const wire = require('../plugins/vvpost-plugin-kafka/lib/wire.js')
const compression = require('../plugins/vvpost-plugin-kafka/lib/compression.js')
const records = require('../plugins/vvpost-plugin-kafka/lib/records.js')

describe('protocolo do plugin Kafka', () => {
  it('CRC32C, murmur2 e particionador iguais aos do Kafka', () => {
    expect(wire.crc32c(Buffer.from('123456789'))).toBe(0xe3069283)
    // Vetores do UtilsTest do Kafka.
    const vectors: [string, number][] = [
      ['21', -973932308],
      ['foobar', -790332482],
      ['a-little-bit-long-string', -985981536],
      ['a-little-bit-longer-string', -1486304829],
      ['lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8', -58897971],
      ['abc', 479470107]
    ]
    for (const [text, hash] of vectors) expect(wire.murmur2(Buffer.from(text))).toBe(hash)
    // Partições escolhidas pelo produtor Java num tópico de 3 partições.
    expect(['k-snappy', 'k-lz4', 'k-zstd', 'k-gzip'].map((k) => wire.partitionFor(Buffer.from(k), 3))).toEqual([2, 2, 0, 0])
  })

  it('varint e varlong em zigzag', () => {
    for (const n of [0, 1, -1, 63, -64, 300, -300, 2 ** 31 - 1, -(2 ** 31)]) {
      expect(new wire.Reader(new wire.Writer().varint(n).build()).varint()).toBe(n)
    }
    for (const n of [0n, -1n, 1234567890123n, -(2n ** 63n), 2n ** 63n - 1n]) {
      expect(new wire.Reader(new wire.Writer().varlong(n).build()).varlong()).toBe(n)
    }
    expect(new wire.Writer().varint(-1).build().toString('hex')).toBe('01')
    expect(new wire.Writer().varint(300).build().toString('hex')).toBe('d804')
  })

  it('record batch v2 vai e volta, com gzip e zstd, e o CRC é conferido', () => {
    for (const codec of [0, 1, 4]) {
      const batch = records.encodeBatch(
        [
          { key: Buffer.from('k'), value: Buffer.from('{"a":1}'), headers: [['h', Buffer.from('v')]], timestamp: 1_700_000_000_000 },
          { key: null, value: null, timestamp: 1_700_000_000_500 }
        ],
        codec
      )
      const [decoded] = records.decodeBatches(batch)
      expect(decoded.codec).toBe(['none', 'gzip', 'snappy', 'lz4', 'zstd'][codec])
      expect(decoded.lastOffset).toBe(1n)
      expect(decoded.records).toEqual([
        { offset: 0n, timestamp: 1_700_000_000_000n, key: Buffer.from('k'), value: Buffer.from('{"a":1}'), headers: [['h', Buffer.from('v')]] },
        { offset: 1n, timestamp: 1_700_000_000_500n, key: null, value: null, headers: [] }
      ])
    }
    const batch = records.encodeBatch([{ key: null, value: Buffer.from('x') }])
    batch[batch.length - 1] ^= 1
    expect(() => records.decodeBatches(batch)).toThrow('CRC inválido')
    // Um batch cortado no fim (limite de bytes do Fetch) é ignorado.
    expect(records.decodeBatches(Buffer.concat([records.encodeBatch([{ key: null, value: Buffer.from('a') }]), batch.subarray(0, 30)]))).toHaveLength(1)
  })

  it('snappy (bruto e xerial) e LZ4 frame', () => {
    // "abcd" literal + cópia de 8 bytes do offset 4.
    const raw = Buffer.from([12, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x11, 0x04])
    expect(compression.snappy(raw).toString()).toBe('abcdabcdabcd')
    const header = Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00, 0, 0, 0, 1, 0, 0, 0, 1])
    const size = Buffer.alloc(4)
    size.writeInt32BE(raw.length)
    expect(compression.snappy(Buffer.concat([header, size, raw, size, raw])).toString()).toBe('abcdabcdabcd'.repeat(2))
    expect(() => compression.snappy(Buffer.from([12, 0x11, 0x04]))).toThrow('snappy: cópia fora dos limites')

    const block = Buffer.from([0x44, 0x61, 0x62, 0x63, 0x64, 0x04, 0x00, 0x30, 0x78, 0x79, 0x7a])
    const blockSize = Buffer.alloc(4)
    blockSize.writeUInt32LE(block.length)
    const plain = Buffer.from('fim')
    const plainSize = Buffer.alloc(4)
    plainSize.writeUInt32LE((0x80000000 | plain.length) >>> 0)
    const frame = Buffer.concat([Buffer.from([0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82]), blockSize, block, plainSize, plain, Buffer.alloc(4)])
    expect(compression.lz4(frame).toString()).toBe('abcdabcdabcdxyzfim')
    expect(compression.decompress(1, gzipSync('oi')).toString()).toBe('oi')
  })
})

let kafka: FakeKafka | undefined
let ws: string
let userData: string
let manager: PluginManager
const http = createHttpDispatcher()
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'vvpost-kafka-ws-'))
  userData = mkdtempSync(join(tmpdir(), 'vvpost-kafka-ud-'))
  manager = new PluginManager({ officialDir: OFFICIAL, userDir: join(userData, 'plugins'), stateFile: join(userData, 'plugins.json') })
})
afterEach(async () => {
  await manager.shutdown()
  await kafka?.close()
  kafka = undefined
  rmSync(ws, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(ws, path)), { recursive: true })
  writeFileSync(join(ws, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

async function run(
  nodes: FlowNode[],
  baseUrl: string,
  { auth, password = 'segredo', chain = true, tls }: { auth?: Record<string, string>; password?: string; chain?: boolean; tls?: Record<string, string> } = {}
) {
  write('connectors/events.connector.vvpost.json', {
    id: 'events.kafka',
    name: 'Eventos',
    version: '1.0.0',
    config: { baseUrl: '{{KAFKA_URL}}', ...(auth && { auth }), ...(tls && { tls }) }
  })
  write('environments/dev.env.json', {
    id: 'env.dev',
    name: 'Dev',
    variables: { KAFKA_URL: { type: 'string', value: baseUrl }, KAFKA_PASSWORD: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
  })
  write('.vvpost/secrets.local.json', { 'env.dev': { KAFKA_PASSWORD: password } })
  // Em sequência, na ordem da lista (chain), ou independentes.
  const flow: Flow = { id: 'flow.kafka', name: 'Kafka', nodes, edges: chain ? nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })) : [] }
  const report = await runFlow(
    { runId: 'r', flow, environmentId: 'env.dev' },
    { workspace: await loadWorkspace(ws), auth: createAuthEngine(), http, plugins: await manager.runner() }
  )
  return (name: string) => report.results.find((r) => r.name === name)!
}

const node = (id: string, name: string, config: Record<string, unknown>): FlowNode =>
  ({ id, name, type: 'plugin', plugin: { adapter: 'kafka', connector: 'events.kafka', config } }) as FlowNode

describe('vvpost-plugin-kafka no fluxo', () => {
  it('produz com chave, headers e compressão; consome as últimas, do início e de um offset; lista os tópicos', async () => {
    kafka = await startFakeKafka()
    const result = await run(
      [
        node('a', 'Pedido', { operation: 'produce', topic: 'pedidos', key: 'pedido-42', value: { id: 42, total: 10.5 }, headers: { origem: 'vvpost' } }),
        node('b', 'Segundo', { operation: 'produce', topic: 'pedidos', key: 'pedido-42', value: 'texto {{ $nodes.Pedido.data.offset }}', compression: 'gzip' }),
        node('c', 'Terceiro', { operation: 'produce', topic: 'pedidos', key: 'pedido-42', value: [1, 2], compression: 'zstd' }),
        node('d', 'Ultimas', { operation: 'consume', topic: 'pedidos', count: 2 }),
        node('e', 'Inicio', { operation: 'consume', topic: 'pedidos', from: 'earliest', count: 1 }),
        node('f', 'Offset', { operation: 'consume', topic: 'pedidos', from: 'offset', partition: 0, offset: 1, format: 'text' }),
        node('g', 'Topicos', { operation: 'topics' })
      ],
      `kafka://127.0.0.1:${kafka.port}`
    )
    // A chave "pedido-42" cai na partição 0 de 3, como no produtor Java.
    expect(result('Pedido').output).toMatchObject({ data: { topic: 'pedidos', partition: 0, offset: '0' }, status: 200 })
    expect(result('Segundo').output).toMatchObject({ data: { partition: 0, offset: '1' } })
    expect(result('Terceiro').output).toMatchObject({ data: { partition: 0, offset: '2' } })
    const ultimas = result('Ultimas').output as { data: { offset: string; key: string; value: unknown; headers: unknown; timestamp: string }[] }
    expect(ultimas.data.map((m) => [m.offset, m.value])).toEqual([['1', 'texto 0'], ['2', [1, 2]]])
    expect(ultimas.data[0]!.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(result('Inicio').output).toMatchObject({ data: [{ partition: 0, offset: '0', key: 'pedido-42', value: { id: 42, total: 10.5 }, headers: { origem: 'vvpost' } }] })
    expect((result('Offset').output as { data: { value: unknown }[] }).data.map((m) => m.value)).toEqual(['texto 0', '[1,2]'])
    expect(result('Topicos').output).toMatchObject({
      data: { clusterId: 'fake-cluster', brokers: [{ nodeId: 1, host: '127.0.0.1', port: kafka.port }], topics: [{ name: 'pedidos', partitions: [{ partition: 0 }, { partition: 1 }, { partition: 2 }] }] }
    })
    expect(kafka.requests.every((r) => r.clientId === 'vvpost')).toBe(true)
  })

  it('basic do conector vira SASL PLAIN ou SCRAM; senha errada falha o nó', async () => {
    kafka = await startFakeKafka({ users: { app: 'segredo' } })
    const auth = { type: 'basic', username: 'app', password: '{{KAFKA_PASSWORD}}' }
    const result = await run(
      [
        node('a', 'Plain', { operation: 'produce', topic: 't', value: 'a' }),
        node('b', 'Scram', { operation: 'produce', topic: 't', value: 'b', sasl: 'SCRAM-SHA-256' }),
        node('c', 'Lido', { operation: 'consume', topic: 't', from: 'earliest', sasl: 'SCRAM-SHA-256' })
      ],
      `kafka://127.0.0.1:${kafka.port}`,
      { auth }
    )
    expect(result('Plain').output).toMatchObject({ headers: { 'x-kafka-sasl': 'PLAIN' } })
    expect(result('Scram').output).toMatchObject({ headers: { 'x-kafka-sasl': 'SCRAM-SHA-256' } })
    expect((result('Lido').output as { data: { value: string }[] }).data.map((m) => m.value).sort()).toEqual(['a', 'b'])

    const wrong = await run([node('a', 'Errada', { operation: 'topics', sasl: 'SCRAM-SHA-256' })], `kafka://127.0.0.1:${kafka.port}`, { auth, password: 'errada' })
    expect(wrong('Errada').error?.message).toMatch(/\[AUTH_FAILED\] autenticação SASL recusada: Authentication failed/)
  })

  it('kafkas:// com o mTLS do conector', async () => {
    const pki = await createTestPki()
    kafka = await startFakeKafka({ tls: { key: pki.server.key, cert: pki.server.cert, ca: pki.ca, requestCert: true, rejectUnauthorized: true } })
    write('certs/client.crt', pki.client.cert)
    write('certs/client.key', pki.client.key)
    write('certs/ca.crt', pki.ca)
    const result = await run([node('a', 'Seguro', { operation: 'produce', topic: 't', value: 'x' })], `kafkas://127.0.0.1:${kafka.port}`, {
      tls: { cert: 'certs/client.crt', key: 'certs/client.key', ca: 'certs/ca.crt' }
    })
    expect(result('Seguro').output).toMatchObject({ data: { topic: 't', offset: '0' } })
  })

  it('só conecta aos brokers do conector e do campo Brokers', async () => {
    // O cluster anuncia 127.0.0.2, que não é o host do conector.
    kafka = await startFakeKafka({ advertisedHost: '127.0.0.2' })
    const denied = await run([node('a', 'Anunciado', { operation: 'produce', topic: 't', value: 'x' })], `kafka://127.0.0.1:${kafka.port}`)
    expect(denied('Anunciado').error?.message).toMatch(/POLICY_DENIED.*não está nas permissões de rede.*campo Brokers/)
    const allowed = await run(
      [node('a', 'Liberado', { operation: 'produce', topic: 't', value: 'x', brokers: `127.0.0.2:${kafka.port}` })],
      `kafka://127.0.0.1:${kafka.port}`
    )
    expect(allowed('Liberado').output).toMatchObject({ data: { topic: 't', offset: '0' } })
  })

  it('erros de configuração dizem o que falta', async () => {
    kafka = await startFakeKafka()
    const url = `kafka://127.0.0.1:${kafka.port}`
    const result = await run(
      [
        node('a', 'SemTopico', { operation: 'consume' }),
        node('b', 'NaoExiste', { operation: 'consume', topic: 'nada' }),
        node('c', 'Particao', { operation: 'produce', topic: 't', value: 1, partition: 9 }),
        node('d', 'Proibido', { operation: 'produce', topic: 'proibido', value: 1, partition: 0 })
      ],
      url,
      { chain: false }
    )
    expect(result('SemTopico').error?.message).toBe('[CONFIG_ERROR] informe o tópico')
    expect(result('NaoExiste').error?.message).toBe('[KAFKA_UNKNOWN_TOPIC] o tópico nada não existe')
    expect(result('Particao').error?.message).toBe('[CONFIG_ERROR] o tópico t não tem a partição 9 (tem 3)')
    expect(result('Proibido').error?.message).toBe('[KAFKA_ERROR] Produce em proibido[0]: TOPIC_AUTHORIZATION_FAILED')
    const http = await run([node('a', 'Http', { operation: 'topics' })], 'http://127.0.0.1:1')
    expect(http('Http').error?.message).toBe('[CONFIG_ERROR] a baseUrl do conector precisa ser kafka:// ou kafkas:// (veio http://)')
  })

  it('declara o host do conector, os do campo Brokers e o recebimento das credenciais', async () => {
    const { plugins } = await manager.catalog()
    expect(plugins.find((p) => p.id === 'vvpost-plugin-kafka')?.permissions).toEqual({
      network: ['connector', 'config:brokers'],
      connectorCredentials: true,
      summary: ['o host do conector do nó', 'os hosts do campo "Brokers"', 'recebe as credenciais do conector do nó']
    })
  })
})

// Contra um Kafka de verdade: VVPOST_KAFKA_BROKER=127.0.0.1:9092 npx vitest run test/kafka-plugin.test.ts
describe.skipIf(!process.env.VVPOST_KAFKA_BROKER)('vvpost-plugin-kafka contra um broker real', () => {
  it('produz e lê de volta', async () => {
    const topic = `vvpost-${Date.now()}`
    const result = await run(
      [
        node('a', 'Produz', { operation: 'produce', topic, key: 'k', value: { ok: true }, compression: 'zstd' }),
        node('b', 'Le', { operation: 'consume', topic, from: 'earliest' })
      ],
      `kafka://${process.env.VVPOST_KAFKA_BROKER}`
    )
    expect(result('Le').output).toMatchObject({ data: [{ key: 'k', value: { ok: true } }] })
  })
})
