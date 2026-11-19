/** Problema na configuração do workspace (conector, ambiente, variável): o usuário corrige nos arquivos. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** O fluxo de autenticação rodou e falhou (credencial recusada, resposta sem token...). */
export class AuthError extends Error {
  override name = 'AuthError'
}

/** A política de quem dispara (MCP, plugin) recusou a requisição: método, origem, ambiente ou limite. */
export class PolicyError extends Error {
  override name = 'PolicyError'
}
