import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readVault, updateVault } from '@vvpost/core/vault'
import {
  convertPostman,
  isSecretName,
  looksLikeSecretValue,
  type PostmanImportResult,
  type PostmanSource
} from '../src/main/importers/postman'
import { writeImport } from '../src/main/importers'
import { SECRETS_FILE, planFiles, validateImport } from '../src/main/importers/workspace'

const fixture = (name: string): PostmanSource => ({
  file: name,
  data: JSON.parse(readFileSync(join(__dirname, 'fixtures/postman', name), 'utf8'))
})

const importAll = () =>
  convertPostman([fixture('billing.postman_collection.json'), fixture('dev.postman_environment.json')])

const connector = (r: PostmanImportResult, id: string) => {
  const c = r.connectors.find((x) => x.id === id)
  if (!c) throw new Error(`conector ${id} não gerado: ${r.connectors.map((x) => x.id).join(', ')}`)
  return c
}
const endpoint = (r: PostmanImportResult, connectorId: string, id: string) => {
  const e = connector(r, connectorId).endpoints?.find((x) => x.id === id)
  if (!e) throw new Error(`endpoint ${id} não está em ${connectorId}`)
  return e
}
const environment = (r: PostmanImportResult, id: string) => r.environments.find((e) => e.id === id)!

const ROOT = 'connector.servico-de-cobranca'
const CHARGES = `${ROOT}.cobrancas`

describe('convertPostman', () => {
  it('gera conectores e ambientes válidos pelos schemas v1', () => {
    const r = importAll()
    expect(r.errors).toEqual([])
    expect(validateImport(r)).toEqual([])
    expect(r.sources.map((s) => s.kind).sort()).toEqual(['collection', 'environment'])
  })

  it('coleção vira conector raiz com URL base, auth e versão; pastas viram filhos com extends', () => {
    const r = importAll()
    const root = connector(r, ROOT)
    expect(root).toMatchObject({
      name: 'Serviço de Cobrança',
      version: '2.3.1',
      description: 'API de cobrança usada nos testes do importador.',
      config: { baseUrl: '{{base_url}}', headers: { Authorization: 'Bearer {{accessToken}}' } }
    })
    expect(root.extends).toBeUndefined()
    expect(connector(r, CHARGES).extends).toBe(ROOT)
    expect(connector(r, `${CHARGES}.webhooks-legados`).extends).toBe(CHARGES)
    // Pai antes dos filhos, para quem lê os arquivos em ordem.
    const ids = r.connectors.map((c) => c.id)
    expect(ids.indexOf(ROOT)).toBeLessThan(ids.indexOf(CHARGES))
    expect(ids.indexOf(CHARGES)).toBeLessThan(ids.indexOf(`${CHARGES}.webhooks-legados`))
  })

  it('converte método, path com parâmetros de rota, query, headers e corpo JSON', () => {
    const r = importAll()
    expect(endpoint(r, CHARGES, 'criar_cobranca')).toEqual({
      id: 'criar_cobranca',
      name: 'Criar cobrança',
      method: 'POST',
      path: '/charges',
      query: { expand: 'items' },
      headers: { 'X-Tenant': '{{tenant}}', 'Content-Type': 'application/json' },
      body: { amount: 150.5, customerId: '{{customer_id}}', method: 'PIX' },
      scenarios: [
        {
          id: 'postman_status_201',
          name: 'Status 201 (teste do Postman)',
          assertions: [{ target: 'status', operator: 'equals', expected: 201 }]
        }
      ],
      // O teste do Postman vira script post com o pm.* traduzido.
      scripts: { post: "vv.test('ok', () => {\n  vv.expect(vv.response).to.have.status(201)\n})" }
    })
    expect(endpoint(r, CHARGES, 'buscar_cobranca').path).toBe('/charges/{chargeId}')
    // Mesmo nome no mesmo conector: o id ganha sufixo.
    expect(endpoint(r, CHARGES, 'buscar_cobranca_2').path).toBe('/charges/{chargeId}/items')
  })

  it('auth de pasta vai para o conector da pasta e segredo literal vira variável', () => {
    const r = importAll()
    const webhooks = connector(r, `${CHARGES}.webhooks-legados`)
    expect(webhooks.config).toEqual({ headers: { 'X-Api-Key': '{{X_API_KEY}}' } })
    expect(webhooks.endpoints![0]).toMatchObject({
      payload: {
        mode: 'urlencoded',
        fields: [
          { name: 'eventId', value: '{{eventId}}' },
          { name: 'client_secret', value: '{{CLIENT_SECRET}}' }
        ]
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Origem': 'postman' }
    })
  })

  it('form-data vira multipart com os campos de arquivo, e o caminho do arquivo vira aviso', () => {
    const r = importAll()
    const login = r.connectors.flatMap((c) => c.endpoints ?? []).find((e) => e.name === 'Login')!
    expect(login.payload).toEqual({
      mode: 'multipart',
      fields: [
        { name: 'username', value: '{{user}}' },
        { name: 'avatar', file: '/tmp/a.png' }
      ]
    })
    expect(login.body).toBeUndefined()
    expect(r.warnings.some((w) => /avatar" aponta para \/tmp\/a.png/.test(w.message))).toBe(true)
  })

  it('basic auth com valores fixos vira Basic {{BASIC_CREDENTIALS}} com o base64 só nos segredos', () => {
    const r = importAll()
    expect(endpoint(r, `${ROOT}.auth`, 'basic').headers).toEqual({
      Authorization: 'Basic {{BASIC_CREDENTIALS}}'
    })
    expect(r.secrets).toContainEqual({
      environmentId: 'env.servico-de-cobranca',
      variable: 'BASIC_CREDENTIALS',
      value: Buffer.from('admin:s3nh4').toString('base64')
    })
  })

  it('requisição com outra origem vai para um conector auxiliar que herda da pasta', () => {
    const r = importAll()
    const aux = connector(r, `${ROOT}.auth.auth-cobranca-com-br`)
    expect(aux).toMatchObject({
      extends: `${ROOT}.auth`,
      config: { baseUrl: 'https://auth.cobranca.com.br' }
    })
    expect(aux.endpoints!.map((e) => e.id)).toEqual(['login'])
    // Empate entre origens: a pasta fica com a herdada e não redefine baseUrl.
    expect(connector(r, `${ROOT}.auth`).config).toBeUndefined()
    const status = connector(r, `${ROOT}.status-cobranca-com-br`)
    expect(status.config).toEqual({ baseUrl: 'https://status.cobranca.com.br' })
    expect(status.endpoints![0]).toMatchObject({
      path: '/health',
      query: { api_key: '{{API_KEY}}' },
      headers: { Authorization: 'Bearer {{BEARER_TOKEN}}' }
    })
  })

  it('nenhum valor de segredo aparece nos arquivos versionáveis', () => {
    const r = importAll()
    const committed = planFiles(r)
      .map((f) => f.content)
      .join('\n')
    expect(r.secrets.length).toBeGreaterThan(0)
    for (const s of r.secrets) expect(committed).not.toContain(s.value)
    expect(committed).not.toContain('s3nh4')
  })

  it('variáveis: nomes inválidos são renomeados, segredos marcados e as usadas sem valor pedidas', () => {
    const r = importAll()
    const dev = environment(r, 'env.cobranca-dev')
    expect(dev.variables).toEqual({
      base_url: { type: 'string', value: 'https://dev.cobranca.com.br/v2' },
      // Usada no bearer da coleção: segredo, mesmo sem nome suspeito.
      accessToken: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
      db_password: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
      user: { type: 'string', value: 'maria' }
    })
    const col = environment(r, 'env.servico-de-cobranca')
    expect(col.variables['tenant']).toEqual({ type: 'string', value: 'acme' })
    expect(col.variables['accessToken']).toMatchObject({ isSecret: true, value: '__REQUIRED_SECRET__' })
    expect(col.variables['customer_id']).toMatchObject({ type: 'string', value: '' })
    expect(col.variables['chargeId']).toMatchObject({ value: '' })
    // Definida no ambiente importado: não é pedida de novo.
    expect(col.variables['user']).toBeUndefined()
    expect(r.secrets).toContainEqual({
      environmentId: 'env.cobranca-dev',
      variable: 'accessToken',
      value: 'token-dev'
    })
    expect(r.secrets).toContainEqual({
      environmentId: 'env.servico-de-cobranca',
      variable: 'accessToken',
      value: 'token-real-da-colecao'
    })
  })

  it('GraphQL vira corpo JSON e {{$guid}} vira {{$uuid}}', () => {
    const r = importAll()
    expect(endpoint(r, ROOT, 'graphql')).toMatchObject({
      query: { trace: '{{$uuid}}', ts: '{{$timestamp}}' },
      body: { query: 'query { charge(id: "{{chargeId}}") { id } }', variables: { x: 1 } },
      headers: { 'Content-Type': 'application/json' }
    })
  })

  it('avisa sobre o que não converte', () => {
    const messages = importAll().warnings.map((w) => `${w.source}: ${w.message}`)
    const expected = [
      /Login: no Postman este item não usa autenticação/,
      /Login: campo de arquivo "avatar" aponta/,
      /Vazia: pasta vazia/,
      /Socket: protocolo wss:\/\//,
      /Purge: método PURGE/,
      /2 script\(s\) de pre-request\/test viraram scripts pre e post.*1 verificação/
    ]
    for (const re of expected)
      expect(
        messages.some((m) => re.test(m)),
        `${re}\n${messages.join('\n')}`
      ).toBe(true)
    // {{$timestamp}} existe no VVPost com o mesmo sentido (segundos): não é aviso.
    expect(messages.join('\n')).not.toContain('$timestamp')
  })

  it('aceita o formato v2.0 (auth como objeto, request como string, headers em texto)', () => {
    const r = convertPostman([
      {
        file: 'v2.json',
        data: {
          info: {
            name: 'Legado',
            schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json'
          },
          auth: { type: 'apikey', apikey: { key: 'token', value: '{{apiToken}}', in: 'query' } },
          item: [
            { name: 'Listar', request: 'https://legado.exemplo.com/itens' },
            {
              name: 'Criar',
              request: {
                method: 'post',
                header: 'Content-Type: text/plain\nX-Trace: 1',
                body: { mode: 'raw', raw: 'olá' },
                url: 'https://legado.exemplo.com/itens'
              }
            }
          ]
        }
      }
    ])
    expect(validateImport(r)).toEqual([])
    const root = connector(r, 'connector.legado')
    expect(root.config).toEqual({ baseUrl: 'https://legado.exemplo.com' })
    // apikey em query não cabe no conector: vai para cada endpoint.
    expect(root.endpoints).toEqual([
      { id: 'listar', name: 'Listar', method: 'GET', path: '/itens', query: { token: '{{apiToken}}' } },
      {
        id: 'criar',
        name: 'Criar',
        method: 'POST',
        path: '/itens',
        query: { token: '{{apiToken}}' },
        headers: { 'Content-Type': 'text/plain', 'X-Trace': '1' },
        body: 'olá'
      }
    ])
    expect(environment(r, 'env.legado').variables['apiToken']).toMatchObject({ isSecret: true })
    expect(root.version).toBe('1.0.0')
  })

  it('recusa arquivos que não são coleção v2 nem ambiente', () => {
    const r = convertPostman([
      { file: 'v1.json', data: { id: 'x', name: 'Velha', requests: [], order: [] } },
      { file: 'lista.json', data: [1, 2] },
      { file: 'outro.json', data: { openapi: '3.1.0' } }
    ])
    expect(r.errors.map((e) => e.file)).toEqual(['v1.json', 'lista.json', 'outro.json'])
    expect(r.errors[0]!.message).toMatch(/v1 não é suportada/)
    expect(r.connectors).toEqual([])
  })

  it('ids de conector não colidem entre coleções com o mesmo nome', () => {
    const c = { info: { name: 'API' }, item: [{ name: 'Ping', request: 'https://a.com/ping' }] }
    const r = convertPostman([
      { file: 'a.json', data: c },
      { file: 'b.json', data: c }
    ])
    expect(r.connectors.map((x) => x.id)).toEqual(['connector.api', 'connector.api-2'])
    expect(validateImport(r)).toEqual([])
  })
})

describe('detecção de segredos', () => {
  it.each([
    ['accessToken', true],
    ['client_secret', true],
    ['DB_PASSWORD', true],
    ['x-api-key', true],
    ['subscriptionKey', true],
    ['auth', true],
    ['refresh-token', true],
    ['tokenUrl', false],
    ['token_type', false],
    ['author', false],
    ['partitionKey', false],
    ['base_url', false],
    ['client_id', false],
    ['username', false]
  ])('%s -> %s', (name, secret) => {
    expect(isSecretName(name)).toBe(secret)
  })

  it('reconhece valores com formato de credencial', () => {
    expect(looksLikeSecretValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln')).toBe(true)
    expect(looksLikeSecretValue('ghp_0123456789abcdefghijABCDEFGHIJ')).toBe(true)
    expect(looksLikeSecretValue('AKIAABCDEFGHIJKLMNOP')).toBe(true)
    expect(looksLikeSecretValue('https://api.exemplo.com')).toBe(false)
  })
})

describe('writeImport', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-import-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const prepared = (result: PostmanImportResult) => ({ id: 'teste', result, readErrors: [], invalid: [] })
  const target = () => ({ dir, isWorkspace: true })

  it('grava conectores, ambientes e segredos separados, com os segredos no cofre local, fora da pasta', async () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules')
    const r = importAll()
    const out = await writeImport(prepared(r), target())
    expect(out.written).toContain(`flows/${CHARGES}/${CHARGES}.flow.vvpost.json`)
    expect(out.written).toContain('environments/cobranca-dev.env.json')
    // Num projeto vazio o import grava fluxos; o conector que eles dão é o importado.
    const { $schema: _, ...imported } = connector(r, ROOT)
    expect((await loadWorkspace(dir)).connectors.get(ROOT)).toEqual(imported)
    const secrets = (await readVault(dir))
    expect(secrets['env.cobranca-dev']).toEqual({ accessToken: 'token-dev', db_password: 'senha-do-banco' })
    // O cofre fica fora da pasta: o .gitignore do projeto não muda.
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules')
    expect(existsSync(join(dir, SECRETS_FILE))).toBe(false)
  })

  it('reimportar mescla: mantém os segredos do vault, a não ser que o ambiente seja substituído', async () => {
    const r = importAll()
    await writeImport(prepared(r), target())
    const vault = (await readVault(dir))
    vault['env.outro'] = { X: '1' }
    vault['env.servico-de-cobranca']!['X_API_KEY'] = 'chave-local'
    await updateVault(dir, (store) => Object.assign(store, vault))

    await writeImport(prepared(r), target())
    let secrets = (await readVault(dir))
    expect(secrets['env.outro']).toEqual({ X: '1' })
    expect(secrets['env.servico-de-cobranca']!['X_API_KEY']).toBe('chave-local')

    await writeImport(prepared(r), target(), { environmentConflicts: { 'env.servico-de-cobranca': 'replace' } })
    secrets = (await readVault(dir))
    expect(secrets['env.servico-de-cobranca']!['X_API_KEY']).toBe('chave-fixa-123')
    // O arquivo antigo escrito à mão migrou para o cofre.
    expect(existsSync(join(dir, SECRETS_FILE))).toBe(false)
  })

  it('sem segredos, não cria arquivo de segredos nem .gitignore', async () => {
    const r = convertPostman([
      { file: 'a.json', data: { info: { name: 'A' }, item: [{ name: 'P', request: 'https://a.com/p' }] } }
    ])
    const out = await writeImport(prepared(r), target())
    expect(out).toEqual({ written: ['flows/connector.a/connector.a.flow.vvpost.json', 'flows/connector.a/p.flow.vvpost.json'] })
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
  })
})
