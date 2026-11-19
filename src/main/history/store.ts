import { statSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Kysely, SqliteDialect, sql, type Generated, type Selectable, type SqliteDatabase } from 'kysely'
import { Migrator, type Migration } from 'kysely/migration'
import {
  HISTORY_LEVELS,
  type AssertionResult,
  type AuthUsage,
  type HistoryExchange,
  type HistoryLevel,
  type HistoryOutcome,
  type HistoryQuery,
  type HistoryRunDetail,
  type HistoryRunSummary,
  type HistorySettings,
  type HistorySource,
  type HistoryStats,
  type HttpHeader,
  type HttpMethod,
  type HttpTimings,
  type RequestPayload,
  type RequestScripts
} from '@shared/ipc'
import { SECRET_PLACEHOLDER, SENSITIVE_HEADERS, isSensitiveName } from '@vvpost/core/secrets'
import { REDACTED, createSecretSanitizer, type SecretSanitizer } from '@vvpost/core/sanitizer'
import type { PiiMasker } from '@vvpost/core/pii'
import { peopleAssertions, peopleHeaders, peopleText } from '@vvpost/core/pii-people'

// O valor de cabeçalhos sensíveis, de parâmetros de query e de campos do corpo com
// nome de credencial nunca vai para o disco: no modelo da requisição vira o mesmo
// marcador que o Git Workspace usa para segredos, e o que foi para a rede
// e a resposta passam pelo Secret Sanitizer (testes em secret-leaks.test.ts).
export { SECRET_PLACEHOLDER } from '@vvpost/core/secrets'

export const DEFAULT_HISTORY_SETTINGS: HistorySettings = {
  levels: { request: 'full', scenarios: 'full', flow: 'full' },
  maxRuns: 1000,
  maxAgeDays: 30,
  maxBodyKB: 256,
  maxSizeMB: 200
}

/** Limites aceitos nas configurações (o que vem do renderer é conferido). */
const LIMITS = {
  maxRuns: [10, 100_000],
  maxAgeDays: [0, 3650],
  maxBodyKB: [1, 10_240],
  maxSizeMB: [1, 10_240]
} as const

interface HistoryRunTable {
  id: Generated<number>
  created_at: number
  source: string
  level: string
  title: string
  outcome: string
  status: number | null
  error_code: string | null
  duration_ms: number
  connector_id: string | null
  environment_id: string | null
  flow_id: string | null
  method: string | null
  url: string | null
  exchange_count: number
  /** JSON de { passed, failed, error }. */
  totals: string | null
  /** JSON do relatório no nível da execução. */
  report: string | null
  replay_of: number | null
  bytes: number
  /** JSON de HistoryRunSummary['remote']: a execução rodou num Execution Runner. */
  remote: string | null
}

interface HistoryExchangeTable {
  id: Generated<number>
  run_id: number
  seq: number
  created_at: number
  label: string | null
  /** JSON de HistoryExchange['ref']. */
  ref: string | null
  method: string
  url: string
  status: number | null
  error_code: string | null
  error_message: string | null
  outcome: string | null
  duration_ms: number
  size_bytes: number | null
  connector_id: string | null
  environment_id: string | null
  replayable: number
  /** JSON com template, sent, response, timings, auth, assertions, logs e replayBlocked. */
  detail: string
}

interface HistorySettingsTable {
  key: string
  value: string
}

interface Schema {
  history_run: HistoryRunTable
  history_exchange: HistoryExchangeTable
  history_settings: HistorySettingsTable
}

const migrations: Record<string, Migration> = {
  '0001_request_history': {
    async up(db) {
      await db.schema
        .createTable('request_history')
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addColumn('method', 'text', (c) => c.notNull())
        .addColumn('url', 'text', (c) => c.notNull())
        .addColumn('request_headers', 'text', (c) => c.notNull())
        .addColumn('request_body', 'text')
        .addColumn('status', 'integer')
        .addColumn('error_code', 'text')
        .addColumn('duration_ms', 'real', (c) => c.notNull())
        .addColumn('size_bytes', 'integer')
        .execute()
    }
  },
  // Requisições com conector guardam a URL como digitada, relativa à baseUrl
  // e com {{VAR}}: sem o conector e o ambiente a entrada não seria repetível.
  '0002_request_connector': {
    async up(db) {
      await db.schema.alterTable('request_history').addColumn('connector_id', 'text').execute()
      await db.schema.alterTable('request_history').addColumn('environment_id', 'text').execute()
    }
  },
  // Histórico rico: execuções de qualquer origem com as requisições delas. As
  // entradas da tabela antiga viram execuções do Quick Request com uma requisição cada.
  '0003_history_runs': {
    async up(db) {
      await db.schema
        .createTable('history_run')
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('level', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('status', 'integer')
        .addColumn('error_code', 'text')
        .addColumn('duration_ms', 'real', (c) => c.notNull())
        .addColumn('connector_id', 'text')
        .addColumn('environment_id', 'text')
        .addColumn('flow_id', 'text')
        .addColumn('method', 'text')
        .addColumn('url', 'text')
        .addColumn('exchange_count', 'integer', (c) => c.notNull())
        .addColumn('totals', 'text')
        .addColumn('report', 'text')
        .addColumn('replay_of', 'integer')
        .addColumn('bytes', 'integer', (c) => c.notNull())
        .execute()
      await db.schema.createIndex('history_run_created').on('history_run').column('created_at').execute()
      await db.schema.createIndex('history_run_source').on('history_run').columns(['source', 'id']).execute()
      await db.schema
        .createTable('history_exchange')
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('run_id', 'integer', (c) => c.notNull().references('history_run.id').onDelete('cascade'))
        .addColumn('seq', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addColumn('label', 'text')
        .addColumn('ref', 'text')
        .addColumn('method', 'text', (c) => c.notNull())
        .addColumn('url', 'text', (c) => c.notNull())
        .addColumn('status', 'integer')
        .addColumn('error_code', 'text')
        .addColumn('error_message', 'text')
        .addColumn('outcome', 'text')
        .addColumn('duration_ms', 'real', (c) => c.notNull())
        .addColumn('size_bytes', 'integer')
        .addColumn('connector_id', 'text')
        .addColumn('environment_id', 'text')
        .addColumn('replayable', 'integer', (c) => c.notNull())
        .addColumn('detail', 'text', (c) => c.notNull())
        .execute()
      await db.schema.createIndex('history_exchange_run').on('history_exchange').columns(['run_id', 'seq']).execute()
      await db.schema
        .createTable('history_settings')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .execute()

      await sql`
        INSERT INTO history_run (id, created_at, source, level, title, outcome, status, error_code, duration_ms,
          connector_id, environment_id, method, url, exchange_count, bytes)
        SELECT id, created_at, 'request', 'full', method || ' ' || url,
          CASE WHEN status IS NULL THEN 'error' WHEN status >= 400 THEN 'failed' ELSE 'passed' END,
          status, error_code, duration_ms, connector_id, environment_id, method, url, 1,
          length(request_headers) + coalesce(length(request_body), 0)
        FROM request_history`.execute(db)
      await sql`
        INSERT INTO history_exchange (run_id, seq, created_at, method, url, status, error_code, outcome, duration_ms,
          size_bytes, connector_id, environment_id, replayable, detail)
        SELECT id, 0, created_at, method, url, status, error_code,
          CASE WHEN status IS NULL THEN 'error' WHEN status >= 400 THEN 'failed' ELSE 'passed' END,
          duration_ms, size_bytes, connector_id, environment_id,
          CASE WHEN instr(request_headers || coalesce(request_body, ''), '${sql.raw(SECRET_PLACEHOLDER)}') > 0 THEN 0 ELSE 1 END,
          json_object('template', json_object('headers', json(request_headers), 'body', request_body))
        FROM request_history`.execute(db)
      await db.schema.dropTable('request_history').execute()
    }
  },
  // Execuções remotas: o relatório do runner entra no histórico marcado como remoto.
  '0004_history_remote': {
    async up(db) {
      await db.schema.alterTable('history_run').addColumn('remote', 'text').execute()
    }
  }
}

/** O que o motor sabe de uma requisição; o nível decide o que disto vai para o disco. */
export interface NewHistoryExchange {
  createdAt: number
  label?: string
  ref?: HistoryExchange['ref']
  method: HttpMethod
  /** Como o chamador montou, com {{VAR}}. */
  url: string
  status: number | null
  errorCode: string | null
  errorMessage?: string | null
  outcome?: HistoryOutcome | null
  durationMs: number
  sizeBytes: number | null
  connectorId: string | null
  environmentId: string | null
  template?: {
    headers: HttpHeader[]
    body?: string | null
    payload?: RequestPayload
    inheritHeaders?: boolean
    dropHeaders?: string[]
    anonymous?: boolean
    extra?: Readonly<Record<string, string>>
    prepareFlowId?: string
    endpointId?: string
    scripts?: RequestScripts
  }
  sent?: { url: string; headers: HttpHeader[]; body?: string | null }
  response?: {
    status: number
    statusText: string
    headers: HttpHeader[]
    body: string
    bodyBase64?: string
    truncated: boolean
    sizeBytes: number
    timings: HttpTimings
  }
  timings?: HttpTimings | { totalMs: number }
  auth?: AuthUsage
  assertions?: AssertionResult[]
  logs?: string
}

export interface NewHistoryRun {
  createdAt: number
  source: HistorySource
  title: string
  outcome: HistoryOutcome
  status?: number | null
  errorCode?: string | null
  durationMs: number
  connectorId?: string | null
  environmentId?: string | null
  flowId?: string | null
  totals?: { passed: number; failed: number; error: number } | null
  /**
   * Relatório da execução. No nível `metadata` só ficam os campos de `report.meta`; o resto
   * passa a contar a partir de `headers`, e `report.full` só em `full`.
   */
  report?: { meta?: unknown; headers?: unknown; full?: unknown }
  replayOf?: number | null
  remote?: HistoryRunSummary['remote']
  exchanges: NewHistoryExchange[]
}

export interface AddRunOptions {
  /** Sanitizer que já conhece os segredos do workspace e as credenciais vistas no dispatcher. */
  sanitizer?: SecretSanitizer
  /** Nível no lugar do configurado para a origem (o `--history` do CLI). */
  level?: HistoryLevel
  /**
   * Dados pessoais mascarados também para pessoas (@vvpost/core/pii-people): respostas, o que foi
   * para a rede, asserções, logs e relatório. O modelo da requisição fica como digitado, para
   * reproduzir.
   */
  pii?: PiiMasker
}

/**
 * Abre (ou cria) o banco SQLite do histórico em modo WAL e aplica as migrações.
 * Usa o `node:sqlite` embutido no Node do Electron: nada de módulo nativo para
 * recompilar a cada versão do Electron, e nada a mais no instalador.
 */
export async function openHistoryStore(path: string) {
  const sqlite = new DatabaseSync(path)
  // auto_vacuum só vale num banco novo (antes da primeira tabela): o espaço das execuções
  // apagadas volta para o sistema com incremental_vacuum, sem VACUUM completo.
  sqlite.exec(
    'PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;'
  )

  const db = new Kysely<Schema>({ dialect: new SqliteDialect({ database: kyselyAdapter(sqlite) }) })
  const { error } = await new Migrator({
    db,
    provider: { getMigrations: async () => migrations }
  }).migrateToLatest()
  if (error) {
    await db.destroy()
    throw error
  }

  let settings = await readSettings()
  let sinceVacuum = 0

  async function readSettings(): Promise<HistorySettings> {
    const row = await db.selectFrom('history_settings').select('value').where('key', '=', 'settings').executeTakeFirst()
    if (!row) return DEFAULT_HISTORY_SETTINGS
    try {
      return normalizeSettings(JSON.parse(row.value))
    } catch {
      return DEFAULT_HISTORY_SETTINGS
    }
  }

  /** Idade, número de execuções e tamanho somado, nesta ordem. */
  async function prune(now = Date.now()): Promise<void> {
    if (settings.maxAgeDays > 0) {
      await db.deleteFrom('history_run').where('created_at', '<', now - settings.maxAgeDays * 86_400_000).execute()
    }
    await sql`DELETE FROM history_run WHERE id NOT IN (SELECT id FROM history_run ORDER BY id DESC LIMIT ${settings.maxRuns})`.execute(db)
    const limit = settings.maxSizeMB * 1024 * 1024
    for (;;) {
      const { total } = await db
        .selectFrom('history_run')
        .select(sql<number>`coalesce(sum(bytes), 0)`.as('total'))
        .executeTakeFirstOrThrow()
      if (total <= limit) break
      // A mais antiga sai até caber; a mais recente fica mesmo que sozinha passe do limite.
      const oldest = await db.selectFrom('history_run').select(['id', 'bytes']).orderBy('id').limit(50).execute()
      const newest = await db.selectFrom('history_run').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst()
      let excess = total - limit
      const ids: number[] = []
      for (const r of oldest) {
        if (excess <= 0 || r.id === newest?.id) break
        ids.push(r.id)
        excess -= r.bytes
      }
      if (!ids.length) break
      await db.deleteFrom('history_run').where('id', 'in', ids).execute()
    }
    if (++sinceVacuum >= 50) {
      sinceVacuum = 0
      sqlite.exec('PRAGMA incremental_vacuum')
    }
  }

  return {
    /** Grava a execução no nível da origem; `null` quando o nível é `off`. */
    async addRun(run: NewHistoryRun, options: AddRunOptions = {}): Promise<number | null> {
      const level = options.level ?? (run.source === 'cli' ? 'metadata' : settings.levels[run.source])
      if (level === 'off') return null
      const sanitizer = options.sanitizer ?? createSecretSanitizer()
      const maxBody = settings.maxBodyKB * 1024
      const shaped = run.exchanges.map((x) => shapeExchange(x, level, sanitizer, maxBody, options.pii))
      const report = shapeReport(run.report, level, sanitizer, options.pii)
      const first = shaped[0]
      const title = options.pii ? options.pii.text(scrub(run.title, sanitizer)) : scrub(run.title, sanitizer)
      const bytes = shaped.reduce((n, x) => n + x.detail.length + x.url.length, title.length + (report?.length ?? 0))

      const id = await db.transaction().execute(async (tx) => {
        const row = await tx
          .insertInto('history_run')
          .values({
            created_at: run.createdAt,
            source: run.source,
            level,
            title,
            outcome: run.outcome,
            status: run.status ?? null,
            error_code: run.errorCode ?? null,
            duration_ms: run.durationMs,
            connector_id: run.connectorId ?? null,
            environment_id: run.environmentId ?? null,
            flow_id: run.flowId ?? null,
            method: first?.method ?? null,
            url: first?.url ?? null,
            exchange_count: shaped.length,
            totals: run.totals ? JSON.stringify(run.totals) : null,
            report,
            replay_of: run.replayOf ?? null,
            bytes,
            remote: run.remote ? JSON.stringify(run.remote) : null
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        // Lotes grandes: em partes, para não passar do limite de parâmetros do SQLite.
        for (let i = 0; i < shaped.length; i += 50) {
          await tx
            .insertInto('history_exchange')
            .values(shaped.slice(i, i + 50).map((x, j) => ({ ...x, run_id: row.id, seq: i + j })))
            .execute()
        }
        return row.id
      })
      await prune()
      return id
    },

    async list(query: HistoryQuery = {}): Promise<HistoryRunSummary[]> {
      let q = db.selectFrom('history_run').selectAll()
      if (query.source) q = q.where('source', '=', query.source)
      if (query.remote !== undefined) q = q.where('remote', query.remote ? 'is not' : 'is', null)
      if (query.outcome) q = q.where('outcome', '=', query.outcome)
      if (query.beforeId) q = q.where('id', '<', query.beforeId)
      const search = query.search?.trim()
      if (search) {
        const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        q = q.where((eb) =>
          eb.or([
            sql<boolean>`title LIKE ${like} ESCAPE '\\'`,
            sql<boolean>`url LIKE ${like} ESCAPE '\\'`,
            sql<boolean>`EXISTS (SELECT 1 FROM history_exchange x WHERE x.run_id = history_run.id AND (x.url LIKE ${like} ESCAPE '\\' OR x.label LIKE ${like} ESCAPE '\\'))`
          ])
        )
      }
      const rows = await q
        .orderBy('id', 'desc')
        .limit(Math.min(Math.max(1, query.limit ?? 100), 1000))
        .execute()
      return rows.map(toSummary)
    },

    async get(id: number): Promise<HistoryRunDetail | null> {
      const run = await db.selectFrom('history_run').selectAll().where('id', '=', id).executeTakeFirst()
      if (!run) return null
      const exchanges = await db.selectFrom('history_exchange').selectAll().where('run_id', '=', id).orderBy('seq').execute()
      return { ...toSummary(run), exchanges: exchanges.map(toExchange), report: run.report ? JSON.parse(run.report) : null }
    },

    async getExchange(id: number): Promise<(HistoryExchange & { runId: number }) | null> {
      const row = await db.selectFrom('history_exchange').selectAll().where('id', '=', id).executeTakeFirst()
      return row ? { ...toExchange(row), runId: row.run_id } : null
    },

    async delete(id: number): Promise<void> {
      await db.deleteFrom('history_run').where('id', '=', id).execute()
    },

    async clear(): Promise<void> {
      await db.deleteFrom('history_run').execute()
      sqlite.exec('PRAGMA incremental_vacuum')
    },

    settings: (): HistorySettings => settings,

    async setSettings(value: unknown): Promise<HistorySettings> {
      settings = normalizeSettings(value)
      const json = JSON.stringify(settings)
      await db
        .insertInto('history_settings')
        .values({ key: 'settings', value: json })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: json }))
        .execute()
      await prune()
      return settings
    },

    async stats(): Promise<HistoryStats> {
      const runs = await db
        .selectFrom('history_run')
        .select([sql<number>`count(*)`.as('runs'), sql<number>`coalesce(sum(bytes), 0)`.as('bytes'), sql<number>`coalesce(sum(exchange_count), 0)`.as('exchanges')])
        .executeTakeFirstOrThrow()
      let fileBytes = 0
      for (const file of [path, `${path}-wal`]) {
        try {
          fileBytes += statSync(file).size
        } catch {
          // sem WAL no momento
        }
      }
      return { runs: runs.runs, exchanges: runs.exchanges, bytes: runs.bytes, fileBytes }
    },

    /** Usado nos testes para confirmar o modo do journal. */
    async journalMode(): Promise<string> {
      const { rows } = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(db)
      return rows[0]?.journal_mode ?? ''
    },

    close: () => db.destroy()
  }
}

export type HistoryStore = Awaited<ReturnType<typeof openHistoryStore>>

/** Configurações vindas do renderer ou do banco: campos ausentes ou fora do limite voltam ao padrão. */
export function normalizeSettings(value: unknown): HistorySettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof HistorySettings, unknown>>
  const levels = (v.levels && typeof v.levels === 'object' ? v.levels : {}) as Record<string, unknown>
  const level = (x: unknown, fallback: HistoryLevel): HistoryLevel =>
    HISTORY_LEVELS.includes(x as HistoryLevel) ? (x as HistoryLevel) : fallback
  const num = (key: keyof typeof LIMITS) => {
    const n = Number(v[key])
    const [min, max] = LIMITS[key]
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : DEFAULT_HISTORY_SETTINGS[key]
  }
  const d = DEFAULT_HISTORY_SETTINGS.levels
  return {
    levels: { request: level(levels['request'], d.request), scenarios: level(levels['scenarios'], d.scenarios), flow: level(levels['flow'], d.flow) },
    maxRuns: num('maxRuns'),
    maxAgeDays: num('maxAgeDays'),
    maxBodyKB: num('maxBodyKB'),
    maxSizeMB: num('maxSizeMB')
  }
}

type ExchangeRow = Omit<HistoryExchangeTable, 'id' | 'run_id' | 'seq'>

/** Aplica o nível e as máscaras: nada sai daqui com segredo. */
function shapeExchange(x: NewHistoryExchange, level: Exclude<HistoryLevel, 'off'>, s: SecretSanitizer, maxBody: number, pii?: PiiMasker): ExchangeRow {
  const withHeaders = level !== 'metadata'
  const full = level === 'full'
  const url = pii ? pii.text(scrub(maskUrl(x.url), s)) : scrub(maskUrl(x.url), s)
  const detail: Record<string, unknown> = {}

  let replayBlocked: string | undefined
  if (x.template) {
    const t = x.template
    const template: NonNullable<HistoryExchange['template']> = {}
    if (withHeaders) template.headers = t.headers.map((h) => ({ name: h.name, value: scrub(maskHeaderValue(h), s) }))
    if (full && t.body !== undefined) template.body = t.body === null ? null : scrub(cut(maskBody(t.body), maxBody).text, s)
    // Do corpo estruturado ficam os campos (valores mascarados como o resto) e os caminhos dos arquivos.
    if (full && t.payload) template.payload = s.sanitize(structuredClone(t.payload))
    if (t.inheritHeaders === false) template.inheritHeaders = false
    if (t.dropHeaders?.length) template.dropHeaders = t.dropHeaders
    if (t.anonymous) template.anonymous = true
    if (t.prepareFlowId) template.prepareFlowId = t.prepareFlowId
    if (t.endpointId) template.endpointId = t.endpointId
    // Os scripts são código: ficam no nível completo, com os valores de segredo mascarados como o corpo.
    if (full && t.scripts) template.scripts = { ...(t.scripts.pre && { pre: scrub(t.scripts.pre, s) }), ...(t.scripts.post && { post: scrub(t.scripts.post, s) }) }
    if (full && t.extra && Object.keys(t.extra).length) template.extra = s.sanitize({ ...t.extra })
    detail['template'] = template

    const hasBody = (t.body !== undefined && t.body !== null && t.body !== '') || !!t.payload || !!t.scripts
    const hasExtra = !!t.extra && Object.keys(t.extra).length > 0
    if (!withHeaders) replayBlocked = 'o nível "metadados" não guarda headers e corpo'
    else if ((hasBody || hasExtra) && !full) replayBlocked = 'o nível "headers" não guarda o corpo, os scripts nem os valores de $nodes'
    else if (t.body && t.body.length > maxBody) replayBlocked = 'o corpo foi cortado ao gravar'
    else if (containsMask(JSON.stringify(template)) || containsMask(url)) {
      replayBlocked = 'há valores mascarados (credencial digitada à mão); reabra no Quick Request e preencha'
    }
  } else replayBlocked = 'sem o modelo da requisição'

  if (withHeaders && x.sent) {
    detail['sent'] = s.sanitize({
      url: x.sent.url,
      headers: x.sent.headers,
      ...(full && x.sent.body !== undefined && { body: x.sent.body === null ? null : cut(cleanBody(x.sent.body, s), maxBody).text })
    })
    if (pii) detail['sent'] = peopleText(detail['sent'], pii)
  }
  if (withHeaders && x.response) {
    const r = x.response
    const body = full ? cut(r.body, maxBody) : undefined
    detail['response'] = {
      status: r.status,
      statusText: r.statusText,
      headers: pii ? peopleHeaders(s.sanitize(r.headers), pii) : s.sanitize(r.headers),
      ...(body && { body: pii ? pii.text(cleanBody(body.text, s)) : cleanBody(body.text, s), ...(body.cut && { bodyCut: true }) }),
      // Corpo binário: os bytes inteiros ou nada (um pedaço de imagem ou PDF não abre).
      ...(full && r.bodyBase64 !== undefined && r.bodyBase64.length <= maxBody && { bodyBase64: r.bodyBase64 }),
      truncated: r.truncated,
      sizeBytes: r.sizeBytes
    }
  }
  const timings = x.response?.timings ?? x.timings
  if (timings) detail['timings'] = timings
  if (x.auth) detail['auth'] = x.auth
  if (x.assertions?.length) {
    const assertions = s.sanitize(x.assertions)
    detail['assertions'] = pii ? peopleAssertions(assertions, pii) : assertions
  }
  if (withHeaders && x.logs) detail['logs'] = pii ? pii.text(s.text(x.logs)) : s.text(x.logs)
  if (replayBlocked) detail['replayBlocked'] = replayBlocked

  return {
    created_at: x.createdAt,
    label: x.label ?? null,
    ref: x.ref ? JSON.stringify(x.ref) : null,
    method: x.method,
    url,
    status: x.status,
    error_code: x.errorCode,
    error_message: x.errorMessage ? s.text(x.errorMessage) : null,
    outcome: x.outcome ?? null,
    duration_ms: x.durationMs,
    size_bytes: x.sizeBytes,
    connector_id: x.connectorId,
    environment_id: x.environmentId,
    replayable: replayBlocked ? 0 : 1,
    detail: JSON.stringify(deepScrub(detail, s))
  }
}

function shapeReport(report: NewHistoryRun['report'], level: Exclude<HistoryLevel, 'off'>, s: SecretSanitizer, pii?: PiiMasker): string | null {
  if (!report) return null
  const parts = [report.meta, level !== 'metadata' ? report.headers : undefined, level === 'full' ? report.full : undefined]
  const merged = parts.reduce<Record<string, unknown> | null>(
    (acc, part) => (part && typeof part === 'object' ? { ...(acc ?? {}), ...(part as Record<string, unknown>) } : acc),
    null
  )
  if (!merged) return null
  // No relatório, as saídas dos nós são dado da resposta: a chave marcada vale (pii.sanitize).
  return JSON.stringify(deepScrub(pii ? pii.sanitize(s.sanitize(merged)) : s.sanitize(merged), s))
}

function toSummary(r: Selectable<HistoryRunTable>): HistoryRunSummary {
  return {
    id: r.id,
    createdAt: r.created_at,
    source: r.source as HistorySource,
    level: r.level as HistoryRunSummary['level'],
    title: r.title,
    outcome: r.outcome as HistoryOutcome,
    status: r.status,
    errorCode: r.error_code,
    durationMs: r.duration_ms,
    connectorId: r.connector_id,
    environmentId: r.environment_id,
    flowId: r.flow_id,
    exchangeCount: r.exchange_count,
    totals: r.totals ? JSON.parse(r.totals) : null,
    method: r.method as HttpMethod | null,
    url: r.url,
    replayOf: r.replay_of,
    bytes: r.bytes,
    remote: r.remote ? JSON.parse(r.remote) : null
  }
}

function toExchange(r: Selectable<HistoryExchangeTable>): HistoryExchange {
  const detail = JSON.parse(r.detail) as Partial<HistoryExchange>
  return {
    id: r.id,
    seq: r.seq,
    createdAt: r.created_at,
    label: r.label,
    ref: r.ref ? JSON.parse(r.ref) : null,
    method: r.method as HttpMethod,
    url: r.url,
    status: r.status,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    outcome: r.outcome as HistoryOutcome | null,
    durationMs: r.duration_ms,
    sizeBytes: r.size_bytes,
    connectorId: r.connector_id,
    environmentId: r.environment_id,
    replayable: r.replayable === 1,
    ...detail
  }
}

function cut(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false }
}

const containsMask = (text: string) => text.includes(SECRET_PLACEHOLDER) || text.includes(REDACTED)

/** Valores que o sanitizer conhece (segredos do workspace, tokens vistos), onde quer que estejam. */
function scrub(text: string, s: SecretSanitizer): string {
  return s.leaks(text) ? s.text(text) : text
}

function deepScrub<T>(value: T, s: SecretSanitizer): T {
  if (typeof value === 'string') return scrub(value, s) as T
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, s)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepScrub(v, s)])) as T
  }
  return value
}

/** Corpo pelo sanitizer, mas com a formatação original quando nada mudou. */
function cleanBody(body: string, s: SecretSanitizer): string {
  const out = s.text(body)
  if (out === body) return body
  try {
    if (JSON.stringify(JSON.parse(out)) === JSON.stringify(JSON.parse(body))) return body
  } catch {
    // não é JSON: fica a versão do sanitizer
  }
  return out
}

/** Valor que é só uma referência {{VAR}} (ou "Bearer {{VAR}}"): o nome da variável, não o segredo. Fica como está. */
const isTemplate = (value: string) => /^\s*(?:(?:Bearer|Basic|Token|Digest)\s+)?\{\{[^{}]+\}\}\s*$/i.test(value)

function maskHeaderValue(h: HttpHeader): string {
  const name = h.name.trim().toLowerCase()
  return (SENSITIVE_HEADERS.has(name) || isSensitiveName(name)) && h.value && !isTemplate(h.value) ? SECRET_PLACEHOLDER : h.value
}

export function maskHeaders(headers: HttpHeader[]): HttpHeader[] {
  return headers.map((h) => ({ ...h, value: maskHeaderValue(h) }))
}

/** Parâmetros de query de nome sensível (api_key, access_token, sig...) viram o marcador. */
export function maskUrl(url: string): string {
  const q = url.indexOf('?')
  if (q < 0) return url
  const hash = url.indexOf('#', q)
  const end = hash < 0 ? url.length : hash
  return url.slice(0, q + 1) + maskForm(url.slice(q + 1, end)) + url.slice(end)
}

/** form-urlencoded, campo a campo, sem reordenar nem recodificar o resto. */
function maskForm(text: string): string {
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return pair
      let name = pair.slice(0, eq)
      let value = pair.slice(eq + 1)
      try {
        name = decodeURIComponent(name.replace(/\+/g, ' '))
        value = decodeURIComponent(value.replace(/\+/g, ' '))
      } catch {
        // Codificação quebrada: o nome cru decide.
      }
      return isSensitiveName(name) && value && !isTemplate(value) ? `${pair.slice(0, eq)}=${SECRET_PLACEHOLDER}` : pair
    })
    .join('&')
}

/**
 * Corpo como vai para o disco: campos JSON e de formulário com nome de credencial
 * (password, client_secret, token...) viram o marcador; {{VAR}} fica. Texto que não
 * é JSON nem formulário passa igual.
 */
export function maskBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return body
    }
    let changed = false
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk)
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          if (isSensitiveName(k) && v !== null && v !== '' && typeof v !== 'object' && !(typeof v === 'string' && isTemplate(v))) {
            changed = true
            return [k, SECRET_PLACEHOLDER]
          }
          return [k, walk(v)]
        })
      )
    }
    const masked = walk(parsed)
    return changed ? JSON.stringify(masked, null, /\n\s/.test(trimmed) ? 2 : undefined) : body
  }
  return /^[^\s=&]+=[^\s]*$/.test(trimmed) ? maskForm(trimmed) : body
}

/** O SqliteDialect do Kysely espera a interface do better-sqlite3; o node:sqlite é quase igual. */
function kyselyAdapter(db: DatabaseSync): SqliteDatabase {
  return {
    close: () => db.close(),
    prepare(query) {
      const stmt = db.prepare(query)
      const args = (params: ReadonlyArray<unknown>) => params as SQLInputValue[]
      return {
        reader: stmt.columns().length > 0,
        all: (params) => stmt.all(...args(params)),
        run: (params) => stmt.run(...args(params)),
        iterate: (params) => stmt.iterate(...args(params))
      }
    }
  }
}
