import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { Connector } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { resolveSchemaRefs } from '@vvpost/core/connectors/shared-schemas'
import { exportAs, ExportError } from '../src/main/bundle/export'
import { translateVvScript } from '../src/main/bundle/postman'
import { main, type Io } from '../src/main/cli'
import { prepareSources } from '../src/main/importers'
import { createMcpServer } from '../src/main/mcp/server'
import { SECRETS_FILE } from '../src/main/workspace/vault'

// Valores montados em tempo de execução: nada com cara de credencial fica no repositório.
const VAULT_TOKEN = ['vault', 'token', '5c1e8b2d7a'].join('-')
const CLIENT_SECRET = ['cliente', 'segredo', '3f9a6d1e'].join('-')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-foreign-export-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const chargeCreated = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }

const chargeSchema = {
  type: 'object',
  required: ['amount', 'customer'],
  properties: {
    amount: { type: 'integer', minimum: 1 },
    currency: { type: 'string', enum: ['BRL', 'USD'] },
    customer: { $ref: '#/$defs/Customer' }
  },
  $defs: { Customer: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string', format: 'email' } } } }
}

/** API com raiz, dois filhos (um com basePath e headers), auth OAuth2, exemplos, scripts e segredos no vault. */
function seeded(extra: Record<string, unknown> = {}): string {
  return workspace({
    'connectors/loja.connector.vvpost.json': {
      id: 'loja',
      name: 'Loja',
      description: 'API da loja.',
      version: '2.1.0',
      config: {
        baseUrl: '{{BASE_URL}}',
        headers: { 'X-Tenant': '{{TENANT}}' },
        auth: {
          type: 'oauth2',
          grantType: 'client_credentials',
          tokenUrl: '/oauth/token',
          clientId: '{{CLIENT_ID}}',
          clientSecret: '{{CLIENT_SECRET}}',
          scope: 'charges:read charges:write'
        }
      },
      endpoints: [{ id: 'health', name: 'Saúde', method: 'GET', path: '/health' }]
    },
    'connectors/cobranca.connector.vvpost.json': {
      id: 'loja.cobranca',
      name: 'Cobranças',
      version: '2.1.0',
      extends: 'loja',
      config: { basePath: '/v1', scripts: { post: "vv.test('status 2xx', () => vv.expect(vv.response.code).to.be.within(200, 299))" } },
      endpoints: [
        {
          id: 'createCharge',
          name: 'Criar cobrança',
          description: 'Cria uma cobrança.',
          method: 'POST',
          path: '/charges',
          headers: { 'Idempotency-Key': '{{$uuid}}' },
          bodySchema: chargeSchema,
          body: { amount: 1000, currency: 'BRL', customer: { id: 'c1' } },
          scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }],
          examples: [
            { id: 'criada', name: 'Criada', status: 201, headers: { 'Content-Type': 'application/json', Location: '/v1/charges/ch_1' }, body: { id: 'ch_1' }, schema: chargeCreated },
            { id: 'invalida', name: 'Inválida', status: 422, body: { error: 'amount' } }
          ]
        },
        { id: 'getCharge', name: 'Buscar cobrança', method: 'GET', path: '/charges/{chargeId}', query: { expand: 'customer' } }
      ]
    },
    'connectors/publico.connector.vvpost.json': {
      id: 'loja.publico',
      name: 'Público',
      version: '2.1.0',
      extends: 'loja',
      config: { auth: { type: 'none' } },
      endpoints: [
        {
          id: 'upload',
          name: 'Enviar arquivo',
          method: 'POST',
          path: '/files',
          payload: { mode: 'multipart', fields: [{ name: 'descricao', value: 'nota' }, { name: 'arquivo', file: 'docs/nota.pdf' }] }
        }
      ]
    },
    'connectors/cobranca.connector.vvpost.md': '# Cobranças\n\nComo cobrar.\n',
    'environments/dev.env.json': {
      id: 'dev',
      name: 'Dev',
      variables: {
        BASE_URL: { type: 'string', value: 'https://dev.loja.exemplo.com' },
        TENANT: { type: 'string', value: 'acme' },
        CLIENT_ID: { type: 'string', value: 'app-loja' },
        CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    },
    'environments/prod.env.json': {
      id: 'prod',
      name: 'Produção',
      variables: {
        BASE_URL: { type: 'string', value: 'https://loja.exemplo.com' },
        TENANT: { type: 'string', value: 'acme' },
        CLIENT_ID: { type: 'string', value: 'app-loja' },
        CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    },
    [SECRETS_FILE]: { dev: { CLIENT_SECRET }, prod: { CLIENT_SECRET: VAULT_TOKEN } },
    ...extra
  })
}

type Obj = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const allText = (files: { text: string }[]) => files.map((f) => f.text).join('\n')

describe('exportação para o Postman', () => {
  it('monta a coleção v2.1 com uma pasta por conector, a auth como variáveis e os ambientes sem segredo', async () => {
    const dir = seeded()
    const result = await exportAs(dir, { format: 'postman' }, { name: 'Loja' })
    expect(result.files.map((f) => f.suffix)).toEqual(['.postman_collection.json', '.dev.postman_environment.json', '.producao.postman_environment.json'])
    const text = allText(result.files)
    for (const secret of [VAULT_TOKEN, CLIENT_SECRET]) expect(text).not.toContain(secret)

    const collection = result.files[0].data as Obj
    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json')
    expect(collection.info.name).toBe('Loja')
    // Raiz única: a coleção é o conector raiz, com a auth dele e as pastas dos filhos.
    expect(collection.auth.type).toBe('oauth2')
    const oauth = Object.fromEntries(collection.auth.oauth2.map((p: Obj) => [p.key, p.value]))
    expect(oauth).toMatchObject({
      grant_type: 'client_credentials',
      accessTokenUrl: '{{BASE_URL}}/oauth/token',
      clientId: '{{CLIENT_ID}}',
      clientSecret: '{{CLIENT_SECRET}}',
      scope: 'charges:read charges:write'
    })
    expect(collection.item.map((i: Obj) => i.name)).toEqual(['Saúde', 'Cobranças', 'Público'])
    const [, charges, open] = collection.item
    expect(charges.description).toContain('Como cobrar.')
    expect(charges.event[0]).toMatchObject({ listen: 'test' })
    expect(charges.event[0].script.exec.join('\n')).toBe("pm.test('status 2xx', () => pm.expect(pm.response.code).to.be.within(200, 299))")
    expect(open.auth).toEqual({ type: 'noauth' })

    const create = charges.item[0]
    expect(create.request.method).toBe('POST')
    expect(create.request.url.raw).toBe('{{BASE_URL}}/v1/charges')
    expect(create.request.header).toEqual(
      expect.arrayContaining([
        { key: 'X-Tenant', value: '{{TENANT}}' },
        { key: 'Idempotency-Key', value: '{{$randomUUID}}' },
        { key: 'Content-Type', value: 'application/json' }
      ])
    )
    expect(JSON.parse(create.request.body.raw)).toEqual({ amount: 1000, currency: 'BRL', customer: { id: 'c1' } })
    expect(create.request.description).toContain('### Schema do corpo')
    expect(create.request.description).toContain('"enum"')
    expect(create.response.map((r: Obj) => [r.name, r.code])).toEqual([
      ['Criada', 201],
      ['Inválida', 422]
    ])
    expect(JSON.parse(create.response[0].body)).toEqual({ id: 'ch_1' })

    const get = charges.item[1]
    expect(get.request.url.raw).toBe('{{BASE_URL}}/v1/charges/:chargeId?expand=customer')
    expect(get.request.url.variable).toEqual([{ key: 'chargeId', value: '' }])
    expect(open.item[0].request.body.formdata).toEqual([
      { key: 'descricao', value: 'nota', type: 'text' },
      { key: 'arquivo', type: 'file', src: 'docs/nota.pdf' }
    ])

    const env = result.files[1]!.data as Obj
    expect(env._postman_variable_scope).toBe('environment')
    expect(env.values).toEqual(
      expect.arrayContaining([
        { key: 'BASE_URL', value: 'https://dev.loja.exemplo.com', type: 'default', enabled: true },
        { key: 'CLIENT_SECRET', value: '', type: 'secret', enabled: true }
      ])
    )
    expect(result.warnings.some((w) => w.includes('cenários de teste só vão no pacote'))).toBe(true)
  })

  it('volta pelo importador do Postman com a mesma hierarquia, auth e exemplos', async () => {
    const result = await exportAs(seeded(), { format: 'postman' })
    const prepared = prepareSources(result.files.map((f, i) => ({ file: `f${i}${f.suffix}`, data: f.data })))
    expect(prepared.invalid).toEqual([])
    const byName = new Map(prepared.result.connectors.map((c) => [c.name, c]))
    const root = byName.get('Loja')!
    expect(root.config?.auth).toMatchObject({ type: 'oauth2', grantType: 'client_credentials', clientId: '{{CLIENT_ID}}' })
    const charges = byName.get('Cobranças')!
    expect(charges.extends).toBe(root.id)
    const create = charges.endpoints!.find((e) => e.name === 'Criar cobrança')!
    expect(create.examples?.map((x) => x.status)).toEqual([201, 422])
    expect(prepared.result.environments.map((e) => e.name).sort()).toEqual(['Dev', 'Produção'])
    // Os segredos vazios voltam como pendentes, nunca com valor.
    expect(prepared.result.secrets).toEqual([])
  })

  it('login próprio vira uma requisição que guarda o token e a pasta usa a variável', async () => {
    const dir = workspace({
      'connectors/api.connector.vvpost.json': {
        id: 'api',
        name: 'API',
        version: '1.0.0',
        config: {
          baseUrl: 'https://api.exemplo.com',
          auth: {
            type: 'login',
            request: { url: '/auth/login', json: { user: '{{USER}}', password: '{{PASSWORD}}' } },
            token: 'body.data.accessToken'
          }
        },
        endpoints: [{ id: 'me', name: 'Eu', method: 'GET', path: '/me' }]
      }
    })
    const collection = (await exportAs(dir, { format: 'postman' })).files[0].data as Obj
    expect(collection.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{API_TOKEN}}', type: 'string' }] })
    const login = collection.item[0]
    expect(login.name).toBe('Login (API)')
    expect(login.request.url.raw).toBe('https://api.exemplo.com/auth/login')
    expect(login.request.auth).toEqual({ type: 'noauth' })
    expect(login.event[0].script.exec[0]).toBe('pm.collectionVariables.set("API_TOKEN", pm.response.json()["data"]["accessToken"]);')
    // Variáveis sem ambiente no pacote vão vazias na coleção; o token, não (o login define).
    expect(collection.variable.map((v: Obj) => v.key)).toEqual(['PASSWORD', 'USER'])
  })

  it('traduz a API vv dos scripts para o pm', () => {
    const { code, unsupported } = translateVvScript(
      "vv.request.setHeader('X-Id', vv.variables.get('ID'))\nvv.variables.set('TOKEN', vv.response.json().token)\nvv.phase"
    )
    expect(code).toContain("vvSetHeader('X-Id', pm.variables.get('ID'))")
    expect(code).toContain("pm.collectionVariables.set('TOKEN', pm.response.json().token)")
    expect(code.split('\n')[0]).toContain('pm.request.headers.upsert')
    expect(unsupported).toEqual(['vv.phase'])
  })
})

describe('exportação para OpenAPI', () => {
  it('monta a spec 3.1 com tags, bodySchema, exemplos, segurança e servidores por ambiente', async () => {
    const dir = seeded()
    const result = await exportAs(dir, { format: 'openapi' })
    expect(result.files.map((f) => f.suffix)).toEqual(['.openapi.json'])
    for (const secret of [VAULT_TOKEN, CLIENT_SECRET]) expect(result.files[0].text).not.toContain(secret)
    const spec = result.files[0].data as Obj
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info).toMatchObject({ title: 'Loja', version: '2.1.0' })
    expect(spec.servers).toEqual([
      { url: 'https://dev.loja.exemplo.com', description: 'Dev' },
      { url: 'https://loja.exemplo.com', description: 'Produção' }
    ])
    expect(spec.tags).toEqual([{ name: 'Cobranças', description: '# Cobranças\n\nComo cobrar.\n' }, { name: 'Público' }])

    const create = spec.paths['/v1/charges'].post
    expect(create).toMatchObject({ tags: ['Cobranças'], summary: 'Criar cobrança', operationId: 'createCharge' })
    expect(create.parameters).toEqual([
      { name: 'X-Tenant', in: 'header', description: 'No VVPost: {{TENANT}}', schema: { type: 'string' }, example: '{{TENANT}}' },
      { name: 'Idempotency-Key', in: 'header', description: 'No VVPost: {{$uuid}}', schema: { type: 'string' }, example: '{{$uuid}}' }
    ])
    const media = create.requestBody.content['application/json']
    expect(media.schema.properties.customer).toEqual({ $ref: '#/components/schemas/Customer' })
    expect(media.schema.$defs).toBeUndefined()
    expect(spec.components.schemas.Customer.properties.email).toEqual({ type: 'string', format: 'email' })
    expect(media.example).toEqual({ amount: 1000, currency: 'BRL', customer: { id: 'c1' } })
    expect(create.responses['201']).toEqual({
      description: 'Criada',
      headers: { Location: { schema: { type: 'string' }, example: '/v1/charges/ch_1' } },
      content: { 'application/json': { schema: chargeCreated, examples: { criada: { summary: 'Criada', value: { id: 'ch_1' } } } } }
    })
    expect(create.responses['422'].content['application/json'].examples.invalida.value).toEqual({ error: 'amount' })

    const get = spec.paths['/v1/charges/{chargeId}'].get
    expect(get.parameters[0]).toEqual({ name: 'chargeId', in: 'path', required: true, schema: { type: 'string' } })
    expect(get.responses).toEqual({ default: { description: 'Resposta' } })

    // OAuth2 com o tokenUrl absoluto (variável pública do ambiente) e as variáveis na descrição.
    expect(spec.components.securitySchemes.loja).toEqual({
      type: 'oauth2',
      flows: { clientCredentials: { tokenUrl: 'https://dev.loja.exemplo.com/oauth/token', scopes: { 'charges:read': '', 'charges:write': '' } } },
      description: 'Variáveis no VVPost: clientId {{CLIENT_ID}}, clientSecret {{CLIENT_SECRET}}.'
    })
    expect(get.security).toEqual([{ loja: ['charges:read', 'charges:write'] }])
    const upload = spec.paths['/files'].post
    expect(upload.security).toBeUndefined()
    expect(upload.requestBody.content['multipart/form-data']).toEqual({
      schema: { type: 'object', properties: { descricao: { type: 'string' }, arquivo: { type: 'string', format: 'binary' } } },
      example: { descricao: 'nota' }
    })
  })

  it('volta pelo importador de OpenAPI com o bodySchema, os exemplos e a auth', async () => {
    const result = await exportAs(seeded(), { format: 'openapi' })
    const prepared = prepareSources([{ file: 'loja.openapi.json', data: result.files[0].data }])
    expect(prepared.invalid).toEqual([])
    const connectors = new Map(prepared.result.connectors.map((c) => [c.name, c as Connector]))
    expect(connectors.get('Loja')!.config).toMatchObject({ baseUrl: 'https://dev.loja.exemplo.com', auth: { type: 'oauth2', grantType: 'client_credentials' } })
    const create = connectors.get('Cobranças')!.endpoints!.find((e) => e.id === 'createCharge')!
    expect(create.path).toBe('/v1/charges')
    const resolve = (s: Record<string, unknown> | undefined) => s && resolveSchemaRefs(s, (n) => prepared.result.schemas?.[n])
    // O Customer vira schema compartilhado; resolvido, o bodySchema é o mesmo que foi exportado.
    expect(create.bodySchema).toMatchObject({ properties: { customer: { $ref: 'schema:Customer' } } })
    expect(resolve(create.bodySchema)).toEqual(chargeSchema)
    expect(create.body).toEqual({ amount: 1000, currency: 'BRL', customer: { id: 'c1' } })
    expect(create.examples?.map((x) => x.status)).toEqual([201, 422])
    // O schema da resposta volta no exemplo.
    expect(create.examples?.map((x) => resolve(x.schema))).toEqual([chargeCreated, undefined])
  })

  it('URL base sem valor público vira variável do servidor, e operação de outra origem leva o servidor dela', async () => {
    const dir = workspace({
      'connectors/a.connector.vvpost.json': {
        id: 'a',
        name: 'A',
        version: '1.0.0',
        config: { baseUrl: '{{HOST}}/api' },
        endpoints: [
          { id: 'x', name: 'X', method: 'GET', path: '/x' },
          { id: 'y', name: 'Y', method: 'GET', path: '/y' }
        ]
      },
      'connectors/b.connector.vvpost.json': {
        id: 'b',
        name: 'B',
        version: '1.0.0',
        config: { baseUrl: 'https://b.exemplo.com' },
        endpoints: [{ id: 'z', name: 'Z', method: 'GET', path: '/z' }]
      }
    })
    const spec = (await exportAs(dir, { format: 'openapi' })).files[0].data as Obj
    expect(spec.servers).toEqual([{ url: '{HOST}/api', variables: { HOST: { default: '', description: 'Variável {{HOST}} do ambiente no VVPost.' } } }])
    expect(spec.paths['/z'].get.servers).toEqual([{ url: 'https://b.exemplo.com' }])
    expect(spec.paths['/z'].get.tags).toEqual(['B'])
  })

  it('recusa quando um exemplo carrega o valor de um segredo do vault', async () => {
    const dir = seeded({
      'connectors/vazou.connector.vvpost.json': {
        id: 'vazou',
        name: 'Vazou',
        version: '1.0.0',
        config: { baseUrl: 'https://x.exemplo.com' },
        endpoints: [{ id: 'e', name: 'E', method: 'GET', path: '/e', examples: [{ id: 'ok', name: 'OK', status: 200, body: { echo: CLIENT_SECRET } }] }]
      }
    })
    await expect(exportAs(dir, { format: 'openapi' })).rejects.toBeInstanceOf(ExportError)
    await expect(exportAs(dir, { format: 'postman' })).rejects.toThrow(/segredo/)
  })
})

describe('exportação no CLI e no MCP', () => {
  async function cli(args: string[], cwd: string) {
    let stdout = ''
    let stderr = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd, isTTY: false, appDir: cwd }
    const code = await main(args, io)
    return { code, stdout, stderr }
  }

  it('vvpost export --format postman grava a coleção e os ambientes ao lado; openapi em YAML', async () => {
    const source = seeded()
    const out = workspace()
    const pm = await cli(['export', '--workspace', source, '--format', 'postman', '--env', 'dev', '--out', 'loja.postman_collection.json'], out)
    expect(pm.code).toBe(0)
    expect(pm.stdout).toContain('Coleção do Postman gravada')
    expect(existsSync(join(out, 'loja.dev.postman_environment.json'))).toBe(true)
    expect(existsSync(join(out, 'loja.producao.postman_environment.json'))).toBe(false)

    const oa = await cli(['export', '--workspace', source, '--format', 'openapi', '--connector', 'loja.cobranca', '--out', 'loja.yaml'], out)
    expect(oa.code).toBe(0)
    const spec = parseYaml(readFileSync(join(out, 'loja.yaml'), 'utf8')) as Obj
    // O pai entra pela herança (servidor e auth), sem os endpoints dele.
    expect(Object.keys(spec.paths)).toEqual(['/v1/charges', '/v1/charges/{chargeId}'])
    expect(Object.keys(spec.components.securitySchemes)).toEqual(['loja'])
    for (const file of ['loja.postman_collection.json', 'loja.dev.postman_environment.json', 'loja.yaml']) {
      const text = readFileSync(join(out, file), 'utf8')
      for (const secret of [VAULT_TOKEN, CLIENT_SECRET]) expect(text).not.toContain(secret)
    }

    const bad = await cli(['export', '--workspace', source, '--format', 'insomnia'], out)
    expect(bad.code).toBe(2)
  })

  it('export_project com format devolve a coleção ou a spec', async () => {
    const dir = seeded()
    const call = async (args: Record<string, unknown>) => {
      const server = createMcpServer({ workspaceDir: dir, http: { send: async () => ({}) as never, cancel() {} }, auth: createAuthEngine() })
      const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export_project', arguments: args } })) as {
        result: { isError: boolean; content: { text: string }[] }
      }
      return { isError: res.result.isError, text: res.result.content[0]!.text, data: JSON.parse(res.result.content[0]!.text) }
    }
    const pm = await call({ format: 'postman', environments: ['prod'] })
    expect(pm.isError).toBe(false)
    expect(pm.data.collection.info.schema).toContain('v2.1.0')
    expect(pm.data.environments.map((e: Obj) => e.name)).toEqual(['Produção'])
    const oa = await call({ format: 'openapi', endpoints: ['loja.cobranca/getCharge'] })
    expect(Object.keys(oa.data.spec.paths)).toEqual(['/v1/charges/{chargeId}'])
    for (const r of [pm, oa]) for (const secret of [VAULT_TOKEN, CLIENT_SECRET]) expect(r.text).not.toContain(secret)
    expect((await call({ format: 'raml' })).isError).toBe(true)
  })
})
