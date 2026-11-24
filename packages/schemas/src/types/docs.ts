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
    tokens?: DocsThemeTokens
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
 * Cores e fontes do PDF, da visualização e do site lidas do arquivo de tokens da marca (brand/*.tokens.json). Cada campo é o nome de um token; sem o campo, vale o nome de costume (color.primary, color.heading, color.text, font.body, font.heading). Uma cor ou fonte escrita no theme ganha do token.
 */
export interface DocsThemeTokens {
  /**
   * Token da cor de destaque. Padrão: color.primary, color.accent ou color.brand.
   */
  primary?: string
  /**
   * Token da cor dos títulos. Padrão: color.heading, senão a do texto.
   */
  heading?: string
  /**
   * Token da cor do texto. Padrão: color.text, color.fg ou color.foreground.
   */
  text?: string
  /**
   * Token (fontFamily) da fonte do texto. Padrão: font.body, font.text, font.ui ou font.sans.
   */
  font?: string
  /**
   * Token (fontFamily) da fonte dos títulos. Padrão: font.heading ou font.display, senão a do texto.
   */
  headingFont?: string
  /**
   * Modo do arquivo de tokens (ex.: light). Padrão: o valor de $value; o papel do PDF é branco, então use o modo claro quando o padrão for escuro.
   */
  mode?: string
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
