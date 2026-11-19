import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createExchangeRecorder } from '@vvpost/core/recorder'
import type { SendOptions } from '@vvpost/core/http/dispatcher'
import { createSecretSanitizer } from '@vvpost/core/sanitizer'
import type { HttpRequestInput, HttpResult, ScenarioRunReport } from '@shared/ipc'
import {
  DEFAULT_HISTORY_SETTINGS,
  SECRET_PLACEHOLDER,
  normalizeSettings,
  openHistoryStore,
  type NewHistoryExchange,
  type NewHistoryRun
} from '../src/main/history/store'
import { remoteRun, requestRun, scenarioRun } from '../src/main/history/record'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-history-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// Gerados a cada execução: nenhum valor com cara de credencial fica commitado.
const VAULT = `vault-${randomBytes(8).toString('hex')}`
const RESOLVED = `tok-${randomBytes(8).toString('hex')}`
const FRESH = `new-${randomBytes(8).toString('hex')}`

const timings = { ttfbMs: 5, downloadMs: 1, totalMs: 6 }

const exchange = (over: Partial<NewHistoryExchange> = {}): NewHistoryExchange => ({
  createdAt: Date.now(),
  method: 'POST',
  url: 'https://api.exemplo.com/recurso',
  status: 201,
  errorCode: null,
  durationMs: 12.5,
  sizeBytes: 42,
  connectorId: null,
  environmentId: null,
  template: { headers: [{ name: 'Accept', value: 'application/json' }], body: '{"a":1}' },
  sent: { url: 'https://api.exemplo.com/recurso', headers: [{ name: 'Accept', value: 'application/json' }], body: '{"a":1}' },
  response: { status: 201, statusText: 'Created', headers: [{ name: 'content-type', value: 'application/json' }], body: '{"id":7}', truncated: false, sizeBytes: 8, timings },
  ...over
})

const run = (over: Partial<NewHistoryRun> = {}): NewHistoryRun => ({
  createdAt: Date.now(),
  source: 'request',
  title: 'POST https://api.exemplo.com/recurso',
  outcome: 'passed',
  status: 201,
  durationMs: 12.5,
  exchanges: [exchange()],
  ...over
})

describe('histórico em SQLite', () => {
  it('abre em modo WAL e persiste execução e requisições entre aberturas', async () => {
    const path = join(dir, 'h.db')
    const store = await openHistoryStore(path)
    expect(await store.journalMode()).toBe('wal')
    const id = await store.addRun(run())
    await store.close()

    const reopened = await openHistoryStore(path)
    const [summary] = await reopened.list()
    const detail = await reopened.get(id!)
    await reopened.close()
    expect(summary).toMatchObject({ id, source: 'request', level: 'full', method: 'POST', status: 201, exchangeCount: 1 })
    expect(detail!.exchanges[0]).toMatchObject({
      template: { body: '{"a":1}' },
      sent: { url: 'https://api.exemplo.com/recurso', body: '{"a":1}' },
      response: { status: 201, body: '{"id":7}' },
      timings,
      replayable: true
    })
  })

  it('o nível decide o que vai para o disco', async () => {
    const store = await openHistoryStore(join(dir, 'h.db'))
    const meta = await store.addRun(run(), { level: 'metadata' })
    const headers = await store.addRun(run(), { level: 'headers' })
    const full = await store.addRun(run(), { level: 'full' })
    expect(await store.addRun(run(), { level: 'off' })).toBeNull()

    const [m, h, f] = await Promise.all([store.get(meta!), store.get(headers!), store.get(full!)])
    await store.close()
    const mx = m!.exchanges[0]!
    expect(mx.template).toEqual({})
    expect(mx.sent).toBeUndefined()
    expect(mx.response).toBeUndefined()
    expect(mx).toMatchObject({ url: 'https://api.exemplo.com/recurso', status: 201, timings, replayable: false })

    const hx = h!.exchanges[0]!
    expect(hx.template).toEqual({ headers: [{ name: 'Accept', value: 'application/json' }] })
    expect(hx.sent!.body).toBeUndefined()
    expect(hx.response).toMatchObject({ status: 201, headers: [{ name: 'content-type', value: 'application/json' }] })
    expect(hx.response!.body).toBeUndefined()
    // Com corpo, o nível headers não basta para refazer a requisição.
    expect(hx.replayable).toBe(false)
    expect(hx.replayBlocked).toMatch(/corpo/)

    expect(f!.exchanges[0]!.response!.body).toBe('{"id":7}')
  })

  it('usa o nível configurado para cada origem', async () => {
    const store = await openHistoryStore(join(dir, 'h.db'))
    await store.setSettings({ ...DEFAULT_HISTORY_SETTINGS, levels: { request: 'off', scenarios: 'metadata', flow: 'full' } })
    expect(await store.addRun(run())).toBeNull()
    const id = await store.addRun(run({ source: 'scenarios', title: 'Cenários' }))
    expect((await store.get(id!))!.level).toBe('metadata')
    await store.close()
    // A configuração fica no banco.
    const reopened = await openHistoryStore(join(dir, 'h.db'))
    expect(reopened.settings().levels.request).toBe('off')
    await reopened.close()
  })

  it('mascara credenciais no modelo, no que foi enviado e na resposta', async () => {
    const store = await openHistoryStore(join(dir, 'h.db'))
    const sanitizer = createSecretSanitizer()
    sanitizer.add(VAULT)
    const id = await store.addRun(
      run({
        exchanges: [
          exchange({
            url: 'https://api.exemplo.com/x?api_key=abc123&token={{TOKEN}}',
            template: {
              headers: [
                { name: 'Authorization', value: 'Bearer {{TOKEN}}' },
                { name: 'x-api-key', value: 'abc' },
                { name: 'X-Trace', value: VAULT }
              ],
              body: '{"user":"ana","password":"segredo"}'
            },
            sent: {
              url: `https://api.exemplo.com/x?api_key=abc123&token=${RESOLVED}`,
              headers: [{ name: 'Authorization', value: `Bearer ${RESOLVED}` }],
              body: '{"user":"ana","password":"segredo"}'
            },
            response: {
              status: 200,
              statusText: 'OK',
              headers: [{ name: 'set-cookie', value: 'sid=xyz123; Path=/' }],
              body: `{"access_token":"${FRESH}","ok":true}`,
              truncated: false,
              sizeBytes: 40,
              timings
            }
          })
        ]
      }),
      { sanitizer }
    )
    const x = (await store.get(id!))!.exchanges[0]!
    await store.close()
    expect(x.url).toBe(`https://api.exemplo.com/x?api_key=${SECRET_PLACEHOLDER}&token={{TOKEN}}`)
    expect(x.template!.headers).toEqual([
      { name: 'Authorization', value: 'Bearer {{TOKEN}}' },
      { name: 'x-api-key', value: SECRET_PLACEHOLDER },
      { name: 'X-Trace', value: '[REDACTED_SECRET]' }
    ])
    expect(x.template!.body).toBe(`{"user":"ana","password":"${SECRET_PLACEHOLDER}"}`)
    // Valor mascarado no modelo: reabrir dá, reproduzir não.
    expect(x.replayable).toBe(false)
    const text = JSON.stringify(x)
    for (const secret of ['abc123', RESOLVED, 'segredo', 'xyz123', FRESH, VAULT]) {
      expect(text.includes(secret), secret).toBe(false)
    }
  })

  it('guarda os scripts da requisição só no nível completo, com os valores do vault mascarados', async () => {
    const store = await openHistoryStore(join(dir, 'h.db'))
    const sanitizer = createSecretSanitizer()
    sanitizer.add(VAULT)
    const scripts = { pre: `vv.request.headers.A = '${VAULT}'`, post: "vv.test('ok', () => {})" }
    const tpl = { headers: [], endpointId: 'perfil', scripts }
    const full = await store.addRun(run({ exchanges: [exchange({ template: tpl })] }), { level: 'full', sanitizer })
    const headers = await store.addRun(run({ exchanges: [exchange({ template: tpl })] }), { level: 'headers', sanitizer })
    const f = (await store.get(full!))!.exchanges[0]!
    const h = (await store.get(headers!))!.exchanges[0]!
    await store.close()
    expect(f.template).toMatchObject({ endpointId: 'perfil', scripts: { pre: "vv.request.headers.A = '[REDACTED_SECRET]'", post: scripts.post } })
    expect(JSON.stringify(f).includes(VAULT)).toBe(false)
    expect(h.template!.scripts).toBeUndefined()
    expect(h.replayBlocked).toMatch(/scripts/)
  })

  it('corta corpos acima do limite e marca o corte', async () => {
    const store = await openHistoryStore(join(dir, 'h.db'))
    await store.setSettings({ ...DEFAULT_HISTORY_SETTINGS, maxBodyKB: 1 })
    const big = 'x'.repeat(5000)
    const id = await store.addRun(
      run({ exchanges: [exchange({ response: { status: 200, statusText: 'OK', headers: [], body: big, truncated: false, sizeBytes: 5000, timings } })] })
    )
    const r = (await store.get(id!))!.exchanges[0]!.response!
    await store.close()
    expect(r.body).toHaveLength(1024)
    expect(r.bodyCut).toBe(true)
  })

  it('guarda os bytes de corpos binários que cabem no limite, para a prévia ao reabrir', async () => {
    const store = await openHistoryStore(join(dir, 'h.db'))
    await store.setSettings({ ...DEFAULT_HISTORY_SETTINGS, maxBodyKB: 1 })
    const png = (bodyBase64: string) =>
      exchange({ response: { status: 200, statusText: 'OK', headers: [], body: '\ufffdPNG', bodyBase64, truncated: false, sizeBytes: 4, timings } })
    const small = await store.addRun(run({ exchanges: [png('iVBORw0K')] }))
    const big = await store.addRun(run({ exchanges: [png('A'.repeat(2000))] }))
    const kept = (await store.get(small!))!.exchanges[0]!.response!
    const dropped = (await store.get(big!))!.exchanges[0]!.response!
    await store.close()
    expect(kept.bodyBase64).toBe('iVBORw0K')
    expect(dropped.bodyBase64).toBeUndefined()
  })

  it('retenção por quantidade, idade e tamanho, apagando as requisições junto', async () => {
    const path = join(dir, 'h.db')
    const store = await openHistoryStore(path)
    await store.setSettings({ ...DEFAULT_HISTORY_SETTINGS, maxRuns: 10 })
    for (let i = 0; i < 15; i++) await store.addRun(run({ title: `r${i}` }))
    let rows = await store.list({ limit: 100 })
    expect(rows.map((r) => r.title)).toEqual(Array.from({ length: 10 }, (_, i) => `r${14 - i}`))

    await store.addRun(run({ title: 'velha', createdAt: Date.now() - 40 * 86_400_000 }))
    expect((await store.list({ search: 'velha' })).length).toBe(0)

    await store.setSettings({ ...DEFAULT_HISTORY_SETTINGS, maxSizeMB: 1 })
    const body = 'y'.repeat(200 * 1024)
    for (let i = 0; i < 8; i++) {
      await store.addRun(run({ title: `grande${i}`, exchanges: [exchange({ response: { status: 200, statusText: 'OK', headers: [], body, truncated: false, sizeBytes: body.length, timings } })] }))
    }
    const stats = await store.stats()
    expect(stats.bytes).toBeLessThanOrEqual(1024 * 1024)
    rows = await store.list({ limit: 100 })
    expect(rows[0]!.title).toBe('grande7')
    await store.close()

    const raw = new DatabaseSync(path)
    const orphans = raw.prepare('SELECT count(*) AS n FROM history_exchange WHERE run_id NOT IN (SELECT id FROM history_run)').get() as { n: number }
    raw.close()
    expect(orphans.n).toBe(0)
  })

  it('filtra por origem, resultado e texto, e pagina', async () => {
    const store = await openHistoryStore(join(dir, 'h.db'))
    await store.addRun(run({ title: 'GET /usuarios', exchanges: [exchange({ url: '/usuarios' })] }))
    await store.addRun(run({ source: 'scenarios', title: 'Cenários de Billing', outcome: 'failed', exchanges: [exchange({ url: '/charges', label: 'create/ok' })] }))
    await store.addRun(run({ source: 'flow', title: 'Fluxo Checkout', exchanges: [] }))
    expect((await store.list({ source: 'scenarios' })).map((r) => r.title)).toEqual(['Cenários de Billing'])
    expect((await store.list({ outcome: 'failed' })).length).toBe(1)
    expect((await store.list({ search: 'create/ok' })).map((r) => r.title)).toEqual(['Cenários de Billing'])
    expect((await store.list({ search: '100%' })).length).toBe(0)
    const [newest] = await store.list({ limit: 1 })
    expect((await store.list({ beforeId: newest!.id })).length).toBe(2)
    await store.delete(newest!.id)
    expect((await store.list()).length).toBe(2)
    await store.clear()
    expect(await store.list()).toEqual([])
    await store.close()
  })

  it('configurações fora do limite voltam ao padrão', () => {
    expect(normalizeSettings({ levels: { request: 'tudo', flow: 'metadata' }, maxRuns: -1, maxAgeDays: 0, maxBodyKB: 'x' })).toEqual({
      ...DEFAULT_HISTORY_SETTINGS,
      levels: { ...DEFAULT_HISTORY_SETTINGS.levels, flow: 'metadata' },
      maxAgeDays: 0
    })
  })

  it('migra o banco da versão anterior para execuções', async () => {
    const path = join(dir, 'h.db')
    // Banco como os PRs #3 e #8 deixavam: migrações 0001 e 0002 aplicadas, com entradas.
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE kysely_migration (name varchar(255) NOT NULL PRIMARY KEY, timestamp varchar(255) NOT NULL);
      INSERT INTO kysely_migration VALUES ('0001_request_history', '2026-10-01T00:00:00.000Z');
      INSERT INTO kysely_migration VALUES ('0002_request_connector', '2026-10-02T00:00:00.000Z');
      CREATE TABLE request_history (id integer PRIMARY KEY AUTOINCREMENT, created_at integer NOT NULL,
        method text NOT NULL, url text NOT NULL, request_headers text NOT NULL, request_body text,
        status integer, error_code text, duration_ms real NOT NULL, size_bytes integer, connector_id text, environment_id text);
      INSERT INTO request_history (created_at, method, url, request_headers, request_body, status, duration_ms, connector_id, environment_id)
        VALUES (unixepoch() * 1000, 'POST', '/charges', '[{"name":"Accept","value":"*/*"}]', '{"a":1}', 201, 3, 'billing.v2', 'env.dev');
      INSERT INTO request_history (created_at, method, url, request_headers, error_code, duration_ms)
        VALUES (unixepoch() * 1000, 'GET', 'https://antigo', '[{"name":"Authorization","value":"__REQUIRED_SECRET__"}]', 'TIMEOUT', 3);
    `)
    old.close()

    const store = await openHistoryStore(path)
    const rows = await store.list()
    const first = await store.get(rows[1]!.id)
    await store.addRun(run())
    expect((await store.list()).length).toBe(3)
    await store.close()
    expect(rows.map((r) => [r.url, r.outcome, r.connectorId])).toEqual([
      ['https://antigo', 'error', null],
      ['/charges', 'passed', 'billing.v2']
    ])
    expect(first!.exchanges[0]).toMatchObject({
      method: 'POST',
      environmentId: 'env.dev',
      template: { headers: [{ name: 'Accept', value: '*/*' }], body: '{"a":1}' },
      replayable: true
    })
    const migrated = await openHistoryStore(path)
    const masked = await migrated.get(rows[0]!.id)
    await migrated.close()
    expect(masked!.exchanges[0]!.replayable).toBe(false)
  })
})

describe('gravador do dispatcher', () => {
  const ok = (body = '{"ok":true}'): HttpResult => ({
    ok: true,
    response: { status: 200, statusText: 'OK', headers: [], body, sizeBytes: body.length, truncated: false, timings }
  })

  it('guarda o modelo, o que foi enviado e a resposta, sem o fluxo de auth', async () => {
    const sent: HttpRequestInput[] = []
    const base = { send: async (i: HttpRequestInput, _o?: SendOptions) => (sent.push(i), ok()), cancel: () => {} }
    const recorder = createExchangeRecorder(base, () => ({ enabled: true, maxBody: 4 }))
    const template: HttpRequestInput = { id: 'run:0', method: 'GET', url: '/x?q={{Q}}', headers: [], connectorId: 'c' }
    await recorder.http.send({ id: 'auth:c', method: 'POST', url: 'https://idp/token', headers: [] })
    await recorder.http.send({ ...template, url: 'https://api/x?q=1' }, { trace: { template, dropHeaders: ['X-A'] } })
    await recorder.http.send({ id: 'outra', method: 'GET', url: 'https://a', headers: [] })
    const [x, ...rest] = recorder.take('run')
    expect(rest).toEqual([])
    expect(x!.trace).toEqual({ template, dropHeaders: ['X-A'] })
    expect(x!.sent.url).toBe('https://api/x?q=1')
    // Corpo guardado até o limite mais um caractere; o chamador recebe o corpo inteiro.
    expect((x!.result as Extract<HttpResult, { ok: true }>).response.body).toBe('{"ok"')
    expect(recorder.take('run')).toEqual([])
    expect(recorder.take('outra')).toHaveLength(1)
  })

  it('não guarda nada com o histórico desligado', async () => {
    const recorder = createExchangeRecorder({ send: async (_i: HttpRequestInput) => ok(), cancel: () => {} }, () => ({ enabled: false, maxBody: 10 }))
    await recorder.http.send({ id: 'a', method: 'GET', url: 'https://a', headers: [] })
    expect(recorder.take('a')).toEqual([])
  })

  it('monta a execução do Quick Request e do lote de cenários', async () => {
    const input: HttpRequestInput = { id: 'q1', method: 'GET', url: '/u', headers: [], connectorId: 'api', environmentId: 'dev' }
    const r = requestRun(input, ok(), undefined)
    expect(r).toMatchObject({ source: 'request', title: 'GET /u', outcome: 'passed', connectorId: 'api' })
    expect(r.exchanges[0]!.template).toEqual({ headers: [], body: null })

    const report: ScenarioRunReport = {
      runId: 'run',
      connectorId: 'api',
      startedAt: 1,
      durationMs: 9,
      canceled: false,
      totals: { passed: 1, failed: 0, error: 1 },
      results: [
        { endpointId: 'e', scenarioId: 'ok', environmentId: 'dev', requestId: 'run:0', outcome: 'passed', request: { method: 'GET', url: '/u' }, status: 200, durationMs: 6, assertions: [{ target: 'status', operator: 'equals', expected: 200, passed: true, message: 'ok' }] },
        { endpointId: 'e', scenarioId: 'quebrado', environmentId: 'dev', outcome: 'error', request: { method: 'GET', url: '/u/{id}' }, durationMs: 0, error: { code: 'CONFIG_ERROR', message: 'sem id' }, assertions: [] }
      ]
    }
    const recorded = [{ id: 'run:0', at: 2, trace: { template: { ...input, id: 'run:0' } }, sent: { method: 'GET' as const, url: 'https://api/u', headers: [] }, result: ok() }]
    const s = scenarioRun(report, recorded, 'Cenários de API')
    expect(s).toMatchObject({ source: 'scenarios', outcome: 'error', totals: report.totals, environmentId: 'dev' })
    expect(s.exchanges.map((x) => [x.label, x.outcome, !!x.template, !!x.sent])).toEqual([
      ['e/ok', 'passed', true, true],
      ['e/quebrado', 'error', false, false]
    ])
    expect(s.exchanges[0]!.assertions).toHaveLength(1)
  })

  it('grava a execução remota marcada, sem nada reproduzível, e filtra remotas e locais', async () => {
    const store = await openHistoryStore(join(dir, 'h.db'))
    const report: ScenarioRunReport = {
      runId: 'r',
      connectorId: 'billing',
      startedAt: Date.now() - 500,
      durationMs: 30,
      canceled: false,
      totals: { passed: 1, failed: 1, error: 0 },
      results: [
        { endpointId: 'charge', scenarioId: 'ok', environmentId: 'env.dev', outcome: 'passed', request: { method: 'GET', url: '/charges' }, status: 200, durationMs: 9, assertions: [] },
        { endpointId: 'charge', scenarioId: 'wrong', environmentId: 'env.dev', outcome: 'failed', request: { method: 'GET', url: '/charges' }, status: 200, durationMs: 8, assertions: [] }
      ]
    }
    const runner = { id: 7, project: 'payments', status: 'failed' as const, requestedBy: 'ana', createdAt: '', finishedAt: new Date(report.startedAt + 500).toISOString(), cancelRequested: false, exitCode: 1, error: null }
    const r = remoteRun(runner, 'cp.contoso.com/payments', [report], new Map([['billing', 'Billing']]))
    expect(r).toMatchObject({ source: 'scenarios', title: 'Cenários de Billing no runner #7', outcome: 'failed', durationMs: 500, environmentId: 'env.dev', remote: { runId: 7, source: 'cp.contoso.com/payments' } })
    expect(r.exchanges.every((x) => !x.template && !x.sent)).toBe(true)
    await store.addRun(run())
    const id = await store.addRun(r)
    const [remote] = await store.list({ remote: true })
    expect(remote).toMatchObject({ id, remote: { runId: 7, source: 'cp.contoso.com/payments' }, totals: report.totals })
    expect((await store.list({ remote: false })).map((x) => x.remote)).toEqual([null])
    // Runner que sumiu: erro com código próprio e sem totais.
    expect(remoteRun({ ...runner, status: 'lost' }, 'cp', [], new Map())).toMatchObject({ outcome: 'error', errorCode: 'RUNNER_LOST', totals: null, title: 'Execução remota no runner #7' })
    await store.close()
  })
})
