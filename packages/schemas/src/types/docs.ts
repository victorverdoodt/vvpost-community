/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

/**
 * Modelo da documentação do projeto, em vvpost.docs.json na raiz do workspace: o documento-fonte em Markdown (com trechos gerados e de outras docs) e o formato aplicado à visualização e ao PDF de qualquer nível (logo, capa, cabeçalho, rodapé, cores, página).
 */
export interface DocsConfig {
  /**
   * URL do schema, usada por editores para autocomplete.
   */
  $schema?: string
  /**
   * Documento-fonte em Markdown, relativo ao workspace. Padrão: docs/projeto.md.
   */
  source?: string
  /**
   * Título do documento do projeto. Padrão: "Documentação de <projeto>".
   */
  title?: string
  subtitle?: string
  /**
   * Versão do documento, na capa e em {{version}}.
   */
  version?: string
  /**
   * Organização ou equipe, na capa e em {{organization}}.
   */
  organization?: string
  /**
   * Imagem do logo (PNG, JPEG, SVG, WebP ou GIF, até 1 MB), relativa ao workspace.
   */
  logo?: string
  /**
   * Capa do documento do projeto, com logo, título, subtítulo, organização, versão e data.
   */
  cover?: boolean
  /**
   * Sumário no início do documento do projeto.
   */
  toc?: boolean
  /**
   * Numera as seções (1, 1.1, 1.1.1) no documento do projeto.
   */
  numberHeadings?: boolean
  /**
   * Nome do modelo de documentação aplicado por último (ex.: C4, arc42), mostrado no estilo da documentação. Não muda o documento.
   */
  methodology?: string
  theme?: {
    /**
     * Cor de destaque: linhas dos títulos, citações e capa.
     */
    primary?: string
    /**
     * Cor dos títulos.
     */
    heading?: string
    /**
     * Cor do texto.
     */
    text?: string
    /**
     * Fonte do texto.
     */
    font?: 'sans' | 'serif' | 'mono'
    /**
     * Fonte dos títulos. Padrão: a do texto.
     */
    headingFont?: 'sans' | 'serif' | 'mono'
  }
  page?: {
    size?: 'A4' | 'Letter' | 'Legal'
    orientation?: 'portrait' | 'landscape'
    margins?: 'narrow' | 'normal' | 'wide'
  }
  header?: DocsBand
  footer?: DocsBand
}
/**
 * Cabeçalho ou rodapé de cada página (sem rodapé no arquivo: título à esquerda e página à direita). Texto à esquerda, ao centro e à direita, com {{title}}, {{subtitle}}, {{project}}, {{version}}, {{organization}}, {{date}}, {{page}} e {{pages}}.
 */
export interface DocsBand {
  left?: string
  center?: string
  right?: string
  /**
   * Onde o logo entra na faixa.
   */
  logo?: 'left' | 'right' | 'none'
}
