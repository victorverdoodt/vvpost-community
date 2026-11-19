import type { Connector, Flow, PluginField, RequestPayload, RequestScripts, ResponseExample } from '@vvpost/schemas'

export type { RequestPayload, RequestScripts } from '@vvpost/schemas'

/**
 * Tipos do motor (requisições, auth, cenários, fluxos, catálogo, plugins), usados pelo
 * core e por todos os clientes dele. O app os reexporta em src/shared/ipc.ts, onde
 * viajam pelo IPC até o renderer.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

/** Cabeçalho como par ordenado: a mesma chave pode aparecer mais de uma vez. */
export interface HttpHeader {
  name: string
  value: string
}

export interface HttpRequestInput {
  /** Gerado pelo renderer; permite cancelar com `cancelRequest(id)`. */
  id: string
  method: HttpMethod
  url: string
  headers: HttpHeader[]
  /** Corpo em texto. Ignorado em GET e HEAD. */
  body?: string
  /**
   * Corpo estruturado (form urlencoded, multipart com arquivos, binário), no lugar de `body`.
   * Caminhos de arquivo absolutos no dispatcher; relativos ao workspace na auth headless.
   */
  payload?: RequestPayload
  /** Padrão: 30 s. */
  timeoutMs?: number
  /** Padrão: true (até 5 redirecionamentos). */
  followRedirects?: boolean
  /**
   * Conector do workspace: a URL pode ser relativa à baseUrl dele, e
   * headers, auth e mTLS herdados são aplicados no main process.
   */
  connectorId?: string
  /** Ambiente cujas variáveis resolvem os {{VAR}} da requisição e do conector. */
  environmentId?: string
  /**
   * Fluxo de preparação: roda em segundo plano antes da requisição, sem abrir o
   * canvas, e a requisição lê a saída dos nós dele com {{ $nodes.Nome.data.campo }}.
   */
  prepareFlowId?: string
  /**
   * A preparação dada inline, no lugar de prepareFlowId: os nós anteriores do fluxo que a aba é
   * (a visão Simples de um fluxo que termina nesta requisição).
   */
  prepareFlow?: Flow
  /** Endpoint do conector de onde a requisição veio: os scripts dele também rodam. */
  endpointId?: string
  /** Scripts pre e post desta requisição, além dos herdados do conector e do endpoint (fase 13). */
  scripts?: RequestScripts
}

/** Chamada pelo adapter de um plugin no Quick Request, no lugar de uma requisição HTTP. */
export interface PluginRequestInput {
  /** Gerado pelo renderer; permite cancelar com `cancelRequest(id)`. */
  id: string
  /** Protocolo do adapter, ex.: grpc, kafka. */
  adapter: string
  /** Valores dos campos do adapter (manifesto do plugin). */
  config?: Record<string, unknown>
  /** Conector cuja herança (baseUrl, headers, auth, mTLS) vale para o adapter. */
  connectorId?: string
  environmentId?: string
  timeoutMs?: number
}

export interface HttpTimings {
  /** Do disparo até os cabeçalhos da resposta chegarem (time to first byte). */
  ttfbMs: number
  /** Leitura do corpo. */
  downloadMs: number
  totalMs: number
}

export interface HttpResponseData {
  status: number
  statusText: string
  headers: HttpHeader[]
  /** Corpo decodificado como UTF-8, cortado em `bodyLimitBytes`. */
  body: string
  /**
   * Os mesmos bytes em base64, só quando o corpo é binário (imagem, PDF, áudio, arquivo), para o
   * ResponseViewer mostrar a prévia, o hex e salvar o arquivo sem perder bytes.
   */
  bodyBase64?: string
  /** Tamanho real do corpo recebido, em bytes. */
  sizeBytes: number
  truncated: boolean
  timings: HttpTimings
}

export type HttpErrorCode =
  | 'INVALID_URL'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'CONNECTION_REFUSED'
  | 'DNS_FAILURE'
  | 'TLS_FAILURE'
  | 'INVALID_REQUEST'
  | 'NETWORK_ERROR'
  /** O fluxo de auth do conector falhou (credencial recusada, token ausente...). */
  | 'AUTH_FAILED'
  /** Conector, ambiente ou variável do workspace com problema. */
  | 'CONFIG_ERROR'
  /** A política de quem dispara (IA pelo MCP, plugin) recusou: método, origem, ambiente ou limite. */
  | 'POLICY_DENIED'
  /** O fluxo de preparação da requisição falhou: a requisição não foi enviada. */
  | 'PREPARE_FAILED'
  /** O protocolo de plugin (adapter) não está instalado, ligado ou carregado. */
  | 'PLUGIN_UNAVAILABLE'
  /** O código do plugin lançou um erro (ou devolveu algo que não é JSON). */
  | 'PLUGIN_ERROR'
  /** O processo do plugin caiu (exceção sem tratamento, memória) ou foi encerrado por outra chamada travada. */
  | 'PLUGIN_CRASHED'
  /** Um script pre-request falhou (erro no código, plugin JavaScript desligado): a requisição não foi enviada. */
  | 'SCRIPT_ERROR'

export interface HttpError {
  code: HttpErrorCode
  message: string
}

/** Como a auth do conector foi resolvida para esta requisição. */
export interface AuthUsage {
  type: 'bearer' | 'apiKey' | 'basic' | 'oauth2' | 'login' | 'digest' | 'ntlm' | 'awsSigV4' | 'oauth1'
  /** Conector da cadeia que define a auth. */
  from: string
  /** static: credencial fixa; cache: token em memória; fetched/refreshed: fluxo rodou agora. */
  source: 'static' | 'cache' | 'fetched' | 'refreshed'
  /** Tempo gasto obtendo a credencial. */
  ms: number
  /** Epoch em ms em que o token expira, quando o servidor informa. */
  expiresAt?: number
  /** O token em cache foi recusado (401) e a requisição foi repetida com um novo. */
  retried?: boolean
}

/** Erros de rede voltam como valor, não como exceção: o IPC perde o tipo de exceções. */
/** O que foi para a rede (URL final, headers herdados e da auth), com as credenciais mascaradas. */
export interface SentRequest {
  method: HttpMethod
  url: string
  headers: HttpHeader[]
}

/** Como o fluxo de preparação rodou antes da requisição (o tempo dele não entra nos timings da resposta). */
export interface PrepareUsage {
  flowId: string
  flowName: string
  outcome: 'success' | 'failed' | 'canceled'
  durationMs: number
  /** Nós que rodaram com sucesso: o que a requisição pode ler em $nodes. */
  nodes: string[]
  /** Primeiro nó que falhou, com o erro. */
  failed?: { nodeId: string; name: string; code: string; message: string }
}

/** Requisição feita pelo adapter de um plugin (gRPC, Kafka...), no lugar do HTTP. */
export interface PluginUsage {
  adapter: string
  /** console.* e ctx.log do plugin. */
  logs?: string
}

export type HttpResult =
  | { ok: true; response: HttpResponseData; auth?: AuthUsage; sent?: SentRequest; prepare?: PrepareUsage; plugin?: PluginUsage; scripts?: ScriptUsage }
  | { ok: false; error: HttpError; timings: Pick<HttpTimings, 'totalMs'>; auth?: AuthUsage; sent?: SentRequest; prepare?: PrepareUsage; plugin?: PluginUsage; scripts?: ScriptUsage }

/** Um teste declarado por vv.test num script da requisição. */
export interface ScriptTestResult {
  name: string
  passed: boolean
  message: string
  /** De onde veio o script: o id do conector, "endpoint" ou "request" (o do Quick Request). */
  from: string
}

/** O que os scripts da requisição fizeram (fase 13), ao lado da resposta. */
export interface ScriptUsage {
  /** Os scripts que rodaram, na ordem, como "pre:<origem>" e "post:<origem>". */
  ran: string[]
  tests: ScriptTestResult[]
  /** console.* dos scripts, com o nó de cada linha. */
  logs?: string
  /** Variáveis definidas pelos scripts (valem para as próximas requisições do mesmo ambiente). */
  variables: Record<string, string>
  /** Um script post que falhou; a resposta continua valendo. */
  error?: { script: string; message: string }
  durationMs: number
}

/** Conector com a herança aplicada, como o Quick Request mostra. Nunca traz valores de segredo. */
export interface CatalogConnector {
  id: string
  name: string
  /** Origem do conector compartilhado (catálogo corporativo), somente leitura; ausente nos do workspace. */
  shared?: string
  /** Ids da raiz até o conector. */
  chain: string[]
  /** Arquivo que define o conector, relativo ao workspace. */
  file?: string
  /** Definido num fluxo-base (docs/flows.md, Herança), não num .connector.vvpost.json. */
  asFlow?: true
  /** Modelo da URL base com basePath, ainda com {{VAR}}. */
  baseUrl?: string
  /** Headers herdados, como escritos nos arquivos (com {{VAR}}, sem valores). */
  headers: HttpHeader[]
  auth?: { type: AuthUsage['type']; from: string; summary: string }
  /** Conector que define o certificado mTLS herdado. */
  tlsFrom?: string
  /** Scripts pre e post da cadeia (fase 13), da raiz ao conector: rodam em toda requisição dele. */
  scripts?: { from: string; pre?: string; post?: string }[]
  endpoints: {
    id: string
    name: string
    /** Fluxo de requisição que define o endpoint (herda do conector); ausente nos do .connector.vvpost.json. */
    flowFile?: string
    method: HttpMethod
    path: string
    /** true: exige credencial; false: público; ausente: não declarado (requiresAuth do arquivo). */
    requiresAuth?: boolean
    headers: HttpHeader[]
    body?: string
    /** JSON Schema do corpo (o do OpenAPI importado): o Quick Request e o Flow Studio montam o formulário dele. */
    bodySchema?: Record<string, unknown>
    /** Corpo estruturado (form, multipart, binário), como no arquivo (caminhos relativos ao workspace). */
    payload?: RequestPayload
    /** Endpoint chamado pelo adapter de um plugin (gRPC, Kafka...): config como escrita no arquivo. */
    plugin?: { adapter: string; config?: Record<string, unknown>; timeoutMs?: number }
    /** Scripts pre e post do endpoint, depois dos do conector. */
    scripts?: RequestScripts
    scenarios: CatalogScenario[]
    /** Exemplos de resposta, como no arquivo: o que o mock server devolve. */
    examples?: ResponseExample[]
  }[]
  /** Herança quebrada (pai ausente, ciclo): o conector não pode ser usado. */
  error?: string
}

/** Conectores e ambientes do workspace aberto, para o Quick Request. */
export interface ConnectorCatalog {
  dir: string
  connectors: CatalogConnector[]
  /** `protected`: ambiente protegido (policy/protected.ts), em que o app pede confirmação antes de disparar. */
  environments: { id: string; name: string; missingSecrets: string[]; protected: boolean }[]
  /** Arquivos ignorados por JSON ou schema inválido. */
  issues: { file: string; message: string }[]
  /** Arquivos de fluxo que viraram conectores e endpoints: o explorador mostra pela herança, não na lista de fluxos. */
  flowFiles?: string[]
  /** Conectores do projeto ainda no formato antigo (.connector.vvpost.json), que "Converter para fluxos" troca. */
  legacy?: number
}

export type AssertionOperator =
  | 'equals'
  | 'notEquals'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'contains'
  | 'matches'
  | 'exists'
  | 'notExists'
  | 'matchesSchema'
  | 'matchesExample'

/** Asserção declarativa de um cenário. */
export interface ScenarioAssertion {
  /** status, responseTimeMs, body, body.<caminho> ou headers.<nome>. */
  target: string
  operator: AssertionOperator
  expected?: unknown
}

/** Cenário table-driven de um endpoint, como escrito no arquivo do conector (com {{VAR}}). */
export interface CatalogScenario {
  id: string
  name: string
  description?: string
  overrides?: {
    body?: unknown
    payload?: RequestPayload | null
    headers?: Record<string, string | null> | null
    query?: Record<string, string | null>
    pathParams?: Record<string, string>
    /** pathParams que vão como estão, sem codificar (valor já codificado, como %E0). */
    rawPathParams?: string[]
  }
  assertions: ScenarioAssertion[]
}

/** Disparo em lote dos cenários de um conector: cada cenário roda uma vez por ambiente. */
export interface ScenarioRunInput {
  /** Gerado pelo renderer; permite cancelar com `cancelScenarios(runId)`. */
  runId: string
  connectorId: string
  /** Só estes endpoints (padrão: todos os do conector). */
  endpointIds?: string[]
  /** Só estes cenários, como "<endpoint>/<cenário>" (padrão: todos). */
  scenarioKeys?: string[]
  /** Ambientes da matriz; "" roda sem ambiente. Padrão: [""]. */
  environmentIds?: string[]
  /**
   * Execução orientada a dados: cada linha é uma iteração do lote inteiro (em cada ambiente),
   * com as colunas em {{coluna}} e {{$data.coluna}}, por cima das variáveis do ambiente.
   */
  data?: { name?: string; rows: Record<string, string>[] }
  /**
   * O gate de acesso dos endpoints com requiresAuth (cenário $sem-credencial, scenarios/access.ts).
   * Padrão: entra; false tira. Com scenarioKeys, entra só se pedido pelo nome.
   */
  accessCheck?: boolean
}

export interface AssertionResult extends ScenarioAssertion {
  passed: boolean
  /**
   * Valor encontrado na resposta, com o tipo dela (número, booleano, texto, objeto). Texto
   * longo é cortado em ~200 caracteres, e objeto ou lista maior que isso vira o resumo em JSON.
   */
  actual?: unknown
  message: string
}

export interface ScenarioResult {
  endpointId: string
  scenarioId: string
  /** "" quando rodou sem ambiente. */
  environmentId: string
  /** Linha do arquivo de dados (a partir de 1); ausente sem `data`. */
  iteration?: number
  /** Id da requisição no dispatcher (`<runId>:<n>`); ausente quando nem chegou a ser montada. */
  requestId?: string
  /** passed: todas as asserções passaram; failed: alguma falhou; error: a requisição não chegou a ter resposta. */
  outcome: 'passed' | 'failed' | 'error'
  /** Método e URL como montados a partir do endpoint e dos overrides (ainda com {{VAR}}). */
  request: { method: HttpMethod; url: string }
  status?: number
  /** Tempo de rede da resposta (o mesmo do alvo responseTimeMs), ou até o erro. */
  durationMs: number
  /** DEPENDENCY_FAILED: um cenário de dependsOn não passou, e este nem foi enviado. */
  error?: { code: HttpErrorCode | 'DEPENDENCY_FAILED'; message: string }
  auth?: AuthUsage
  /** Só as asserções que valem no ambiente (as de outros ambientes ficam de fora). */
  assertions: AssertionResult[]
  /** Valores de capture tirados da resposta, para os cenários que dependem deste. */
  captures?: Record<string, string>
  /** Começo do corpo da resposta, para o detalhe da célula. */
  bodyPreview?: string
  responseHeaders?: HttpHeader[]
}

export interface ScenarioRunReport {
  runId: string
  connectorId: string
  /** Epoch em ms. */
  startedAt: number
  durationMs: number
  results: ScenarioResult[]
  totals: { passed: number; failed: number; error: number }
  /** O lote foi cancelado: cenários que não chegaram a rodar ficam de fora. */
  canceled: boolean
  /** Workspace ou conector com problema: nada rodou. */
  error?: string
  /** Com arquivo de dados: quantas iterações o lote teve e de que arquivo. */
  data?: { name?: string; iterations: number }
}

/** Fluxos do workspace aberto. */
export interface FlowCatalog {
  dir: string
  /** file: caminho relativo ao workspace, com "/". */
  flows: { file: string; flow: Flow; version?: string | null }[]
  /** Arquivos ignorados por JSON ou schema inválido. */
  issues: { file: string; message: string }[]
}

export interface FlowRunInput {
  /** Gerado pelo renderer; identifica os eventos e permite cancelar com `cancelFlow(runId)`. */
  runId: string
  /** O fluxo como está no canvas (pode ter edições ainda não salvas). */
  flow: Flow
  /** Ambiente que resolve os {{VAR}}; "" ou ausente roda sem ambiente. */
  environmentId?: string
}

export type FlowNodeStatus = 'running' | 'success' | 'error' | 'skipped'

export type FlowErrorCode =
  | HttpErrorCode
  /** A resposta veio com status 4xx/5xx (e o nó não tem ignoreHttpErrors). */
  | 'HTTP_STATUS'
  /** Uma referência {{ $nodes... }} não pôde ser resolvida. */
  | 'EXPRESSION_ERROR'
  | 'PYTHON_NOT_FOUND'
  | 'PYTHON_ERROR'
  /** Uma condição com failWhenFalse não valeu. */
  | 'ASSERTION_FAILED'
  /** O polling da requisição esgotou o tempo ou as tentativas sem a condição valer. */
  | 'POLL_TIMEOUT'
  /** Nenhum evento aceito pelo nó webhook chegou no tempo limite. */
  | 'WEBHOOK_TIMEOUT'
  /** O nó webhook roda onde não há servidor de webhooks (ou ele não pôde ligar). */
  | 'WEBHOOK_UNAVAILABLE'

/** Resultado de um nó; `output` é exatamente o que entrou em $nodes.<nome>. */
export interface FlowNodeResult {
  nodeId: string
  name: string
  status: Exclude<FlowNodeStatus, 'running'>
  durationMs: number
  output?: { data: unknown; status?: number; headers?: Record<string, string>; durationMs?: number }
  /**
   * `property`: o campo do nó que causou o erro, como no arquivo do fluxo (`request.url`,
   * `request.headers.Authorization`, `python.code`), quando dá para saber.
   */
  error?: { code: FlowErrorCode; message: string; property?: string }
  /** Requisição como montada, com a baseUrl do conector (ainda com {{VAR}}: valores do ambiente não voltam ao renderer). */
  request?: { method: HttpMethod; url: string }
  /** Tentativas feitas por uma requisição com polling. */
  attempts?: number
  auth?: AuthUsage
  /** print() e stderr do nó Python; console.* e ctx.log de um nó de plugin. */
  logs?: string
  /** Versão do Python que rodou o nó Python (ex.: "3.12.3"). */
  python?: string
  /** Por que o nó foi pulado (ramo não escolhido, nó anterior com erro). */
  reason?: string
  /** Testes dos scripts do endpoint e do conector que rodaram em volta do nó de requisição. */
  tests?: ScriptTestResult[]
}

export type FlowRunEvent =
  | { runId: string; type: 'node'; nodeId: string; status: 'running' }
  | { runId: string; type: 'node'; nodeId: string; status: FlowNodeResult['status']; result: FlowNodeResult }

export interface FlowRunReport {
  runId: string
  flowId: string
  startedAt: number
  durationMs: number
  /** Na ordem em que os nós terminaram. */
  results: FlowNodeResult[]
  outcome: 'success' | 'failed' | 'canceled'
  /** Fluxo inválido ou workspace com problema: nada rodou. */
  error?: string
}

/** Problema de validação: JSON Pointer do campo ("" é a raiz) e a mensagem. */
export interface SchemaIssue {
  path: string
  message: string
}

/** Campo do bodySchema achatado para a tabela da documentação (ex.: items[].sku). */
export interface SchemaField {
  path: string
  type: string
  required: boolean
  description?: string
  /** Valores aceitos (enum ou const), como JSON. */
  values?: string[]
}

/** Um corpo guardado no conector (o padrão do endpoint ou o de um cenário) conferido com o bodySchema. */
export interface BodyCheck {
  /** "body" para o corpo padrão, ou o id do cenário. */
  source: string
  label: string
  issues: SchemaIssue[]
}

export interface RegistryEndpoint {
  id: string
  name: string
  /** Markdown. */
  description?: string
  method: HttpMethod
  path: string
  /** baseUrl + basePath herdados + path, ainda com {{VAR}}. Ausente sem baseUrl na cadeia. */
  url?: string
  /** true: exige credencial; false: público (requiresAuth do arquivo). */
  requiresAuth?: boolean
  headers: HttpHeader[]
  query: HttpHeader[]
  bodySchema?: Record<string, unknown>
  /** O corpo é um schema compartilhado ({"$ref": "schema:<nome>"}): o bodySchema vem resolvido. */
  sharedSchema?: { name: string; file: string }
  fields: SchemaField[]
  /** Corpo padrão formatado. */
  body?: string
  /** Seção do arquivo de documentação marcada com {#id do endpoint}. */
  docs?: string
  /** Só com bodySchema: o corpo padrão e o de cada cenário com overrides.body. */
  checks: BodyCheck[]
  /** Só os exemplos de resposta com schema: o corpo de cada um conferido com o schema dele. */
  exampleChecks?: ExampleCheck[]
  scenarios: { id: string; name: string }[]
}

/** Uma resposta de exemplo conferida com o próprio schema; fora dele, o vvpost validate reprova. */
export interface ExampleCheck {
  id: string
  name: string
  status: number
  issues: SchemaIssue[]
}

/** Conector como o Connector Registry mostra: a camada do próprio arquivo e o resultado da herança. */
export interface RegistryConnector {
  id: string
  name: string
  version: string
  /** Markdown. */
  description?: string
  /** Arquivo do conector, relativo ao workspace. */
  file: string
  extends?: string
  /** Filhos diretos (que fazem extends deste), por nome. */
  children: string[]
  /** Ids da raiz até o conector (só o próprio quando a herança está quebrada). */
  chain: string[]
  /** O que o próprio arquivo define em config. */
  own: {
    baseUrl?: string
    basePath?: string
    headers: HttpHeader[]
    auth?: { type: string; summary: string }
    tls: boolean
  }
  /** Config efetiva depois da herança; ausente quando a herança está quebrada. */
  resolved?: {
    baseUrl?: { value: string; from: string }
    basePath: string
    /** Cada header com o conector que o define e os ancestrais cujo valor ele substitui. */
    headers: (HttpHeader & { from: string; overrides: string[] })[]
    auth?: { type: string; summary: string; from: string }
    /** Conector mais próximo com auth { "type": "none" }, que desliga a auth herdada. */
    authDisabledBy?: string
    tlsFrom?: string
  }
  endpoints: RegistryEndpoint[]
  /** Arquivo de documentação ao lado do conector (*.connector.vvpost.md) e a parte que não é de endpoint. */
  docs?: { file: string; overview: string }
  /** Diagramas Mermaid gerados a partir do conector. */
  diagrams: { hierarchy: string; auth?: string }
  /** Herança quebrada (pai ausente, ciclo). */
  error?: string
  /** Spec OpenAPI de onde o conector (ou o ancestral `from`) foi importado: dá para reimportar. */
  source?: { location: string; version?: string; from: string }
}

/** Catálogo de conectores do workspace aberto. */
export interface ConnectorRegistry {
  dir: string
  /** Ordenados por nome. */
  connectors: RegistryConnector[]
  /** Arquivos ignorados e seções de documentação sem endpoint. */
  issues: { file: string; message: string }[]
}

export type BodyValidation =
  | { ok: true }
  | { ok: false; issues: SchemaIssue[] }
  /** Sem bodySchema no endpoint, ou o texto não é JSON. */
  | { ok: false; message: string }

/** Tipo de nó (kind node) ou adapter de protocolo (kind adapter) que um plugin contribui. */
export interface PluginContribution {
  kind: 'node' | 'adapter'
  /** Tipo do nó (ex.: javascript.script) ou protocolo do adapter (ex.: graphql). */
  name: string
  title: string
  description?: string
  fields: PluginField[]
}

/** O que o processo de um plugin pode fazer, além de ler a própria pasta (docs/plugins.md). */
export interface PluginPermissionsInfo {
  /** permissions.network do manifesto; vazio: sem rede própria (só ctx.http, pelo host). */
  network: string[]
  /** O adapter recebe a conexão resolvida do conector (credenciais incluídas). */
  connectorCredentials: boolean
  /** As regras em texto, para a interface. */
  summary: string[]
}

/** Plugin como o Extensions Hub mostra. */
export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  /** official: vem com o app (só pode ser desligado); user: instalado de uma pasta. */
  source: 'official' | 'user'
  /** Pasta do plugin. */
  dir: string
  enabled: boolean
  /** Processo do plugin: sobe no primeiro uso e para depois de um tempo sem uso. */
  state: 'stopped' | 'starting' | 'running'
  /** Impede o uso (ex.: conflito de tipo de nó com outro plugin ligado). */
  error?: string
  /** Última falha do processo (não carregou, caiu, memória): o próximo uso tenta de novo. */
  lastError?: string
  contributions: PluginContribution[]
  /** Extensões do editor de diagramas (contributes.diagrams): pacotes de ícones e blocos da paleta. */
  diagrams?: { iconPacks: { prefix: string; title: string }[]; blocks: number }
  /** Exportadores da documentação (contributes.exporters): o provider de um destino do vvpost.publish.json. */
  exporters?: { id: string; title: string; description?: string }[]
  /** Publicadores remotos da documentação (contributes.publishers), com os hosts a que publicam. */
  publishers?: { id: string; title: string; description?: string; hosts: string[] }[]
  permissions: PluginPermissionsInfo
  /** Só nos instalados: a assinatura conferida na instalação, contra as chaves confiáveis de agora. */
  signature?: PluginSignatureInfo
  /** Só nos instalados: de onde veio. */
  origin?: PluginOrigin
}

/**
 * Assinatura de um plugin (docs/plugins.md, "Assinatura"): unsigned (sem
 * vvpost-plugin.sig.json), invalid (não confere: impede a instalação), trusted (válida, de uma
 * chave confiável ou fixada pelo registro) ou untrusted (válida, de uma chave desconhecida).
 */
export interface PluginSignatureInfo {
  status: 'unsigned' | 'invalid' | 'trusted' | 'untrusted'
  publicKey?: string
  /** SHA-256 da chave, 16 bytes em grupos de 4 hex. */
  fingerprint?: string
  /** Nome da chave confiável, ou "registro <nome>" quando o registro fixa a chave. */
  signer?: string
  /** Por que não confere (status invalid). */
  reason?: string
}

export interface PluginOrigin {
  kind: 'folder' | 'archive' | 'registry'
  /** Pasta, arquivo ou URL do pacote. */
  location: string
  /** URL do índice, quando veio de um registro. */
  registry?: string
}

/** Chave pública em que o usuário confia para assinaturas de plugins. */
export interface TrustedPluginKey {
  publicKey: string
  fingerprint: string
  name: string
  addedAt: string
}

/** Um registro de plugins com o que ele oferece (ou o erro ao lê-lo). */
export interface PluginRegistryListing {
  url: string
  name: string
  error?: string
  plugins: {
    id: string
    name: string
    description?: string
    author?: string
    homepage?: string
    latest: string
    versions: string[]
    /** A versão mais nova exige a assinatura de uma chave fixada pelo registro. */
    signed: boolean
    /** Versão instalada, se houver (de qualquer origem). */
    installed?: string
    /** official: o id é de um plugin oficial e não pode ser instalado. */
    official?: boolean
  }[]
}

export interface PluginCatalog {
  plugins: PluginInfo[]
  /** Pastas ignoradas: sem manifesto, manifesto inválido, id repetido. */
  issues: { dir: string; message: string }[]
  /** Onde ficam os plugins instalados pelo usuário. */
  userDir: string
  /** kernelNetwork: plugins sem rede declarada rodam num namespace de rede vazio (Linux com user namespaces). */
  sandbox: { kernelNetwork: boolean }
  /** Chaves de assinatura em que o usuário confia. */
  trustedKeys: TrustedPluginKey[]
  /** URLs dos registros de plugins configurados. */
  registries: string[]
}

/** O que a instalação (de pasta, arquivo ou registro) vai copiar, mostrado antes de o usuário confirmar. */
export interface PluginInstallPreview {
  /** Identifica a prévia na chamada de `installPlugin`. */
  id: string
  sourceDir: string
  origin: PluginOrigin
  signature: PluginSignatureInfo
  plugin?: Omit<PluginInfo, 'source' | 'dir' | 'enabled' | 'state' | 'error' | 'lastError'>
  /** Versão já instalada que será substituída. */
  replaces?: string
  /** Contribuições que já vêm de outro plugin ligado. */
  conflicts?: string[]
  /** Impedem a instalação (manifesto inválido, id de um plugin oficial...). */
  problems: string[]
  canInstall: boolean
  files: number
  sizeBytes: number
}

/** Conector do workspace como escrito no arquivo, para o editor. */
export interface ConnectorSource {
  /** Caminho relativo ao workspace, com "/". */
  file: string
  connector: Connector
  /** Versão do que foi lido (o arquivo, ou a base e os fluxos dela), para salvar sem passar por cima de outra gravação. */
  version?: string | null
}

/**
 * Evento recebido pelo servidor local de webhooks (docs/webhooks.md). Fica só em memória;
 * o corpo vem como o das respostas: texto UTF-8 e, se binário, os bytes em base64.
 */
export interface WebhookEvent {
  /** Sequencial no servidor, crescente: também é o cursor dos nós que esperam eventos. */
  id: number
  /** ISO 8601. */
  receivedAt: string
  method: string
  /** Caminho sem a query. */
  path: string
  /** Caminho com a query, como chegou. */
  url: string
  query: Record<string, string | string[]>
  headers: HttpHeader[]
  body: string
  bodyBase64?: string
  sizeBytes: number
  truncated: boolean
  /** Endereço de quem mandou (loopback, ou o túnel). */
  remoteAddress?: string
  /** Hook de .vvpost/webhooks.json que atendeu; ausente quando nenhum casou. */
  hookId?: string
  /** Assinatura HMAC conferida pelo hook. */
  signature?: 'valid' | 'invalid' | 'missing' | 'unconfigured'
  /** Por que o evento foi recusado (assinatura, método, Origin, Host, tamanho): recusados não disparam nada nem servem a nós. */
  rejected?: string
  /** O que o servidor respondeu. */
  response: { status: number; durationMs: number }
  /** O disparo do hook (fluxo ou cenários), quando há. */
  trigger?: WebhookTriggerResult
}

export interface WebhookTriggerResult {
  kind: 'flow' | 'scenarios'
  /** Id do fluxo ou do conector. */
  target: string
  environmentId: string
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'skipped'
  message?: string
  durationMs?: number
  /** Execução no histórico do app, para abrir dali. */
  historyRunId?: number
}

/** Onde os nós webhook de um fluxo esperam os eventos (o servidor local, no app e no CLI). */
export interface WebhookSource {
  /** Id que o próximo evento vai ter: o que chegar daqui em diante. */
  cursor(): number
  /**
   * O primeiro evento não recusado com id >= `since`, fora de `skip`, em que `accept` vale;
   * espera até `timeoutMs`. null no tempo limite.
   */
  wait(
    accept: (event: WebhookEvent) => boolean,
    options: { since: number; timeoutMs: number; skip?: ReadonlySet<number>; signal?: AbortSignal }
  ): Promise<WebhookEvent | null>
}

/** Um ícone no formato do Iconify: o miolo do SVG e o tamanho, quando foge do padrão do pacote. */
export interface DiagramIcon {
  body: string
  width?: number
  height?: number
  left?: number
  top?: number
}

/** Pacote de ícones dos diagramas (Iconify JSON), usado como prefixo:nome no Mermaid. */
export interface DiagramIconPack {
  prefix: string
  title: string
  pluginId: string
  pluginName: string
  icons: { prefix: string; icons: Record<string, DiagramIcon>; aliases?: Record<string, { parent: string }>; width?: number; height?: number }
}

/** Bloco pronto da paleta do editor de diagramas. */
export interface DiagramBlock {
  title: string
  category: string
  code: string
  description?: string
  icon?: string
  pluginId?: string
  pluginName?: string
}

/** O que os plugins ligados trazem para o editor de diagramas. */
export interface DiagramCatalog {
  iconPacks: DiagramIconPack[]
  blocks: DiagramBlock[]
  /** Pacotes que não carregaram (arquivo ausente, grande demais, JSON fora do formato). */
  issues: { pluginId: string; message: string }[]
}
