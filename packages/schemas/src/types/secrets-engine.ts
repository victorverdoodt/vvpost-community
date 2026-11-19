/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

/**
 * localMock (Community) resolve de um arquivo local; enterpriseProxy (Enterprise) busca na nuvem via SSO e guarda só em RAM.
 */
export type SecretsEngineMode = 'localMock' | 'enterpriseProxy'
export type SecretsProvider = 'azureKeyVault' | 'awsSecretsManager' | 'hashicorpVault'

/**
 * Configuração do Secret Manager Engine em .vvpost/secrets-engine.json.
 */
export interface SecretsEngineConfig {
  $schema?: string
  /**
   * Porta local em que o engine escuta.
   */
  port?: number
  mode: SecretsEngineMode
  localMock?: LocalMockConfig
  enterpriseProxy?: EnterpriseProxyConfig
}
export interface LocalMockConfig {
  /**
   * Id do ambiente (environment.id) cujos segredos são servidos.
   */
  activeEnvironment: string
  /**
   * Caminho relativo à raiz do workspace de um arquivo JSON com os valores reais, em texto puro, no lugar do cofre local cifrado. Precisa estar no .gitignore. Sem o campo, vale o cofre local.
   */
  storageFile?: string
}
export interface EnterpriseProxyConfig {
  provider: SecretsProvider
  /**
   * URL HTTPS do cofre na nuvem.
   */
  upstreamVaultUrl: string
  /**
   * Tempo que um segredo fica no cache em memória. 0 desliga o cache.
   */
  cacheTtlSeconds?: number
  /**
   * Zero-Disk Footprint: segredos nunca são gravados em disco. Só pode ser true.
   */
  enforceMemoryOnly?: true
}
