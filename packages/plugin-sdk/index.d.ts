/**
 * Plugin SDK do VVPost, apiVersion 1. Guia completo em docs/plugins.md.
 *
 * Um plugin é uma pasta com `vvpost-plugin.json` (o manifesto) e o arquivo de `main`,
 * que exporta as implementações das contribuições declaradas no manifesto:
 *
 * ```js
 * const { definePlugin } = require('@vvpost/plugin-sdk')
 * module.exports = definePlugin({
 *   nodes: { 'acme.hello': { run: async (ctx) => ({ hello: ctx.config.name }) } },
 *   adapters: { acme: { send: async (ctx) => { const res = await ctx.http.send({ method: 'GET', url: '/' }); return { data: res.json(), status: res.status, headers: res.headers } } } }
 * })
 * ```
 *
 * O código roda num processo só do plugin, com as permissões do Node ligadas: lê só a
 * pasta do plugin e conecta só aos hosts de `permissions.network` no manifesto.
 * Veja "Modelo de confiança" em docs/plugins.md.
 */

export declare const API_VERSION: 1

/** Saída de um nó anterior, como em `$nodes.<nome>`. */
export interface NodeOutput {
  readonly data: unknown
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly durationMs?: number
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/**
 * Requisição enviada pelo host (dispatcher e auth headless do VVPost). Num adapter com
 * conector, uma url relativa usa a baseUrl do conector e a auth, os headers e o mTLS
 * herdados entram no main process: o plugin nunca vê o token. `{{VAR}}` do ambiente
 * ativo é resolvido no host, em url, headers e body.
 */
export interface HttpRequest {
  /** Padrão: GET. */
  method?: HttpMethod
  url: string
  headers?: Record<string, string> | { name: string; value: string }[]
  /** Texto, ou um valor que vira JSON (com content-type application/json se não houver um). */
  body?: string | object | number | boolean | null
  /** Padrão: 30 s. */
  timeoutMs?: number
}

export interface HttpResponse {
  status: number
  statusText: string
  /** Por nome em minúsculas; repetidos juntados com ", ". */
  headers: Record<string, string>
  /** Corpo como texto (cortado em 10 MB; veja truncated). */
  body: string
  truncated: boolean
  durationMs: number
  /** JSON.parse(body); lança se o corpo não for JSON. */
  json<T = unknown>(): T
}

/** Erro de rede, de auth ou de configuração numa chamada de ctx.http.send. */
export interface HttpError extends Error {
  /** INVALID_URL, TIMEOUT, ABORTED, CONNECTION_REFUSED, AUTH_FAILED, CONFIG_ERROR... */
  code: string
}

export interface PluginHttp {
  send(request: HttpRequest): Promise<HttpResponse>
}

export interface BaseContext<Config> {
  /**
   * Valores dos campos do manifesto, com os defaults aplicados e `{{ $nodes... }}` já
   * resolvido (exceto nos campos com `templates: false`). `{{VAR}}` do ambiente fica literal.
   */
  readonly config: Config
  /** Saída dos nós anteriores a este no grafo (uma cópia: mudar não afeta o fluxo). */
  readonly nodes: Readonly<Record<string, NodeOutput>>
  /** O nó do fluxo que está rodando. */
  readonly node: { readonly id: string; readonly name: string }
  /** Tempo máximo desta chamada, em ms. */
  readonly timeoutMs: number
  /** Abortado quando o usuário cancela o fluxo ou o tempo acaba. */
  readonly signal: AbortSignal
  /** Vai para os logs do nó no inspetor (console.log também vai). */
  log(...args: unknown[]): void
  /** Requisições pelo host, com o ambiente ativo (e, num adapter, o conector do nó). */
  readonly http: PluginHttp
}

export type NodeContext<Config = Record<string, unknown>> = BaseContext<Config>

export interface AdapterContext<Config = Record<string, unknown>> extends BaseContext<Config> {
  /** Id do conector do nó, quando há um (a herança já é aplicada pelo ctx.http). */
  readonly connector?: string
  /**
   * A conexão resolvida do conector do nó, só para plugins com
   * `permissions.connectorCredentials` (protocolos que não passam por ctx.http, como gRPC e Kafka).
   */
  readonly connection?: ConnectorConnection
}

/** baseUrl, headers, credenciais e mTLS do conector, com as variáveis do ambiente resolvidas. */
export interface ConnectorConnection {
  /** baseUrl + basePath (ex.: grpcs://api:443, kafka://b1:9092). */
  readonly url: string
  /** Headers do conector e os da auth (Authorization...), por nome em minúsculas. */
  readonly headers: Readonly<Record<string, string>>
  /** Parâmetros de query da auth (apiKey em query). */
  readonly query: Readonly<Record<string, string>>
  /** basic: username e password; as outras auths: o token aplicado (sem "Bearer "). */
  readonly auth?: { readonly type: string; readonly username?: string; readonly password?: string; readonly token?: string }
  /** mTLS: PEM em texto, pfx em base64. */
  readonly tls?: { readonly ca?: string; readonly cert?: string; readonly key?: string; readonly pfx?: string; readonly passphrase?: string }
}

/** O que um adapter devolve; vira `$nodes.<nome>` como a saída de uma requisição. */
export interface AdapterResult {
  data: unknown
  status?: number
  headers?: Record<string, string>
}

export interface NodeImplementation<Config = Record<string, unknown>> {
  /** O valor devolvido (serializável em JSON) vira `$nodes.<nome>.data`. Lançar um erro falha o nó. */
  run(ctx: NodeContext<Config>): unknown
}

export interface AdapterImplementation<Config = Record<string, unknown>> {
  /** Um status >= 400 falha o nó, a menos que ele marque ignoreHttpErrors. */
  send(ctx: AdapterContext<Config>): AdapterResult | Promise<AdapterResult>
}

/** Texto inline de uma página da documentação (a árvore neutra do "Enviar para…"). */
export type DocInline =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: DocInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: DocInline[] }
  /** Link para outra página do pacote, pela chave do nó. */
  | { type: 'pageLink'; page: string; anchor?: string; children: DocInline[] }
  | { type: 'anchorLink'; anchor: string; children: DocInline[] }
  /** Imagem do pacote (asset, o id de um anexo) ou externa (url). */
  | { type: 'image'; alt: string; asset?: string; url?: string }
  | { type: 'break' }

/** Bloco de uma página da documentação. */
export type DocBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; anchor: string; children: DocInline[] }
  | { type: 'paragraph'; children: DocInline[] }
  | { type: 'list'; ordered: boolean; start?: number; items: { checked?: boolean; blocks: DocBlock[] }[] }
  | { type: 'table'; align: ('left' | 'center' | 'right' | null)[]; header: DocInline[][]; rows: DocInline[][][] }
  | { type: 'code'; language?: string; text: string }
  /** Diagrama Mermaid: a imagem é o anexo `asset` (quando foi desenhada); source é o código. */
  | { type: 'diagram'; asset?: string; source: string }
  | { type: 'alert'; kind: 'note' | 'tip' | 'important' | 'warning' | 'caution'; blocks: DocBlock[] }
  | { type: 'quote'; blocks: DocBlock[] }
  | { type: 'rule' }
  /** HTML cru do Markdown: mostre como texto, nunca interprete. */
  | { type: 'html'; text: string }

export interface DocNode {
  /** Chave estável do nó (document, file:docs/guia.md, connector:billing...). */
  key: string
  kind: 'folder' | 'page'
  title: string
  source?: string
  /** Sem page, a página só agrupa as filhas. */
  page?: { markdown: string; blocks: DocBlock[]; toc: boolean }
  /** SHA-256 do conteúdo: muda quando a página muda. */
  hash: string
  children: DocNode[]
}

/** A documentação montada pelo VVPost, já sem nenhum valor de segredo. */
export interface DocBundle {
  target: { id: string; name: string; provider: string; destination: string; diagrams: 'png' | 'svg' | 'code' }
  project: string
  generatedAt: string
  nodes: DocNode[]
  /** Anexos: imagens do workspace e diagramas desenhados, com os bytes em base64. */
  assets: { id: string; mediaType: string; hash: string; base64?: string; diagram?: string; file?: string }[]
  meta?: { title: string; subtitle?: string; version?: string; organization?: string; primary?: string; logo?: string }
  api?: { endpoints: { key: string; method: string; path: string; name: string; connector: string; hash: string }[] }
  site?: { title?: string; changelog?: boolean; backstage?: boolean; baseUrl?: string }
}

export interface DocChangelogEntry {
  at: string
  label?: string
  initial?: boolean
  pages: { added: { key: string; title: string }[]; changed: { key: string; title: string }[]; removed: { key: string; title: string }[] }
  endpoints: { added: { key: string; title: string }[]; changed: { key: string; title: string }[]; removed: { key: string; title: string }[] }
}

export interface ExporterContext {
  readonly bundle: DocBundle
  /** Histórico das exportações nesta pasta, da mais nova (esta) para a mais antiga. */
  readonly changelog: DocChangelogEntry[]
  /** O vvpost-site.json da exportação anterior na mesma pasta, ou null. */
  readonly previous: unknown
  readonly timeoutMs: number
  readonly signal: AbortSignal
  log(...args: unknown[]): void
}

/** Um arquivo da exportação: caminho relativo à pasta de saída, com texto ou bytes em base64. */
export interface ExportedFile {
  path: string
  text?: string
  base64?: string
  /** Chave da página que o arquivo mostra: ele só muda com a confirmação da pessoa no app. */
  page?: string
}

export interface ExporterImplementation {
  /** Devolve os arquivos; o VVPost confere os caminhos e grava só dentro da pasta de saída. */
  export(ctx: ExporterContext): { files: ExportedFile[] } | Promise<{ files: ExportedFile[] }>
}

/** Um destino do vvpost.publish.json, como o publicador o recebe. */
export interface PublishTarget {
  id: string
  name: string
  provider: string
  /** Onde a estrutura começa no destino, como a pessoa escreveu (um espaço, uma página...). */
  destination: string
  diagrams: 'png' | 'svg' | 'code'
}

export type PublishAction = 'create' | 'update' | 'same' | 'conflict' | 'orphan'

export interface PublishPlanItem {
  key: string
  kind: 'folder' | 'page'
  title: string
  path: string[]
  action: PublishAction
  remote?: { id: string; version?: number; url?: string; editedBy?: string; editedAt?: string }
  /** Texto atual e novo, para o diff (só update e conflict). */
  before?: string
  after?: string
}

export interface PublishPlan {
  items: PublishPlanItem[]
  destination: { label: string; url?: string }
  warnings?: string[]
}

/** O que a pessoa confirmou: update, conflict e orphan só mudam com a chave aqui. */
export interface PublishApproval {
  update: string[]
  conflicts: string[]
  archive: string[]
}

export interface PublishResultItem {
  key: string
  outcome: 'created' | 'updated' | 'unchanged' | 'skipped' | 'archived' | 'failed'
  /** Id no destino: com ele, a próxima publicação acha a página (o "published" do vvpost.publish.json). */
  id?: string
  version?: number
  url?: string
  error?: string
}

export interface PublisherContext {
  readonly target: PublishTarget
  /** As requisições saem pelo VVPost, só para os hosts do manifesto, já com a credencial da pessoa. */
  readonly http: PluginHttp
  readonly timeoutMs: number
  readonly signal: AbortSignal
  log(...args: unknown[]): void
}

export interface PublisherPlanContext extends PublisherContext {
  /** As páginas sem segredos; bundle.published diz o que o destino já tem, pela chave. */
  readonly bundle: DocBundle & { published: Record<string, { id: string; kind: 'folder' | 'page'; version?: number; hash?: string; url?: string }> }
}

export interface PublisherPublishContext extends PublisherPlanContext {
  readonly plan: PublishPlan
  readonly approval: PublishApproval
}

export interface PublisherImplementation {
  /** Quem está conectado e onde vai publicar; lançar diz que a credencial não serve. Opcional. */
  session?(ctx: PublisherContext): { account?: string; destination?: string } | null | Promise<{ account?: string; destination?: string } | null>
  /** O que mudaria no destino, sem mudar nada. */
  plan(ctx: PublisherPlanContext): PublishPlan | Promise<PublishPlan>
  /** Publica o que o plano e a confirmação permitem; uma página que falha não derruba as outras. */
  publish(ctx: PublisherPublishContext): { items: PublishResultItem[]; destination?: { label: string; url?: string } } | Promise<{ items: PublishResultItem[]; destination?: { label: string; url?: string } }>
}

/** O que o arquivo de main exporta (module.exports, ou export default num .mjs). */
export interface PluginModule {
  /** Uma implementação por tipo declarado em contributes.nodes. */
  nodes?: Record<string, NodeImplementation<any>>
  /** Uma implementação por protocolo declarado em contributes.adapters. */
  adapters?: Record<string, AdapterImplementation<any>>
  /** Uma implementação por id declarado em contributes.exporters. */
  exporters?: Record<string, ExporterImplementation>
  /** Uma implementação por id declarado em contributes.publishers. */
  publishers?: Record<string, PublisherImplementation>
}

export declare function definePlugin<T extends PluginModule>(plugin: T): T

/** Erro com código, mostrado no nó como `PLUGIN_ERROR: <message>`. */
export declare class PluginError extends Error {
  constructor(message: string, code?: string)
  code?: string
}
