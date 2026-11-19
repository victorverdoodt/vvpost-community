/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

export type FlowNode =
  | FlowRequestNode
  | FlowConditionNode
  | FlowPythonNode
  | FlowPluginNode
  | FlowWaitNode
  | FlowWebhookNode
  | FlowOAuth2Node
/**
 * Identificador único do nó dentro do fluxo.
 */
export type FlowNodeId = string
/**
 * Nome do nó em $nodes.<nome>: único no fluxo, sem espaços, começando por letra ou _.
 */
export type FlowNodeName = string
export type FlowHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
/**
 * Nome do nó em $nodes.<nome>: único no fluxo, sem espaços, começando por letra ou _.
 */
export type FlowNodeName1 = string

/**
 * Fluxo do Flow Studio, gravado em *.flow.vvpost.json. Os nós formam um grafo acíclico: cada nó roda quando todos os anteriores terminam, nós independentes rodam em paralelo e a saída de cada um fica imutável em $nodes.<nome>, referenciada pelos seguintes com {{ $nodes.Nome.data.campo }}. Com `extends`, o fluxo herda de um fluxo-base: os nós da base rodam antes e os `defaults` da cadeia (URL base, basePath, headers, auth, mTLS, scripts) valem para as requisições dele. A base faz o papel de conector, e um fluxo que termina numa requisição e herda dela, o de endpoint (docs/flows.md, Herança entre fluxos).
 */
export interface Flow {
  /**
   * URL do schema, usada por editores para autocomplete.
   */
  $schema?: string
  /**
   * Identificador estável em notação de pontos, ex.: flow.checkout. Um fluxo de requisição criado de um endpoint usa <base>.<endpoint>, ex.: billing.v2.charge_customer; um fluxo-base usa o formato de id de conector (minúsculas, números e . _ -).
   */
  id: string
  name: string
  description?: string
  /**
   * Num fluxo-base: versão semântica da API que ele descreve (MAJOR.MINOR.PATCH), como o version de um conector.
   */
  version?: string
  /**
   * Id do fluxo-base de quem este fluxo herda. Os nós da base rodam antes (o filho lê a saída deles com {{ $nodes.Nome... }}) e os defaults da cadeia valem para as requisições deste fluxo. "<projeto>:<id>" herda de uma base de outro projeto do workspace.
   */
  extends?: string
  /**
   * Num fluxo de requisição: a posição do endpoint entre os do fluxo-base (o catálogo e as exportações seguem essa ordem). Sem order, o endpoint vem depois dos que têm, pelo nome do arquivo.
   */
  order?: number
  defaults?: FlowDefaults
  nodes: FlowNode[]
  edges?: FlowEdge[]
  /**
   * Só num fluxo de requisição: o endpoint exige credencial (true) ou é público (false), como o requiresAuth de um endpoint.
   */
  requiresAuth?: boolean
  /**
   * Só num fluxo de requisição (um nó de requisição que herda de uma base): casos de teste table-driven sobre esse nó, como os cenários de um endpoint.
   */
  scenarios?: import('./connector').Scenario[]
  /**
   * Só num fluxo de requisição: respostas de exemplo, para a documentação e o mock server.
   */
  examples?: import('./connector').ResponseExample[]
  /**
   * De onde o fluxo veio numa importação de spec: a spec, num fluxo-base, ou a operação, num fluxo de requisição. A reimportação usa isso.
   */
  source?: import('./connector').ConnectorSource | import('./connector').EndpointSource
}
/**
 * O que vale para todo nó de requisição deste fluxo e dos que herdam dele, como a config de um conector: baseUrl é substituída pelo mais específico, basePath acumula, headers se mesclam pelo nome, auth e tls são herdados inteiros e os scripts rodam todos, da base para o filho. Um header pode ler a saída de um nó da base com cache, ex.: Authorization: Bearer {{ $nodes.Login.data.token }}.
 */
export interface FlowDefaults {
  /**
   * URL base absoluta. Aceita variáveis {{VAR}}.
   */
  baseUrl?: string
  /**
   * Prefixo de caminho somado ao basePath herdado.
   */
  basePath?: string
  headers?: import('./connector').HttpHeaders
  /**
   * Auth que não é uma requisição à parte: digest, ntlm, awsSigV4 e oauth1 assinam ou negociam a própria requisição, e bearer, apiKey, basic e oauth2 como num conector. Um login próprio da API é um nó de requisição da base com cache, não um type login.
   */
  auth?: import('./connector').ConnectorAuth
  tls?: import('./connector').ConnectorTls
  scripts?: import('./connector').RequestScripts
}
export interface FlowRequestNode {
  id: FlowNodeId
  name: FlowNodeName
  type: 'request'
  position?: FlowPosition
  cache?: FlowCache
  request: FlowRequest
}
/**
 * Posição no canvas. Não afeta a execução.
 */
export interface FlowPosition {
  x: number
  y: number
}
/**
 * Só num nó de requisição de um fluxo-base (o login): a saída do nó fica em memória, nunca em disco nem no histórico, e serve às requisições dos fluxos que herdam até vencer. Um pedido por vez para o mesmo ambiente e as mesmas variáveis; um 401 numa requisição que usou a saída em cache a descarta e repete uma vez.
 */
export interface FlowCache {
  /**
   * Caminho na saída do nó com a validade em segundos, ex.: data.expires_in.
   */
  expiresIn?: string
  /**
   * Validade fixa, quando a resposta não informa.
   */
  ttlSeconds?: number
}
/**
 * Requisição pelo mesmo dispatcher e auth headless do Quick Request. Com connector + endpoint, o endpoint do conector é a base e os campos abaixo funcionam como os overrides de um cenário; sem endpoint, method e url descrevem a requisição (url relativa à baseUrl e ao basePath quando há connector, ou quando o fluxo herda de uma base). Textos aceitam {{VAR}} do ambiente e {{ $nodes.Nome... }}.
 */
export interface FlowRequest {
  /**
   * Id do conector cuja herança (baseUrl, headers, auth, mTLS) é aplicada.
   */
  connector?: string
  /**
   * Id de um endpoint do conector.
   */
  endpoint?: string
  method?: FlowHttpMethod
  url?: string
  /**
   * Padrão: true, e uma url relativa entra depois da baseUrl e do basePath herdados. false: só depois da baseUrl, ex.: um login fora do caminho da API.
   */
  basePath?: boolean
  /**
   * Mescla com os headers do endpoint e os herdados; um header null é removido.
   */
  headers?: {
    [k: string]: string | null
  }
  query?: {
    [k: string]: string | null
  }
  /**
   * Valores dos {nome} do path do endpoint.
   */
  pathParams?: {
    [k: string]: string
  }
  /**
   * Nomes de pathParams que vão como estão, sem codificar para URL (um valor já codificado chega ao servidor cru).
   */
  rawPathParams?: string[]
  /**
   * Corpo: texto, ou JSON. Num JSON, um texto que é só {{ $nodes... }} vira o valor referenciado (objeto, número...).
   */
  body?: unknown
  /**
   * JSON Schema do corpo, como o de um endpoint: valida o corpo, monta o formulário tipado e a documentação.
   */
  bodySchema?: Record<string, unknown>
  timeoutMs?: number
  /**
   * Padrão: false, e uma resposta 4xx/5xx é erro do nó. Com true ela segue para $nodes e uma condição decide o caminho.
   */
  ignoreHttpErrors?: boolean
  /**
   * Corpo estruturado (urlencoded, multipart com arquivos, binary), como o payload de um endpoint (connector.json).
   */
  payload?: import('./connector').RequestPayload
  /**
   * Padrão: true (até 5 redirecionamentos).
   */
  followRedirects?: boolean
  fromScript?: FlowNodeName1
  /**
   * Padrão: true, e os scripts do endpoint e do conector rodam em volta do nó (pre, requisição, post). false: só a requisição, como quando os scripts já são nós do fluxo.
   */
  scripts?: boolean
  /**
   * Scripts pre e post do próprio nó, como os de uma requisição do Quick Request: rodam depois dos do conector e do endpoint (pre e post), no mesmo fluxo script → requisição → script. Valem também com scripts: false.
   */
  requestScripts?: import('./connector').RequestScripts
  poll?: FlowPoll
}
/**
 * Polling: repete a requisição até a condição valer (ex.: um processamento assíncrono terminar). A condição lê a resposta da tentativa pelo nome do próprio nó, ex.: $nodes.Status.data.situacao. Respostas 4xx/5xx durante o polling não param o nó; a última vale para ignoreHttpErrors. Sem a condição valer até timeoutMs ou maxAttempts, o nó falha com POLL_TIMEOUT.
 */
export interface FlowPoll {
  until: FlowCondition
  /**
   * Espera entre uma tentativa e a próxima. Padrão: 1000.
   */
  intervalMs?: number
  /**
   * Tempo total do polling, somando tentativas e esperas. Padrão: 30000.
   */
  timeoutMs?: number
  /**
   * Tentativas no máximo. Padrão: as que cabem em timeoutMs com o intervalo.
   */
  maxAttempts?: number
}
export interface FlowCondition {
  /**
   * Caminho em $nodes, ex.: $nodes.Login.status ou $nodes.Login.data.items[0].id.
   */
  target: string
  operator:
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
  /**
   * Valor comparado. Um texto que é só {{ $nodes... }} compara com o valor referenciado.
   */
  expected?: unknown
}
/**
 * Avalia uma condição sobre $nodes. As arestas que saem com branch "true" seguem quando ela vale; as com "false", quando não vale. O ramo não escolhido é pulado. Com failWhenFalse, vira uma asserção que falha o fluxo.
 */
export interface FlowConditionNode {
  id: FlowNodeId
  name: FlowNodeName
  type: 'condition'
  position?: FlowPosition
  condition: FlowCondition
  /**
   * Asserção: com true, a condição que não vale é erro do nó (ASSERTION_FAILED) e o fluxo termina como falho, no app e no CLI. Os nós depois dela só rodam quando ela vale.
   */
  failWhenFalse?: boolean
}
/**
 * Script Python num subprocesso isolado (stdin/stdout). O script lê `nodes` (cópia de $nodes) e atribui o resultado a `output`, que vira $nodes.<nome>.data; print() vai para os logs do nó.
 */
export interface FlowPythonNode {
  id: FlowNodeId
  name: FlowNodeName
  type: 'python'
  position?: FlowPosition
  python: FlowPython
}
export interface FlowPython {
  code: string
  /**
   * Padrão: 10000. Passou do tempo, o processo é encerrado.
   */
  timeoutMs?: number
  /**
   * Versão mínima do Python 3 que o script precisa (ex.: "3.11"). Com um Python mais antigo, o nó falha sem rodar o script e diz qual versão achou. Sem version, vale o mínimo do VVPost (3.8). A versão que rodou aparece no relatório do CLI.
   */
  version?: string
  /**
   * Hosts que o script pode acessar: "api.example.com", "*.example.com", "10.0.0.5:5432" ou "*" (qualquer host). Sem network, o script não tem rede, nem abre subprocessos ou carrega ctypes (docs/flows.md).
   *
   * @maxItems 64
   */
  network?: string[]
}
/**
 * Nó contribuído por um plugin (Plugin SDK, docs/plugins.md), executado no processo do plugin. Com node, roda um tipo de nó do plugin e o valor devolvido vira $nodes.<nome>.data; com adapter, faz a chamada pelo adapter de protocolo (ex.: graphql) e a saída tem data, status e headers como a de uma requisição.
 */
export interface FlowPluginNode {
  id: FlowNodeId
  name: FlowNodeName
  type: 'plugin'
  position?: FlowPosition
  plugin: FlowPlugin
}
/**
 * A contribuição de plugin que o nó usa (node ou adapter) e a configuração dela. Textos da configuração aceitam {{ $nodes.Nome... }}; os {{VAR}} do ambiente ficam como estão e só são resolvidos no main process, quando o plugin envia uma requisição pelo host.
 */
export interface FlowPlugin {
  /**
   * Tipo de nó de um plugin, no formato <namespace>.<nome>, ex.: javascript.script.
   */
  node?: string
  /**
   * Protocolo de um adapter de plugin, ex.: graphql.
   */
  adapter?: string
  /**
   * Só com adapter: conector cuja herança (baseUrl, headers, auth, mTLS) vale para as requisições do adapter.
   */
  connector?: string
  /**
   * Valores dos campos que a contribuição declara no manifesto do plugin.
   */
  config?: Record<string, unknown>
  /**
   * Padrão: 30000. Passou do tempo, a chamada é cancelada, e um worker que não para é encerrado.
   */
  timeoutMs?: number
  /**
   * Só com adapter. Padrão: false, e um status 4xx/5xx é erro do nó.
   */
  ignoreHttpErrors?: boolean
}
/**
 * Espera um tempo antes de seguir (ex.: dar tempo a um processamento assíncrono). A saída é { waitedMs }.
 */
export interface FlowWaitNode {
  id: FlowNodeId
  name: FlowNodeName
  type: 'wait'
  position?: FlowPosition
  wait: FlowWait
}
export interface FlowWait {
  /**
   * Milissegundos de espera.
   */
  ms: number
}
/**
 * Espera um evento no servidor local de webhooks (docs/webhooks.md): o primeiro aceito desde o início da execução, ou o que disparou o fluxo. Serve de gatilho (nó sem anteriores num fluxo disparado por um hook) e de espera por um callback assíncrono (depois da requisição que o pede). A saída fica em $nodes.<nome>: data com method, path, query, headers, body (JSON ou formulário já lidos) e hook, e headers com os headers recebidos. Sem evento até timeoutMs, o nó falha com WEBHOOK_TIMEOUT.
 */
export interface FlowWebhookNode {
  id: FlowNodeId
  name: FlowNodeName
  type: 'webhook'
  position?: FlowPosition
  webhook: FlowWebhook
}
/**
 * Que evento o nó aceita. Sem hook nem path, qualquer evento aceito pelo servidor. Cada evento serve a um nó só por execução.
 */
export interface FlowWebhook {
  /**
   * Id de um hook de .vvpost/webhooks.json: só eventos que ele atendeu.
   */
  hook?: string
  /**
   * Caminho recebido, sem a query, ex.: /pagamentos. Terminado em /* aceita os subcaminhos. Aceita {{ $nodes.Nome... }}, ex.: /pedidos/{{ $nodes.Criar.data.id }}.
   */
  path?: string
  method?: FlowHttpMethod
  until?: FlowCondition1
  /**
   * Quanto esperar pelo evento. Padrão: 60000.
   */
  timeoutMs?: number
}
/**
 * Condição sobre o evento, lida pelo nome do próprio nó (ex.: $nodes.Callback.data.body.status equals "pago"); eventos em que ela não vale são ignorados.
 */
export interface FlowCondition1 {
  /**
   * Caminho em $nodes, ex.: $nodes.Login.status ou $nodes.Login.data.items[0].id.
   */
  target: string
  operator:
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
  /**
   * Valor comparado. Um texto que é só {{ $nodes... }} compara com o valor referenciado.
   */
  expected?: unknown
}
/**
 * OAuth2 de um fluxo-base (client credentials, password ou authorization code com PKCE): o access_token vai em Authorization em toda requisição de quem herda, fica só em memória e é renovado com o refresh_token. Só vale num fluxo-base, como o nó de login.
 */
export interface FlowOAuth2Node {
  id: FlowNodeId
  name: FlowNodeName
  type: 'oauth2'
  position?: FlowPosition
  oauth2: import('./connector').AuthOAuth2
}
export interface FlowEdge {
  from: FlowNodeId
  to: FlowNodeId
  /**
   * Só em arestas que saem de um nó condition: o ramo que esta aresta segue.
   */
  branch?: 'true' | 'false'
}
