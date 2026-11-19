import type { FlowCatalog, FlowRunEvent, FlowRunInput, FlowRunReport, ScenarioRunInput, ScenarioRunReport, WebhookSource } from './types'
import { createAuthEngine, type AuthEngine, type AuthHooks } from './connectors/auth'
import { loadWorkspace, type LoadedWorkspace } from './connectors/workspace'
import type { SharedConnector } from './connectors/shared'
import { loadFlows } from './flows/workspace'
import { createHttpDispatcher, type HttpClientConfig, type HttpDispatcher } from './http/dispatcher'
import type { SecretSanitizer } from './sanitizer'
import type { PluginManager, PluginManagerOptions } from './plugins/manager'
import type { RequestGuard } from './policy/request-policy'
import { protectWorkspace } from './protect'
import { createExchangeRecorder, type RecordedExchange, type RecorderLimits } from './recorder'
import { runFlowWith, runScenarioBatch } from './run'

export interface CoreSessionOptions {
  workspaceDir: string
  /** Pastas de plugins; sem isso, nós de plugin falham com PLUGIN_UNAVAILABLE. */
  plugins?: PluginManagerOptions
  /** Aprende as credenciais que passam pelo dispatcher e recebe os segredos do workspace. */
  sanitizer?: SecretSanitizer
  /** Ajusta o workspace recém-lido (ex.: segredos vindos do CI). */
  onLoad?: (ws: LoadedWorkspace) => void
  /** Conectores compartilhados (somente leitura) no lugar do provider registrado, ex.: --catalog do CLI. */
  shared?: SharedConnector[]
  /** Proxy, verificação TLS, CAs extras e cookie jar do dispatcher (ignorado com `http`). */
  client?: HttpClientConfig
  /** Para testes: dispatcher no lugar do Undici (não é fechado pela sessão). */
  http?: Pick<HttpDispatcher, 'send' | 'cancel'>
  /** Guarda cada requisição (modelo, o que foi enviado e a resposta) para o histórico (`takeRecorded`). */
  record?: RecorderLimits
  /** Liga (ou devolve) o servidor de webhooks; só é chamado por fluxo com nó webhook. */
  webhooks?: () => Promise<WebhookSource>
  /** Login no navegador do OAuth2 authorization_code; sem ele, só token em cache ou refresh_token. */
  authHooks?: AuthHooks
}

export interface CoreSession {
  readonly workspaceDir: string
  readonly auth: AuthEngine
  /** Relê conectores, ambientes e segredos do disco. */
  load(): Promise<LoadedWorkspace>
  loadFlows(): Promise<FlowCatalog>
  runScenarios(input: ScenarioRunInput, workspace: LoadedWorkspace, signal?: AbortSignal, guard?: RequestGuard): Promise<ScenarioRunReport>
  runFlow(
    input: FlowRunInput,
    workspace: LoadedWorkspace,
    options?: {
      signal?: AbortSignal
      onEvent?: (event: FlowRunEvent) => void
      /** Limites de quem dispara sem humano (um hook do servidor de webhooks). */
      guard?: RequestGuard
      /** Fluxo disparado por um hook: o id do evento que disparou. */
      webhookSince?: number
      /** Servidor de webhooks desta execução, no lugar do da sessão. */
      webhooks?: () => Promise<WebhookSource>
    }
  ): Promise<FlowRunReport>
  /** Tira as requisições gravadas com este prefixo de id (vazio sem `record`). */
  takeRecorded(prefix: string): RecordedExchange[]
  /**
   * O que impede o workspace de rodar com os plugins declarados em vvpost.plugins.json (ou um nó
   * de plugin que nenhum plugin ligado fornece). Vazio sem `plugins`: aí nós de plugin falham com
   * PLUGIN_UNAVAILABLE de propósito. Com `declaredOnly`, só os plugins declarados (uma execução
   * filtrada não precisa dos plugins do resto do workspace).
   */
  pluginProblems(workspace: LoadedWorkspace, flows: FlowCatalog, options?: { declaredOnly?: boolean }): Promise<string[]>
  /** Fecha o pool de sockets e os workers de plugin. */
  close(): Promise<void>
}

/**
 * O motor do VVPost fora do Electron: um workspace, um dispatcher, um cache de tokens
 * e os plugins, para o CLI e para runners sem interface. O app monta as mesmas peças
 * em services.ts, com o carregamento sob demanda que o cold start pede.
 */
export function createCoreSession(options: CoreSessionOptions): CoreSession {
  const dispatcher = options.http ? undefined : createHttpDispatcher({}, options.client)
  const base = options.http ?? dispatcher!
  const tracked = options.sanitizer ? options.sanitizer.track(base) : base
  const recorder = options.record ? createExchangeRecorder(tracked, () => options.record!) : undefined
  const http = recorder?.http ?? tracked
  const auth = createAuthEngine(Date.now, options.authHooks)
  let manager: Promise<PluginManager> | undefined
  const loadManager = () => (manager ??= import('./plugins/manager').then((m) => new m.PluginManager(options.plugins!)))
  const plugins = options.plugins ? () => loadManager().then((p) => p.runner()) : undefined

  return {
    workspaceDir: options.workspaceDir,
    auth,
    async load() {
      const ws = await loadWorkspace(options.workspaceDir, options.shared ? { shared: options.shared } : {})
      options.onLoad?.(ws)
      if (options.sanitizer) protectWorkspace(options.sanitizer, ws)
      return ws
    },
    loadFlows: () => loadFlows(options.workspaceDir),
    runScenarios: (input, workspace, signal, guard) =>
      runScenarioBatch(input, workspace, { auth, http, ...(signal && { signal }), ...(guard && { guard }), ...(plugins && { plugins }) }),
    runFlow: (input, workspace, opts = {}) =>
      runFlowWith(input, workspace, {
        auth,
        http,
        ...(opts.signal && { signal: opts.signal }),
        ...(opts.onEvent && { onEvent: opts.onEvent }),
        ...(opts.guard && { guard: opts.guard }),
        ...(opts.webhookSince !== undefined && { webhookSince: opts.webhookSince }),
        ...(plugins && { plugins }),
        ...((opts.webhooks ?? options.webhooks) && { webhooks: (opts.webhooks ?? options.webhooks)! })
      }),
    takeRecorded: (prefix) => recorder?.take(prefix) ?? [],
    async pluginProblems(workspace, flows, { declaredOnly = false } = {}) {
      if (!options.plugins) return []
      const r = await import('./plugins/requirements')
      const used = declaredOnly ? [] : r.usedContributions(workspace, flows)
      let required
      try {
        required = await r.readPluginRequirements(options.workspaceDir)
      } catch (err) {
        return [(err as Error).message]
      }
      if (!required && !used.length) return []
      return r.pluginProblems(required, await (await loadManager()).catalog(), used)
    },
    async close() {
      await Promise.allSettled([dispatcher?.close(), manager?.then((p) => p.shutdown())])
    }
  }
}
