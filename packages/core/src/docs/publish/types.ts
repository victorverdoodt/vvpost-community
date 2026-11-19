import type { PublishedItem, PublishSiteOptions } from '@vvpost/schemas'

/**
 * Conteúdo de uma página no formato neutro do "Enviar para…": a árvore do Markdown já
 * interpretada (títulos com âncora, tabelas, código, alertas, diagramas e imagens como
 * anexos, links para outras páginas do pacote). Cada publicador converte para o formato do
 * destino (storage do Confluence, blocos do Notion...) sem reinterpretar Markdown.
 */
export type PublishInline =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: PublishInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: PublishInline[] }
  /** Link para outra página do pacote (pela chave do nó), com a âncora opcional. */
  | { type: 'pageLink'; page: string; anchor?: string; children: PublishInline[] }
  /** Link para uma âncora da própria página. */
  | { type: 'anchorLink'; anchor: string; children: PublishInline[] }
  /** Imagem do workspace (asset) ou externa (url). */
  | { type: 'image'; alt: string; asset?: string; url?: string }
  | { type: 'break' }

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

export interface PublishListItem {
  /** Lista de tarefas: marcada ou não; ausente numa lista comum. */
  checked?: boolean
  blocks: PublishBlock[]
}

export type PublishBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; anchor: string; children: PublishInline[] }
  | { type: 'paragraph'; children: PublishInline[] }
  | { type: 'list'; ordered: boolean; start?: number; items: PublishListItem[] }
  | { type: 'table'; align: ('left' | 'center' | 'right' | null)[]; header: PublishInline[][]; rows: PublishInline[][][] }
  | { type: 'code'; language?: string; text: string }
  /** Diagrama Mermaid: a imagem é o asset; source é o código, para quem quiser ver ou copiar. */
  | { type: 'diagram'; asset?: string; source: string }
  | { type: 'alert'; kind: AlertKind; blocks: PublishBlock[] }
  | { type: 'quote'; blocks: PublishBlock[] }
  | { type: 'rule' }
  /** HTML cru do Markdown: o publicador mostra como texto, nunca interpreta. */
  | { type: 'html'; text: string }

export interface PublishPage {
  /** Markdown da página, já sanitizado (para destinos que aceitam Markdown). */
  markdown: string
  blocks: PublishBlock[]
  /** Pôr um sumário no topo (o toc do modelo do projeto, na página do documento). */
  toc: boolean
}

export interface PublishTreeNode {
  /** Chave estável do nó: liga o nó à página ou pasta já publicada. */
  key: string
  kind: 'folder' | 'page'
  title: string
  /** De onde o conteúdo veio, para a prévia (document, arquivo, connector:id...). */
  source?: string
  /** Sem page, uma página só agrupa as filhas. */
  page?: PublishPage
  /** SHA-256 (hex) do título, do conteúdo e dos anexos que a página usa. */
  hash: string
  children: PublishTreeNode[]
}

export interface PublishAsset {
  /** Nome do anexo no destino: o hash entra no nome, então o mesmo nome é o mesmo conteúdo. */
  id: string
  mediaType: string
  /** SHA-256 (hex) do conteúdo (dos diagramas, do código Mermaid até a imagem chegar). */
  hash: string
  /** Bytes do anexo; um diagrama ainda sem imagem não tem (o publicador cai para o código). */
  data?: Uint8Array
  /** Código Mermaid, quando o anexo é um diagrama. */
  diagram?: string
  /** Arquivo do workspace, quando o anexo é uma imagem do projeto. */
  file?: string
}

export interface PublishTargetRef {
  id: string
  name: string
  provider: string
  destination: string
  diagrams: 'png' | 'svg' | 'code'
}

/** Um endpoint do projeto, para o histórico de mudanças dos exportadores. */
export interface PublishApiEndpoint {
  /** <conector>/<endpoint>. */
  key: string
  method: string
  path: string
  name: string
  connector: string
  /** SHA-256 (hex) da referência do endpoint (contrato, exemplos, auth): muda quando ele muda. */
  hash: string
}

/** O que o documento do projeto (vvpost.docs.json) diz da capa, para o título e a marca de um site. */
export interface PublishMeta {
  title: string
  subtitle?: string
  version?: string
  organization?: string
  /** Cor de destaque (#RRGGBB) do modelo. */
  primary?: string
  /** Logo do modelo, como anexo do pacote. */
  logo?: string
}

/** Tudo o que vai para o destino, montado do workspace sem nenhum valor de segredo. */
export interface PublishBundle {
  target: PublishTargetRef
  /** Nome do projeto (pasta do workspace). */
  project: string
  generatedAt: string
  nodes: PublishTreeNode[]
  assets: PublishAsset[]
  /** O que o destino já tem, pela chave do nó (o "published" do vvpost.publish.json). */
  published: Record<string, PublishedItem>
  /** Título e marca do documento do projeto. */
  meta?: PublishMeta
  /** Os endpoints do projeto, em ordem, com o hash de cada um. */
  api?: { endpoints: PublishApiEndpoint[] }
  /** Opções dos exportadores para pasta (site do vvpost.publish.json). */
  site?: PublishSiteOptions
}

/** Conta do destino para o diálogo: quem está publicando e onde. */
export interface PublisherSession {
  status: 'signedIn' | 'signedOut' | 'unavailable'
  /** Nome ou e-mail da conta no destino. */
  account?: string
  /** Onde a estrutura começa, para a pessoa conferir (ex.: "Espaço PAG › Documentação"). */
  destination?: string
  /** Por que não dá para publicar (unavailable) ou o que fazer (signedOut). */
  message?: string
  /**
   * signedOut de um publicador que entra com uma credencial colada (os de plugins): o que a pessoa
   * cola e onde aprender a gerar. O diálogo mostra o campo, e signIn recebe em ctx.credential.
   */
  credential?: { label: string; help?: string }
}

export type PublishAction = 'create' | 'update' | 'same' | 'conflict' | 'orphan'

export interface PublishPlanItem {
  key: string
  kind: 'folder' | 'page'
  title: string
  /** Títulos das pastas e páginas acima, da raiz do destino até o pai. */
  path: string[]
  /**
   * create: não existe no destino; update: existe e muda; same: igual; conflict: existe, muda
   * e alguém editou no destino depois da última publicação; orphan: foi publicado pelo VVPost
   * e saiu da estrutura.
   */
  action: PublishAction
  remote?: { id: string; version?: number; url?: string; editedBy?: string; editedAt?: string }
  /** Texto atual no destino e o texto novo, para o diff (só update e conflict). */
  before?: string
  after?: string
}

export interface PublishPlan {
  items: PublishPlanItem[]
  /** Onde a estrutura começa, para a pessoa conferir. */
  destination: { label: string; url?: string }
  warnings: string[]
}

/**
 * O que a pessoa confirmou: create e same seguem sempre; update só com a chave aqui; conflict
 * só com a chave em conflicts (confirmação página a página); orphan só é arquivado em archive.
 */
export interface PublishApproval {
  update: string[]
  conflicts: string[]
  archive: string[]
}

export interface PublishResultItem {
  key: string
  kind: 'folder' | 'page'
  title: string
  outcome: 'created' | 'updated' | 'unchanged' | 'skipped' | 'archived' | 'failed'
  id?: string
  version?: number
  url?: string
  hash?: string
  error?: string
}

export interface PublishResult {
  items: PublishResultItem[]
  /** path: a pasta de saída de um exportador local, relativa ao workspace (para abrir no explorador). */
  destination: { label: string; url?: string; path?: string }
}

export interface PublishContext {
  /** Abre um endereço no navegador do sistema (login). */
  openExternal(url: string): Promise<void>
  /** Cancela a publicação em andamento. */
  signal?: AbortSignal
  /** No signIn de um publicador com session.credential: o que a pessoa colou. */
  credential?: string
}

/**
 * Publicador do "Enviar para…". Vem do módulo Enterprise (controlPlane.publishers) ou de um
 * plugin (contributes.publishers, docs/publish/plugin.ts). Roda no main process: recebe o pacote sem segredos e fala com o
 * destino com a conta da própria pessoa.
 */
export interface DocsPublisher {
  /** O provider do vvpost.publish.json (ex.: confluence-cloud). */
  id: string
  title: string
  session(target: PublishTargetRef): Promise<PublisherSession>
  /** Abre o login no navegador do sistema; resolve quando a conta estiver pronta ou o login falhar. */
  signIn?(target: PublishTargetRef, ctx: PublishContext): Promise<PublisherSession>
  signOut?(target: PublishTargetRef): Promise<void>
  /** O que mudaria, sem mudar nada no destino. */
  plan(bundle: PublishBundle, ctx: PublishContext): Promise<PublishPlan>
  /** Publica o que o plano e a confirmação permitem. Uma página que falha não derruba as outras. */
  publish(bundle: PublishBundle, plan: PublishPlan, approval: PublishApproval, ctx: PublishContext): Promise<PublishResult>
  /**
   * Exportador para uma pasta do workspace (html, os de plugins): sem conta, o destino é a pasta
   * de saída e o estado fica no vvpost-site.json dela, não no "published" do vvpost.publish.json.
   */
  local?: boolean
}
