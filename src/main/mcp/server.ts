import { validateJsonSchema } from '@vvpost/schemas'
import type { AuthEngine } from '@vvpost/core/connectors/auth'
import type { HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { createRequestGuard, type RequestGuard, type RequestPolicy } from '@vvpost/core/policy/request-policy'
import { createSecretSanitizer, type SecretSanitizer } from '@vvpost/core/sanitizer'
import { createPiiMasker, type PiiMasker, type PiiOptions } from '@vvpost/core/pii'
import { effectiveAgentPolicy, toolCallEvent, type CentralAgentPolicy } from './central'
import type { AgentPolicyState } from '../enterprise/control-plane'
import { EDIT_TOOLS } from './edit-tools'
import { DOC_PROMPTS, DOC_RESOURCES, PromptError, promptArguments } from './harness'
import { resolveProject, type ProjectTarget } from '../workspace/references'
import { TOOLS, ToolError, type McpTool, type McpWebhooks, type ToolContext } from './tools'
import { WEBHOOK_TOOLS } from './webhook-tools'
import { BRAND_TOOLS } from './brand-tools'
import { LINT_TOOLS } from './lint-tools'
import { READINESS_TOOLS } from './readiness-tools'
import { featureDenial } from '@vvpost/core/policy/features'
import { fitPayload } from './budget'
import { MCP_SEARCH_TERMS } from '@shared/mcp-tools'
import { isModernVersion, LEGACY_VERSIONS, META, ProtocolError, requestedVersion, SUPPORTED_VERSIONS } from './protocol'
import { createSkillCatalog, SKILLS_CAPABILITY, SKILLS_EXTENSION, type SkillCatalog } from './skills'

/** Versões do protocolo MCP que o servidor fala, da mais nova para a mais antiga (modernas e com initialize). */
export const PROTOCOL_VERSIONS = SUPPORTED_VERSIONS
const SERVER_INFO = { name: 'vvpost', title: 'VVPost', version: '0.1.0' }

// Vai em toda conversa: curto. O detalhe fica nas descrições das ferramentas e no guia.
// A primeira linha é tudo o que o Codex mostra do servidor antes de carregar uma ferramenta (a primeira linha das
// instruções, cortada em 250 caracteres): ela diz quando usar o VVPost e a regra da credencial.
export const INSTRUCTIONS_SUMMARY =
  'VVPost: catálogo, testes e docs das APIs deste código. Ao mudar uma API, atualize-o junto (edit_project, sync_openapi). ' +
  'Chamar uma API: execute_dry_run, nunca curl: a credencial sai do cofre.'
export const INSTRUCTIONS_FIRST_LINE_MAX = 250

const INSTRUCTIONS_DETAIL =
  'Leia junto (get_api_catalog { view: "summary" }, get_source { ids }) e grave direto, sem dryRun: edit_project e write_docs_page validam, gravam tudo ou nada e devolvem o resultado conferido; não reconsulte depois. ' +
  'Ao mudar o código de um sistema daqui, atualize no mesmo trabalho o catálogo e as páginas que descrevem a mudança. Uma mudança de API é um edit_project só: replaceReferences (find_references { terms } diz em exact onde ela troca; escolha o in por ele), setSchemaField { fillExamples: true } e writePage { file, edits }. ' +
  'Conector que segue uma spec OpenAPI gerada pelo código (source): depois de regerar a spec, sync_openapi { apply: true } em vez de editar os endpoints. ' +
  'Com documentErrors na resposta, corrija as diretivas; com stalePdf, rode export_docs. Sem stalePdf, não exporte. ' +
  'Para chamar uma API do catálogo use execute_dry_run { connectorId, environmentIds, request: { endpointId, overrides, select } }, não curl nem script: a auth sai do cofre. Antes do primeiro disparo, ou quando ele falhar sem motivo claro, check_readiness diz o que impede de rodar. ' +
  'Sem o trecho do VVPost (<!-- vvpost:docs -->) no CLAUDE.md ou AGENTS.md do repositório, ofereça install_agent_rules { repo }. ' +
  'Credenciais: nunca peça nem escreva; use {{VAR}} de variável secreta. Vários projetos: list_projects e project nas ferramentas (com um só, não precisa). ' +
  'Documente pelo documento do projeto (save_docs_project, páginas em docs/ com {{> include}}); não crie arquivos .md soltos; guia em vvpost://docs/guia. ' +
  'Passo a passos (skills): skill://atualizar-docs-com-o-codigo/SKILL.md, skill://chamar-api/SKILL.md e skill://documentar-projeto/SKILL.md. ' +
  'Com a pessoa editando no app, mande expect {caminho: versão}; com CONFLICT nada foi gravado. Erros trazem code e hint.'

/** As instruções do initialize: o resumo na primeira linha, o aviso da regra (quando falta) e o detalhe depois. */
export const serverInstructions = (repoWithoutRule?: string) =>
  [INSTRUCTIONS_SUMMARY, ...(repoWithoutRule ? [ruleNotice(repoWithoutRule)] : []), INSTRUCTIONS_DETAIL].join('\n')

/**
 * Vai na recusa quando a política central está fora: é temporário, e o agente não deve contornar
 * gravando os arquivos do projeto à mão (o que a política bloqueou passaria sem a trilha e a revisão).
 */
const CENTRAL_DOWN_HINT =
  'restrição temporária: a sessão com o Control Plane caiu e o servidor tenta voltar sozinho (a cada 30 s, na próxima chamada). Não contorne editando os arquivos do projeto à mão: tente esta ferramenta de novo em instantes; se continuar bloqueado, pare e avise quem opera o ambiente'

/** Vai nas respostas com marca de revisão quando a política manda aprovar no console. */
const CENTRAL_REVIEW_NOTE =
  'a política da organização manda aprovar no console do Control Plane: o VVPost abre o pedido de revisão sozinho; até a aprovação, execute_dry_run e execute_flow só montam o plano'

/** Vai na frente das instruções quando o repositório de código da sessão ainda não tem a regra. */
const ruleNotice = (repo: string) =>
  `O repositório de código desta sessão (${repo}) ainda não tem a regra do VVPost no CLAUDE.md ou AGENTS.md. ` +
  `Além de fazer o pedido e atualizar a documentação como dito abaixo, ofereça à pessoa install_agent_rules { repo: ${JSON.stringify(repo)} }, mesmo que o pedido seja só sobre o código: ` +
  'com a regra, as próximas sessões atualizam a documentação junto com o código sem depender destas instruções.'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export const RpcError = {
  Parse: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603
} as const

export interface McpServerOptions {
  workspaceDir: string
  http: Pick<HttpDispatcher, 'send' | 'cancel'>
  auth: AuthEngine
  readOnly?: boolean
  /** Desliga a edição do projeto (edit_project, import_postman com apply); readOnly também desliga. */
  noWrite?: boolean
  allowEnvironments?: ReadonlySet<string>
  /** Métodos que a IA pode disparar; ausente: todos. */
  allowMethods?: RequestPolicy['allowMethods']
  /** Troca os limites padrão (MCP_POLICY_DEFAULTS) de taxa, concorrência e timeout. */
  limits?: Pick<RequestPolicy, 'rate' | 'maxConcurrent' | 'maxTimeoutMs'>
  /** Para testes: as ferramentas e o sanitizer usados. */
  tools?: readonly McpTool[]
  /** Para testes: as skills publicadas (Skills over MCP). Ausente: as do VVPost. */
  skills?: SkillCatalog
  /**
   * Só estas ferramentas são anunciadas e atendem (--tools: perfis e nomes). Ausente: todas. Cada
   * definição anunciada vai em todo turno do agente, então um passo que usa poucas paga menos.
   */
  toolNames?: ReadonlySet<string>
  /**
   * Modo enxuto (--enxuto): o tools/list traz de cada ferramenta só a primeira frase e os tipos dos argumentos, e
   * describe_tool devolve o resto quando a IA vai usá-la. A validação continua com o schema inteiro.
   */
  enxuto?: boolean
  sanitizer?: SecretSanitizer
  pii?: PiiMasker
  /**
   * Detecção por padrão de dados pessoais nos campos não marcados (--pii-detect, política Enterprise).
   * Soma com a do .vvpost/privacy.json do workspace; os campos com x-sensitive são mascarados sempre.
   */
  piiDetect?: PiiOptions['detect']
  /** Lida a cada chamada: a política Enterprise da sessão aberta no app pode ligar a detecção a qualquer momento. */
  piiPolicy?: () => PiiOptions['detect']
  /** Servidor local de webhooks, quando ligado: list_webhook_events, get_webhook_event e nós webhook. */
  webhooks?: () => McpWebhooks | null
  log?: (line: string) => void
  /** Uma linha por chamada de ferramenta (--stats): para medir chamadas e o tamanho das respostas por tarefa. */
  stats?: (entry: McpCallStats) => void
  /**
   * Política do agente do Control Plane (módulo Enterprise): restringe as flags acima, recebe um
   * evento por chamada e aprova revisões pelo console. Ausente: só as flags locais valem.
   */
  central?: CentralAgentPolicy
  /** De onde o servidor roda, para a trilha: stdio (mcp.js) ou app (barra de status). */
  surface?: 'stdio' | 'app'
  /**
   * Repositório de código em que o cliente iniciou o servidor (--repo ou a pasta atual do stdio). Sem a
   * regra do VVPost nele, as instruções e a primeira resposta de ferramenta pedem para oferecer install_agent_rules.
   */
  codeRepo?: string
}

export interface McpCallStats {
  tool: string
  project?: string
  ms: number
  /** Caracteres dos argumentos e da resposta (≈ 4 por token). */
  inChars: number
  outChars: number
  error?: string
}

export interface McpServer {
  /** Trata uma mensagem JSON-RPC (ou um lote) já parseada. null: nada a responder (notificação). */
  handle(message: unknown, signal?: AbortSignal): Promise<JsonRpcResponse | JsonRpcResponse[] | null>
  sanitizer: SecretSanitizer
  pii: PiiMasker
}

/**
 * Núcleo do servidor MCP, independente do transporte: stdio e SSE só
 * entregam mensagens aqui. Toda saída de ferramenta, inclusive mensagens de erro,
 * passa pelo Secret Sanitizer, e o texto final passa de novo como rede de segurança.
 */
const PROJECT_ARG = {
  type: 'string',
  description: 'Projeto do workspace (veja list_projects). Ausente: a pasta em que o servidor abriu.'
}

/** Toda ferramenta aceita project: o schema publicado e o validado ganham a propriedade. */
function withProject(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema['properties'] as Record<string, unknown> | undefined
  if (schema['type'] !== 'object' || !properties || 'project' in properties) return schema
  return { ...schema, properties: { ...properties, project: PROJECT_ARG } }
}

/** A descrição completa, como o tools/list padrão anuncia (com os termos de busca). */
function fullDescription(t: McpTool): string {
  return MCP_SEARCH_TERMS[t.name] ? `${t.description}\nTerms: ${MCP_SEARCH_TERMS[t.name]}.` : t.description
}

const ENXUTO_DESC = 120

/** O anúncio do modo enxuto: a primeira frase (até ENXUTO_DESC caracteres) e só o tipo de cada argumento. */
export function leanTool(t: McpTool): { name: string; description: string; inputSchema: Record<string, unknown> } {
  const first = t.description.split('\n')[0]!
  const dot = first.search(/\.\s/)
  let description = dot >= 0 && dot < ENXUTO_DESC ? first.slice(0, dot + 1) : first
  if (description.length > ENXUTO_DESC) description = `${description.slice(0, ENXUTO_DESC - 1).trimEnd()}…`
  const schema = withProject(t.inputSchema)
  const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>
  const properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v && 'type' in v ? { type: v['type'] } : {}]))
  const required = schema['required']
  return { name: t.name, description, inputSchema: { type: 'object', properties, ...(Array.isArray(required) && required.length && { required }) } }
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const sanitizer = options.sanitizer ?? createSecretSanitizer()
  // A detecção do servidor (--pii-detect, política Enterprise) só soma com a do workspace.
  const pii = options.pii ?? createPiiMasker({ detect: options.piiDetect ?? false })
  const allTools = options.tools ?? [...TOOLS, ...READINESS_TOOLS, ...EDIT_TOOLS, ...LINT_TOOLS, ...BRAND_TOOLS, ...WEBHOOK_TOOLS]
  const tools = options.toolNames ? allTools.filter((t) => options.toolNames!.has(t.name)) : [...allTools]
  if (options.enxuto) {
    tools.push({
      name: 'describe_tool',
      title: 'Descrever ferramentas',
      description:
        'A descrição e o inputSchema completos das ferramentas pedidas. Neste servidor (modo enxuto) o tools/list traz só a primeira frase e o tipo de cada argumento: chame antes de usar uma ferramenta pela primeira vez.',
      inputSchema: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Nomes das ferramentas, como no tools/list' } },
        required: ['names'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      async call(args) {
        const names = args['names'] as string[]
        const unknown = names.filter((n) => !tools.some((t) => t.name === n))
        if (unknown.length) throw new ToolError(`ferramenta desconhecida: ${unknown.join(', ')}`, { code: 'NOT_FOUND', hint: 'os nomes estão no tools/list' })
        return {
          tools: names.map((n) => {
            const t = tools.find((x) => x.name === n)!
            return { name: t.name, description: fullDescription(t), inputSchema: withProject(t.inputSchema), ...(t.annotations && { annotations: t.annotations }) }
          })
        }
      }
    })
  }
  // Sem install_agent_rules no perfil, o agente não tem como instalar a regra: não pede.
  const offersRule = tools.some((t) => t.name === 'install_agent_rules')
  const http = sanitizer.track(options.http)
  const log = options.log ?? (() => {})
  /** O repositório de código a oferecer a regra, ou null quando já a tem (ou não há um). */
  const missingRule = async (): Promise<string | null> => {
    if (!options.codeRepo || !offersRule) return null
    const { agentSnippetFile } = await import('@vvpost/core/docs')
    return (await agentSnippetFile(options.codeRepo)) ? null : options.codeRepo
  }
  let ruleHintSent = false
  // A política central que cai (ou volta) no meio da sessão vai para o log do processo, uma vez
  // por mudança: no worker o operador vê no log do contêiner, não só o agente na resposta.
  let centralStatus: string | null = null
  const noteCentral = (state: AgentPolicyState) => {
    if (state.status === centralStatus) return
    const was = centralStatus
    centralStatus = state.status
    if (state.status === 'unavailable') log(`AVISO: política do agente indisponível (${state.reason}): modo mais restrito, edição e disparos bloqueados até o Control Plane voltar`)
    else if (was === 'unavailable' && state.status === 'active') log(`política do agente do Control Plane de volta (${state.source})`)
  }
  const local = {
    ...(options.readOnly && { readOnly: true }),
    ...(options.noWrite && { noWrite: true }),
    ...(options.allowMethods && { allowMethods: options.allowMethods }),
    ...(options.allowEnvironments && { allowEnvironments: options.allowEnvironments }),
    ...(options.limits && { limits: options.limits })
  }
  // Um guard para o servidor inteiro: o limite de taxa vale entre chamadas, não por chamada.
  // Só é recriado quando a política central muda os limites.
  let guard: { key: string; guard: RequestGuard } | null = null
  const guardFor = (policy: ReturnType<typeof effectiveAgentPolicy>): RequestGuard => {
    if (guard?.key !== policy.key) {
      guard = {
        key: policy.key,
        guard: createRequestGuard({
          actor: 'a IA (MCP)',
          ...policy.limits,
          ...(policy.allowMethods && { allowMethods: policy.allowMethods }),
          ...(policy.allowEnvironments && { allowEnvironments: policy.allowEnvironments })
        })
      }
    }
    return guard.guard
  }

  const skills = options.skills ?? createSkillCatalog()
  const capabilities = {
    tools: { listChanged: false },
    prompts: { listChanged: false },
    resources: { listChanged: false },
    extensions: { [SKILLS_EXTENSION]: SKILLS_CAPABILITY }
  }
  const ok = (id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
  const fail = (id: JsonRpcResponse['id'], code: number, message: string, data?: unknown): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message: sanitizer.text(message), ...(data !== undefined && { data }) }
  })
  /** Pedidos em andamento, para o notifications/cancelled do stdio parar o trabalho. */
  const inflight = new Map<string, AbortController>()

  async function callTool(params: Record<string, unknown>, signal?: AbortSignal) {
    const name = params['name']
    const tool = tools.find((t) => t.name === name)
    if (!tool) return null
    const args = (params['arguments'] ?? {}) as Record<string, unknown>
    const started = Date.now()
    const centralState = options.central?.state() ?? { status: 'none' as const }
    const policy = effectiveAgentPolicy(local, centralState)
    noteCentral(centralState)
    const toolResult = (payload: unknown, isError = false) => {
      const code = isError ? String((payload as { code?: unknown }).code ?? 'ERROR') : undefined
      // Recusa com a política central restringindo: a IA (e a pessoa) sabem de onde veio o limite.
      if (code === 'BLOCKED' && policy.restrictedBy) {
        payload = { ...(payload as object), policy: policy.restrictedBy, ...(centralState.status === 'unavailable' && { hint: CENTRAL_DOWN_HINT }) }
      }
      // Com a revisão central, a nota de revisão das ferramentas de edição aponta o console, não o app.
      const review = !isError && policy.centralReview && payload && typeof payload === 'object' ? (payload as { review?: unknown }).review : undefined
      if (review !== undefined) payload = { ...(payload as object), review: { ...(typeof review === 'object' ? review : { note: review }), approval: CENTRAL_REVIEW_NOTE } }
      // Sanitiza a estrutura e de novo o texto serializado: o que a IA recebe é exatamente este texto.
      // JSON sem indentação: a resposta é lida por um modelo, e o espaço em branco só custa tokens.
      // Resposta grande demais é cortada aqui, por item inteiro e com a dica, e não no meio do texto pelo cliente.
      const text = sanitizer.text(JSON.stringify(sanitizer.sanitize(fitPayload(payload))))
      options.stats?.({
        tool: tool.name,
        ...(typeof args['project'] === 'string' && { project: args['project'] }),
        ms: Date.now() - started,
        inChars: JSON.stringify(args ?? {}).length,
        outChars: text.length,
        ...(code !== undefined && { error: code })
      })
      const safeArgs = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}
      options.central?.record(toolCallEvent(tool.name, safeArgs, options.surface ?? 'stdio', { ms: Date.now() - started, ...(code !== undefined && { errorCode: code }) }))
      return {
        content: [{ type: 'text', text }],
        ...(!isError && { structuredContent: JSON.parse(text) as unknown }),
        isError
      }
    }
    // A organização desligou o MCP: o servidor responde, mas nenhuma ferramenta roda.
    const off = featureDenial('mcp')
    if (off) return toolResult({ error: off, code: 'POLICY_DENIED' }, true)
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return toolResult({ error: 'arguments deve ser um objeto', code: 'INVALID_ARGS' }, true)
    }
    const valid = validateJsonSchema(withProject(tool.inputSchema), args)
    if (!valid.ok) {
      return toolResult(
        { error: 'argumentos inválidos', code: 'INVALID_ARGS', issues: valid.issues, hint: `confira o inputSchema de ${tool.name} em ${options.enxuto ? 'describe_tool' : 'tools/list'}` },
        true
      )
    }
    // project escolhe a pasta do projeto no workspace; a ferramenta não vê o argumento.
    const { project, ...toolArgs } = args
    let workspaceDir = options.workspaceDir
    let reference: ProjectTarget['reference']
    if (typeof project === 'string') {
      try {
        ;({ dir: workspaceDir, reference } = await resolveProject(options.workspaceDir, project))
      } catch (err) {
        return toolResult({ error: (err as Error).message, code: 'UNKNOWN_PROJECT', hint: 'list_projects mostra os ids dos projetos' }, true)
      }
    }
    if (options.piiPolicy) pii.addDetect(options.piiPolicy())
    if (policy.piiDetect) pii.addDetect(true)
    // Aprovações do console valem antes de a ferramenta olhar as marcas de revisão.
    if (policy.centralReview) await options.central?.syncReviews(workspaceDir)
    const ctx: ToolContext = {
      workspaceDir,
      sanitizer,
      pii,
      auth: options.auth,
      http,
      guard: guardFor(policy),
      ...(policy.readOnly && { readOnly: true }),
      ...((policy.noWrite || reference) && { noWrite: true }),
      ...(reference && { reference }),
      ...(policy.allowEnvironments && { allowEnvironments: policy.allowEnvironments }),
      ...(policy.protectedEnvironments && { protectedEnvironments: policy.protectedEnvironments }),
      ...(policy.centralReview && { centralReview: true }),
      ...(options.webhooks && { webhooks: options.webhooks }),
      ...(signal && { signal })
    }
    try {
      const result = await tool.call(toolArgs, ctx)
      // Um lembrete, na primeira resposta, para o agente que não leu as instruções até o fim.
      if (!ruleHintSent && tool.name !== 'install_agent_rules' && result && typeof result === 'object' && !Array.isArray(result)) {
        ruleHintSent = true
        const repo = await missingRule()
        if (repo) {
          return toolResult({
            ...result,
            agentRules: { repo, installed: false, hint: `ofereça à pessoa install_agent_rules { repo: ${JSON.stringify(repo)} }: sem a regra no CLAUDE.md ou AGENTS.md, a próxima sessão pode mudar o código e esquecer a documentação` }
          })
        }
      }
      return toolResult(result)
    } catch (err) {
      if (!(err instanceof ToolError)) {
        log(`erro em ${tool.name}: ${sanitizer.text((err as Error).stack ?? String(err))}`)
        return toolResult({ error: (err as Error).message, code: 'INTERNAL' }, true)
      }
      return toolResult({ error: err.message, code: 'INVALID_REQUEST', ...err.details }, true)
    }
  }

  async function handleOne(msg: unknown, signal?: AbortSignal): Promise<JsonRpcResponse | null> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, RpcError.InvalidRequest, 'mensagem JSON-RPC inválida')
    const req = msg as Partial<JsonRpcRequest>
    const isNotification = !('id' in req) || req.id === undefined
    const id = (req.id ?? null) as JsonRpcResponse['id']
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      // Respostas do cliente (a pedidos que este servidor não faz) não têm method: ignoradas.
      if (!isNotification && ('result' in req || 'error' in req)) return null
      return isNotification ? null : fail(id, RpcError.InvalidRequest, 'mensagem JSON-RPC inválida')
    }
    const params = (req.params ?? {}) as Record<string, unknown>
    if (isNotification) {
      if (req.method === 'notifications/cancelled') inflight.get(String(params['requestId']))?.abort()
      return null
    }
    // Era moderna: a versão vem no _meta de cada pedido, e o servidor recusa a que não fala.
    const version = requestedVersion(params)
    if (version !== undefined && !isModernVersion(version)) {
      return fail(id, ProtocolError.UnsupportedProtocolVersion, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: version })
    }
    const modern = version !== undefined
    const key = String(id)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) controller.abort()
    inflight.set(key, controller)
    try {
      const reply = await dispatch(req.method, params, id, controller.signal)
      return modern && reply.result !== undefined ? ok(id, modernResult(req.method, reply.result)) : reply
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (inflight.get(key) === controller) inflight.delete(key)
    }
  }

  /** Resultado da era moderna: resultType, o servidor no _meta e, nas listas e leituras, a validade do cache. */
  function modernResult(method: string, result: unknown): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result
    const r = result as Record<string, unknown>
    const cacheable = ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read'].includes(method)
    return {
      ...r,
      resultType: r['resultType'] ?? 'complete',
      ...(cacheable && !('ttlMs' in r) && { ttlMs: method === 'resources/read' ? 0 : 300_000, cacheScope: 'private' }),
      _meta: { ...(r['_meta'] as object | undefined), [META.serverInfo]: SERVER_INFO }
    }
  }

  /** Os resultados de skills levam a validade do cache em qualquer era: o schema da extensão exige. */
  const skillsResult = (result: Record<string, unknown>) => ({ resultType: 'complete', ...result, ttlMs: skills.ttlMs, cacheScope: 'public' })

  async function dispatch(method: string, params: Record<string, unknown>, id: JsonRpcResponse['id'], signal: AbortSignal): Promise<JsonRpcResponse> {
    switch (method) {
      case 'initialize': {
        const asked = String(params['protocolVersion'] ?? '')
        const protocolVersion = (LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : LEGACY_VERSIONS[0]
        const repo = await missingRule()
        return ok(id, {
          protocolVersion,
          capabilities,
          serverInfo: SERVER_INFO,
          instructions: serverInstructions(repo ?? undefined)
        })
      }
      case 'server/discover': {
        const repo = await missingRule()
        return ok(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities,
          instructions: serverInstructions(repo ?? undefined),
          ttlMs: 60_000,
          cacheScope: 'private'
        })
      }
      case 'ping':
        return ok(id, {})
      case 'skills/list':
        return ok(id, skillsResult({ skills: await skills.list() }))
      case 'skills/get': {
        const skill = await skills.get(String(params['uri'] ?? ''))
        if (!skill) return fail(id, RpcError.InvalidParams, `nenhuma skill em ${String(params['uri'])}`)
        return ok(id, skillsResult({ skill }))
      }
      case 'resources/directory/read': {
        const children = await skills.directory(String(params['uri'] ?? ''))
        if (!children) return fail(id, RpcError.InvalidParams, `${String(params['uri'])} não é um diretório`)
        return ok(id, skillsResult({ resources: children }))
      }
      case 'tools/list':
        return ok(id, {
          tools: tools.map((t) => ({
            ...(options.enxuto && t.name !== 'describe_tool'
              ? leanTool(t)
              : { name: t.name, title: t.title, description: fullDescription(t), inputSchema: withProject(t.inputSchema) }),
            // No enxuto, das anotações só o que o cliente usa para pedir confirmação (leitura ou destrutiva).
            ...(t.annotations &&
              (options.enxuto
                ? { annotations: { readOnlyHint: t.annotations['readOnlyHint'] === true, ...(t.annotations['destructiveHint'] === true && { destructiveHint: true }) } }
                : { annotations: { title: t.title, ...t.annotations } }))
          }))
        })
      case 'tools/call': {
        const result = await callTool(params, signal)
        return result ? ok(id, result) : fail(id, RpcError.InvalidParams, `ferramenta desconhecida: ${String(params['name'])}`)
      }
      case 'resources/list':
        return ok(id, {
          resources: DOC_RESOURCES.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType }))
        })
      case 'resources/templates/list':
        return ok(id, { resourceTemplates: [] })
      case 'resources/read': {
        const skillFile = await skills.read(String(params['uri'] ?? ''))
        if (skillFile) return ok(id, { contents: [skillFile], ttlMs: skills.ttlMs, cacheScope: 'public' })
        const resource = DOC_RESOURCES.find((r) => r.uri === params['uri'])
        if (!resource) return fail(id, RpcError.InvalidParams, `resource desconhecido: ${String(params['uri'])}`)
        try {
          const text = sanitizer.text(await resource.read(options.workspaceDir))
          return ok(id, { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }] })
        } catch (err) {
          log(`erro em ${resource.uri}: ${sanitizer.text((err as Error).stack ?? String(err))}`)
          return fail(id, RpcError.Internal, (err as Error).message)
        }
      }
      case 'prompts/list':
        return ok(id, {
          prompts: DOC_PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args }))
        })
      case 'prompts/get': {
        const prompt = DOC_PROMPTS.find((p) => p.name === params['name'])
        if (!prompt) return fail(id, RpcError.InvalidParams, `prompt desconhecido: ${String(params['name'])}`)
        try {
          const text = sanitizer.text(prompt.build(promptArguments(prompt, params['arguments'])))
          return ok(id, { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] })
        } catch (err) {
          if (err instanceof PromptError) return fail(id, RpcError.InvalidParams, err.message)
          throw err
        }
      }
      default:
        return fail(id, RpcError.MethodNotFound, `método não suportado: ${method}`)
    }
  }

  return {
    sanitizer,
    pii,
    async handle(message, signal) {
      if (Array.isArray(message)) {
        if (!message.length) return fail(null, RpcError.InvalidRequest, 'lote vazio')
        const out = (await Promise.all(message.map((m) => handleOne(m, signal)))).filter((r): r is JsonRpcResponse => r !== null)
        return out.length ? out : null
      }
      return handleOne(message, signal)
    }
  }
}

/** Texto recebido de um transporte: JSON inválido vira o erro -32700 do JSON-RPC. */
export async function handleText(server: McpServer, text: string, signal?: AbortSignal) {
  let message: unknown
  try {
    message = JSON.parse(text)
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: RpcError.Parse, message: 'JSON inválido' } } satisfies JsonRpcResponse
  }
  return server.handle(message, signal)
}
