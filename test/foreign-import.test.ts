import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readVault, updateVault } from '@vvpost/core/vault'
import type { Connector, Endpoint } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { previewImport, prepareSources, writeImport, type PreparedImport } from '../src/main/importers'
import { parseBru } from '../src/main/importers/bruno'
import { convertPostman } from '../src/main/importers/postman'
import { parseImportText, readImportFile } from '../src/main/importers/source'
import { SECRETS_FILE } from '../src/main/importers/workspace'
import { parseXml } from '../src/main/importers/xml'
import { createMcpServer } from '../src/main/mcp/server'

const FIXTURES = join(__dirname, 'fixtures')

async function prepare(...paths: string[]): Promise<PreparedImport> {
  const sources = []
  for (const path of paths) {
    const full = join(FIXTURES, path)
    sources.push({ file: path.split('/').pop()!, data: await readImportFile(full), location: full })
  }
  return prepareSources(sources)
}

const connector = (p: PreparedImport, id: string): Connector => {
  const c = p.result.connectors.find((x) => x.id === id)
  if (!c) throw new Error(`conector ${id} não gerado: ${p.result.connectors.map((x) => x.id).join(', ')}`)
  return c
}
const endpoint = (p: PreparedImport, connectorId: string, id: string): Endpoint => {
  const e = connector(p, connectorId).endpoints?.find((x) => x.id === id)
  if (!e) throw new Error(`endpoint ${id} não está em ${connectorId}`)
  return e
}
const versioned = (p: PreparedImport) => JSON.stringify([p.result.connectors, p.result.environments])
const warnings = (p: PreparedImport) => p.result.warnings.map((w) => w.message).join('\n')

function expectClean(p: PreparedImport) {
  expect(p.readErrors).toEqual([])
  expect(p.result.errors).toEqual([])
  expect(p.invalid).toEqual([])
  // Nenhum valor que foi para o vault aparece num arquivo versionado (os curtos, como "loja", aparecem em nomes).
  const text = versioned(p)
  for (const s of p.result.secrets) if (s.value.length >= 8) expect(text).not.toContain(s.value)
}

describe('Insomnia', () => {
  it('v4: workspace vira conector raiz, pasta vira filho com a auth, e {{ _.x }} vira {{x}}', async () => {
    const p = await prepare('insomnia/loja.insomnia.json')
    expectClean(p)
    expect(p.result.sources).toEqual([{ file: 'loja.insomnia.json', kind: 'insomnia', name: 'Loja' }])
    expect(connector(p, 'connector.loja')).toMatchObject({ name: 'Loja', description: 'API da loja de exemplo.', config: { baseUrl: '{{base_url}}' } })
    expect(connector(p, 'connector.loja.pedidos')).toMatchObject({
      extends: 'connector.loja',
      config: { headers: { Authorization: 'Bearer {{token}}' } }
    })
    const listar = endpoint(p, 'connector.loja.pedidos', 'listar_pedidos')
    expect(listar).toMatchObject({
      method: 'GET',
      path: '/{{api_versao}}/pedidos',
      query: { status: 'aberto', pagina: '{{pagina}}' },
      headers: { Accept: 'application/json', 'X-Request-Id': '{{$uuid}}' }
    })
    expect(listar.query).not.toHaveProperty('debug')
    // insomnia.* é a API do Postman com outro nome: segue a tradução para vv.
    expect(listar.scripts?.post).toContain("vv.variables.set('ultimo', vv.response.json().id)")
    expect(listar.scenarios?.[0]).toMatchObject({ name: 'Status 200 (teste do Insomnia)' })
    expect(endpoint(p, 'connector.loja.pedidos', 'criar_pedido').body).toEqual({ item: 'livro', quando: '{{$isoTimestamp}}' })
    expect(endpoint(p, 'connector.loja', 'catalogo_graphql').body).toEqual({ query: 'query { produtos { id } }', variables: { n: 1 } })
  })

  it('v4: credenciais fixas vão para o vault; ambiente privado é segredo só no que ele define', async () => {
    const p = await prepare('insomnia/loja.insomnia.json')
    const login = endpoint(p, 'connector.loja', 'login')
    expect(login.headers).toEqual({ Authorization: 'Basic {{BASIC_CREDENTIALS}}' })
    expect(JSON.stringify(login.payload)).toContain('{{PASSWORD}}')
    expect(endpoint(p, 'connector.loja', 'catalogo_graphql').headers).toMatchObject({ 'X-Api-Key': '{{X_API_KEY}}' })
    const values = Object.fromEntries(p.result.secrets.map((s) => [`${s.environmentId}/${s.variable}`, s.value]))
    expect(values).toMatchObject({
      'env.loja/PASSWORD': 's3nh4-fixa',
      'env.loja/X_API_KEY': 'chave-da-api-123',
      'env.loja-producao/user': 'loja'
    })
    expect(Buffer.from(values['env.loja/BASIC_CREDENTIALS']!, 'base64').toString()).toBe('cliente:segredo-basic')
    const dev = p.result.environments.find((e) => e.id === 'env.loja-dev')!
    // O subambiente leva o base por baixo, e o JWT é segredo pelo formato.
    expect(dev.variables['base_url']).toEqual({ type: 'string', value: 'https://dev.loja.dev' })
    expect(dev.variables['api_versao']).toEqual({ type: 'string', value: 'v2' })
    expect(dev.variables['token']).toMatchObject({ isSecret: true, value: '__REQUIRED_SECRET__' })
    const prod = p.result.environments.find((e) => e.id === 'env.loja-producao')!
    expect(prod.variables['base_url']).toEqual({ type: 'string', value: 'https://api.loja.dev' })
    expect(prod.variables['user']).toMatchObject({ isSecret: true })
  })

  it('v4: avisa o que fica de fora (gRPC, tags de template sem equivalente)', async () => {
    const p = await prepare('insomnia/loja.insomnia.json')
    expect(warnings(p)).toContain('1 requisição(ões) grpc do Insomnia ficaram de fora')
    expect(warnings(p)).toContain('{% response %}')
  })

  it('v5 (YAML): pastas, digest como config.auth e scripts', async () => {
    const p = await prepare('insomnia/loja.insomnia.yaml')
    expectClean(p)
    expect(p.result.sources[0]).toMatchObject({ kind: 'insomnia', name: 'Loja v5' })
    expect(connector(p, 'connector.loja-v5.clientes').config?.auth).toEqual({ type: 'digest', username: '{{usuario}}', password: '{{DIGEST_PASSWORD}}' })
    expect(p.result.secrets).toContainEqual({ environmentId: 'env.loja-v5', variable: 'DIGEST_PASSWORD', value: 'senha-digest' })
    expect(endpoint(p, 'connector.loja-v5.clientes', 'ver_cliente')).toMatchObject({
      path: '/clientes/{id}',
      scripts: { pre: "vv.variables.set('agora', Date.now());" }
    })
  })

  it('o YAML do Insomnia é aceito mesmo com extensão .json', () => {
    const text = readFileSync(join(FIXTURES, 'insomnia/loja.insomnia.yaml'), 'utf8')
    expect(parseImportText(text, 'export.json')).toMatchObject({ type: 'collection.insomnia.rest/5.0' })
  })
})

describe('Bruno', () => {
  it('lê o formato .bru: blocos de dicionário, de texto, de lista e itens desligados', () => {
    const blocks = parseBru(readFileSync(join(FIXTURES, 'bruno/loja/pedidos/listar.bru'), 'utf8'))
    expect(blocks.get('get')!.pairs).toContainEqual({ name: 'url', value: '{{baseUrl}}/pedidos?status=aberto', enabled: true })
    expect(blocks.get('params:query')!.pairs).toContainEqual({ name: 'debug', value: '1', enabled: false })
    expect(blocks.get('tests')!.text).toBe('test("tem itens", function () {\n  expect(res.getStatus()).to.equal(200);\n});')
    const env = parseBru(readFileSync(join(FIXTURES, 'bruno/loja/environments/Dev.bru'), 'utf8'))
    expect(env.get('vars:secret')!.list).toEqual(['apiKey'])
  })

  it('pasta da coleção: pastas, herança de auth, assert e scripts traduzidos', async () => {
    const p = await prepare('bruno/loja')
    expectClean(p)
    expect(p.result.sources).toEqual([{ file: 'loja', kind: 'bruno', name: 'Loja Bruno' }])
    expect(connector(p, 'connector.loja-bruno')).toMatchObject({
      description: 'API da loja, pela coleção do Bruno.',
      config: { baseUrl: '{{baseUrl}}', headers: { Authorization: 'Bearer {{LOJA_TOKEN}}' } }
    })
    // folder.bru sem bloco auth herda (não vira "sem auth").
    expect(connector(p, 'connector.loja-bruno.pedidos').config?.headers).toBeUndefined()
    const pedidos = connector(p, 'connector.loja-bruno.pedidos').endpoints!.map((e) => e.id)
    expect(pedidos).toEqual(['criar_pedido', 'listar_pedidos'])
    const listar = endpoint(p, 'connector.loja-bruno.pedidos', 'listar_pedidos')
    expect(listar.query).toEqual({ status: 'aberto' })
    expect(listar.headers).toEqual({ 'X-Cliente': 'vvpost', Accept: 'application/json' })
    const post = listar.scripts!.post!
    expect(post).toContain('vv.variables.set("primeiro", vv.response.json().itens[0].id);')
    expect(post).toContain("vv.expect(vv.response.json().itens).to.be.an('array')")
    expect(post).toContain('vv.expect(vv.response.header("content-type")).to.include("json")')
    expect(post).toContain('vv.expect(vv.response.code).to.equal(200)')
    for (const left of ['res.getBody', 'res.getStatus', 'bru.setEnvVar']) expect(post).not.toContain(left)
    expect(listar.scenarios).toEqual([expect.objectContaining({ assertions: [{ target: 'status', operator: 'equals', expected: 200 }] })])
    expect(warnings(p)).toContain('res.foo: eq 1')
    const criar = endpoint(p, 'connector.loja-bruno.pedidos', 'criar_pedido')
    expect(criar.body).toEqual({ item: 'livro', qtd: 2 })
    expect(criar.headers).toMatchObject({ 'X-Api-Key': '{{apiKey}}', 'Content-Type': 'application/json' })
    expect(criar.scripts!.pre).toContain('vv.variables.set("pedidoId", "42");')
    expect(criar.scripts!.pre).toContain('vv.request.setHeader("X-Trace", vv.variables.get("trace"));')
    expect(warnings(p)).toContain('script usa bru.runRequest sem equivalente')
  })

  it('pasta da coleção: .env e vars:secret vão para o vault, e a auth AWS da requisição fica num conector filho', async () => {
    const p = await prepare('bruno/loja')
    expect(p.result.secrets).toContainEqual({ environmentId: 'env.loja-bruno-env', variable: 'LOJA_TOKEN', value: 'tok_live_abcdef123456' })
    // Só o que a coleção usa do .env entra.
    expect(JSON.stringify(p.result.secrets)).not.toContain('NAO_USADA')
    const dev = p.result.environments.find((e) => e.id === 'env.loja-bruno-dev')!
    expect(dev.variables).toEqual({
      baseUrl: { type: 'string', value: 'https://dev.loja.dev' },
      apiKey: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    })
    const upload = connector(p, 'connector.loja-bruno.pedidos.upload')
    expect(upload).toMatchObject({
      name: 'Pedidos (Upload)',
      extends: 'connector.loja-bruno.pedidos',
      config: {
        auth: { type: 'awsSigV4', accessKeyId: '{{AWS_ACCESS_KEY_ID}}', secretAccessKey: '{{AWS_SECRET_ACCESS_KEY}}', region: 'sa-east-1', service: 's3' }
      }
    })
    expect(upload.endpoints![0]!.payload).toEqual({ mode: 'multipart', fields: [{ name: 'nome', value: 'arquivo' }, { name: 'arquivo', file: 'docs/nota.pdf' }] })
    expect(p.result.secrets.map((s) => s.value)).toEqual(expect.arrayContaining(['AKIAABCDEFGHIJKLMNOP', 'segredo-aws']))
  })

  it('exportação JSON: pasta com digest, GraphQL e asserção de status', async () => {
    const p = await prepare('bruno/loja-export.json')
    expectClean(p)
    expect(p.result.sources[0]).toMatchObject({ kind: 'bruno', name: 'Loja exportada' })
    expect(connector(p, 'connector.loja-exportada.admin').config?.auth).toEqual({ type: 'digest', username: 'admin', password: '{{adminPassword}}' })
    expect(endpoint(p, 'connector.loja-exportada.admin', 'usuarios').body).toEqual({ query: '{ usuarios { id } }', variables: {} })
    expect(endpoint(p, 'connector.loja-exportada', 'ping').scenarios?.[0]?.assertions).toEqual([{ target: 'status', operator: 'equals', expected: 204 }])
    expect(warnings(p)).toContain('gRPC ou WebSocket do Bruno')
  })

  it('.bru soltos do mesmo lote formam uma coleção, e um .bru só de vars vira ambiente', async () => {
    const p = await prepare('bruno/loja/ping.bru', 'bruno/loja/pedidos/criar.bru', 'bruno/loja/environments/Dev.bru')
    expectClean(p)
    expect(p.result.sources).toEqual([{ file: '3 arquivos .bru', kind: 'bruno', name: 'loja' }])
    const root = p.result.connectors[0]!
    expect(root.endpoints!.map((e) => e.id).sort()).toEqual(['criar_pedido', 'ping'])
    expect(p.result.environments.map((e) => e.name)).toContain('loja (Dev)')
  })

  it('uma pasta que não é do Bruno dá erro de leitura claro', async () => {
    await expect(readImportFile(join(FIXTURES, 'wsdl'))).rejects.toThrow('não é uma coleção do Bruno')
  })
})

describe('HAR', () => {
  it('agrupa por origem e por método + caminho, sem estáticos, preflights e headers do navegador', async () => {
    const p = await prepare('har/loja.har')
    expectClean(p)
    expect(p.result.sources).toEqual([{ file: 'loja.har', kind: 'har', name: 'loja' }])
    expect(connector(p, 'connector.loja').config?.baseUrl).toBe('https://api.loja.dev')
    const api = connector(p, 'connector.loja.api-loja-dev')
    // O mesmo Authorization em todas as chamadas da origem vira a auth da pasta.
    expect(api.config?.headers).toEqual({ Authorization: 'Bearer {{BEARER_TOKEN}}' })
    expect(api.endpoints!.map((e) => `${e.method} ${e.path}`)).toEqual(['GET /v1/pedidos', 'POST /v1/pedidos'])
    const get = api.endpoints![0]!
    expect(get.headers).toEqual({ accept: 'application/json' })
    expect(get.query).toEqual({ pagina: '1' })
    expect(connector(p, 'connector.loja.auth-loja-dev').config?.baseUrl).toBe('https://auth.loja.dev')
    expect(warnings(p)).toContain('1 arquivo(s) estático(s), 1 preflight(s) de CORS')
    expect(warnings(p)).toContain('1 chamada(s) repetida(s)')
  })

  it('respostas viram exemplos, sem cookies nem credenciais no corpo', async () => {
    const p = await prepare('har/loja.har')
    const get = endpoint(p, 'connector.loja.api-loja-dev', 'get_v1_pedidos')
    expect(get.examples).toEqual([
      { id: '200_ok', name: '200 OK', status: 200, headers: { 'content-type': 'application/json' }, body: { itens: [{ id: 1 }], access_token: '<removido no import>' } },
      { id: '404_not_found', name: '404 Not Found', status: 404, body: { erro: 'nada' } }
    ])
    expect(endpoint(p, 'connector.loja.auth-loja-dev', 'post_oauth_token').examples?.[0]?.body).toEqual({ token_type: 'bearer' })
    expect(versioned(p)).not.toContain('nao-deveria-ir')
    expect(versioned(p)).not.toContain('sessao=abc')
    expect(p.result.secrets.map((s) => s.value)).toEqual(expect.arrayContaining(['cs-123456', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYXIifQ.YXNzaW5hdHVyYQ']))
  })
})

describe('WSDL', () => {
  it('cada serviço vira conector, cada operação um POST com SOAPAction e envelope do XSD', async () => {
    const p = await prepare('wsdl/calculadora.wsdl')
    expectClean(p)
    expect(p.result.sources).toEqual([{ file: 'calculadora.wsdl', kind: 'wsdl', name: 'CalculadoraService, LegadoService' }])
    const calc = connector(p, 'connector.calculadoraservice')
    expect(calc).toMatchObject({ description: 'Calculadora & conversões.', config: { baseUrl: 'https://soap.exemplo.dev' } })
    // As portas SOAP 1.2 do mesmo serviço não duplicam as operações.
    expect(calc.endpoints!.map((e) => e.id)).toEqual(['somar', 'cadastrar'])
    const somar = endpoint(p, 'connector.calculadoraservice', 'somar')
    expect(somar).toMatchObject({
      method: 'POST',
      path: '/calculadora.asmx',
      description: 'Soma dois inteiros.',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://exemplo.dev/calculadora/Somar"' }
    })
    expect(somar.body).toBe(
      [
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://exemplo.dev/calculadora">',
        '  <soapenv:Header/>',
        '  <soapenv:Body>',
        '    <tns:Somar>',
        '      <tns:a>0</tns:a>',
        '      <tns:b>0</tns:b>',
        '      <!-- Opcional: -->',
        '      <tns:nota>?</tns:nota>',
        '    </tns:Somar>',
        '  </soapenv:Body>',
        '</soapenv:Envelope>'
      ].join('\n')
    )
    const cadastrar = String(endpoint(p, 'connector.calculadoraservice', 'cadastrar').body)
    expect(cadastrar).toContain('<tns:endereco principal="false">')
    expect(cadastrar).toContain('<tns:uf>SP</tns:uf>')
    expect(cadastrar).toContain('<!-- Uma ou mais repetições: -->')
    expect(cadastrar).toContain('<tns:indicado/>')
    expect(warnings(p)).toContain('portas SOAP 1.2')
    // Mesmo método e caminho, mas actions diferentes: não são variações para mesclar em cenários.
    expect((await previewImport(p, null)).suggestions).toEqual([])
  })

  it('estilo rpc embrulha as partes no elemento da operação, no namespace do soap:body', async () => {
    const p = await prepare('wsdl/calculadora.wsdl')
    const dividir = endpoint(p, 'connector.legadoservice', 'dividir')
    expect(connector(p, 'connector.legadoservice').config?.baseUrl).toBe('http://legado.exemplo.dev:8080')
    expect(dividir.headers).toMatchObject({ SOAPAction: '"urn:Dividir"' })
    expect(String(dividir.body)).toContain('xmlns:tns="urn:legado"')
    expect(String(dividir.body)).toContain('<tns:Dividir>\n      <dividendo>0.0</dividendo>\n      <divisor>0.0</divisor>\n    </tns:Dividir>')
  })

  it('WSDL 2.0 e XML que não é WSDL dão erro', () => {
    const wsdl2 = prepareSources([{ file: 'x.wsdl', data: { $text: '<description xmlns="http://www.w3.org/ns/wsdl"/>' } }])
    expect(wsdl2.result.errors[0]!.message).toContain('WSDL 2.0')
    const other = prepareSources([{ file: 'x.xml', data: parseImportText('<?xml version="1.0"?><nota/>', 'x.xml') }])
    expect(other.result.errors[0]!.message).toContain('não é um WSDL')
  })

  it('o leitor de XML não expande entidades do DTD', () => {
    const root = parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x a="1 &amp; 2">&e;&lt;</x>')
    expect(root.attrs['a']).toBe('1 & 2')
    expect(root.text).toBe('&e;<')
    expect(() => parseXml('<a><b></a>')).toThrow('linha 1')
  })
})

describe('Postman: o que os novos importadores trouxeram', () => {
  const collection = (item: unknown[], auth?: unknown) => ({
    file: 'c.json',
    data: { info: { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item, ...(auth ? { auth } : {}) }
  })

  it('exemplos salvos (response) viram examples do endpoint', () => {
    const r = convertPostman([
      collection([
        {
          name: 'Ver',
          request: { method: 'GET', url: 'https://h.dev/x' },
          response: [{ name: 'Achou', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Authorization', value: 'x' }], body: '{"ok":true}' }]
        }
      ])
    ])
    expect(r.connectors[0]!.endpoints![0]!.examples).toEqual([{ id: 'achou', name: 'Achou', status: 200, headers: { 'Content-Type': 'application/json' }, body: { ok: true } }])
  })

  it('OAuth2 client credentials vira config.auth com o segredo no vault, e $timestamp não é aviso', () => {
    const r = convertPostman([
      collection([{ name: 'A', request: { method: 'GET', url: 'https://h.dev/a?t={{$timestamp}}' } }], {
        type: 'oauth2',
        oauth2: [
          { key: 'grant_type', value: 'client_credentials' },
          { key: 'accessTokenUrl', value: 'https://h.dev/token' },
          { key: 'clientId', value: 'app' },
          { key: 'clientSecret', value: 'cs-segredo' },
          { key: 'scope', value: 'ler' }
        ]
      })
    ])
    expect(r.connectors[0]!.config?.auth).toEqual({
      type: 'oauth2',
      grantType: 'client_credentials',
      tokenUrl: 'https://h.dev/token',
      clientId: 'app',
      clientSecret: '{{OAUTH2_CLIENT_SECRET}}',
      scope: 'ler'
    })
    expect(r.secrets).toContainEqual(expect.objectContaining({ variable: 'OAUTH2_CLIENT_SECRET', value: 'cs-segredo' }))
    expect(r.warnings.map((w) => w.message).join()).not.toContain('$timestamp')
  })
})

describe('gravação e MCP', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'vvpost-foreign-'))
    dirs.push(d)
    return d
  }

  it('grava pela camada de escrita, com os segredos só no vault', async () => {
    const dir = tmp()
    const p = await prepare('bruno/loja', 'har/loja.har', 'wsdl/calculadora.wsdl', 'insomnia/loja.insomnia.json')
    expectClean(p)
    const { written } = await writeImport(p, { dir, isWorkspace: true })
    expect(written).toContain('flows/connector.calculadoraservice/connector.calculadoraservice.flow.vvpost.json')
    expect(written).toContain('flows/connector.loja-bruno.pedidos.upload/connector.loja-bruno.pedidos.upload.flow.vvpost.json')
    const vault = (await readVault(dir))
    expect(vault['env.loja-bruno-env']).toEqual({ LOJA_TOKEN: 'tok_live_abcdef123456' })
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]))
    const versionedText = files(dir)
      .filter((f) => !f.endsWith('secrets.local.json'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    for (const s of p.result.secrets) if (s.value.length >= 8) expect(versionedText).not.toContain(s.value)
  })

  it('import_collection lê a pasta do Bruno dentro do projeto e não devolve os segredos', async () => {
    const dir = tmp()
    cpSync(join(FIXTURES, 'bruno/loja'), join(dir, 'bruno-loja'), { recursive: true })
    const server = createMcpServer({ workspaceDir: dir, http: { send: async () => ({ ok: false }) as never, cancel() {} }, auth: createAuthEngine() })
    const call = async (args: Record<string, unknown>) => {
      const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_collection', arguments: args } })) as {
        result: { isError: boolean; content: { text: string }[] }
      }
      return { isError: res.result.isError, text: res.result.content[0]!.text }
    }
    const plan = await call({ location: 'bruno-loja' })
    expect(plan.isError).toBe(false)
    expect(plan.text).toContain('connector.loja-bruno.pedidos')
    expect(plan.text).toContain('pendingSecrets')
    for (const secret of ['tok_live_abcdef123456', 'segredo-aws', 'AKIAABCDEFGHIJKLMNOP']) expect(plan.text).not.toContain(secret)

    const har = await call({ content: readFileSync(join(FIXTURES, 'har/loja.har'), 'utf8'), file: 'loja.har', apply: true })
    expect(har.isError).toBe(false)
    expect(readFileSync(join(dir, 'connectors/connector.loja.api-loja-dev.connector.vvpost.json'), 'utf8')).toContain('{{BEARER_TOKEN}}')

    const outside = await call({ location: '../fora' })
    expect(outside.isError).toBe(true)
    const postman = await call({ content: readFileSync(join(FIXTURES, 'postman/billing.postman_collection.json'), 'utf8'), file: 'billing.json' })
    expect(postman.text).toContain('import_postman')
  })
})
