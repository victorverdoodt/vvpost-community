import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
const round = (ms: number) => Math.round(ms * 100) / 100

/**
 * Overhead de disparo: quanto o VVPost acrescenta a uma requisição além
 * da rede. Um servidor em loopback responde na hora; a mesma requisição vai (a) direto pelo
 * dispatcher Undici, no main process, e (b) pelo caminho do Quick Request, do renderer: IPC,
 * herança do conector (baseUrl, headers, auth por API key do ambiente), {{VAR}}, gravador,
 * Secret Sanitizer e a gravação no histórico. O overhead é a diferença das medianas.
 */
export async function measureDispatchOverhead(renderer: WebContents): Promise<{ overheadMs: number; rawMs: number; appMs: number; samples: number }> {
  const SAMPLES = 200
  const WARMUP = 30
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const dir = await mkdtemp(join(tmpdir(), 'vvpost-bench-dispatch-'))
  try {
    await mkdir(join(dir, 'connectors'))
    await mkdir(join(dir, 'environments'))
    await mkdir(join(dir, '.vvpost'))
    await writeFile(
      join(dir, 'connectors/bench.connector.vvpost.json'),
      JSON.stringify({
        id: 'connector.bench',
        name: 'Bench',
        version: '1.0.0',
        config: {
          baseUrl: '{{BASE_URL}}',
          basePath: '/v1',
          headers: { 'X-Client': 'VVPost', 'X-Tenant': '{{TENANT}}' },
          auth: { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: '{{API_KEY}}' }
        }
      })
    )
    await writeFile(
      join(dir, 'environments/bench.env.json'),
      JSON.stringify({
        id: 'env.bench',
        name: 'Bench',
        variables: {
          BASE_URL: { type: 'string', value: origin },
          TENANT: { type: 'string', value: 'acme' },
          API_KEY: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
        }
      })
    )
    await writeFile(join(dir, '.vvpost/secrets.local.json'), JSON.stringify({ 'env.bench': { API_KEY: 'bench-key-0123456789' } }))
    const services = await import('./services')
    await services.useWorkspaceForBench(dir)

    const { createHttpDispatcher } = await import('@vvpost/core/http/dispatcher')
    const raw = createHttpDispatcher()
    const rawTimes: number[] = []
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      const start = performance.now()
      const r = await raw.send({ id: `raw-${i}`, method: 'POST', url: `${origin}/v1/orders`, headers: [{ name: 'content-type', value: 'application/json' }], body: '{"amount":1}' })
      if (!r.ok) throw new Error(`requisição direta falhou: ${r.error.message}`)
      if (i >= WARMUP) rawTimes.push(performance.now() - start)
    }
    await raw.close()

    // Do renderer, como o botão Enviar: window.vvpost.sendRequest até o resultado voltar.
    const appTimes = (await renderer.executeJavaScript(`(async () => {
      const times = []
      for (let i = 0; i < ${WARMUP + SAMPLES}; i++) {
        const start = performance.now()
        const r = await window.vvpost.sendRequest({
          id: 'bench-' + i, method: 'POST', url: '/orders',
          headers: [{ name: 'content-type', value: 'application/json' }], body: '{"amount":1}',
          connectorId: 'connector.bench', environmentId: 'env.bench'
        })
        if (!r.ok) throw new Error('requisição do app falhou: ' + r.error.message)
        if (i >= ${WARMUP}) times.push(performance.now() - start)
      }
      return times
    })()`)) as number[]
    const rawMs = median(rawTimes)
    const appMs = median(appTimes)
    return { overheadMs: round(Math.max(0, appMs - rawMs)), rawMs: round(rawMs), appMs: round(appMs), samples: SAMPLES }
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
}
