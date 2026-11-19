import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createSecureServer, createServer, type Http2Server, type Http2SecureServer, type ServerHttp2Stream } from 'node:http2'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Flow, FlowNode } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { runFlow } from '@vvpost/core/flows/run'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { PluginManager } from '@vvpost/core/plugins/manager'
import { createTestPki, type TestPki } from './helpers/test-pki'

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')
const require = createRequire(import.meta.url)
const pb = require('../plugins/vvpost-plugin-grpc/lib/protobuf.js')
const { descriptors } = require('../plugins/vvpost-plugin-grpc/lib/descriptor.js')
const { REFLECTION_PROTO } = require('../plugins/vvpost-plugin-grpc/lib/reflection.js')
const { frame, unframe } = require('../plugins/vvpost-plugin-grpc/lib/transport.js')
const { parseProto } = require('../plugins/vvpost-plugin-grpc/lib/proto-parser.js')

const SHOP_PROTO = `
syntax = "proto3";
package shop.v1;
import "google/protobuf/timestamp.proto";
service Shop {
  rpc GetItem(GetItemRequest) returns (Item);
  rpc ListItems(ListRequest) returns (stream Item) { option deprecated = true; }
  rpc Upload(stream Item) returns (Summary);
}
// Comentário de linha
message GetItemRequest { int64 id = 1; }
message ListRequest { int32 count = 1; }
/* bloco */
message Item {
  int64 id = 1;
  string name = 2;
  double price = 3;
  repeated string tags = 4;
  map<string, int32> stock = 5;
  Kind kind = 6;
  google.protobuf.Timestamp created = 7;
  optional string note = 8;
  oneof promo { float discount = 9; bool free = 10; }
  string auth = 11 [json_name = "authHeader"];
  enum Kind { KIND_UNSPECIFIED = 0; BOOK = 1; GAME = 2; }
}
message Summary { int32 count = 1; repeated int64 ids = 2 [packed = true]; }
`

describe('protobuf do plugin gRPC', () => {
  const registry = () => new pb.Registry().addProto(SHOP_PROTO)

  it('codifica e decodifica com o mapeamento JSON do proto3', () => {
    const r = registry()
    const item = { id: '-42', name: 'Livro', price: 9.5, tags: ['a'], stock: { sp: 3 }, kind: 'BOOK', created: '2024-01-02T03:04:05.120Z', free: true, authHeader: 'x' }
    const bytes = pb.encode(r, 'shop.v1.Item', item)
    // Bytes conferidos contra o protobufjs/grpc-js: id em varint de 10 bytes (negativo), map como mensagem de entrada.
    expect(bytes.subarray(0, 11).toString('hex')).toBe('08d6ffffffffffffffff01')
    expect(pb.decode(r, 'shop.v1.Item', bytes)).toEqual({ ...item, stock: { sp: 3 } })
    // Sem valor: os padrões aparecem (menos oneof e optional), e somem com emitDefaults: false.
    expect(pb.decode(r, 'shop.v1.Item', Buffer.alloc(0))).toEqual({ id: '0', name: '', price: 0, tags: [], stock: {}, kind: 'KIND_UNSPECIFIED', created: null, authHeader: '' })
    expect(pb.decode(r, 'shop.v1.Item', Buffer.alloc(0), { emitDefaults: false })).toEqual({})
    // Nome do .proto também vale na entrada.
    expect(pb.decode(r, 'shop.v1.Item', pb.encode(r, 'shop.v1.Item', { auth: 'y' }), { emitDefaults: false })).toEqual({ authHeader: 'y' })
    // Packed e não packed são lidos.
    expect(pb.decode(r, 'shop.v1.Summary', Buffer.from('100110021003', 'hex'))).toEqual({ count: 0, ids: ['1', '2', '3'] })
  })

  it('erros dizem o caminho do campo e o que era esperado', () => {
    const r = registry()
    expect(() => pb.encode(r, 'shop.v1.Item', { nope: 1 })).toThrow('shop.v1.Item: shop.v1.Item não tem o campo "nope"')
    expect(() => pb.encode(r, 'shop.v1.Item', { kind: 'CD' })).toThrow('"CD" não é um valor de shop.v1.Item.Kind')
    expect(() => pb.encode(r, 'shop.v1.Item', { created: 'ontem' })).toThrow('Timestamp em RFC 3339')
    expect(() => pb.encode(r, 'shop.v1.Item', { tags: 'a' })).toThrow('um campo repeated vai como lista')
    expect(() => new pb.Registry().addProto('syntax = "proto3"; message A { B b = 1; }').resolve()).toThrow('tipo B não encontrado')
    expect(() => parseProto('message A { int32 x = ; }')).toThrow('.proto, linha 1: esperava um número inteiro')
  })

  it('Struct, Value, Duration, wrappers, FieldMask e Any', () => {
    const r = new pb.Registry().addProto(`syntax = "proto3"; package t;
      message W { google.protobuf.Struct s = 1; google.protobuf.Duration d = 2; google.protobuf.Int64Value i = 3;
        google.protobuf.FieldMask m = 4; google.protobuf.Any any = 5; google.protobuf.Value v = 6; google.protobuf.Empty e = 7; }
      message Inner { string name = 1; }`)
    const value = { s: { a: [1, 'b', null, { c: true }] }, d: '-1.500s', i: '7', m: 'fooBar,baz', any: { '@type': 'type.googleapis.com/t.Inner', name: 'x' }, v: 3, e: {} }
    expect(pb.decode(r, 't.W', pb.encode(r, 't.W', value))).toEqual(value)
  })

  it('vários arquivos colados em sequência, cada um com syntax', () => {
    const files = parseProto('syntax = "proto3"; package a; message X { b.Y y = 1; }\nsyntax = "proto3"; package b; message Y { int32 n = 1; }')
    expect(files.map((f: { package: string }) => f.package)).toEqual(['a', 'b'])
    const r = new pb.Registry().addProto('syntax = "proto3"; package a; message X { b.Y y = 1; }\nsyntax = "proto3"; package b; message Y { int32 n = 1; }')
    expect(pb.decode(r, 'a.X', pb.encode(r, 'a.X', { y: { n: 5 } }))).toEqual({ y: { n: 5 } })
  })
})

/** Servidor gRPC de teste em node:http2, com o mesmo codec (o interop com o grpc-js foi conferido à parte). */
function grpcHandler(seen: { path: string; headers: Record<string, unknown> }[]) {
  const r = new pb.Registry().addProto(SHOP_PROTO)
  const reflection = new pb.Registry().addProto(REFLECTION_PROTO)
  // FileDescriptorProto do shop.proto, como um servidor real devolveria (nomes absolutos, map_entry).
  const descriptor = pb.encode(descriptors, 'google.protobuf.FileDescriptorProto', {
    name: 'shop.proto',
    package: 'shop.v1',
    syntax: 'proto3',
    dependency: ['google/protobuf/timestamp.proto'],
    messageType: [
      { name: 'GetItemRequest', field: [{ name: 'id', number: 1, label: 1, type: 3, jsonName: 'id' }] },
      { name: 'ListRequest', field: [{ name: 'count', number: 1, label: 1, type: 5 }] },
      {
        name: 'Item',
        field: [
          { name: 'id', number: 1, label: 1, type: 3 },
          { name: 'name', number: 2, label: 1, type: 9 },
          { name: 'stock', number: 5, label: 3, type: 11, typeName: '.shop.v1.Item.StockEntry' },
          { name: 'created', number: 7, label: 1, type: 11, typeName: '.google.protobuf.Timestamp' },
          { name: 'auth', number: 11, label: 1, type: 9, jsonName: 'authHeader' }
        ],
        nestedType: [
          { name: 'StockEntry', field: [{ name: 'key', number: 1, label: 1, type: 9 }, { name: 'value', number: 2, label: 1, type: 5 }], options: { mapEntry: true } }
        ]
      }
    ],
    service: [
      {
        name: 'Shop',
        method: [
          { name: 'GetItem', inputType: '.shop.v1.GetItemRequest', outputType: '.shop.v1.Item' },
          { name: 'ListItems', inputType: '.shop.v1.ListRequest', outputType: '.shop.v1.Item', serverStreaming: true }
        ]
      }
    ]
  })
  return (stream: ServerHttp2Stream, headers: Record<string, unknown>) => {
    const path = String(headers[':path'])
    seen.push({ path, headers })
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => {
      const requests: Buffer[] = unframe(Buffer.concat(chunks))
      const reply = (messages: Buffer[], status = 0, message?: string) => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'x-server': 'test' }, { waitForTrailers: true })
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': String(status), ...(message && { 'grpc-message': encodeURIComponent(message) }) }))
        for (const m of messages) stream.write(frame(m))
        stream.end()
      }
      if (path === '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo') {
        return reply(
          requests.map((req) => {
            const q = pb.decode(reflection, 'grpc.reflection.v1.ServerReflectionRequest', req, { emitDefaults: false })
            if (q.listServices !== undefined) return pb.encode(reflection, 'grpc.reflection.v1.ServerReflectionResponse', { listServicesResponse: { service: [{ name: 'shop.v1.Shop' }] } })
            if (q.fileContainingSymbol === 'shop.v1.Shop') {
              return pb.encode(reflection, 'grpc.reflection.v1.ServerReflectionResponse', { fileDescriptorResponse: { fileDescriptorProto: [descriptor.toString('base64')] } })
            }
            return pb.encode(reflection, 'grpc.reflection.v1.ServerReflectionResponse', { errorResponse: { errorCode: 5, errorMessage: `Symbol not found: ${q.fileContainingSymbol}` } })
          })
        )
      }
      if (path === '/shop.v1.Shop/GetItem') {
        const { id } = pb.decode(r, 'shop.v1.GetItemRequest', requests[0]!)
        if (id === '404') return reply([], 5, 'item não existe')
        return reply([pb.encode(r, 'shop.v1.Item', { id, name: `item ${id}`, stock: { sp: 2 }, created: '2024-01-02T03:04:05Z', authHeader: String(headers['authorization'] ?? '') })])
      }
      if (path === '/shop.v1.Shop/ListItems') {
        const { count } = pb.decode(r, 'shop.v1.ListRequest', requests[0]!)
        return reply(Array.from({ length: count }, (_, i) => pb.encode(r, 'shop.v1.Item', { id: String(i + 1) })))
      }
      if (path === '/shop.v1.Shop/Upload') {
        const ids = requests.map((m) => pb.decode(r, 'shop.v1.Item', m).id)
        return reply([pb.encode(r, 'shop.v1.Summary', { count: ids.length, ids })])
      }
      reply([], 12, 'método desconhecido')
    })
  }
}

let plain: Http2Server
let secure: Http2SecureServer
let pki: TestPki
let plainPort: number
let securePort: number
const seen: { path: string; headers: Record<string, unknown> }[] = []
let http: HttpDispatcher

beforeAll(async () => {
  pki = await createTestPki()
  plain = createServer()
  plain.on('stream', grpcHandler(seen))
  secure = createSecureServer({ key: pki.server.key, cert: pki.server.cert, ca: pki.ca, requestCert: true, rejectUnauthorized: true })
  secure.on('stream', grpcHandler(seen))
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => secure.listen(0, '127.0.0.1', r))
  plainPort = (plain.address() as AddressInfo).port
  securePort = (secure.address() as AddressInfo).port
  http = createHttpDispatcher()
})
afterAll(async () => {
  await http.close()
  plain.close()
  secure.close()
})

let ws: string
let userData: string
let manager: PluginManager
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'vvpost-grpc-ws-'))
  userData = mkdtempSync(join(tmpdir(), 'vvpost-grpc-ud-'))
  manager = new PluginManager({ officialDir: OFFICIAL, userDir: join(userData, 'plugins'), stateFile: join(userData, 'plugins.json') })
  seen.length = 0
})
afterEach(async () => {
  await manager.shutdown()
  rmSync(ws, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(ws, path)), { recursive: true })
  writeFileSync(join(ws, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

async function run(nodes: FlowNode[], baseUrl = `grpc://127.0.0.1:${plainPort}`, tls?: Record<string, string>, chain = true) {
  write('connectors/shop.connector.vvpost.json', {
    id: 'shop.grpc',
    name: 'Shop',
    version: '1.0.0',
    config: { baseUrl: '{{SHOP_URL}}', auth: { type: 'bearer', token: '{{TOKEN}}' }, ...(tls && { tls }) }
  })
  write('environments/dev.env.json', {
    id: 'env.dev',
    name: 'Dev',
    variables: { SHOP_URL: { type: 'string', value: baseUrl }, TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
  })
  write('.vvpost/secrets.local.json', { 'env.dev': { TOKEN: 'tok-secreto' } })
  // Em sequência, na ordem da lista.
  const flow: Flow = { id: 'flow.grpc', name: 'gRPC', nodes, edges: chain ? nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })) : [] }
  return runFlow(
    { runId: 'r', flow, environmentId: 'env.dev' },
    { workspace: await loadWorkspace(ws), auth: createAuthEngine(), http, plugins: await manager.runner() }
  )
}

const grpc = (id: string, name: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}): FlowNode =>
  ({ id, name, type: 'plugin', plugin: { adapter: 'grpc', connector: 'shop.grpc', config, ...extra } }) as FlowNode

describe('vvpost-plugin-grpc no fluxo', () => {
  it('unária pelo reflection, com a auth do conector como metadata; server streaming e client streaming', async () => {
    const report = await run([
      grpc('a', 'Get', { service: 'Shop', method: 'GetItem', message: { id: 7 }, metadata: { 'x-tenant': 'acme' } }),
      grpc('b', 'List', { service: 'shop.v1.Shop', method: 'ListItems', message: { count: '{{ $nodes.Get.data.stock.sp }}' }, emitDefaults: false }),
      grpc('c', 'Upload', { service: 'shop.v1.Shop', method: 'Upload', message: [{ id: 1 }, { id: 2 }], proto: SHOP_PROTO })
    ])
    const byName = (n: string) => report.results.find((r) => r.name === n)!
    expect(byName('Get').output).toMatchObject({
      data: { id: '7', name: 'item 7', stock: { sp: 2 }, created: '2024-01-02T03:04:05Z', authHeader: 'Bearer tok-secreto' },
      status: 200,
      headers: { 'grpc-status': '0', 'x-server': 'test' }
    })
    const get = seen.find((s) => s.path === '/shop.v1.Shop/GetItem')!
    expect(get.headers['x-tenant']).toBe('acme')
    expect(get.headers['content-type']).toBe('application/grpc')
    expect(byName('List').output).toMatchObject({ data: [{ id: '1' }, { id: '2' }] })
    expect(byName('Upload').output).toMatchObject({ data: { count: 2, ids: ['1', '2'] } })
    expect(byName('Get').logs).toMatch(/reflection \(grpc.reflection.v1\): 1 arquivo/)
  })

  it('status de erro do gRPC vira o HTTP equivalente e falha o nó, a menos de ignoreHttpErrors', async () => {
    const report = await run([
      grpc('a', 'Missing', { service: 'shop.v1.Shop', method: 'GetItem', message: { id: 404 } }),
      grpc('b', 'Ignored', { service: 'shop.v1.Shop', method: 'GetItem', message: { id: 404 } }, { ignoreHttpErrors: true }),
      grpc('c', 'Nope', { service: 'Nada', method: 'X' }),
      grpc('d', 'BadField', { service: 'shop.v1.Shop', method: 'GetItem', message: { idd: 1 } })
    ], undefined, undefined, false)
    const byName = (n: string) => report.results.find((r) => r.name === n)!
    expect(byName('Missing').error).toEqual({ code: 'HTTP_STATUS', message: 'HTTP 404' })
    expect(byName('Ignored').output).toMatchObject({ data: { code: 'NOT_FOUND', message: 'item não existe' }, status: 404, headers: { 'grpc-status': '5' } })
    expect(byName('Nope').error?.message).toBe('[GRPC_SERVICE_NOT_FOUND] serviço Nada não encontrado (disponíveis: shop.v1.Shop)')
    expect(byName('BadField').error?.message).toMatch(/\[PROTO_ENCODE\] message: shop.v1.GetItemRequest não tem o campo "idd"/)
  })

  it('grpcs:// com o mTLS do conector', async () => {
    write('certs/client.crt', pki.client.cert)
    write('certs/client.key', pki.client.key)
    write('certs/ca.crt', pki.ca)
    const report = await run(
      [grpc('a', 'Get', { service: 'shop.v1.Shop', method: 'GetItem', message: { id: 1 }, proto: SHOP_PROTO })],
      `grpcs://127.0.0.1:${securePort}`,
      { cert: 'certs/client.crt', key: 'certs/client.key', ca: 'certs/ca.crt' }
    )
    expect(report.results[0]!.output).toMatchObject({ data: { id: '1' }, status: 200 })
  })

  it('declara só o host do conector e o recebimento das credenciais dele', async () => {
    const { plugins } = await manager.catalog()
    expect(plugins.find((p) => p.id === 'vvpost-plugin-grpc')?.permissions).toEqual({
      network: ['connector'],
      connectorCredentials: true,
      summary: ['o host do conector do nó', 'recebe as credenciais do conector do nó']
    })
  })
})
