import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { summarizeWorkspace } from '@vvpost/core/connectors/summary'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { runAdapterRequest } from '@vvpost/core/flows/adapter-request'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { PluginManager } from '@vvpost/core/plugins/manager'
import { runScenarioBatch } from '@vvpost/core/run'
import { startFakeKafka, type FakeKafka } from './helpers/fake-kafka'

/** Protocolos de plugin fora do Flow Studio: o Quick Request (runAdapterRequest) e os cenários. */

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')
const http = createHttpDispatcher()
let kafka: FakeKafka
let ws: string
let userData: string
let manager: PluginManager

beforeEach(async () => {
  kafka = await startFakeKafka()
  ws = mkdtempSync(join(tmpdir(), 'vvpost-protocols-ws-'))
  userData = mkdtempSync(join(tmpdir(), 'vvpost-protocols-ud-'))
  manager = new PluginManager({ officialDir: OFFICIAL, userDir: join(userData, 'plugins'), stateFile: join(userData, 'plugins.json') })
  write('environments/dev.env.json', { id: 'env.dev', name: 'Dev', variables: { KAFKA_URL: { type: 'string', value: `kafka://127.0.0.1:${kafka.port}` } } })
})
afterEach(async () => {
  await manager.shutdown()
  await kafka.close()
  rmSync(ws, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(ws, path)), { recursive: true })
  writeFileSync(join(ws, path), JSON.stringify(data, null, 2))
}

function connector(endpoints: unknown[]): void {
  write('connectors/events.connector.vvpost.json', {
    id: 'events.kafka',
    name: 'Eventos',
    version: '1.0.0',
    config: { baseUrl: '{{KAFKA_URL}}' },
    endpoints
  })
}

const context = async (plugins = true) => ({
  workspace: await loadWorkspace(ws),
  auth: createAuthEngine(),
  http,
  ...(plugins && { plugins: await manager.runner() })
})

describe('protocolo de plugin no Quick Request', () => {
  it('chama o adapter com o conector e o ambiente e devolve a saída como resposta JSON', async () => {
    connector([])
    const result = await runAdapterRequest(
      {
        id: 'q1',
        adapter: 'kafka',
        config: { operation: 'produce', topic: 'pedidos', key: 'pedido-42', value: { id: 42 } },
        connectorId: 'events.kafka',
        environmentId: 'env.dev'
      },
      await context()
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugin).toMatchObject({ adapter: 'kafka' })
    expect(result.response.status).toBe(200)
    expect(result.response.statusText).toBe('OK')
    expect(result.response.headers).toContainEqual({ name: 'content-type', value: 'application/json' })
    expect(JSON.parse(result.response.body)).toMatchObject({ topic: 'pedidos', partition: 0, offset: '0' })
    expect(result.response.sizeBytes).toBe(Buffer.byteLength(result.response.body))
  })

  it('protocolo ausente, campo obrigatório vazio e falha do plugin voltam como erro da requisição', async () => {
    connector([])
    const ctx = await context()
    const missing = await runAdapterRequest({ id: 'q2', adapter: 'mqtt', config: {} }, ctx)
    expect(missing).toMatchObject({ ok: false, error: { code: 'PLUGIN_UNAVAILABLE' }, plugin: { adapter: 'mqtt' } })

    const required = await runAdapterRequest({ id: 'q3', adapter: 'kafka', config: { operation: '' }, connectorId: 'events.kafka', environmentId: 'env.dev' }, ctx)
    expect(required).toMatchObject({ ok: false, error: { code: 'CONFIG_ERROR' } })
    if (!required.ok) expect(required.error.message).toMatch(/obrigatório/)

    // Sem conector o adapter não sabe a que broker conectar: erro do plugin, não exceção.
    const noBroker = await runAdapterRequest({ id: 'q4', adapter: 'kafka', config: { operation: 'topics' } }, ctx)
    expect(noBroker.ok).toBe(false)

    const noPlugins = await runAdapterRequest({ id: 'q5', adapter: 'kafka', config: { operation: 'topics' } }, await context(false))
    expect(noPlugins).toMatchObject({ ok: false, error: { code: 'PLUGIN_UNAVAILABLE' } })
  })

  it('o catálogo do Quick Request leva o plugin do endpoint', async () => {
    connector([{ id: 'publish', name: 'Publicar', method: 'POST', path: '/pedidos', plugin: { adapter: 'kafka', config: { operation: 'produce', topic: 'pedidos' } } }])
    const loaded = await loadWorkspace(ws)
    expect(loaded.issues).toEqual([])
    const endpoint = summarizeWorkspace(loaded).connectors[0]!.endpoints[0]!
    expect(endpoint.plugin).toEqual({ adapter: 'kafka', config: { operation: 'produce', topic: 'pedidos' } })
  })
})

describe('cenários de endpoint com plugin', () => {
  it('overrides.config por cima da config, capture para o próximo cenário e asserções sobre data', async () => {
    connector([
      {
        id: 'publish',
        name: 'Publicar',
        method: 'POST',
        path: '/pedidos',
        plugin: { adapter: 'kafka', config: { operation: 'produce', topic: 'pedidos', key: 'pedido-1', value: { id: 1 } } },
        scenarios: [
          {
            id: 'ok',
            name: 'Publica',
            overrides: { config: { value: { id: 2, total: 9.9 } } },
            capture: { topico: 'body.topic' },
            assertions: [
              { target: 'status', operator: 'equals', expected: 200 },
              { target: 'body.topic', operator: 'equals', expected: 'pedidos' },
              { target: 'headers.content-type', operator: 'equals', expected: 'application/json' }
            ]
          },
          {
            id: 'sem-topico',
            name: 'Sem tópico',
            overrides: { config: { topic: null } },
            assertions: [{ target: 'status', operator: 'equals', expected: 200 }]
          }
        ]
      },
      {
        id: 'read',
        name: 'Ler',
        method: 'GET',
        path: '/pedidos',
        plugin: { adapter: 'kafka', config: { operation: 'consume', topic: '{{$capture.topico}}', from: 'earliest' } },
        scenarios: [
          {
            id: 'lido',
            name: 'Lê o que foi publicado',
            dependsOn: ['publish/ok'],
            assertions: [
              { target: 'body[0].value.total', operator: 'equals', expected: 9.9 },
              { target: 'body[0].key', operator: 'equals', expected: 'pedido-1' }
            ]
          }
        ]
      }
    ])
    const ctx = await context()
    const report = await runScenarioBatch({ runId: 'run1', connectorId: 'events.kafka', environmentIds: ['env.dev'] }, ctx.workspace, {
      auth: ctx.auth,
      http,
      plugins: () => manager.runner()
    })
    expect(report.error).toBeUndefined()
    const by = (id: string) => report.results.find((r) => r.scenarioId === id)!
    expect(by('ok')).toMatchObject({ outcome: 'passed', status: 200, request: { method: 'POST', url: '/pedidos' }, captures: { topico: 'pedidos' } })
    expect(by('lido').outcome).toBe('passed')
    // null tira o campo da config do endpoint: o adapter recusa produzir sem tópico.
    expect(by('sem-topico')).toMatchObject({ outcome: 'error', error: { code: 'PLUGIN_ERROR' } })
    expect(report.totals).toEqual({ passed: 2, failed: 0, error: 1 })
  })

  it('sem plugins carregados (MCP), o cenário de plugin dá PLUGIN_UNAVAILABLE e os de HTTP seguem', async () => {
    connector([
      {
        id: 'publish',
        name: 'Publicar',
        method: 'POST',
        path: '/pedidos',
        plugin: { adapter: 'kafka', config: { operation: 'produce', topic: 'pedidos', value: 'x' } },
        scenarios: [{ id: 'ok', name: 'Publica', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
      }
    ])
    const workspace = await loadWorkspace(ws)
    const report = await runScenarioBatch({ runId: 'run2', connectorId: 'events.kafka', environmentIds: ['env.dev'] }, workspace, { auth: createAuthEngine(), http })
    expect(report.results[0]).toMatchObject({ outcome: 'error', error: { code: 'PLUGIN_UNAVAILABLE' } })
  })
})
