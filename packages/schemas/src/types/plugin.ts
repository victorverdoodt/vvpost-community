/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

/**
 * Manifesto de um plugin do VVPost (vvpost-plugin.json na raiz da pasta do plugin). Declara o que o plugin contribui (tipos de nó do Flow Studio e adapters de protocolo) e os campos de configuração de cada um; o código fica no arquivo de main e roda num processo próprio, com as permissões que o manifesto declara (docs/plugins.md).
 */
export interface PluginManifest {
  /**
   * URL do schema, usada por editores para autocomplete.
   */
  $schema?: string
  /**
   * Identificador único do plugin, em minúsculas com hífens, ex.: vvpost-plugin-graphql. É também o nome da pasta onde ele é instalado.
   */
  id: string
  name: string
  /**
   * Versão semântica, ex.: 1.2.0.
   */
  version: string
  description?: string
  author?: string
  homepage?: string
  /**
   * Arquivo JavaScript de entrada, relativo à pasta do plugin e dentro dela (CommonJS .js/.cjs, ou ES module .mjs).
   */
  main: string
  /**
   * Versão da API do Plugin SDK que o plugin usa. Esta versão do VVPost aceita 1.
   */
  apiVersion: 1
  permissions?: PluginPermissions
  contributes: PluginContributions
}
/**
 * O que o processo do plugin pode fazer além de ler a própria pasta. Sem permissions, o plugin não abre conexões: as requisições dele saem só por ctx.http, pelo host. O Extensions Hub mostra as permissões antes de instalar.
 */
export interface PluginPermissions {
  /**
   * Hosts a que o plugin conecta por conta própria (gRPC, Kafka, um SDK): "api.example.com", "*.example.com", "10.0.0.5:9092", "connector" (o host da baseUrl do conector do nó), "config:<campo>" (os hosts escritos num campo da configuração do nó) ou "*" (qualquer host). UDP, sockets locais e servidores só com "*".
   *
   * @maxItems 64
   */
  network?: string[]
  /**
   * true: num adapter com conector, o plugin recebe em ctx.connection a conexão resolvida do conector (URL, headers com a auth, usuário e senha, mTLS), para falar um protocolo próprio (gRPC, Kafka). Só vale com network restrito a connector e config:<campo>, para as credenciais só irem aos hosts do nó.
   */
  connectorCredentials?: boolean
}
export interface PluginContributions {
  nodes?: PluginNodeContribution[]
  adapters?: PluginAdapterContribution[]
  diagrams?: PluginDiagramContribution
  exporters?: PluginExporterContribution[]
  publishers?: PluginPublisherContribution[]
}
/**
 * Tipo de nó do Flow Studio. O plugin exporta nodes[type].run(ctx), e o valor devolvido vira $nodes.<nome>.data.
 */
export interface PluginNodeContribution {
  /**
   * <namespace>.<nome>, ex.: javascript.script. Único entre os plugins ligados.
   */
  type: string
  title: string
  description?: string
  fields?: PluginField[]
}
/**
 * Campo de configuração mostrado no inspetor do Flow Studio e gravado em plugin.config do nó.
 */
export interface PluginField {
  key: string
  label: string
  /**
   * text: uma linha; textarea e code: várias linhas; json: qualquer valor JSON; number, boolean e select: o valor tipado.
   */
  type: 'text' | 'textarea' | 'code' | 'json' | 'number' | 'boolean' | 'select'
  description?: string
  placeholder?: string
  required?: boolean
  /**
   * Valor usado quando o nó não define o campo.
   */
  default?: unknown
  /**
   * Só em code: linguagem do código (javascript, graphql...), para o editor.
   */
  language?: string
  /**
   * Padrão: true, e textos com {{ $nodes... }} recebem os valores dos nós anteriores antes de chegar ao plugin. false entrega o texto como está (ex.: um script que lê nodes direto).
   */
  templates?: boolean
  /**
   * Só em select: os valores aceitos.
   *
   * @minItems 1
   */
  options?: [PluginFieldOption, ...PluginFieldOption[]]
}
export interface PluginFieldOption {
  value: string
  label: string
}
/**
 * Adapter de protocolo. O plugin exporta adapters[protocol].send(ctx), que faz a chamada (em geral por ctx.http, com a herança do conector do nó) e devolve { data, status?, headers? }.
 */
export interface PluginAdapterContribution {
  /**
   * Nome do protocolo, ex.: graphql. Único entre os plugins ligados.
   */
  protocol: string
  title: string
  description?: string
  fields?: PluginField[]
}
/**
 * Extensões do editor de diagramas da documentação: pacotes de ícones (usados como prefixo:nome nos diagramas Mermaid, ex.: aws:lambda) e blocos prontos da paleta. São só dados: nada do plugin roda para isso, e os SVG dos ícones passam pelo DOMPurify antes de entrar no diagrama.
 */
export interface PluginDiagramContribution {
  /**
   * @maxItems 16
   */
  iconPacks?:
    | []
    | [PluginIconPack]
    | [PluginIconPack, PluginIconPack]
    | [PluginIconPack, PluginIconPack, PluginIconPack]
    | [PluginIconPack, PluginIconPack, PluginIconPack, PluginIconPack]
    | [PluginIconPack, PluginIconPack, PluginIconPack, PluginIconPack, PluginIconPack]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
    | [
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack,
        PluginIconPack
      ]
  /**
   * @maxItems 500
   */
  blocks?: PluginDiagramBlock[]
}
export interface PluginIconPack {
  /**
   * Prefixo dos ícones nos diagramas (aws em aws:lambda). Único entre os plugins ligados; vv é do VVPost.
   */
  prefix: string
  title: string
  /**
   * Arquivo JSON no formato do Iconify (icons, width, height), relativo à pasta do plugin; até 4 MB.
   */
  file: string
}
export interface PluginDiagramBlock {
  title: string
  /**
   * Grupo da paleta (ex.: AWS, Kafka).
   */
  category: string
  description?: string
  /**
   * Trecho Mermaid inserido no cursor (ou arrastado para o código).
   */
  code: string
  /**
   * Ícone mostrado na paleta, como prefixo:nome.
   */
  icon?: string
}
/**
 * Exportador da documentação para uma pasta (o "Enviar para…" e o vvpost docs export). O plugin exporta exporters[id].export(ctx): recebe em ctx.bundle as páginas já montadas e sem segredos (a mesma árvore neutra dos publicadores) e devolve { files: [{ path, text | base64, page? }] }. Quem grava os arquivos é o VVPost, só dentro da pasta de saída; o plugin não escreve em disco.
 */
export interface PluginExporterContribution {
  /**
   * O provider do destino no vvpost.publish.json (ex.: docusaurus). Único entre os plugins ligados; html e confluence-cloud são do VVPost.
   */
  id: string
  title: string
  description?: string
}
/**
 * Publicador remoto da documentação (o "Enviar para…" do app): o plugin exporta publishers[id] com plan(ctx) e publish(ctx), e session(ctx) opcional. Recebe o pacote sem segredos e fala com o destino só por ctx.http, só com os hosts declarados; o VVPost guarda a credencial da pessoa no cofre local e põe a auth em cada requisição, então o plugin nunca vê o token.
 */
export interface PluginPublisherContribution {
  /**
   * O provider do destino no vvpost.publish.json (ex.: notion). Único entre os plugins ligados, também entre os exportadores; html e confluence-cloud são do VVPost.
   */
  id: string
  title: string
  description?: string
  /**
   * Os únicos hosts a que ctx.http do publicador chega, e só por HTTPS (HTTP só para 127.0.0.1, localhost e [::1]): "api.notion.com", "*.atlassian.net" ou com porta ("docs.empresa.com:8443"). Sem porta, só a padrão.
   *
   * @minItems 1
   * @maxItems 16
   */
  hosts:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
  /**
   * Como a credencial da pessoa entra nas requisições. A pessoa cola o token no "Enviar para…"; ele fica no cofre local, por publicador.
   */
  auth: {
    /**
     * bearer: Authorization: Bearer <token>; basic: Authorization: Basic com o "usuário:token" que a pessoa cola; header: o token no header de header.
     */
    type: 'bearer' | 'basic' | 'header'
    /**
     * Com type header: o nome do header (ex.: X-API-Key).
     */
    header?: string
    /**
     * O que a pessoa cola, ex.: Token de integração.
     */
    label: string
    /**
     * Página que explica como gerar a credencial.
     */
    help?: string
  }
}
