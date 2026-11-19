import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request, Agent } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, type WebContents } from 'electron'
import type { ResourceUsage } from '@shared/ipc'

/**
 * Modo benchmark (VVPOST_BENCH=1): o app mede o próprio boot e encerra.
 * Usado por scripts/bench-startup.mjs para validar as metas de perf-budgets.json
 * (cold start < 800 ms, RAM em repouso < 150 MB).
 */
export const benchEnabled = process.env['VVPOST_BENCH'] === '1'

/** Tempo de espera após o primeiro paint antes de medir a RAM "em repouso". */
const IDLE_SETTLE_MS = Number(process.env['VVPOST_BENCH_IDLE_MS'] ?? 3000)

let finished = false

export function finishBench(sample: () => Promise<ResourceUsage>, renderer: WebContents): void {
  if (finished) return
  finished = true

  // Tempo desde o início do Node no main process até o primeiro paint do renderer.
  const firstPaintMs = Math.round(performance.now())
  // Marcador imediato: o script de benchmark mede o tempo de parede até esta linha.
  process.stdout.write('VVPOST_BENCH_PAINT\n')

  setTimeout(async () => {
    const idle = await sample()
    const secretEngine = await measureSecretEngine(idle, sample).catch((err) => {
      process.stderr.write(`Falha ao medir o Secret Engine: ${(err as Error).stack}\n`)
      return null
    })
    // Depois da RAM: o disparo carrega o undici, o histórico e o motor de conectores.
    const dispatch = await import('./bench-dispatch').then((m) => m.measureDispatchOverhead(renderer)).catch((err) => {
      process.stderr.write(`Falha ao medir o overhead de disparo: ${(err as Error).stack}\n`)
      return null
    })
    const result = {
      firstPaintMs,
      dispatchOverheadMs: dispatch?.overheadMs ?? null,
      dispatch,
      idleMemoryMB: idle.totalMemoryMB,
      secretEngineMB: secretEngine,
      memoryMetric: idle.metric,
      idleByProcessType: idle.byProcessType,
      electron: process.versions.electron,
      platform: `${process.platform}-${process.arch}`
    }
    process.stdout.write(`VVPOST_BENCH ${JSON.stringify(result)}\n`)
    app.exit(0)
  }, IDLE_SETTLE_MS)
}

/**
 * Custo de memória do Secret Engine (meta: < 30 MB): liga o mock num
 * workspace temporário, faz 300 leituras em cada API emulada (Azure, AWS e Vault)
 * e mede quanto o main process cresceu em relação ao repouso.
 */
async function measureSecretEngine(idle: ResourceUsage, sample: () => Promise<ResourceUsage>): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'vvpost-bench-'))
  try {
    await mkdir(join(dir, '.vvpost'))
    await writeFile(join(dir, '.vvpost/secrets.local.json'), JSON.stringify({ 'env.bench': { DATABASE_URL: 'postgres://bench' } }))
    const { startSecretEngine } = await import('./secret-engine/server')
    const engine = await startSecretEngine(dir, { port: 0 })
    const agent = new Agent({ keepAlive: true })
    const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
      new Promise<void>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: engine.port, path, agent, method: init.method ?? 'GET', headers: init.headers }, (res) => {
          res.resume()
          res.on('end', resolve)
        })
        req.on('error', reject)
        req.end(init.body)
      })
    for (let i = 0; i < 300; i++) {
      await call('/secrets/DATABASE-URL?api-version=7.4', { headers: { authorization: 'Bearer bench' } })
      await call('/', {
        method: 'POST',
        headers: { 'x-amz-target': 'secretsmanager.GetSecretValue', 'content-type': 'application/x-amz-json-1.1' },
        body: '{"SecretId":"DATABASE_URL"}'
      })
      await call('/v1/secret/data/DATABASE_URL', { headers: { 'x-vault-token': 'bench' } })
    }
    agent.destroy()
    await new Promise((r) => setTimeout(r, 1000))
    const running = await sample()
    await engine.close()
    const main = (u: ResourceUsage) => u.byProcessType['Browser'] ?? 0
    return Math.round((main(running) - main(idle)) * 10) / 10
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

