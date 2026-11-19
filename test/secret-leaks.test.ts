import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { main as vvpostCli } from '../src/main/cli'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { openHistoryStore } from '../src/main/history/store'
import { createSecretSanitizer } from '@vvpost/core/sanitizer'
import { preparePostmanImport, previewImport, writeImport } from '../src/main/importers'
import { createMcpServer } from '../src/main/mcp/server'
import { applyProjectOps } from '../src/main/project'
import * as workspace from '../src/main/workspace'
import { encodedForms, findSecretLeaks } from '../src/main/workspace/leak-guard'
import { SECRETS_FILE } from '../src/main/workspace/vault'
import { readVault } from '@vvpost/core/vault'
import { hookInfo, loadWebhooksConfig } from '../src/main/webhooks/config'
import { startWebhookServer } from '../src/main/webhooks/server'
import type { HttpRequestInput, HttpResult } from '@shared/ipc'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { protectWorkspace } from '@vvpost/core/protect'
import { literalFlowSecrets } from '@vvpost/core/flows/workspace'
import { requestToFlow } from '@vvpost/core/flows/simple-flow'
import { openRealtime, type RealtimeConnection, type RealtimeEvent, type RealtimeOpenInput } from '@vvpost/core/realtime'
import { startRealtimeServer } from './helpers/realtime-server.mjs'

// Nenhum segredo sai em exports, logs ou commits. Os
// valores são gerados a cada execução e procurados, em todas as codificações, em
// tudo o que cada superfície escreve ou devolve.

const canary = (prefix: string) => `${prefix}${randomBytes(8).toString('hex')}`
const CLIENT_SECRET = canary('cs-')
const API_TOKEN = canary('tok-')
const PASSWORD = `${canary('pw-')} /+=`
const POSTMAN_TOKEN = canary('pm-')
const POSTMAN_SECRET = canary('pmenv-')
const ACCESS_TOKEN = canary('at-')
const SCRIPT_TOKEN = canary('st-')
const ALL = [CLIENT_SECRET, API_TOKEN, PASSWORD, POSTMAN_TOKEN, POSTMAN_SECRET, ACCESS_TOKEN, SCRIPT_TOKEN]

/** O texto não tem nenhum segredo em nenhuma forma. */
function expectClean(text: string, where: string, secrets = ALL): void {
  for (const secret of secrets) {
    for (const form of encodedForms(secret)) expect(text.includes(form), `${where} contém ${secret}`).toBe(false)
  }
}

/** Todo arquivo da pasta (menos o vault e o .git), concatenado. */
function filesOf(dir: string, skip: string[] = [SECRETS_FILE]): string {
  const out: string[] = []
  const visit = (path: string) => {
    const rel = relative(dir, path).split('\\').join('/')
    if (rel === '.git' || skip.includes(rel)) return
    if (statSync(path).isDirectory()) return readdirSync(path).forEach((n) => visit(join(path, n)))
    out.push(`--- ${rel}\n${readFileSync(path, 'latin1')}`)
  }
  visit(dir)
  return out.join('\n')
}

const dirs: string[] = []
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
const write = (dir: string, path: string, data: unknown) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
}
/** Mensagem do erro com que a promessa falha. */
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('esperava falha')
    },
    (e: Error) => e.message
  )
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** Workspace com segredos digitados em texto puro no ambiente, como um usuário faria. */
function seedWorkspace(dir: string): void {
  write(dir, 'environments/dev.env.json', {
    id: 'env.dev',
    name: 'Dev',
    variables: {
      BASE_URL: { type: 'string', value: 'https://api.exemplo.com' },
      CLIENT_SECRET: { type: 'string', value: CLIENT_SECRET, isSecret: true },
      API_TOKEN: { type: 'string', value: API_TOKEN, isSecret: true },
      PASSWORD: { type: 'string', value: PASSWORD, isSecret: true }
    }
  })
  write(dir, 'connectors/api.connector.vvpost.json', {
    $schema: 'https://vvpost.dev/schemas/v1/connector.json',
    id: 'api',
    name: 'API',
    version: '1.0.0',
    config: {
      baseUrl: '{{BASE_URL}}',
      auth: { type: 'oauth2', grantType: 'password', tokenUrl: '/token', clientId: 'app', clientSecret: '{{CLIENT_SECRET}}', username: 'ana', password: '{{PASSWORD}}' }
    },
    endpoints: [
      {
        id: 'me',
        name: 'Eu',
        method: 'GET',
        path: '/me',
        // capture guarda o eco (com o token injetado) para um cenário seguinte: é outra saída a conferir.
        scenarios: [
          { id: 'ok', name: 'OK', capture: { echoed: 'body.echo' }, assertions: [{ target: 'status', operator: 'equals', expected: 200 }] },
          {
            id: 'chained',
            name: 'Encadeado',
            dependsOn: ['me/ok'],
            overrides: { query: { from: '{{$capture.echoed}}' } },
            assertions: [{ target: 'body.url', operator: 'exists' }]
          }
        ]
      }
    ]
  })
}

/** Toda saída de console e de stderr durante o teste. */
let logs: string[]
beforeEach(() => {
  logs = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')))
  }
  const write = process.stderr.write.bind(process.stderr)
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    logs.push(String(chunk))
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write)
})
afterEach(() => {
  expectClean(logs.join('\n'), 'console/stderr')
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
beforeAll(() => {
  process.env['GIT_AUTHOR_NAME'] = process.env['GIT_COMMITTER_NAME'] = 'VVPost Teste'
  process.env['GIT_AUTHOR_EMAIL'] = process.env['GIT_COMMITTER_EMAIL'] = 'teste@vvpost.dev'
})

/** API falsa: o token endpoint devolve ACCESS_TOKEN, e /me ecoa o que recebeu (headers e query). */
function fakeApi() {
  return {
    cancel() {},
    async send(input: HttpRequestInput): Promise<HttpResult> {
      const body = input.url.endsWith('/token')
        ? JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 3600 })
        : JSON.stringify({ echo: input.headers, url: input.url })
      return {
        ok: true,
        response: {
          status: 200,
          statusText: 'OK',
          headers: [{ name: 'set-cookie', value: `sid=${ACCESS_TOKEN}` }],
          body,
          sizeBytes: body.length,
          truncated: false,
          timings: { ttfbMs: 1, downloadMs: 0, totalMs: 1 }
        }
      }
    }
  }
}

describe('commits', () => {
  it('segredo digitado no ambiente nunca entra em nenhum objeto do Git', async () => {
    const dir = tmp('vvpost-leak-git-')
    sh(dir, 'init', '-b', 'main')
    seedWorkspace(dir)
    const outcome = await workspace.commitPaths(dir, 'workspace', ['environments/dev.env.json', 'connectors/api.connector.vvpost.json'])
    expect(outcome.redacted).toEqual([{ file: 'environments/dev.env.json', variables: ['CLIENT_SECRET', 'API_TOKEN', 'PASSWORD'] }])
    const objects = sh(dir, 'cat-file', '--batch-all-objects', '--batch')
    expectClean(objects, 'objetos do Git')
    expect(sh(dir, 'log', '--name-only', '--format=')).not.toContain(SECRETS_FILE)
  })

  it('valor do vault colado em qualquer arquivo bloqueia o commit, sem mostrar o valor', async () => {
    const dir = tmp('vvpost-leak-guard-')
    sh(dir, 'init', '-b', 'main')
    seedWorkspace(dir)
    await workspace.commitPaths(dir, 'base', ['environments/dev.env.json', 'connectors/api.connector.vvpost.json'])
    // Em base64 (um Basic montado à mão), num fluxo, e em URL-encode num README.
    write(dir, 'flows/login.flow.vvpost.json', { note: Buffer.from(API_TOKEN).toString('base64') })
    write(dir, 'README.md', `curl -d "password=${encodeURIComponent(PASSWORD)}"`)
    const commit = workspace.commitPaths(dir, 'vazamento', ['flows/login.flow.vvpost.json', 'README.md'])
    await expect(commit).rejects.toMatchObject({ code: 'SECRET_LEAK' })
    const message = await rejection(commit)
    expect(message).toContain('flows/login.flow.vvpost.json: o valor do segredo API_TOKEN do ambiente env.dev')
    expect(message).toContain('README.md: o valor do segredo PASSWORD do ambiente env.dev')
    expectClean(message, 'mensagem de erro')
    expect(sh(dir, 'log', '--format=%s')).not.toContain('vazamento')
  })

  it('credencial literal no conector e chave privada também bloqueiam', async () => {
    const dir = tmp('vvpost-leak-literal-')
    sh(dir, 'init', '-b', 'main')
    write(dir, 'connectors/x.connector.vvpost.json', {
      id: 'x',
      name: 'X',
      version: '1.0.0',
      config: { baseUrl: 'https://x.exemplo.com', auth: { type: 'bearer', token: canary('lit-') } }
    })
    const label = ['PRIVATE', 'KEY'].join(' ')
    write(dir, 'certs/client.key', `-----BEGIN ${label}-----\n${randomBytes(32).toString('base64')}\n-----END ${label}-----\n`)
    const message = await rejection(workspace.commitPaths(dir, 'x', ['connectors/x.connector.vvpost.json', 'certs/client.key']))
    expect(message).toContain('connectors/x.connector.vvpost.json: credencial literal em auth.token')
    expect(message).toContain('certs/client.key: uma chave privada PEM')
  })

  it('requisição salva como fluxo (Ctrl+S): credencial digitada no header é recusada; {{VAR}} e $nodes passam', async () => {
    const flow = requestToFlow(
      { method: 'GET', url: '/me', headers: [{ name: 'Authorization', value: 'Bearer abc123def456' }, { name: 'X-Api-Key', value: '{{API_KEY}}' }] },
      { id: 'flow.me', name: 'Me' }
    )
    expect(literalFlowSecrets(flow)).toEqual(['header Authorization do nó Requisicao'])
    const templated = requestToFlow({ method: 'GET', url: '/me', headers: [{ name: 'Authorization', value: 'Bearer {{ $nodes.Login.data.token }}' }] }, { id: 'f', name: 'F' })
    expect(literalFlowSecrets(templated)).toEqual([])
    // O valor do vault colado no fluxo também é achado antes de gravar.
    const vault = { 'env.dev': { TOKEN: 'valor-do-vault-123' } }
    const pasted = requestToFlow({ method: 'GET', url: '/me?t=valor-do-vault-123', headers: [] }, { id: 'f', name: 'F' })
    expect(await findSecretLeaks('/nao-usado', [{ path: 'flows/f.flow.vvpost.json', content: JSON.stringify(pasted) }], vault)).toHaveLength(1)
  })

  it('fluxo-base com credencial literal (auth, nó OAuth2, header) é recusado no commit e na camada de escrita', async () => {
    const base = {
      id: 'api',
      name: 'API',
      defaults: { baseUrl: 'https://api.exemplo.com', headers: { 'X-Api-Key': 'chave-literal-123' } },
      nodes: [
        {
          id: 'oauth2',
          name: 'OAuth2',
          type: 'oauth2',
          oauth2: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: '{{AUTH_URL}}', clientId: 'app', clientSecret: 'segredo-literal-456' }
        }
      ],
      edges: [],
      scenarios: [{ id: 'ok', name: 'OK', overrides: { headers: { Authorization: 'Bearer abc123def456' } }, assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
    }
    expect(literalFlowSecrets(base as never)).toEqual(['header Authorization do cenário OK', 'auth.clientSecret da base', 'headers.X-Api-Key da base'])
    const leaks = await findSecretLeaks('/nao-usado', [{ path: 'flows/api/api.flow.vvpost.json', content: JSON.stringify(base) }], {})
    expect(leaks.map((l) => l.reason)).toEqual([
      'credencial literal em header Authorization do cenário OK',
      'credencial literal em auth.clientSecret da base',
      'credencial literal em headers.X-Api-Key da base'
    ])
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-flow-literal-'))
    try {
      const { scenarios: _, ...noScenarios } = base
      const r = await applyProjectOps(dir, [{ op: 'upsertFlow', flow: noScenarios as never }])
      expect(r.ok).toBe(false)
      expect(r.errors[0]!.message).toBe(
        'credencial escrita direto no fluxo "api" (auth.clientSecret da base, headers.X-Api-Key da base); use uma variável {{NOME}} de um ambiente, marcada como segredo'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('valores curtos do vault não são procurados (evita bloquear por "true" ou "8080")', async () => {
    const leaks = await findSecretLeaks('/nada', [{ path: 'a.json', content: '{"port": 8080}' }], { 'env.dev': { PORT: '8080' } })
    expect(leaks).toEqual([])
  })

  it('resolução de conflito com o segredo colado é recusada antes de entrar no index', async () => {
    const dir = tmp('vvpost-leak-merge-')
    sh(dir, 'init', '-b', 'main')
    seedWorkspace(dir)
    await workspace.commitPaths(dir, 'base', ['environments/dev.env.json', 'connectors/api.connector.vvpost.json'])
    write(dir, 'notes.txt', 'base\n')
    sh(dir, 'add', 'notes.txt')
    sh(dir, 'commit', '-m', 'notes')
    sh(dir, 'checkout', '-b', 'outra')
    write(dir, 'notes.txt', 'deles\n')
    sh(dir, 'commit', '-am', 'deles')
    sh(dir, 'checkout', 'main')
    write(dir, 'notes.txt', 'meus\n')
    sh(dir, 'commit', '-am', 'meus')
    try {
      sh(dir, 'merge', 'outra')
    } catch {
      // conflito esperado
    }
    const resolved = workspace.resolveConflict(dir, 'notes.txt', { content: `token: ${API_TOKEN}\n` })
    await expect(resolved).rejects.toMatchObject({ code: 'SECRET_LEAK' })
    expect(sh(dir, 'diff', '--name-only', '--diff-filter=U')).toContain('notes.txt')
  })
})

describe('exports', () => {
  it('import do Postman: segredos só no vault; os arquivos gravados e a prévia não têm nenhum', async () => {
    const src = tmp('vvpost-leak-pm-src-')
    write(src, 'api.postman_collection.json', {
      info: { name: 'API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: POSTMAN_TOKEN, type: 'string' }] },
      item: [
        {
          name: 'Eu',
          // Scripts viram arquivos do workspace (fase 13): um segredo escrito neles também vai só para o vault.
          event: [
            { listen: 'prerequest', script: { exec: [`pm.environment.set('api_token', '${SCRIPT_TOKEN}')`] } },
            { listen: 'test', script: { exec: [`pm.test('auth', () => pm.expect(pm.request.headers.get('Authorization')).to.equal('Bearer ${POSTMAN_TOKEN}'))`] } }
          ],
          request: { method: 'GET', url: 'https://api.exemplo.com/me' }
        }
      ]
    })
    write(src, 'dev.postman_environment.json', {
      name: 'Dev',
      values: [
        { key: 'client_secret', value: POSTMAN_SECRET, type: 'secret', enabled: true },
        { key: 'host', value: 'api.exemplo.com', type: 'default', enabled: true }
      ]
    })
    const prepared = await preparePostmanImport([join(src, 'api.postman_collection.json'), join(src, 'dev.postman_environment.json')])
    const dir = tmp('vvpost-leak-pm-ws-')
    const target = { dir, isWorkspace: false }
    const preview = await previewImport(prepared, target)
    expect(preview.canWrite).toBe(true)
    expectClean(JSON.stringify(preview), 'prévia do import (vai para a interface)')

    const outcome = await writeImport(prepared, target)
    expect(outcome.written.length).toBeGreaterThan(0)
    expectClean(filesOf(dir), 'arquivos do import')
    // Os valores existem, mas só no vault.
    const vault = JSON.stringify(await readVault(dir))
    expect(vault).toContain(POSTMAN_TOKEN)
    expect(vault).toContain(POSTMAN_SECRET)
    expect(vault).toContain(SCRIPT_TOKEN)
  })

  it('import de OpenAPI: exemplos com cara de credencial não vão para os arquivos nem para a prévia', async () => {
    const src = tmp('vvpost-leak-oas-src-')
    write(src, 'api.json', {
      openapi: '3.0.3',
      info: { title: 'API', version: '1.0.0' },
      servers: [{ url: 'https://api.exemplo.com' }],
      paths: {
        '/login': {
          post: {
            operationId: 'login',
            parameters: [
              { name: 'X-Api-Key', in: 'header', required: true, example: API_TOKEN },
              { name: 'access_token', in: 'query', example: ACCESS_TOKEN }
            ],
            requestBody: { content: { 'application/json': { example: { user: 'ana', password: PASSWORD, nested: { client_secret: CLIENT_SECRET } } } } },
            // A resposta documentada vira exemplo do mock: o token do exemplo também não vai para o arquivo.
            responses: { '200': { description: 'ok', content: { 'application/json': { example: { access_token: ACCESS_TOKEN, user: 'ana' } } } } }
          }
        },
        '/form': {
          post: {
            operationId: 'form',
            requestBody: {
              content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { api_key: { type: 'string', example: POSTMAN_TOKEN } } } } }
            },
            responses: {}
          }
        }
      }
    })
    const { prepareImport } = await import('../src/main/importers')
    const prepared = await prepareImport([join(src, 'api.json')])
    const dir = tmp('vvpost-leak-oas-ws-')
    const target = { dir, isWorkspace: false }
    const preview = await previewImport(prepared, target)
    expect(preview.canWrite).toBe(true)
    expectClean(JSON.stringify(preview), 'prévia do import de OpenAPI')
    await writeImport(prepared, target)
    const files = filesOf(dir)
    expectClean(files, 'arquivos do import de OpenAPI')
    expect(files).toContain('{{API_X_API_KEY}}')
    expect(files).toContain('{{API_PASSWORD}}')
    expect(files).toContain('"examples"')
  })

  it('exportar para o Postman e OpenAPI (app, MCP e CLI): segredos digitados e do vault não saem', async () => {
    const dir = tmp('vvpost-leak-foreign-export-')
    seedWorkspace(dir)
    // Um ambiente com os segredos digitados no arquivo (inválido) e outro com eles no vault.
    write(dir, 'environments/prod.env.json', {
      id: 'env.prod',
      name: 'Prod',
      variables: {
        BASE_URL: { type: 'string', value: 'https://api.exemplo.com' },
        CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
        PASSWORD: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    })
    write(dir, SECRETS_FILE, { 'env.prod': { CLIENT_SECRET: POSTMAN_SECRET, PASSWORD: POSTMAN_TOKEN } })
    const { exportAs } = await import('../src/main/bundle/export')
    for (const format of ['postman', 'openapi'] as const) {
      const result = await exportAs(dir, { format })
      expectClean(result.files.map((f) => f.text).join('\n') + JSON.stringify(result.warnings), `exportação ${format}`)
    }
    const server = createMcpServer({ workspaceDir: dir, http: fakeApi(), auth: createAuthEngine() })
    for (const format of ['postman', 'openapi']) {
      const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export_project', arguments: { format } } })
      expect(JSON.stringify(res)).toContain(format === 'postman' ? 'collection' : 'openapi')
      expectClean(JSON.stringify(res), `export_project (${format})`)
    }
    const out = tmp('vvpost-leak-foreign-export-out-')
    let terminal = ''
    const io = { stdout: (t: string) => void (terminal += t), stderr: (t: string) => void (terminal += t), env: {}, cwd: out, isTTY: false, appDir: out }
    expect(await vvpostCli(['export', '--workspace', dir, '--format', 'postman', '--out', 'api.postman_collection.json'], io)).toBe(0)
    expect(await vvpostCli(['export', '--workspace', dir, '--format', 'openapi', '--out', 'api.openapi.yaml'], io)).toBe(0)
    // O ambiente com segredo digitado no arquivo é inválido e fica de fora, com aviso; o do vault vai, sem valor.
    expect(readdirSync(out).sort()).toEqual(['api.openapi.yaml', 'api.postman_collection.json', 'api.prod.postman_environment.json'])
    expect(terminal).toContain('environments/dev.env.json')
    expectClean(terminal, 'saída do vvpost export')
    expectClean(filesOf(out), 'arquivos do vvpost export')
  })

  it('MCP: catálogo, plano e execução não devolvem segredo nem token obtido', async () => {
    const dir = tmp('vvpost-leak-mcp-')
    seedWorkspace(dir)
    // Os segredos ficam no vault, como depois de um commit.
    write(dir, SECRETS_FILE, { 'env.dev': { CLIENT_SECRET, API_TOKEN, PASSWORD } })
    const env = JSON.parse(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8'))
    for (const name of ['CLIENT_SECRET', 'API_TOKEN', 'PASSWORD']) env.variables[name].value = '__REQUIRED_SECRET__'
    write(dir, 'environments/dev.env.json', env)

    // Fluxo escrito pelo usuário (sem marca de revisão): a saída de cada nó também passa pelo sanitizer.
    write(dir, 'flows/me.flow.vvpost.json', {
      id: 'flow.me',
      name: 'Eu',
      nodes: [{ id: 'me', name: 'Me', type: 'request', request: { connector: 'api', endpoint: 'me' } }]
    })
    // Fluxo-base com o OAuth2 como nó: rodar a base pede o token e não o devolve.
    write(dir, 'flows/api2.flow.vvpost.json', {
      id: 'api2',
      name: 'API 2',
      defaults: { baseUrl: '{{BASE_URL}}' },
      nodes: [
        {
          id: 'oauth2',
          name: 'OAuth2',
          type: 'oauth2',
          oauth2: { type: 'oauth2', grantType: 'password', tokenUrl: '/token', clientId: 'app', clientSecret: '{{CLIENT_SECRET}}', username: 'ana', password: '{{PASSWORD}}' }
        }
      ]
    })
    const server = createMcpServer({ workspaceDir: dir, http: fakeApi(), auth: createAuthEngine() })
    const call = (name: string, args: Record<string, unknown>) =>
      server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    const flowRun = await call('execute_flow', { flowId: 'flow.me', environmentId: 'env.dev' })
    expect(JSON.stringify(flowRun)).toContain('\\"outcome\\":\\"success\\"')
    const baseRun = await call('execute_flow', { flowId: 'api2', environmentId: 'env.dev' })
    expect(JSON.stringify(baseRun)).toContain('token obtido')
    const outputs = [
      flowRun,
      baseRun,
      await call('list_projects', {}),
      await call('execute_flow', { flowId: 'flow.me', environmentId: 'env.dev', plan: true }),
      await call('get_api_catalog', {}),
      await call('get_api_catalog', { connectorId: 'api' }),
      await call('execute_dry_run', { connectorId: 'api', environmentIds: ['env.dev'], plan: true }),
      await call('execute_dry_run', { connectorId: 'api', environmentIds: ['env.dev'] }),
      await call('execute_dry_run', { connectorId: 'api', environmentIds: ['env.dev'], request: { endpointId: 'me', overrides: { query: { q: '1' } } } })
    ]
    const text = JSON.stringify(outputs)
    expect(text).toContain('"passed"')
    expectClean(text, 'saída do MCP')
  })

  it('CLI (vvpost run): terminal, JUnit e JSON não trazem segredo, token obtido nem segredo do CI', async () => {
    const dir = tmp('vvpost-leak-cli-')
    seedWorkspace(dir)
    const env = JSON.parse(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8'))
    for (const name of ['CLIENT_SECRET', 'API_TOKEN', 'PASSWORD']) env.variables[name].value = '__REQUIRED_SECRET__'
    write(dir, 'environments/dev.env.json', env)
    // Como no CI: o vault não existe e os segredos chegam por variável de ambiente e por --secrets.
    write(dir, 'ci-secrets.json', { 'env.dev': { PASSWORD } })
    let terminal = ''
    const io = {
      stdout: (t: string) => void (terminal += t),
      stderr: (t: string) => void (terminal += t),
      env: { VVPOST_SECRET_CLIENT_SECRET: CLIENT_SECRET, VVPOST_SECRET_API_TOKEN: API_TOKEN, VVPOST_USER_DATA: join(dir, 'user-data') },
      cwd: dir,
      isTTY: false,
      appDir: dir,
      http: fakeApi()
    }
    const code = await vvpostCli(
      ['run', '--workspace', dir, '--env', 'env.dev', '--secrets', 'ci-secrets.json', '--junit', 'out/junit.xml', '--json', 'out/report.json'],
      io
    )
    expect(code).toBe(0)
    let stdoutJson = ''
    await vvpostCli(['run', '--workspace', dir, '--env', 'env.dev', '--secrets', 'ci-secrets.json', '--json', '-'], {
      ...io,
      stdout: (t: string) => void (stdoutJson += t)
    })
    expect(stdoutJson).toContain('"passed"')
    expectClean(terminal, 'saída do CLI')
    expectClean(stdoutJson, 'JSON do CLI no stdout')
    expectClean(filesOf(join(dir, 'out')), 'relatórios do CLI')
    expectClean(filesOf(dir, ['ci-secrets.json']), 'workspace depois do CLI')
  })
})

describe('webhooks', () => {
  /** POST cru no servidor local, com os headers que o remetente quiser. */
  const post = (url: string, headers: Record<string, string>, body: string) =>
    new Promise<string>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve(text))
      })
      req.on('error', reject)
      req.end(body)
    })

  it('chave da assinatura e credenciais do remetente não saem pelo MCP, pelo CLI nem pelo estado do servidor', async () => {
    const dir = tmp('vvpost-leak-webhooks-')
    seedWorkspace(dir)
    write(dir, SECRETS_FILE, { 'env.dev': { CLIENT_SECRET, API_TOKEN, PASSWORD } })
    const env = JSON.parse(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8'))
    for (const name of ['CLIENT_SECRET', 'API_TOKEN', 'PASSWORD']) env.variables[name].value = '__REQUIRED_SECRET__'
    write(dir, 'environments/dev.env.json', env)
    write(dir, '.vvpost/webhooks.json', {
      hooks: [{ id: 'signed', path: '/signed', signature: { header: 'X-Sig', secret: '{{CLIENT_SECRET}}' } }]
    })
    // O remetente manda a credencial no header e o vault ecoado no corpo; a chave assina o corpo.
    const body = JSON.stringify({ note: `pw ${PASSWORD}`, token: API_TOKEN })
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${ACCESS_TOKEN}`,
      'x-sig': createHmac('sha256', CLIENT_SECRET).update(body).digest('hex')
    }

    const server = await startWebhookServer(dir, { port: 0, workspace: () => loadWorkspace(dir) })
    try {
      const replies = [await post(`${server.url}/signed`, headers, body), await post(`${server.url}/signed`, { ...headers, 'x-sig': 'errada' }, body)]
      expect(server.inbox.list().map((e) => e.signature)).toEqual(['invalid', 'valid'])
      const mcp = createMcpServer({ workspaceDir: dir, http: fakeApi(), auth: createAuthEngine(), webhooks: () => ({ url: server.url, inbox: server.inbox }) })
      const call = (name: string, args: Record<string, unknown>) =>
        mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      const outputs = [await call('list_webhook_events', {}), ...(await Promise.all(server.inbox.list().map((e) => call('get_webhook_event', { id: e.id }))))]
      expect(JSON.stringify(outputs)).toContain('pw [REDACTED')
      expectClean(JSON.stringify(outputs), 'saída do MCP sobre webhooks')
      expectClean(replies.join('\n'), 'respostas do servidor')
      expectClean(JSON.stringify((await loadWebhooksConfig(dir)).hooks.map(hookInfo)), 'hooks mostrados na interface')
    } finally {
      await server.close()
    }

    let terminal = ''
    const controller = new AbortController()
    const running = vvpostCli(['webhooks', '--workspace', dir, '--port', '0'], {
      stdout: (t: string) => void (terminal += t),
      stderr: (t: string) => void (terminal += t),
      env: { VVPOST_USER_DATA: join(dir, 'user-data') },
      cwd: dir,
      isTTY: false,
      appDir: dir,
      signal: controller.signal
    })
    for (let i = 0; i < 200 && !/Webhooks em (\S+) /.test(terminal); i++) await new Promise((r) => setTimeout(r, 10))
    const url = /Webhooks em (\S+) /.exec(terminal)![1]!
    await post(`${url}/signed?token=${API_TOKEN}`, headers, body)
    await post(`${url}/signed`, { ...headers, 'x-sig': 'errada' }, body)
    controller.abort()
    expect(await running).toBe(0)
    expect(terminal).toContain('assinatura inválida')
    expectClean(terminal, 'saída do vvpost webhooks')
  })
})

describe('edição pelo MCP', () => {
  it('get_source, edit_project e import_postman não devolvem nem gravam segredo', async () => {
    const dir = tmp('vvpost-leak-mcp-edit-')
    seedWorkspace(dir)
    write(dir, SECRETS_FILE, { 'env.dev': { CLIENT_SECRET, API_TOKEN, PASSWORD } })
    const env = JSON.parse(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8'))
    for (const name of ['CLIENT_SECRET', 'API_TOKEN', 'PASSWORD']) env.variables[name].value = '__REQUIRED_SECRET__'
    write(dir, 'environments/dev.env.json', env)

    const server = createMcpServer({ workspaceDir: dir, http: fakeApi(), auth: createAuthEngine() })
    const call = (name: string, args: Record<string, unknown>) =>
      server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    const collection = {
      info: { name: 'Outra', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: POSTMAN_TOKEN, type: 'string' }] },
      item: [{ name: 'Eu', request: { method: 'GET', url: 'https://outra.exemplo.com/me' } }]
    }
    const postmanEnv = { name: 'Outra', values: [{ key: 'client_secret', value: POSTMAN_SECRET, type: 'secret', enabled: true }] }
    const outputs = [
      await call('get_source', { kind: 'connector', id: 'api' }),
      await call('get_source', { kind: 'environment', id: 'env.dev' }),
      await call('import_postman', { collection, environments: [postmanEnv] }),
      await call('import_postman', { collection, environments: [postmanEnv], apply: true }),
      // A IA tenta gravar valores que conhece por fora: recusado, sem ecoar o valor.
      await call('edit_project', { ops: [{ op: 'writeDoc', connectorId: 'api', markdown: `token ${API_TOKEN}` }] }),
      await call('edit_project', { ops: [{ op: 'writeDoc', connectorId: 'api', markdown: `postman ${POSTMAN_TOKEN}` }] }),
      await call('edit_project', { ops: [{ op: 'setVariable', environmentId: 'env.dev', name: 'NOVO_SEGREDO', secret: true, value: PASSWORD }] })
    ]
    const text = JSON.stringify(outputs)
    expectClean(text, 'saída do MCP')
    expectClean(filesOf(dir), 'arquivos depois da edição pela IA')
    expect(await readVault(dir)).toEqual({ 'env.dev': { CLIENT_SECRET, API_TOKEN, PASSWORD } })
  })
})

describe('MCP: cada caminho de saída', () => {
  it('valor colado em página e fluxo, resposta, erro de rede e hex não saem em nenhuma ferramenta, nem como primeira chamada', async () => {
    const PASTED = canary('cola-')
    const api = {
      cancel() {},
      async send(input: HttpRequestInput): Promise<HttpResult> {
        if (input.url.endsWith('/falha')) {
          return { ok: false, error: { kind: 'network', message: `ECONNRESET com ${PASTED} (${Buffer.from(PASTED).toString('hex')})` } } as unknown as HttpResult
        }
        const body = JSON.stringify({ recebido: input.headers, eco: `valor ${PASTED}`, hex: Buffer.from(PASTED).toString('hex').toUpperCase() })
        return {
          ok: true,
          response: { status: 200, statusText: 'OK', headers: [{ name: 'x-eco', value: PASTED }], body, sizeBytes: body.length, truncated: false, timings: { ttfbMs: 1, downloadMs: 0, totalMs: 1 } }
        }
      }
    }
    const seed = () => {
      const dir = tmp('vvpost-leak-mcp-saidas-')
      write(dir, 'environments/dev.env.json', {
        id: 'env.dev',
        name: 'Dev',
        variables: { BASE_URL: { type: 'string', value: 'https://api.exemplo.com' }, CHAVE: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
      })
      write(dir, SECRETS_FILE, { 'env.dev': { CHAVE: PASTED } })
      write(dir, 'connectors/api.connector.vvpost.json', {
        $schema: 'https://vvpost.dev/schemas/v1/connector.json',
        id: 'api',
        name: 'API',
        version: '1.0.0',
        config: { baseUrl: '{{BASE_URL}}', auth: { type: 'apiKey', in: 'header', name: 'X-Chave', value: '{{CHAVE}}' } },
        endpoints: [
          { id: 'eco', name: 'Eco', method: 'GET', path: '/eco', scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }] },
          { id: 'falha', name: 'Falha', method: 'GET', path: '/falha' }
        ]
      })
      // Alguém colou o valor numa página e na descrição de um fluxo.
      write(dir, 'docs/guia.md', `# Guia\n\nA chave de teste é ${PASTED}, use com cuidado.\n`)
      write(dir, 'docs/projeto.md', '{{> include docs/guia.md}}\n')
      write(dir, 'flows/f.flow.vvpost.json', { $schema: 'https://vvpost.dev/schemas/v1/flow.json', id: 'f', name: 'F', description: `chave ${PASTED}`, nodes: [] })
      return dir
    }
    const calls: [string, Record<string, unknown>][] = [
      ['get_docs_project', {}],
      ['find_references', { terms: ['chave'] }],
      ['generate_docs', {}],
      ['get_source', { kind: 'flow', id: 'f' }],
      ['get_api_catalog', {}],
      ['export_project', {}],
      ['export_project', { format: 'openapi' }],
      ['execute_dry_run', { connectorId: 'api', environmentIds: ['env.dev'] }],
      ['execute_dry_run', { connectorId: 'api', environmentIds: ['env.dev'], request: { endpointId: 'eco' } }],
      ['execute_dry_run', { connectorId: 'api', environmentIds: ['env.dev'], request: { endpointId: 'falha' } }],
      ['execute_dry_run', { connectorId: 'api', environmentIds: ['env.dev'], request: { endpointId: 'eco', select: ['recebido', 'eco', 'hex'] } }],
      ['replace_references', { from: 'chave', to: 'senha', dryRun: true }],
      ['replace_references', { from: 'chave', to: 'senha' }],
      ['replace_references', { from: 'Chave', to: 'Senha' }],
      ['execute_flow', { flowId: 'f' }],
      ['write_docs_page', { file: 'docs/outra.md', markdown: '# Outra\n' }]
    ]
    // Um servidor novo por chamada: o sanitizer não pode depender de outra ferramenta ter lido o workspace antes.
    for (const [name, args] of calls) {
      const server = createMcpServer({ workspaceDir: seed(), http: api, auth: createAuthEngine() })
      const out = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      expectClean(JSON.stringify(out), `${name} ${JSON.stringify(args)}`, [PASTED])
    }
  })
})

describe('prontidão', () => {
  it('check_readiness e vvpost doctor (texto e JSON) não trazem o segredo de uma URL montada com ele', async () => {
    const SEGREDO = canary('url-')
    const dir = tmp('vvpost-leak-pronto-')
    write(dir, 'environments/dev.env.json', {
      id: 'env.dev',
      name: 'Dev',
      variables: { BASE: { type: 'string', value: 'ftp://h.local' }, CHAVE: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }, FALTA: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
    })
    write(dir, SECRETS_FILE, { 'env.dev': { CHAVE: SEGREDO } })
    // A URL montada com o segredo não é http(s): o achado invalid-url cita a URL inteira.
    write(dir, 'connectors/api.connector.vvpost.json', {
      id: 'api',
      name: 'API',
      version: '1.0.0',
      config: { baseUrl: '{{BASE}}/{{CHAVE}}', headers: { 'X-Falta': '{{FALTA}}' } },
      endpoints: [{ id: 'eco', name: 'Eco', method: 'GET', path: '/eco' }]
    })
    const server = createMcpServer({ workspaceDir: dir, http: createHttpDispatcher(), auth: createAuthEngine() })
    const mcp = JSON.stringify(await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_readiness', arguments: {} } }))
    expect(mcp).toContain('invalid-url')
    expectClean(mcp, 'check_readiness', [SEGREDO])
    let out = ''
    const io = {
      stdout: (t: string) => void (out += t),
      stderr: (t: string) => void (out += t),
      env: { VVPOST_USER_DATA: join(dir, 'user-data'), VVPOST_SECRET_CHAVE: SEGREDO },
      cwd: dir,
      isTTY: false,
      appDir: dir
    }
    expect(await vvpostCli(['doctor', '--workspace', dir, '--proxy', 'off'], io)).toBe(2)
    expect(await vvpostCli(['doctor', '--workspace', dir, '--proxy', 'off', '--json', '-'], io)).toBe(2)
    expect(out).toContain('FALTA')
    expectClean(out, 'vvpost doctor', [SEGREDO])
  })
})

describe('documento do projeto', () => {
  it('modelo, fonte, páginas, modelos, prompts e resources pelo MCP não devolvem nem gravam segredo', async () => {
    const dir = tmp('vvpost-leak-docs-')
    seedWorkspace(dir)
    write(dir, SECRETS_FILE, { 'env.dev': { CLIENT_SECRET, API_TOKEN, PASSWORD } })
    const env = JSON.parse(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8'))
    for (const name of ['CLIENT_SECRET', 'API_TOKEN', 'PASSWORD']) env.variables[name].value = '__REQUIRED_SECRET__'
    write(dir, 'environments/dev.env.json', env)
    const server = createMcpServer({ workspaceDir: dir, http: fakeApi(), auth: createAuthEngine() })
    const rpc = (method: string, params: Record<string, unknown>) => server.handle({ jsonrpc: '2.0', id: 1, method, params })
    const call = (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args })
    const source = '# Doc\n\n```mermaid\ngraph TD\n  a --> b\n```\n\n{{> variables}}\n\n{{> connector api}}\n\n{{> include docs/guia.md}}\n'
    const outputs = [
      await call('save_docs_project', { template: 'builtin:c4', source }),
      await call('write_docs_page', { file: 'docs/guia.md', markdown: '## Guia\n\nUse a variável {{API_TOKEN}}.\n' }),
      await call('get_docs_project', {}),
      await call('generate_docs', {}),
      await call('save_docs_template', { name: 'Padrão' }),
      // A IA tenta gravar valores que conhece por fora: recusado, sem ecoar o valor.
      await call('save_docs_project', { source: `token ${API_TOKEN}` }),
      await call('save_docs_project', { config: { title: 'Doc', footer: { left: CLIENT_SECRET } } }),
      await call('write_docs_page', { file: 'docs/vaza.md', markdown: `senha ${PASSWORD}` }),
      await call('save_docs_template', { name: 'Vaza', source: `token ${API_TOKEN}` }),
      await call('write_docs_page', { file: 'docs/diagramas/vaza.mmd', markdown: `graph TD\n  a[${CLIENT_SECRET}]` }),
      await rpc('resources/read', { uri: 'vvpost://docs/guia' }),
      await rpc('resources/read', { uri: 'vvpost://docs/modelos' }),
      await rpc('prompts/get', { name: 'documentar_conector', arguments: { connector: 'api' } })
    ]
    expectClean(JSON.stringify(outputs), 'saída do MCP')
    for (const refused of outputs.slice(5, 10)) expect(JSON.stringify(refused)).toContain('segredo do workspace')
    // A página pelo edit_project (writePage) passa pela mesma recusa.
    const page = await call('edit_project', { ops: [{ op: 'writePage', file: 'docs/vaza2.md', markdown: `senha ${PASSWORD}` }] })
    expectClean(JSON.stringify(page), 'saída do MCP')
    expect(JSON.stringify(page)).toContain('nada foi gravado')
    // O editor de diagramas do app grava pelo mesmo núcleo: bloco de um Markdown e .mmd.
    const { writeDiagram } = await import('@vvpost/core/docs')
    const ws = await loadWorkspace(dir)
    const line = readFileSync(join(dir, 'docs/projeto.md'), 'utf8').split('\n').findIndex((l) => l.startsWith('```mermaid')) + 1
    expect(line).toBeGreaterThan(0)
    await expect(writeDiagram(ws, { file: 'docs/projeto.md', line, code: `graph TD\n  a[${PASSWORD}]` })).rejects.toThrow(/segredo/)
    await expect(writeDiagram(ws, { file: 'docs/diagramas/novo.mmd', code: `graph TD\n  a[${API_TOKEN}]`, create: true })).rejects.toThrow(/segredo/)
    expectClean(filesOf(dir), 'arquivos do documento do projeto')
  })
})

describe('enviar para (publicação da documentação)', () => {
  it('pacote entregue ao publicador, plano, resultado e vvpost.publish.json não levam segredo', async () => {
    const { createPublishService, setPublishersForTests } = await import('../src/main/docs/publish')
    const { loadFlows } = await import('@vvpost/core/flows/workspace')
    const dir = tmp('vvpost-leak-publish-')
    seedWorkspace(dir)
    write(dir, SECRETS_FILE, { 'env.dev': { CLIENT_SECRET, API_TOKEN, PASSWORD } })
    const env = JSON.parse(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8'))
    for (const name of ['CLIENT_SECRET', 'API_TOKEN', 'PASSWORD']) env.variables[name].value = '__REQUIRED_SECRET__'
    write(dir, 'environments/dev.env.json', env)
    // Valores colados à mão em todo lugar que vira página: título, texto, diagrama, imagem SVG.
    write(dir, 'docs/projeto.md', `## Visão\n\nA senha é ${PASSWORD}.\n\n\`\`\`mermaid\ngraph TD\n  a[${CLIENT_SECRET}] --> b\n\`\`\`\n\n![fig](fig.svg)\n\n{{> connector api}}\n`)
    write(dir, 'docs/fig.svg', `<svg xmlns="http://www.w3.org/2000/svg"><text>${API_TOKEN}</text></svg>`)
    write(dir, 'docs/guias/token.md', `# Token ${API_TOKEN}\n\nUse {{API_TOKEN}}.\n`)
    write(dir, 'vvpost.publish.json', {
      targets: [
        {
          id: 'leak',
          provider: 'fake',
          destination: 'catalog:x',
          diagrams: 'svg',
          structure: [{ page: 'Doc', source: 'document', children: [{ pages: 'docs/guias/*.md' }, { each: 'connector', split: 'endpoints' }] }]
        }
      ]
    })
    const seen: string[] = []
    const show = (v: unknown) =>
      JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Buffer.from(x).toString('latin1') : x))
    setPublishersForTests([
      {
        id: 'fake',
        title: 'Fake',
        session: async () => ({ status: 'signedIn', account: 'ana' }),
        plan: async (bundle) => {
          seen.push(show(bundle))
          return { destination: { label: 'X' }, warnings: [], items: [] }
        },
        publish: async (bundle, plan) => {
          seen.push(show(bundle))
          return { destination: plan.destination, items: [{ key: 'document', kind: 'page', title: 'Doc', outcome: 'created', id: '1' }] }
        }
      }
    ])
    try {
      const svc = createPublishService({
        dir: async () => dir,
        workspace: () => loadWorkspace(dir),
        flows: (d) => loadFlows(d),
        openExternal: async () => {},
        svgToPng: async () => null
      })
      const prepared = await svc.prepare('leak')
      // O renderer desenha o diagrama do código que recebeu: o segredo já não estava lá.
      const images = prepared.diagrams.map((d) => ({ id: d.id, svg: `<svg><text>${d.source}</text></svg>` }))
      const outputs = [await svc.targets(), prepared, await svc.plan(prepared.id, images), await svc.apply(prepared.id, { update: [], conflicts: [], archive: [] })]
      expect(seen.length).toBe(2)
      expectClean(seen.join('\n'), 'pacote do publicador')
      expectClean(show(outputs), 'saída do serviço de publicação')
      expectClean(filesOf(dir, [SECRETS_FILE, 'docs/projeto.md', 'docs/fig.svg', 'docs/guias/token.md']), 'arquivos depois da publicação')
      expect(seen[0]).not.toContain('vv-imagem-')
    } finally {
      setPublishersForTests(null)
    }
  })
  it('exportar como site (vvpost docs export): páginas, manifesto e saída do terminal não levam segredo', async () => {
    const dir = tmp('vvpost-leak-site-')
    seedWorkspace(dir)
    write(dir, SECRETS_FILE, { 'env.dev': { CLIENT_SECRET, API_TOKEN, PASSWORD } })
    const env = JSON.parse(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8'))
    for (const name of ['CLIENT_SECRET', 'API_TOKEN', 'PASSWORD']) env.variables[name].value = '__REQUIRED_SECRET__'
    write(dir, 'environments/dev.env.json', env)
    write(dir, 'docs/projeto.md', `## Visão\n\nA senha é ${PASSWORD}.\n\n\`\`\`mermaid\ngraph TD\n  a[${CLIENT_SECRET}] --> b\n\`\`\`\n\n![fig](fig.svg)\n\n{{> connector api}}\n`)
    write(dir, 'docs/fig.svg', `<svg xmlns="http://www.w3.org/2000/svg"><text>${API_TOKEN}</text></svg>`)
    write(dir, 'docs/guias/token.md', `# Token ${API_TOKEN}\n\nUse {{API_TOKEN}}.\n`)
    write(dir, 'vvpost.publish.json', {
      targets: [
        {
          id: 'site',
          provider: 'html',
          destination: 'dist/site',
          structure: [{ page: 'Doc', source: 'document', children: [{ pages: 'docs/guias/*.md' }, { each: 'connector', split: 'endpoints' }] }]
        }
      ]
    })
    let terminal = ''
    const io = { stdout: (t: string) => void (terminal += t), stderr: (t: string) => void (terminal += t), env: {}, cwd: dir, isTTY: false, appDir: dir }
    expect(await vvpostCli(['docs', 'export', '--workspace', dir, '--no-plugins', '--json', '-'], io)).toBe(0)
    expectClean(terminal, 'saída do vvpost docs export')
    expect(readdirSync(join(dir, 'dist/site')).filter((n) => n.endsWith('.html')).length).toBeGreaterThan(3)
    expectClean(filesOf(join(dir, 'dist/site')), 'arquivos do site exportado')
  })
})

describe('logs', () => {
  let historyDir: string
  beforeAll(() => {
    historyDir = mkdtempSync(join(tmpdir(), 'vvpost-leak-history-'))
  })
  afterAll(() => rmSync(historyDir, { recursive: true, force: true }))

  it('histórico: headers, query e campos de credencial do corpo não chegam ao disco (nem ao WAL)', async () => {
    const path = join(historyDir, 'history.sqlite')
    const store = await openHistoryStore(path)
    // Como o app: o sanitizer conhece os segredos do workspace e aprende os do dispatcher.
    const sanitizer = createSecretSanitizer()
    for (const value of [CLIENT_SECRET, PASSWORD, API_TOKEN]) sanitizer.add(value)
    const timings = { ttfbMs: 1, downloadMs: 1, totalMs: 2 }
    const jsonBody = JSON.stringify({ user: 'ana', password: PASSWORD, nested: { client_secret: CLIENT_SECRET } })
    const formBody = `grant_type=password&username=ana&password=${encodeURIComponent(PASSWORD)}&client_secret=${CLIENT_SECRET}`
    const exchange = (url: string, headers: { name: string; value: string }[], body: string) => ({
      createdAt: Date.now(),
      method: 'POST' as const,
      url,
      status: 200,
      errorCode: null,
      durationMs: 1,
      sizeBytes: 10,
      connectorId: null,
      environmentId: null,
      template: { headers, body },
      sent: { url, headers, body },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [{ name: 'Set-Cookie', value: `sid=${ACCESS_TOKEN}; HttpOnly` }],
        // A API devolve um token novo e ecoa o segredo num campo de nome neutro.
        body: JSON.stringify({ access_token: ACCESS_TOKEN, echo: PASSWORD, ok: true }),
        truncated: false,
        sizeBytes: 10,
        timings
      },
      logs: `login com ${CLIENT_SECRET}`
    })
    const ids: (number | null)[] = []
    for (const level of ['metadata', 'headers', 'full'] as const) {
      ids.push(
        await store.addRun(
          {
            createdAt: Date.now(),
            source: 'request',
            title: `POST https://api.exemplo.com/login?api_key=${API_TOKEN}`,
            outcome: 'passed',
            durationMs: 2,
            report: { meta: { auth: { access_token: ACCESS_TOKEN } }, full: { nodes: [{ output: { data: { password: PASSWORD } } }] } },
            exchanges: [
              exchange(
                `https://api.exemplo.com/login?api_key=${encodeURIComponent(API_TOKEN)}&page=2&token={{API_TOKEN}}`,
                [
                  { name: 'Authorization', value: `Bearer ${ACCESS_TOKEN}` },
                  { name: 'Content-Type', value: 'application/json' }
                ],
                jsonBody
              ),
              exchange('https://api.exemplo.com/token', [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }], formBody)
            ]
          },
          { sanitizer, level }
        )
      )
    }
    const full = await store.get(ids[2]!)
    const [json, form] = full!.exchanges
    expect(json!.url).toBe('https://api.exemplo.com/login?api_key=__REQUIRED_SECRET__&page=2&token={{API_TOKEN}}')
    expect(JSON.parse(json!.template!.body!)).toEqual({ user: 'ana', password: '__REQUIRED_SECRET__', nested: { client_secret: '__REQUIRED_SECRET__' } })
    expect(form!.template!.body).toBe('grant_type=password&username=ana&password=__REQUIRED_SECRET__&client_secret=__REQUIRED_SECRET__')
    expect(JSON.parse(json!.response!.body!)).toMatchObject({ ok: true })
    // O arquivo do banco e o WAL, byte a byte, antes de fechar (o WAL ainda tem as páginas).
    expectClean(filesOf(historyDir, []), 'banco do histórico')
    await store.close()
    expectClean(filesOf(historyDir, []), 'banco do histórico')
  })

  it('workspace carregado com segredos não escreve nada no console', async () => {
    const dir = tmp('vvpost-leak-load-')
    seedWorkspace(dir)
    write(dir, SECRETS_FILE, { 'env.dev': { CLIENT_SECRET, API_TOKEN, PASSWORD } })
    await loadWorkspace(dir)
    expect(logs).toEqual([])
  })
})

describe('redirecionamentos', () => {
  it('credenciais não seguem um redirect para outra origem, qualquer que seja o header', async () => {
    const { createServer } = await import('node:http')
    const { createHttpDispatcher } = await import('@vvpost/core/http/dispatcher')
    const { sendHeadless } = await import('@vvpost/core/connectors/headless')
    const seen: Record<string, string | string[] | undefined>[] = []
    const other = createServer((req, res) => {
      seen.push(req.headers)
      res.end('{}')
    })
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    const otherUrl = `http://localhost:${(other.address() as { port: number }).port}`
    const api = createServer((req, res) => {
      res.statusCode = 302
      res.setHeader('location', `${otherUrl}/fim`)
      res.end()
    })
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
    const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`
    const http = createHttpDispatcher()
    try {
      const ws = {
        dir: '/ws',
        connectors: new Map([
          ['c', { id: 'c', name: 'C', version: '1.0.0', config: { baseUrl: apiUrl, auth: { type: 'apiKey' as const, name: 'X-Tenant-Credencial', value: '{{K}}' } } }]
        ]),
        connectorFiles: new Map(),
        environments: new Map([['dev', { id: 'dev', name: 'Dev', variables: { K: { type: 'string' as const, value: '__REQUIRED_SECRET__', isSecret: true } } }]]),
        secrets: { dev: { K: API_TOKEN } },
        issues: []
      }
      const result = await sendHeadless(
        { id: '1', method: 'GET', url: '/x', headers: [{ name: 'X-Api-Key', value: CLIENT_SECRET }, { name: 'X-Trace', value: 't1' }], connectorId: 'c', environmentId: 'dev' },
        { workspace: ws, auth: createAuthEngine(), http }
      )
      expect(result.ok && result.response.status).toBe(200)
      expect(seen).toHaveLength(1)
      expect(seen[0]!['x-trace']).toBe('t1')
      expectClean(JSON.stringify(seen), 'headers recebidos pela outra origem')
    } finally {
      await http.close()
      api.close()
      other.close()
    }
  })
})

describe('scripts por requisição', () => {
  it('o script vê {{NOME}}: logs, variáveis, testes e o histórico do envio não trazem o segredo', async () => {
    const { createServer } = await import('node:http')
    const { createHttpDispatcher } = await import('@vvpost/core/http/dispatcher')
    const { sendWithScripts } = await import('@vvpost/core/flows/scripted-send')
    const { PluginManager } = await import('@vvpost/core/plugins/manager')
    const received: string[] = []
    const api = createServer((req, res) => {
      received.push(String(req.headers['x-api-key']))
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
    const userData = tmp('vvpost-leak-scripts-')
    const manager = new PluginManager({
      officialDir: join(__dirname, '..', 'plugins'),
      userDir: join(userData, 'plugins'),
      stateFile: join(userData, 'plugins.json'),
      graceMs: 200
    })
    const http = createHttpDispatcher()
    try {
      const ws = {
        dir: '/ws',
        connectors: new Map([['c', { id: 'c', name: 'C', version: '1.0.0', config: { baseUrl: `http://127.0.0.1:${(api.address() as { port: number }).port}` } }]]),
        connectorFiles: new Map(),
        environments: new Map([['dev', { id: 'dev', name: 'Dev', variables: { K: { type: 'string' as const, value: '__REQUIRED_SECRET__', isSecret: true } } }]]),
        secrets: { dev: { K: API_TOKEN } },
        issues: []
      }
      const result = await sendWithScripts(
        {
          id: '1',
          method: 'GET',
          url: '/x',
          headers: [],
          connectorId: 'c',
          environmentId: 'dev',
          scripts: {
            pre: `
              const k = vv.variables.get('K')
              console.log('chave: ' + k, JSON.stringify(vv.variables.toObject()))
              vv.variables.set('copia', k)
              vv.request.headers['X-Api-Key'] = k`,
            post: `
              console.log(JSON.stringify(vv.request), JSON.stringify(vv.response))
              vv.test('vê ' + vv.variables.get('K'), () => vv.expect(vv.variables.get('copia')).to.equal('outro'))`
          }
        },
        { workspace: ws, auth: createAuthEngine(), http, plugins: await manager.runner() }
      )
      // O host resolve o {{K}} no envio: a API recebe a chave.
      expect(received).toEqual([API_TOKEN])
      expect(result?.ok).toBe(true)
      expect(result!.scripts!.logs).toContain('chave: {{K}}')
      expect(result!.scripts!.tests[0]!.passed).toBe(false)
      expectClean(JSON.stringify(result), 'resultado da requisição com scripts')
    } finally {
      await manager.shutdown()
      await http.close()
      api.close()
    }
  })
})

describe('conexões realtime', () => {
  it('WebSocket, Socket.IO e SSE: mensagens, estados e erros não trazem segredo nem token da abertura', async () => {
    const server = await startRealtimeServer()
    const http = createHttpDispatcher()
    try {
      const dir = tmp('vvpost-leak-realtime-')
      write(dir, 'environments/dev.env.json', {
        id: 'dev',
        name: 'Dev',
        variables: {
          BASE_URL: { type: 'string', value: server.url },
          API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
          PASSWORD: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
        }
      })
      write(dir, '.vvpost/secrets.local.json', { dev: { API_TOKEN, PASSWORD } })
      write(dir, 'connectors/live.connector.vvpost.json', {
        id: 'live',
        name: 'Live',
        version: '1.0.0',
        config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}', header: 'X-Live-Key', prefix: '' } },
        endpoints: []
      })
      const ws = await loadWorkspace(dir)
      expect(ws.issues).toEqual([])
      // O mesmo sanitizer do app: o do histórico, protegido com o workspace aberto.
      const sanitizer = createSecretSanitizer()
      protectWorkspace(sanitizer, ws)
      const events: RealtimeEvent[] = []
      const open = (input: Omit<RealtimeOpenInput, 'id' | 'headers' | 'connectorId' | 'environmentId'>, script: (e: RealtimeEvent, c: RealtimeConnection) => void) => {
        const conn: RealtimeConnection = openRealtime({ id: input.protocol, headers: [], connectorId: 'live', environmentId: 'dev', ...input }, { workspace: ws, auth: createAuthEngine(), http, sanitizer }, (e) => {
          events.push(e)
          queueMicrotask(() => script(e, conn))
        })
        setTimeout(() => conn.close(), 3000)
        return conn.done
      }
      await open({ protocol: 'websocket', url: '/ws' }, (e, c) => {
        // O servidor devolve o header da auth e o eco do que foi digitado com {{API_TOKEN}} e {{PASSWORD}}.
        if (e.type === 'message' && e.message.data.includes('hello')) c.send({ data: 'token={{API_TOKEN}} senha {{PASSWORD}}' })
        if (e.type === 'message' && e.message.data.startsWith('echo:')) c.close()
      })
      await open({ protocol: 'socketio', url: '/' }, (e, c) => {
        if (e.type === 'message' && e.message.event === 'welcome') c.send({ event: 'login', data: '{"password":"{{PASSWORD}}","t":"{{API_TOKEN}}"}' })
        if (e.type === 'message' && e.message.event === 'echo') c.close()
      })
      await open({ protocol: 'sse', url: '/sse' }, () => {})
      await open({ protocol: 'websocket', url: `wss://outro.exemplo.com/{{API_TOKEN}}` }, () => {})
      expect(server.state.received.some((m) => m.includes(API_TOKEN))).toBe(true)
      expect(server.state.headers.every((h) => h['x-live-key'] === API_TOKEN)).toBe(true)
      expect(events.filter((e) => e.type === 'message').length).toBeGreaterThanOrEqual(6)
      expectClean(JSON.stringify(events), 'eventos realtime')
    } finally {
      await http.close()
      await server.close()
    }
  })
})
