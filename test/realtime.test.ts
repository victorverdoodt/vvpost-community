import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { createSseParser, decodeFrame, eventArgs, openRealtime, socketIoTarget, type RealtimeEvent, type RealtimeOpenInput, type SseEvent } from '@vvpost/core/realtime'
import { createSecretSanitizer } from '@vvpost/core/sanitizer'
import { emptyWorkspace } from '@vvpost/core'
import { startRealtimeServer } from './helpers/realtime-server.mjs'

describe('parser de SSE', () => {
  const parse = (...chunks: string[]) => {
    const out: SseEvent[] = []
    const p = createSseParser((e) => out.push(e))
    for (const c of chunks) p.feed(c)
    p.end()
    return out
  }

  it('junta data: repetido, lê event:, id: e retry:, ignora comentários', () => {
    expect(parse(': oi\n\nevent: tick\ndata: 1\n\ndata: a\ndata: b\nid: 7\nretry: 3000\n\n')).toEqual([
      { event: 'tick', data: '1' },
      { event: 'message', data: 'a\nb', id: '7', retry: 3000 }
    ])
  })

  it('aceita CRLF, CR e pedaços que cortam uma linha (e um \\r\\n) no meio', () => {
    expect(parse('da', 'ta: x\r', '\n\r\ndata:y\r\r\n')).toEqual([
      { event: 'message', data: 'x' },
      { event: 'message', data: 'y' }
    ])
  })

  it('descarta o evento sem a linha em branco final e o que não tem data', () => {
    expect(parse('event: vazio\n\ndata: pela metade')).toEqual([])
  })
})

describe('Socket.IO', () => {
  it('monta a URL do transporte e o namespace como o cliente oficial', () => {
    expect(socketIoTarget('https://api.exemplo.com/admin?token=1')).toEqual({
      url: 'wss://api.exemplo.com/socket.io/?token=1&EIO=4&transport=websocket',
      namespace: '/admin'
    })
    expect(socketIoTarget('http://localhost:3000')).toEqual({ url: 'ws://localhost:3000/socket.io/?EIO=4&transport=websocket', namespace: '/' })
    expect(socketIoTarget('http://localhost:3000/ws/socket.io').url).toBe('ws://localhost:3000/ws/socket.io/?EIO=4&transport=websocket')
  })

  it('lê os pacotes do Engine.IO e do Socket.IO', () => {
    expect(decodeFrame('0{"sid":"a","pingInterval":25000}')).toEqual({ kind: 'open', sid: 'a', pingInterval: 25000 })
    expect(decodeFrame('2')).toEqual({ kind: 'ping' })
    expect(decodeFrame('40{"sid":"x"}')).toEqual({ kind: 'connect', namespace: '/', sid: 'x' })
    expect(decodeFrame('42/admin,13["pedido",{"id":1},2]')).toEqual({ kind: 'event', namespace: '/admin', event: 'pedido', args: [{ id: 1 }, 2], ackId: 13 })
    expect(decodeFrame('43/admin,13["ok"]')).toEqual({ kind: 'ack', namespace: '/admin', args: ['ok'], ackId: 13 })
    expect(decodeFrame('44{"message":"não"}')).toEqual({ kind: 'connect_error', namespace: '/', message: 'não' })
    expect(decodeFrame('451-["bin",{"_placeholder":true,"num":0}]').kind).toBe('unsupported')
  })

  it('o texto digitado é um argumento: JSON quando dá, string quando não', () => {
    expect(eventArgs('')).toEqual([])
    expect(eventArgs('{"a":1}')).toEqual([{ a: 1 }])
    expect(eventArgs('[1,2]')).toEqual([[1, 2]])
    expect(eventArgs('olá')).toEqual(['olá'])
  })
})

describe('conexões realtime', () => {
  let server: Awaited<ReturnType<typeof startRealtimeServer>>
  let ws: LoadedWorkspace
  let dir: string
  const http = createHttpDispatcher()
  const TOKEN = 'tok-realtime-9f3c2a7b'

  beforeAll(async () => {
    server = await startRealtimeServer()
    dir = mkdtempSync(join(tmpdir(), 'vvpost-realtime-'))
    const put = (path: string, data: unknown) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), JSON.stringify(data))
    }
    put('connectors/live.connector.vvpost.json', {
      id: 'live',
      name: 'Live',
      version: '1.0.0',
      config: { baseUrl: '{{BASE_URL}}', basePath: '/api', headers: { 'X-App': 'vvpost' }, auth: { type: 'bearer', token: '{{TOKEN}}' } },
      endpoints: []
    })
    put('connectors/io.connector.vvpost.json', {
      id: 'io',
      name: 'IO',
      version: '1.0.0',
      config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{TOKEN}}' } },
      endpoints: []
    })
    put('environments/dev.env.json', {
      id: 'dev',
      name: 'Dev',
      variables: { BASE_URL: { type: 'string', value: server.url }, TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }, NOME: { type: 'string', value: 'Ana' } }
    })
    put('.vvpost/secrets.local.json', { dev: { TOKEN } })
    ws = await loadWorkspace(dir)
    expect(ws.issues).toEqual([])
  })
  afterAll(async () => {
    await server.close()
    await http.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Abre, roda `script` a cada evento e devolve todos quando a conexão termina. */
  async function run(input: Omit<RealtimeOpenInput, 'id' | 'headers'> & { headers?: RealtimeOpenInput['headers'] }, script: (e: RealtimeEvent, conn: ReturnType<typeof openRealtime>) => void = () => {}, workspace = ws) {
    const events: RealtimeEvent[] = []
    const sanitizer = createSecretSanitizer()
    sanitizer.addWorkspace(workspace)
    const conn: ReturnType<typeof openRealtime> = openRealtime(
      { id: 'c1', headers: [], ...input },
      { workspace, auth: createAuthEngine(), http, sanitizer },
      (e) => {
        events.push(e)
        queueMicrotask(() => script(e, conn))
      }
    )
    const timer = setTimeout(() => conn.close(), 3000)
    await conn.done
    clearTimeout(timer)
    return events
  }
  const statuses = (events: RealtimeEvent[]) => events.flatMap((e) => (e.type === 'status' ? [e.status] : []))
  const messages = (events: RealtimeEvent[]) => events.flatMap((e) => (e.type === 'message' ? [e.message] : []))

  it('WebSocket: abre, troca mensagens com {{VAR}} resolvida e fecha', async () => {
    const events = await run({ protocol: 'websocket', url: `ws://127.0.0.1:${server.port}/ws`, environmentId: 'dev', subprotocols: ['chat'] }, (e, conn) => {
      if (e.type === 'message' && e.message.data.startsWith('{"hello"')) conn.send({ data: 'oi {{NOME}}' })
      if (e.type === 'message' && e.message.data.startsWith('echo:')) conn.close()
    })
    expect(statuses(events)).toEqual(['connecting', 'open', 'closed'])
    const open = events.find((e) => e.type === 'status' && e.status === 'open')
    expect(open).toMatchObject({ detail: 'subprotocolo chat', url: `ws://127.0.0.1:${server.port}/ws` })
    expect(messages(events).map((m) => [m.direction, m.data])).toEqual([
      ['in', JSON.stringify({ hello: true, authorization: null, protocol: 'chat' })],
      ['out', 'oi Ana'],
      ['in', 'echo:oi Ana']
    ])
    expect(messages(events).map((m) => m.seq)).toEqual([1, 2, 3])
  })

  it('WebSocket pelo conector: caminho relativo à baseUrl, headers e auth herdados, token mascarado na tela', async () => {
    const events = await run({ protocol: 'websocket', url: '/ws', connectorId: 'io', environmentId: 'dev' }, (e, conn) => {
      if (e.type === 'message') conn.close()
    })
    const first = messages(events)[0]!
    expect(JSON.parse(first.data)).toEqual({ hello: true, authorization: '[REDACTED_SECRET]', protocol: null })
    expect(JSON.stringify(events)).not.toContain(TOKEN)
    expect(server.state.headers.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('WebSocket: uma URL absoluta de outra origem não leva a credencial do conector', async () => {
    const events = await run({ protocol: 'websocket', url: 'wss://outro.exemplo.com/ws', connectorId: 'io', environmentId: 'dev' })
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'error', code: 'CONFIG_ERROR' })
  })

  it('WebSocket recusado no upgrade vira erro, não fechamento', async () => {
    const events = await run({ protocol: 'websocket', url: `${server.url}/ws-401` }, () => {}, emptyWorkspace())
    expect(statuses(events)).toEqual(['connecting', 'error'])
  })

  it('Socket.IO: conecta no namespace, responde ao ping e troca eventos', async () => {
    const events = await run({ protocol: 'socketio', url: `${server.url}/admin`, connectorId: 'io', environmentId: 'dev' }, (e, conn) => {
      if (e.type === 'message' && e.message.event === 'welcome') conn.send({ event: 'pedido', data: '{"id": "{{NOME}}"}' })
      if (e.type === 'message' && e.message.event === 'echo') conn.send({ event: 'tchau', data: '' })
    })
    expect(statuses(events)).toEqual(['connecting', 'open', 'closed'])
    expect(events.find((e) => e.type === 'status' && e.status === 'open')).toMatchObject({ detail: 'namespace /admin · sid s-/admin' })
    expect(messages(events).map((m) => [m.direction, m.event, m.data])).toEqual([
      ['in', 'welcome', '{"authorization":"[REDACTED_SECRET]"}'],
      ['out', 'pedido', '{"id":"Ana"}'],
      ['in', 'echo', '{"name":"pedido","args":[{"id":"Ana"}]}'],
      ['out', 'tchau', ''],
      ['info', undefined, 'o servidor desconectou o namespace /admin']
    ])
    expect(server.state.pongs).toBeGreaterThan(0)
    expect(server.state.received).toContain('40/admin,')
  })

  it('Socket.IO: o namespace que recusa a conexão vira erro com a mensagem do servidor', async () => {
    const events = await run({ protocol: 'socketio', url: `${server.url}/proibido` }, () => {}, emptyWorkspace())
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'error', detail: 'o namespace /proibido recusou a conexão: sem permissão' })
  })

  it('SSE: recebe os eventos com nome e o fim do stream fecha a conexão', async () => {
    const events = await run({ protocol: 'sse', url: '/sse', connectorId: 'live', environmentId: 'dev' })
    expect(statuses(events)).toEqual(['connecting', 'open', 'closed'])
    expect(messages(events).map((m) => [m.event, m.data])).toEqual([
      ['tick', '1'],
      ['message', 'linha1\nlinha2'],
      ['message', '{"authorization":"[REDACTED_SECRET]"}']
    ])
    const sent = server.state.headers.at(-1)!
    expect(sent.accept).toBe('text/event-stream')
    expect(sent['x-app']).toBe('vvpost')
  })

  it('SSE por POST manda o corpo com {{VAR}}; enviar mensagem numa conexão SSE é recusado', async () => {
    const events = await run({ protocol: 'sse', url: `${server.url}/sse-post`, method: 'POST', body: '{"q":"{{NOME}}"}', environmentId: 'dev' }, (e, conn) => {
      if (e.type === 'status' && e.status === 'open') expect(() => conn.send({ data: 'x' })).toThrow('SSE só recebe')
    })
    expect(messages(events).map((m) => [m.event, m.data])).toEqual([['eco', 'POST {"q":"Ana"}']])
    expect(server.state.headers.at(-1)?.['content-type']).toBe('application/json')
  })

  it('SSE: resposta que não é event stream vira erro com o Content-Type', async () => {
    const events = await run({ protocol: 'sse', url: `${server.url}/sse-json` }, () => {}, emptyWorkspace())
    expect(events.at(-1)).toMatchObject({ status: 'error', code: 'NOT_EVENT_STREAM', detail: 'a resposta é application/json, não text/event-stream' })
  })

  it('fechar enquanto conecta termina a conexão sem abrir', async () => {
    const events = await run({ protocol: 'sse', url: `${server.url}/sse` }, (e, conn) => {
      if (e.type === 'status' && e.status === 'connecting') conn.close()
    }, emptyWorkspace())
    expect(statuses(events)).toEqual(['connecting', 'closed'])
  })
})
