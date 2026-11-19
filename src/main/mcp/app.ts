import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import type { CentralAgentPolicy } from './central'
import { createMcpServer } from './server'
import type { McpWebhooks } from './tools'
import { DEFAULT_MCP_PORT, serveHttp } from './transports'

export interface RunningAppMcp {
  url: string
  port: number
  close(): Promise<void>
}

export interface AppMcpOptions {
  port?: number
  token?: string
  /** O servidor de webhooks do app, se ligado (pode ligar e desligar com o MCP rodando). */
  webhooks?: () => McpWebhooks | null
  /** A política Enterprise da sessão aberta liga a detecção de dados pessoais (lida a cada chamada). */
  piiPolicy?: () => boolean
  /** Política do agente do Control Plane (com a conta corporativa do app). */
  central?: CentralAgentPolicy
  log?: (line: string) => void
}

/**
 * Servidor MCP ligado pela barra de status do app: o mesmo servidor do
 * `out/main/mcp.js`, no transporte HTTP/SSE, servindo o workspace aberto. Tem
 * dispatcher e auth próprios: um token que o Quick Request já guardou em cache
 * nunca passou pelo Secret Sanitizer, então não pode ser reaproveitado pela IA.
 */
export async function startAppMcp(workspaceDir: string, options: AppMcpOptions = {}): Promise<RunningAppMcp> {
  // Proxy e TLS das configurações do app, mas sem o cookie jar: a sessão do usuário não vai para a IA.
  const client = await (await import('../http-settings')).httpClientConfig()
  const http = createHttpDispatcher({}, { ...client, cookies: null })
  const server = createMcpServer({
    workspaceDir,
    http,
    auth: createAuthEngine(),
    ...(options.webhooks && { webhooks: options.webhooks }),
    ...(options.piiPolicy && { piiPolicy: options.piiPolicy }),
    ...(options.central && { central: options.central }),
    surface: 'app',
    ...(options.log && { log: options.log })
  })
  try {
    const running = await serveHttp(server, {
      port: options.port ?? DEFAULT_MCP_PORT,
      ...(options.token && { token: options.token }),
      ...(options.log && { log: options.log })
    })
    return {
      url: running.url,
      port: running.port,
      close: () => running.close().then(() => http.close())
    }
  } catch (err) {
    await http.close()
    throw err
  }
}
