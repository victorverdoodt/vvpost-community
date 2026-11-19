import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { app, clipboard, dialog, shell, type BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { featureDenial } from '@vvpost/core/policy/features'
import { enterprisePolicy, refreshIdentity } from './identity'
import {
  PROJECT_EDIT_OPS,
  type BodyValidation,
  type ConflictFile,
  type ConflictResolution,
  type Connector,
  type CatalogConnector,
  type ConnectorCatalog,
  type ConnectorSource,
  type SharedSchemaSource,
  type AiReviewItem,
  type ConnectorRegistry,
  type DiagramFixReport,
  type LintReport,
  type DataFile,
  type DocScope,
  type DocsCompileResult,
  type DocsConfig,
  type DocsDraft,
  type DocsProjectState,
  type DocsSaveResult,
  type DocsTemplateInput,
  type DiagramCatalog,
  type DiagramSaveInput,
  type DocsFileList,
  type MarkdownSaveInput,
  type DocTemplateSummary,
  type FileDiff,
  type GeneratedDocs,
  type Flow,
  type FlowCatalog,
  type FlowRunEvent,
  type FlowRunInput,
  type FlowRunReport,
  type GitCommitOutcome,
  type GitSyncAction,
  type HistoryQuery,
  type HistoryReplayResult,
  type HistoryRunDetail,
  type HistoryRunSummary,
  type HistorySettings,
  type HistoryStats,
  type HttpRequestInput,
  type HttpSettings,
  type CookieEntry,
  type PluginRequestInput,
  type HttpResult,
  type McpServerState,
  type ConnectRepoResult,
  type MockServerState,
  type RealtimeEvent,
  type RealtimeOpenInput,
  type PluginCatalog,
  type PluginInstallPreview,
  type PluginRegistryListing,
  type ExportOptions,
  type ExportPreview,
  type ExportSaveResult,
  type ResponseSaveInput,
  type ResponseSaveResult,
  type ExportSelection,
  type ExportFormat,
  type ImportPlanInput,
  type PostmanImportPreview,
  type PostmanWriteResult,
  type RemoteRun,
  type RemoteRunPoll,
  type RemoteRunPreview,
  type RemoteRunSelection,
  type RemoteRunTarget,
  type ScenarioRunInput,
  type ScenarioRunReport,
  type SecretEngineState,
  type SecretInventory,
  type ProjectEdit,
  type ProjectMigration,
  type ProjectTemplate,
  type WebhookChangeEvent,
  type WebhookEventSummary,
  type WebhookServerState,
  type WorkspaceInfo,
  type WorkspaceResult,
  type WorkspaceFilesChange,
  type WorkspaceState,
  type ArchiveExportPreview,
  type ArchiveExportSaveResult,
  type ArchiveImportChoice,
  type ArchiveImportPreview,
  type ArchiveImportResult,
  type ArchiveKind,
  type PublishApplied,
  type PublishApproval,
  type PublishPlan,
  type PublishPrepared,
  type PublisherSession,
  type PublishTargetsState
} from '@shared/ipc'
import type { AuthEngine, LoadedWorkspace } from '@vvpost/core/connectors'
import { pluginLocations } from '@vvpost/core/paths'
import type { HttpDispatcher } from '@vvpost/core/http/dispatcher'
import type { HistoryStore, NewHistoryRun } from './history/store'
import type { ExchangeRecorder, RecordedExchange, RecorderLimits } from '@vvpost/core/recorder'
import type { SecretSanitizer } from '@vvpost/core/sanitizer'
import type { PiiMasker } from '@vvpost/core/pii'
import type { PluginManager } from '@vvpost/core/plugins'
import type { ImportTarget, PreparedImport } from './importers'
import type { RunningAppMcp } from './mcp/app'
import { setSharedConnectors } from '@vvpost/core/connectors/shared'
import { auditHost, recordActivity, sharedConnectors } from './enterprise/control-plane'
import { readOrganization } from './enterprise/organization'
import { loadEnterpriseModule, type OrganizationRef } from './secret-engine/backend'
import type { RunningEngine } from './secret-engine/server'
import type { RunningWebhookServer } from './webhooks/server'
import type { WebhookEvent } from '@vvpost/core/types'
import { REQUIRED_SECRET, type SecretsEngineMode } from '@vvpost/schemas'
import type { ProjectOp } from './project/ops'
import { watchWorkspace, type WorkspaceWatcher } from './workspace/watch'

/** OAuth2 authorization_code: o login do provedor abre no navegador do sistema (o motor só aceita http e https). */
const AUTH_HOOKS = { openBrowser: (url: string) => shell.openExternal(url) }

/**
 * Dispatcher HTTP (undici) e histórico (Kysely + SQLite) são chunks separados,
 * carregados via import() no primeiro uso de cada um, fora do caminho do cold
 * start. Abrir o histórico não carrega o undici, e vice-versa.
 */
let http: Promise<HttpDispatcher> | null = null
let history: Promise<HistoryStore> | null = null

const getHttp = () =>
  (http ??= Promise.all([import('@vvpost/core/http/dispatcher'), import('./http-settings')]).then(async ([m, settings]) =>
    m.createHttpDispatcher({}, await settings.httpClientConfig())
  ))
const getHttpSettingsModule = () => import('./http-settings')
const getHistory = () =>
  (history ??= import('./history/store').then(async (m) => {
    const store = await m.openHistoryStore(join(app.getPath('userData'), 'vvpost.db'))
    recordLimits = limitsFor(store.settings())
    return store
  }))
/** O gravador só guarda o que o histórico vai gravar; até o banco abrir, o padrão (256 KB). */
let recordLimits: RecorderLimits = { enabled: true, maxBody: 256 * 1024 }
const limitsFor = (s: HistorySettings): RecorderLimits => ({
  enabled: Object.values(s.levels).some((level) => level !== 'off'),
  maxBody: s.maxBodyKB * 1024
})
const getRecord = () => import('./history/record')

/**
 * Histórico rico: todo disparo do app passa por um sanitizer que aprende as
 * credenciais vistas (segredos do workspace, tokens dos fluxos de auth) e por um gravador
 * que guarda, por id, o modelo da requisição, o que foi para a rede e a resposta. Quem
 * dispara tira as suas requisições do gravador ao terminar e grava a execução no nível
 * configurado para a origem.
 */
interface Traced {
  http: HttpDispatcher
  recorder: ExchangeRecorder<HttpDispatcher>
  sanitizer: SecretSanitizer
}
let traced: Promise<Traced> | null = null
const getTraced = () =>
  (traced ??= Promise.all([
    getHttp(),
    import('@vvpost/core/sanitizer'),
    import('@vvpost/core/recorder'),
    getProtect()
  ]).then(([base, { createSecretSanitizer }, { createExchangeRecorder }, { protectWorkspace }]) => {
    const sanitizer = createSecretSanitizer()
    if (catalog) protectWorkspace(sanitizer, catalog)
    const recorder = createExchangeRecorder(sanitizer.track(base, { remember: 0 }), () => recordLimits)
    return { http: recorder.http, recorder, sanitizer }
  }))
const getProtect = () => import('@vvpost/core/protect')

/** O histórico não pode derrubar quem disparou: uma falha de disco só vai para o log. */
async function saveRun(run: NewHistoryRun, sanitizer: SecretSanitizer): Promise<number | null> {
  try {
    const pii = await peopleView()
    return await (await getHistory()).addRun(run, { sanitizer, ...(pii && { pii }) })
  } catch (err) {
    console.error('Falha ao gravar histórico:', err)
    return null
  }
}

/**
 * Conectores e auth headless: outro chunk sob demanda. Os arquivos do
 * workspace aberto ficam em memória como foram lidos por último; o Quick Request
 * pede para reler ao ganhar foco, e toda operação do Git Workspace descarta a cópia.
 */
let connectors: Promise<typeof import('@vvpost/core/connectors')> | null = null
let auth: AuthEngine | null = null
let catalog: LoadedWorkspace | null = null
const getConnectors = () => (connectors ??= import('@vvpost/core/connectors'))
// Catálogo centralizado (módulo Enterprise): os conectores corporativos entram em todo
// loadWorkspace como somente leitura. Sem módulo, a lista é vazia.
setSharedConnectors(() => sharedConnectors())
/** Fase de auth das requisições em andamento, para o cancelamento alcançar também o login/OAuth2. */
const authPhase = new Map<string, AbortController>()

async function loadCatalog({ fresh = false } = {}): Promise<LoadedWorkspace> {
  const dir = await currentWorkspaceDir()
  if (!dir) throw new Error('Nenhum workspace aberto. Abra a pasta do workspace no Quick Request.')
  if (!fresh && catalog?.dir === dir) return catalog
  catalog = await (await getConnectors()).loadWorkspace(dir)
  // O sanitizer do histórico conhece os segredos de todo workspace que o app leu (se ainda não
  // existe, nasce com o catálogo atual: ler o workspace não carrega o undici).
  const loaded = catalog
  if (traced) void Promise.all([traced, getProtect()]).then(([t, { protectWorkspace }]) => protectWorkspace(t.sanitizer, loaded))
  return catalog
}

/**
 * Fluxo de preparação do Quick Request: roda o fluxo salvo no disco pelo
 * mesmo dispatcher e cache de tokens, sem entrar no histórico como execução à parte (as
 * requisições dele saem do gravador aqui); a requisição lê a saída pelos $nodes.
 */
async function prepare(input: HttpRequestInput, ws: LoadedWorkspace, t: Traced, engine: AuthEngine, signal: AbortSignal) {
  const [flows, core, { prepareRequest }] = await Promise.all([getFlows(), getCore(), import('@vvpost/core/flows/prepare')])
  const flow = input.prepareFlow ?? (await flows.loadFlows(ws.dir)).flows.find((f) => f.flow.id === input.prepareFlowId)?.flow
  const runId = `prepare:${input.id}`
  try {
    return await prepareRequest(input, flow, (f) =>
      core.runFlowWith({ runId, flow: f, ...(input.environmentId && { environmentId: input.environmentId }) }, ws, {
        auth: engine,
        http: t.http,
        signal,
        plugins: async () => (await getPlugins()).runner()
      })
    )
  } finally {
    t.recorder.take(runId)
  }
}

/**
 * Variáveis que os scripts da requisição definiram (vv.variables.set), por ambiente: valem para
 * as próximas requisições até o app fechar. Só em memória; nunca vão para um arquivo.
 */
const scriptVariables = new Map<string, Record<string, string>>()

/**
 * Envia pela herança e auth headless; com scripts (da requisição, do endpoint ou do conector), pelo
 * fluxo script → requisição → script no motor do Flow Studio (fase 13).
 */
async function send(
  input: HttpRequestInput,
  ws: LoadedWorkspace,
  ctx: import('@vvpost/core/connectors/headless').HeadlessContext & { http: Pick<HttpDispatcher, 'send' | 'cancel'> },
  options: import('@vvpost/core/connectors/headless').HeadlessOptions
): Promise<HttpResult> {
  const scripts = await import('@vvpost/core/flows/scripted-send')
  if (!scripts.stepsFor(input, ws).length) return (await getConnectors()).sendHeadless(input, ctx, options)
  const key = input.environmentId ?? ''
  const result = await scripts.sendWithScripts(
    input,
    { ...ctx, plugins: await (await getPlugins()).runner(), variables: scriptVariables.get(key) ?? {} },
    options
  )
  if (result?.scripts && Object.keys(result.scripts.variables).length) {
    scriptVariables.set(key, { ...scriptVariables.get(key), ...result.scripts.variables })
  }
  return result ?? (await getConnectors()).sendHeadless(input, ctx, options)
}

/** O fluxo que roda por trás de uma requisição com scripts, para abrir no Flow Studio ("Ver como fluxo"). */
export async function requestScriptFlow(input: HttpRequestInput): Promise<WorkspaceResult<Flow>> {
  try {
    const ws = (await currentWorkspaceDir()) ? await loadCatalog() : (await getCore()).emptyWorkspace()
    const { requestScriptFlow: build } = await import('@vvpost/core/flows/scripted-send')
    return { ok: true, value: build(input, ws) }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** Dispara pelo gravador: com conector, ambiente ou preparação, pela herança e auth headless. */
async function dispatch(
  input: HttpRequestInput,
  options: import('@vvpost/core/connectors/headless').HeadlessOptions = {}
): Promise<{ result: HttpResult; traced: Traced }> {
  const t = await getTraced()
  let result: HttpResult
  if (input.connectorId || input.environmentId || input.prepareFlowId || input.prepareFlow || input.scripts?.pre?.trim() || input.scripts?.post?.trim()) {
    const controller = new AbortController()
    authPhase.set(input.id, controller)
    try {
      const mod = await getConnectors()
      // Só scripts, sem conector nem ambiente: roda mesmo sem workspace aberto.
      const ws = (await currentWorkspaceDir()) || input.connectorId || input.environmentId || input.prepareFlowId || input.prepareFlow
        ? await loadCatalog().catch((err: Error) => err)
        : (await getCore()).emptyWorkspace()
      const ctx = () => ({
        workspace: ws as LoadedWorkspace,
        auth: (auth ??= mod.createAuthEngine(Date.now, AUTH_HOOKS)),
        http: t.http,
        signal: controller.signal
      })
      if (ws instanceof Error) {
        result = { ok: false, error: { code: 'CONFIG_ERROR', message: ws.message }, timings: { totalMs: 0 } }
      } else if (input.prepareFlowId || input.prepareFlow) {
        const prepared = await prepare(input, ws, t, ctx().auth, controller.signal)
        result = prepared.ok
          ? { ...(await send(prepared.input, ws, ctx(), { ...options, extra: { ...options.extra, ...prepared.extra } })), prepare: prepared.prepare }
          : prepared.result
      } else {
        result = await send(input, ws, ctx(), options)
      }
    } finally {
      authPhase.delete(input.id)
    }
  } else {
    result = await t.http.send(input)
  }
  recordActivity({
    at: new Date().toISOString(),
    kind: 'request',
    method: input.method,
    host: input.connectorId ? null : auditHost(input.url),
    connectorId: input.connectorId ?? null,
    environmentId: input.environmentId ?? null,
    status: result.ok ? result.response.status : null,
    errorCode: result.ok ? null : result.error.code,
    durationMs: result.ok ? result.response.timings.totalMs : result.timings.totalMs
  })
  return { result, traced: t }
}

/**
 * Com preparação, o histórico guarda a requisição como digitada (com os {{ $nodes... }}) e o
 * fluxo, não os valores do fluxo daquela vez: reproduzir roda a preparação de novo.
 */
function withPrepareTemplate(input: HttpRequestInput, recorded: RecordedExchange[]): RecordedExchange[] {
  if (!input.prepareFlowId && !input.prepareFlow) return recorded
  return recorded.map((x) => ({ ...x, trace: { template: input } }))
}

export async function sendRequest(input: HttpRequestInput): Promise<HttpResult> {
  const { result, traced: t } = await dispatch(input)
  // Com scripts, a requisição é o nó Requisicao do fluxo (<id>:request), e o histórico guarda a
  // requisição como digitada, com os scripts: reproduzir roda os scripts de novo.
  const taken = t.recorder.take(input.id)
  const main = taken.find((x) => x.id === input.id || x.id === `${input.id}:request`)
  const [recorded] = withPrepareTemplate(input, main ? [result.scripts ? { ...main, trace: { template: input } } : main] : [])
  // É aguardado para que o renderer já encontre a entrada ao recarregar a lista.
  await saveRun((await getRecord()).requestRun(input, result, recorded), t.sanitizer)
  // A requisição enviada, ao lado da resposta: o Quick Request distingue o
  // modelo editável do que foi para a rede. Mascarada como no histórico.
  if (!recorded) return result
  const { method, url, headers } = recorded.sent
  return { ...result, sent: t.sanitizer.sanitize({ method, url, headers }) }
}

/**
 * Protocolo de plugin no Quick Request (gRPC, Kafka...): o adapter roda pelo mesmo caminho do
 * nó de plugin, com o conector e o ambiente escolhidos; cancelar é o mesmo `cancelRequest`.
 * As requisições que o plugin fizer pelo host não vão para o histórico.
 */
export async function sendPluginRequest(input: PluginRequestInput): Promise<HttpResult> {
  const controller = new AbortController()
  authPhase.set(input.id, controller)
  try {
    const [t, mod, core, plugins, { runAdapterRequest }] = await Promise.all([
      getTraced(),
      getConnectors(),
      getCore(),
      getPlugins(),
      import('@vvpost/core/flows/adapter-request')
    ])
    const ws = (await currentWorkspaceDir()) ? await loadCatalog().catch((err: Error) => err) : core.emptyWorkspace()
    if (ws instanceof Error) return { ok: false, error: { code: 'CONFIG_ERROR', message: ws.message }, timings: { totalMs: 0 } }
    try {
      return await runAdapterRequest(
        {
          id: String(input.id),
          adapter: String(input.adapter),
          ...(input.config && typeof input.config === 'object' && { config: input.config }),
          ...(input.connectorId && { connectorId: input.connectorId }),
          ...(input.environmentId && { environmentId: input.environmentId }),
          ...(typeof input.timeoutMs === 'number' && { timeoutMs: input.timeoutMs })
        },
        { workspace: ws, auth: (auth ??= mod.createAuthEngine(Date.now, AUTH_HOOKS)), http: t.http, plugins: await plugins.runner(), signal: controller.signal }
      )
    } finally {
      t.recorder.take(input.id)
    }
  } finally {
    authPhase.delete(input.id)
  }
}

export async function cancelRequest(id: string): Promise<void> {
  authPhase.get(id)?.abort()
  // Sem dispatcher carregado não há nada em andamento para cancelar.
  if (http) (await http).cancel(id)
}

// --- Conexões realtime (fase 15): WebSocket, SSE e Socket.IO no Quick Request ---

type RealtimeModule = typeof import('@vvpost/core/realtime')
const realtime = new Map<string, import('@vvpost/core/realtime').RealtimeConnection>()
const realtimeListeners = new Set<(events: RealtimeEvent[]) => void>()
let realtimeQueue: RealtimeEvent[] = []
let realtimeFlush: NodeJS.Timeout | null = null
/** Conexões abertas ao mesmo tempo: cada uma segura um socket. */
const MAX_REALTIME = 20

export function onRealtimeEvents(listener: (events: RealtimeEvent[]) => void): () => void {
  realtimeListeners.add(listener)
  return () => void realtimeListeners.delete(listener)
}

/** Um servidor que manda milhares de mensagens por segundo não inunda o IPC: os eventos vão em lotes. */
function emitRealtime(event: RealtimeEvent): void {
  realtimeQueue.push(event)
  realtimeFlush ??= setTimeout(() => {
    const batch = realtimeQueue
    realtimeQueue = []
    realtimeFlush = null
    for (const listener of realtimeListeners) listener(batch)
  }, 30)
}

/**
 * Abre a conexão de uma aba com o conector e o ambiente do contexto. As mensagens e os estados
 * chegam por onRealtimeEvents, já pelo Secret Sanitizer do histórico (que aprende os headers de
 * credencial da abertura). As conexões não entram no histórico.
 */
export function openRealtime(input: RealtimeOpenInput): Promise<WorkspaceResult<null>> {
  return attempt(async () => {
    const id = String(input?.id ?? '')
    const { REALTIME_PROTOCOLS, openRealtime: open } = (await import('@vvpost/core/realtime')) as RealtimeModule
    if (!id || realtime.has(id)) throw new Error('Id de conexão inválido ou já em uso.')
    if (!(REALTIME_PROTOCOLS as readonly string[]).includes(input.protocol)) throw new Error(`Protocolo desconhecido: ${String(input.protocol)}`)
    if (realtime.size >= MAX_REALTIME) throw new Error(`Já há ${MAX_REALTIME} conexões abertas; feche uma antes de abrir outra.`)
    const [t, mod, core] = await Promise.all([getTraced(), getConnectors(), getCore()])
    const ws = (await currentWorkspaceDir()) ? await loadCatalog() : core.emptyWorkspace()
    const conn = open(
      {
        id,
        protocol: input.protocol,
        url: String(input.url ?? ''),
        headers: Array.isArray(input.headers) ? input.headers.map((h) => ({ name: String(h.name), value: String(h.value) })) : [],
        ...(input.connectorId && { connectorId: String(input.connectorId) }),
        ...(input.environmentId && { environmentId: String(input.environmentId) }),
        ...(input.method && { method: input.method }),
        ...(typeof input.body === 'string' && { body: input.body }),
        ...(Array.isArray(input.subprotocols) && { subprotocols: input.subprotocols.map(String).filter(Boolean) })
      },
      { workspace: ws, auth: (auth ??= mod.createAuthEngine(Date.now, AUTH_HOOKS)), http: t.http, sanitizer: t.sanitizer },
      emitRealtime
    )
    realtime.set(id, conn)
    void conn.done.then(() => realtime.delete(id))
    return null
  })
}

export function sendRealtime(id: unknown, message: unknown): Promise<WorkspaceResult<null>> {
  return attempt(async () => {
    const conn = realtime.get(String(id))
    if (!conn) throw new Error('A conexão já foi fechada.')
    const m = (message && typeof message === 'object' ? message : {}) as { data?: unknown; event?: unknown }
    conn.send({ data: String(m.data ?? ''), ...(typeof m.event === 'string' && { event: m.event }) })
    return null
  })
}

export async function closeRealtime(id: unknown): Promise<void> {
  realtime.get(String(id))?.close()
}

function closeAllRealtime(): void {
  for (const conn of realtime.values()) conn.close()
}

export async function listHistory(query?: HistoryQuery): Promise<HistoryRunSummary[]> {
  return (await getHistory()).list(query && typeof query === 'object' ? query : {})
}

export async function getHistoryRun(id: number): Promise<HistoryRunDetail | null> {
  return (await getHistory()).get(Number(id))
}

export async function deleteHistoryRun(id: number): Promise<void> {
  await (await getHistory()).delete(Number(id))
}

export async function clearHistory(): Promise<void> {
  await (await getHistory()).clear()
}

export async function getHistorySettings(): Promise<HistorySettings> {
  return (await getHistory()).settings()
}

export async function setHistorySettings(settings: unknown): Promise<HistorySettings> {
  const saved = await (await getHistory()).setSettings(settings)
  recordLimits = limitsFor(saved)
  return saved
}

export async function getHistoryStats(): Promise<HistoryStats> {
  return (await getHistory()).stats()
}

/**
 * Reproduzir: refaz a requisição pelo modelo gravado, com {{VAR}}, herança e
 * auth resolvidos de novo no ambiente atual dos arquivos; nunca reenvia um valor mascarado.
 * A nova execução entra no histórico apontando para a original.
 */
export async function replayHistory(exchangeId: number): Promise<HistoryReplayResult> {
  const store = await getHistory()
  const x = await store.getExchange(Number(exchangeId))
  if (!x) return { ok: false, message: 'Esta entrada não está mais no histórico.' }
  if (!x.replayable || !x.template) return { ok: false, message: `Não dá para reproduzir: ${x.replayBlocked ?? 'sem o modelo da requisição'}.` }
  const t = x.template
  const input: HttpRequestInput = {
    id: `replay:${crypto.randomUUID()}`,
    method: x.method,
    url: x.url,
    headers: t.headers ?? [],
    ...(t.body && { body: t.body }),
    ...(t.payload && { payload: t.payload }),
    ...(x.connectorId && { connectorId: x.connectorId }),
    ...(x.environmentId && { environmentId: x.environmentId }),
    ...(t.prepareFlowId && { prepareFlowId: t.prepareFlowId }),
    ...(t.endpointId && { endpointId: t.endpointId }),
    ...(t.scripts && { scripts: t.scripts })
  }
  const { result, traced: tr } = await dispatch(input, {
    ...(t.inheritHeaders === false && { inheritHeaders: false }),
    ...(t.dropHeaders && { dropHeaders: t.dropHeaders }),
    ...(t.extra && { extra: t.extra }),
    ...(t.anonymous && { anonymous: true })
  })
  const [recorded] = withPrepareTemplate(input, tr.recorder.take(input.id))
  const runId = await saveRun((await getRecord()).requestRun(input, result, recorded, x.runId), tr.sanitizer)
  return { ok: true, result, runId }
}

/**
 * Import do Postman: a prévia converte e guarda o resultado aqui (com os valores de
 * segredo, que nunca vão ao renderer); a revisão reaplica os ajustes sobre ele e a
 * gravação usa o mesmo resultado. O destino padrão é o workspace aberto. Só o
 * último import fica em memória.
 */
let pendingImport: { prepared: PreparedImport; target: ImportTarget | null } | null = null

const showOpen = (win: BrowserWindow | null, options: OpenDialogOptions) =>
  win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)

const getImporters = () => import('./importers')

function pendingFor(id: string) {
  if (pendingImport?.prepared.id !== id) {
    throw new Error('Esta importação não está mais disponível. Escolha os arquivos de novo.')
  }
  return pendingImport
}

export async function previewPostmanImport(win: BrowserWindow | null, folder = false): Promise<PostmanImportPreview | null> {
  const picked = await showOpen(
    win,
    folder
      ? { title: 'Importar a pasta de uma coleção do Bruno', buttonLabel: 'Importar', properties: ['openDirectory'] }
      : {
          title: 'Importar no projeto',
          buttonLabel: 'Importar',
          properties: ['openFile', 'multiSelections'],
          filters: [
            {
              name: 'Pacotes do VVPost, Postman, OpenAPI, Insomnia, Bruno, HAR e WSDL',
              extensions: ['json', 'yaml', 'yml', 'bru', 'har', 'wsdl', 'xml']
            },
            { name: 'Todos os arquivos', extensions: ['*'] }
          ]
        }
  )
  if (picked.canceled || picked.filePaths.length === 0) return null
  const importers = await getImporters()
  const prepared = await importers.preparePostmanImport(picked.filePaths)
  const dir = await currentWorkspaceDir()
  pendingImport = { prepared, target: dir ? { dir, isWorkspace: true } : null }
  return importers.previewImport(prepared, pendingImport.target)
}

export async function previewUrlImport(url: string): Promise<PostmanImportPreview> {
  const importers = await getImporters()
  const prepared = await importers.prepareUrlImport(url.trim())
  const dir = await currentWorkspaceDir()
  pendingImport = { prepared, target: dir ? { dir, isWorkspace: true } : null }
  return importers.previewImport(prepared, pendingImport.target)
}

/** Reimportação da spec de um conector do projeto aberto, pela mesma revisão do import. */
export async function previewSpecReimport(connectorId: string): Promise<PostmanImportPreview> {
  const dir = await currentWorkspaceDir()
  if (!dir) throw new Error('Abra o projeto para reimportar a spec.')
  const importers = await getImporters()
  const prepared = await importers.prepareSpecReimport(dir, connectorId)
  pendingImport = { prepared, target: { dir, isWorkspace: true } }
  return importers.previewImport(prepared, pendingImport.target)
}

export async function planPostmanImport(id: string, input: ImportPlanInput): Promise<PostmanImportPreview> {
  const pending = pendingFor(id)
  return (await getImporters()).previewImport(pending.prepared, pending.target, input)
}

export async function choosePostmanImportTarget(
  win: BrowserWindow | null,
  id: string,
  input: ImportPlanInput
): Promise<PostmanImportPreview | null> {
  const pending = pendingFor(id)
  const picked = await showOpen(win, {
    title: 'Pasta do projeto VVPost',
    buttonLabel: 'Importar aqui',
    properties: ['openDirectory', 'createDirectory']
  })
  if (picked.canceled || !picked.filePaths[0]) return null
  const dir = picked.filePaths[0]
  pending.target = { dir, isWorkspace: dir === (await currentWorkspaceDir()) }
  return (await getImporters()).previewImport(pending.prepared, pending.target, input)
}

export async function writePostmanImport(
  win: BrowserWindow | null,
  id: string,
  input: ImportPlanInput
): Promise<PostmanWriteResult> {
  try {
    const pending = pendingFor(id)
    if (!pending.target) {
      const preview = await choosePostmanImportTarget(win, id, input)
      if (!preview) return { ok: false, reason: 'canceled' }
    }
    const target = pending.target!
    const { written } = await (await getImporters()).writeImport(pending.prepared, target, input)
    pendingImport = null
    if (target.isWorkspace) catalog = null
    return { ok: true, dir: target.dir, written }
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message }
  }
}

/**
 * Exportação do projeto aberto como pacote do VVPost (bundle.json). O módulo só é
 * carregado quando o painel pede; nenhum valor de segredo sai (ver bundle/export.ts).
 */
const getBundle = () => import('./bundle/export')

async function exportDir(): Promise<string> {
  const dir = await currentWorkspaceDir()
  if (!dir) throw new Error('Abra um projeto para exportar.')
  return dir
}

export async function getExportOptions(): Promise<ExportOptions | null> {
  const dir = await currentWorkspaceDir()
  return dir ? (await getBundle()).exportOptions(dir) : null
}

export async function previewExport(selection: ExportSelection): Promise<ExportPreview> {
  try {
    const { summary, warnings } = await (await getBundle()).exportAs(await exportDir(), selection)
    return { ok: true, summary, warnings }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

const SAVE_DIALOG: Record<ExportFormat, { title: string; filters: SaveDialogOptions['filters'] }> = {
  vvpost: { title: 'Exportar pacote do VVPost', filters: [{ name: 'Pacote do VVPost', extensions: ['json'] }] },
  postman: { title: 'Exportar coleção do Postman', filters: [{ name: 'Coleção do Postman v2.1', extensions: ['json'] }] },
  openapi: {
    title: 'Exportar spec OpenAPI',
    filters: [
      { name: 'OpenAPI em JSON', extensions: ['json'] },
      { name: 'OpenAPI em YAML', extensions: ['yaml', 'yml'] }
    ]
  }
}

export async function saveExport(
  win: BrowserWindow | null,
  selection: ExportSelection,
  meta: { name?: string; description?: string }
): Promise<ExportSaveResult> {
  try {
    const dir = await exportDir()
    const bundle = await getBundle()
    const format = selection.format ?? 'vvpost'
    const generator = `VVPost ${app.getVersion()}`
    // Primeiro monta (e recusa se houver segredo), depois pergunta onde salvar.
    const probe = await bundle.exportAs(dir, selection, { ...meta, generator })
    const fileName = `${(meta.name || basename(dir)).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'projeto'}${probe.files[0].suffix}`
    const options: SaveDialogOptions = {
      title: SAVE_DIALOG[format].title,
      buttonLabel: 'Exportar',
      defaultPath: join(app.getPath('documents'), fileName),
      filters: SAVE_DIALOG[format].filters
    }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, reason: 'canceled' }
    const target = picked.filePath
    const yaml = format === 'openapi' && /\.ya?ml$/i.test(target)
    const result = yaml ? await bundle.exportAs(dir, selection, { ...meta, generator, yaml }) : probe
    const [main, ...extra] = result.files
    // Os ambientes do Postman vão ao lado da coleção, com o mesmo começo de nome.
    const stem = target.endsWith(main.suffix) ? target.slice(0, -main.suffix.length) : target.replace(/\.(json|ya?ml)$/i, '')
    await writeFile(target, main.text)
    const files: string[] = []
    for (const f of extra) {
      await writeFile(`${stem}${f.suffix}`, f.text)
      files.push(`${stem}${f.suffix}`)
    }
    return { ok: true, path: target, files, summary: result.summary, warnings: result.warnings }
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message }
  }
}

/**
 * Zip do VVPost (bundle/archive.ts): a pasta do projeto aberto ou do workspace inteiro, sem
 * nenhum valor de segredo. Importar abre o zip como workspace novo ou acrescenta como projeto.
 */
const getArchive = () => import('./bundle/archive')

export async function previewArchiveExport(scope: ArchiveKind): Promise<ArchiveExportPreview> {
  try {
    const { manifest, folder, summary, warnings } = await (await getArchive()).exportArchive(await exportDir(), scope)
    return { ok: true, kind: manifest.kind, name: manifest.name, folder, summary, warnings }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

export async function saveArchiveExport(win: BrowserWindow | null, scope: ArchiveKind, meta: { name?: string }): Promise<ArchiveExportSaveResult> {
  try {
    const archive = await getArchive()
    // Primeiro monta (e recusa se houver segredo), depois pergunta onde salvar.
    const result = await archive.exportArchive(await exportDir(), scope, { ...meta, generator: `VVPost ${app.getVersion()}` })
    const fileName = `${result.manifest.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'}${archive.ARCHIVE_SUFFIX}`
    const options: SaveDialogOptions = {
      title: result.manifest.kind === 'project' ? 'Exportar o projeto em .zip' : 'Exportar o workspace em .zip',
      buttonLabel: 'Exportar',
      defaultPath: join(app.getPath('documents'), fileName),
      filters: [{ name: 'Zip do VVPost', extensions: ['zip'] }]
    }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, reason: 'canceled' }
    await writeFile(picked.filePath, result.data)
    return { ok: true, path: picked.filePath, kind: result.manifest.kind, summary: result.summary, warnings: result.warnings }
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message }
  }
}

/** O zip lido na prévia, à espera da escolha (workspace novo ou projeto). */
let pendingArchive: { id: string; file: string } | null = null

export async function previewArchiveImport(win: BrowserWindow | null): Promise<ArchiveImportPreview | null> {
  const picked = await showOpen(win, {
    title: 'Importar um .zip do VVPost',
    buttonLabel: 'Abrir',
    properties: ['openFile'],
    filters: [{ name: 'Zip do VVPost', extensions: ['zip'] }]
  })
  const file = picked.filePaths[0]
  if (picked.canceled || !file) return null
  const archive = await getArchive()
  const read = archive.readWorkspaceArchive(await readFile(file), basename(file))
  const dir = await currentWorkspaceDir()
  const target = dir
    ? archive.projectTarget(read, (await import('@vvpost/core/projects')).projectLayout(dir).root)
    : { id: read.manifest.project?.id ?? '', name: read.manifest.name, blocked: 'abra um workspace para acrescentar o zip como projeto' }
  pendingArchive = { id: crypto.randomUUID(), file }
  return {
    id: pendingArchive.id,
    file,
    kind: read.manifest.kind,
    name: read.manifest.name,
    projects: read.projects.map(({ id, name }) => ({ id, name })),
    summary: read.summary,
    warnings: read.warnings,
    hasWorkspace: !!dir,
    asProject: target
  }
}

export async function writeArchiveImport(win: BrowserWindow | null, id: string, choice: ArchiveImportChoice): Promise<ArchiveImportResult> {
  try {
    if (!pendingArchive || pendingArchive.id !== id) throw new Error('A prévia expirou: escolha o zip de novo.')
    const archive = await getArchive()
    const read = archive.readWorkspaceArchive(await readFile(pendingArchive.file), basename(pendingArchive.file))
    if (choice.mode === 'project') {
      const dir = await currentWorkspaceDir()
      const root = await currentRootDir()
      if (!dir || !root) throw new Error('Abra um workspace para acrescentar o zip como projeto.')
      const result = await archive.importArchiveAsProject(read, dir, { id: choice.id, name: choice.name })
      pendingArchive = null
      await setWorkspaceDir(root, result.dir)
      return { ok: true, mode: 'project', dir: result.dir, written: result.written.length, pendingSecrets: result.pendingSecrets, warnings: result.warnings }
    }
    const picked = await showOpen(win, {
      title: `Pasta do workspace "${read.manifest.name}" (vazia)`,
      buttonLabel: 'Abrir o zip aqui',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, reason: 'canceled' }
    const result = await archive.importArchiveAsWorkspace(read, picked.filePaths[0])
    pendingArchive = null
    const { dir, content } = await foldersFor(result.dir)
    await setWorkspaceDir(dir, content)
    return { ok: true, mode: 'workspace', dir: result.dir, written: result.written.length, pendingSecrets: result.pendingSecrets, warnings: result.warnings }
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message }
  }
}

/** Arquivo para o corpo (binário, campo do multipart) ou para uma CA extra; o caminho absoluto. */
export async function pickFile(win: BrowserWindow | null, purpose: 'body' | 'ca'): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: purpose === 'ca' ? 'Escolher certificado da CA (PEM)' : 'Escolher arquivo do corpo',
    properties: ['openFile'],
    ...(purpose === 'ca' && { filters: [{ name: 'Certificado PEM', extensions: ['pem', 'crt', 'cer'] }, { name: 'Todos', extensions: ['*'] }] })
  }
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return picked.canceled ? null : (picked.filePaths[0] ?? null)
}

/** Configurações do cliente HTTP (proxy, TLS, cookies): salvar já vale para a próxima requisição. */
export async function getHttpSettings(): Promise<HttpSettings> {
  return (await getHttpSettingsModule()).getHttpSettings()
}

export async function setHttpSettings(input: unknown): Promise<HttpSettings> {
  const mod = await getHttpSettingsModule()
  const saved = await mod.setHttpSettings(input)
  if (http) (await http).configure(await mod.httpClientConfig())
  return saved
}

export async function listCookies(): Promise<CookieEntry[]> {
  return (await getHttpSettingsModule()).listCookies()
}

export async function setCookie(input: unknown): Promise<CookieEntry[]> {
  return (await getHttpSettingsModule()).setCookie(input)
}

export async function deleteCookies(filter: unknown): Promise<CookieEntry[]> {
  return (await getHttpSettingsModule()).deleteCookies(filter)
}

/** Salvar resposta em arquivo: o nome sugerido vira só um nome de arquivo, sem pastas. */
export async function saveResponse(win: BrowserWindow | null, input: ResponseSaveInput): Promise<ResponseSaveResult> {
  try {
    const fileName = basename(input.fileName.replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]+/g, '-').slice(0, 120) || 'resposta'
    const options: SaveDialogOptions = {
      title: 'Salvar resposta',
      buttonLabel: 'Salvar',
      defaultPath: join(app.getPath('downloads'), fileName)
    }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, reason: 'canceled' }
    await writeFile(picked.filePath, Buffer.from(input.data, input.encoding))
    return { ok: true, path: picked.filePath }
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message }
  }
}

/**
 * Git Workspace. O módulo (git pelo executável do sistema e o vault
 * de segredos) é carregado no primeiro uso do painel Git, fora do cold start.
 * A pasta aberta é lembrada em userData/workspace.json.
 */
let workspaceDir: string | null = null
/**
 * Pasta do conteúdo (conectores, fluxos, ambientes, docs) quando não é a do Git: um projeto do
 * workspace (docs/git-workspace.md, Projetos) ou um workspace com projetos dentro de um
 * repositório maior. null: o conteúdo é a própria pasta do workspace.
 */
let contentDir: string | null = null
/** Leitura de workspace.json, uma só: chamadas simultâneas no boot esperam a mesma. */
let workspaceLoading: Promise<string | null> | null = null

const getWorkspace = () => import('./workspace')
const workspaceFile = () => join(app.getPath('userData'), 'workspace.json')

async function setWorkspaceDir(dir: string, content: string | null = null): Promise<void> {
  catalog = null
  const nextContent = content && content !== dir ? content : null
  const changed = workspaceDir !== dir || contentDir !== nextContent
  workspaceDir = dir
  contentDir = nextContent
  workspaceLoading = Promise.resolve(dir)
  // O mock serve o workspace aberto: trocar de pasta reinicia o engine na nova.
  if (changed && engine) void setSecretEngine(false).then(() => setSecretEngine(true))
  if (changed && mcp) void setMcpServer(false).then(() => setMcpServer(true))
  if (changed && webhooks) void setWebhookServer(false).then(() => setWebhookServer(true))
  if (changed && mock) void setMockServer(false).then(() => setMockServer(true))
  // As conexões abertas usam o conector e os segredos da pasta anterior.
  if (changed) closeAllRealtime()
  // Outra pasta pode declarar outra organização (ou nenhuma): a política do agente reabre.
  if (changed) {
    appAgent = null
    void applyWorkspaceOrganization().then(() => connectFeaturePolicy())
  }
  await writeFile(workspaceFile(), `${JSON.stringify({ dir, ...(contentDir && { content: contentDir }) })}\n`).catch((err) =>
    console.error('Falha ao lembrar o workspace:', err)
  )
  void ensureWatcher()
}

/**
 * O que uma gravação do app deixou para trás e o `vvpost validate` reprova (diretiva quebrada no
 * documento do projeto, corpo padrão fora do bodySchema): o mesmo aviso que o MCP devolve ao
 * agente. Só o que a gravação causou: o estado de antes é lido antes de gravar.
 */
const problemListeners = new Set<(problems: string[]) => void>()

export function onWriteProblems(listener: (problems: string[]) => void): () => void {
  problemListeners.add(listener)
  return () => void problemListeners.delete(listener)
}

async function problemsOf(dir: string): Promise<string[]> {
  const [{ writeProblems }, connectors, flows] = await Promise.all([import('@vvpost/core/docs/write-check'), getConnectors(), getFlows()])
  return writeProblems(await connectors.loadWorkspace(dir), await flows.loadFlows(dir))
}

async function reportNewProblems<T>(dir: string, write: () => Promise<T>): Promise<T> {
  const before = problemListeners.size ? await problemsOf(dir).catch(() => null) : null
  const value = await write()
  if (before) {
    void problemsOf(dir)
      .then((after) => {
        const fresh = after.filter((p) => !before.includes(p))
        if (fresh.length) for (const listener of problemListeners) listener(fresh)
      })
      .catch(() => undefined)
  }
  return value
}

/**
 * Arquivos do workspace mudados no disco por quem quer que seja (o MCP de um agente, o CLI, um
 * editor, o Git): o catálogo em memória cai e as abas abertas releem. O watcher começa na primeira
 * leitura do catálogo, fora do cold start, e acompanha a troca de pasta.
 */
const fileListeners = new Set<(change: WorkspaceFilesChange) => void>()
let watcher: { root: string; handle: WorkspaceWatcher } | null = null

export function onWorkspaceFilesChanged(listener: (change: WorkspaceFilesChange) => void): () => void {
  fileListeners.add(listener)
  return () => void fileListeners.delete(listener)
}

async function ensureWatcher(): Promise<void> {
  const root = await currentRootDir()
  if (!root || !fileListeners.size || watcher?.root === root) return
  watcher?.handle.close()
  watcher = {
    root,
    handle: watchWorkspace(root, (files) => {
      catalog = null
      // Relativos à pasta do conteúdo, como as abas os conhecem: o Compartilhado de um projeto sai com "../".
      const content = contentDir ?? root
      const change = { files: files.map((f) => relative(content, join(root, f)).split(sep).join('/')) }
      for (const listener of fileListeners) listener(change)
    })
  }
}

/** Benchmark (src/main/bench.ts): abre um workspace temporário sem o diálogo de pasta. */
export const useWorkspaceForBench = (dir: string): Promise<void> => setWorkspaceDir(dir)

/** A pasta do conteúdo: o projeto escolhido, ou a pasta do workspace. É a de quase tudo, menos do Git. */
async function currentWorkspaceDir(): Promise<string | null> {
  const root = await currentRootDir()
  return root && (contentDir ?? root)
}

/** A pasta do workspace aberto, a do Git (estado, commits, branches). */
async function currentRootDir(): Promise<string | null> {
  // Uma promessa compartilhada: antes, a segunda chamada do boot (o shell junto com o módulo)
  // via a leitura em andamento como concluída e voltava sem workspace.
  workspaceLoading ??= readFile(workspaceFile(), 'utf8')
    .then((text) => {
      const saved = JSON.parse(text) as { dir?: unknown; content?: unknown }
      if (typeof saved.dir === 'string' && workspaceDir === null) {
        workspaceDir = saved.dir
        // Um projeto que sumiu (apagado, outra branch) volta para a pasta do workspace.
        if (typeof saved.content === 'string' && saved.content !== saved.dir && existsSync(saved.content)) contentDir = saved.content
      }
      return workspaceDir
    })
    // Primeiro uso, ou arquivo ilegível: começa sem workspace.
    .catch(() => workspaceDir)
  await workspaceLoading
  return workspaceDir
}

/** Erros do Git e do disco voltam como mensagem para o painel. */
async function attempt<T>(task: () => Promise<T>): Promise<WorkspaceResult<T>> {
  try {
    return { ok: true, value: await task() }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/**
 * Roda a operação do Git no workspace aberto (na pasta do repositório). `content` é a pasta do
 * conteúdo, para o que grava segredos e ambientes; o estado devolvido conta os segredos dela.
 */
function inWorkspace<T>(task: (ws: typeof import('./workspace'), dir: string, content: string) => Promise<T>) {
  return attempt(async () => {
    const dir = await currentRootDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    // Segredos, branch ou pull mudam os arquivos que o Quick Request usa.
    catalog = null
    const ws = await getWorkspace()
    const content = contentDir ?? dir
    const result = await task(ws, dir, content)
    return content !== dir ? ws.withContentSecrets(result, content) : result
  })
}

export async function getWorkspaceInfo(): Promise<WorkspaceInfo | null> {
  const dir = await currentRootDir()
  if (!dir) return null
  const info: WorkspaceInfo = { dir, name: basename(dir), branch: await readBranch(dir) }
  const { projectLayout } = await import('@vvpost/core/projects')
  const layout = projectLayout(contentDir ?? dir)
  if (!layout.projects.length) return info
  return {
    ...info,
    projects: {
      root: layout.root,
      list: layout.projects.map(({ id, name, description }) => ({ id, name, ...(description && { description }) })),
      current: layout.current?.id ?? null
    }
  }
}

/** A pasta escolhida no diálogo: a do Git e, num projeto ou num workspace com projetos, a do conteúdo. */
async function foldersFor(picked: string): Promise<{ dir: string; content: string | null }> {
  const ws = await getWorkspace()
  const { enclosingProjectDir, projectLayout } = await import('@vvpost/core/projects')
  const repo = await ws.resolveWorkspaceDir(picked)
  const project = enclosingProjectDir(picked)
  // Sem Git, a pasta do workspace é a raiz dos projetos, não o projeto escolhido.
  const dir = repo === picked && project ? projectLayout(project).root : repo
  if (project) return { dir, content: project }
  if (picked !== dir && projectLayout(picked).projects.length) return { dir, content: picked }
  return { dir, content: null }
}

/**
 * Troca o projeto aberto no workspace (null: o Compartilhado, na raiz). Recarrega o catálogo e os
 * servidores locais, como trocar de pasta.
 */
export function switchProject(id: unknown): Promise<WorkspaceResult<WorkspaceInfo | null>> {
  return attempt(async () => {
    const dir = await currentRootDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const { projectDir, projectLayout } = await import('@vvpost/core/projects')
    const root = projectLayout(contentDir ?? dir).root
    await setWorkspaceDir(dir, id === null ? root : projectDir(root, String(id)))
    return getWorkspaceInfo()
  })
}

/** Cria um projeto no workspace (subpasta com vvpost.project.json) e já abre nele. */
export function createWorkspaceProject(input: unknown): Promise<WorkspaceResult<WorkspaceInfo | null>> {
  return attempt(async () => {
    const dir = await currentRootDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const { name, description } = (input ?? {}) as { name?: unknown; description?: unknown }
    if (typeof name !== 'string' || !name.trim()) throw new Error('Dê um nome ao projeto.')
    const { createProject } = await import('./workspace/projects')
    const { projectLayout } = await import('@vvpost/core/projects')
    const folder = await createProject(projectLayout(contentDir ?? dir).root, name.trim(), typeof description === 'string' ? description.trim() : undefined)
    await setWorkspaceDir(dir, folder)
    return getWorkspaceInfo()
  })
}

/** Lê a branch direto de .git/HEAD (também em worktrees, onde .git é um arquivo `gitdir:`). */
async function readBranch(dir: string): Promise<string | null> {
  try {
    let gitDir = join(dir, '.git')
    const pointer = await readFile(gitDir, 'utf8').catch(() => null)
    const match = pointer?.match(/^gitdir:\s*(.+)$/m)
    if (match) gitDir = resolve(dir, match[1]!.trim())
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null
  } catch {
    return null
  }
}

export function getSecretInventory(): Promise<WorkspaceResult<SecretInventory | null>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) return null
    const { secretInventory } = await import('./workspace/vault')
    return secretInventory(dir)
  })
}

export function getWorkspaceState(): Promise<WorkspaceResult<WorkspaceState | null>> {
  return attempt(async () => {
    const dir = await currentRootDir()
    if (!dir) return null
    const ws = await getWorkspace()
    try {
      return await ws.withContentSecrets(await ws.readState(dir), contentDir ?? dir)
    } catch (err) {
      // A pasta lembrada sumiu (apagada, disco removido): volta para a tela inicial.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  })
}

export function openWorkspace(win: BrowserWindow | null): Promise<WorkspaceResult<WorkspaceState | null>> {
  return attempt(async () => {
    const picked = await showOpen(win, {
      title: 'Abrir workspace',
      buttonLabel: 'Abrir',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const ws = await getWorkspace()
    const { dir, content } = await foldersFor(picked.filePaths[0])
    await setWorkspaceDir(dir, content)
    return ws.withContentSecrets(await ws.readState(dir), content ?? dir)
  })
}

export function cloneWorkspace(win: BrowserWindow | null, url: string): Promise<WorkspaceResult<WorkspaceState | null>> {
  return attempt(async () => {
    const ws = await getWorkspace()
    const picked = await showOpen(win, {
      title: `Clonar ${ws.repoNameFromUrl(url)} em…`,
      buttonLabel: 'Clonar aqui',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const dir = await ws.cloneInto(picked.filePaths[0], url)
    await setWorkspaceDir(dir)
    return ws.readState(dir)
  })
}

export const initWorkspace = () => inWorkspace((ws, dir) => ws.initRepository(dir))

const getTemplates = () => import('./workspace/templates')

export const listProjectTemplates = async (): Promise<ProjectTemplate[]> => (await getTemplates()).PROJECT_TEMPLATES

export function createProject(
  win: BrowserWindow | null,
  template: unknown,
  git: boolean
): Promise<WorkspaceResult<WorkspaceState | null>> {
  return attempt(async () => {
    const templates = await getTemplates()
    if (!templates.isProjectTemplate(template)) throw new Error('Modelo de projeto desconhecido.')
    const picked = await showOpen(win, {
      title: 'Pasta do projeto novo (vazia)',
      buttonLabel: 'Criar o projeto aqui',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const dir = picked.filePaths[0]
    await templates.createFromTemplate(dir, template)
    const ws = await getWorkspace()
    // Dentro de um repositório que já existe (monorepo), o projeto entra nele em vez de aninhar outro.
    const state = await ws.readState(dir)
    await setWorkspaceDir(dir)
    return git && !state.isRepo ? ws.initRepository(dir) : state
  })
}

export const diffWorkspaceFile = (path: string): Promise<WorkspaceResult<FileDiff>> =>
  inWorkspace((ws, dir) => ws.diffFile(dir, path))

export const saveWorkspaceSecrets = (values: { environmentId: string; variable: string; value: string }[]) =>
  inWorkspace((ws, dir, content) => ws.saveSecrets(content, values, dir))

/** Um segredo trocado muda credenciais: o cache de tokens da auth headless é descartado. */
export const replaceWorkspaceSecret = (value: { environmentId: string; variable: string; value: string }) =>
  inWorkspace(async (ws, dir, content) => {
    const state = await ws.replaceSecret(content, value, dir)
    auth?.clear()
    return state
  })

export const setEnvironmentVariable = (input: { environmentId: string; name: string; value: string | number | boolean }) =>
  inWorkspace((ws, _dir, content) => ws.setEnvironmentVariable(content, input))

export const commitWorkspace = (message: string, paths: string[]): Promise<WorkspaceResult<GitCommitOutcome>> =>
  inWorkspace((ws, dir) => ws.commitPaths(dir, message, paths))

/**
 * Hook de pre-commit com o leak guard: commits do terminal ou da IDE passam pela mesma
 * conferência do commit pelo app. Sem `vvpost` no PATH, o hook roda o CLI deste app.
 */
export const installCommitHook = () =>
  inWorkspace(async (_ws, dir) => {
    const { installPreCommitHook } = await import('./workspace/commit-guard')
    return installPreCommitHook(dir, [process.execPath, join(__dirname, 'cli.js')])
  })

export const checkoutBranch = (name: string) => inWorkspace((ws, dir) => ws.checkout(dir, name))

export const createBranch = (name: string) => inWorkspace((ws, dir) => ws.createBranch(dir, name))

export const syncWorkspace = (action: GitSyncAction) => inWorkspace((ws, dir) => ws.sync(dir, action))

export const readConflict = (path: string): Promise<WorkspaceResult<ConflictFile>> =>
  inWorkspace((ws, dir) => ws.readConflict(dir, path))

export const resolveConflict = (path: string, resolution: ConflictResolution) =>
  inWorkspace((ws, dir) => ws.resolveConflict(dir, path, resolution))

export const finishMerge = () => inWorkspace((ws, dir) => ws.finishMerge(dir))

export const abortMerge = () => inWorkspace((ws, dir) => ws.abortMerge(dir))

/** Conectores e ambientes do workspace aberto, relidos do disco. null sem workspace. */
export function getConnectorCatalog(): Promise<WorkspaceResult<ConnectorCatalog | null>> {
  return attempt(async () => {
    if (!(await currentWorkspaceDir())) return null
    void ensureWatcher()
    return (await getConnectors()).summarizeWorkspace(await loadCatalog({ fresh: true }))
  })
}

/**
 * Bases dos outros projetos do workspace, com id "<projeto>:<id>", para o Flow Studio oferecer
 * no conector de um nó. Vazio fora de um projeto. Lidas só quando o Flow Studio pede.
 */
export function getProjectBases(): Promise<WorkspaceResult<CatalogConnector[]>> {
  return attempt(async () => {
    if (!(await currentWorkspaceDir())) return []
    const mod = await getConnectors()
    const { ws, ids } = await mod.otherProjectBases(await loadCatalog())
    if (!ids.length) return []
    const wanted = new Set(ids)
    return mod.summarizeWorkspace(ws).connectors.filter((c) => wanted.has(c.id))
  })
}

/**
 * Connector Registry e documentação viva: o mesmo catálogo do Quick Request,
 * com a camada de cada arquivo, os *.connector.vvpost.md e os corpos conferidos com o bodySchema.
 */
export function getConnectorRegistry(): Promise<WorkspaceResult<ConnectorRegistry | null>> {
  return attempt(async () => {
    if (!(await currentWorkspaceDir())) return null
    // O que a IA mudou em auth ou destino vem por listAiReview (painel de revisão do Catálogo).
    return (await getConnectors()).buildRegistry(await loadCatalog({ fresh: true }))
  })
}

/** O lint do projeto (lint/index.ts), para o painel do Catálogo. Carregado só quando o painel pede. */
export function lintWorkspace(): Promise<WorkspaceResult<LintReport | null>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) return null
    const result = await (await import('./lint')).lintWorkspace(dir, { ws: await loadCatalog({ fresh: true }) })
    const { drift: _drift, ...report } = result
    return { ...report, findings: result.findings.map(({ pointer: _pointer, path: _path, documentationUrl: _url, ...f }) => f) }
  })
}

/** Corrige os diagramas de arquitetura que o lint achou divergentes (botão do painel Lint). */
export function fixDiagrams(apply: boolean): Promise<WorkspaceResult<DiagramFixReport | null>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) return null
    const ws = await loadCatalog({ fresh: true })
    const lint = await import('./lint')
    const { drift } = await lint.lintWorkspace(dir, { ws, noHistory: true })
    const plan = await (await import('./lint/architecture')).fixDiagrams(dir, drift, { apply, ws })
    return plan
  })
}

/** Alterações da IA pelo MCP aguardando a revisão do usuário (project/review.ts). */
export function listAiReview(): Promise<WorkspaceResult<AiReviewItem[]>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) return []
    const review = await import('./project/review')
    // Fluxos com código ainda não revisado nesta máquina (de antes da marca, ou vindos do Git) também aparecem.
    await review.markUnreviewedFlows(dir)
    // Com a revisão no console, o pedido sai daqui também (a IA pode nem ter chamado o MCP de novo).
    const central = await centralReview(dir)
    const marks = await review.readReviewMarks(dir)
    if (!Object.keys(marks).length) return []
    const [ws, flows] = await Promise.all([loadCatalog({ fresh: true }), (await getFlows()).loadFlows(dir)])
    return Object.entries(marks)
      .map(([key, mark]): AiReviewItem => {
        const flow = key.startsWith('flow:')
        const id = flow ? key.slice('flow:'.length) : key
        const name = flow ? flows.flows.find((f) => f.flow.id === id)?.flow.name : ws.connectors.get(id)?.name
        return {
          key,
          kind: flow ? 'flow' : 'connector',
          id,
          ...(name && { name }),
          at: mark.at,
          ...(mark.reason && { reason: mark.reason }),
          ...(central && { central: true }),
          ...(mark.request !== undefined && { request: mark.request })
        }
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
  })
}

/** O usuário confirmou no app as alterações da IA: sem `keys`, todas. */
export function approveAiReview(keys?: string[]): Promise<WorkspaceResult<string[]>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    if (await centralReview(dir)) {
      throw new Error('POLICY_DENIED: a política do agente da organização manda aprovar no console do Control Plane. O pedido de revisão foi aberto lá.')
    }
    return (await import('./project/review')).clearReviewMarks(dir, keys)
  })
}

/**
 * Política do agente vinda do Control Plane (mcp/central.ts), para o MCP do app e a revisão das
 * alterações da IA. Aberta uma vez, com a conta corporativa do app; null sem Control Plane.
 */
let appAgent: Promise<import('./mcp/central').CentralAgentPolicy | null> | null = null
function appAgentPolicy(): Promise<import('./mcp/central').CentralAgentPolicy | null> {
  appAgent ??= import('./mcp/central').then(async (c) => {
    const log = (line: string) => console.error(`[vvpost-mcp] ${line}`)
    let declared: OrganizationRef | null
    try {
      declared = await workspaceOrganization()
    } catch (err) {
      // Um organization.json inválido não vira "sem política".
      return c.centralAgentPolicy(c.unavailableSession((err as Error).message), log)
    }
    const session = await c
      .openAgentSession({ surface: 'app' }, undefined, declared)
      .catch((err: Error) => c.unavailableSession(`módulo Enterprise: ${err.message}`))
    return session ? c.centralAgentPolicy(session, log) : null
  })
  return appAgent
}

/** A organização que o workspace aberto declara (.vvpost/organization.json): o projeto vence a raiz. */
async function workspaceOrganization(): Promise<OrganizationRef | null> {
  const [dir, root] = await Promise.all([currentWorkspaceDir(), currentRootDir()])
  if (!dir || !root) return null
  return readOrganization([...new Set([dir, root])])
}

let organizationApplied = false

/** Passa ao módulo Enterprise a organização do workspace, para a conta corporativa do app seguir o Control Plane dela. */
export async function applyWorkspaceOrganization(): Promise<void> {
  const declared = await workspaceOrganization().catch((err: Error) => {
    console.error(err.message)
    return null
  })
  // Sem organização declarada agora nem antes, o módulo nem é carregado (fora do caminho do boot).
  if (!declared && !organizationApplied) return
  organizationApplied = declared !== null
  const mod = await loadEnterpriseModule().catch(() => null)
  try {
    mod?.organization?.use(declared)
  } catch (err) {
    console.error((err as Error).message)
  }
}

/**
 * Dados pessoais também para quem usa o app (@vvpost/core/pii-people): com o people.mask do
 * .vvpost/privacy.json ou com piiVisible desligado pela organização (ou VVPOST_DISABLE_FEATURES),
 * o que chega à interface e ao histórico vem mascarado. null: nada a mascarar.
 */
let people: { ws: LoadedWorkspace; policy: boolean; masker: Promise<PiiMasker | null> } | null = null
export async function peopleView(): Promise<PiiMasker | null> {
  let ws: LoadedWorkspace
  try {
    ws = await loadCatalog()
  } catch {
    return null
  }
  const { featureDenial } = await import('@vvpost/core/policy/features')
  const policy = featureDenial('piiVisible') !== null
  if (people?.ws !== ws || people.policy !== policy) {
    const dirs = [ws.dir, ...(ws.root ? [ws.root] : [])]
    const masker = import('@vvpost/core/pii').then((p) =>
      // Um privacy.json inválido não derruba a tela: erra para o lado seguro, com os campos marcados
      // mascarados (sem detecção), e fica no log.
      p.peopleMasker(ws, dirs, policy).catch((err: Error) => (console.error('privacy.json:', err.message), p.peopleMasker(ws, [], true)))
    )
    people = { ws, policy, masker }
  }
  return people.masker
}

/**
 * Recursos desligados pela organização (enterprise/features.ts): a sessão do módulo segue a conta
 * do app e a organização do workspace aberto, e reabre quando o workspace muda. A interface lê o
 * estado no IdentityState e é avisada a cada mudança.
 */
let features: { session: import('./enterprise/control-plane').FeaturePolicySession | null; off?: () => void } | null = null
let featuresOpening: Promise<void> | null = null
export function connectFeaturePolicy(): Promise<void> {
  const run = (featuresOpening ?? Promise.resolve()).then(async () => {
    const f = await import('./enterprise/features')
    let session: import('./enterprise/control-plane').FeaturePolicySession | null
    try {
      session = await f.openFeaturePolicy({ surface: 'app' }, undefined, await workspaceOrganization())
    } catch (err) {
      // Um organization.json inválido não vira "sem política".
      session = f.unavailableFeatures((err as Error).message)
    }
    const previous = features
    const changed = () => {
      enforceFeatures()
      refreshIdentity()
    }
    features = { session, ...(session?.onChange && { off: session.onChange(changed) }) }
    f.applyFeaturePolicy(session)
    previous?.off?.()
    await previous?.session?.close().catch(() => undefined)
    changed()
  })
  featuresOpening = run.catch((err: Error) => console.error('Política de recursos:', err.message))
  return featuresOpening
}

/** O que estava ligado e a política acabou de desligar para (servidores locais e conexões realtime). */
function enforceFeatures(): void {
  if (mcp && featureDenial('mcp')) void setMcpServer(false)
  if (mock && featureDenial('mockServer')) void setMockServer(false)
  if (webhooks && featureDenial('webhooks')) void setWebhookServer(false)
  if (engine && engineState.mode !== 'enterpriseProxy' && featureDenial('secretEmulator')) void setSecretEngine(false)
  if (realtime.size && featureDenial('protocols')) closeAllRealtime()
}

/** A revisão é aprovada no console (ou, sem a política, não pode ser aprovada aqui). Abre o pedido. */
async function centralReview(dir: string): Promise<boolean> {
  const central = await appAgentPolicy()
  if (!central) return false
  const { effectiveAgentPolicy } = await import('./mcp/central')
  if (!effectiveAgentPolicy({}, central.state()).centralReview) return false
  await central.syncReviews(dir)
  return true
}

/** Documentação rica (core/docs): outro chunk sob demanda, como o registry. */
const getDocs = () => import('@vvpost/core/docs')

/** O modelo do projeto e o logo; um logo que não dá para ler vira problema, não erro. */
async function docsTemplate(dir: string, config?: DocsConfig) {
  const docs = await getDocs()
  const project = await docs.loadDocsProject(dir)
  const use = config ?? project.config
  const issues = [...project.configIssues]
  let logo: string | undefined
  if (use.logo) {
    try {
      logo = await docs.readDocsLogo(dir, use.logo)
    } catch (err) {
      issues.push({ file: use.logo, message: (err as Error).message })
    }
  }
  return { project, config: use, logo, issues }
}

async function generateDocsFor(scope: DocScope, generated = false, diagramOrigins = false): Promise<GeneratedDocs & { ws: LoadedWorkspace }> {
  const dir = await currentWorkspaceDir()
  if (!dir) throw new Error('Nenhum workspace aberto.')
  const [docs, flows] = await Promise.all([getDocs(), getFlows()])
  const ws = await loadCatalog({ fresh: true })
  const flowCatalog = await flows.loadFlows(dir)
  const options = { generator: `VVPost ${app.getVersion()}` }
  const result = await docs.generateDocumentation(ws, flowCatalog, scope, options)
  const { project, logo } = await docsTemplate(dir)
  // O documento do projeto (docs/projeto.md) é a documentação do projeto quando existe.
  const composed =
    scope.kind === 'project' && project.source !== null && !generated
      ? await docs.composeDocumentation(ws, flowCatalog, {
          ...options,
          source: project.source,
          sourceFile: project.sourceFile,
          config: project.config,
          diagramOrigins
        })
      : undefined
  return { ...result, template: { config: project.config, ...(logo && { logo }) }, ...(composed && { composed }), ws }
}

/** Documentação de um nível da hierarquia: o modelo para a visualização e o Markdown. */
export function generateDocs(scope: DocScope): Promise<WorkspaceResult<GeneratedDocs>> {
  return attempt(async () => {
    // Na tela, cada diagrama escrito sai com a origem, para o botão Editar gravar no lugar certo.
    const { ws: _ws, ...docs } = await generateDocsFor(scope, false, true)
    return docs
  })
}

const docsFileName = (title: string, ext: string) =>
  `${title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'documentacao'}.${ext}`

async function askDocsPath(win: BrowserWindow | null, title: string, ext: 'md' | 'pdf'): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: ext === 'md' ? 'Salvar documentação em Markdown' : 'Salvar documentação em PDF',
    buttonLabel: 'Salvar',
    defaultPath: join(app.getPath('documents'), docsFileName(title, ext)),
    filters: [ext === 'md' ? { name: 'Markdown', extensions: ['md'] } : { name: 'PDF', extensions: ['pdf'] }]
  }
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return picked.canceled || !picked.filePath ? null : picked.filePath
}

/** Grava o .md gerado de novo no main (o conteúdo não vem do renderer). */
export async function saveDocsMarkdown(win: BrowserWindow | null, scope: DocScope, generated = false): Promise<DocsSaveResult> {
  try {
    const { document, markdown, composed } = await generateDocsFor(scope, generated)
    const path = await askDocsPath(win, composed?.title ?? document.title, 'md')
    if (!path) return { ok: false, reason: 'canceled' }
    await writeFile(path, composed?.markdown ?? markdown)
    return { ok: true, path }
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message }
  }
}

/**
 * Página de impressão no formato do modelo, conferida contra os segredos do workspace: o HTML
 * vem do renderer (Markdown sanitizado e diagramas em SVG), o estilo, a capa, o cabeçalho e o
 * rodapé vêm do modelo, lido aqui.
 */
async function printableDocs(title: string, html: string, cover: boolean, config?: DocsConfig) {
  const pdf = await import('./docs/pdf')
  if (Buffer.byteLength(html) > pdf.MAX_PDF_HTML_BYTES) throw new Error('documento grande demais para o PDF')
  const dir = await currentWorkspaceDir()
  if (!dir) throw new Error('Nenhum workspace aberto.')
  const [{ createSecretSanitizer }, { printLayout }, ws, template] = await Promise.all([
    import('@vvpost/core/sanitizer'),
    import('@vvpost/core/docs/theme'),
    loadCatalog({ fresh: true }),
    docsTemplate(dir, config)
  ])
  const sanitizer = createSecretSanitizer()
  sanitizer.addWorkspace(ws)
  const layout = printLayout(
    template.config,
    { title, project: basename(dir), date: new Date().toLocaleDateString('pt-BR'), ...(template.logo && { logo: template.logo }) },
    { cover: cover && template.config.cover !== false }
  )
  const page = pdf.printDocument(title, html, layout)
  if (sanitizer.leaks(page.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, '')) || sanitizer.leaks(title)) {
    throw new Error('o documento teria o valor de uma credencial; nada foi gravado')
  }
  return { page, layout, pdf }
}

/**
 * PDF da visualização, no formato do modelo do projeto: o renderer manda o HTML do documento
 * (Markdown sanitizado e os diagramas já em SVG), conferido aqui contra os segredos do workspace
 * antes de imprimir. `cover`: o documento do projeto, com a capa do modelo.
 */
export async function saveDocsPdf(win: BrowserWindow | null, title: string, html: string, cover = false): Promise<DocsSaveResult> {
  try {
    const { page, layout, pdf } = await printableDocs(title, html, cover)
    const path = await askDocsPath(win, title, 'pdf')
    if (!path) return { ok: false, reason: 'canceled' }
    await writeFile(path, await pdf.htmlToPdf(page, layout))
    return { ok: true, path }
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message }
  }
}

/** Rascunho do editor vindo do renderer: o modelo validado pelo schema e o texto. */
async function parseDocsDraft(draft: unknown): Promise<DocsDraft> {
  const d = draft as Partial<DocsDraft> | null
  if (!d || typeof d !== 'object' || typeof d.source !== 'string') throw new Error('rascunho de documentação inválido')
  if (Buffer.byteLength(d.source) > 1024 * 1024) throw new Error('o documento passa de 1 MB')
  return { config: (await getDocs()).parseDocsConfig(d.config), source: d.source }
}

/** Modelo, documento-fonte e arquivos do workspace para o editor de documentação. */
export function docsProject(): Promise<WorkspaceResult<DocsProjectState>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const docs = await getDocs()
    const [{ project, logo, issues }, files, templates] = await Promise.all([
      docsTemplate(dir),
      docs.listDocsFiles(dir),
      docs.listDocTemplates(dir, userDocTemplatesDir())
    ])
    return {
      config: project.config,
      ...(logo && { logo }),
      configExists: project.configExists,
      configIssues: [...issues, ...templates.issues],
      sourceFile: project.sourceFile,
      source: project.source,
      starter: docs.DOCS_STARTER_SOURCE,
      markdownFiles: files.markdown,
      imageFiles: files.images,
      diagramFiles: files.diagrams,
      directives: [...docs.DOC_DIRECTIVES],
      templates: templates.templates.map(templateSummary)
    }
  })
}

/**
 * Grava o modelo (vvpost.docs.json) e o documento-fonte. Os dois vão para o Git: nada com
 * valor de segredo do workspace é gravado.
 */
export function saveDocsProject(draft: unknown): Promise<WorkspaceResult<{ files: string[] }>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const draftValue = await parseDocsDraft(draft)
    const [docs, ws] = await Promise.all([getDocs(), loadCatalog({ fresh: true })])
    const { files } = await docs.writeDocsProject(ws, draftValue)
    return { files }
  })
}

/** Modelos de documentação do usuário: valem em todo projeto aberto neste computador. */
const userDocTemplatesDir = () => join(app.getPath('userData'), 'doc-templates')

const templateSummary = (t: { id: string; name: string; description: string; origin: DocTemplateSummary['origin']; file?: string }): DocTemplateSummary => ({
  id: t.id,
  name: t.name,
  description: t.description,
  origin: t.origin,
  ...(t.file && { file: t.file })
})

/** Rascunho que um modelo dá ao projeto, mantendo o que identifica o projeto. */
export function applyDocsTemplate(id: string, current: unknown): Promise<WorkspaceResult<DocsDraft>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const docs = await getDocs()
    const { templates } = await docs.listDocTemplates(dir, userDocTemplatesDir())
    const template = templates.find((t) => t.id === id)
    if (!template) throw new Error(`modelo "${id}" não existe`)
    return docs.applyDocTemplate(template, docs.parseDocsConfig(current))
  })
}

/** Grava o documento atual como modelo próprio, no projeto ou na pasta do usuário. */
export function saveDocsTemplate(input: unknown): Promise<WorkspaceResult<DocTemplateSummary>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const i = input as Partial<DocsTemplateInput> | null
    if (!i || typeof i !== 'object' || (i.origin !== 'project' && i.origin !== 'user')) throw new Error('modelo inválido')
    const [docs, ws] = await Promise.all([getDocs(), loadCatalog({ fresh: true })])
    const saved = await docs.saveDocTemplate(
      ws,
      { name: String(i.name ?? ''), ...(typeof i.description === 'string' && { description: i.description }), config: i.config, source: String(i.source ?? '') },
      i.origin === 'user' ? { origin: 'user', dir: userDocTemplatesDir() } : { origin: 'project' }
    )
    return templateSummary(saved)
  })
}

/** Ícones e blocos dos plugins ligados para o editor de diagramas (só dados; nenhum processo sobe). */
export const diagramCatalog = (): Promise<WorkspaceResult<DiagramCatalog>> => attempt(async () => (await getPlugins()).diagramCatalog())

/** Um diagrama .mmd do workspace, para o editor de diagramas. */
export function readDiagram(file: unknown): Promise<WorkspaceResult<string>> {
  return attempt(async () => {
    const [docs, ws] = await Promise.all([getDocs(), loadCatalog({ fresh: true })])
    return docs.readDiagram(ws, String(file ?? ''))
  })
}

/**
 * Grava um diagrama do editor onde ele vive (bloco ```mermaid de um Markdown ou arquivo .mmd),
 * conferindo que nada mudou desde a abertura. Recusa segredo e caminho fora do workspace.
 */
export function saveDiagram(input: unknown): Promise<WorkspaceResult<{ file: string; line?: number }>> {
  return attempt(async () => {
    const i = input as Partial<DiagramSaveInput> | null
    if (!i || typeof i !== 'object' || typeof i.file !== 'string' || typeof i.code !== 'string') throw new Error('diagrama inválido')
    const [docs, ws] = await Promise.all([getDocs(), loadCatalog({ fresh: true })])
    return docs.writeDiagram(ws, {
      file: i.file,
      code: i.code,
      ...(typeof i.line === 'number' && { line: i.line }),
      ...(typeof i.previous === 'string' && { previous: i.previous }),
      ...(i.create === true && { create: true })
    })
  })
}

/** Documentos .md e diagramas .mmd do workspace, para o explorador (sem modelos nem logo). */
export function docsFiles(): Promise<WorkspaceResult<DocsFileList>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const docs = await getDocs()
    const [files, project] = await Promise.all([docs.listDocsFiles(dir), docs.loadDocsProject(dir)])
    return { markdown: files.markdown.map((f) => f.file), diagrams: files.diagrams, sourceFile: project.sourceFile }
  })
}

// "Enviar para…": o pacote e o plano ficam no main; o publicador vem do módulo Enterprise.
let publishService: Promise<ReturnType<typeof import('./docs/publish').createPublishService>> | null = null
function publishing() {
  publishService ??= Promise.all([import('./docs/publish'), import('./docs/svg-png'), import('./docs/publisher-credentials')]).then(([m, png, creds]) =>
    m.createPublishService({
      dir: currentWorkspaceDir,
      workspace: () => loadCatalog({ fresh: true }),
      flows: async (dir) => (await getFlows()).loadFlows(dir),
      openExternal: (url) => shell.openExternal(url),
      svgToPng: png.svgToPng,
      pluginExporters: async () => (await getPlugins()).exporters(),
      pluginPublishers: async () => (await getPlugins()).publishers(),
      // O cliente do app (proxy e CA da pessoa), fora do histórico: a publicação não é um disparo.
      send: async (input) => (await getHttp()).send(input),
      cancel: (id) => void getHttp().then((h) => h.cancel(id)),
      credentials: creds.vaultCredentials(join(app.getPath('userData'), 'publishers'))
    })
  )
  return publishService
}

const publishText = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')

export function publishTargets(): Promise<WorkspaceResult<PublishTargetsState>> {
  return attempt(async () => (await publishing()).targets())
}

export function publishInit(provider: unknown, destination: unknown): Promise<WorkspaceResult<{ file: string }>> {
  return attempt(async () => (await publishing()).init(publishText(provider), publishText(destination, 500)))
}

export function publishSignIn(target: unknown, credential?: unknown): Promise<WorkspaceResult<PublisherSession>> {
  return attempt(async () => (await publishing()).signIn(publishText(target), publishText(credential, 4096) || undefined))
}

export function publishSignOut(target: unknown): Promise<WorkspaceResult<void>> {
  return attempt(async () => (await publishing()).signOut(publishText(target)))
}

export function publishPrepare(target: unknown): Promise<WorkspaceResult<PublishPrepared>> {
  return attempt(async () => (await publishing()).prepare(publishText(target)))
}

export function publishPlan(id: unknown, images: unknown): Promise<WorkspaceResult<PublishPlan>> {
  return attempt(async () => {
    const list = Array.isArray(images)
      ? images.filter((i): i is { id: string; svg: string } => typeof i?.id === 'string' && typeof i?.svg === 'string')
      : []
    return (await publishing()).plan(publishText(id), list)
  })
}

export function publishApply(id: unknown, approval: unknown): Promise<WorkspaceResult<PublishApplied>> {
  return attempt(async () => (await publishing()).apply(publishText(id), (approval ?? {}) as PublishApproval))
}

/** Um documento .md do workspace, para a aba de documento. */
export function readMarkdownFile(file: unknown): Promise<WorkspaceResult<string>> {
  return attempt(async () => {
    const [docs, ws] = await Promise.all([getDocs(), loadCatalog({ fresh: true })])
    return docs.readMarkdownFile(ws, String(file ?? ''))
  })
}

/** Grava um .md da aba de documento. Recusa segredo, caminho fora do workspace e mudança feita fora. */
export function saveMarkdownFile(input: unknown): Promise<WorkspaceResult<{ file: string }>> {
  return attempt(async () => {
    const i = input as Partial<MarkdownSaveInput> | null
    if (!i || typeof i !== 'object' || typeof i.file !== 'string' || typeof i.text !== 'string') throw new Error('documento inválido')
    const [docs, ws] = await Promise.all([getDocs(), loadCatalog({ fresh: true })])
    return docs.writeMarkdownFile(ws, {
      file: i.file,
      text: i.text,
      ...(typeof i.previous === 'string' && { previous: i.previous }),
      ...(i.create === true && { create: true })
    })
  })
}

/** Renomeia ou move um .md/.mmd pelo explorador. */
export function renameDocsFile(input: unknown): Promise<WorkspaceResult<{ file: string }>> {
  return attempt(async () => {
    const i = input as { from?: unknown; to?: unknown } | null
    if (!i || typeof i.from !== 'string' || typeof i.to !== 'string') throw new Error('arquivo inválido')
    const [docs, ws] = await Promise.all([getDocs(), loadCatalog({ fresh: true })])
    return docs.renameDocsFile(ws, { from: i.from, to: i.to })
  })
}

/** Exclui um .md/.mmd pelo explorador. */
export function deleteDocsFile(file: unknown): Promise<WorkspaceResult<{ file: string }>> {
  return attempt(async () => {
    if (typeof file !== 'string') throw new Error('arquivo inválido')
    const [docs, ws] = await Promise.all([getDocs(), loadCatalog({ fresh: true })])
    return docs.deleteDocsFile(ws, file)
  })
}

/** Monta o documento do projeto a partir do rascunho do editor, sem gravar nada. */
export function compileDocs(draft: unknown): Promise<WorkspaceResult<DocsCompileResult>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const { config, source } = await parseDocsDraft(draft)
    const [docs, flows] = await Promise.all([getDocs(), getFlows()])
    const ws = await loadCatalog({ fresh: true })
    const composed = await docs.composeDocumentation(ws, await flows.loadFlows(dir), {
      generator: `VVPost ${app.getVersion()}`,
      source,
      sourceFile: docs.normalizeRel(config.source ?? docs.DEFAULT_DOCS_SOURCE),
      config,
      // A prévia do editor liga cada bloco à linha do texto (clique, rolagem e prévias inline).
      sourceMap: true
    })
    // O logo que não dá para ler aparece no log do editor, como os outros problemas.
    if (config.logo) {
      await docs.readDocsLogo(dir, config.logo).catch((err: Error) =>
        composed.diagnostics.push({ file: docs.DOCS_CONFIG_FILE, line: 1, severity: 'warning', message: `logo: ${err.message}` })
      )
    }
    return composed
  })
}

/** PDF da prévia do editor, no formato do rascunho do modelo (com a capa), sem gravar. */
export function previewDocsPdf(config: unknown, title: string, html: string): Promise<WorkspaceResult<Uint8Array>> {
  return attempt(async () => {
    const { page, layout, pdf } = await printableDocs(title, html, true, (await getDocs()).parseDocsConfig(config))
    return new Uint8Array(await pdf.htmlToPdf(page, layout))
  })
}

export function readConnector(connectorId: string): Promise<WorkspaceResult<ConnectorSource>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const source = await (await getConnectors()).readConnectorSource(dir, connectorId)
    return { ...source, version: await connectorVersion(dir, connectorId) }
  })
}

/**
 * Versão do que o editor de conector abriu: o arquivo do conector, ou o fluxo-base e os fluxos de
 * requisição dele. Ao salvar, uma versão diferente quer dizer que alguém gravou no meio.
 */
async function connectorVersion(dir: string, connectorId: string): Promise<string | null> {
  const ws = await (await getConnectors()).loadWorkspace(dir)
  const file = ws.connectorFiles.get(connectorId)
  if (!file) return null
  const flows = ws.flowSources?.get(connectorId) === file
    ? [...ws.flowSources!].filter(([key]) => key === connectorId || key.startsWith(`${connectorId}/`)).map(([, f]) => f)
    : [file]
  return (await import('./workspace/file-version')).filesVersion(flows.map((f) => join(dir, f)))
}

/**
 * Grava o conector editado no app; a cópia em memória é descartada para todos relerem.
 * `expected`: a versão de quando o editor abriu (readConnector); diferente do disco, recusa.
 */
export function saveConnector(connector: Connector, file?: string, expected?: string | null): Promise<WorkspaceResult<{ file: string; version?: string | null }>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    // Pelo arquivo que o editor abriu: o id pode ter mudado na edição.
    const opened = file === undefined ? undefined : [...(await (await getConnectors()).loadWorkspace(dir)).connectorFiles].find(([, f]) => f === file)?.[0]
    if (expected !== undefined && opened !== undefined && (await connectorVersion(dir, opened)) !== expected) {
      throw new Error((await import('./workspace/file-version')).changedOnDisk(`O conector "${connector.name}"`))
    }
    const { saveConnectorInFormat } = await import('./project/save-connector')
    const saved = await reportNewProblems(
      dir,
      async () => (await saveConnectorInFormat(dir, connector, file)) ?? (await (await getConnectors()).saveConnector(dir, connector, file))
    )
    // Salvar no editor é a revisão do usuário das mudanças que a IA fez nesse conector (sem a revisão central).
    if (!(await centralReview(dir))) await (await import('./project/review')).clearReviewMarks(dir, [connector.id])
    catalog = null
    // A auth pode ter mudado: o token em cache não vale mais.
    auth?.clear(connector.id)
    return { ...saved, version: await connectorVersion(dir, connector.id) }
  })
}

export function readSharedSchema(name: string): Promise<WorkspaceResult<SharedSchemaSource>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const ws = await (await getConnectors()).loadWorkspace(dir)
    const s = ws.schemas?.get(name)
    if (!s) throw new Error(`O schema compartilhado "${name}" não existe.`)
    const { versionOf } = await import('./workspace/file-version')
    return {
      name,
      file: s.file,
      schema: s.schema,
      uses: ws.schemaUses?.get(name) ?? [],
      ...(s.shared && { readOnly: s.shared }),
      version: versionOf(await readFile(join(dir, s.file), 'utf8').catch(() => null))
    }
  })
}

/** Grava um schema compartilhado pela camada de escrita do projeto (a mesma do MCP): vale para todos os usos. */
export function saveSharedSchema(name: string, schema: unknown, expected?: string | null): Promise<WorkspaceResult<{ file: string; version: string | null }>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('O schema precisa ser um objeto JSON Schema.')
    const file = `schemas/${name}.schema.json`
    const { applyProjectOps } = await import('./project/apply')
    const result = await reportNewProblems(dir, () =>
      applyProjectOps(dir, [{ op: 'upsertSchema', name, schema: schema as Record<string, unknown> }], {
        actor: 'app',
        ...(expected !== undefined && { expect: { [file]: expected } })
      })
    )
    if (result.conflicts?.length) throw new Error((await import('./workspace/file-version')).changedOnDisk(`O schema "${name}"`))
    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n') || 'O schema não foi gravado.')
    catalog = null
    const { versionOf } = await import('./workspace/file-version')
    return { file, version: versionOf(await readFile(join(dir, file), 'utf8').catch(() => null)) }
  })
}

export async function validateEndpointBody(
  connectorId: string,
  endpointId: string,
  body: string
): Promise<BodyValidation> {
  try {
    return (await getConnectors()).validateEndpointBody(await loadCatalog(), connectorId, endpointId, body)
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** Arquivo de dados dos cenários (CSV ou JSON): lido aqui, as linhas vão para o renderer mostrar e reenviar no lote. */
export async function pickDataFile(win: BrowserWindow | null): Promise<WorkspaceResult<DataFile> | null> {
  const picked = await showOpen(win, {
    title: 'Escolher arquivo de dados',
    buttonLabel: 'Usar nas iterações',
    properties: ['openFile'],
    filters: [{ name: 'CSV ou JSON', extensions: ['csv', 'tsv', 'txt', 'json'] }, { name: 'Todos', extensions: ['*'] }]
  })
  const path = picked.canceled ? undefined : picked.filePaths[0]
  if (!path) return null
  try {
    const [{ dataFormatOf, parseDataFile }, text] = await Promise.all([import('@vvpost/core/scenarios/data'), readFile(path, 'utf8')])
    const { columns, rows } = parseDataFile(text, dataFormatOf(path))
    return { ok: true, value: { name: basename(path), columns, rows } }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

export async function clearAuthCache(connectorId?: string): Promise<void> {
  auth?.clear(connectorId)
}

/** Lotes de cenários em andamento, para o cancelamento alcançar todas as requisições do lote. */
const scenarioRuns = new Map<string, AbortController>()

/**
 * Matriz de cenários: relê o workspace (os cenários são editados nos
 * arquivos) e roda o lote pelo dispatcher e pela auth headless do Quick Request,
 * dividindo o cache de tokens com ele. O lote entra no histórico como uma execução.
 */
export async function runScenarios(input: ScenarioRunInput): Promise<ScenarioRunReport> {
  const controller = new AbortController()
  scenarioRuns.set(input.runId, controller)
  try {
    const [t, mod, core] = await Promise.all([getTraced(), getConnectors(), getCore()])
    const ws = await loadCatalog({ fresh: true }).catch((err: Error) => err)
    const report = await core.runScenarioBatch(input, ws, {
      auth: (auth ??= mod.createAuthEngine(Date.now, AUTH_HOOKS)),
      http: t.http,
      signal: controller.signal,
      plugins: async () => (await getPlugins()).runner()
    })
    const recorded = t.recorder.take(input.runId)
    if (ws instanceof Error) return report
    const name = ws.connectors.get(input.connectorId)?.name
    await saveRun((await getRecord()).scenarioRun(report, recorded, name && `Cenários de ${name}`), t.sanitizer)
    recordActivity({
      at: new Date().toISOString(),
      kind: 'scenarioRun',
      connectorId: report.connectorId,
      environments: [...new Set(report.results.map((r) => r.environmentId))],
      ...report.totals,
      canceled: report.canceled
    })
    return report
  } finally {
    scenarioRuns.delete(input.runId)
  }
}

export async function cancelScenarios(runId: string): Promise<void> {
  scenarioRuns.get(runId)?.abort()
}

/**
 * Flow Studio: o Context Engine e o executor Python são outro chunk,
 * carregado na primeira vez que o painel lista, grava ou roda um fluxo.
 */
const getFlows = () => import('@vvpost/core/flows')
/** Execução de cenários e fluxos dividida com o CLI (core/run.ts), no mesmo chunk sob demanda. */
const getCore = () => import('@vvpost/core/run')
const flowRuns = new Map<string, AbortController>()

export function listFlows(): Promise<WorkspaceResult<FlowCatalog | null>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) return null
    const catalog = await (await getFlows()).loadFlows(dir)
    // A versão de cada arquivo, para o Flow Studio mandar ao salvar (saveFlow `expected`).
    const { diskText, versionOf } = await import('./workspace/file-version')
    const versions = await Promise.all(catalog.flows.map((f) => diskText(join(dir, f.file)).then(versionOf)))
    return { ...catalog, flows: catalog.flows.map((f, i) => ({ ...f, version: versions[i] ?? null })) }
  })
}

/**
 * Grava o fluxo do Flow Studio ou do Quick Request. `expected`: a versão do arquivo de quando a
 * aba abriu (listFlows); se o disco tem outra (a IA ou outra pessoa gravou), recusa em vez de
 * sobrescrever. Devolve a versão nova.
 */
export function saveFlow(flow: Flow, file?: string, expected?: string | null): Promise<WorkspaceResult<{ file: string; version?: string | null }>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const fileVersion = await import('./workspace/file-version')
    if (expected !== undefined && file !== undefined && fileVersion.versionOf(await fileVersion.diskText(join(dir, file))) !== expected) {
      throw new Error(fileVersion.changedOnDisk(`O fluxo "${flow.name}" (${file})`))
    }
    const flows = await getFlows()
    // O arquivo do fluxo vai para o Git: nenhum valor do vault nem credencial digitada no nó.
    const { describeLeaks, findSecretLeaks } = await import('./workspace/leak-guard')
    const target = file ?? `flows/${flow.id}.flow.vvpost.json`
    const leaks = [
      ...(await findSecretLeaks(dir, [{ path: target, content: JSON.stringify(flow) }])),
      ...flows.literalFlowSecrets(flow).map((where) => ({ file: target, reason: `credencial literal no ${where}` }))
    ]
    if (leaks.length) {
      throw new Error(
        describeLeaks(leaks)
          .replace(/^Commit bloqueado/, 'Gravação bloqueada')
          .replace('ou tire o arquivo do commit.', 'ou use {{ $nodes... }} de um nó anterior.')
      )
    }
    const saved = await reportNewProblems(dir, () => flows.saveFlow(dir, flow, file))
    // Salvar no Flow Studio é a revisão do usuário dos nós de código (da IA ou de quem for), sem a revisão central.
    const review = await import('./project/review')
    if (!(await centralReview(dir))) {
      await review.clearReviewMarks(dir, [review.flowReviewKey(flow.id)])
      await review.recordReviewedFlows(dir, [flow])
    }
    return { ...saved, version: fileVersion.versionOf(await fileVersion.diskText(join(dir, saved.file))) }
  })
}

/**
 * Roda o fluxo do canvas pelo dispatcher e pela auth headless do Quick Request
 * (cache de tokens dividido). O progresso de cada nó vai para o renderer por
 * `onEvent`; a execução entra no histórico.
 */
export async function runFlow(input: FlowRunInput, onEvent: (event: FlowRunEvent) => void): Promise<FlowRunReport> {
  const controller = new AbortController()
  flowRuns.set(input.runId, controller)
  try {
    const [t, mod, core] = await Promise.all([getTraced(), getConnectors(), getCore()])
    // Sem workspace o fluxo ainda roda, só sem conectores e ambientes.
    const ws = (await currentWorkspaceDir()) ? await loadCatalog({ fresh: true }).catch((err: Error) => err) : core.emptyWorkspace()
    // Uma base de outro projeto escolhida no canvas e ainda não gravada entra agora.
    if (!(ws instanceof Error) && input.flow) await mod.addFlowProjectRefs(ws, input.flow)
    const report = await core.runFlowWith(input, ws, {
      auth: (auth ??= mod.createAuthEngine(Date.now, AUTH_HOOKS)),
      http: t.http,
      signal: controller.signal,
      onEvent,
      plugins: async () => (await getPlugins()).runner(),
      // O nó webhook liga o servidor sozinho: rodar o fluxo é a ação do usuário.
      webhooks: () => ensureWebhookServer()
    })
    const recorded = t.recorder.take(input.runId)
    if (ws instanceof Error) return report
    const title = input.flow?.name ? `Fluxo ${input.flow.name}` : undefined
    await saveRun((await getRecord()).flowRun(report, recorded, input.environmentId ?? '', title), t.sanitizer)
    recordActivity({ at: new Date().toISOString(), kind: 'flowRun', flowId: report.flowId, outcome: report.outcome, durationMs: report.durationMs })
    return report
  } finally {
    flowRuns.delete(input.runId)
  }
}

export async function cancelFlow(runId: string): Promise<void> {
  flowRuns.get(runId)?.abort()
}

/**
 * Plugin SDK: o gerenciador de plugins é outro chunk, carregado no primeiro
 * uso do Extensions Hub ou de um fluxo com nó de plugin. Os oficiais vêm com o app
 * (pasta plugins/), os do usuário ficam em userData/plugins; o código de cada um só
 * sobe, num processo com sandbox, quando um nó dele roda. Nada é carregado do workspace.
 */
let pluginManager: Promise<PluginManager> | null = null

const getPlugins = () =>
  (pluginManager ??= import('@vvpost/core/plugins').then(
    // No instalador os oficiais ficam fora do app.asar, em resources/plugins.
    (m) => new m.PluginManager(pluginLocations(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.getPath('userData')))
  ))

export const listPlugins = (): Promise<WorkspaceResult<PluginCatalog>> => attempt(async () => (await getPlugins()).catalog())

export const setPluginEnabled = (id: string, enabled: boolean): Promise<WorkspaceResult<PluginCatalog>> =>
  attempt(async () => (await getPlugins()).setEnabled(id, enabled))

export function previewPluginInstall(win: BrowserWindow | null): Promise<WorkspaceResult<PluginInstallPreview | null>> {
  return attempt(async () => {
    const picked = await showOpen(win, {
      title: 'Instalar plugin de uma pasta',
      buttonLabel: 'Ver plugin',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return (await getPlugins()).previewInstall(picked.filePaths[0])
  })
}

export function previewPluginArchive(win: BrowserWindow | null): Promise<WorkspaceResult<PluginInstallPreview | null>> {
  return attempt(async () => {
    const picked = await showOpen(win, {
      title: 'Instalar plugin de um arquivo',
      buttonLabel: 'Ver plugin',
      properties: ['openFile'],
      filters: [{ name: 'Pacote de plugin', extensions: ['zip', 'tgz', 'gz', 'tar'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return (await getPlugins()).previewArchive(picked.filePaths[0])
  })
}

export const previewPluginFromRegistry = (registryUrl: string, pluginId: string, version?: string): Promise<WorkspaceResult<PluginInstallPreview>> =>
  attempt(async () => (await getPlugins()).previewRegistry(registryUrl, pluginId, version))

export const browsePluginRegistries = (): Promise<WorkspaceResult<PluginRegistryListing[]>> => attempt(async () => (await getPlugins()).browseRegistries())

export const addPluginRegistry = (url: string): Promise<WorkspaceResult<PluginCatalog>> => attempt(async () => (await getPlugins()).addRegistry(url))

export const removePluginRegistry = (url: string): Promise<WorkspaceResult<PluginCatalog>> => attempt(async () => (await getPlugins()).removeRegistry(url))

export const trustPluginKey = (publicKey: string, name: string): Promise<WorkspaceResult<PluginCatalog>> =>
  attempt(async () => (await getPlugins()).trustKey(publicKey, name))

export const untrustPluginKey = (publicKey: string): Promise<WorkspaceResult<PluginCatalog>> => attempt(async () => (await getPlugins()).untrustKey(publicKey))

export const installPlugin = (previewId: string, options: { trustKey?: boolean } = {}): Promise<WorkspaceResult<PluginCatalog>> =>
  attempt(async () => (await getPlugins()).install(previewId, options))

export const removePlugin = (id: string): Promise<WorkspaceResult<PluginCatalog>> => attempt(async () => (await getPlugins()).remove(id))

/**
 * Secret Manager Engine, modo Local Mock. Fastify e os emuladores são
 * um chunk carregado só quando o usuário liga o mock na barra de status.
 */
let engine: Promise<RunningEngine> | null = null
let engineState: SecretEngineState = { status: 'off', port: null, environment: null }
/** Modo escolhido no toggle Mock/Proxy, por workspace. Só em memória: o arquivo versionado não muda. */
const engineModeChoice = new Map<string, SecretsEngineMode>()

/** Estado do engine, com o modo que vale ao ligar e se o Cloud Proxy está configurado no workspace. */
export async function getSecretEngineState(): Promise<SecretEngineState> {
  const dir = await currentWorkspaceDir()
  if (!dir) return engineState
  const { readEngineModes } = await import('./secret-engine/modes')
  const modes = await readEngineModes(dir)
  const chosen = engineModeChoice.get(dir)
  const mode = engineState.status === 'running' && engineState.mode ? engineState.mode : (chosen ?? modes.configured)
  return { ...engineState, mode, proxyAvailable: modes.proxy }
}

export async function setSecretEngineMode(mode: unknown): Promise<SecretEngineState> {
  if (mode !== 'localMock' && mode !== 'enterpriseProxy') throw new Error('Modo do Secret Engine inválido.')
  const dir = await currentWorkspaceDir()
  if (!dir) return getSecretEngineState()
  engineModeChoice.set(dir, mode)
  const current = await getSecretEngineState()
  // Ligado em outro modo (ou com erro ao ligar): troca na hora, reiniciando.
  if (engine && engineState.mode !== mode) {
    await setSecretEngine(false)
    await setSecretEngine(true)
  } else if (!engine && current.status === 'error') {
    await setSecretEngine(true)
  }
  return getSecretEngineState()
}

export async function setSecretEngine(enabled: boolean): Promise<SecretEngineState> {
  if (!enabled) {
    const running = engine
    engine = null
    engineState = { status: 'off', port: null, environment: null }
    await running?.then((e) => e.close()).catch(() => undefined)
    if (running) recordActivity({ at: new Date().toISOString(), kind: 'secretEngine', action: 'stop', mode: null })
    return engineState
  }
  if (engine) {
    await engine.catch(() => undefined)
    return engineState
  }
  const dir = await currentWorkspaceDir()
  if (!dir) {
    engineState = { status: 'error', port: null, environment: null, message: 'Abra um workspace no painel Git para ligar o mock.' }
    return engineState
  }
  engineState = { status: 'starting', port: null, environment: null }
  const chosen = engineModeChoice.get(dir)
  const starting = import('./secret-engine/server').then((m) =>
    m.startSecretEngine(dir, { openExternal: (url) => shell.openExternal(url), ...(chosen && { mode: chosen }) })
  )
  engine = starting
  try {
    const running = await starting
    if (engine === starting) engineState = { status: 'running', port: running.port, environment: running.environment, mode: running.mode }
    recordActivity({ at: new Date().toISOString(), kind: 'secretEngine', action: 'start', mode: running.mode })
  } catch (err) {
    if (engine === starting) {
      engine = null
      const e = err as NodeJS.ErrnoException & { port?: number }
      const message = e.code === 'EADDRINUSE' ? `A porta ${e.port ?? 4460} já está em uso.` : e.message
      engineState = { status: 'error', port: null, environment: null, message }
      recordActivity({ at: new Date().toISOString(), kind: 'secretEngine', action: 'startFailed', mode: null })
    }
  }
  return engineState
}

/**
 * Execuções remotas nos Execution Runners: o módulo Enterprise fala com o
 * Control Plane; aqui só se monta o workspace sem segredos e se repassa. Nada carrega
 * antes de o módulo Tests perguntar se há Control Plane.
 */
export async function getRemoteRunTarget(): Promise<RemoteRunTarget | null> {
  try {
    return await (await import('./enterprise/remote-runs')).remoteRunTarget()
  } catch {
    return null
  }
}

const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && x.length <= 200)

async function remoteSelection(selection: unknown): Promise<{ dir: string; selection: RemoteRunSelection }> {
  const s = selection as Partial<RemoteRunSelection> | null
  if (!s || !isIdList(s.environments) || !isIdList(s.connectors) || !isIdList(s.scenarios) || !isIdList(s.flows)) {
    throw new Error('Seleção inválida para a execução remota.')
  }
  const dir = await currentWorkspaceDir()
  if (!dir) throw new Error('Nenhum workspace aberto.')
  return { dir, selection: { environments: s.environments, connectors: s.connectors, scenarios: s.scenarios, flows: s.flows } }
}

export function previewRemoteRun(selection: unknown): Promise<WorkspaceResult<RemoteRunPreview>> {
  return attempt(async () => {
    const { dir, selection: s } = await remoteSelection(selection)
    return (await import('./enterprise/remote-runs')).previewRemoteRun(dir, s)
  })
}

export function startRemoteRun(selection: unknown): Promise<WorkspaceResult<RemoteRun>> {
  return attempt(async () => {
    const { dir, selection: s } = await remoteSelection(selection)
    return (await import('./enterprise/remote-runs')).startRemoteRun(dir, s)
  })
}

const runId = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error('Execução inválida.')
  return v
}

/** Execuções remotas já gravadas no histórico nesta sessão (o renderer consulta até o fim e um pouco depois). */
const recordedRemote = new Set<number>()

export function pollRemoteRun(id: unknown, after: unknown): Promise<WorkspaceResult<RemoteRunPoll>> {
  return attempt(async () => {
    const remote = await import('./enterprise/remote-runs')
    const poll = await remote.pollRemoteRun(runId(id), typeof after === 'number' && Number.isSafeInteger(after) && after > 0 ? after : 0)
    if (remote.isFinal(poll.run.status) && !recordedRemote.has(poll.run.id)) {
      recordedRemote.add(poll.run.id)
      void recordRemoteRun(poll)
    }
    return poll
  })
}

/** O fim de uma execução remota vai para o Histórico, marcado como remoto. */
async function recordRemoteRun(poll: RemoteRunPoll): Promise<void> {
  try {
    const [t, target, ws] = await Promise.all([
      getTraced(),
      getRemoteRunTarget(),
      loadCatalog().catch(() => null)
    ])
    const names = new Map([...(ws?.connectors.values() ?? [])].map((c) => [c.id, c.name]))
    const reports = (poll.report?.scenarios ?? []).filter((r) => r && Array.isArray(r.results))
    const run = (await getRecord()).remoteRun(poll.run, target?.source ?? poll.run.project, reports, names)
    await saveRun(run, t.sanitizer)
  } catch (err) {
    console.error('Falha ao gravar a execução remota no histórico:', err)
  }
}

export function cancelRemoteRun(id: unknown): Promise<WorkspaceResult<RemoteRun>> {
  return attempt(async () => (await import('./enterprise/remote-runs')).cancelRemoteRun(runId(id)))
}

/**
 * Servidor MCP ligado pela barra de status: HTTP/SSE em loopback na
 * porta 4470 ($VVPOST_MCP_PORT), servindo o workspace aberto. É o mesmo chunk do
 * `mcp.js` de linha de comando, carregado só quando o usuário liga.
 */
let mcp: Promise<RunningAppMcp> | null = null
let mcpState: McpServerState = { status: 'off', url: null, workspace: null, token: false }

export function getMcpServerState(): McpServerState {
  return mcpState
}

export async function setMcpServer(enabled: boolean): Promise<McpServerState> {
  const token = process.env['VVPOST_MCP_TOKEN'] || undefined
  if (!enabled) {
    const running = mcp
    mcp = null
    mcpState = { status: 'off', url: null, workspace: null, token: false }
    await running?.then((m) => m.close()).catch(() => undefined)
    if (running) recordActivity({ at: new Date().toISOString(), kind: 'mcpServer', action: 'stop' })
    return mcpState
  }
  if (mcp) {
    await mcp.catch(() => undefined)
    return mcpState
  }
  const dir = await currentWorkspaceDir()
  if (!dir) {
    mcpState = { status: 'error', url: null, workspace: null, token: false, message: 'Abra um workspace no painel Git para ligar o servidor MCP.' }
    return mcpState
  }
  const off = featureDenial('mcp')
  if (off) {
    mcpState = { status: 'error', url: null, workspace: dir, token: false, message: off }
    return mcpState
  }
  const envPort = process.env['VVPOST_MCP_PORT']
  const port = envPort ? Number(envPort) : undefined
  mcpState = { status: 'starting', url: null, workspace: dir, token: !!token }
  const starting = Promise.all([import('./mcp/app'), appAgentPolicy()]).then(([m, central]) =>
    m.startAppMcp(dir, {
      ...(central && { central }),
      ...(port !== undefined && Number.isInteger(port) && { port }),
      webhooks: () => (runningWebhooks ? { url: runningWebhooks.server.url, inbox: runningWebhooks.server.inbox } : null),
      piiPolicy: () => enterprisePolicy()?.agentPiiDetection === true,
      ...(token && { token }),
      log: (line) => console.error(`[vvpost-mcp] ${line}`)
    })
  )
  mcp = starting
  try {
    const running = await starting
    if (mcp === starting) mcpState = { status: 'running', url: running.url, workspace: dir, token: !!token }
    recordActivity({ at: new Date().toISOString(), kind: 'mcpServer', action: 'start' })
  } catch (err) {
    if (mcp === starting) {
      mcp = null
      const e = err as NodeJS.ErrnoException & { port?: number }
      const message = e.code === 'EADDRINUSE' ? `A porta ${e.port ?? port ?? 4470} já está em uso.` : e.message
      mcpState = { status: 'error', url: null, workspace: dir, token: !!token, message }
    }
  }
  return mcpState
}

/**
 * Liga um repositório de código ao VVPost pelo app (o vvpost connect com o servidor HTTP do app):
 * a pessoa escolhe a pasta, e os clientes recebem o servidor e o repositório, a regra do VVPost.
 */
export async function connectCodeRepo(win: BrowserWindow | null, clients: unknown): Promise<ConnectRepoResult | null> {
  const dir = await currentWorkspaceDir()
  if (!dir) return { ok: false, message: 'Abra um workspace antes de ligar um repositório de código.' }
  const [{ AGENT_CLIENTS, connectRepo }, { codeRepoRoot }, { projectLayout }, { DEFAULT_MCP_PORT }] = await Promise.all([
    import('./mcp/connect'),
    import('@vvpost/core/docs'),
    import('@vvpost/core/projects'),
    import('./mcp/transports')
  ])
  const wanted = (Array.isArray(clients) ? clients : []).filter((c): c is (typeof AGENT_CLIENTS)[number]['id'] => AGENT_CLIENTS.some((x) => x.id === c))
  if (!wanted.length) return { ok: false, message: 'Escolha ao menos um cliente de IA.' }
  const options: OpenDialogOptions = { title: 'Escolher o repositório de código', properties: ['openDirectory'] }
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const folder = picked.canceled ? null : picked.filePaths[0]
  if (!folder) return null
  const repo = await codeRepoRoot(folder)
  const layout = projectLayout(dir)
  if (repo === layout.root) return { ok: false, message: 'Essa pasta é o próprio workspace; escolha o repositório do código que ele documenta.' }
  const envPort = Number(process.env['VVPOST_MCP_PORT'])
  const url = mcpState.url ?? `http://127.0.0.1:${Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_MCP_PORT}`
  try {
    const steps = await connectRepo({
      repo,
      workspace: layout.root,
      ...(layout.current && { project: layout.current.id }),
      clients: wanted,
      endpoint: { transport: 'http', url, ...(process.env['VVPOST_MCP_TOKEN'] && { token: true }) }
    })
    return { ok: true, repo, steps }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/**
 * Servidor local de webhooks: Fastify em 127.0.0.1:4480, outro chunk carregado só
 * quando o usuário liga (barra de status, módulo Webhooks) ou um fluxo com nó webhook roda.
 * Os eventos ficam só em memória; os disparos dos hooks passam pelo dispatcher do app, com os
 * limites de quem dispara sem humano, e entram no histórico.
 */
let webhooks: Promise<{ server: RunningWebhookServer; close: () => Promise<void> }> | null = null
let runningWebhooks: { server: RunningWebhookServer } | null = null
let webhookState: WebhookServerState = { status: 'off', url: null, environment: null, configured: false, hooks: [], events: 0 }
const webhookListeners = new Set<(change: WebhookChangeEvent) => void>()

export function onWebhookChange(listener: (change: WebhookChangeEvent) => void): () => void {
  webhookListeners.add(listener)
  return () => void webhookListeners.delete(listener)
}

const webhookSummary = ({ headers, body: _, bodyBase64: __, ...rest }: WebhookEvent): WebhookEventSummary => {
  const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value
  return { ...rest, ...(contentType && { contentType }) }
}

// --- Mock server (fase 15): os exemplos de resposta dos endpoints em 127.0.0.1:4490 ---

let mock: Promise<import('@vvpost/core/mock').MockServer> | null = null
let mockState: MockServerState = { status: 'off', url: null, endpoints: 0, withExamples: 0, hits: 0 }

export function getMockServerState(): MockServerState {
  return { ...mockState }
}

export async function setMockServer(enabled: boolean): Promise<MockServerState> {
  if (!enabled) {
    const running = mock
    mock = null
    mockState = { status: 'off', url: null, endpoints: 0, withExamples: 0, hits: 0 }
    await running?.then((m) => m.close()).catch(() => undefined)
    return getMockServerState()
  }
  if (mock) {
    await mock.catch(() => undefined)
    return getMockServerState()
  }
  if (!(await currentWorkspaceDir())) {
    mockState = { ...mockState, status: 'error', message: 'Abra um workspace para ligar o mock server.' }
    return getMockServerState()
  }
  mockState = { ...mockState, status: 'starting', message: undefined }
  const envPort = Number(process.env['VVPOST_MOCK_PORT'])
  const starting = (async () => {
    const m = await import('@vvpost/core/mock')
    const { routes } = m.mockRoutes(await loadCatalog({ fresh: true }))
    const server = await m.startMockServer({
      ...(Number.isInteger(envPort) && envPort > 0 && { port: envPort }),
      // Relido a cada requisição: um exemplo salvo agora já responde.
      routes: async () => m.mockRoutes(await loadCatalog({ fresh: true })).routes,
      onHit: () => {
        if (mockState.status === 'running') mockState = { ...mockState, hits: mockState.hits + 1 }
      }
    })
    mockState = { status: 'running', url: server.url, endpoints: routes.length, withExamples: routes.filter((r) => r.examples.length).length, hits: 0 }
    return server
  })()
  mock = starting
  try {
    await starting
  } catch (err) {
    if (mock === starting) mock = null
    const code = (err as NodeJS.ErrnoException).code
    mockState = {
      status: 'error',
      url: null,
      endpoints: 0,
      withExamples: 0,
      hits: 0,
      message: code === 'EADDRINUSE' ? 'A porta 4490 já está em uso (troque com VVPOST_MOCK_PORT).' : (err as Error).message
    }
  }
  return getMockServerState()
}

export function getWebhookServerState(): WebhookServerState {
  return { ...webhookState, events: runningWebhooks?.server.inbox.size ?? 0 }
}

export async function setWebhookServer(enabled: boolean): Promise<WebhookServerState> {
  if (!enabled) {
    const running = webhooks
    webhooks = null
    runningWebhooks = null
    webhookState = { status: 'off', url: null, environment: null, configured: false, hooks: [], events: 0 }
    await running?.then((w) => w.close()).catch(() => undefined)
    for (const listener of webhookListeners) listener({ change: 'cleared' })
    return getWebhookServerState()
  }
  if (webhooks) {
    await webhooks.catch(() => undefined)
    return getWebhookServerState()
  }
  const dir = await currentWorkspaceDir()
  if (!dir) {
    webhookState = { ...webhookState, status: 'error', message: 'Abra um workspace no painel Git para ligar o servidor de webhooks.' }
    return getWebhookServerState()
  }
  webhookState = { ...webhookState, status: 'starting', message: undefined }
  const envPort = Number(process.env['VVPOST_WEBHOOK_PORT'])
  const starting = startAppWebhooks(dir, Number.isInteger(envPort) && envPort > 0 ? envPort : undefined)
  webhooks = starting
  try {
    const { server } = await starting
    if (webhooks === starting) {
      runningWebhooks = { server }
      const { hookInfo } = await import('./webhooks/config')
      webhookState = {
        status: 'running',
        url: server.url,
        environment: server.environment,
        configured: server.config.file,
        hooks: server.config.hooks.map(hookInfo),
        events: 0
      }
    }
  } catch (err) {
    if (webhooks === starting) {
      webhooks = null
      const e = err as NodeJS.ErrnoException & { port?: number }
      const message = e.code === 'EADDRINUSE' ? `A porta ${e.port ?? 4480} já está em uso.` : e.message
      webhookState = { ...webhookState, status: 'error', url: null, message }
    }
  }
  return getWebhookServerState()
}

/** Liga o servidor se preciso (fluxo com nó webhook) e devolve a caixa de entrada. */
async function ensureWebhookServer() {
  const state = await setWebhookServer(true)
  if (!runningWebhooks) throw new Error(state.message ?? 'o servidor de webhooks não ligou')
  return runningWebhooks.server.inbox
}

async function startAppWebhooks(dir: string, port?: number) {
  const [{ startWebhookServer }, { createTriggerQueue, runTrigger }, { createWebhookInbox }, { loadWebhooksConfig }, policy] = await Promise.all([
    import('./webhooks/server'),
    import('./webhooks/triggers'),
    import('./webhooks/inbox'),
    import('./webhooks/config'),
    import('@vvpost/core/policy/request-policy')
  ])
  const inbox = createWebhookInbox({ maxEvents: (await loadWebhooksConfig(dir)).maxEvents })
  const unsubscribe = inbox.subscribe((change, event) => {
    const payload: WebhookChangeEvent = change === 'cleared' ? { change } : { change, event: webhookSummary(event!) }
    for (const listener of webhookListeners) listener(payload)
  })
  // Um guard para o servidor: o limite de taxa vale entre eventos, não por disparo.
  const guard = policy.createRequestGuard({ actor: 'um webhook', ...policy.WEBHOOK_POLICY_DEFAULTS })
  let triggers: ReturnType<typeof createTriggerQueue> | null = null
  const server = await startWebhookServer(dir, {
    ...(port !== undefined && { port }),
    inbox,
    workspace: () => loadCatalog({ fresh: true }),
    onTrigger: (event, hook) => triggers?.enqueue(event, hook)
  })
  triggers = createTriggerQueue({
    inbox,
    environment: server.environment,
    run: async (job, signal) => {
      const [t, mod, core, flows] = await Promise.all([getTraced(), getConnectors(), getCore(), getFlows()])
      const ctx = { auth: (auth ??= mod.createAuthEngine(Date.now, AUTH_HOOKS)), http: t.http, guard }
      const run = await runTrigger(
        job,
        {
          workspaceDir: dir,
          loadWorkspace: () => loadCatalog({ fresh: true }),
          loadFlows: () => flows.loadFlows(dir),
          runFlow: (input, ws, opts) =>
            core.runFlowWith(input, ws, {
              ...ctx,
              signal: opts.signal,
              webhookSince: opts.webhookSince,
              webhooks: async () => inbox,
              plugins: async () => (await getPlugins()).runner()
            }),
          runScenarios: (input, ws, s) => core.runScenarioBatch(input, ws, { ...ctx, signal: s, plugins: async () => (await getPlugins()).runner() })
        },
        signal
      )
      if (!run.report) return run
      const runId = run.report.report.runId
      const recorded = t.recorder.take(runId)
      const record = await getRecord()
      const label = `(webhook #${job.event.id})`
      const historyRunId =
        run.report.kind === 'flow'
          ? await saveRun(record.flowRun(run.report.report, recorded, job.environmentId, `Fluxo ${run.report.name} ${label}`), t.sanitizer)
          : await saveRun(record.scenarioRun(run.report.report, recorded, `Cenários de ${run.report.name} ${label}`), t.sanitizer)
      if (run.report.kind === 'flow') {
        const r = run.report.report
        recordActivity({ at: new Date().toISOString(), kind: 'flowRun', flowId: r.flowId, outcome: r.outcome, durationMs: r.durationMs })
      } else {
        const r = run.report.report
        recordActivity({ at: new Date().toISOString(), kind: 'scenarioRun', connectorId: r.connectorId, environments: [job.environmentId], ...r.totals, canceled: r.canceled })
      }
      const { report: _, ...outcome } = run
      return { ...outcome, ...(historyRunId !== null && { historyRunId }) }
    }
  })
  return {
    server,
    close: async () => {
      triggers?.close()
      unsubscribe()
      await server.close()
    }
  }
}

export function listWebhookEvents(): WebhookEventSummary[] {
  return runningWebhooks?.server.inbox.list().map(webhookSummary) ?? []
}

export function getWebhookEvent(id: unknown): WebhookEvent | null {
  return typeof id === 'number' ? (runningWebhooks?.server.inbox.get(id) ?? null) : null
}

export function clearWebhookEvents(): void {
  runningWebhooks?.server.inbox.clear()
}

export function replayWebhookEvent(id: unknown): Promise<WorkspaceResult<{ id: number | null; status: number }>> {
  return attempt(async () => {
    const running = runningWebhooks?.server
    if (!running) throw new Error('O servidor de webhooks está desligado.')
    const event = typeof id === 'number' ? running.inbox.get(id) : undefined
    if (!event) throw new Error('Este evento não está mais na memória do servidor.')
    return (await import('./webhooks/replay')).replayEvent(running.url, event)
  })
}

export function hasOpenResources(): boolean {
  return !!(http || history || engine || mcp || pluginManager || webhooks || mock || realtime.size)
}

/** Fecha o pool de sockets, o banco (checkpoint do WAL), o Secret Engine e o servidor MCP. */
export async function shutdown(): Promise<void> {
  // Encerra os scripts Python em andamento: um subprocesso não pode sobreviver ao app.
  for (const run of flowRuns.values()) run.abort()
  closeAllRealtime()
  await Promise.allSettled([
    http?.then((d) => d.close()),
    history?.then((s) => s.close()),
    engine?.then((e) => e.close()),
    pluginManager?.then((p) => p.shutdown()),
    mcp?.then((m) => m.close()),
    webhooks?.then((w) => w.close()),
    mock?.then((m) => m.close())
  ])
}

/** "Converter para fluxos" (vvpost migrate): com dryRun, só a prévia; sem, grava tudo ou nada. */
export function migrateProject(dryRun: boolean): Promise<WorkspaceResult<ProjectMigration | null>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const { migrateWorkspace } = await import('./project/migrate')
    const { plan, result } = await migrateWorkspace(dir, { dryRun, actor: 'app' })
    if (!dryRun && result?.ok) {
      catalog = null
      auth?.clear()
    }
    return {
      converted: plan.converted,
      schemas: plan.schemas,
      skipped: plan.skipped.map(({ id, reason }) => ({ id, reason })),
      changes: (result?.changes ?? []).map(({ path, action }) => ({ path, action })),
      errors: (result?.errors ?? []).map((e) => e.message)
    }
  })
}

/**
 * Edição do projeto pelos menus de contexto (duplicar, renomear, excluir): só as
 * operações de PROJECT_EDIT_OPS, pela mesma camada em lote do importador e do MCP.
 */
export function editProject(ops: unknown): Promise<WorkspaceResult<{ changed: string[] }>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    if (!Array.isArray(ops) || ops.length === 0) throw new Error('Nada para alterar.')
    const allowed = new Set<string>(PROJECT_EDIT_OPS)
    for (const op of ops) {
      if (!op || typeof op !== 'object' || !allowed.has(String((op as { op?: unknown }).op))) {
        throw new Error('Operação não permitida pela interface.')
      }
    }
    // O index de ./project reexporta módulos que o Rolldown não divide bem num import dinâmico.
    const { applyProjectOps } = await import('./project/apply')
    const result = await reportNewProblems(dir, () => applyProjectOps(dir, ops as ProjectOp[], { actor: 'app' }))
    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n') || 'O projeto não foi alterado.')
    catalog = null
    for (const op of ops as ProjectEdit[]) {
      if ('connectorId' in op) auth?.clear(op.connectorId)
      else if (op.op === 'moveConnector' || op.op === 'deleteConnector') auth?.clear(op.id)
      // Uma variável mudada pode ser credencial de qualquer conector: os tokens em cache saem.
      else if (op.op === 'setVariable' || op.op === 'deleteVariable' || op.op === 'deleteEnvironment') auth?.clear()
    }
    return { changed: result.changes.map((c) => c.path) }
  })
}

/** Caminho dentro de `root`, ou null se `rel` sair dele. */
function inside(root: string, rel: string): string | null {
  const full = resolve(root, rel)
  const base = resolve(root)
  return full === base || full.startsWith(base + sep) ? full : null
}

export function revealInFolder(target: unknown): Promise<WorkspaceResult<null>> {
  return attempt(async () => {
    const t = (target && typeof target === 'object' ? target : {}) as Record<string, unknown>
    let path: string | null = null
    if (typeof t['workspacePath'] === 'string' || typeof t['repoPath'] === 'string') {
      // Os caminhos do Git são da pasta do repositório; os outros, da pasta do conteúdo (o projeto).
      const repo = typeof t['repoPath'] === 'string'
      const dir = repo ? await currentRootDir() : await currentWorkspaceDir()
      if (!dir) throw new Error('Nenhum workspace aberto.')
      path = inside(dir, String(repo ? t['repoPath'] : t['workspacePath']))
    } else if (typeof t['pluginId'] === 'string') {
      path = (await (await getPlugins()).catalog()).plugins.find((p) => p.id === t['pluginId'])?.dir ?? null
    }
    if (!path) throw new Error('Caminho fora do workspace.')
    // Uma pasta abre o explorador nela; um arquivo abre a pasta com ele selecionado.
    if ((await stat(path)).isDirectory()) {
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    } else shell.showItemInFolder(path)
    return null
  })
}

export function discardChanges(paths: unknown): Promise<WorkspaceResult<WorkspaceState>> {
  const list = Array.isArray(paths) ? paths.map(String) : []
  return inWorkspace((ws, dir) => ws.discardPaths(dir, list))
}

/** Limpa a área de transferência se ela ainda tiver o segredo copiado. */
let clipboardTimer: NodeJS.Timeout | null = null

export function revealSecret(environmentId: unknown, variable: unknown, copy: boolean): Promise<WorkspaceResult<{ value?: string }>> {
  return attempt(async () => {
    const dir = await currentWorkspaceDir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    const { readSecretsStore } = await import('./workspace/vault')
    const value = (await readSecretsStore(dir))[String(environmentId)]?.[String(variable)]
    if (value === undefined || value === REQUIRED_SECRET) throw new Error('Este segredo não tem valor no vault local.')
    if (!copy) return { value }
    await clipboard.writeText(value)
    if (clipboardTimer) clearTimeout(clipboardTimer)
    clipboardTimer = setTimeout(() => {
      void Promise.resolve(clipboard.readText()).then((current) => current === value && clipboard.clear())
    }, 30_000)
    return {}
  })
}
