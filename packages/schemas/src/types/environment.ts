/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

export type VariableType = 'string' | 'number' | 'boolean'

/**
 * Ambiente versionado no Git. Variáveis com isSecret: true são commitadas com o valor __REQUIRED_SECRET__ e o valor real fica no cofre local cifrado, fora do projeto.
 */
export interface Environment {
  $schema?: string
  /**
   * Identificador do ambiente, ex.: env.development. Referenciado por secrets-engine.localMock.activeEnvironment.
   */
  id: string
  name: string
  description?: string
  /**
   * Ambiente protegido (produção): a IA pelo MCP e os hooks de webhook só montam o plano e validam, sem disparar, e todo disparo pelo app pede confirmação. Sem o campo, vale true quando o id ou o nome parecem de produção (prod, prd, production, producao, produção, live); false libera explicitamente.
   */
  protected?: boolean
  variables: {
    [k: string]: EnvironmentVariable
  }
}
export interface EnvironmentVariable {
  type: VariableType
  /**
   * Valor da variável. Para segredos, sempre o template __REQUIRED_SECRET__.
   */
  value: string | number | boolean
  isSecret?: boolean
  description?: string
  /**
   * Texto de ajuda mostrado no wizard de onboarding ao preencher o valor.
   */
  placeholder?: string
}
