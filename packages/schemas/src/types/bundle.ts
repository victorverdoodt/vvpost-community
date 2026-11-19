/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

/**
 * Pacote de exportação do VVPost (*.vvpost.bundle.json): conectores, ambientes, fluxos e documentação de um projeto, ou de parte dele, num arquivo só, para importar em outro projeto. Nunca carrega valor de segredo: variáveis com isSecret vão com __REQUIRED_SECRET__ e ficam pendentes no projeto que importa. Cada documento segue o próprio schema (connector.json, environment.json, flow.json) e é validado com ele ao importar.
 */
export interface Bundle {
  /**
   * URL do schema do pacote. Obrigatória: é ela que identifica o arquivo como pacote do VVPost.
   */
  $schema: string
  /**
   * Nome do pacote, para quem importa.
   */
  name?: string
  description?: string
  /**
   * Quando o pacote foi gerado (ISO 8601).
   */
  exportedAt: string
  /**
   * Quem gerou, ex.: vvpost 0.1.0.
   */
  generator?: string
  /**
   * Conectores (connector.json), pai antes de filho.
   */
  connectors?: {}[]
  /**
   * Ambientes (environment.json), com os segredos como __REQUIRED_SECRET__.
   */
  environments?: {}[]
  /**
   * Fluxos do Flow Studio (flow.json).
   */
  flows?: {}[]
  /**
   * Documentação em Markdown por id de conector (o arquivo .connector.vvpost.md ao lado do conector).
   */
  docs?: {
    [k: string]: string
  }
}
