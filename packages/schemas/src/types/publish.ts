/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

export type PublishNode = PublishFolderNode | PublishPageNode | PublishPagesNode | PublishEachNode
/**
 * Chave estável do nó. Sem ela, a chave vem da origem ou do caminho de títulos: trocar o título cria outra página.
 */
export type Key = string
/**
 * @maxItems 200
 */
export type Children = PublishNode[]

/**
 * Destinos de publicação da documentação, em vvpost.publish.json na raiz do workspace: para onde o "Enviar para…" manda a documentação e com que estrutura de pastas e páginas. Vai para o Git; credenciais nunca entram aqui.
 */
export interface PublishConfig {
  /**
   * URL do schema, usada por editores para autocomplete.
   */
  $schema?: string
  /**
   * @maxItems 50
   */
  targets: PublishTarget[]
}
export interface PublishTarget {
  /**
   * Identificador do destino no workspace.
   */
  id: string
  /**
   * Nome mostrado no "Enviar para…".
   */
  name?: string
  /**
   * Publicador que envia: html (site estático numa pasta, do próprio VVPost), confluence-cloud (do VVPost Enterprise) ou o exportador de um plugin.
   */
  provider: string
  /**
   * Onde a estrutura começa, no formato do publicador. Num exportador (html ou de plugin) é a pasta de saída, relativa ao workspace (ex.: dist/site). No Confluence Cloud do Enterprise, "catalog:<id>" aponta para um destino aprovado no Control Plane.
   */
  destination: string
  /**
   * Como os diagramas Mermaid vão: imagem PNG, imagem SVG ou só o código.
   */
  diagrams?: 'png' | 'svg' | 'code'
  site?: PublishSiteOptions
  /**
   * Pastas e páginas na ordem em que aparecem no destino.
   *
   * @minItems 1
   * @maxItems 200
   */
  structure: [PublishNode, ...PublishNode[]]
  /**
   * Gravado pelo VVPost depois de cada publicação: o que já existe no destino, pela chave do nó. Não edite à mão.
   */
  published?: {
    [k: string]: PublishedItem
  }
}
/**
 * Opções dos exportadores para pasta (html e os de plugins). Os publicadores remotos ignoram.
 */
export interface PublishSiteOptions {
  /**
   * Título do site. Padrão: o título do documento do projeto (vvpost.docs.json) ou o nome do projeto.
   */
  title?: string
  /**
   * Página "Mudanças" com o que mudou em cada exportação (páginas e endpoints novos, alterados e removidos), guardada no vvpost-site.json da pasta.
   */
  changelog?: boolean
  /**
   * Grava o techdocs_metadata.json do Backstage TechDocs: a pasta vai direto para techdocs-cli publish --directory.
   */
  backstage?: boolean
  /**
   * Endereço público do site, para os links canônicos e o sitemap.xml.
   */
  baseUrl?: string
}
export interface PublishFolderNode {
  /**
   * Título da pasta.
   */
  folder: string
  key?: Key
  children?: Children
}
export interface PublishPageNode {
  /**
   * Título da página.
   */
  page: string
  /**
   * Conteúdo: "document" (o documento do projeto), um .md do workspace (com "#seção" opcional), "connector:<id>" ou "endpoint:<conector>/<endpoint>". Sem source, a página só agrupa as filhas.
   */
  source?: string
  key?: Key
  children?: Children
}
export interface PublishPagesNode {
  /**
   * Glob de arquivos .md do workspace (ex.: docs/guias/*.md): uma página por arquivo, em ordem alfabética.
   */
  pages: string
  /**
   * Título de cada página: {{heading}} (o primeiro título do arquivo, o padrão) e {{file}} (o nome sem .md).
   */
  title?: string
}
export interface PublishEachNode {
  /**
   * Uma página por conector do projeto, com a referência.
   */
  each: 'connector'
  /**
   * Título de cada página: {{name}} (o padrão) e {{id}}.
   */
  title?: string
  /**
   * sections: os endpoints são seções da página do conector; endpoints: uma página filha por endpoint.
   */
  split?: 'sections' | 'endpoints'
  /**
   * Só estes conectores (ids), na ordem dada. Padrão: todos, em ordem alfabética.
   *
   * @maxItems 500
   */
  connectors?: string[]
}
export interface PublishedItem {
  /**
   * Id no destino.
   */
  id: string
  kind: 'folder' | 'page'
  /**
   * Versão no destino depois da última publicação pelo VVPost.
   */
  version?: number
  /**
   * Hash do conteúdo publicado.
   */
  hash?: string
  url?: string
}
