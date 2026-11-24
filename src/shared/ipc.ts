import type { Connector, Endpoint, Flow, FlowCondition, FlowEdge, FlowNode, FlowPlugin, FlowRequest, FlowWebhook, PluginField, ResponseExample, Scenario } from '@vvpost/schemas'
import type {
  AssertionOperator,
  AssertionResult,
  AuthUsage,
  BodyCheck,
  BodyValidation,
  CatalogConnector,
  CatalogScenario,
  ConnectorCatalog,
  ConnectorRegistry,
  ConnectorSource,
  FlowCatalog,
  FlowErrorCode,
  FlowNodeResult,
  FlowNodeStatus,
  FlowRunEvent,
  FlowRunInput,
  FlowRunReport,
  HttpError,
  HttpErrorCode,
  HttpHeader,
  HttpMethod,
  HttpRequestInput,
  PluginRequestInput,
  HttpResponseData,
  HttpResult,
  HttpTimings,
  PluginCatalog,
  PluginContribution,
  PluginInfo,
  PluginInstallPreview,
  PluginRegistryListing,
  RegistryConnector,
  RegistryEndpoint,
  ScenarioAssertion,
  ScenarioResult,
  ScenarioRunInput,
  ScenarioRunReport,
  SchemaField,
  SchemaIssue,
  WebhookEvent,
  WebhookTriggerResult,
  DiagramBlock,
  DiagramCatalog,
  DiagramIconPack
} from '@vvpost/core/types'

import type { ApiDocument, DocScope } from '@vvpost/core/docs/model'
import type { DocDiagnostic, DocsMarkdownFile } from '@vvpost/core/docs/compose'
import type { DocTemplateOrigin } from '@vvpost/core/docs/templates'
import type { BrandFileView, BrandItem } from '@vvpost/core/brand'
import type { DocsConfig } from '@vvpost/schemas'
import type { RequestPayload, RequestScripts } from '@vvpost/core/types'
import type { RealtimeEvent, RealtimeOpenInput } from '@vvpost/core/realtime'

// Tipos do motor, definidos em @vvpost/core e reexportados para o preload e o renderer.
export type * from '@vvpost/core/docs/model'
export type { DocDiagnostic, DocsMarkdownFile } from '@vvpost/core/docs/compose'
export type { DocTemplateOrigin } from '@vvpost/core/docs/templates'
export type { BrandFileView, BrandItem, BrandTokenView } from '@vvpost/core/brand'
export type { DocsBand, DocsConfig } from '@vvpost/schemas'
export type { RealtimeEvent, RealtimeMessage, RealtimeOpenInput, RealtimeProtocol, RealtimeStatus } from '@vvpost/core/realtime'
export { HTTP_METHODS } from '@vvpost/core/types'
export type {
  AssertionOperator,
  AssertionResult,
  AuthUsage,
  BodyCheck,
  BodyValidation,
  CatalogConnector,
  CatalogScenario,
  ConnectorCatalog,
  ConnectorRegistry,
  ConnectorSource,
  FlowCatalog,
  FlowErrorCode,
  FlowNodeResult,
  FlowNodeStatus,
  FlowRunEvent,
  FlowRunInput,
  FlowRunReport,
  HttpError,
  HttpErrorCode,
  HttpHeader,
  HttpMethod,
  HttpRequestInput,
  PluginRequestInput,
  HttpResponseData,
  HttpResult,
  RequestPayload,
  RequestScripts,
  ScriptTestResult,
  ScriptUsage,
  SentRequest,
  PrepareUsage,
  HttpTimings,
  PluginCatalog,
  PluginContribution,
  PluginInfo,
  PluginInstallPreview,
  PluginRegistryListing,
  RegistryConnector,
  RegistryEndpoint,
  ScenarioAssertion,
  ScenarioResult,
  ScenarioRunInput,
  ScenarioRunReport,
  SchemaField,
  SchemaIssue,
  WebhookEvent,
  WebhookTriggerResult
} from '@vvpost/core/types'

/**
 * Contrato IPC entre o renderer e o main process.
 * Todo canal novo deve ser declarado aqui para que preload e main
 * compartilhem nomes e tipos.
 */
export const IpcChannel = {
  GetResourceUsage: 'app:get-resource-usage',
  BenchFirstPaint: 'bench:first-paint',
  UxStudyTrack: 'ux-study:track',
  UxStudyStatus: 'ux-study:status',
  HttpSend: 'http:send',
  HttpCancel: 'http:cancel',
  HttpScriptFlow: 'http:script-flow',
  HistoryList: 'history:list',
  HistoryGet: 'history:get',
  HistoryDelete: 'history:delete',
  HistoryClear: 'history:clear',
  HistoryReplay: 'history:replay',
  HistorySettingsGet: 'history:settings-get',
  HistorySettingsSet: 'history:settings-set',
  HistoryStats: 'history:stats',
  PostmanPreview: 'import:postman-preview',
  PostmanPlan: 'import:postman-plan',
  PostmanTarget: 'import:postman-target',
  PostmanWrite: 'import:postman-write',
  ImportUrlPreview: 'import:url-preview',
  ImportSpecReimport: 'import:spec-reimport',
  ExportOptions: 'export:options',
  ExportPreview: 'export:preview',
  ExportSave: 'export:save',
  ArchiveExportPreview: 'archive:export-preview',
  ArchiveExportSave: 'archive:export-save',
  ArchivePreview: 'archive:import-preview',
  ArchiveWrite: 'archive:import-write',
  ResponseSave: 'response:save',
  PickFile: 'dialog:pick-file',
  PickDataFile: 'dialog:pick-data-file',
  HttpSettingsGet: 'http:settings-get',
  HttpSettingsSet: 'http:settings-set',
  CookiesList: 'cookies:list',
  CookiesSet: 'cookies:set',
  CookiesDelete: 'cookies:delete',
  EnvironmentSetVariable: 'environment:set-variable',
  WorkspaceGet: 'workspace:get',
  WorkspaceInfo: 'workspace:info',
  ProjectSwitch: 'project:switch',
  ProjectCreate: 'project:create',
  ProjectMigrate: 'project:migrate',
  SecretsInventory: 'secrets:inventory',
  WorkspaceOpen: 'workspace:open',
  WorkspaceClone: 'workspace:clone',
  WorkspaceInit: 'workspace:init',
  WorkspaceTemplates: 'workspace:templates',
  WorkspaceCreate: 'workspace:create',
  WorkspaceDiff: 'workspace:diff',
  WorkspaceSaveSecrets: 'workspace:save-secrets',
  WorkspaceReplaceSecret: 'workspace:replace-secret',
  GitCommit: 'git:commit',
  GitCheckout: 'git:checkout',
  GitCreateBranch: 'git:create-branch',
  GitSync: 'git:sync',
  GitConflictRead: 'git:conflict-read',
  GitConflictResolve: 'git:conflict-resolve',
  GitMergeFinish: 'git:merge-finish',
  GitMergeAbort: 'git:merge-abort',
  GitInstallHook: 'git:install-hook',
  ConnectorsGet: 'connectors:get',
  AuthClear: 'auth:clear',
  ScenariosRun: 'scenarios:run',
  ScenariosCancel: 'scenarios:cancel',
  FlowsList: 'flows:list',
  FlowsSave: 'flows:save',
  FlowsRun: 'flows:run',
  FlowsCancel: 'flows:cancel',
  /** main → renderer: progresso de cada nó durante a execução de um fluxo. */
  FlowsEvent: 'flows:event',
  RegistryGet: 'registry:get',
  LintRun: 'lint:run',
  LintFixDiagrams: 'lint:fix-diagrams',
  ProjectBases: 'catalog:project-bases',
  AiReviewList: 'ai-review:list',
  AiReviewApprove: 'ai-review:approve',
  ConnectorRead: 'connector:read',
  ConnectorSave: 'connector:save',
  SchemaRead: 'schema:read',
  SchemaSave: 'schema:save',
  RegistryValidateBody: 'registry:validate-body',
  DocsGenerate: 'docs:generate',
  DocsSaveMarkdown: 'docs:save-markdown',
  DocsSavePdf: 'docs:save-pdf',
  DocsProject: 'docs:project',
  DocsSaveProject: 'docs:save-project',
  DocsCompile: 'docs:compile',
  DocsPreviewPdf: 'docs:preview-pdf',
  DocsApplyTemplate: 'docs:apply-template',
  DocsSaveTemplate: 'docs:save-template',
  DocsReadDiagram: 'docs:read-diagram',
  DocsSaveDiagram: 'docs:save-diagram',
  DiagramCatalog: 'docs:diagram-catalog',
  DocsFiles: 'docs:files',
  BrandRead: 'brand:read',
  BrandFindings: 'brand:findings',
  BrandSave: 'brand:save',
  DocsReadMarkdownFile: 'docs:read-markdown-file',
  DocsSaveMarkdownFile: 'docs:save-markdown-file',
  DocsRenameFile: 'docs:rename-file',
  DocsDeleteFile: 'docs:delete-file',
  PublishTargets: 'publish:targets',
  PublishInit: 'publish:init',
  PublishSignIn: 'publish:sign-in',
  PublishSignOut: 'publish:sign-out',
  PublishPrepare: 'publish:prepare',
  PublishPlan: 'publish:plan',
  PublishApply: 'publish:apply',
  SecretEngineGet: 'secret-engine:get',
  SecretEngineSet: 'secret-engine:set',
  SecretEngineMode: 'secret-engine:mode',
  PluginsList: 'plugins:list',
  PluginsSetEnabled: 'plugins:set-enabled',
  PluginsPreviewInstall: 'plugins:preview-install',
  PluginsInstall: 'plugins:install',
  PluginsRemove: 'plugins:remove',
  PluginsPreviewArchive: 'plugins:preview-archive',
  PluginsPreviewRegistry: 'plugins:preview-registry',
  PluginsBrowseRegistries: 'plugins:browse-registries',
  PluginsAddRegistry: 'plugins:add-registry',
  PluginsRemoveRegistry: 'plugins:remove-registry',
  PluginsTrustKey: 'plugins:trust-key',
  PluginsUntrustKey: 'plugins:untrust-key',
  PluginsSendRequest: 'plugins:send-request',
  McpServerGet: 'mcp-server:get',
  McpServerSet: 'mcp-server:set',
  McpConnectRepo: 'mcp-server:connect-repo',
  RealtimeOpen: 'realtime:open',
  RealtimeSend: 'realtime:send',
  RealtimeClose: 'realtime:close',
  /** main → renderer: estados e mensagens das conexões realtime, em lotes. */
  RealtimeEvents: 'realtime:events',
  MockGet: 'mock:get',
  MockSet: 'mock:set',
  WebhooksGet: 'webhooks:get',
  WebhooksSet: 'webhooks:set',
  WebhooksList: 'webhooks:list',
  WebhooksEvent: 'webhooks:event',
  WebhooksClear: 'webhooks:clear',
  WebhooksReplay: 'webhooks:replay',
  /** main → renderer: evento novo ou atualizado (resposta, disparo) no servidor de webhooks. */
  WebhooksChanged: 'webhooks:changed',
  RemoteRunTarget: 'remote-run:target',
  RemoteRunPreview: 'remote-run:preview',
  RemoteRunStart: 'remote-run:start',
  RemoteRunPoll: 'remote-run:poll',
  RemoteRunCancel: 'remote-run:cancel',
  IdentityGet: 'identity:get',
  IdentitySetProfile: 'identity:set-profile',
  IdentitySignIn: 'identity:sign-in',
  IdentitySignOut: 'identity:sign-out',
  IdentitySwitchOrganization: 'identity:switch-organization',
  ProjectEdit: 'project:edit',
  ShellReveal: 'shell:reveal',
  /** renderer → main (send): desfazer, recortar, colar... no campo focado (o Electron não tem menu nativo). */
  EditCommand: 'edit:command',
  GitDiscard: 'git:discard',
  SecretReveal: 'secrets:reveal',
  /** main → renderer: a identidade mudou (login, logout, sessão expirada, organização). */
  IdentityChanged: 'identity:changed',
  /** main → renderer: arquivos do workspace mudaram no disco (MCP, CLI, editor, Git). */
  WorkspaceFilesChanged: 'workspace:files-changed',
  /** main → renderer: uma gravação do app deixou problemas que o vvpost validate reprova. */
  WriteProblems: 'workspace:write-problems'
} as const

/** Arquivos do workspace que mudaram no disco, relativos à pasta do projeto aberto ("../" para o Compartilhado). */
export interface WorkspaceFilesChange {
  files: string[]
}

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]

/** Documentação gerada: o modelo (visualização no app) e o Markdown com Mermaid (o .md exportado). */
export interface GeneratedDocs {
  document: ApiDocument
  markdown: string
  /** O modelo do projeto (vvpost.docs.json), que a visualização e o PDF seguem em qualquer nível. */
  template?: DocsTemplate
  /** No escopo do projeto, o documento do projeto (docs/projeto.md), quando existe. */
  composed?: DocsCompileResult
}

/** Modelo da documentação para a visualização: o vvpost.docs.json e o logo como data: URL. */
export interface DocsTemplate {
  config: DocsConfig
  logo?: string
  /**
   * Cores (#RRGGBB) e fontes (pilha de CSS) dos tokens da marca, quando o projeto tem um arquivo de
   * tokens. Valem na visualização e no PDF só com theme.tokens no modelo; o editor mostra o que viria.
   */
  brand?: DocsTemplateBrand
}

export interface DocsTemplateBrand {
  primary?: string
  heading?: string
  text?: string
  font?: string
  headingFont?: string
  /** O arquivo de tokens, relativo ao projeto. */
  file: string
}

/** Modelo e documento-fonte do projeto, para o editor de documentação. */
export type { DiagramBlock, DiagramCatalog, DiagramIconPack }

/** O que o editor de diagramas grava: o arquivo (e a linha do bloco num Markdown), o código e o que foi aberto. */
export interface DiagramSaveInput {
  file: string
  line?: number
  code: string
  previous?: string
  create?: boolean
}

/** Arquivos de documentação do workspace, relativos a ele, para o explorador. */
export interface DocsFileList {
  markdown: string[]
  diagrams: string[]
  /** O documento do projeto (vvpost.docs.json), que também abre no editor com o PDF. */
  sourceFile: string
  /** Os arquivos de tokens da marca (brand/*.tokens.json), relativos ao projeto; podem vir da raiz do workspace (../brand/...). */
  brand?: string[]
}

/** O que a aba de documento grava. */
export interface MarkdownSaveInput {
  file: string
  text: string
  previous?: string
  create?: boolean
}

export interface DocsProjectState extends DocsTemplate {
  configExists: boolean
  /** Problemas do vvpost.docs.json e do logo; com eles, vale o modelo vazio. */
  configIssues: { file: string; message: string }[]
  /** Documento-fonte, relativo ao workspace. */
  sourceFile: string
  /** null: o documento ainda não existe (o editor começa de um modelo). */
  source: string | null
  /** Documento de partida, para quando ainda não existe. */
  starter: string
  /** Markdown do workspace que dá para incluir com {{> include}}, com as seções. */
  markdownFiles: DocsMarkdownFile[]
  /** Imagens do workspace que servem de logo. */
  imageFiles: string[]
  /** Diagramas .mmd do workspace ({{> diagram}} e o editor de diagramas). */
  diagramFiles: string[]
  /** As diretivas {{> ...}} aceitas, para o autocomplete. */
  directives: { kind: string; usage: string; description: string }[]
  /** Modelos de documentação: os do VVPost (C4, arc42, Diátaxis, ADR...), os do projeto e os do usuário. */
  templates: DocTemplateSummary[]
}

export interface DocTemplateSummary {
  id: string
  name: string
  description: string
  origin: DocTemplateOrigin
  file?: string
}

/** Documento atual salvo como modelo próprio: no projeto (Git) ou só para o usuário (todos os projetos). */
export interface DocsTemplateInput extends DocsDraft {
  name: string
  description?: string
  origin: 'project' | 'user'
}

/** O que o editor manda compilar (salvo ou não). */
export interface DocsDraft {
  config: DocsConfig
  source: string
}

/** O documento do projeto montado do documento-fonte, com os diagnósticos por linha. */
export interface DocsCompileResult {
  title: string
  /** O .md completo (título, sumário e corpo). */
  markdown: string
  /** O que vai para o PDF (sem o bloco de título quando o modelo tem capa). */
  printMarkdown: string
  diagnostics: DocDiagnostic[]
  includes: string[]
  /** A linha do documento-fonte de cada linha do printMarkdown (0: criada pela montagem). */
  sourceLines?: number[]
}

export type {
  PublishAction,
  PublishApproval,
  PublishPlan,
  PublishPlanItem,
  PublishResult,
  PublishResultItem,
  PublisherSession
} from '@vvpost/core/docs/publish'

/** Um destino do vvpost.publish.json, com o publicador que o atende e a conta nele. */
export interface PublishTargetSummary {
  id: string
  name: string
  provider: string
  destination: string
  diagrams: 'png' | 'svg' | 'code'
  /** Há publicador para o provider (o Confluence Cloud vem com o VVPost Enterprise). */
  available: boolean
  providerTitle?: string
  /** Exportador para uma pasta do workspace (html, de plugin): sem conta; destination é a pasta. */
  local?: boolean
  session?: import('@vvpost/core/docs/publish').PublisherSession
}

export interface PublishTargetsState {
  configExists: boolean
  issues: { file: string; message: string }[]
  targets: PublishTargetSummary[]
  /** Publicadores disponíveis, para criar o primeiro destino. */
  providers: { id: string; title: string; local?: boolean }[]
}

export interface PublishOutlineNode {
  key: string
  kind: 'folder' | 'page'
  title: string
  source?: string
  children: PublishOutlineNode[]
}

/** O pacote montado: a estrutura e os diagramas que o renderer desenha antes do plano. */
export interface PublishPrepared {
  id: string
  nodes: PublishOutlineNode[]
  pages: number
  diagrams: { id: string; source: string }[]
  diagnostics: DocDiagnostic[]
}

export type PublishApplied = import('@vvpost/core/docs/publish').PublishResult & {
  /** Os ids foram gravados no vvpost.publish.json. */
  recorded: boolean
  warning?: string
}

export type DocsSaveResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'canceled' }
  | { ok: false; reason: 'error'; message: string }

export interface ResourceUsage {
  /** Memória somada de todos os processos do app, em MB (ver `metric`). */
  totalMemoryMB: number
  /** pss no Linux, privateBytes no Windows, workingSet no macOS. */
  metric: 'pss' | 'privateBytes' | 'workingSet'
  /** Memória por tipo de processo (Browser, Tab, GPU, Utility...), em MB. */
  byProcessType: Record<string, number>
  engine: 'ready' | 'starting'
}

/**
 * Histórico rico: cada execução (uma requisição do Quick Request, um lote de
 * cenários, um fluxo, um `vvpost run`) é uma entrada, com as requisições que ela disparou.
 * Quanto de cada requisição vai para o banco depende do nível da origem.
 */
export const HISTORY_LEVELS = ['off', 'metadata', 'headers', 'full'] as const
/**
 * off: não grava. metadata: método, URL como digitada, status, tempos, auth e asserções.
 * headers: mais headers enviados e recebidos, URL resolvida e logs. full: mais os corpos.
 */
export type HistoryLevel = (typeof HISTORY_LEVELS)[number]
export const HISTORY_SOURCES = ['request', 'scenarios', 'flow', 'cli'] as const
export type HistorySource = (typeof HISTORY_SOURCES)[number]
/** passed: tudo certo (2xx/3xx numa requisição avulsa); failed: asserção, nó ou status 4xx/5xx; error: sem resposta. */
export type HistoryOutcome = 'passed' | 'failed' | 'error' | 'canceled'

/** Configurações do cliente HTTP do app (spec, fase 12), em userData; a senha do proxy nunca volta ao renderer. */
export interface HttpSettings {
  proxy: {
    /** off: direto; env: HTTP(S)_PROXY e NO_PROXY; manual: url e bypass; system: o proxy do sistema (e PAC). */
    mode: 'off' | 'env' | 'manual' | 'system'
    url: string
    /** Hosts que não usam o proxy, separados por vírgula. */
    bypass: string
    username: string
    hasPassword: boolean
  }
  /** false aceita certificado inválido em todas as requisições. */
  verifyTls: boolean
  /** Arquivos PEM de CAs extras, além das do sistema. */
  caFiles: string[]
  /** Guardar e reenviar cookies (cookie jar). */
  cookies: boolean
  /** O cofre do sistema está disponível para guardar a senha do proxy. */
  vault: boolean
}

export interface HttpSettingsInput {
  /** password: texto troca a senha, null ou "" apaga, ausente mantém. */
  proxy: Omit<HttpSettings['proxy'], 'hasPassword'> & { password?: string | null }
  verifyTls: boolean
  caFiles: string[]
  cookies: boolean
}

/** Cookie do cookie jar, como a tela de cookies mostra e edita. */
export interface CookieEntry {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  /** Epoch em ms; ausente: cookie de sessão. */
  expires?: number
  secure: boolean
  httpOnly: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  created: number
}

export type CookieInput = Omit<CookieEntry, 'created' | 'sameSite'>

export interface HistorySettings {
  /** Nível de cada origem do app; o CLI escolhe o dele com `--history`. */
  levels: Record<Exclude<HistorySource, 'cli'>, HistoryLevel>
  /** Execuções guardadas; as mais antigas saem. */
  maxRuns: number
  /** Idade máxima em dias; 0 guarda sem limite de idade. */
  maxAgeDays: number
  /** Corpo (de requisição ou de resposta) acima disso é cortado, em KB. */
  maxBodyKB: number
  /** Tamanho somado do que o histórico guarda, em MB; as execuções mais antigas saem. */
  maxSizeMB: number
}

export interface HistoryRunSummary {
  id: number
  /** Epoch em ms. */
  createdAt: number
  source: HistorySource
  level: Exclude<HistoryLevel, 'off'>
  title: string
  outcome: HistoryOutcome
  status: number | null
  errorCode: string | null
  durationMs: number
  connectorId: string | null
  environmentId: string | null
  flowId: string | null
  exchangeCount: number
  totals: { passed: number; failed: number; error: number } | null
  /** Primeira requisição da execução (a única, no Quick Request). */
  method: HttpMethod | null
  url: string | null
  /** Execução refeita a partir desta entrada do histórico. */
  replayOf: number | null
  /** Bytes guardados (JSON dos detalhes e relatório). */
  bytes: number
  /** Rodou num Execution Runner da organização: o id da execução e o Control Plane/projeto. */
  remote: { runId: number; source: string } | null
}

export interface HistoryExchange {
  id: number
  seq: number
  createdAt: number
  /** Cenário ou nó que disparou ("<endpoint>/<cenário>", nome do nó). */
  label: string | null
  ref: { endpointId?: string; scenarioId?: string; nodeId?: string } | null
  method: HttpMethod
  /** Como digitada ou montada, ainda com {{VAR}} (relativa à baseUrl com conector). */
  url: string
  status: number | null
  errorCode: string | null
  errorMessage: string | null
  outcome: HistoryOutcome | null
  durationMs: number
  sizeBytes: number | null
  connectorId: string | null
  environmentId: string | null
  /** Reproduzir refaz a requisição a partir do modelo, resolvendo {{VAR}} de novo. */
  replayable: boolean
  /** Por que não dá para reproduzir (nível baixo, valor mascarado). */
  replayBlocked?: string
  /** Modelo da requisição (headers a partir de `headers`, corpo só em `full`). */
  template?: {
    headers?: HttpHeader[]
    body?: string | null
    /** Corpo estruturado (form, multipart, binário): campos e caminhos dos arquivos, sem os bytes. */
    payload?: RequestPayload
    inheritHeaders?: boolean
    dropHeaders?: string[]
    /** Sem credencial (endpoint público, gate de acesso). */
    anonymous?: boolean
    extra?: Record<string, string>
    /** Fluxo de preparação do Quick Request: Reproduzir roda o fluxo de novo antes. */
    prepareFlowId?: string
    /** Endpoint do conector (os scripts dele e do conector rodam de novo). */
    endpointId?: string
    /** Scripts pre e post da própria requisição (só no nível completo). */
    scripts?: RequestScripts
  }
  /** O que foi para a rede, com herança, auth e {{VAR}} resolvidos e segredos mascarados. */
  sent?: { url: string; headers: HttpHeader[]; body?: string | null }
  response?: {
    status: number
    statusText: string
    headers: HttpHeader[]
    body?: string
    truncated: boolean
    /** O corpo foi cortado em `maxBodyKB` ao gravar. */
    bodyCut?: boolean
    /** Bytes do corpo binário (imagem, PDF...), quando cabem em `maxBodyKB`; a prévia usa. */
    bodyBase64?: string
    sizeBytes: number
  }
  timings?: HttpTimings | { totalMs: number }
  auth?: AuthUsage
  assertions?: AssertionResult[]
  logs?: string
}

export interface HistoryRunDetail extends HistoryRunSummary {
  exchanges: HistoryExchange[]
  /** Relatório da execução, no nível dela (nós do fluxo, erros do lote, resumo do CLI). */
  report: unknown
}

export interface HistoryQuery {
  source?: HistorySource
  outcome?: HistoryOutcome
  /** Procura no título e na URL. */
  search?: string
  /** true: só execuções remotas (Execution Runner); false: só locais. */
  remote?: boolean
  limit?: number
  /** Paginação: só entradas com id menor. */
  beforeId?: number
}

export interface HistoryStats {
  runs: number
  exchanges: number
  /** Bytes guardados (o que conta para `maxSizeMB`). */
  bytes: number
  /** Tamanho do arquivo do banco. */
  fileBytes: number
}

export type HistoryReplayResult =
  | { ok: true; result: HttpResult; runId: number | null }
  | { ok: false; message: string }

/** O que fazer quando o projeto de destino já tem um conector ou ambiente com o mesmo id. */
export type ImportConflictMode =
  /** Mantém o que existe e acrescenta só o que é novo (endpoints, cenários, variáveis). */
  | 'merge'
  /** Importa como item novo, com outro id. */
  | 'rename'
  /** Substitui o que existe pelo importado. */
  | 'replace'

/** Conector do import (`existing` ausente) ou do projeto de destino (`existing: true`). */
export interface ImportConnectorRef {
  id: string
  existing?: boolean
}

/**
 * Ajuste feito na revisão do import, antes de gravar. A lista é reaplicada do zero
 * sobre a conversão, então cada id se refere ao estado depois dos ajustes anteriores.
 */
export type ImportAdjustment =
  | { op: 'renameConnector'; id: string; name: string }
  /** Troca o pai (`extends`); `null` deixa o conector na raiz. */
  | { op: 'setParent'; id: string; parent: ImportConnectorRef | null }
  /** Desfaz a pasta: endpoints e filhos sobem para o pai. */
  | { op: 'dissolveConnector'; id: string }
  /** Não importa o conector nem os filhos dele. */
  | { op: 'excludeConnector'; id: string }
  /** Cria um conector filho com estes endpoints. */
  | { op: 'groupEndpoints'; id: string; endpointIds: string[]; name: string }
  | { op: 'renameEndpoint'; connectorId: string; endpointId: string; name: string }
  | { op: 'moveEndpoint'; connectorId: string; endpointId: string; to: ImportConnectorRef }
  | { op: 'excludeEndpoint'; connectorId: string; endpointId: string }
  /** A requisição vira um cenário de teste de outro endpoint (diferenças viram overrides). */
  | {
      op: 'mergeIntoScenario'
      connectorId: string
      endpointId: string
      into: { connector: ImportConnectorRef; endpointId: string }
      name?: string
    }
  | { op: 'excludeEnvironment'; id: string }
  | { op: 'excludeFlow'; id: string }

/** O que o usuário decidiu na revisão: reenviado a cada mudança e na gravação. */
export interface ImportPlanInput {
  adjustments?: ImportAdjustment[]
  /** Por id importado: o que fazer com conector de id já usado no projeto (padrão: merge). */
  conflicts?: Record<string, ImportConflictMode>
  environmentConflicts?: Record<string, ImportConflictMode>
  flowConflicts?: Record<string, ImportConflictMode>
  /**
   * Reimportação de uma spec OpenAPI, por "<conector>/<endpoint>" do projeto: `spec`
   * aplica a versão da spec (ou apaga, num endpoint que saiu dela) e `keep` deixa o
   * endpoint como está. Padrão: `spec` para o que só mudou na spec, `keep` para conflito e removido.
   */
  syncDecisions?: Record<string, ImportSyncDecision>
  /**
   * A spec do código é a fonte do contrato (vvpost sync, sync_openapi): conflito e endpoint ou schema
   * editado só no projeto ficam com a versão da spec por padrão.
   */
  specWins?: boolean
}

export type ImportSyncDecision = 'spec' | 'keep'

/** O que mudou num campo do endpoint entre o projeto e a spec (valores em JSON, encurtados). */
export interface ImportFieldChange {
  field: string
  before?: string
  after?: string
}

export interface ImportPlanEndpoint {
  id: string
  name: string
  method: HttpMethod
  path: string
  /**
   * `existing`: já está no projeto e não muda. Na reimportação de uma spec: `updated`
   * mudou só na spec, `conflict` mudou na spec e foi editado no projeto, `removed` saiu da spec,
   * `linked` é um endpoint feito à mão que passa a seguir a operação da spec com o mesmo método e
   * caminho, e `edited` (só com `specWins`) foi editado no projeto sem mudança na spec.
   */
  status: 'new' | 'existing' | 'updated' | 'conflict' | 'removed' | 'linked' | 'edited'
  scenarios: { id: string; name: string; isNew: boolean }[]
  /** Reimportação: a chave de `syncDecisions`, o que vale agora e as diferenças. */
  sync?: { key: string; decision: ImportSyncDecision; changes: ImportFieldChange[] }
}

export interface ImportPlanConnector {
  /** Id usado nos ajustes (o do import, antes de um eventual "importar como novo"). */
  key: string
  /** Id final no projeto. */
  id: string
  name: string
  /** `existing`: conector do projeto (recebe algo, ou é pai de um importado). */
  origin: 'imported' | 'existing'
  extends?: string
  baseUrl?: string
  /** O projeto já tem este id: o modo escolhido. */
  conflict?: ImportConflictMode
  /** Conector do projeto que só aparece como pai; nada muda nele. */
  untouched?: boolean
  endpoints: ImportPlanEndpoint[]
}

export interface ImportPlanEnvironment {
  key: string
  id: string
  name: string
  origin: 'imported' | 'existing'
  conflict?: ImportConflictMode
  excluded: boolean
  /** `exists`: a variável já está no ambiente do projeto e o valor de lá é mantido. */
  variables: { name: string; isSecret: boolean; exists: boolean }[]
  secretValues: number
}

/** Fluxo de um pacote do VVPost. Com `merge` (padrão quando o id já existe), o do projeto fica. */
export interface ImportPlanFlow {
  key: string
  id: string
  name: string
  origin: 'imported' | 'existing'
  conflict?: ImportConflictMode
  excluded: boolean
  nodes: number
  /** Conectores usados pelos nós que não estão no import nem no projeto. */
  missingConnectors?: string[]
}

/** Requisição que parece variação de outro endpoint e pode virar cenário dele. */
export interface ImportScenarioSuggestion {
  connectorId: string
  endpointId: string
  endpointName: string
  into: { connectorId: string; endpointId: string; endpointName: string }
  scenarioName: string
}

/** Resumo de um import do Postman, mostrado antes de gravar. Nunca traz valores de segredo. */
export interface PostmanImportPreview {
  /** Identifica o import nas chamadas seguintes. */
  id: string
  sources: { file: string; kind: 'collection' | 'environment' | 'bundle' | 'openapi' | 'insomnia' | 'bruno' | 'har' | 'wsdl'; name: string }[]
  /** Projeto de destino; `null` até o usuário escolher (sem workspace aberto). */
  target: { dir: string; isWorkspace: boolean } | null
  /** Árvore depois dos ajustes, pai antes de filho. */
  connectors: ImportPlanConnector[]
  environments: ImportPlanEnvironment[]
  flows: ImportPlanFlow[]
  /** Conectores que levam documentação Markdown (pacotes do VVPost). */
  docs: number
  /** Conectores do projeto de destino, para mover endpoints ou mesclar cenários neles. */
  projectConnectors: { id: string; name: string; endpoints: { id: string; name: string; method: HttpMethod; path: string }[] }[]
  suggestions: ImportScenarioSuggestion[]
  /** Observações dos ajustes e ajustes que não puderam ser aplicados (pela posição). */
  notes: { source: string; message: string }[]
  adjustmentErrors: { adjustment: number; message: string }[]
  /** Quantos valores reais de segredo vão para o arquivo local de segredos (fora do Git). */
  secretValues: number
  warnings: { source: string; message: string }[]
  /** Arquivos que não puderam ser lidos ou convertidos, e problemas que impedem gravar. */
  errors: { file: string; message: string }[]
  /** Arquivos do projeto que a gravação cria ou altera. */
  changes: { path: string; action: 'create' | 'update' | 'delete' }[]
  /** Há algo para gravar e tudo passou na validação. */
  canWrite: boolean
}

export type PostmanWriteResult =
  | { ok: true; dir: string; written: string[] }
  | { ok: false; reason: 'canceled' }
  | { ok: false; reason: 'error'; message: string }

/**
 * O que vai no pacote de exportação do VVPost. Sem nenhum campo, vai o projeto
 * inteiro; com algum, só o pedido e o que ele precisa (pais por `extends` e os
 * conectores dos fluxos).
 */
/**
 * Formato do arquivo exportado: o pacote do VVPost (tudo, para outro projeto), uma coleção
 * v2.1 do Postman (com um ambiente do Postman por ambiente) ou uma spec OpenAPI 3.1.
 */
export type ExportFormat = 'vvpost' | 'postman' | 'openapi'

export const EXPORT_FORMATS: readonly ExportFormat[] = ['vvpost', 'postman', 'openapi']

export interface ExportSelection {
  /** Padrão: vvpost. Postman e OpenAPI levam conectores e endpoints; cenários e fluxos só vão no pacote. */
  format?: ExportFormat
  connectors?: string[]
  /** "<conector>/<endpoint>": só estes endpoints do conector (que entra junto). */
  endpoints?: string[]
  environments?: string[]
  flows?: string[]
  /** false tira os cenários de teste dos endpoints. Padrão: true. */
  scenarios?: boolean
  /** false não leva a documentação Markdown dos conectores. Padrão: true. */
  docs?: boolean
}

export interface ExportSummary {
  connectors: number
  endpoints: number
  scenarios: number
  environments: number
  flows: number
  docs: number
}

/** O projeto aberto, para escolher o que exportar. Sem valores de variáveis. */
export interface ExportOptions {
  dir: string
  name: string
  connectors: {
    id: string
    name: string
    extends?: string
    hasDocs: boolean
    endpoints: { id: string; name: string; method: HttpMethod; path: string; scenarios: number }[]
  }[]
  environments: { id: string; name: string; variables: number; secrets: number }[]
  flows: { id: string; name: string; nodes: number; connectors: string[] }[]
}

export type ExportPreview =
  | { ok: true; summary: ExportSummary; warnings: string[] }
  | { ok: false; message: string }

export type ExportSaveResult =
  /** `files`: os outros arquivos gravados ao lado (ambientes do Postman). */
  | { ok: true; path: string; files: string[]; summary: ExportSummary; warnings: string[] }
  | { ok: false; reason: 'canceled' }
  | { ok: false; reason: 'error'; message: string }

/** Zip do VVPost (.vvpost.zip): a pasta do workspace inteiro (o Compartilhado e os projetos) ou de um projeto. */
export type ArchiveKind = 'workspace' | 'project'

export interface ArchiveSummary {
  files: number
  /** Projetos dentro do zip (num zip de workspace com projetos). */
  projects: number
  connectors: number
  flows: number
  environments: number
  /** Arquivos Markdown (documento do projeto, guias, docs dos conectores). */
  docs: number
  /** Variáveis secretas que vão sem valor (__REQUIRED_SECRET__). */
  pendingSecrets: number
}

export type ArchiveExportPreview =
  | { ok: true; kind: ArchiveKind; name: string; folder: string; summary: ArchiveSummary; warnings: string[] }
  | { ok: false; message: string }

export type ArchiveExportSaveResult =
  | { ok: true; path: string; kind: ArchiveKind; summary: ArchiveSummary; warnings: string[] }
  | { ok: false; reason: 'canceled' }
  | { ok: false; reason: 'error'; message: string }

/** O zip escolhido para importar, antes de gravar. */
export interface ArchiveImportPreview {
  id: string
  file: string
  kind: ArchiveKind
  name: string
  /** Os projetos do zip, num zip de workspace com projetos. */
  projects: { id: string; name: string }[]
  summary: ArchiveSummary
  warnings: string[]
  /** Há um workspace aberto (para entrar como projeto nele). */
  hasWorkspace: boolean
  /** Como projeto do workspace aberto: o id sugerido e o que impede, se algo impedir. */
  asProject: { id: string; name: string; blocked?: string; taken?: string }
}

export type ArchiveImportChoice = { mode: 'workspace' } | { mode: 'project'; id: string; name: string }

export type ArchiveImportResult =
  | { ok: true; mode: ArchiveImportChoice['mode']; dir: string; written: number; pendingSecrets: number; warnings: string[] }
  | { ok: false; reason: 'canceled' }
  | { ok: false; reason: 'error'; message: string }

/** Corpo de resposta a gravar em arquivo: texto em UTF-8 ou bytes em base64. */
export interface ResponseSaveInput {
  fileName: string
  data: string
  encoding: 'utf8' | 'base64'
}

export type ResponseSaveResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'canceled' }
  | { ok: false; reason: 'error'; message: string }

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

/** Arquivo alterado no working tree ou no index, com caminho relativo à raiz do repositório. */
export interface GitChange {
  path: string
  /** Caminho anterior, em renomeações. */
  origPath?: string
  kind: GitChangeKind
  /** Há mudança no index (staged). */
  staged: boolean
  /** Há mudança no working tree ainda fora do index. */
  unstaged: boolean
}

export interface GitBranch {
  /** Nome curto: `main`, ou `origin/main` para branches remotas. */
  name: string
  current: boolean
  remote: boolean
  upstream?: string
}

/** Segredo que o workspace espera (`__REQUIRED_SECRET__`) e que ainda não tem valor local. */
export interface MissingSecret {
  environmentId: string
  environmentName: string
  /** Arquivo do ambiente, relativo ao workspace. */
  file: string
  variable: string
  description?: string
  placeholder?: string
}

/** Ambiente com segredo em texto puro, que será redigido no próximo commit. */
export interface UnredactedSecrets {
  file: string
  variables: string[]
}

/**
 * configured: o arquivo versionado tem __REQUIRED_SECRET__ e o vault local tem valor; missing: falta
 * o valor local; plaintext: isSecret com o valor em texto puro no arquivo versionado (redigido no
 * próximo commit); unmarked: nome sensível sem isSecret, com valor no arquivo versionado.
 */
export type SecretState = 'configured' | 'missing' | 'plaintext' | 'unmarked'

/** Segredos do workspace por ambiente, sem valores (módulo Secrets). */
export interface SecretInventory {
  dir: string
  /** Onde ficam os valores, para a interface: o cofre local, fora da pasta, e onde fica a chave. */
  storeFile: string
  environments: {
    id: string
    name: string
    file: string
    /**
     * Num projeto, o ambiente só existe no Compartilhado (a raiz): vale aqui, mas renomear,
     * excluir e editar variáveis se faz na raiz. Ausente na raiz e nos ambientes do projeto.
     */
    shared?: true
    /** `shared`: o segredo vem do ambiente do Compartilhado; o valor fica no cofre da raiz. */
    secrets: { variable: string; state: SecretState; description?: string; placeholder?: string; shared?: true }[]
    /** O arquivo não passa no schema (ex.: segredo em texto puro): o app não edita até corrigir. */
    problem?: string
    /**
     * Todas as variáveis do ambiente, para editar no app. `value` só vem das que não são segredo
     * nem têm nome de credencial: o resto nunca sai do main.
     */
    variables: {
      name: string
      type: 'string' | 'number' | 'boolean'
      isSecret: boolean
      value?: string | number | boolean
      description?: string
      /** Declarada só no ambiente do Compartilhado (o projeto herda): edita-se na raiz. */
      shared?: true
    }[]
  }[]
}

/** Resumo barato do workspace aberto para o shell (cabeçalho e barra de status), sem carregar o Git. */
export interface WorkspaceInfo {
  dir: string
  /** Nome da pasta. */
  name: string
  /** Branch lida de .git/HEAD; null fora de um repositório ou com HEAD destacado. */
  branch: string | null
  /**
   * Os projetos do workspace (docs/git-workspace.md, Projetos), quando ele tem algum. `current`
   * é o aberto; null é o Compartilhado, na raiz.
   */
  projects?: { root: string; list: { id: string; name: string; description?: string }[]; current: string | null }
}

/** O que "Converter para fluxos" faria ou fez (vvpost migrate). */
/** Um schema compartilhado do catálogo, como está no arquivo. */
export interface SharedSchemaSource {
  name: string
  /** Caminho relativo ao workspace ("../schemas/..." para o do Compartilhado). */
  file: string
  schema: Record<string, unknown>
  /** "<conector>/<endpoint>" (ou "...#<exemplo>") de cada uso. */
  uses: string[]
  /** De onde vem, quando é só de leitura aqui. */
  readOnly?: string
  version: string | null
}

export interface ProjectMigration {
  /** Conectores convertidos (ou que a prévia converteria). */
  converted: string[]
  /** Schemas repetidos que viram compartilhados (schemas/), com quantas cópias cada um substitui. */
  schemas?: { name: string; uses: number }[]
  /** Os que ficam no formato antigo, com o motivo. */
  skipped: { id: string; reason: string }[]
  changes: { path: string; action: 'create' | 'update' | 'delete' }[]
  errors: string[]
}

export type ProjectTemplateId = 'empty' | 'rest-api'

/** Modelo de projeto novo: o que ele cria, para a pessoa saber antes de escolher a pasta. */
export interface ProjectTemplate {
  id: ProjectTemplateId
  name: string
  description: string
  /** Caminhos que o modelo grava, relativos à pasta do projeto. */
  files: string[]
}

export interface WorkspaceState {
  /** Pasta do workspace: a raiz do repositório quando há um. */
  dir: string
  isRepo: boolean
  /** null com HEAD destacado ou fora de um repositório. */
  branch: string | null
  /** Hash curto do HEAD; null num repositório sem commits. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  changes: GitChange[]
  branches: GitBranch[]
  remotes: string[]
  missingSecrets: MissingSecret[]
  unredacted: UnredactedSecrets[]
  /** O arquivo local de segredos está versionado no Git: os valores já vazaram para o histórico. */
  secretsFileTracked: boolean
  /** Operação parada no meio esperando o usuário (merge com conflitos, rebase feito no terminal...). */
  operation: GitOperation | null
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

/** Arquivo em conflito com as versões de cada lado; null quando aquele lado apagou o arquivo. */
export interface ConflictFile {
  path: string
  /** Ancestral comum. */
  base: string | null
  /** Branch local (HEAD). */
  ours: string | null
  /** O que veio do remoto. */
  theirs: string | null
  /** Arquivo no disco, com os marcadores de conflito; null se não existe no disco. */
  working: string | null
  /** Arquivo grande ou binário demais para resolver no app. */
  tooLarge?: boolean
}

/** Como resolver um arquivo em conflito: um lado inteiro, ou o texto final. */
export type ConflictResolution = { use: 'ours' | 'theirs' } | { content: string }

/** Operações do Git voltam como valor: o IPC perde o tipo de exceções. */
/** Arquivo de dados lido para a execução orientada a dados (ScenarioRunInput.data). */
export interface DataFile {
  name: string
  columns: string[]
  rows: Record<string, string>[]
}

/** Um achado do lint (docs/lint.md), como o painel do Catálogo mostra. */
export interface LintFindingView {
  code: string
  message: string
  severity: 'error' | 'warn' | 'info' | 'hint'
  file: string
  line?: number
  label?: string
  hint?: string
  format: 'vvpost' | 'oas3'
  target?:
    | { kind: 'connector'; connectorId: string }
    | { kind: 'endpoint'; connectorId: string; endpointId: string }
    | { kind: 'scenario'; connectorId: string; endpointId: string; scenarioId: string }
    | { kind: 'environment'; environmentId: string; variable?: string }
    | { kind: 'flow'; flowId: string; file: string }
    | { kind: 'doc'; file: string; line?: number }
}

export interface LintReport {
  findings: LintFindingView[]
  summary: { error: number; warn: number; info: number; hint: number }
  /** Arquivo do ruleset do time; ausente: o vvpost:recommended. */
  ruleset?: string
  issues: string[]
  /** Achados de diagrama que o VVPost corrige sozinho (fixDiagrams). */
  fixable: number
}

/** Correções de diagramas de arquitetura, por arquivo (lint/architecture.ts). */
export interface DiagramFixReport {
  files: { file: string; fixes: { code: string; message: string; line?: number }[]; removed: string[]; added: string[] }[]
  total: number
}

export type WorkspaceResult<T = WorkspaceState> = { ok: true; value: T } | { ok: false; message: string }

export interface GitCommitOutcome {
  state: WorkspaceState
  /** Hash curto do commit criado; null quando, redigidos os segredos, não sobrou mudança. */
  commit: string | null
  /** Ambientes que tiveram segredos movidos para o cofre local antes do commit. */
  redacted: UnredactedSecrets[]
  /** Caminhos commitados (inclui o .gitignore quando a proteção do arquivo de segredos foi acrescentada). */
  committed: string[]
}

export interface FileDiff {
  path: string
  /** Versão no HEAD; null em arquivo novo. */
  before: string | null
  /** Versão que vai para o commit (working tree com segredos redigidos); null em arquivo apagado. */
  after: string | null
  /** O arquivo é grande ou binário demais para comparar. */
  tooLarge?: boolean
}

export type GitSyncAction = 'fetch' | 'pull' | 'push'

/** Fluxo do Flow Studio, como no arquivo *.flow.vvpost.json. */
export type { PayloadFormField } from '@vvpost/schemas'
export type { Connector, Flow, FlowNode, FlowEdge, FlowRequest, FlowCondition, FlowPlugin, FlowWebhook, PluginField }

/** API exposta ao renderer via contextBridge, em `window.vvpost`. */
export interface VvpostApi {
  getResourceUsage(): Promise<ResourceUsage>
  /** Sinaliza o primeiro paint ao benchmark. Não faz nada fora do modo bench. */
  reportFirstPaint(): void
  /** Evento do teste com usuários. Não faz nada fora do modo de estudo. */
  trackUx(type: string, data?: Record<string, string | number | boolean | undefined>): void
  /** O modo de estudo está gravando (a status bar avisa o participante). */
  getUxStudyStatus(): Promise<boolean>
  /** Dispara a requisição pelo dispatcher do main process e grava no histórico. */
  sendRequest(input: HttpRequestInput): Promise<HttpResult>
  cancelRequest(id: string): Promise<void>
  /** O fluxo script → requisição → script que roda por trás de uma requisição com scripts ("Ver como fluxo"). */
  requestScriptFlow(input: HttpRequestInput): Promise<WorkspaceResult<Flow>>
  listHistory(query?: HistoryQuery): Promise<HistoryRunSummary[]>
  getHistoryRun(id: number): Promise<HistoryRunDetail | null>
  deleteHistoryRun(id: number): Promise<void>
  clearHistory(): Promise<void>
  /** Refaz uma requisição do histórico pelo modelo dela (re-resolve {{VAR}} e a auth). */
  replayHistory(exchangeId: number): Promise<HistoryReplayResult>
  getHistorySettings(): Promise<HistorySettings>
  setHistorySettings(settings: HistorySettings): Promise<HistorySettings>
  getHistoryStats(): Promise<HistoryStats>
  /**
   * Escolhe arquivos (Postman, pacotes do VVPost, OpenAPI, Insomnia, Bruno, HAR, WSDL) ou, com
   * `folder`, a pasta de uma coleção do Bruno, e converte, sem gravar. O destino padrão é o
   * workspace aberto; `null` se o usuário cancelar.
   */
  previewPostmanImport(options?: { folder?: boolean }): Promise<PostmanImportPreview | null>
  /** Reaplica os ajustes da revisão e devolve a nova prévia. */
  planPostmanImport(previewId: string, input: ImportPlanInput): Promise<PostmanImportPreview>
  /** Pergunta outra pasta de destino; `null` se o usuário cancelar. */
  choosePostmanImportTarget(previewId: string, input: ImportPlanInput): Promise<PostmanImportPreview | null>
  /** Grava no destino (pergunta a pasta se ainda não houver uma), tudo ou nada. */
  writePostmanImport(previewId: string, input: ImportPlanInput): Promise<PostmanWriteResult>
  /** Baixa uma spec OpenAPI/Swagger (ou outro arquivo de import) pela URL e abre a revisão. */
  previewUrlImport(url: string): Promise<PostmanImportPreview>
  /** Lê de novo a spec de onde o conector (ou o raiz dele) foi importado e abre a revisão da reimportação. */
  previewSpecReimport(connectorId: string): Promise<PostmanImportPreview>
  /** Conectores, endpoints, ambientes e fluxos do projeto aberto; null sem workspace. */
  getExportOptions(): Promise<ExportOptions | null>
  /** Monta o pacote sem gravar: o que vai e os avisos (ou por que seria recusado). */
  previewExport(selection: ExportSelection): Promise<ExportPreview>
  /** Pergunta onde salvar e grava o pacote .vvpost.bundle.json. */
  saveExport(selection: ExportSelection, meta: { name?: string; description?: string }): Promise<ExportSaveResult>
  /** Monta o .zip do projeto aberto ou do workspace inteiro sem gravar: o que vai e os avisos. */
  previewArchiveExport(scope: ArchiveKind): Promise<ArchiveExportPreview>
  /** Pergunta onde salvar e grava o .vvpost.zip. */
  saveArchiveExport(scope: ArchiveKind, meta: { name?: string }): Promise<ArchiveExportSaveResult>
  /** Escolhe um .zip do VVPost e lê, sem gravar; null se o usuário cancelar. */
  previewArchiveImport(): Promise<ArchiveImportPreview | null>
  /** Grava o zip: como workspace novo (pergunta a pasta vazia e abre) ou como projeto do workspace aberto. */
  writeArchiveImport(previewId: string, choice: ArchiveImportChoice): Promise<ArchiveImportResult>
  /** Pergunta onde salvar e grava o corpo da resposta (Salvar resposta em arquivo). */
  saveResponse(input: ResponseSaveInput): Promise<ResponseSaveResult>
  /** Escolhe um arquivo (corpo binário, campo de arquivo do multipart, CA); null se cancelar. */
  pickFile(purpose: 'body' | 'ca'): Promise<string | null>
  /** Escolhe e lê um arquivo de dados (CSV ou JSON) para os cenários rodarem uma vez por linha; null se cancelar. */
  pickDataFile(): Promise<WorkspaceResult<DataFile> | null>
  getHttpSettings(): Promise<HttpSettings>
  setHttpSettings(settings: HttpSettingsInput): Promise<HttpSettings>
  listCookies(): Promise<CookieEntry[]>
  /** Cria ou troca um cookie (mesmo nome, domínio e caminho) e devolve a lista. */
  setCookie(cookie: CookieInput): Promise<CookieEntry[]>
  /** Apaga por domínio, nome e caminho (sem filtro: todos) e devolve a lista. */
  deleteCookies(filter?: { domain?: string; name?: string; path?: string }): Promise<CookieEntry[]>
  /**
   * Grava um valor como variável do ambiente ("Use as variable" do DataPicker). Nomes sensíveis e
   * variáveis já secretas vão para o vault local, fora do Git.
   */
  setEnvironmentVariable(input: {
    environmentId: string
    name: string
    value: string | number | boolean
  }): Promise<WorkspaceResult<{ file: string; secret: boolean }>>
  /** Último workspace aberto, ou null. Recarrega o status do Git. */
  getWorkspace(): Promise<WorkspaceResult<WorkspaceState | null>>
  /** Pasta e branch do workspace aberto, sem carregar o módulo do Git. null sem workspace. */
  getWorkspaceInfo(): Promise<WorkspaceInfo | null>
  /** Abre outro projeto do mesmo workspace (null: o Compartilhado, na raiz). */
  switchProject(id: string | null): Promise<WorkspaceResult<WorkspaceInfo | null>>
  /** Cria um projeto no workspace aberto e já abre nele. */
  createWorkspaceProject(input: { name: string; description?: string }): Promise<WorkspaceResult<WorkspaceInfo | null>>
  /** Converte os conectores do formato antigo em fluxos; com dryRun, só mostra o que mudaria. */
  migrateProject(dryRun: boolean): Promise<WorkspaceResult<ProjectMigration | null>>
  /** Estado dos segredos por ambiente, sem valores. null sem workspace. */
  getSecretInventory(): Promise<WorkspaceResult<SecretInventory | null>>
  /** Abre o seletor de pasta. Resultado null se o usuário cancelar. */
  openWorkspace(): Promise<WorkspaceResult<WorkspaceState | null>>
  /** Pergunta a pasta onde clonar e clona `url` numa subpasta com o nome do repositório. */
  cloneWorkspace(url: string): Promise<WorkspaceResult<WorkspaceState | null>>
  /** `git init` no workspace aberto. */
  initWorkspace(): Promise<WorkspaceResult>
  listProjectTemplates(): Promise<ProjectTemplate[]>
  /**
   * Pergunta a pasta (vazia) do projeto novo, grava o modelo, abre como workspace e, com `git`,
   * inicia o repositório. null se o usuário cancelar.
   */
  createProject(input: { template: ProjectTemplateId; git: boolean }): Promise<WorkspaceResult<WorkspaceState | null>>
  /** Diff do arquivo entre o HEAD e o que vai para o commit. */
  diffFile(path: string): Promise<WorkspaceResult<FileDiff>>
  /** Grava valores de segredo no arquivo local (fora do Git). Os valores nunca voltam ao renderer. */
  saveSecrets(values: { environmentId: string; variable: string; value: string }[]): Promise<WorkspaceResult>
  /** Troca o valor de um segredo já configurado no vault local (só variáveis com isSecret). */
  replaceSecret(value: { environmentId: string; variable: string; value: string }): Promise<WorkspaceResult>
  /** Redige segredos dos ambientes escolhidos e commita só esses caminhos. */
  commit(message: string, paths: string[]): Promise<WorkspaceResult<GitCommitOutcome>>
  checkoutBranch(name: string): Promise<WorkspaceResult>
  createBranch(name: string): Promise<WorkspaceResult>
  /** Pull faz fast-forward ou merge; com conflito, o estado volta com operation 'merge'. */
  sync(action: GitSyncAction): Promise<WorkspaceResult>
  /** As versões do arquivo em conflito, para resolver no app. */
  readConflict(path: string): Promise<WorkspaceResult<ConflictFile>>
  /** Grava a resolução (ambientes saem redigidos) e marca o arquivo como resolvido. */
  resolveConflict(path: string, resolution: ConflictResolution): Promise<WorkspaceResult>
  /** Commit de merge, depois de todos os conflitos resolvidos. */
  finishMerge(): Promise<WorkspaceResult<{ state: WorkspaceState; commit: string }>>
  /** Desfaz o merge em andamento e volta ao estado de antes do pull. */
  abortMerge(): Promise<WorkspaceResult>
  /** Instala o hook de pre-commit com o leak guard (vvpost guard), para commits feitos fora do app. */
  installCommitHook(): Promise<WorkspaceResult<{ file: string; status: 'installed' | 'updated' | 'unchanged' }>>
  /** Conectores e ambientes do workspace aberto, relidos do disco. null sem workspace aberto. */
  getConnectorCatalog(): Promise<WorkspaceResult<ConnectorCatalog | null>>
  /** Descarta os tokens em memória do conector (o que define a auth), ou de todos. */
  clearAuthCache(connectorId?: string): Promise<void>
  /** Roda os cenários de teste em lote pelo dispatcher e pela auth headless. */
  runScenarios(input: ScenarioRunInput): Promise<ScenarioRunReport>
  cancelScenarios(runId: string): Promise<void>
  /** Fluxos (*.flow.vvpost.json) do workspace aberto, relidos do disco. null sem workspace. */
  listFlows(): Promise<WorkspaceResult<FlowCatalog | null>>
  /**
   * Valida e grava o fluxo. Sem `file`, cria flows/<id>.flow.vvpost.json (recusa se o
   * id já existe em outro arquivo); com `file`, regrava esse arquivo.
   */
  /** expected: a versão de quando o fluxo abriu (listFlows); outra no disco recusa sem gravar. */
  saveFlow(flow: Flow, file?: string, expected?: string | null): Promise<WorkspaceResult<{ file: string; version?: string | null }>>
  /** Roda o fluxo no main process; o progresso chega por `onFlowEvent`. */
  runFlow(input: FlowRunInput): Promise<FlowRunReport>
  cancelFlow(runId: string): Promise<void>
  /** Assina os eventos de execução de fluxos; devolve a função que cancela a assinatura. */
  onFlowEvent(listener: (event: FlowRunEvent) => void): () => void
  getIdentity(): Promise<IdentityState>
  setLocalProfile(input: { displayName: string }): Promise<WorkspaceResult<IdentityState>>
  /** Só com o módulo Enterprise (`enterprise` não nulo); sem ele, responde com erro. */
  signIn(): Promise<WorkspaceResult<IdentityState>>
  signOut(): Promise<WorkspaceResult<IdentityState>>
  switchOrganization(id: string): Promise<WorkspaceResult<IdentityState>>
  onIdentityChanged(listener: (state: IdentityState) => void): () => void
  /** Assina as mudanças de arquivos do workspace no disco; devolve a função que cancela a assinatura. */
  onWorkspaceFilesChanged(listener: (change: WorkspaceFilesChange) => void): () => void
  /** Assina os problemas que uma gravação do app deixou (uma linha por problema). */
  onWriteProblems(listener: (problems: string[]) => void): () => void
  /** Catálogo com hierarquia e documentação viva, relido do disco. null sem workspace aberto. */
  getConnectorRegistry(): Promise<WorkspaceResult<ConnectorRegistry | null>>
  /** Lint do projeto com o ruleset do time (ou o vvpost:recommended). null sem workspace aberto. */
  lintWorkspace(): Promise<WorkspaceResult<LintReport | null>>
  /** Corrige os diagramas de arquitetura que divergem do catálogo; sem apply, só o plano. */
  fixDiagrams(apply: boolean): Promise<WorkspaceResult<DiagramFixReport | null>>
  /** Bases dos outros projetos ("<projeto>:<id>") para o conector de um nó; vazio fora de um projeto. */
  getProjectBases(): Promise<WorkspaceResult<CatalogConnector[]>>
  /** O que a IA mudou pelo MCP e espera a revisão do usuário (auth e destino de conectores, código de fluxos). */
  listAiReview(): Promise<WorkspaceResult<AiReviewItem[]>>
  /** Confirma a revisão: sem `keys`, de todos. Devolve as chaves confirmadas. */
  approveAiReview(keys?: string[]): Promise<WorkspaceResult<string[]>>
  /** O conector como está no arquivo (sem herança aplicada), para editar no app. */
  readConnector(connectorId: string): Promise<WorkspaceResult<ConnectorSource>>
  /** Um schema compartilhado (schemas/<nome>.schema.json) e os endpoints que o citam, para o editor de campos. */
  readSharedSchema(name: string): Promise<WorkspaceResult<SharedSchemaSource>>
  /** Grava o schema compartilhado; expected é a versão de readSharedSchema (outra no disco recusa). */
  saveSharedSchema(name: string, schema: Record<string, unknown>, expected?: string | null): Promise<WorkspaceResult<{ file: string; version: string | null }>>
  /**
   * Valida e grava o conector. Sem `file`, cria connectors/<id>.connector.vvpost.json;
   * com `file`, regrava esse arquivo. Recusa id repetido e credencial literal.
   */
  /** expected: a versão de readConnector; outra no disco recusa sem gravar. */
  saveConnector(connector: Connector, file?: string, expected?: string | null): Promise<WorkspaceResult<{ file: string; version?: string | null }>>
  /** Confere um corpo JSON com o bodySchema do endpoint (variáveis {{VAR}} inteiras são aceitas). */
  validateEndpointBody(connectorId: string, endpointId: string, body: string): Promise<BodyValidation>
  /** Documentação rica de um nível da hierarquia (projeto, conector, endpoint ou request), sem valores de segredo. */
  generateDocs(scope: DocScope): Promise<WorkspaceResult<GeneratedDocs>>
  /**
   * Gera de novo no main e grava o .md onde o usuário escolher. No escopo do projeto, `generated`
   * grava a referência gerada mesmo quando há documento do projeto.
   */
  saveDocsMarkdown(scope: DocScope, generated?: boolean): Promise<DocsSaveResult>
  /**
   * Imprime o HTML da visualização em PDF (conferido contra os segredos do workspace), no formato
   * do modelo do projeto; `cover`: com a capa do modelo (o documento do projeto).
   */
  saveDocsPdf(title: string, html: string, cover?: boolean): Promise<DocsSaveResult>
  /** Modelo e documento-fonte do projeto, para o editor de documentação. */
  docsProject(): Promise<WorkspaceResult<DocsProjectState>>
  /** Grava o vvpost.docs.json e o documento-fonte (recusa valor de segredo e caminho fora do workspace). */
  saveDocsProject(draft: DocsDraft): Promise<WorkspaceResult<{ files: string[] }>>
  /** Monta o documento do projeto a partir do rascunho do editor, sem gravar nada. */
  compileDocs(draft: DocsDraft): Promise<WorkspaceResult<DocsCompileResult>>
  /** Rascunho que um modelo de documentação dá ao projeto, mantendo título, organização, logo e fonte. */
  applyDocsTemplate(id: string, current: DocsConfig): Promise<WorkspaceResult<DocsDraft>>
  /** Grava o documento como modelo próprio (recusa valor de segredo). */
  saveDocsTemplate(input: DocsTemplateInput): Promise<WorkspaceResult<DocTemplateSummary>>
  /** Um diagrama .mmd do workspace, para o editor de diagramas. */
  readDiagram(file: string): Promise<WorkspaceResult<string>>
  /** Grava o diagrama onde ele vive (bloco ```mermaid de um Markdown ou .mmd), se nada mudou desde a abertura. */
  saveDiagram(input: DiagramSaveInput): Promise<WorkspaceResult<{ file: string; line?: number }>>
  /** Ícones e blocos que os plugins ligados trazem para o editor de diagramas. */
  diagramCatalog(): Promise<WorkspaceResult<DiagramCatalog>>
  /** Documentos .md e diagramas .mmd do workspace (o explorador), e o documento do projeto. */
  docsFiles(): Promise<WorkspaceResult<DocsFileList>>
  /** Um arquivo de tokens da marca, já formatado para a aba (tokens, modos, contraste, problemas). */
  readBrandFile(file: string): Promise<WorkspaceResult<BrandFileView>>
  /** O código do frontend conferido contra os tokens (os achados brand-*). */
  brandFindings(): Promise<WorkspaceResult<{ items: BrandItem[]; scanned: number }>>
  /** Grava o arquivo de tokens (JSON válido, sem segredo, sem sobrescrever mudança feita fora desde `previous`). */
  saveBrandFile(input: { file: string; text: string; previous?: string }): Promise<WorkspaceResult<{ file: string }>>
  /** Um documento .md do workspace, para a aba de documento. */
  readMarkdownFile(file: string): Promise<WorkspaceResult<string>>
  /** Grava um .md do workspace (sem segredo, sem sobrescrever mudança feita fora desde `previous`). */
  saveMarkdownFile(input: MarkdownSaveInput): Promise<WorkspaceResult<{ file: string }>>
  /** Renomeia ou move um documento .md ou diagrama .mmd do workspace (explorador). */
  renameDocsFile(input: { from: string; to: string }): Promise<WorkspaceResult<{ file: string }>>
  /** Exclui um documento .md ou diagrama .mmd do workspace (explorador). */
  deleteDocsFile(file: string): Promise<WorkspaceResult<{ file: string }>>
  /** Destinos do "Enviar para…" (vvpost.publish.json) e os publicadores disponíveis. */
  publishTargets(): Promise<WorkspaceResult<PublishTargetsState>>
  /** Cria o vvpost.publish.json com um destino de partida. */
  publishInit(provider: string, destination: string): Promise<WorkspaceResult<{ file: string }>>
  /** Login no destino pelo navegador do sistema; devolve a conta. */
  /** credential: o que a pessoa colou, num publicador com session.credential (os de plugins). */
  publishSignIn(targetId: string, credential?: string): Promise<WorkspaceResult<import('@vvpost/core/docs/publish').PublisherSession>>
  publishSignOut(targetId: string): Promise<WorkspaceResult<void>>
  /** Monta o pacote do destino (sem segredos) e devolve a estrutura e os diagramas a desenhar. */
  publishPrepare(targetId: string): Promise<WorkspaceResult<PublishPrepared>>
  /** Plano do publicador com os diagramas já desenhados (SVG); nada muda no destino. */
  publishPlan(id: string, images: { id: string; svg: string }[]): Promise<WorkspaceResult<import('@vvpost/core/docs/publish').PublishPlan>>
  /** Publica o que a pessoa confirmou. */
  publishApply(id: string, approval: import('@vvpost/core/docs/publish').PublishApproval): Promise<WorkspaceResult<PublishApplied>>
  /** PDF da prévia do editor: o HTML compilado no formato do rascunho do modelo, sem gravar. */
  previewDocsPdf(config: DocsConfig, title: string, html: string): Promise<WorkspaceResult<Uint8Array>>
  /** Estado do Secret Engine (mock local na porta 4460). Não carrega o servidor. */
  getSecretEngine(): Promise<SecretEngineState>
  /** Liga ou desliga o mock de Secret Managers do workspace aberto. */
  setSecretEngine(enabled: boolean): Promise<SecretEngineState>
  /** Troca entre Local Mock e Cloud Proxy (só nesta sessão do app; o arquivo do workspace não muda). Ligado, reinicia. */
  setSecretEngineMode(mode: 'localMock' | 'enterpriseProxy'): Promise<SecretEngineState>
  /** Plugins oficiais e instalados, relidos do disco. Não sobe nenhum worker. */
  listPlugins(): Promise<WorkspaceResult<PluginCatalog>>
  setPluginEnabled(id: string, enabled: boolean): Promise<WorkspaceResult<PluginCatalog>>
  /** Pergunta a pasta do plugin e mostra o que seria instalado. null se o usuário cancelar. */
  previewPluginInstall(): Promise<WorkspaceResult<PluginInstallPreview | null>>
  /** Pergunta o pacote (.zip, .tgz) e mostra o que seria instalado. null se o usuário cancelar. */
  previewPluginArchive(): Promise<WorkspaceResult<PluginInstallPreview | null>>
  /** Baixa a versão (padrão: a mais nova) do plugin de um registro e mostra o que seria instalado. */
  previewPluginFromRegistry(registryUrl: string, pluginId: string, version?: string): Promise<WorkspaceResult<PluginInstallPreview>>
  /** O que cada registro configurado oferece. */
  browsePluginRegistries(): Promise<WorkspaceResult<PluginRegistryListing[]>>
  addPluginRegistry(url: string): Promise<WorkspaceResult<PluginCatalog>>
  removePluginRegistry(url: string): Promise<WorkspaceResult<PluginCatalog>>
  /** Confia numa chave de assinatura de plugins (com um nome para mostrar). */
  trustPluginKey(publicKey: string, name: string): Promise<WorkspaceResult<PluginCatalog>>
  untrustPluginKey(publicKey: string): Promise<WorkspaceResult<PluginCatalog>>
  /** Chama o adapter de um plugin (gRPC, Kafka...) pelo Quick Request; cancela com `cancelRequest(id)`. */
  sendPluginRequest(input: PluginRequestInput): Promise<HttpResult>
  /** Copia o plugin pré-visualizado para a pasta de plugins do usuário; trustKey passa a confiar na chave que o assinou. */
  installPlugin(previewId: string, options?: { trustKey?: boolean }): Promise<WorkspaceResult<PluginCatalog>>
  /** Apaga um plugin instalado pelo usuário. */
  removePlugin(id: string): Promise<WorkspaceResult<PluginCatalog>>
  /** Abre um WebSocket, SSE ou Socket.IO com o conector e o ambiente; estados e mensagens chegam por onRealtimeEvents. */
  openRealtime(input: RealtimeOpenInput): Promise<WorkspaceResult<null>>
  /** Envia uma mensagem (WebSocket) ou um evento (Socket.IO) pela conexão aberta. */
  sendRealtime(id: string, message: { data: string; event?: string }): Promise<WorkspaceResult<null>>
  closeRealtime(id: string): Promise<void>
  onRealtimeEvents(listener: (events: RealtimeEvent[]) => void): () => void
  /** Estado do servidor MCP do app (HTTP/SSE em loopback). Não carrega o servidor. */
  getMcpServer(): Promise<McpServerState>
  /** Liga ou desliga o servidor MCP do workspace aberto. */
  setMcpServer(enabled: boolean): Promise<McpServerState>
  /**
   * Escolhe um repositório de código e o liga ao VVPost: o servidor MCP do app nos clientes de IA e a
   * regra do VVPost no CLAUDE.md / AGENTS.md dele. null: a pessoa cancelou.
   */
  connectCodeRepo(clients: McpClientId[]): Promise<ConnectRepoResult | null>
  /** Estado do servidor local de webhooks. Não carrega o servidor. */
  /** Estado do mock server (exemplos de resposta dos endpoints). Não carrega o servidor. */
  getMockServer(): Promise<MockServerState>
  /** Liga ou desliga o mock server do workspace aberto (127.0.0.1:4490). */
  setMockServer(enabled: boolean): Promise<MockServerState>
  getWebhookServer(): Promise<WebhookServerState>
  /** Liga ou desliga o servidor de webhooks do workspace aberto. */
  setWebhookServer(enabled: boolean): Promise<WebhookServerState>
  /** Eventos recebidos, do mais novo para o mais antigo, sem headers nem corpo. */
  listWebhookEvents(): Promise<WebhookEventSummary[]>
  /** O evento inteiro (headers e corpo), ou null se já saiu da memória. */
  getWebhookEvent(id: number): Promise<WebhookEvent | null>
  clearWebhookEvents(): Promise<void>
  /** Manda o evento de novo ao servidor, como chegou (vira um evento novo e dispara de novo). */
  replayWebhookEvent(id: number): Promise<WorkspaceResult<{ id: number | null; status: number }>>
  /** Assina as mudanças da lista de eventos; devolve a função que cancela a assinatura. */
  onWebhookChange(listener: (change: WebhookChangeEvent) => void): () => void
  /** Projeto do Control Plane para execuções remotas; null sem VVPost Enterprise com Control Plane. */
  getRemoteRunTarget(): Promise<RemoteRunTarget | null>
  /** Envia o workspace aberto (sem segredos) para a fila dos runners. */
  /** O que vai para o runner, para confirmar antes. Não envia nada. */
  previewRemoteRun(selection: RemoteRunSelection): Promise<WorkspaceResult<RemoteRunPreview>>
  startRemoteRun(selection: RemoteRunSelection): Promise<WorkspaceResult<RemoteRun>>
  /** Eventos depois de `after` e o estado; no fim, o relatório. */
  pollRemoteRun(id: number, after: number): Promise<WorkspaceResult<RemoteRunPoll>>
  cancelRemoteRun(id: number): Promise<WorkspaceResult<RemoteRun>>
  /**
   * Edição do projeto pelos menus (duplicar, renomear, mover, excluir), pela mesma camada
   * em lote do importador e do MCP: tudo ou nada.
   */
  editProject(ops: ProjectEdit[]): Promise<WorkspaceResult<{ changed: string[] }>>
  /** Mostra no explorador de arquivos um caminho do workspace ('' é a pasta) ou a pasta de um plugin. */
  revealInFolder(target: RevealTarget): Promise<WorkspaceResult<null>>
  /** Comando de edição no campo focado. */
  editCommand(command: EditCommand): void
  /** Volta os arquivos ao HEAD (um arquivo novo é apagado). */
  discardChanges(paths: string[]): Promise<WorkspaceResult<WorkspaceState>>
  /**
   * Valor de um segredo do vault local, pedido pelo usuário (menu do Secrets, com confirmação).
   * `copy` grava na área de transferência pelo main e limpa depois de 30 s, sem o valor
   * passar pelo renderer; sem `copy`, devolve o valor para mostrar por alguns segundos.
   */
  revealSecret(environmentId: string, variable: string, copy: boolean): Promise<WorkspaceResult<{ value?: string }>>
}

/** Operações que a interface pode pedir a editProject (as de segredo ficam de fora). */
export type ProjectEdit =
  | { op: 'upsertConnector'; connector: Connector }
  | { op: 'moveConnector'; id: string; newId?: string; extends?: string | null }
  | { op: 'deleteConnector'; id: string }
  | { op: 'upsertEndpoint'; connectorId: string; endpoint: Endpoint; index?: number }
  | { op: 'moveEndpoint'; connectorId: string; endpointId: string; toConnectorId?: string; newId?: string; index?: number }
  | { op: 'deleteEndpoint'; connectorId: string; endpointId: string }
  | { op: 'upsertScenario'; connectorId: string; endpointId: string; scenario: Scenario }
  | { op: 'deleteScenario'; connectorId: string; endpointId: string; scenarioId: string }
  | { op: 'upsertExample'; connectorId: string; endpointId: string; example: ResponseExample }
  | { op: 'deleteExample'; connectorId: string; endpointId: string; exampleId: string }
  | { op: 'upsertFlow'; flow: Flow }
  | { op: 'deleteFlow'; id: string }
  /** Cria o ambiente ou muda nome e descrição (as variáveis vão por setVariable). */
  | { op: 'upsertEnvironment'; environment: { id: string; name: string; description?: string } }
  | { op: 'deleteEnvironment'; id: string }
  /** Cria ou muda uma variável; com `secret`, o valor vai para o vault local e o arquivo guarda __REQUIRED_SECRET__. */
  | {
      op: 'setVariable'
      environmentId: string
      name: string
      value?: string | number | boolean
      secret?: boolean
      description?: string
      overwrite?: boolean
    }
  | { op: 'deleteVariable'; environmentId: string; name: string }

export const PROJECT_EDIT_OPS: readonly ProjectEdit['op'][] = [
  'upsertConnector',
  'moveConnector',
  'deleteConnector',
  'upsertEndpoint',
  'moveEndpoint',
  'deleteEndpoint',
  'upsertScenario',
  'deleteScenario',
  'upsertExample',
  'deleteExample',
  'upsertFlow',
  'deleteFlow',
  'upsertEnvironment',
  'deleteEnvironment',
  'setVariable',
  'deleteVariable'
]

export type RevealTarget = { workspacePath: string } | { repoPath: string } | { pluginId: string }

export const EDIT_COMMANDS = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const
export type EditCommand = (typeof EDIT_COMMANDS)[number]

/** Execução remota num Execution Runner da organização (módulo Enterprise). */
export type RemoteRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'canceled' | 'lost'

export interface RemoteRun {
  id: number
  project: string
  status: RemoteRunStatus
  requestedBy: string
  createdAt: string
  finishedAt: string | null
  cancelRequested: boolean
  exitCode: number | null
  error: string | null
}

export interface RemoteRunEvent {
  seq: number
  at: string
  /** status (mudança de estado), log (linhas da saída do CLI) ou progress. */
  kind: string
  data: Record<string, unknown>
}

export interface RemoteRunTarget {
  /** Control Plane e projeto, ex.: cp.contoso.com/payments. */
  source: string
  /** Há sessão SSO para disparar agora. */
  signedIn: boolean
  /** O que fazer quando não há sessão. */
  hint?: string
}

/** Os filtros do CLI no runner (vvpost run --env/--connector/--scenario/--flow). */
export interface RemoteRunSelection {
  environments: string[]
  connectors: string[]
  scenarios: string[]
  flows: string[]
}

/**
 * Antes de enviar a um runner: destino, projeto, ambientes, conectores e o contexto
 * de segredos. Só nomes: os valores nunca saem do vault local, e no runner vêm do broker.
 */
export interface RemoteRunPreview {
  /** Control Plane e projeto, ex.: cp.contoso.com/payments. */
  source: string
  /** A pasta do workspace que vai, pelo nome. */
  workspace: string
  environments: { id: string; name: string; secrets: string[] }[]
  connectors: { id: string; name: string }[]
  scenarios: string[]
  /** Arquivos enviados e quantos deles são conectores do catálogo da organização (shared/). */
  files: number
  shared: number
  /** Arquivos do Compartilhado do workspace (compartilhado/), quando o projeto aberto é um dos projetos. */
  compartilhado: number
  /** Bases de outros projetos do workspace que este usa ("<projeto>:<id>"), em projetos/. */
  otherProjects: number
  bytes: number
}

export interface RemoteRunPoll {
  run: RemoteRun
  events: RemoteRunEvent[]
  /** Só no fim: o relatório JSON do CLI, com `scenarios` no formato do ScenarioRunReport. */
  report?: { outcome?: string; scenarios?: ScenarioRunReport[] } & Record<string, unknown>
}

/** Secret Manager Engine. */
export interface SecretEngineState {
  status: 'off' | 'starting' | 'running' | 'error'
  port: number | null
  /** Modo em que o engine está rodando, ou o que vai usar ao ligar (localMock ou enterpriseProxy, do módulo Enterprise). */
  mode?: 'localMock' | 'enterpriseProxy'
  /** O workspace configura o enterpriseProxy, então o toggle Mock/Proxy aparece. */
  proxyAvailable?: boolean
  /** Ambiente cujos segredos são servidos. */
  environment: string | null
  /** Motivo do erro (porta ocupada, sem workspace, configuração inválida). */
  message?: string
}

/** Servidor MCP ligado pela barra de status, em HTTP/SSE só em loopback. */
export interface McpServerState {
  status: 'off' | 'starting' | 'running' | 'error'
  /** Raiz do servidor (ex.: http://127.0.0.1:4470); os transportes ficam em /mcp e /sse. */
  url: string | null
  /** Workspace servido. */
  workspace: string | null
  /** O servidor exige Authorization: Bearer ($VVPOST_MCP_TOKEN). */
  token: boolean
  message?: string
}

/** Clientes de IA que o app configura (vvpost connect). */
export type McpClientId = 'claude' | 'cursor' | 'vscode' | 'codex'

export type ConnectRepoResult =
  | {
      ok: true
      repo: string
      /** O que foi feito em cada cliente e na regra; manual traz o comando para rodar à mão. */
      steps: { client: McpClientId | 'rule'; target: string; action: 'created' | 'updated' | 'unchanged' | 'manual'; command?: string }[]
    }
  | { ok: false; message: string }

/** Servidor local de webhooks, ligado pela barra de status ou pelo módulo Webhooks. */
export interface MockServerState {
  status: 'off' | 'starting' | 'running' | 'error'
  /** Raiz do servidor (ex.: http://127.0.0.1:4490). */
  url: string | null
  /** Endpoints servidos e quantos têm exemplo de resposta (na hora de ligar). */
  endpoints: number
  withExamples: number
  /** Requisições atendidas desde que ligou. */
  hits: number
  message?: string
}

export interface WebhookServerState {
  status: 'off' | 'starting' | 'running' | 'error'
  /** Raiz do servidor (ex.: http://127.0.0.1:4480). */
  url: string | null
  /** Ambiente das assinaturas e dos disparos. */
  environment: string | null
  /** O workspace tem .vvpost/webhooks.json. */
  configured: boolean
  hooks: WebhookHookInfo[]
  events: number
  message?: string
}

/** Um hook de .vvpost/webhooks.json como a interface mostra: sem a variável da chave da assinatura. */
export interface WebhookHookInfo {
  id: string
  name?: string
  path: string
  methods?: string[]
  /** Header conferido, quando o hook exige assinatura. */
  signatureHeader?: string
  status: number
  trigger?: { kind: 'flow' | 'scenarios'; target: string; environment?: string }
}

/** Linha da lista de eventos: tudo menos headers e corpo. */
export type WebhookEventSummary = Omit<WebhookEvent, 'headers' | 'body' | 'bodyBase64'> & { contentType?: string }

export type WebhookChangeEvent =
  | { change: 'added' | 'updated'; event: WebhookEventSummary }
  | { change: 'cleared' }

/**
 * Identidade: o perfil local é do core e sempre existe; a
 * identidade autenticada, a organização e as permissões vêm do módulo Enterprise, quando
 * instalado. Ter perfil não é estar autenticado, e estar autenticado não concede acesso.
 */
export interface LocalProfile {
  displayName: string
  initials?: string
}

export type IdentitySessionStatus = 'signedOut' | 'signingIn' | 'signedIn' | 'expired'

export interface EnterpriseIdentity {
  /** O login corporativo está configurado nesta instalação. */
  available: boolean
  session: {
    status: IdentitySessionStatus
    user?: { name: string; email?: string }
    provider?: 'azureAd' | 'okta' | 'awsIam'
    expiresAt?: string
    message?: string
  }
  organization?: { id: string; name: string }
  organizations?: { id: string; name: string }[]
  permissions?: { project: string; roles: string[] }[]
  /** Política efetiva do Control Plane para o projeto, só com a sessão aberta. Só exibe: quem aplica é o módulo. */
  policy?: EnterprisePolicy
}

export interface EnterprisePolicy {
  /** Projeto do Control Plane; ausente, a política da organização. */
  project?: string
  secretsProxyEnabled: boolean
  secretsBroker: boolean
  allowWrites: boolean
  allowedSecretProviders: string[]
  allowedUpstreamHosts: string[]
  maxCacheTtlSeconds?: number
  /** O MCP do app mascara também dados pessoais não marcados, reconhecidos pelo formato (docs/security-model.md). */
  agentPiiDetection?: boolean
  /** Política do agente (MCP) da organização: só restringe as flags locais (docs/mcp.md, "Política central"). */
  mcp?: EnterpriseAgentPolicy
  fetchedAt: string
}

export interface EnterpriseAgentPolicy {
  allowMethods?: string[]
  allowEnvironments?: string[]
  readOnly?: boolean
  noWrite?: boolean
  requestsPerMinute?: number
  maxConcurrent?: number
  protectedEnvironments?: string[]
  /** Papéis que aprovam no console a revisão de auth, destino e código. */
  reviewApprovers?: string[]
}

export interface IdentityState {
  profile: LocalProfile
  /** null sem o módulo Enterprise: nada de login na interface. */
  enterprise: EnterpriseIdentity | null
  /** Recursos desligados pela organização ou por VVPOST_DISABLE_FEATURES (@vvpost/core/policy/features). */
  features?: DisabledFeatureInfo[]
}

export interface DisabledFeatureInfo {
  /** Id de FEATURES: secretEmulator, pythonNode, scripts, plugins, protocols, mockServer, webhooks, mcp, piiVisible. */
  id: string
  label: string
  /** Quem desligou: "política da organização (...)" ou VVPOST_DISABLE_FEATURES. */
  source: string
}

/** Uma alteração da IA aguardando revisão (src/main/project/review.ts). */
export interface AiReviewItem {
  /** Chave da marca: o id do conector, ou flow:<id do fluxo>. */
  key: string
  kind: 'connector' | 'flow'
  id: string
  /** Nome do conector ou do fluxo, quando ainda existe. */
  name?: string
  /** Quando a IA alterou (ISO 8601). */
  at: string
  /** O que se confirma: auth e destino efetivos, ou os nós de código. */
  reason?: string
  /** A política do agente da organização manda aprovar no console do Control Plane: o app não aprova. */
  central?: boolean
  /** Pedido de revisão aberto no console para este item. */
  request?: number
}
