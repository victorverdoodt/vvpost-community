/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

/**
 * Identificador estável em notação de pontos, ex.: connector.billing.v2.
 */
export type ConnectorId = string
/**
 * Id de um conector do mesmo projeto ou do Compartilhado do workspace; "<projeto>:<id>" aponta para um conector de outro projeto do workspace.
 */
export type ConnectorRef = string
/**
 * Autenticação do conector. Executada em segundo plano pelo main process antes de cada requisição; tokens obtidos ficam só em memória. Herdada do pai inteira: o filho que define auth substitui a do pai, e {"type": "none"} desliga. Todos os textos aceitam variáveis {{VAR}}.
 */
export type ConnectorAuth =
  | AuthNone
  | AuthBearer
  | AuthApiKey
  | AuthBasic
  | AuthOAuth2
  | AuthLogin
  | AuthDigest
  | AuthAwsSigV4
  | AuthNtlm
  | AuthOAuth1
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
/**
 * Identificador único dentro do escopo pai (endpoint no conector, cenário no endpoint).
 */
export type LocalId = string
export type HttpMethod1 = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
/**
 * Corpo estruturado da requisição, no lugar de body: form urlencoded, multipart/form-data (campos de texto e arquivos) ou um arquivo binário. Caminhos de arquivo relativos são relativos à pasta do workspace; textos e caminhos aceitam {{VAR}}. O content-type é definido pelo VVPost (com o boundary, no multipart), a menos que o endpoint defina um.
 */
export type RequestPayload = PayloadUrlencoded | PayloadMultipart | PayloadBinary
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

/**
 * Conector do catálogo VVPost. Agrupa endpoints e herda config de outro conector via `extends` (id do pai): baseUrl, headers, auth e tls do pai valem para o filho, basePath é concatenado e o filho sobrescreve o que redefinir.
 */
export interface Connector {
  /**
   * URL do schema, usada por editores para autocomplete.
   */
  $schema?: string
  id: ConnectorId
  name: string
  description?: string
  /**
   * Versão semântica do conector (MAJOR.MINOR.PATCH).
   */
  version: string
  extends?: ConnectorRef
  config?: ConnectorConfig
  endpoints?: Endpoint[]
  source?: ConnectorSource
}
export interface ConnectorConfig {
  /**
   * URL base absoluta. Normalmente definida no conector raiz e herdada pelos filhos. Aceita variáveis {{VAR}}.
   */
  baseUrl?: string
  /**
   * Prefixo de caminho somado ao basePath herdado.
   */
  basePath?: string
  headers?: HttpHeaders
  auth?: ConnectorAuth
  tls?: ConnectorTls
  scripts?: RequestScripts
}
export interface HttpHeaders {
  [k: string]: string
}
export interface AuthNone {
  type: 'none'
}
/**
 * Token fixo, normalmente {{VAR}} de um segredo do ambiente.
 */
export interface AuthBearer {
  type: 'bearer'
  token: string
  /**
   * Cabeçalho que recebe o token. Padrão: Authorization.
   */
  header?: string
  /**
   * Prefixo antes do token. Padrão: "Bearer"; "" envia só o token.
   */
  prefix?: string
}
export interface AuthApiKey {
  type: 'apiKey'
  /**
   * Nome do cabeçalho ou do parâmetro de query.
   */
  name: string
  value: string
  in?: 'header' | 'query'
}
export interface AuthBasic {
  type: 'basic'
  username: string
  password: string
}
/**
 * OAuth2: client credentials, password (ROPC) ou authorization code com PKCE (login no navegador do sistema, com retorno num servidor local em 127.0.0.1). O access_token vai em Authorization com o token_type devolvido; refresh_token é usado quando o token expira.
 */
export interface AuthOAuth2 {
  type: 'oauth2'
  grantType: 'client_credentials' | 'password' | 'authorization_code'
  /**
   * authorization_code: URL do authorization endpoint, aberta no navegador do sistema.
   */
  authUrl?: string
  /**
   * authorization_code: redirect_uri registrado no provedor, em loopback (http://127.0.0.1:<porta>/<caminho> ou http://localhost:...). Padrão: http://127.0.0.1:<porta livre>/callback.
   */
  redirectUri?: string
  /**
   * authorization_code: manda code_challenge S256 (RFC 7636). Desligue só para provedores que recusam PKCE.
   */
  pkce?: boolean
  /**
   * URL absoluta do token endpoint, ou caminho relativo à baseUrl do conector, que entra inteira: com baseUrl https://h/api/v1, /oauth/token vira https://h/api/v1/oauth/token. Para a raiz do host, use a URL absoluta.
   */
  tokenUrl: string
  clientId: string
  clientSecret?: string
  username?: string
  password?: string
  scope?: string
  audience?: string
  /**
   * basic: client_id e client_secret no cabeçalho Authorization, no esquema Basic; body: no corpo do form.
   */
  clientAuthentication?: 'basic' | 'body'
  /**
   * Campos extras no corpo do pedido de token.
   */
  extraParams?: {
    [k: string]: string
  }
  /**
   * Corpo do pedido de token: form (application/x-www-form-urlencoded, o padrão do OAuth2) ou json (application/json, os mesmos campos num objeto).
   */
  tokenRequestFormat?: 'form' | 'json'
}
/**
 * Endpoint de login próprio da API: o VVPost chama o endpoint, extrai o token da resposta e injeta nas requisições.
 */
export interface AuthLogin {
  type: 'login'
  request: AuthLoginRequest
  /**
   * Caminho do token na resposta, body.<caminho> ou headers.<nome>, ex.: body.data.accessToken.
   */
  token: string
  /**
   * Caminho (body.<caminho>) com a validade em segundos.
   */
  expiresIn?: string
  /**
   * Validade fixa do token quando a resposta não informa.
   */
  ttlSeconds?: number
  inject?: AuthLoginInject
}
export interface AuthLoginRequest {
  method?: HttpMethod
  /**
   * URL absoluta ou caminho relativo à baseUrl do conector.
   */
  url: string
  headers?: HttpHeaders
  /**
   * Corpo JSON. Strings dentro dele aceitam {{VAR}}.
   */
  json?: unknown
  /**
   * Corpo application/x-www-form-urlencoded.
   */
  form?: {
    [k: string]: string
  }
  /**
   * Corpo em texto puro.
   */
  body?: string
}
/**
 * Onde o token entra. Padrão: o cabeçalho Authorization recebe {{$token}} com o prefixo Bearer.
 */
export interface AuthLoginInject {
  in?: 'header' | 'query'
  name?: string
  /**
   * Modelo do valor; {{$token}} é o token extraído.
   */
  value?: string
}
/**
 * HTTP Digest (RFC 7616, MD5 e SHA-256, qop auth): a primeira resposta 401 traz o desafio, e a requisição é repetida com Authorization: Digest.
 */
export interface AuthDigest {
  type: 'digest'
  username: string
  password: string
}
/**
 * Assinatura AWS Signature Version 4 de cada requisição (método, URL, headers e corpo), em Authorization, X-Amz-Date e X-Amz-Content-Sha256.
 */
export interface AuthAwsSigV4 {
  type: 'awsSigV4'
  accessKeyId: string
  secretAccessKey: string
  /**
   * Credencial temporária (STS): vai em X-Amz-Security-Token.
   */
  sessionToken?: string
  /**
   * Ex.: us-east-1.
   */
  region: string
  /**
   * Ex.: execute-api, s3, lambda.
   */
  service: string
}
/**
 * NTLMv2 (Windows): o handshake de três mensagens acontece numa conexão dedicada à origem, antes de cada requisição.
 */
export interface AuthNtlm {
  type: 'ntlm'
  username: string
  password: string
  domain?: string
  workstation?: string
}
/**
 * OAuth 1.0a com token já emitido (RFC 5849): cada requisição é assinada com HMAC-SHA1, HMAC-SHA256 ou PLAINTEXT e vai com Authorization: OAuth.
 */
export interface AuthOAuth1 {
  type: 'oauth1'
  consumerKey: string
  consumerSecret: string
  token?: string
  tokenSecret?: string
  signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT'
  realm?: string
}
/**
 * Certificado de cliente (mTLS) e CA extra para o conector e o fluxo de auth. Caminhos relativos à pasta do workspace (ou absolutos, ou {{VAR}}): chaves privadas não devem ser commitadas.
 */
export interface ConnectorTls {
  /**
   * Certificado do cliente em PEM.
   */
  cert?: string
  /**
   * Chave privada do cliente em PEM.
   */
  key?: string
  /**
   * Certificado e chave em PKCS#12, no lugar de cert/key.
   */
  pfx?: string
  passphrase?: string
  /**
   * CA em PEM para confiar no servidor, além das do sistema.
   */
  ca?: string
}
/**
 * Scripts JavaScript da requisição. Por trás, a requisição vira um fluxo script → requisição → script no motor do Flow Studio, com o runtime do vvpost-plugin-javascript. Os do conector valem para todos os endpoints dele e dos filhos, e rodam antes dos do endpoint (pre e post, da raiz para o endpoint).
 */
export interface RequestScripts {
  /**
   * Roda antes do envio: lê e altera vv.request (method, url, headers, query, body) e define variáveis com vv.variables.set.
   */
  pre?: string
  /**
   * Roda com a resposta em vv.response: declara testes com vv.test(nome, fn) e vv.expect, que entram no resultado como asserções, e define variáveis.
   */
  post?: string
}
export interface Endpoint {
  id: LocalId
  name: string
  description?: string
  method: HttpMethod1
  /**
   * Caminho relativo ao basePath. Parâmetros de rota usam {nome}, ex.: /charges/{chargeId}.
   */
  path: string
  /**
   * true: o endpoint exige credencial, e sem ela a API responde 401 ou 403. false: é público e funciona sem credencial. Ausente: não declarado. O vvpost run confere: um endpoint que exige auth é chamado uma vez sem credencial (cenário $sem-credencial) e precisa dar 401 ou 403; os cenários de um endpoint público rodam sem a auth do conector e sem os headers de credencial herdados. A importação da OpenAPI preenche pelo security da operação.
   */
  requiresAuth?: boolean
  headers?: HttpHeaders
  query?: QueryParams
  /**
   * JSON Schema do corpo da requisição. Usado para validação e autocomplete.
   */
  bodySchema?: Record<string, unknown>
  /**
   * Corpo padrão da requisição. Cenários sobrescrevem via overrides.body.
   */
  body?: unknown
  payload?: RequestPayload
  plugin?: EndpointPlugin
  scripts?: RequestScripts
  source?: EndpointSource
  scenarios?: Scenario[]
  /**
   * Respostas de exemplo do endpoint: documentação e o que o mock server local devolve.
   */
  examples?: ResponseExample[]
}
export interface QueryParams {
  [k: string]: string
}
export interface PayloadUrlencoded {
  mode: 'urlencoded'
  fields: PayloadTextField[]
}
export interface PayloadTextField {
  name: string
  value?: string
}
export interface PayloadMultipart {
  mode: 'multipart'
  fields: PayloadFormField[]
}
export interface PayloadFormField {
  name: string
  /**
   * Valor de um campo de texto.
   */
  value?: string
  /**
   * Caminho do arquivo enviado neste campo (no lugar de value).
   */
  file?: string
  /**
   * Nome do arquivo no envio. Padrão: o nome do arquivo em file.
   */
  filename?: string
  /**
   * Content-Type da parte. Padrão: pela extensão do arquivo; nenhum num campo de texto.
   */
  contentType?: string
}
export interface PayloadBinary {
  mode: 'binary'
  /**
   * Caminho do arquivo enviado como corpo.
   */
  file: string
  /**
   * Padrão: pela extensão do arquivo.
   */
  contentType?: string
}
/**
 * O endpoint é chamado pelo adapter de um plugin (gRPC, Kafka...), não por HTTP. method e path ficam como rótulo; headers, query e body não se aplicam. A herança do conector chega ao adapter como no nó de plugin do Flow Studio.
 */
export interface EndpointPlugin {
  /**
   * Protocolo do adapter, ex.: grpc, kafka, graphql.
   */
  adapter: string
  /**
   * Valores dos campos que o adapter declara no manifesto do plugin. {{VAR}} do ambiente fica literal até o plugin enviar pelo host; {{$capture.<nome>}} recebe o capture de um cenário anterior.
   */
  config?: Record<string, unknown>
  /**
   * Padrão: 30000.
   */
  timeoutMs?: number
}
/**
 * Operação da spec que gerou o endpoint. hash resume o que veio da spec (nome, descrição, método, caminho, headers, query, bodySchema e corpo) para a reimportação saber o que mudou na spec e o que foi editado no projeto.
 */
export interface EndpointSource {
  /**
   * Método e caminho da operação na spec, ex.: GET /pets/{petId}.
   */
  operation: string
  operationId?: string
  /**
   * Primeira tag da operação.
   */
  tag?: string
  hash: string
}
/**
 * Caso de teste table-driven de um endpoint.
 */
export interface Scenario {
  id: LocalId
  name: string
  description?: string
  overrides?: ScenarioOverrides
  /**
   * Cenários que rodam antes deste, no mesmo ambiente, como <endpoint>/<cenário> do mesmo conector. Se um deles não passar, este nem é enviado.
   */
  dependsOn?: string[]
  /**
   * Valores da resposta guardados para os cenários que dependem deste, lidos com {{$capture.<nome>}}. O valor é status, body, body.<caminho> ou headers.<nome>.
   */
  capture?: {
    [k: string]: string
  }
  /**
   * @minItems 1
   */
  assertions: [Assertion, ...Assertion[]]
}
export interface ScenarioOverrides {
  /**
   * Substitui o corpo padrão do endpoint.
   */
  body?: unknown
  /**
   * Substitui o corpo estruturado do endpoint (e o body). null tira o corpo estruturado.
   */
  payload?: null | RequestPayload
  /**
   * Mescla com os headers herdados. null remove todos os headers herdados (ex.: testar 401 sem auth); um header com valor null é removido.
   */
  headers?: null | {
    [k: string]: string | null
  }
  query?: {
    [k: string]: string | null
  }
  /**
   * Valores para os parâmetros {nome} do path.
   */
  pathParams?: {
    [k: string]: string
  }
  /**
   * Nomes de pathParams que vão como estão, sem codificar para URL: um valor já codificado (ex.: %E0, para testar o 400 de um caminho malformado) chega ao servidor cru.
   */
  rawPathParams?: string[]
  /**
   * Só em endpoint com plugin: mescla com plugin.config do endpoint, campo a campo; null tira o campo (volta ao padrão do manifesto).
   */
  config?: Record<string, unknown | null>
}
export interface Assertion {
  /**
   * O que é verificado: status, responseTimeMs, body, body.<caminho> ou headers.<nome>.
   */
  target: string
  operator: AssertionOperator
  /**
   * Valor esperado. Ausente em exists/notExists/matchesExample; número em comparações; JSON Schema em matchesSchema.
   */
  expected?: unknown
  /**
   * Só vale nestes ambientes (ids). Ausente: em todos. Ex.: status 401 em um ambiente e 200 em outro.
   *
   * @minItems 1
   */
  environments?: [string, ...string[]]
}
/**
 * Resposta de exemplo salva no endpoint, servida pelo mock server (vvpost mock).
 */
export interface ResponseExample {
  id: LocalId
  name: string
  description?: string
  status: number
  headers?: HttpHeaders
  /**
   * Corpo da resposta: texto ou JSON. No mock, {{$path.<nome>}}, {{$query.<nome>}} e as variáveis dinâmicas ($uuid, $timestamp...) são trocadas.
   */
  body?: unknown
  /**
   * Atraso antes de o mock responder, para simular latência.
   */
  delayMs?: number
  /**
   * JSON Schema do corpo desta resposta (o import de OpenAPI preenche). O vvpost validate reprova o exemplo fora dele, e a asserção matchesExample confere a resposta real com o schema do exemplo do mesmo status.
   */
  schema?: Record<string, unknown>
}
/**
 * Spec de onde o conector (e os filhos dele) foi importado. Reimportar a spec dali mescla o que mudou.
 */
export interface ConnectorSource {
  type: 'openapi'
  /**
   * URL da spec, ou caminho do arquivo relativo à pasta do workspace (ou absoluto).
   */
  location: string
  /**
   * info.version da spec na última importação.
   */
  version?: string
}
