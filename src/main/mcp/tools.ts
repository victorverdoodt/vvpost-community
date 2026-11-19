import { REQUIRED_SECRET, type Assertion, type Endpoint, type Scenario } from '@vvpost/schemas'
import type { HttpHeader, HttpResponseData, HttpResult, ScenarioResult } from '@shared/ipc'
import type { AuthEngine } from '@vvpost/core/connectors/auth'
import { ConfigError } from '@vvpost/core/connectors/errors'
import { resolveUrl } from '@vvpost/core/connectors/auth'
import { authHeaderName, mergeHeaders, sendHeadless } from '@vvpost/core/connectors/headless'
import { buildRegistry, validateEndpointBody } from '@vvpost/core/connectors/registry'
import { joinPath, resolveConnector } from '@vvpost/core/connectors/resolve'
import { rootSchemaName } from '@vvpost/core/connectors/shared-schemas'
import { describeAuth } from '@vvpost/core/connectors/summary'
import { interpolate, type VariableScope } from '@vvpost/core/connectors/template'
import { environmentValues, loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { protectWorkspace } from '@vvpost/core/protect'
import { isCredentialHeader } from '@vvpost/core/secrets'
import type { HttpDispatcher } from '@vvpost/core/http/dispatcher'
import type { RequestGuard } from '@vvpost/core/policy/request-policy'
import { isProtectedEnvironment } from '@vvpost/core/policy/protected'
import { evaluateAssertion, toSubject } from '@vvpost/core/scenarios/assert'
import { buildScenarioRequest } from '@vvpost/core/scenarios/request'
import { accessCheckScenario } from '@vvpost/core/scenarios/access'
import { runScenarios } from '@vvpost/core/scenarios/run'
import { flowReviewKey, markUnreviewedFlows, readReviewMarks } from '../project/review'
import { inheritConnector, isBaseFlow, runFlow } from '@vvpost/core/flows/run'
import { projectLayout } from '@vvpost/core/projects'
import { loadFlows, plainFlows } from '@vvpost/core/flows/workspace'
import { REDACTED, isSensitiveName, type SecretSanitizer } from '@vvpost/core/sanitizer'
import { loadPrivacyDetect, type PiiMasker } from '@vvpost/core/pii'
import type { WebhookInbox } from '../webhooks/inbox'

/** Corpo de resposta devolvido à IA: sanitizado inteiro e só depois cortado. */
const BODY_PREVIEW_CHARS = 4000
/** Corpo devolvido com select: só os campos pedidos, então cabe uma lista inteira. */
const SELECTED_BODY_CHARS = 20_000
/** Um lote de cenários pedido pela IA não passa disto (é teste, não carga). */
const MAX_RUNS = 50
/** Espera máxima de um nó webhook num fluxo rodado pela IA. */
const MCP_WEBHOOK_WAIT_MS = 120_000

export interface ToolContext {
  workspaceDir: string
  sanitizer: SecretSanitizer
  /** Dados pessoais (x-sensitive e detecção por padrão): mascarados antes do sanitizer em todo dado de execução. */
  pii: PiiMasker
  auth: AuthEngine
  /** Com lastResponse (o dispatcher do sanitizer), o corpo devolvido é o inteiro sanitizado. */
  http: Pick<HttpDispatcher, 'send' | 'cancel'> & { lastResponse?(id: string): HttpResult | undefined }
  /** Só monta as requisições (plan): nada é enviado para as APIs. */
  readOnly?: boolean
  /** Ambientes em que a IA pode disparar; ausente: todos. */
  allowEnvironments?: ReadonlySet<string>
  /** Edição do projeto desligada (--no-write); readOnly também desliga. */
  noWrite?: boolean
  /** O projeto da chamada é uma referência (vvpost.project.json com reference): só leitura, com noWrite. */
  reference?: { project: string; source: 'workspace' | 'openapi'; location: string }
  /** Ambientes protegidos pela política central (por id), além dos do arquivo. */
  protectedEnvironments?: ReadonlySet<string>
  /** A revisão de auth, destino e código é aprovada no console do Control Plane, não no app. */
  centralReview?: boolean
  /** Permissões e limites de toda requisição que a IA dispara. */
  guard?: RequestGuard
  /** Servidor local de webhooks ligado (no app, ou com --webhooks): eventos e nós webhook. */
  webhooks?: () => McpWebhooks | null
  signal?: AbortSignal
}

export interface McpWebhooks {
  url: string
  inbox: WebhookInbox
}

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  call(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>
}

/**
 * O que acompanha um erro para a IA agir sem adivinhar: `code` estável (CONFLICT, NOT_FOUND,
 * INVALID_ARGS, BLOCKED...), `hint` com a próxima chamada e o que mais ajudar (a versão atual...).
 */
export interface ToolErrorDetails {
  code?: string
  hint?: string
  [key: string]: unknown
}

/** Erro de uso da ferramenta: vai para a IA como resultado com isError, não como erro do protocolo. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details: ToolErrorDetails = {}
  ) {
    super(message)
  }
}

const ASSERTION_OPERATORS = [
  'equals',
  'notEquals',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'contains',
  'matches',
  'exists',
  'notExists',
  'matchesSchema',
  'matchesExample'
]

const assertionSchema = {
  type: 'object',
  required: ['target', 'operator'],
  additionalProperties: false,
  properties: {
    target: {
      type: 'string',
      pattern: '^(status|responseTimeMs|body|body(\\.|\\[).+|headers\\..+)$',
      description: 'status, responseTimeMs, body, body.<caminho> (com .chave e [índice]) ou headers.<nome>.'
    },
    operator: { type: 'string', enum: ASSERTION_OPERATORS },
    expected: {
      description:
        'Valor esperado. Ausente em exists/notExists/matchesExample; número nas comparações; JSON Schema em matchesSchema. matchesExample (só com target body) confere o corpo com o schema do exemplo de resposta do mesmo status.'
    }
  }
}

export async function load(ctx: ToolContext): Promise<LoadedWorkspace> {
  let ws: LoadedWorkspace
  try {
    ws = await loadWorkspace(ctx.workspaceDir)
  } catch (err) {
    throw new ToolError(`não foi possível ler o workspace ${ctx.workspaceDir}: ${(err as Error).message}`)
  }
  // Todo segredo do workspace entra no sanitizer antes de qualquer saída.
  protectWorkspace(ctx.sanitizer, ws)
  // E todo campo marcado como dado pessoal, com a detecção pedida pelo workspace.
  ctx.pii.addWorkspace(ws)
  try {
    ctx.pii.addDetect(await loadPrivacyDetect([ctx.workspaceDir, ws.root ?? ws.dir]))
  } catch (err) {
    throw new ToolError((err as Error).message, { code: 'INVALID_CONFIG', hint: 'corrija .vvpost/privacy.json (docs/security-model.md, Dados pessoais)' })
  }
  return ws
}

/** Variáveis que a IA não pode referenciar em overrides: elas só entram pela auth do conector. */
function secretVariables(ws: LoadedWorkspace): Set<string> {
  const names = new Set<string>()
  for (const vars of Object.values(ws.secrets)) for (const name of Object.keys(vars)) names.add(name)
  for (const env of ws.environments.values()) {
    for (const [name, variable] of Object.entries(env.variables)) {
      if (variable.isSecret || variable.value === REQUIRED_SECRET || isSensitiveName(name)) names.add(name)
    }
  }
  return names
}

const TEMPLATE_REF = /\{\{\s*([^{}]+?)\s*\}\}/g

function assertNoSecretRefs(value: unknown, secrets: ReadonlySet<string>, where: string): void {
  const visit = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(TEMPLATE_REF)) {
        const name = m[1]!.replace(/^\$totp:/, '').trim()
        if (secrets.has(name)) {
          throw new ToolError(
            `${path} referencia o segredo {{${name}}}: segredos só entram pela auth do conector, nunca por valores enviados pela IA`
          )
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${path}[${i}]`))
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        visit(k, path)
        visit(item, `${path}.${k}`)
      }
    }
  }
  visit(value, where)
}

/** Os schemas compartilhados do catálogo e quantos endpoints citam cada um. */
function sharedSchemas(ws: LoadedWorkspace) {
  return [...(ws.schemas?.values() ?? [])].map((s) => ({
    name: s.name,
    file: s.file,
    uses: ws.schemaUses?.get(s.name)?.length ?? 0,
    ...(s.shared && { readOnly: s.shared })
  }))
}

const getApiCatalog: McpTool = {
  name: 'get_api_catalog',
  title: 'Catálogo de APIs do VVPost',
  description:
    'Conectores (herança resolvida), endpoints, ambientes, fluxos e schemas compartilhados (schemas/<nome>.schema.json, citados como {"$ref": "schema:<nome>"}). view: "summary" (uma linha por conector) ou "issues" (só os avisos) gastam menos; com connectorId, o detalhe do conector (headers com origem, auth, bodySchema, campos, cenários, doc). Credenciais vêm como [REDACTED_SECRET] e variáveis como {{NOME}}.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      connectorId: { type: 'string', description: 'Id do conector para o detalhe completo.' },
      view: {
        enum: ['full', 'summary', 'issues'],
        description:
          'Sem connectorId: full (padrão) traz tudo; summary, uma linha por conector (extends, baseUrl, auth, quantos endpoints) e os ids de ambientes e fluxos; issues, só os avisos do catálogo e as contagens.'
      }
    }
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async call(args, ctx) {
    const ws = await load(ctx)
    const registry = await buildRegistry(ws)
    const connectorId = typeof args['connectorId'] === 'string' ? args['connectorId'] : undefined
    const view = !connectorId && (args['view'] === 'summary' || args['view'] === 'issues') ? args['view'] : 'full'
    if (view !== 'full') {
      const flows = await loadFlows(ctx.workspaceDir)
      const issues = [...registry.issues, ...flows.issues]
      const counts = {
        connectors: registry.connectors.length,
        endpoints: registry.connectors.reduce((n, c) => n + c.endpoints.length, 0),
        environments: ws.environments.size,
        flows: plainFlows(flows, ws.flowSources).length,
        issues: issues.length
      }
      if (view === 'issues') return { counts, ...(issues.length && { issues }) }
      return {
        counts,
        ...(ws.projects?.length && { project: ws.project?.id ?? null }),
        connectors: registry.connectors.map((c) => ({
          id: c.id,
          ...(c.extends !== undefined && { extends: c.extends }),
          ...(ws.shared?.get(c.id) && { readOnly: true }),
          ...(c.resolved?.baseUrl && { baseUrl: c.resolved.baseUrl.value }),
          ...(c.resolved?.auth && { auth: c.resolved.auth.summary }),
          endpoints: c.endpoints.length,
          ...(c.error !== undefined && { error: c.error })
        })),
        environments: [...ws.environments.keys()],
        flows: plainFlows(flows, ws.flowSources).map(({ flow }) => flow.id),
        ...(ws.schemas?.size && { schemas: sharedSchemas(ws) }),
        ...(issues.length && { issues })
      }
    }

    if (connectorId) {
      const c = registry.connectors.find((x) => x.id === connectorId)
      if (!c) {
        // "transnorte.cotarFrete" é o id de um fluxo de endpoint: o conector é a parte antes do ponto.
        const owner = registry.connectors.find((x) => connectorId.startsWith(`${x.id}.`) && x.endpoints.some((e) => e.id === connectorId.slice(x.id.length + 1)))
        throw new ToolError(
          owner
            ? `conector "${connectorId}" não existe: é o endpoint "${connectorId.slice(owner.id.length + 1)}" do conector "${owner.id}"; use connectorId "${owner.id}"`
            : `conector "${connectorId}" não existe; use get_api_catalog sem connectorId para ver a lista`
        )
      }
      const raw = ws.connectors.get(connectorId)
      const cited = ws.unresolved?.get(connectorId)
      const { diagrams: _diagrams, own, children, ...rest } = c
      return {
        ...rest,
        // Sem herança, own repete o resolved; listas vazias e a url (baseUrl + path) só gastam contexto.
        ...(c.chain.length > 1 && { own }),
        ...(children.length && { children }),
        endpoints: c.endpoints.map((e) => {
          const { fields, checks, url: _url, exampleChecks, ...all } = e
          const endpoint = Object.fromEntries(Object.entries(all).filter(([, v]) => !(Array.isArray(v) && !v.length)))
          const scenarios = raw?.endpoints?.find((x) => x.id === e.id)?.scenarios ?? []
          // O corpo que é um schema compartilhado: o bodySchema vem resolvido, e o nome diz o que editar.
          const shared = rootSchemaName(cited?.endpoints?.find((x) => x.id === e.id)?.bodySchema)
          return {
            ...endpoint,
            ...(shared && { sharedSchema: { name: shared, file: ws.schemas?.get(shared)?.file, edit: `setSchemaField { name: "${shared}" } muda todos os usos` } }),
            // O bodySchema já diz os campos; fields fica só para o corpo sem schema.
            ...(fields.length && !endpoint['bodySchema'] && { fields }),
            ...(checks.some((x) => x.issues.length) && { bodyIssues: checks.filter((x) => x.issues.length) }),
            ...(exampleChecks?.length && {
              examples: exampleChecks.map((x) => (x.issues.length ? x : `${x.id} (${x.status})`))
            }),
            ...(scenarios.length && { scenarios: scenarios.map((sc) => ({
              id: sc.id,
              name: sc.name,
              ...(sc.description !== undefined && { description: sc.description }),
              ...(sc.overrides && { overrides: sc.overrides }),
              assertions: sc.assertions
            })) })
          }
        })
      }
    }

    await markUnreviewedFlows(ctx.workspaceDir)
    const marks = await readReviewMarks(ctx.workspaceDir)
    const flows = await loadFlows(ctx.workspaceDir)
    return {
      workspace: registry.dir,
      ...(ws.projects?.length && { project: ws.project?.id ?? null, projects: ws.projects.map((p) => p.id) }),
      tree: connectorTree(registry.connectors),
      ...(ws.schemas?.size && { schemas: sharedSchemas(ws) }),
      connectors: registry.connectors.map((c) => ({
        id: c.id,
        name: c.name,
        version: c.version,
        ...(ws.connectorFiles.get(c.id) && { file: ws.connectorFiles.get(c.id) }),
        ...(marks[c.id] && { review: 'alterado pela IA; aguardando revisão do usuário (só plan)' }),
        ...(ws.shared?.get(c.id) && { readOnly: ws.shared.get(c.id) }),
        ...(c.description !== undefined && { description: c.description }),
        ...(c.extends !== undefined && { extends: c.extends }),
        chain: c.chain,
        ...(c.resolved?.baseUrl && { baseUrl: c.resolved.baseUrl.value }),
        ...(c.resolved?.auth && { auth: c.resolved.auth.summary }),
        ...(c.error !== undefined && { error: c.error }),
        endpoints: c.endpoints.map((e) => ({
          id: e.id,
          name: e.name,
          method: e.method,
          path: e.path,
          ...(e.scenarios.length && { scenarios: e.scenarios.map((s) => s.id) })
        }))
      })),
      environments: [...ws.environments.values()].map((env) => {
        const { missingSecrets } = environmentValues(ws, env.id)
        return {
          id: env.id,
          name: env.name,
          variables: Object.entries(env.variables).map(([name, v]) => {
            const secret = !!v.isSecret || v.value === REQUIRED_SECRET || isSensitiveName(name)
            return {
              name,
              ...(secret ? { secret: true, value: missingSecrets.has(name) ? 'sem valor local' : REDACTED } : { value: v.value })
            }
          }),
          ...(isProtectedEnvironment(env) || ctx.protectedEnvironments?.has(env.id)
            ? { protected: true, execution: 'ambiente protegido (produção): só plan' }
            : ctx.allowEnvironments && !ctx.allowEnvironments.has(env.id) && { execution: 'bloqueada para a IA' })
        }
      }),
      flows: plainFlows(flows, ws.flowSources).map(({ file, flow }) => ({
        id: flow.id,
        name: flow.name,
        file,
        ...(marks[flowReviewKey(flow.id)] && { review: 'nós de código escritos pela IA; aguardando revisão do usuário (só plan)' })
      })),
      ...((registry.issues.length || flows.issues.length) && { issues: [...registry.issues, ...flows.issues] })
    }
  }
}

interface TreeNode {
  id: string
  name: string
  children?: TreeNode[]
}

/** A hierarquia de herança (extends): cada conector sob o pai, raízes primeiro, na ordem do catálogo. */
function connectorTree(connectors: readonly { id: string; name: string; extends?: string }[]): TreeNode[] {
  const ids = new Set(connectors.map((c) => c.id))
  const children = new Map<string, TreeNode[]>()
  const nodes = new Map(connectors.map((c) => [c.id, { id: c.id, name: c.name } as TreeNode]))
  const roots: TreeNode[] = []
  for (const c of connectors) {
    const node = nodes.get(c.id)!
    // Pai ausente (herança quebrada) vira raiz; o erro aparece no próprio conector.
    if (c.extends && ids.has(c.extends) && c.extends !== c.id) children.set(c.extends, [...(children.get(c.extends) ?? []), node])
    else roots.push(node)
  }
  const seen = new Set<string>()
  const attach = (node: TreeNode): TreeNode => {
    seen.add(node.id)
    const kids = (children.get(node.id) ?? []).filter((k) => !seen.has(k.id)).map(attach)
    return kids.length ? { ...node, children: kids } : node
  }
  return roots.map(attach)
}

const executeDryRun: McpTool = {
  name: 'execute_dry_run',
  title: 'Executar testes pelo motor do VVPost',
  description:
    'Roda requisições pelo motor do VVPost (herança e auth headless) sem gravar nada. Sem request: os cenários do conector (filtros endpointId e scenarioIds) nos environmentIds, como a matriz do app. Com request: um endpoint com overrides (body, headers, query, pathParams) e assertions. plan: true só monta, sem enviar. A IA nunca vê credenciais, e overrides não referenciam variáveis secretas. Dados pessoais marcados (x-sensitive) vêm como [REDACTED_PII:<tipo>], e as asserções rodam sobre a resposta já mascarada.',
  inputSchema: {
    type: 'object',
    required: ['connectorId'],
    additionalProperties: false,
    properties: {
      connectorId: { type: 'string' },
      environmentIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ambientes em que rodar (uma coluna da matriz por ambiente). Vazio: sem ambiente.'
      },
      endpointId: { type: 'string', description: 'Só os cenários deste endpoint.' },
      scenarioIds: { type: 'array', items: { type: 'string' }, description: 'Só estes cenários (ids do endpoint escolhido). $sem-credencial é o gate de acesso de um endpoint com requiresAuth: chamado sem credencial, dá 401/403 se exige auth.' },
      request: {
        type: 'object',
        required: ['endpointId'],
        additionalProperties: false,
        description: 'Requisição avulsa a partir de um endpoint do conector.',
        properties: {
          endpointId: { type: 'string' },
          overrides: {
            type: 'object',
            additionalProperties: false,
            properties: {
              body: { description: 'Substitui o corpo padrão (null tira o corpo).' },
              headers: {
                oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: { type: ['string', 'null'] } }],
                description: 'Mescla com os headers; null remove todos os herdados e a auth (ex.: testar 401).'
              },
              query: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
              pathParams: { type: 'object', additionalProperties: { type: 'string' } },
              rawPathParams: { type: 'array', items: { type: 'string' } }
            }
          },
          assertions: { type: 'array', items: assertionSchema },
          select: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'string' },
            description: `Só estes campos do corpo JSON da resposta ("pedidos[].id", "pedidos[].status", "total"; [] percorre uma lista): vem até ${SELECTED_BODY_CHARS / 1000} mil caracteres em vez de ${BODY_PREVIEW_CHARS / 1000} mil.`
          }
        }
      },
      plan: { type: 'boolean', description: 'true: só mostra as requisições montadas, sem enviar.' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async call(args, ctx) {
    const ws = await load(ctx)
    const connectorId = String(args['connectorId'])
    let connector
    try {
      connector = resolveConnector(connectorId, ws.connectors)
    } catch (err) {
      // Os ids certos vão no hint: o agente acerta na próxima chamada sem ler o catálogo.
      throw new ToolError((err as Error).message, { code: 'NOT_FOUND', hint: `conectores: ${[...ws.connectors.keys()].join(', ')}` })
    }
    const environmentIds = Array.isArray(args['environmentIds']) ? (args['environmentIds'] as string[]) : []
    for (const id of environmentIds) {
      if (!ws.environments.has(id)) throw new ToolError(`ambiente "${id}" não existe no workspace`, { code: 'NOT_FOUND', hint: `ambientes: ${[...ws.environments.keys()].join(', ')}` })
    }
    const endpointIds = `endpoints de ${connectorId}: ${connector.endpoints.map((e) => `${e.id} (${e.method} ${e.path})`).join(', ')}`
    const plan = args['plan'] === true || !!ctx.readOnly
    if (!plan && ctx.allowEnvironments) {
      const blocked = (environmentIds.length ? environmentIds : ['']).filter((id) => !ctx.allowEnvironments!.has(id))
      if (blocked.length) {
        throw new ToolError(
          `execução bloqueada no(s) ambiente(s) ${blocked.map((id) => (id ? `"${id}"` : '(sem ambiente)')).join(', ')} pela configuração do servidor MCP; use plan: true`
        )
      }
    }
    if (!plan) refuseProtected(ws, environmentIds, ctx)

    const request = args['request'] as
      | { endpointId: string; overrides?: Scenario['overrides']; assertions?: Assertion[]; select?: string[] }
      | undefined
    const jobs: { endpoint: Endpoint; scenario: Scenario; adhoc: boolean }[] = []
    if (request) {
      const endpoint = connector.endpoints.find((e) => e.id === request.endpointId)
      if (!endpoint) throw new ToolError(`endpoint "${request.endpointId}" não existe em "${connectorId}"`, { code: 'NOT_FOUND', hint: endpointIds })
      assertNoSecretRefs(request.overrides ?? {}, secretVariables(ws), 'request.overrides')
      assertNoSecretRefs(request.assertions ?? [], secretVariables(ws), 'request.assertions')
      jobs.push({
        endpoint,
        scenario: {
          id: 'mcp',
          name: 'Requisição da IA',
          ...(request.overrides && { overrides: request.overrides }),
          // Sem asserções da IA, só a resposta volta; o schema do arquivo exige ao menos uma.
          assertions: (request.assertions ?? []) as Scenario['assertions']
        },
        adhoc: true
      })
    } else {
      const endpointId = typeof args['endpointId'] === 'string' ? args['endpointId'] : undefined
      const scenarioIds = Array.isArray(args['scenarioIds']) ? new Set(args['scenarioIds'] as string[]) : undefined
      if (endpointId && !connector.endpoints.some((e) => e.id === endpointId)) {
        throw new ToolError(`endpoint "${endpointId}" não existe em "${connectorId}"`, { code: 'NOT_FOUND', hint: endpointIds })
      }
      for (const endpoint of connector.endpoints) {
        if (endpointId && endpoint.id !== endpointId) continue
        const access = accessCheckScenario(endpoint)
        for (const scenario of [...(endpoint.scenarios ?? []), ...(access ? [access] : [])]) {
          if (scenarioIds && !scenarioIds.has(scenario.id)) continue
          jobs.push({ endpoint, scenario, adhoc: false })
        }
      }
      if (!jobs.length) throw new ToolError('nenhum cenário encontrado com esses filtros; use "request" para uma requisição avulsa')
    }
    const methods = ctx.guard?.policy.allowMethods
    const blockedMethod = !plan && methods && jobs.find((j) => !methods.has(j.endpoint.method))
    if (blockedMethod) {
      throw new ToolError(
        `${blockedMethod.endpoint.method} ${blockedMethod.endpoint.id} bloqueado pela configuração do servidor MCP (métodos permitidos: ${[...methods].join(', ')}); use plan: true`
      )
    }
    if (!plan && (await readReviewMarks(ctx.workspaceDir))[connectorId]) {
      throw new ToolError(
        `"${connectorId}" teve auth, destino ou credenciais alterados pela IA e ainda não foi revisado` +
          (ctx.centralReview ? `: ${CENTRAL_REVIEW}` : ' pelo usuário: até ele salvar o conector no editor do Catálogo do app, só plan: true é aceito')
      )
    }
    const runs = jobs.length * Math.max(environmentIds.length, 1)
    if (runs > MAX_RUNS) throw new ToolError(`${runs} execuções pedidas; o limite por chamada é ${MAX_RUNS}`)

    if (plan) {
      return {
        mode: 'plan',
        ...(ctx.readOnly && { note: 'servidor MCP em modo somente leitura: nada é enviado' }),
        requests: (environmentIds.length ? environmentIds : ['']).flatMap((environmentId) =>
          jobs.map(({ endpoint, scenario, adhoc }) => ({
            environmentId,
            endpointId: endpoint.id,
            ...(!adhoc && { scenarioId: scenario.id }),
            ...planRequest(ws, connectorId, endpoint, scenario, environmentId, ctx.pii)
          }))
        )
      }
    }

    if (request) {
      const results = []
      for (const environmentId of environmentIds.length ? environmentIds : ['']) {
        results.push(await runAdhoc(ws, connectorId, jobs[0]!.endpoint, jobs[0]!.scenario, environmentId, ctx, request.select))
      }
      return { mode: 'request', results }
    }

    const runId = `mcp:${crypto.randomUUID()}`
    const report = await runScenarios(
      {
        runId,
        connectorId,
        environmentIds,
        scenarioKeys: jobs.map((j) => `${j.endpoint.id}/${j.scenario.id}`)
      },
      { workspace: ws, auth: ctx.auth, http: ctx.http, signal: ctx.signal, ...(ctx.guard && { guard: ctx.guard }) }
    )
    return {
      mode: 'scenarios',
      connectorId,
      durationMs: report.durationMs,
      totals: report.totals,
      ...(report.error !== undefined && { error: ctx.pii.text(report.error) }),
      ...(report.canceled && { canceled: true }),
      results: report.results.map((r) => {
        const last = r.requestId ? ctx.http.lastResponse?.(r.requestId) : undefined
        const scenario = connector.endpoints.find((e) => e.id === r.endpointId)?.scenarios?.find((s) => s.id === r.scenarioId)
        return withPreview(maskResult(r, ctx.pii, scenario?.capture), last?.ok ? last.response : undefined, ctx.sanitizer, ctx.pii)
      })
    }
  }
}

/** Corta o texto já sanitizado sem deixar um [REDACTED_SECRET] pela metade. */
function cut(text: string, max = BODY_PREVIEW_CHARS): string {
  if (text.length <= max) return text
  let head = text.slice(0, max)
  const open = head.lastIndexOf('[')
  if (open > max - REDACTED.length && REDACTED.startsWith(head.slice(open))) head = head.slice(0, open)
  return `${head}…`
}

/**
 * Só os campos pedidos do corpo já sanitizado, como um grep na resposta: o agente lê a lista
 * inteira de pedidos sem o corte do preview e sem escrever um script para filtrar.
 */
function selectedBody(body: string, paths: string[]): { body?: unknown; selectError?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { body: cut(body), selectError: 'a resposta não é JSON: veio o começo do corpo' }
  }
  const pick = (value: unknown, segs: string[]): unknown => {
    if (!segs.length) return value
    const [head, ...rest] = segs as [string, ...string[]]
    if (head === '[]') return Array.isArray(value) ? value.map((v) => pick(v, rest)) : undefined
    if (!value || typeof value !== 'object' || Array.isArray(value) || !(head in value)) return undefined
    const inner = pick((value as Record<string, unknown>)[head], rest)
    return inner === undefined ? undefined : { [head]: inner }
  }
  const merge = (a: unknown, b: unknown): unknown => {
    if (a === undefined) return b
    if (b === undefined) return a
    if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => merge(x, b[i]))
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
      for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v)
      return out
    }
    return a
  }
  let picked: unknown
  const missing: string[] = []
  for (const path of paths) {
    const segs = path.replace(/\[\]/g, '.[]').split('.').filter(Boolean)
    const one = pick(parsed, segs)
    if (one === undefined) missing.push(path)
    picked = merge(picked, one)
  }
  const text = JSON.stringify(picked ?? null)
  return {
    body: text.length > SELECTED_BODY_CHARS ? cut(text, SELECTED_BODY_CHARS) : (picked ?? null),
    ...(missing.length && { selectError: `sem esses campos na resposta: ${missing.join(', ')}` })
  }
}

/**
 * Os dados pessoais de um resultado de cenário fora do corpo: o valor de cada asserção e de cada
 * capture pelo caminho de onde veio, a URL, os headers e a mensagem de erro.
 */
function maskResult(result: ScenarioResult, pii: PiiMasker, capture?: Record<string, string>): ScenarioResult {
  return {
    ...result,
    request: { ...result.request, url: pii.text(result.request.url) },
    ...(result.error && { error: { ...result.error, message: pii.text(result.error.message) } }),
    assertions: result.assertions.map((a) => maskAssertion(a, pii)),
    ...(result.captures && {
      captures: Object.fromEntries(Object.entries(result.captures).map(([name, value]) => [name, String(pii.at(capture?.[name] ?? name, value))]))
    }),
    ...(result.responseHeaders && { responseHeaders: pii.sanitize(result.responseHeaders) })
  }
}

/** Asserção com o valor encontrado e o esperado mascarados pelo campo do alvo, também dentro da mensagem. */
function maskAssertion<A extends { target: string; actual?: unknown; expected?: unknown; message: string }>(a: A, pii: PiiMasker): A {
  let message = a.message
  const out = { ...a }
  for (const key of ['actual', 'expected'] as const) {
    const value = a[key]
    if (value === undefined) continue
    const masked = pii.at(a.target, value)
    out[key] = masked as A[typeof key]
    // A mensagem cita o valor ("esperado "x", recebido "y""): sai junto quando o campo é marcado.
    if (masked !== value && (typeof value === 'string' || typeof value === 'number') && String(value)) {
      message = message.split(String(value)).join(String(masked))
    }
  }
  out.message = pii.text(message)
  return out
}

/**
 * Substitui o começo do corpo pelo corpo inteiro sanitizado e só então cortado: um segredo no limite do corte não sai pela metade.
 * Os dados pessoais saem antes, com o corpo ainda inteiro (JSON parseável).
 */
function withPreview(result: ScenarioResult, response: HttpResponseData | undefined, sanitizer: SecretSanitizer, pii: PiiMasker) {
  const { bodyPreview, ...rest } = result
  if (!response) return bodyPreview === undefined ? rest : { ...rest, body: cut(sanitizer.text(pii.text(bodyPreview))) }
  return {
    ...rest,
    body: cut(sanitizer.text(pii.text(response.body))),
    ...(response.truncated && { bodyTruncatedBytes: response.sizeBytes })
  }
}

/** Interpola as variáveis do ambiente para mostrar à IA: segredos viram [REDACTED_SECRET]. */
function shownValues(ws: LoadedWorkspace, environmentId: string): (text: string) => string {
  const { values, missingSecrets } = environmentValues(ws, environmentId || undefined)
  const secrets = secretVariables(ws)
  const shown = new Map([...values].map(([k, v]) => [k, secrets.has(k) ? REDACTED : v]))
  for (const name of missingSecrets) shown.set(name, REDACTED)
  const scope: VariableScope = { values: shown }
  return (text: string) => {
    try {
      return interpolate(text, scope)
    } catch (err) {
      return `${text} (${(err as Error).message})`
    }
  }
}

/**
 * Para onde vai o pedido de token ou de login da auth, já resolvido. Um caminho relativo
 * junta com a baseUrl inteira (com o caminho dela, sem o basePath): a nota diz isso quando
 * a baseUrl tem caminho, que é onde a URL costuma surpreender.
 */
function authTarget(connector: ReturnType<typeof resolveConnector>, v: (text: string) => string) {
  const auth = connector.auth?.config
  const raw = auth?.type === 'oauth2' ? auth.tokenUrl : auth?.type === 'login' ? auth.request.url : undefined
  if (raw === undefined) return {}
  const field = auth!.type === 'oauth2' ? 'tokenUrl' : 'loginUrl'
  const base = connector.baseUrl === undefined ? undefined : v(connector.baseUrl)
  let url: string
  try {
    url = resolveUrl(v(raw), base, field)
  } catch (err) {
    return { [field]: `${raw} (${(err as Error).message})` }
  }
  let basePath = ''
  try {
    basePath = base ? new URL(base).pathname.replace(/\/+$/, '') : ''
  } catch {
    // baseUrl com variável sem valor: sem nota
  }
  const relative = !/^https?:\/\//i.test(v(raw))
  return {
    [field]: url,
    ...(relative && basePath && {
      [`${field}Note`]: `${raw} é relativo e entra depois da baseUrl inteira (${base}); para a raiz do host, use a URL absoluta no conector`
    })
  }
}

/** Com a revisão central, quem aprova é o console do Control Plane: o pedido já foi aberto. */
const CENTRAL_REVIEW = 'a política da organização manda aprovar no console do Control Plane (o pedido de revisão já foi aberto); até lá, só plan: true é aceito'

/** Requisição como seria enviada, com os segredos no lugar de {{VAR}} trocados por [REDACTED_SECRET]. */
/**
 * Ambiente protegido (produção, docs/security-model.md): a IA só lê e valida, nem com --allow-env.
 * Quem libera é o arquivo do ambiente, com "protected": false.
 */
function refuseProtected(ws: LoadedWorkspace, environmentIds: readonly string[], ctx: Pick<ToolContext, 'protectedEnvironments'>) {
  // A política central protege por id e não é desfeita pelo "protected": false do arquivo.
  const hit = environmentIds.map((id) => ws.environments.get(id)).filter((e) => isProtectedEnvironment(e) || (!!e && !!ctx.protectedEnvironments?.has(e.id)))
  if (hit.length) {
    throw new ToolError(
      `${hit.map((e) => `"${e!.id}"`).join(', ')} ${hit.length === 1 ? 'é ambiente protegido' : 'são ambientes protegidos'} (produção): a IA só monta e valida; use plan: true. O disparo é do usuário, no app`
    )
  }
}

function planRequest(ws: LoadedWorkspace, connectorId: string, endpoint: Endpoint, scenario: Scenario, environmentId: string, pii: PiiMasker) {
  let built
  try {
    built = buildScenarioRequest(endpoint, scenario)
  } catch (err) {
    return { error: (err as Error).message }
  }
  const connector = resolveConnector(connectorId, ws.connectors)
  const v = shownValues(ws, environmentId)
  const inheritHeaders = built.options.inheritHeaders !== false
  const dropped = new Set((built.options.dropHeaders ?? []).map((n) => n.toLowerCase()))
  const anonymous = !!built.options.anonymous
  const inherited: HttpHeader[] = inheritHeaders
    ? Object.entries(connector.headers)
        .filter(([name]) => !dropped.has(name.toLowerCase()) && !(anonymous && isCredentialHeader(name)))
        .map(([name, value]) => ({ name, value }))
    : []
  const headers = mergeHeaders(inherited, built.headers)
  const url = connector.baseUrl === undefined ? built.url : joinPath(connector.baseUrl, connector.basePath, built.url)
  const authConfig = connector.auth?.config
  const authHeader = authConfig && authHeaderName(authConfig)
  const authOff = anonymous || !inheritHeaders || (authHeader !== undefined && dropped.has(authHeader.toLowerCase()))
  return {
    method: built.method,
    url: pii.text(v(url)),
    headers: pii.sanitize(headers.map((h) => ({ name: h.name, value: v(h.value) }))),
    ...(built.body !== undefined && { body: pii.text(v(built.body)) }),
    ...(built.payload && { payload: pii.sanitize(built.payload) }),
    auth: authConfig && !authOff ? `${describeAuth(authConfig)} (aplicada pelo VVPost no envio)` : anonymous ? 'nenhuma: o endpoint é público (requiresAuth: false) e vai sem credencial' : 'nenhuma',
    ...(authConfig && !authOff && authTarget(connector, v)),
    ...(scenario.dependsOn?.length && { dependsOn: scenario.dependsOn }),
    ...(scenario.capture && { capture: scenario.capture }),
    ...(scenario.assertions.length && { assertions: scenario.assertions })
  }
}

/**
 * Requisição avulsa da IA. As asserções dela rodam sobre a resposta já sanitizada:
 * um `matches` ou `contains` escrito pela IA não consegue adivinhar um segredo
 * refletido pela API letra por letra pelo passou/falhou.
 */
async function runAdhoc(
  ws: LoadedWorkspace,
  connectorId: string,
  endpoint: Endpoint,
  scenario: Scenario,
  environmentId: string,
  ctx: ToolContext,
  select?: string[]
) {
  // Como nos fluxos da IA, plugins não sobem pelo MCP: o guard dela não alcança o processo do plugin.
  if (endpoint.plugin) {
    return { environmentId, outcome: 'error', error: { code: 'PLUGIN_UNAVAILABLE', message: `o endpoint usa o adapter ${endpoint.plugin.adapter}; endpoints de plugin rodam pelo app ou pelo CLI` } }
  }
  let built
  try {
    built = buildScenarioRequest(endpoint, scenario)
  } catch (err) {
    if (err instanceof ConfigError) return { environmentId, outcome: 'error', error: { code: 'CONFIG_ERROR', message: err.message } }
    throw err
  }
  const result = await sendHeadless(
    {
      id: `mcp:${crypto.randomUUID()}`,
      method: built.method,
      url: built.url,
      headers: built.headers,
      ...(built.body !== undefined && { body: built.body }),
      ...(built.payload && { payload: built.payload }),
      connectorId,
      ...(environmentId && { environmentId })
    },
    { workspace: ws, auth: ctx.auth, http: ctx.http, signal: ctx.signal, ...(ctx.guard && { guard: ctx.guard }) },
    built.options
  )
  const request = { method: built.method, url: ctx.pii.text(built.url) }
  if (!result.ok) {
    return { environmentId, outcome: 'error', request, error: { ...result.error, message: ctx.pii.text(result.error.message) }, ...(result.auth && { auth: result.auth }) }
  }
  // Dados pessoais e depois credenciais: as asserções da IA rodam sobre a resposta já mascarada.
  const response = ctx.sanitizer.sanitize({
    ...result.response,
    headers: ctx.pii.sanitize(result.response.headers),
    body: ctx.pii.text(result.response.body)
  })
  const subject = toSubject(response)
  const assertions = scenario.assertions.map((a) => maskAssertion(evaluateAssertion(a, subject, endpoint.examples), ctx.pii))
  return {
    environmentId,
    outcome: assertions.every((a) => a.passed) ? 'passed' : 'failed',
    request,
    status: response.status,
    durationMs: response.timings.totalMs,
    ...(result.auth && { auth: result.auth }),
    ...(assertions.length && { assertions }),
    ...(select ? selectedBody(response.body, select) : { responseHeaders: response.headers.filter((h) => !TRANSPORT_HEADERS.has(h.name.toLowerCase())), body: cut(response.body) }),
    ...(response.truncated && { bodyTruncatedBytes: response.sizeBytes })
  }
}

/** Headers de transporte, que não dizem nada sobre a API e ficam fora da resposta à IA. */
const TRANSPORT_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'vary', 'server', 'x-powered-by'])

const validateBody: McpTool = {
  name: 'validate_body',
  title: 'Validar corpo com o bodySchema',
  description: 'Confere um corpo de requisição com o bodySchema do endpoint, sem enviar nada. Devolve os problemas com o JSON Pointer de cada campo.',
  inputSchema: {
    type: 'object',
    required: ['connectorId', 'endpointId', 'body'],
    additionalProperties: false,
    properties: {
      connectorId: { type: 'string' },
      endpointId: { type: 'string' },
      body: { description: 'O corpo, como valor JSON ou como texto JSON.' }
    }
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async call(args, ctx) {
    const ws = await load(ctx)
    const body = typeof args['body'] === 'string' ? args['body'] : JSON.stringify(args['body'])
    return validateEndpointBody(ws, String(args['connectorId']), String(args['endpointId']), body)
  }
}

/** Saída de um nó devolvida à IA: sem dados pessoais, sanitizada inteira e só depois cortada, como o corpo dos cenários. */
function nodePreview(value: unknown, ctx: Pick<ToolContext, 'sanitizer' | 'pii'>): string {
  return cut(ctx.sanitizer.text(ctx.pii.text(typeof value === 'string' ? value : JSON.stringify(value))))
}

const executeFlow: McpTool = {
  name: 'execute_flow',
  title: 'Executar um fluxo pelo motor do VVPost',
  description:
    'Roda um fluxo do workspace pelo Context Engine (herança e auth dos conectores) sem gravar nada e devolve cada nó (status, erro, requisição, HTTP, saída cortada, logs do Python). plan: true só lista. Nós de plugin não rodam aqui; código e auth alterados pela IA só rodam depois da revisão no app. Dados pessoais marcados (x-sensitive) vêm como [REDACTED_PII:<tipo>].',
  inputSchema: {
    type: 'object',
    required: ['flowId'],
    additionalProperties: false,
    properties: {
      flowId: { type: 'string', description: 'Id do fluxo (veja get_api_catalog ou get_source com kind flow).' },
      environmentId: { type: 'string', description: 'Ambiente que resolve os {{VAR}}. Ausente: sem ambiente.' },
      plan: { type: 'boolean', description: 'true: só mostra os nós e as requisições, sem enviar.' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async call(args, ctx) {
    const ws = await load(ctx)
    const flowId = String(args['flowId'])
    const { flows } = await loadFlows(ctx.workspaceDir)
    const found = flows.find((f) => f.flow.id === flowId)
    if (!found) throw new ToolError(`fluxo "${flowId}" não existe (${flows.map((f) => f.flow.id).join(', ') || 'nenhum fluxo no workspace'})`)
    // Um fluxo com extends usa o conector-pai nos nós sem conector, também para a revisão abaixo.
    const flow = inheritConnector(found.flow)
    const environmentId = typeof args['environmentId'] === 'string' ? args['environmentId'] : ''
    if (environmentId && !ws.environments.has(environmentId)) throw new ToolError(`ambiente "${environmentId}" não existe no workspace`)

    const requests = flow.nodes.flatMap((n) => {
      if (n.type !== 'request') return []
      let method = n.request.method
      let path = n.request.url
      if (n.request.endpoint && n.request.connector) {
        try {
          const endpoint = resolveConnector(n.request.connector, ws.connectors).endpoints.find((e) => e.id === n.request.endpoint)
          method ??= endpoint?.method
          path ??= endpoint?.path
        } catch {
          // Conector inválido: o motor devolve o erro no nó.
        }
      }
      const poll = n.request.poll
      // Com polling, o nó pode mandar várias requisições: conta o máximo para o limite por chamada.
      const attempts = poll ? (poll.maxAttempts ?? Math.floor((poll.timeoutMs ?? 30_000) / (poll.intervalMs ?? 1000)) + 1) : 1
      return [
        {
          node: n.name,
          ...(n.request.connector && { connector: n.request.connector }),
          ...(n.request.endpoint && { endpoint: n.request.endpoint }),
          method,
          path,
          ...(poll && { poll: { until: poll.until, maxAttempts: attempts } }),
          attempts
        }
      ]
    })
    const plan = args['plan'] === true || !!ctx.readOnly
    if (plan) {
      return {
        mode: 'plan',
        flowId,
        file: found.file,
        ...(ctx.readOnly && { note: 'servidor MCP em modo somente leitura: nada é enviado' }),
        nodes: flow.nodes.map((n) => ({
          id: n.id,
          name: n.name,
          type: n.type,
          ...(n.type === 'wait' && { waitMs: n.wait.ms }),
          ...(n.type === 'webhook' && { webhook: n.webhook }),
          ...(n.type === 'condition' && n.failWhenFalse && { failWhenFalse: true })
        })),
        edges: flow.edges ?? [],
        requests: requests.map(({ attempts: _, ...r }) => r)
      }
    }

    if (ctx.allowEnvironments && !ctx.allowEnvironments.has(environmentId)) {
      throw new ToolError(
        `execução bloqueada no ambiente ${environmentId ? `"${environmentId}"` : '(sem ambiente)'} pela configuração do servidor MCP; use plan: true`
      )
    }
    refuseProtected(ws, [environmentId], ctx)
    const methods = ctx.guard?.policy.allowMethods
    const blocked = methods && requests.find((r) => r.method && !methods.has(r.method))
    if (blocked) {
      throw new ToolError(
        `o nó ${blocked.node} faz ${blocked.method}, bloqueado pela configuração do servidor MCP (métodos permitidos: ${[...methods!].join(', ')}); use plan: true`
      )
    }
    const total = requests.reduce((sum, r) => sum + r.attempts, 0)
    if (total > MAX_RUNS) {
      throw new ToolError(`o fluxo pode mandar ${total} requisições (contando as tentativas de polling); o limite por chamada é ${MAX_RUNS}`)
    }
    // Fluxos com código de antes da revisão (ou vindos do Git) também passam pela revisão do usuário.
    await markUnreviewedFlows(ctx.workspaceDir)
    const marks = await readReviewMarks(ctx.workspaceDir)
    if (marks[flowReviewKey(flowId)]) {
      throw new ToolError(
        `"${flowId}" tem nós de código escritos ou mudados pela IA e ainda não foi revisado` +
          (ctx.centralReview ? `: ${CENTRAL_REVIEW}` : ' pelo usuário: até ele salvar o fluxo no Flow Studio do app, só plan: true é aceito')
      )
    }
    // Rodar uma base é rodar o login dela: a revisão da auth vale para a própria base.
    const connectors = [...requests.map((r) => r.connector), ...(isBaseFlow(flow) ? [flow.id] : [])]
    const pending = [...new Set(connectors.filter((id): id is string => !!id && !!marks[id]))]
    if (pending.length) {
      throw new ToolError(
        `${pending.map((id) => `"${id}"`).join(', ')} teve auth, destino ou credenciais alterados pela IA e ainda não foi revisado` +
          (ctx.centralReview ? `: ${CENTRAL_REVIEW}` : ' pelo usuário: até ele salvar o conector no editor do Catálogo do app, só plan: true é aceito')
      )
    }

    const webhooks = flow.nodes.some((n) => n.type === 'webhook') ? ctx.webhooks?.() : undefined
    const report = await runFlow(
      { runId: `mcp:${crypto.randomUUID()}`, flow, ...(environmentId && { environmentId }) },
      {
        workspace: ws,
        auth: ctx.auth,
        http: ctx.http,
        ...(ctx.signal && { signal: ctx.signal }),
        ...(ctx.guard && { guard: ctx.guard }),
        ...(webhooks
          ? {
              // A chamada da IA não fica presa a um nó que espera uma hora: no máximo MCP_WEBHOOK_WAIT_MS.
              webhooks: {
                cursor: () => webhooks.inbox.cursor(),
                wait: (accept, o) => webhooks.inbox.wait(accept, { ...o, timeoutMs: Math.min(o.timeoutMs, MCP_WEBHOOK_WAIT_MS) })
              }
            }
          : { webhooksError: 'o servidor de webhooks está desligado: ligue-o na barra de status do app (Webhooks) ou rode o MCP com --webhooks' })
      }
    )
    // Na ordem do fluxo, não na ordem em que os nós terminaram.
    const order = new Map(flow.nodes.map((n, i) => [n.id, i]))
    const v = shownValues(ws, environmentId)
    return {
      mode: 'flow',
      flowId,
      environmentId,
      outcome: report.outcome,
      durationMs: report.durationMs,
      ...(report.error !== undefined && { error: ctx.pii.text(report.error) }),
      nodes: [...report.results]
        .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
        .map((r) => ({
          id: r.nodeId,
          name: r.name,
          status: r.status,
          durationMs: r.durationMs,
          ...(r.reason && { reason: r.reason }),
          ...(r.error && { error: { ...r.error, message: ctx.pii.text(r.error.message) } }),
          ...(r.request && { request: { method: r.request.method, url: ctx.pii.text(v(r.request.url)) } }),
          ...(r.attempts !== undefined && { attempts: r.attempts }),
          ...(r.auth && { auth: r.auth }),
          ...(r.output?.status !== undefined && { httpStatus: r.output.status }),
          ...(r.output && { data: nodePreview(r.output.data, ctx) }),
          ...(r.logs && { logs: nodePreview(r.logs, ctx) })
        }))
    }
  }
}

const listProjects: McpTool = {
  name: 'list_projects',
  title: 'Projetos do workspace',
  description:
    'Lista os projetos do workspace (subpastas com vvpost.project.json) e diz em qual a chamada está. ' +
    'Toda outra ferramenta aceita project: "<id>" para ler, editar ou rodar naquele projeto; sem project, vale a pasta em que o servidor abriu ' +
    '(a raiz é o Compartilhado, visível em todos os projetos e só leitura dentro deles). Um projeto herda a base de outro com "extends": "<projeto>:<id>". ' +
    'Um projeto com reference é o catálogo de outro repositório (a API que o front ou o app consome), só para leitura: project: "<id>" lê as rotas e os schemas de lá.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async call(_args, ctx) {
    const layout = projectLayout(ctx.workspaceDir)
    return {
      workspace: layout.root,
      current: layout.current ? layout.current.id : layout.projects.length ? null : 'o workspace inteiro é um projeto só (sem subpastas de projeto): use as ferramentas sem project; get_api_catalog mostra o que ele documenta',
      ...(layout.projects.length && !layout.current && { note: 'esta chamada está no Compartilhado (a raiz do workspace)' }),
      projects: layout.projects,
      ...(ctx.reference && { reference: ctx.reference }),
      ...(layout.issues.length && { issues: layout.issues })
    }
  }
}

const createProjectTool: McpTool = {
  name: 'create_project',
  title: 'Criar um projeto no workspace',
  description:
    'Cria um projeto no workspace (subpasta com vvpost.project.json, o id vem do nome), como o "Novo projeto…" do app. ' +
    'Idempotente: se o projeto já existe, devolve existed: true sem mudar nada. Depois, use project: "<id>" nas outras ferramentas.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, description: 'Nome do projeto (ex.: "Estoque").' },
      description: { type: 'string' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    if (ctx.readOnly || ctx.noWrite) throw new ToolError('a edição do projeto está desligada neste servidor MCP', { code: 'BLOCKED' })
    const [{ createProject }, { slug }] = await Promise.all([import('../workspace/projects'), import('../importers/postman')])
    const name = String(args['name']).trim()
    const root = projectLayout(ctx.workspaceDir).root
    const existing = projectLayout(root).projects.find((p) => p.id === slug(name))
    if (existing) return { ok: true, existed: true, project: existing.id, folder: existing.folder }
    try {
      await createProject(root, name, typeof args['description'] === 'string' ? args['description'] : undefined)
    } catch (err) {
      throw new ToolError((err as Error).message, { code: 'VALIDATION', hint: 'list_projects mostra os projetos e as pastas que já existem' })
    }
    const created = projectLayout(root).projects.find((p) => p.id === slug(name))!
    return { ok: true, project: created.id, folder: created.folder }
  }
}

const installAgentRules: McpTool = {
  name: 'install_agent_rules',
  title: 'Instalar a regra do VVPost no repositório de código',
  description:
    'Grava no AGENTS.md (ou CLAUDE.md) de um repositório de código o trecho do VVPost: a documentação dele fica no VVPost e, ao mudar o código, o agente atualiza junto o catálogo, as páginas e o PDF. ' +
    'Sem essa regra no repositório, um agente que mexe só no código esquece a documentação. Idempotente: com o trecho já lá, não muda nada. Proponha à pessoa antes de instalar.',
  inputSchema: {
    type: 'object',
    required: ['repo'],
    additionalProperties: false,
    properties: {
      repo: { type: 'string', description: 'Caminho absoluto da pasta do repositório de código.' },
      file: { enum: ['CLAUDE.md', 'AGENTS.md'], description: 'Padrão: AGENTS.md, com o CLAUDE.md importando-o (@AGENTS.md); só CLAUDE.md quando o repositório só tem ele.' },
      dryRun: { type: 'boolean', description: 'Só diz o que faria.' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    if (ctx.readOnly || ctx.noWrite) throw new ToolError('a edição está desligada neste servidor MCP', { code: 'BLOCKED' })
    const repo = String(args['repo'])
    const [{ existsSync, statSync }, { isAbsolute, join }, docs] = await Promise.all([import('node:fs'), import('node:path'), import('@vvpost/core/docs')])
    if (!isAbsolute(repo) || !existsSync(repo) || !statSync(repo).isDirectory()) {
      throw new ToolError(`"${repo}" não é uma pasta que existe`, { code: 'INVALID_ARGS', hint: 'mande o caminho absoluto da raiz do repositório de código' })
    }
    const dryRun = args['dryRun'] === true
    const target = typeof args['file'] === 'string' ? { file: args['file'] } : await docs.agentRuleTarget(repo)
    const layout = projectLayout(ctx.workspaceDir)
    const result = await docs.installAgentSnippet(
      join(repo, target.file),
      { workspace: layout.root, ...(layout.current && { project: layout.current.id }) },
      { dryRun }
    )
    // O CLAUDE.md importa o AGENTS.md: uma regra só, lida pelo Claude Code e pelo Codex.
    const claudeImport = 'claudeImport' in target && target.claudeImport ? await docs.ensureClaudeImportsAgents(repo, { dryRun }) : undefined
    return {
      ok: true,
      ...result,
      ...(claudeImport && claudeImport !== 'unchanged' && { claudeImport: { file: join(repo, 'CLAUDE.md'), action: claudeImport } }),
      ...('note' in target && target.note && { hint: target.note }),
      ...(dryRun && (result.action !== 'unchanged' || (claudeImport && claudeImport !== 'unchanged')) && { dryRun: true, note: 'nada foi gravado' })
    }
  }
}

export const TOOLS: readonly McpTool[] = [listProjects, createProjectTool, getApiCatalog, executeDryRun, executeFlow, validateBody, installAgentRules]
