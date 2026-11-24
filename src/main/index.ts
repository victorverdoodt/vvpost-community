import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { EDIT_COMMANDS, EXPORT_FORMATS, IpcChannel, type ExportFormat, type EditCommand, type ConflictResolution, type ExportSelection, type Connector, type Flow, type FlowRunInput, type DocScope, type GitSyncAction, type HistoryQuery, type HttpRequestInput, type PluginRequestInput, type RealtimeOpenInput, type ImportConflictMode, type ImportPlanInput, type ImportSyncDecision, type ScenarioRunInput } from '@shared/ipc'
import { benchEnabled, finishBench } from './bench'
import { connectEnterpriseIdentity } from './enterprise/identity'
import * as identity from './identity'
import { getResourceUsage } from './memory'
import { setBundledEnterpriseModule } from './secret-engine/backend'
import { startUxStudy, trackFlow, trackRequest, trackScenarios, trackUx, uxStudyEnabled } from './ux-study'
import * as services from './services'

// Recursos do Chromium que o VVPost não usa. Desligá-los reduz RAM e tempo de boot.
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,MediaRouter')

// Composição por software, com o processo de GPU dentro do main: a interface é de
// formulários, tabelas e um canvas SVG, que não precisam de aceleração, e o
// processo de GPU era a maior parcela da RAM em repouso (~70 MB de ~280 MB no
// Linux). VVPOST_GPU=1 volta à aceleração por hardware.
if (process.env['VVPOST_GPU'] !== '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('in-process-gpu')
}

// O instalador grava productName ("VVPost") no package.json, e o Electron tiraria a pasta userData
// dele; fixá-la em "vvpost" mantém a mesma pasta do desenvolvimento e a que o CLI procura
// (defaultUserDataDir em @vvpost/core/paths). --user-data-dir (testes, benchmark) continua valendo.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'vvpost'))
// O cofre local de segredos (@vvpost/core/vault) fica em <userData>/vault, onde o CLI e o servidor
// MCP também procuram; com --user-data-dir, o cofre acompanha a pasta.
process.env['VVPOST_VAULT_DIR'] ??= join(app.getPath('userData'), 'vault')

// Instalador com o módulo Enterprise (build com VVPOST_ENTERPRISE_DIR, ver docs/packaging.md):
// ele fica fora do app.asar, em resources/enterprise, e só é carregado quando usado.
if (app.isPackaged) {
  const entry = join(process.resourcesPath, 'enterprise', 'dist', 'index.js')
  if (existsSync(entry)) setBundledEnterpriseModule(entry)
}

// Modo de impressão (export_docs do MCP): imprime um PDF numa janela oculta e sai, sem abrir o
// app, sem a trava de instância única e com uma pasta de dados própria (--user-data-dir).
const printJob = process.argv.find((a) => a.startsWith('--vvpost-print='))?.slice('--vvpost-print='.length) ?? null

if (printJob === null && !app.requestSingleInstanceLock()) {
  // O benchmark e os testes leem isto para explicar a saída sem paint (código 0).
  process.stderr.write('VVPOST_SINGLE_INSTANCE: outra instância do VVPost já está aberta com esta pasta de dados\n')
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0c0f',
    title: 'VVPost',
    icon: join(__dirname, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    // Sem a barra de título do sistema: a barra superior do app (44 px) é a área de arrastar, e
    // os botões de minimizar, maximizar e fechar são os nativos sobrepostos à direita (no macOS,
    // os semáforos à esquerda). O renderer reserva o espaço deles com env(titlebar-area-*).
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'darwin' ? true : { color: '#11141a', symbolColor: '#929bad', height: 43 },
    ...(process.platform === 'darwin' && { trafficLightPosition: { x: 14, y: 14 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck'
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (!benchEnabled) mainWindow?.show()
  })

  // Links externos abrem no navegador do sistema, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const CONFLICT_MODES = new Set<unknown>(['merge', 'rename', 'replace'])

/** Entrada da revisão do import vinda do renderer: só passa o formato esperado; o planejador confere o resto. */
function importInput(input: unknown): ImportPlanInput {
  const v = (input ?? {}) as Record<string, unknown>
  const modes = (r: unknown) =>
    Object.fromEntries(
      Object.entries(r && typeof r === 'object' && !Array.isArray(r) ? r : {}).filter(([, m]) => CONFLICT_MODES.has(m))
    ) as Record<string, ImportConflictMode>
  return {
    adjustments: Array.isArray(v['adjustments']) ? v['adjustments'] : [],
    conflicts: modes(v['conflicts']),
    environmentConflicts: modes(v['environmentConflicts']),
    flowConflicts: modes(v['flowConflicts']),
    syncDecisions: Object.fromEntries(
      Object.entries(v['syncDecisions'] && typeof v['syncDecisions'] === 'object' ? v['syncDecisions'] : {}).filter(
        ([, d]) => d === 'spec' || d === 'keep'
      )
    ) as Record<string, ImportSyncDecision>
  }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)

/** Seleção de exportação vinda do renderer: só listas de ids, as duas chaves booleanas e o formato. */
function exportSelection(input: unknown): ExportSelection {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out: ExportSelection = {}
  for (const key of ['connectors', 'endpoints', 'environments', 'flows'] as const) {
    const list = strings(v[key])
    if (list) out[key] = list
  }
  if (v['scenarios'] === false) out.scenarios = false
  if (v['docs'] === false) out.docs = false
  if (EXPORT_FORMATS.includes(v['format'] as ExportFormat)) out.format = v['format'] as ExportFormat
  return out
}

/** Escopo da documentação vindo do renderer: só os campos esperados, como texto. */
function docScope(input: unknown): DocScope | null {
  if (!input || typeof input !== 'object') return null
  const v = input as Record<string, unknown>
  const id = (k: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : null)
  switch (v['kind']) {
    case 'project':
      return { kind: 'project' }
    case 'connector':
      return id('connectorId') ? { kind: 'connector', connectorId: id('connectorId')! } : null
    case 'endpoint':
      return id('connectorId') && id('endpointId')
        ? { kind: 'endpoint', connectorId: id('connectorId')!, endpointId: id('endpointId')! }
        : null
    case 'request':
      return id('connectorId') && id('endpointId') && id('scenarioId')
        ? { kind: 'request', connectorId: id('connectorId')!, endpointId: id('endpointId')!, scenarioId: id('scenarioId')! }
        : null
    default:
      return null
  }
}

type PeopleView = typeof import('@vvpost/core/pii-people')
let realtimePeople: { view: PeopleView; m: import('@vvpost/core/pii').PiiMasker } | null = null
async function preparePeople(): Promise<void> {
  const m = await services.peopleView()
  realtimePeople = m ? { view: await import('@vvpost/core/pii-people'), m } : null
}
/**
 * Dados pessoais para quem usa o app (services.peopleView): com a máscara ligada, o que mostra uma
 * resposta passa por @vvpost/core/pii-people antes de chegar ao renderer. Sem ela, nada carrega.
 */
async function forPeople<T>(value: T, mask: (view: PeopleView, value: T, m: import('@vvpost/core/pii').PiiMasker) => T): Promise<T> {
  const m = await services.peopleView()
  return m ? mask(await import('@vvpost/core/pii-people'), value, m) : value
}

function registerIpc(): void {
  ipcMain.handle(IpcChannel.GetResourceUsage, () => getResourceUsage())
  ipcMain.handle(IpcChannel.HttpSend, async (_e, input: HttpRequestInput) => {
    const result = await services.sendRequest(input)
    trackRequest(result, input)
    return forPeople(result, (v, r, m) => v.peopleHttpResult(r, m))
  })
  ipcMain.handle(IpcChannel.HttpCancel, (_e, id: string) => services.cancelRequest(id))
  ipcMain.handle(IpcChannel.HttpScriptFlow, (_e, input: HttpRequestInput) => services.requestScriptFlow(input))
  ipcMain.handle(IpcChannel.HistoryList, async (_e, query?: HistoryQuery) =>
    forPeople(await services.listHistory(query), (_v, list, m) => list.map((r) => ({ ...r, title: m.text(r.title), url: r.url === null ? null : m.text(r.url) })))
  )
  ipcMain.handle(IpcChannel.HistoryGet, async (_e, id: number) =>
    forPeople(await services.getHistoryRun(id), (v, run, m) =>
      run && { ...run, title: m.text(run.title), url: run.url === null ? null : m.text(run.url), exchanges: run.exchanges.map((x) => ({ ...v.peopleExchange(x, m), url: m.text(x.url) })), report: m.sanitize(run.report) }
    )
  )
  ipcMain.handle(IpcChannel.HistoryDelete, (_e, id: number) => services.deleteHistoryRun(id))
  ipcMain.handle(IpcChannel.HistoryClear, () => services.clearHistory())
  ipcMain.handle(IpcChannel.HistoryReplay, async (_e, exchangeId: number) =>
    forPeople(await services.replayHistory(exchangeId), (v, r, m) => (r.ok ? { ...r, result: v.peopleHttpResult(r.result, m) } : r))
  )
  ipcMain.handle(IpcChannel.HistorySettingsGet, () => services.getHistorySettings())
  ipcMain.handle(IpcChannel.HistorySettingsSet, (_e, settings: unknown) => services.setHistorySettings(settings))
  ipcMain.handle(IpcChannel.HistoryStats, () => services.getHistoryStats())
  ipcMain.handle(IpcChannel.PostmanPreview, (e, options: unknown) =>
    services.previewPostmanImport(BrowserWindow.fromWebContents(e.sender), (options as { folder?: unknown } | undefined)?.folder === true)
  )
  ipcMain.handle(IpcChannel.ImportUrlPreview, (_e, url: unknown) => services.previewUrlImport(String(url ?? '')))
  ipcMain.handle(IpcChannel.ImportSpecReimport, (_e, id: unknown) => services.previewSpecReimport(String(id ?? '')))
  ipcMain.handle(IpcChannel.PostmanPlan, (_e, id: string, input: ImportPlanInput) =>
    services.planPostmanImport(String(id), importInput(input))
  )
  ipcMain.handle(IpcChannel.PostmanTarget, (e, id: string, input: ImportPlanInput) =>
    services.choosePostmanImportTarget(BrowserWindow.fromWebContents(e.sender), String(id), importInput(input))
  )
  ipcMain.handle(IpcChannel.PostmanWrite, (e, id: string, input: ImportPlanInput) =>
    services.writePostmanImport(BrowserWindow.fromWebContents(e.sender), String(id), importInput(input))
  )
  ipcMain.handle(IpcChannel.ExportOptions, () => services.getExportOptions())
  ipcMain.handle(IpcChannel.ExportPreview, (_e, selection: unknown) => services.previewExport(exportSelection(selection)))
  ipcMain.handle(IpcChannel.ExportSave, (e, selection: unknown, meta: unknown) => {
    const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>
    const text = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 200) : undefined)
    return services.saveExport(BrowserWindow.fromWebContents(e.sender), exportSelection(selection), {
      ...(text(m['name']) && { name: text(m['name']) }),
      ...(text(m['description']) && { description: text(m['description']) })
    })
  })
  const archiveScope = (x: unknown) => (x === 'workspace' ? 'workspace' : 'project')
  ipcMain.handle(IpcChannel.ArchiveExportPreview, (_e, scope: unknown) => services.previewArchiveExport(archiveScope(scope)))
  ipcMain.handle(IpcChannel.ArchiveExportSave, (e, scope: unknown, meta: unknown) => {
    const name = (meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['name'] : undefined)
    return services.saveArchiveExport(BrowserWindow.fromWebContents(e.sender), archiveScope(scope), {
      ...(typeof name === 'string' && name.trim() && { name: name.trim().slice(0, 200) })
    })
  })
  ipcMain.handle(IpcChannel.ArchivePreview, (e) => services.previewArchiveImport(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(IpcChannel.ArchiveWrite, (e, id: unknown, choice: unknown) => {
    const c = (choice && typeof choice === 'object' ? choice : {}) as Record<string, unknown>
    const text = (x: unknown) => (typeof x === 'string' ? x.trim().slice(0, 200) : '')
    return services.writeArchiveImport(
      BrowserWindow.fromWebContents(e.sender),
      String(id ?? ''),
      c['mode'] === 'project' ? { mode: 'project', id: text(c['id']), name: text(c['name']) } : { mode: 'workspace' }
    )
  })
  ipcMain.handle(IpcChannel.ResponseSave, (e, input: unknown) => {
    const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    if (typeof v['data'] !== 'string' || (v['encoding'] !== 'utf8' && v['encoding'] !== 'base64')) {
      return { ok: false, reason: 'error', message: 'Corpo inválido' }
    }
    return services.saveResponse(BrowserWindow.fromWebContents(e.sender), {
      fileName: typeof v['fileName'] === 'string' ? v['fileName'] : 'resposta',
      data: v['data'],
      encoding: v['encoding']
    })
  })
  ipcMain.handle(IpcChannel.PickFile, (e, purpose: unknown) =>
    services.pickFile(BrowserWindow.fromWebContents(e.sender), purpose === 'ca' ? 'ca' : 'body')
  )
  ipcMain.handle(IpcChannel.PickDataFile, (e) => services.pickDataFile(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(IpcChannel.HttpSettingsGet, () => services.getHttpSettings())
  ipcMain.handle(IpcChannel.HttpSettingsSet, (_e, settings: unknown) => services.setHttpSettings(settings))
  ipcMain.handle(IpcChannel.CookiesList, () => services.listCookies())
  ipcMain.handle(IpcChannel.CookiesSet, (_e, cookie: unknown) => services.setCookie(cookie))
  ipcMain.handle(IpcChannel.CookiesDelete, (_e, filter: unknown) => services.deleteCookies(filter))
  ipcMain.handle(IpcChannel.EnvironmentSetVariable, (_e, input: unknown) => {
    const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const value = v['value']
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { ok: false, message: 'Valor inválido' }
    }
    return services.setEnvironmentVariable({ environmentId: String(v['environmentId']), name: String(v['name']), value })
  })
  ipcMain.handle(IpcChannel.WorkspaceGet, () => services.getWorkspaceState())
  ipcMain.handle(IpcChannel.WorkspaceInfo, () => services.getWorkspaceInfo())
  ipcMain.handle(IpcChannel.ProjectSwitch, (_e, id: unknown) => services.switchProject(id))
  ipcMain.handle(IpcChannel.ProjectCreate, (_e, input: unknown) => services.createWorkspaceProject(input))
  ipcMain.handle(IpcChannel.ProjectMigrate, (_e, dryRun: unknown) => services.migrateProject(dryRun === true))
  ipcMain.handle(IpcChannel.SecretsInventory, () => services.getSecretInventory())
  ipcMain.handle(IpcChannel.WorkspaceOpen, async (e) => {
    const result = await services.openWorkspace(BrowserWindow.fromWebContents(e.sender))
    trackUx('workspace', { ok: result.ok, opened: result.ok && result.value !== null })
    return result
  })
  ipcMain.handle(IpcChannel.WorkspaceClone, (e, url: string) =>
    services.cloneWorkspace(BrowserWindow.fromWebContents(e.sender), String(url))
  )
  ipcMain.handle(IpcChannel.WorkspaceInit, () => services.initWorkspace())
  ipcMain.handle(IpcChannel.WorkspaceTemplates, () => services.listProjectTemplates())
  ipcMain.handle(IpcChannel.WorkspaceCreate, async (e, input) => {
    const v = (input ?? {}) as Record<string, unknown>
    const result = await services.createProject(BrowserWindow.fromWebContents(e.sender), v['template'], v['git'] === true)
    trackUx('workspace-created', { ok: result.ok, template: String(v['template']) })
    return result
  })
  ipcMain.handle(IpcChannel.WorkspaceDiff, (_e, path: string) => services.diffWorkspaceFile(String(path)))
  ipcMain.handle(IpcChannel.WorkspaceSaveSecrets, (_e, values) =>
    services.saveWorkspaceSecrets(Array.isArray(values) ? values : [])
  )
  ipcMain.handle(IpcChannel.WorkspaceReplaceSecret, (_e, value) => services.replaceWorkspaceSecret(value))
  ipcMain.handle(IpcChannel.GitCommit, (_e, message: string, paths: string[]) =>
    services.commitWorkspace(String(message), Array.isArray(paths) ? paths.map(String) : [])
  )
  ipcMain.handle(IpcChannel.GitCheckout, (_e, name: string) => services.checkoutBranch(String(name)))
  ipcMain.handle(IpcChannel.GitCreateBranch, (_e, name: string) => services.createBranch(String(name)))
  ipcMain.handle(IpcChannel.GitSync, (_e, action: GitSyncAction) => services.syncWorkspace(action))
  ipcMain.handle(IpcChannel.GitConflictRead, (_e, path: string) => services.readConflict(String(path)))
  ipcMain.handle(IpcChannel.GitConflictResolve, (_e, path: string, resolution: ConflictResolution) =>
    services.resolveConflict(String(path), resolution)
  )
  ipcMain.handle(IpcChannel.GitMergeFinish, () => services.finishMerge())
  ipcMain.handle(IpcChannel.GitMergeAbort, () => services.abortMerge())
  ipcMain.handle(IpcChannel.GitInstallHook, () => services.installCommitHook())
  ipcMain.handle(IpcChannel.ConnectorsGet, () => services.getConnectorCatalog())
  ipcMain.handle(IpcChannel.AuthClear, (_e, connectorId?: string) => services.clearAuthCache(connectorId))
  ipcMain.handle(IpcChannel.ScenariosRun, async (_e, input: ScenarioRunInput) => {
    const report = await services.runScenarios(input)
    trackScenarios(report)
    return forPeople(report, (v, r, m) => v.peopleScenarioReport(r, m))
  })
  ipcMain.handle(IpcChannel.ScenariosCancel, (_e, runId: string) => services.cancelScenarios(String(runId)))
  ipcMain.handle(IpcChannel.FlowsList, () => services.listFlows())
  ipcMain.handle(IpcChannel.FlowsSave, (_e, flow: Flow, file?: string, expected?: unknown) =>
    services.saveFlow(flow, typeof file === 'string' ? file : undefined, typeof expected === 'string' || expected === null ? expected : undefined)
  )
  ipcMain.handle(IpcChannel.FlowsRun, async (e, input: FlowRunInput) => {
    const m = await services.peopleView()
    const view = m && (await import('@vvpost/core/pii-people'))
    const report = await services.runFlow(input, (event) => {
      const shown = view && m && 'result' in event ? { ...event, result: view.peopleFlowNode(event.result, m) } : event
      if (!e.sender.isDestroyed()) e.sender.send(IpcChannel.FlowsEvent, shown)
    })
    trackFlow(report)
    return view && m ? view.peopleFlowReport(report, m) : report
  })
  ipcMain.handle(IpcChannel.FlowsCancel, (_e, runId: string) => services.cancelFlow(String(runId)))
  ipcMain.handle(IpcChannel.RegistryGet, () => services.getConnectorRegistry())
  ipcMain.handle(IpcChannel.LintRun, () => services.lintWorkspace())
  ipcMain.handle(IpcChannel.LintFixDiagrams, (_e, apply: unknown) => services.fixDiagrams(apply === true))
  ipcMain.handle(IpcChannel.ProjectBases, () => services.getProjectBases())
  ipcMain.handle(IpcChannel.AiReviewList, () => services.listAiReview())
  ipcMain.handle(IpcChannel.AiReviewApprove, (_e, keys?: unknown) =>
    services.approveAiReview(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : undefined)
  )
  ipcMain.handle(IpcChannel.DocsGenerate, (_e, scope: unknown) => {
    const s = docScope(scope)
    return s ? services.generateDocs(s) : { ok: false, message: 'escopo de documentação inválido' }
  })
  ipcMain.handle(IpcChannel.DocsSaveMarkdown, (e, scope: unknown, generated: unknown) => {
    const s = docScope(scope)
    return s
      ? services.saveDocsMarkdown(BrowserWindow.fromWebContents(e.sender), s, generated === true)
      : { ok: false, reason: 'error', message: 'escopo de documentação inválido' }
  })
  ipcMain.handle(IpcChannel.DocsSavePdf, (e, title: unknown, html: unknown, cover: unknown) =>
    typeof title === 'string' && typeof html === 'string'
      ? services.saveDocsPdf(BrowserWindow.fromWebContents(e.sender), title.slice(0, 200), html, cover === true)
      : { ok: false, reason: 'error', message: 'documento inválido' }
  )
  ipcMain.handle(IpcChannel.DocsProject, () => services.docsProject())
  ipcMain.handle(IpcChannel.DocsSaveProject, (_e, draft: unknown) => services.saveDocsProject(draft))
  ipcMain.handle(IpcChannel.DocsCompile, (_e, draft: unknown) => services.compileDocs(draft))
  ipcMain.handle(IpcChannel.DocsApplyTemplate, (_e, id: unknown, current: unknown) => services.applyDocsTemplate(String(id), current))
  ipcMain.handle(IpcChannel.DocsReadDiagram, (_e, file: unknown) => services.readDiagram(file))
  ipcMain.handle(IpcChannel.DocsSaveDiagram, (_e, input: unknown) => services.saveDiagram(input))
  ipcMain.handle(IpcChannel.DiagramCatalog, () => services.diagramCatalog())
  ipcMain.handle(IpcChannel.DocsFiles, () => services.docsFiles())
  ipcMain.handle(IpcChannel.BrandRead, (_e, file: unknown) => services.readBrandFile(file))
  ipcMain.handle(IpcChannel.BrandFindings, () => services.brandFindings())
  ipcMain.handle(IpcChannel.BrandSave, (_e, input: unknown) => services.saveBrandFile(input))
  ipcMain.handle(IpcChannel.PublishTargets, () => services.publishTargets())
  ipcMain.handle(IpcChannel.PublishInit, (_e, provider: unknown, destination: unknown) => services.publishInit(provider, destination))
  ipcMain.handle(IpcChannel.PublishSignIn, (_e, target: unknown, credential: unknown) => services.publishSignIn(target, credential))
  ipcMain.handle(IpcChannel.PublishSignOut, (_e, target: unknown) => services.publishSignOut(target))
  ipcMain.handle(IpcChannel.PublishPrepare, (_e, target: unknown) => services.publishPrepare(target))
  ipcMain.handle(IpcChannel.PublishPlan, (_e, id: unknown, images: unknown) => services.publishPlan(id, images))
  ipcMain.handle(IpcChannel.PublishApply, (_e, id: unknown, approval: unknown) => services.publishApply(id, approval))
  ipcMain.handle(IpcChannel.DocsReadMarkdownFile, (_e, file: unknown) => services.readMarkdownFile(file))
  ipcMain.handle(IpcChannel.DocsSaveMarkdownFile, (_e, input: unknown) => services.saveMarkdownFile(input))
  ipcMain.handle(IpcChannel.DocsRenameFile, (_e, input: unknown) => services.renameDocsFile(input))
  ipcMain.handle(IpcChannel.DocsDeleteFile, (_e, file: unknown) => services.deleteDocsFile(file))
  ipcMain.handle(IpcChannel.DocsSaveTemplate, (_e, input: unknown) => services.saveDocsTemplate(input))
  ipcMain.handle(IpcChannel.DocsPreviewPdf, (_e, config: unknown, title: unknown, html: unknown) =>
    typeof title === 'string' && typeof html === 'string'
      ? services.previewDocsPdf(config, title.slice(0, 200), html)
      : { ok: false, message: 'documento inválido' }
  )
  ipcMain.handle(IpcChannel.ConnectorRead, (_e, id: string) => services.readConnector(String(id)))
  ipcMain.handle(IpcChannel.SchemaRead, (_e, name: unknown) => services.readSharedSchema(String(name)))
  ipcMain.handle(IpcChannel.SchemaSave, (_e, name: unknown, schema: unknown, expected?: unknown) =>
    services.saveSharedSchema(String(name), schema, typeof expected === 'string' || expected === null ? expected : undefined)
  )
  ipcMain.handle(IpcChannel.ConnectorSave, (_e, connector: Connector, file?: string, expected?: unknown) =>
    services.saveConnector(connector, typeof file === 'string' ? file : undefined, typeof expected === 'string' || expected === null ? expected : undefined)
  )
  ipcMain.handle(IpcChannel.RegistryValidateBody, (_e, connectorId: string, endpointId: string, body: string) =>
    services.validateEndpointBody(String(connectorId), String(endpointId), String(body))
  )
  ipcMain.handle(IpcChannel.SecretEngineGet, () => services.getSecretEngineState())
  ipcMain.handle(IpcChannel.SecretEngineSet, (_e, enabled: boolean) => services.setSecretEngine(enabled === true).then(() => services.getSecretEngineState()))
  ipcMain.handle(IpcChannel.SecretEngineMode, (_e, mode: unknown) => services.setSecretEngineMode(mode))
  ipcMain.handle(IpcChannel.PluginsList, () => services.listPlugins())
  ipcMain.handle(IpcChannel.PluginsSetEnabled, (_e, id: string, enabled: boolean) => services.setPluginEnabled(String(id), enabled === true))
  ipcMain.handle(IpcChannel.PluginsPreviewInstall, (e) => services.previewPluginInstall(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(IpcChannel.PluginsInstall, (_e, previewId: string, options?: { trustKey?: unknown }) =>
    services.installPlugin(String(previewId), { trustKey: options?.trustKey === true })
  )
  ipcMain.handle(IpcChannel.PluginsPreviewArchive, (e) => services.previewPluginArchive(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(IpcChannel.PluginsPreviewRegistry, (_e, registryUrl: string, pluginId: string, version?: string) =>
    services.previewPluginFromRegistry(String(registryUrl), String(pluginId), typeof version === 'string' ? version : undefined)
  )
  ipcMain.handle(IpcChannel.PluginsBrowseRegistries, () => services.browsePluginRegistries())
  ipcMain.handle(IpcChannel.PluginsAddRegistry, (_e, url: string) => services.addPluginRegistry(String(url)))
  ipcMain.handle(IpcChannel.PluginsRemoveRegistry, (_e, url: string) => services.removePluginRegistry(String(url)))
  ipcMain.handle(IpcChannel.PluginsTrustKey, (_e, publicKey: string, name: string) => services.trustPluginKey(String(publicKey), String(name ?? '')))
  ipcMain.handle(IpcChannel.PluginsUntrustKey, (_e, publicKey: string) => services.untrustPluginKey(String(publicKey)))
  ipcMain.handle(IpcChannel.PluginsSendRequest, async (_e, input: PluginRequestInput) =>
    forPeople(await services.sendPluginRequest(input), (v, r, m) => v.peopleHttpResult(r, m))
  )
  ipcMain.handle(IpcChannel.PluginsRemove, (_e, id: string) => services.removePlugin(String(id)))
  ipcMain.handle(IpcChannel.McpServerGet, () => services.getMcpServerState())
  ipcMain.handle(IpcChannel.McpServerSet, (_e, enabled: boolean) => services.setMcpServer(enabled === true))
  ipcMain.handle(IpcChannel.McpConnectRepo, (e, clients: unknown) => services.connectCodeRepo(BrowserWindow.fromWebContents(e.sender), clients))
  ipcMain.handle(IpcChannel.RealtimeOpen, async (_e, input: RealtimeOpenInput) => {
    await preparePeople()
    return services.openRealtime(input)
  })
  ipcMain.handle(IpcChannel.RealtimeSend, (_e, id: unknown, message: unknown) => services.sendRealtime(id, message))
  ipcMain.handle(IpcChannel.RealtimeClose, (_e, id: unknown) => services.closeRealtime(id))
  ipcMain.handle(IpcChannel.MockGet, () => services.getMockServerState())
  ipcMain.handle(IpcChannel.MockSet, (_e, enabled: boolean) => services.setMockServer(enabled === true))
  ipcMain.handle(IpcChannel.WebhooksGet, () => services.getWebhookServerState())
  ipcMain.handle(IpcChannel.WebhooksSet, (_e, enabled: boolean) => services.setWebhookServer(enabled === true))
  ipcMain.handle(IpcChannel.WebhooksList, () => forPeople(services.listWebhookEvents(), (v, list, m) => list.map((x) => v.peopleWebhookEvent(x, m))))
  ipcMain.handle(IpcChannel.WebhooksEvent, (_e, id: unknown) => forPeople(services.getWebhookEvent(id), (v, x, m) => x && v.peopleWebhookEvent(x, m)))
  ipcMain.handle(IpcChannel.WebhooksClear, () => services.clearWebhookEvents())
  ipcMain.handle(IpcChannel.WebhooksReplay, (_e, id: unknown) => services.replayWebhookEvent(id))
  services.onRealtimeEvents((events) => {
    // Os eventos chegam em lote e em ordem: a máscara é a lida ao abrir a conexão (preparePeople).
    const shown = realtimePeople ? events.map((x) => realtimePeople!.view.peopleRealtimeEvent(x, realtimePeople!.m)) : events
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.RealtimeEvents, shown)
  })
  services.onWriteProblems((problems) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.WriteProblems, problems)
  })
  services.onWorkspaceFilesChanged((change) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.WorkspaceFilesChanged, change)
  })
  services.onWebhookChange((change) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.WebhooksChanged, change)
  })
  ipcMain.handle(IpcChannel.RemoteRunTarget, () => services.getRemoteRunTarget())
  ipcMain.handle(IpcChannel.RemoteRunPreview, (_e, selection: unknown) => services.previewRemoteRun(selection))
  ipcMain.handle(IpcChannel.RemoteRunStart, (_e, selection: unknown) => services.startRemoteRun(selection))
  ipcMain.handle(IpcChannel.RemoteRunPoll, (_e, id: unknown, after: unknown) => services.pollRemoteRun(id, after))
  ipcMain.handle(IpcChannel.RemoteRunCancel, (_e, id: unknown) => services.cancelRemoteRun(id))
  ipcMain.handle(IpcChannel.IdentityGet, () => identity.identityState())
  ipcMain.handle(IpcChannel.IdentitySetProfile, (_e, input: unknown) => identity.setLocalProfile(input))
  ipcMain.handle(IpcChannel.IdentitySignIn, () => identity.signIn())
  ipcMain.handle(IpcChannel.IdentitySignOut, () => identity.signOut())
  ipcMain.handle(IpcChannel.IdentitySwitchOrganization, (_e, id: unknown) => identity.switchOrganization(id))
  ipcMain.handle(IpcChannel.ProjectEdit, (_e, ops: unknown) => services.editProject(ops))
  ipcMain.handle(IpcChannel.ShellReveal, (_e, target: unknown) => services.revealInFolder(target))
  ipcMain.handle(IpcChannel.GitDiscard, (_e, paths: unknown) => services.discardChanges(paths))
  ipcMain.handle(IpcChannel.SecretReveal, (_e, environmentId: unknown, variable: unknown, copy: unknown) =>
    services.revealSecret(environmentId, variable, copy === true)
  )
  ipcMain.on(IpcChannel.EditCommand, (e, command: unknown) => {
    if (typeof command === 'string' && (EDIT_COMMANDS as readonly string[]).includes(command)) {
      e.sender[command as EditCommand]()
    }
  })
  identity.onIdentityChange((state) => mainWindow?.webContents.send(IpcChannel.IdentityChanged, state))
  ipcMain.on(IpcChannel.UxStudyTrack, (_e, type: unknown, data: unknown) => trackUx(type, data))
  ipcMain.handle(IpcChannel.UxStudyStatus, () => uxStudyEnabled())
  ipcMain.on(IpcChannel.BenchFirstPaint, () => {
    if (benchEnabled && mainWindow) finishBench(getResourceUsage, mainWindow.webContents)
  })
}

void app.whenReady().then(() => {
  if (printJob !== null) {
    void import('./docs/print-worker').then(({ runPrintJob }) => runPrintJob(printJob)).then(
      () => app.exit(0),
      (err: Error) => {
        process.stderr.write(`VVPOST_PRINT_ERROR: ${err.message}\n`)
        app.exit(1)
      }
    )
    return
  }
  identity.setProfileDir(app.getPath('userData'))
  startUxStudy()
  registerIpc()
  createWindow()
  // Depois da primeira pintura: o módulo Enterprise não entra no cold start.
  // A organização que o workspace declara vem antes: a conta corporativa depende dela.
  mainWindow?.webContents.once('did-finish-load', () => void services.applyWorkspaceOrganization().finally(() => {
      void connectEnterpriseIdentity((url) => shell.openExternal(url))
      void services.connectFeaturePolicy()
    }))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

let shuttingDown = false
app.on('will-quit', (event) => {
  // Fecha o pool de sockets e faz checkpoint do WAL antes de sair.
  if (!services.hasOpenResources() || shuttingDown) return
  event.preventDefault()
  shuttingDown = true
  // O quit sai no próximo tick: chamado ainda dentro do will-quit cancelado (o que
  // acontece quando o fechamento termina rápido, ex.: só o histórico aberto), o
  // Electron ignora o app.quit() e o processo nunca fecha.
  void services.shutdown().finally(() => setImmediate(() => app.quit()))
})

app.on('window-all-closed', () => {
  // A impressão abre e fecha janelas em sequência e sai sozinha no fim.
  if (process.platform !== 'darwin' && printJob === null) app.quit()
})
