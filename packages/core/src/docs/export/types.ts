import type { PublishBundle } from '../publish/types'

/** Um arquivo que o exportador quer na pasta de saída. */
export interface ExportFile {
  /** Caminho relativo à pasta de saída, com "/" (ex.: assets/site.css). */
  path: string
  data: string | Uint8Array
  /**
   * Chave do nó do pacote que este arquivo mostra: o arquivo de uma página só muda com a
   * confirmação da pessoa (como uma página no destino de um publicador).
   */
  page?: string
}

export interface ChangelogRef {
  key: string
  title: string
}

/** O que mudou numa exportação, comparado com a anterior (da mesma pasta). */
export interface ChangelogEntry {
  at: string
  /** Nome da versão (vvpost docs export --label), quando houver. */
  label?: string
  /** A primeira exportação: sem a anterior para comparar. */
  initial?: boolean
  pages: { added: ChangelogRef[]; changed: ChangelogRef[]; removed: ChangelogRef[] }
  endpoints: { added: ChangelogRef[]; changed: ChangelogRef[]; removed: ChangelogRef[] }
}

/** vvpost-site.json: o estado da pasta exportada, para a próxima exportação comparar. */
export interface SiteManifest {
  generator: 'VVPost'
  version: 1
  /** O exportador que gerou a pasta (html, ou o id do exportador de um plugin). */
  exporter: string
  project: string
  target: string
  generatedAt: string
  /** Páginas e pastas pela chave do nó: o hash do conteúdo e o arquivo de cada página. */
  pages: Record<string, { kind: 'folder' | 'page'; title: string; hash: string; file?: string }>
  /** Endpoints pela chave <conector>/<endpoint>: o hash da referência. */
  endpoints: Record<string, { title: string; hash: string }>
  /** SHA-256 de cada arquivo gravado (menos este): um arquivo diferente foi editado à mão. */
  files: Record<string, string>
  /** Da exportação mais nova para a mais antiga. */
  changelog: ChangelogEntry[]
}

export interface ExportContext {
  /** O histórico já com a entrada desta exportação (vazio com site.changelog false). */
  changelog: ChangelogEntry[]
  /** O manifesto da exportação anterior na mesma pasta, se houver. */
  previous: SiteManifest | null
  /**
   * O mermaid.min.js para desenhar no navegador os diagramas que chegaram sem imagem (o CLI e o MCP
   * sem o executável do VVPost). Só o exportador html usa; não vai para os plugins.
   */
  mermaidScript?: string
  signal?: AbortSignal
}

/**
 * Exportador da documentação para uma pasta: recebe o pacote neutro (o mesmo dos
 * publicadores, sem segredos) e devolve os arquivos. Quem grava é o VVPost, só dentro da pasta
 * de saída. O html vem com o core; outros formatos vêm de plugins (contributes.exporters).
 */
export interface DocsExporter {
  /** O provider do vvpost.publish.json. */
  id: string
  title: string
  description?: string
  render(bundle: PublishBundle, ctx: ExportContext): Promise<ExportFile[]>
}
