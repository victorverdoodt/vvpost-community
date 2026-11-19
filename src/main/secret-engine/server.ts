import type { Socket } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import type { SecretsEngineMode } from '@vvpost/schemas'
import { registerAwsSecretsManager } from './aws'
import { registerAzureKeyVault } from './azure'
import { loadEnterpriseModule, withAudit, type SecretAuditSink, type SecretBackend } from './backend'
import { NoEnvironmentError, resolveEngineConfig, SecretSource, type ResolvedEngineConfig } from './source'
import { registerHashicorpVault } from './vault'
import { assertFeature } from '@vvpost/core/policy/features'

export interface RunningEngine {
  port: number
  mode: SecretsEngineMode
  /** Ambiente servido; null se o workspace ainda não tem nenhum. */
  environment: string | null
  close(): Promise<void>
}

export interface StartOptions {
  /** Sobrepõe a porta da configuração (0 escolhe uma livre; usado em testes e no benchmark). */
  port?: number
  /** Trilha de auditoria extra, chamada em qualquer modo (além da do módulo Enterprise). */
  audit?: SecretAuditSink
  /** Repassado ao módulo Enterprise para o login SSO no navegador. */
  openExternal?: (url: string) => Promise<void>
  /** Modo escolhido na barra de status, no lugar do que está no arquivo. */
  mode?: SecretsEngineMode
}

/**
 * Secret Manager Engine: um Fastify em 127.0.0.1 que responde às APIs
 * do Azure Key Vault, AWS Secrets Manager e HashiCorp Vault. No modo localMock os
 * segredos vêm do cofre local cifrado do workspace; no enterpriseProxy, do
 * backend do módulo Enterprise (backend.ts). As três APIs convivem na mesma porta
 * porque os caminhos não colidem: /secrets (Azure), POST / com X-Amz-Target (AWS)
 * e /v1 (Vault).
 */
export async function startSecretEngine(dir: string, options: StartOptions = {}): Promise<RunningEngine> {
  const config = await resolveEngineConfig(dir, options.mode ? { mode: options.mode } : {})
  // O mock emula as APIs dos cofres com valores locais; o Cloud Proxy segue a política de segredos.
  if (config.mode !== 'enterpriseProxy') assertFeature('secretEmulator')
  const { backend, audit } = await openBackend(dir, config, options)
  try {
    const app = buildApp(backend, { mode: config.mode, audit })
    await app.listen({ host: '127.0.0.1', port: options.port ?? config.port })
    const address = app.server.address()
    return {
      port: typeof address === 'object' && address ? address.port : config.port,
      mode: config.mode,
      environment: backend.environment,
      close: async () => {
        await app.close()
        await backend.close?.()
      }
    }
  } catch (err) {
    await backend.close?.().catch(() => undefined)
    throw err
  }
}

async function openBackend(
  dir: string,
  config: ResolvedEngineConfig,
  options: StartOptions
): Promise<{ backend: SecretBackend; audit?: SecretAuditSink }> {
  if (config.mode !== 'enterpriseProxy' || !config.enterpriseProxy) {
    return { backend: new SecretSource(dir, config), ...(options.audit ? { audit: options.audit } : {}) }
  }
  const mod = await loadEnterpriseModule()
  const backend = await mod.createBackend({
    workspaceDir: dir,
    config: config.enterpriseProxy,
    ...(options.openExternal ? { openExternal: options.openExternal } : {})
  })
  const extra = options.audit
  const audit: SecretAuditSink = extra
    ? async (event) => {
        await mod.audit(event)
        await extra(event)
      }
    : mod.audit
  return { backend, audit }
}

export interface AppOptions {
  mode?: SecretsEngineMode
  /** Com ela, cada operação de cada API emulada vira um evento na trilha (withAudit). */
  audit?: SecretAuditSink
}

export function buildApp(source: SecretBackend, options: AppOptions = {}): FastifyInstance {
  const app: FastifyInstance = Fastify({
    logger: false,
    routerOptions: { ignoreTrailingSlash: true },
    bodyLimit: 1024 * 1024,
    // Desligar o engine não espera clientes com keep-alive aberto.
    forceCloseConnections: true,
    clientErrorHandler: (err, socket) => onClientError(app, err as unknown as ClientError, socket)
  })

  app.addHook('onRequest', async (req, reply) => {
    // Só clientes locais e só SDKs: um navegador sempre manda Origin em requisições
    // de outra origem, então isso barra páginas web lendo ou gravando segredos, e o
    // Host fixo em localhost barra DNS rebinding.
    if (req.headers.origin !== undefined || !isLoopbackHost(req.hostname)) {
      reply.code(403).send({ error: 'O Secret Engine do VVPost só aceita clientes locais.' })
      return reply
    }
  })

  // SDKs nem sempre mandam Content-Type (o cliente Go do Vault, por exemplo). Com
  // Origin barrado acima, aceitar qualquer tipo não abre CSRF.
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined)
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }))
    }
  })

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof NoEnvironmentError ? 409 : (err.statusCode ?? 500)
    reply.code(status).send({ error: err.message })
  })

  app.get('/msi/token', async (req) => managedIdentityToken(String((req.query as { resource?: string }).resource ?? '')))

  const { audit, mode = 'localMock' } = options
  const via = (api: 'azureKeyVault' | 'awsSecretsManager' | 'hashicorpVault') => (audit ? withAudit(source, audit, mode, api) : source)
  registerAzureKeyVault(app, via('azureKeyVault'))
  registerAwsSecretsManager(app, via('awsSecretsManager'))
  registerHashicorpVault(app, via('hashicorpVault'))
  return app
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/:\d+$/, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
}

/**
 * Token falso no formato do endpoint de identidade gerenciada do App Service, para
 * a cadeia do DefaultAzureCredential funcionar sem login (IDENTITY_ENDPOINT
 * apontando para /msi/token e IDENTITY_HEADER com qualquer valor).
 */
function managedIdentityToken(resource: string) {
  const expiresOn = Math.floor(Date.now() / 1000) + 24 * 3600
  return {
    access_token: 'vvpost-mock-token',
    expires_on: String(expiresOn),
    expires_in: String(24 * 3600),
    resource,
    token_type: 'Bearer'
  }
}

/**
 * O parser HTTP do Node recusa métodos que não conhece, e o Vault usa LIST para
 * listar caminhos (hvac, node-vault). A requisição recusada chega aqui crua: ela é
 * reexecutada como GET ?list=true, que o Vault trata igual, e a resposta é escrita
 * direto no socket, fechando a conexão.
 */
type ClientError = Error & { code?: string; rawPacket?: Buffer }

function onClientError(app: FastifyInstance, err: ClientError, socket: Socket): void {
  const raw = err.rawPacket?.toString('latin1')
  if (err.code === 'HPE_INVALID_METHOD' && raw?.startsWith('LIST ') && socket.writable) {
    void replayList(app, raw, socket)
    return
  }
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  else socket.destroy()
}

async function replayList(app: FastifyInstance, raw: string, socket: Socket): Promise<void> {
  try {
    const [head = ''] = raw.split('\r\n\r\n')
    const [requestLine = '', ...headerLines] = head.split('\r\n')
    const target = requestLine.split(' ')[1] ?? '/'
    const headers: Record<string, string> = {}
    for (const line of headerLines) {
      const colon = line.indexOf(':')
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }
    delete headers['content-length']
    delete headers['transfer-encoding']
    const url = `${target}${target.includes('?') ? '&' : '?'}list=true`
    const res = await app.inject({ method: 'GET', url, headers })
    const body = res.rawPayload
    const out = [
      `HTTP/1.1 ${res.statusCode} ${res.statusMessage}`,
      `Content-Type: ${String(res.headers['content-type'] ?? 'application/json')}`,
      `Content-Length: ${body.length}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n')
    socket.end(Buffer.concat([Buffer.from(out, 'latin1'), body]))
  } catch {
    socket.destroy()
  }
}
