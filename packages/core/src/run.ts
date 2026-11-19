import type { FlowRunEvent, FlowRunInput, FlowRunReport, ScenarioRunInput, ScenarioRunReport, WebhookSource } from './types'
import type { AuthEngine } from './connectors/auth'
import type { LoadedWorkspace } from './connectors/workspace'
import type { FlowPluginRunner } from './plugins/manager'
import type { HttpDispatcher } from './http/dispatcher'
import type { RequestGuard } from './policy/request-policy'

/**
 * Execução de cenários e fluxos a partir de um workspace já lido, dividida pelos
 * clientes do motor: o app (services.ts, via IPC), o CLI (`vvpost run`) e, adiante,
 * os runners remotos. Cada cliente só decide de onde vêm o workspace, o dispatcher,
 * a auth e os plugins; o que acontece com eles é igual em todos.
 */
export interface RunContext {
  auth: AuthEngine
  http: Pick<HttpDispatcher, 'send' | 'cancel'>
  signal?: AbortSignal
  /** Limites de quem dispara sem humano (disparo por webhook); ausente quando é o usuário. */
  guard?: RequestGuard
}

/** Workspace vazio: um fluxo sem workspace ainda roda, só sem conectores e ambientes. */
export const emptyWorkspace = (): LoadedWorkspace => ({
  dir: '',
  connectors: new Map(),
  connectorFiles: new Map(),
  environments: new Map(),
  secrets: {},
  issues: []
})

/** Lote de cenários. Um workspace que não pôde ser lido vira um relatório com `error`, sem nada rodado. */
export async function runScenarioBatch(
  input: ScenarioRunInput,
  workspace: LoadedWorkspace | Error,
  ctx: RunContext & { plugins?: () => Promise<FlowPluginRunner> }
): Promise<ScenarioRunReport> {
  if (workspace instanceof Error) {
    return {
      runId: input.runId,
      connectorId: input.connectorId,
      startedAt: Date.now(),
      durationMs: 0,
      results: [],
      totals: { passed: 0, failed: 0, error: 0 },
      canceled: false,
      error: workspace.message
    }
  }
  const { runScenarios } = await import('./scenarios/run')
  return runScenarios(input, {
    workspace,
    auth: ctx.auth,
    http: ctx.http,
    ...(ctx.signal && { signal: ctx.signal }),
    ...(ctx.guard && { guard: ctx.guard }),
    ...(ctx.plugins && { plugins: ctx.plugins })
  })
}

export interface FlowRunOptions extends RunContext {
  onEvent?: (event: FlowRunEvent) => void
  /** Carrega os plugins ligados; só é chamado se o fluxo tem nó de plugin. */
  plugins?: () => Promise<FlowPluginRunner>
  /** Liga (ou devolve) o servidor de webhooks; só é chamado se o fluxo tem nó webhook. */
  webhooks?: () => Promise<WebhookSource>
  /** Num fluxo disparado por um hook: o id do evento que disparou (ver FlowRunContext). */
  webhookSince?: number
}

/** Algum conector (ou endpoint) do workspace tem scripts por requisição. */
function hasScripts(ws: LoadedWorkspace): boolean {
  for (const c of ws.connectors.values()) {
    if (c.config?.scripts?.pre || c.config?.scripts?.post) return true
    if (c.endpoints?.some((e) => e.scripts?.pre || e.scripts?.post)) return true
  }
  return false
}

/** Roda um fluxo. Só fluxos com nó de plugin leem as pastas de plugins, e só os com nó webhook ligam o servidor. */
export async function runFlowWith(
  input: FlowRunInput,
  workspace: LoadedWorkspace | Error,
  ctx: FlowRunOptions
): Promise<FlowRunReport> {
  if (workspace instanceof Error) {
    return { runId: input.runId, flowId: input.flow?.id ?? '', startedAt: Date.now(), durationMs: 0, results: [], outcome: 'failed', error: workspace.message }
  }
  // Um nó de requisição de endpoint com scripts roda o nó de script do plugin JavaScript (fase 13).
  const needsPlugins =
    input.flow?.nodes?.some((n) => n?.type === 'plugin') ||
    (input.flow?.nodes?.some((n) => n?.type === 'request') && hasScripts(workspace))
  const needsWebhooks = input.flow?.nodes?.some((n) => n?.type === 'webhook')
  const [{ runFlow }, plugins, webhooks] = await Promise.all([
    import('./flows/run'),
    needsPlugins && ctx.plugins ? ctx.plugins() : undefined,
    needsWebhooks && ctx.webhooks ? ctx.webhooks().catch((err: Error) => err) : undefined
  ])
  return runFlow(input, {
    workspace,
    auth: ctx.auth,
    http: ctx.http,
    ...(ctx.signal && { signal: ctx.signal }),
    ...(ctx.onEvent && { onEvent: ctx.onEvent }),
    ...(plugins && { plugins }),
    ...(ctx.guard && { guard: ctx.guard }),
    ...(webhooks instanceof Error ? { webhooksError: `o servidor de webhooks não ligou: ${webhooks.message}` } : webhooks && { webhooks }),
    ...(ctx.webhookSince !== undefined && { webhookSince: ctx.webhookSince })
  })
}
