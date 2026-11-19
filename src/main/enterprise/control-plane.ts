import type { SharedConnector } from '@vvpost/core/connectors/shared'
import type { DocsPublisher } from '@vvpost/core/docs/publish'
import type { RemoteRun, RemoteRunEvent, RemoteRunTarget } from '@shared/ipc'
import { loadEnterpriseModule, type EnterpriseSecretsModule } from '../secret-engine/backend'

/**
 * Ponto de extensão para o Control Plane Enterprise (docs/architecture.md).
 *
 * O desktop continua executando tudo localmente: requisições, fluxos, cenários e
 * Git não passam por servidor nenhum. Quando o módulo Enterprise está instalado e
 * traz um `controlPlane`, o core só o avisa do que aconteceu (metadados, nunca
 * headers, corpo, query ou valores), para a auditoria central da organização. Sem
 * módulo, recordActivity não faz nada, e nenhum formato .vvpost depende disso.
 */

interface ActivityBase {
  /** ISO 8601. */
  at: string
}

export type ActivityEvent = ActivityBase &
  (
    | {
        kind: 'request'
        method: string
        /** Só o host de destino (sem caminho, query ou usuário), ou null se a URL ainda tem {{VAR}}. */
        host: string | null
        connectorId: string | null
        environmentId: string | null
        /** Status HTTP, ou null quando falhou antes da resposta. */
        status: number | null
        errorCode: string | null
        durationMs: number
      }
    | {
        kind: 'scenarioRun'
        connectorId: string
        environments: string[]
        passed: number
        failed: number
        error: number
        canceled: boolean
      }
    | { kind: 'flowRun'; flowId: string; outcome: string; durationMs: number }
    | { kind: 'secretEngine'; action: 'start' | 'stop' | 'startFailed'; mode: string | null }
    | { kind: 'mcpServer'; action: 'start' | 'stop' }
    | DocsPublishEvent
    | AgentToolCallEvent
  )

/**
 * Uma publicação da documentação ("Enviar para…"): o destino e as contagens, nunca o conteúdo,
 * títulos ou ids das páginas. O publicador registra o detalhe (páginas e hashes) na trilha dele.
 */
export interface DocsPublishEvent {
  kind: 'docsPublish'
  provider: string
  /** Id do destino no vvpost.publish.json. */
  target: string
  /** Rótulo do destino que o publicador devolveu (ex.: o espaço). */
  destination: string
  created: number
  updated: number
  unchanged: number
  skipped: number
  archived: number
  failed: number
  durationMs: number
}

/**
 * Uma chamada de ferramenta do agente (MCP), para a trilha central. Só identificadores e o
 * resultado: nunca argumentos de corpo, headers, valores, overrides ou o texto da resposta.
 */
export interface AgentToolCallEvent {
  kind: 'mcpToolCall'
  /** Nome da ferramenta (o Control Plane grava como action). */
  action: string
  /** stdio: o out/main/mcp.js iniciado pelo cliente de IA; app: o servidor ligado pela barra de status. */
  surface: 'stdio' | 'app'
  /** Projeto do workspace (o argumento project), quando a chamada escolheu um. */
  workspaceProject?: string
  connectorId?: string
  endpointId?: string
  flowId?: string
  environments?: string[]
  outcome: 'ok' | 'error' | 'denied'
  errorCode?: string
  durationMs: number
}

/**
 * Política do agente (MCP) vinda do Control Plane. Só restringe: cada campo é cruzado com o
 * que as flags locais do mcp.js pediram, e o mais restrito vale. Campo ausente: sem limite central.
 */
export interface AgentPolicy {
  /** Métodos que o agente pode disparar. */
  allowMethods?: string[]
  /** Ambientes (ids) em que o agente pode disparar. */
  allowEnvironments?: string[]
  /** Nada é enviado para as APIs: execute_dry_run só monta. */
  readOnly?: boolean
  /** O agente não edita o projeto. */
  noWrite?: boolean
  /** Requisições por minuto. */
  requestsPerMinute?: number
  /** Requisições ao mesmo tempo. */
  maxConcurrent?: number
  /** Ambientes (ids) protegidos além dos que o arquivo marca: o agente só monta o plano neles. */
  protectedEnvironments?: string[]
  /** Papéis que aprovam no console a revisão de auth, destino e código; com algum, a aprovação local é recusada. */
  reviewApprovers?: string[]
  /** Mascara também dados pessoais não marcados, reconhecidos pelo formato (o agentPiiDetection da política). */
  piiDetection?: boolean
}

/**
 * Estado da política para quem pergunta agora. none: a organização não usa Control Plane (só as
 * flags locais valem). active: a política lida há pouco. unavailable: há Control Plane, mas sem
 * política válida (sem login, servidor fora, cache vencido): o MCP fica no modo mais restrito.
 */
export type AgentPolicyState =
  | { status: 'none' }
  | { status: 'active'; policy: AgentPolicy; fetchedAt: string; source: string }
  | { status: 'unavailable'; reason: string }

/** Um item a revisar: a chave da marca (conector ou flow:<id>), o que mudou e o hash do conteúdo aprovado. */
export interface AgentReviewItem {
  key: string
  kind: 'connector' | 'flow'
  reason?: string
  /** SHA-256 (base64url) do arquivo do conector ou do código do fluxo; a aprovação só vale para ele. */
  hash: string
  /** O que o aprovador lê no console: o código dos nós do fluxo (o conector já vai resumido em reason). */
  detail?: string
}

export interface AgentReviewRequest {
  id: number
  status: 'pending' | 'approved' | 'rejected'
  /** Itens com o hash aprovado (ou pedido, enquanto pendente). */
  items: { key: string; hash: string }[]
  url?: string
  decidedBy?: string
}

/** Sessão do agente com o Control Plane: política, trilha por chamada e revisão central. */
export interface AgentSession {
  state(): AgentPolicyState
  /** Resolve quando a primeira leitura da política termina (com ou sem sucesso, inclusive o login). */
  ready(): Promise<AgentPolicyState>
  /** Melhor esforço, com fila local se o Control Plane cair. */
  record(event: AgentToolCallEvent & { at: string }): void
  /** Abre (ou reaproveita, se igual) um pedido de revisão no console. */
  requestReview(request: { workspace: string; items: AgentReviewItem[] }): Promise<AgentReviewRequest>
  reviews(ids: number[]): Promise<AgentReviewRequest[]>
  /** Envia o que ficou na fila (ou guarda para a próxima sessão) e solta o login. */
  close(): Promise<void>
}

export interface AgentPolicyExtension {
  /**
   * null quando a organização não usa Control Plane. Não espera o login: até a política chegar
   * o estado é unavailable. No app a sessão usa a conta corporativa aberta; no stdio, abre o
   * login no navegador com openExternal.
   */
  open(context: { surface: 'stdio' | 'app'; openExternal?: (url: string) => Promise<void> }): Promise<AgentSession | null>
}

/**
 * Recursos que a organização desligou (FEATURES em @vvpost/core/policy/features). none: a
 * organização não usa Control Plane. active: a última política lida, ao vivo ou da cópia em disco
 * (cached), para o CLI e o app sem rede. unavailable: há Control Plane, mas nenhuma política lida
 * nesta máquina: o core desliga todos os recursos da lista até ela chegar.
 */
export type FeaturePolicyState =
  | { status: 'none' }
  | { status: 'active'; disabled: string[]; source: string; fetchedAt: string; cached?: boolean }
  | { status: 'unavailable'; reason: string }

export interface FeaturePolicySession {
  state(): FeaturePolicyState
  /** Resolve quando a primeira leitura termina (a cópia em disco já vale antes). */
  ready(): Promise<FeaturePolicyState>
  /** Avisa quando o estado muda (login, logout, política relida). Devolve o cancelamento. */
  onChange?(listener: () => void): () => void
  close(): Promise<void>
}

export interface FeaturePolicyExtension {
  /**
   * null quando a organização não usa Control Plane. Nunca abre login: segue a conta já aberta
   * (o app, o login do mcp.js) e, sem ela, a última política gravada nesta máquina.
   */
  open(context: { surface: 'app' | 'cli' | 'stdio' }): Promise<FeaturePolicySession | null>
}

/** Conector do catálogo centralizado: o documento *.connector.vvpost.json e a versão de onde veio. */
export interface CatalogConnector {
  /** "org" ou a chave do projeto no Control Plane. */
  scope: string
  version: number
  doc: unknown
}

export interface CatalogSnapshot {
  /** Control Plane e projeto, ex.: cp.contoso.com/payments. */
  source: string
  etag: string
  syncedAt: string
  connectors: CatalogConnector[]
}

/**
 * Execuções remotas nos Execution Runners da organização. O módulo fala com o Control
 * Plane com a sessão do usuário; o core só monta o workspace sem segredos e mostra.
 */
export type { RemoteRun, RemoteRunEvent, RemoteRunStatus, RemoteRunTarget } from '@shared/ipc'

/** O que vai para a fila do Control Plane: o workspace sem segredos e os filtros do CLI. */
export interface RemoteRunRequest {
  /** Caminho relativo ("/") → documento JSON: *.vvpost.json e environments/*.env.json. */
  files: Record<string, unknown>
  environments: string[]
  connectors: string[]
  scenarios: string[]
  flows: string[]
  labels?: string[]
}

export interface RemoteRunsExtension {
  /** Projeto de destino e se há sessão para disparar; null sem Control Plane configurado. */
  target(): Promise<RemoteRunTarget | null>
  start(request: RemoteRunRequest): Promise<RemoteRun>
  /** Estado e, no fim, o relatório JSON do CLI (o mesmo de `vvpost run --json`). */
  get(id: number): Promise<{ run: RemoteRun; report: unknown }>
  /** Eventos depois de `after` (seq), em ordem. */
  events(id: number, after: number): Promise<RemoteRunEvent[]>
  cancel(id: number): Promise<RemoteRun>
}

export interface ControlPlaneExtension {
  /**
   * Recebe cada evento de atividade. É melhor esforço: o core não espera nem
   * bloqueia por ele (ao contrário da trilha de segredos, que é fail-closed), então
   * fila, reenvio e buffer offline são do módulo.
   */
  activity(event: ActivityEvent): void | Promise<void>
  /**
   * Catálogo centralizado: conectores corporativos publicados no Control Plane, já
   * sincronizados pelo módulo (o core não fala com o servidor). null sem Control Plane
   * ou antes da primeira sincronização. Entram no workspace somente leitura.
   */
  catalog?(): Promise<CatalogSnapshot | null>
  /** Execuções remotas nos runners. */
  runs?: RemoteRunsExtension
  /** Política do agente (MCP), trilha por chamada e revisão central. */
  agent?: AgentPolicyExtension
  /** Publicadores do "Enviar para…" da Documentação (ex.: Confluence Cloud). */
  publishers?: DocsPublisher[]
  /** Recursos que a organização desligou no app, no CLI e no MCP. */
  features?: FeaturePolicyExtension
}

let extension: Promise<ControlPlaneExtension | null> | null = null

/** Só para testes: troca (ou limpa, com undefined) o Control Plane sem carregar o módulo. */
export function setControlPlaneForTests(cp: ControlPlaneExtension | null | undefined): void {
  extension = cp === undefined ? null : Promise.resolve(cp)
}

/** O controlPlane do módulo Enterprise, ou null quando não há módulo ou ele não traz um. */
export function controlPlane(load: () => Promise<EnterpriseSecretsModule> = loadEnterpriseModule): Promise<ControlPlaneExtension | null> {
  extension ??= load()
    .then((mod) => mod.controlPlane ?? null)
    .catch(() => null)
  return extension
}

/** Avisa o Control Plane, se houver. Nunca lança nem atrasa quem chamou. */
export function recordActivity(event: ActivityEvent): void {
  void controlPlane()
    .then((cp) => cp?.activity(event))
    .catch((err: Error) => console.error('Control Plane recusou um evento de atividade:', err.message))
}

/**
 * Conectores do catálogo para o loadWorkspace (setSharedConnectors). Falha do módulo
 * não derruba o workspace: vira lista vazia e o loader segue com os arquivos locais.
 */
export async function sharedConnectors(): Promise<SharedConnector[]> {
  const cp = await controlPlane()
  const snap = await cp?.catalog?.()
  if (!snap) return []
  return snap.connectors.map((c) => ({ source: `${snap.source}@${c.scope}:${c.version}`, doc: c.doc }))
}

/** Host de destino para a auditoria: nada de caminho, query nem credencial na URL. */
export function auditHost(url: string): string | null {
  if (url.includes('{{')) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}
