/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

/**
 * Dados pessoais em .vvpost/privacy.json. No que vai ao agente de IA, os campos marcados com x-sensitive nos schemas do projeto são mascarados sempre, e agent liga a detecção por padrão para os campos não marcados (vale o mais forte entre este arquivo, o --pii-detect do servidor MCP e a política Enterprise). people liga o mesmo mascaramento também no que o app e o CLI mostram a pessoas.
 */
export interface PrivacyConfig {
  /**
   * URL do schema, usada por editores para autocomplete.
   */
  $schema?: string
  /**
   * O que vai ao agente de IA pelo MCP.
   */
  agent?: {
    /**
     * Detecção por padrão nos campos não marcados: true liga todos os tipos (cpf, cnpj, email, phone, card); uma lista liga só esses.
     */
    detect?: boolean | ('cpf' | 'cnpj' | 'email' | 'phone' | 'card')[]
  }
  /**
   * O que o app e o CLI mostram a pessoas: respostas no Quick Request, cenários, fluxos, realtime, webhooks, histórico, terminal e relatórios do vvpost run. Os valores reais continuam indo para a rede.
   */
  people?: {
    /**
     * true: mascara os campos marcados com x-sensitive também para pessoas. A política da organização pode ligar; nada aqui desliga o que ela ligou.
     */
    mask?: boolean
    /**
     * Com mask: detecção por padrão nos campos não marcados, como em agent.detect.
     */
    detect?: boolean | ('cpf' | 'cnpj' | 'email' | 'phone' | 'card')[]
  }
}
