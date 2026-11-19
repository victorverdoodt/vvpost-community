/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

/**
 * vvpost.project.json: marca uma subpasta do workspace como um projeto. Os conectores, fluxos e ambientes da pasta são do projeto; o que fica fora de qualquer projeto é o Compartilhado do workspace, visível em todos.
 */
export interface Project {
  $schema?: string
  /**
   * Identificador do projeto, usado nas referências entre projetos ("extends": "<projeto>:<id>"), no CLI (--project) e no MCP (project).
   */
  id: string
  name: string
  description?: string
  /**
   * Projeto de referência, só para leitura: o catálogo vem de outro lugar e não de arquivos nesta pasta. Vale a primeira fonte que existir: o workspace do VVPost em "workspace" (o catálogo inteiro, com fluxos e documentação) ou a spec OpenAPI em "openapi" (rotas e schemas). Os caminhos são relativos a esta pasta. Serve para o front e o app consultarem o catálogo da API de outro repositório pelo MCP.
   */
  reference?: {
    /**
     * Pasta do workspace do VVPost de outro repositório (ex.: "../../../api/vvpost"), quando ele está na mesma máquina.
     */
    workspace?: string
    /**
     * Arquivo da spec OpenAPI (JSON ou YAML), ex.: a cópia da spec da API que o repositório já mantém.
     */
    openapi?: string
  }
}
