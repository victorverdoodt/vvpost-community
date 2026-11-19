import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HttpRequestInput } from '@shared/ipc'
import { createHttpDispatcher, isBinaryBody } from '@vvpost/core/http/dispatcher'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff])

let server: Server
let base: string
let connections = 0

async function readAll(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const chunk of req) data += chunk
  return data
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  switch (url.pathname) {
    case '/echo':
      void readAll(req).then((body) => {
        res.setHeader('content-type', 'application/json')
        res.setHeader('set-cookie', ['a=1', 'b=2'])
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body }))
      })
      return
    case '/png':
      res.setHeader('content-type', 'image/png')
      res.end(PNG)
      return
    case '/sem-tipo':
      res.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]))
      return
    case '/gzip':
      res.setHeader('content-encoding', 'gzip')
      res.end(gzipSync('olá comprimido'))
      return
    case '/redirect':
      res.statusCode = 302
      res.setHeader('location', '/echo')
      res.end()
      return
    case '/slow':
      setTimeout(() => res.end('tarde'), 2000)
      return
    case '/status':
      res.statusCode = Number(url.searchParams.get('code'))
      res.end()
      return
    default:
      res.statusCode = 404
      res.end()
  }
}

beforeAll(async () => {
  server = createServer(handler)
  server.on('connection', () => connections++)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})

let seq = 0
const req = (over: Partial<HttpRequestInput>): HttpRequestInput => ({
  id: `r${++seq}`,
  method: 'GET',
  url: `${base}/echo`,
  headers: [],
  ...over
})

describe('dispatcher HTTP', () => {
  it('envia GET e devolve status, cabeçalhos, corpo e tempos', async () => {
    const http = createHttpDispatcher()
    const result = await http.send(req({ headers: [{ name: 'X-Teste', value: '1' }] }))
    await http.close()

    if (!result.ok) throw new Error(result.error.message)
    const { response } = result
    expect(response.status).toBe(200)
    expect(response.statusText).toBe('OK')
    expect(response.headers.filter((h) => h.name === 'set-cookie').map((h) => h.value)).toEqual([
      'a=1',
      'b=2'
    ])
    const echoed = JSON.parse(response.body)
    expect(echoed.headers['x-teste']).toBe('1')
    expect(echoed.headers['user-agent']).toMatch(/^VVPost\//)
    expect(response.sizeBytes).toBe(Buffer.byteLength(response.body))
    expect(response.timings.totalMs).toBeGreaterThanOrEqual(response.timings.ttfbMs)
  })

  it('envia corpo JSON com content-type detectado', async () => {
    const http = createHttpDispatcher()
    const result = await http.send(req({ method: 'POST', body: '{"a":1}' }))
    await http.close()

    if (!result.ok) throw new Error(result.error.message)
    const echoed = JSON.parse(result.response.body)
    expect(echoed.method).toBe('POST')
    expect(echoed.body).toBe('{"a":1}')
    expect(echoed.headers['content-type']).toBe('application/json')
  })

  it('reaproveita o mesmo socket TCP entre requisições para a mesma origem', async () => {
    const http = createHttpDispatcher()
    const before = connections
    for (let i = 0; i < 5; i++) {
      const r = await http.send(req({}))
      // O undici devolve o socket ao pool num tick seguinte; disparos de usuário nunca
      // chegam colados assim, mas sem isso o pool abriria uma segunda conexão.
      await new Promise((r) => setImmediate(r))
      expect(r.ok).toBe(true)
    }
    await http.close()
    expect(connections - before).toBe(1)
  })

  it('mantém o overhead por disparo abaixo de 5 ms (mediana, socket reaproveitado)', async () => {
    const http = createHttpDispatcher()
    await http.send(req({ url: `${base}/status?code=204` }))
    const samples: number[] = []
    for (let i = 0; i < 50; i++) {
      const r = await http.send(req({ url: `${base}/status?code=204` }))
      if (r.ok) samples.push(r.response.timings.totalMs)
    }
    await http.close()
    samples.sort((a, b) => a - b)
    // Ida e volta inteira contra um servidor local: o overhead do dispatcher é uma parte disso.
    expect(samples[25]).toBeLessThan(5)
  })

  it('descomprime respostas gzip', async () => {
    const http = createHttpDispatcher()
    const result = await http.send(req({ url: `${base}/gzip` }))
    await http.close()
    expect(result.ok && result.response.body).toBe('olá comprimido')
  })

  it('guarda os bytes de corpos binários em base64 (e só deles)', async () => {
    const http = createHttpDispatcher()
    const png = await http.send(req({ url: `${base}/png` }))
    const sniffed = await http.send(req({ url: `${base}/sem-tipo` }))
    const text = await http.send(req({ url: `${base}/gzip` }))
    await http.close()
    expect(png.ok && Buffer.from(png.response.bodyBase64!, 'base64')).toEqual(PNG)
    expect(sniffed.ok && sniffed.response.bodyBase64).toBe(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]).toString('base64'))
    expect(text.ok && 'bodyBase64' in text.response).toBe(false)
  })

  it('classifica binário pelo content-type e, sem ele, pelos bytes', () => {
    const utf8 = new TextEncoder().encode('olá')
    expect(isBinaryBody('application/json', PNG)).toBe(false)
    expect(isBinaryBody('image/svg+xml', utf8)).toBe(false)
    expect(isBinaryBody('application/vnd.api+json', utf8)).toBe(false)
    expect(isBinaryBody('application/pdf', utf8)).toBe(true)
    expect(isBinaryBody('application/vnd.openxmlformats-officedocument.wordprocessingml.document', utf8)).toBe(true)
    expect(isBinaryBody(undefined, utf8)).toBe(false)
    expect(isBinaryBody(undefined, PNG)).toBe(true)
    expect(isBinaryBody('application/x-desconhecido', new Uint8Array([0xc3, 0x28]))).toBe(true)
    // Um caractere multibyte cortado no fim da amostra de 64 KB não torna o corpo binário.
    const long = new TextEncoder().encode('a'.repeat(64 * 1024 - 1) + 'ç' + 'b'.repeat(10))
    expect(isBinaryBody(undefined, long)).toBe(false)
    expect(isBinaryBody(undefined, new Uint8Array())).toBe(false)
  })

  it('segue redirecionamentos por padrão e pode desligar isso', async () => {
    const http = createHttpDispatcher()
    const followed = await http.send(req({ url: `${base}/redirect` }))
    const raw = await http.send(req({ url: `${base}/redirect`, followRedirects: false }))
    await http.close()
    expect(followed.ok && followed.response.status).toBe(200)
    expect(raw.ok && raw.response.status).toBe(302)
  })

  it('devolve erros de rede como valor', async () => {
    const http = createHttpDispatcher()
    const invalid = await http.send(req({ url: 'ftp://x' }))
    const refused = await http.send(req({ url: 'http://127.0.0.1:1/' }))
    const timeout = await http.send(req({ url: `${base}/slow`, timeoutMs: 100 }))
    await http.close()
    expect(!invalid.ok && invalid.error.code).toBe('INVALID_URL')
    expect(!refused.ok && refused.error.code).toBe('CONNECTION_REFUSED')
    expect(!timeout.ok && timeout.error.code).toBe('TIMEOUT')
  })

  it('cancela uma requisição em andamento', async () => {
    const http = createHttpDispatcher()
    const pending = http.send(req({ id: 'cancelar', url: `${base}/slow` }))
    setTimeout(() => http.cancel('cancelar'), 50)
    const result = await pending
    await http.close()
    expect(!result.ok && result.error.code).toBe('ABORTED')
  })
})
