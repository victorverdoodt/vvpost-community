import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LINT_FUNCTIONS, queryJsonPath, resolveRuleset, runLint, severityFor, type LintDocument } from '@vvpost/core/lint'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { main, type Io } from '../src/main/cli'
import { lintWorkspace } from '../src/main/lint'
import { createMcpServer } from '../src/main/mcp/server'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-lint-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const CONNECTOR = {
  id: 'pedidos',
  name: 'Pedidos',
  version: '1.0.0',
  config: { baseUrl: 'https://api.exemplo.com', basePath: '/v1' },
  endpoints: [
    {
      id: 'listar',
      name: 'Listar pedidos',
      description: 'Lista os pedidos do cliente.',
      method: 'GET',
      path: '/pedidos',
      scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }],
      examples: [{ id: 'ok', name: 'OK', status: 200, body: { itens: [] }, schema: { type: 'object' } }]
    },
    {
      id: 'buscar',
      name: 'buscar pedido',
      method: 'GET',
      path: '/Pedidos_Ativos/{pedido_id}/',
      scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'body.id', operator: 'exists' }] }],
      examples: [{ id: 'nf', name: 'Não encontrado', status: 404, body: { erro: 'x' } }],
      requiresAuth: true
    }
  ]
}

function seeded(extra: Record<string, unknown> = {}): string {
  return workspace({
    'connectors/pedidos.connector.vvpost.json': CONNECTOR,
    'environments/dev.env.json': {
      id: 'dev',
      name: 'Dev',
      variables: {
        BASE_URL: { type: 'string', value: 'https://api.exemplo.com' },
        API_TOKEN: { type: 'string', value: '' },
        tokenUrl: { type: 'string', value: 'https://auth.exemplo.com/token' },
        CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    },
    'docs/arquitetura.md': '# Arquitetura\n\nDiagrama C4 do sistema, sem citar endpoints.\n',
    'docs/pedidos.md': '# Pedidos\n\n{{> endpoint pedidos/listar}}\n',
    'docs/busca.md': '# Busca\n\nUse GET /Pedidos_Ativos/{pedido_id}/ para um pedido.\n',
    ...extra
  })
}

describe('JSONPath do lint', () => {
  const doc = {
    paths: { '/a': { get: { id: 1 }, post: { id: 2 }, parameters: [] }, '/b/': { put: { id: 3 } } },
    list: [{ n: 1, tag: 'x' }, { n: 2, tag: 'y' }, { n: 3 }],
    vars: { API_TOKEN: { v: 1 }, tokenUrl: { v: 2 }, password: { v: 3 } }
  }
  const values = (path: string) => queryJsonPath(doc, path).map((m) => m.value)
  const paths = (path: string) => queryJsonPath(doc, path).map((m) => m.path.join('.'))

  it('nomes, curinga, índices, fatias, uniões e descida recursiva', () => {
    expect(values('$.list[0].n')).toEqual([1])
    expect(values('$.list[-1].n')).toEqual([3])
    expect(values('$.list[0:2].n')).toEqual([1, 2])
    expect(values("$['list'][*].tag")).toEqual(['x', 'y'])
    expect(paths('$.paths[*][get,put]')).toEqual(['paths./a.get', 'paths./b/.put'])
    expect(values('$..id')).toEqual([1, 2, 3])
    expect(values('$.paths.*.*.id')).toEqual([1, 2, 3])
  })

  it('filtros com @, @property, comparações, lógica e métodos', () => {
    expect(values('$.list[?(@.n > 1 && @.tag)].n')).toEqual([2])
    expect(values('$.list[?(@.n === 1 || @.n == "3")].n')).toEqual([1, 3])
    expect(values('$.list[?(!@.tag)].n')).toEqual([3])
    expect(paths('$.vars[?(@property.match(/(token|password)$/i))]')).toEqual(['vars.API_TOKEN', 'vars.password'])
    expect(paths("$.paths[?(@property.startsWith('/b'))]")).toEqual(['paths./b/'])
    expect(values('$.list[?(@.tag.length == 1 && @.tag !== undefined)].n')).toEqual([1, 2])
  })

  it('filtro com código é recusado, não avaliado', () => {
    expect(() => queryJsonPath(doc, '$.list[?(@.constructor.constructor("return 1")())]')).toThrow(/não suportado|inesperado/)
    expect(() => queryJsonPath(doc, 'list[0]')).toThrow(/começar com \$/)
  })
})

describe('Funções do Spectral', () => {
  const run = (name: string, value: unknown, options: Record<string, unknown> = {}) => LINT_FUNCTIONS[name]!.run(value, options, { path: [], document: null }).length
  it('casing, pattern, length, enumeration, schema, alphabetical e xor', () => {
    expect(run('casing', 'pedidoId', { type: 'camel' })).toBe(0)
    expect(run('casing', 'pedido_id', { type: 'camel' })).toBe(1)
    expect(run('casing', 'pedidos-ativos', { type: 'kebab' })).toBe(0)
    expect(run('casing', 'PedidoAtivo', { type: 'pascal' })).toBe(0)
    expect(run('casing', 'PEDIDO_ATIVO', { type: 'macro' })).toBe(0)
    expect(run('casing', 'v1', { type: 'flat', disallowDigits: true })).toBe(1)
    expect(run('casing', 'a.b-c', { type: 'kebab', separator: { char: '.' } })).toBe(0)
    expect(run('pattern', 'Pedidos', { match: '/^p/i' })).toBe(0)
    expect(run('pattern', 'Pedidos', { notMatch: '^P' })).toBe(1)
    expect(run('length', [], { min: 1 })).toBe(1)
    expect(run('length', 'abc', { max: 2 })).toBe(1)
    expect(run('length', undefined, { min: 1 })).toBe(0)
    expect(run('enumeration', 'PUT', { values: ['GET', 'POST'] })).toBe(1)
    expect(run('schema', { a: 1 }, { schema: { type: 'object', required: ['b'] } })).toBe(1)
    expect(run('alphabetical', ['b', 'a'])).toBe(1)
    expect(run('xor', { a: 1, b: 2 }, { properties: ['a', 'b'] })).toBe(1)
    expect(run('truthy', '')).toBe(1)
    expect(run('defined', null)).toBe(0)
  })
})

describe('Ruleset', () => {
  it('extends, severidade por regra (nome, número, booleano), regras novas e overrides por pasta', async () => {
    const r = await resolveRuleset(
      {
        extends: [['vvpost:recommended', 'all']],
        rules: {
          'endpoint-description': 'error',
          'endpoint-scenario': 'off',
          'flow-description': 3,
          'name-capitalized': true,
          'id-kebab': { given: '$.connectors[*].endpoints[*]', severity: 'hint', then: { field: 'id', function: 'casing', functionOptions: { type: 'kebab' } } }
        },
        overrides: [{ files: ['legado/**'], rules: { 'endpoint-description': 'off' } }]
      },
      '.vvpost/ruleset.yaml'
    )
    expect(r.issues).toEqual([])
    expect(r.severity.get('endpoint-description')).toBe('error')
    expect(r.severity.get('endpoint-scenario')).toBe('off')
    expect(r.severity.get('flow-description')).toBe('hint')
    expect(r.severity.get('path-params-camel-case')).toBe('info')
    expect(r.severity.get('id-kebab')).toBe('hint')
    expect(r.rules.get('id-kebab')!.formats).toEqual(['vvpost'])
    expect(severityFor(r, 'endpoint-description', 'connectors/a.connector.vvpost.json')).toBe('error')
    expect(severityFor(r, 'endpoint-description', 'legado/b.connector.vvpost.json')).toBe('off')
  })

  it('o que não roda vira aviso do ruleset sem derrubar o resto', async () => {
    const r = await resolveRuleset(
      {
        extends: ['vvpost:recommended', 'https://exemplo.com/ruleset.yaml', 'spectral:asyncapi'],
        functions: ['minha-funcao'],
        aliases: { Endpoint: '$.connectors[*].endpoints[*]' },
        rules: {
          'nao-existe': 'error',
          'funcao-js': { given: '$.connectors[*]', then: { function: 'minhaFuncao' } },
          'path-ruim': { given: '$.connectors[?(@.x', then: { function: 'truthy' } },
          'com-alias': { given: '#Endpoint.path', then: { function: 'pattern', functionOptions: { notMatch: 'v2' } } }
        }
      },
      'ruleset.yaml'
    )
    expect(r.issues.join('\n')).toMatch(/por URL não é suportado/)
    expect(r.issues.join('\n')).toMatch(/spectral:asyncapi" não existe/)
    expect(r.issues.join('\n')).toMatch(/funções em JavaScript/)
    expect(r.issues.join('\n')).toMatch(/"nao-existe" não existe/)
    expect(r.issues.join('\n')).toMatch(/minhaFuncao" não existe/)
    expect(r.issues.join('\n')).toMatch(/path-ruim/)
    expect(r.rules.get('com-alias')!.given).toEqual(['$.connectors[*].endpoints[*].path'])
    await expect(resolveRuleset({ rules: [] }, 'x.yaml')).rejects.toThrow(/rules precisa ser um objeto/)
  })

  it('regras de OpenAPI só rodam no documento oas3, e o achado aponta para o arquivo de origem', async () => {
    const r = await resolveRuleset({ extends: ['spectral:oas'], rules: { 'sem-v2': { given: '$.paths', then: { field: '@key', function: 'pattern', functionOptions: { notMatch: '^/v2' } } } } }, 'r.yaml')
    expect(r.rules.get('sem-v2')!.formats).toEqual(['oas3'])
    const doc: LintDocument = {
      format: 'oas3',
      data: { openapi: '3.1.0', info: { title: 'x' }, paths: { '/v2/a': { get: { responses: { '404': {} } } } } },
      locate: (path) => ({ file: path[0] === 'paths' ? 'connectors/a.json' : 'vvpost.project.json' })
    }
    const codes = runLint([doc, { ...doc, format: 'vvpost' }], r).map((f) => `${f.code}@${f.file}`)
    expect(codes).toEqual(
      expect.arrayContaining(['sem-v2@connectors/a.json', 'operation-success-response@connectors/a.json', 'operation-description@connectors/a.json', 'info-contact@vvpost.project.json'])
    )
    expect(codes.length).toBe(new Set(codes).size)
  })
})

describe('spectral:oas: path-params e operation-parameters', () => {
  const run = async (paths: Record<string, unknown>) => {
    const r = await resolveRuleset({ extends: ['spectral:oas'] }, 'r.yaml')
    const doc: LintDocument = { format: 'oas3', data: { openapi: '3.1.0', info: {}, paths }, locate: () => ({ file: 'x.json' }) }
    return runLint([doc], r).filter((f) => f.code === 'path-params' || f.code === 'operation-parameters')
  }
  const param = (name: string, extra: object = {}) => ({ name, in: 'path', required: true, ...extra })

  it('acha variável sem parâmetro, parâmetro sobrando, required faltando, repetição e caminhos equivalentes', async () => {
    const found = await run({
      '/pedidos/{id}': { get: { parameters: [param('id')] } },
      '/pedidos/{pedidoId}': { delete: { parameters: [param('pedidoId')] } },
      '/a/{x}/b/{x}': { get: { parameters: [param('x')] } },
      '/c/{y}': { get: {}, put: { parameters: [param('y', { required: false }), param('z')] } },
      '/d/{w}': { parameters: [param('w')], get: {} }
    })
    const messages = found.map((f) => `${f.severity}: ${f.message}`)
    expect(messages).toEqual(
      expect.arrayContaining([
        'error: os caminhos /pedidos/{id} e /pedidos/{pedidoId} são equivalentes (só muda o nome das variáveis)',
        'error: a variável {x} aparece mais de uma vez em /a/{x}/b/{x}',
        'error: GET /c/{y}: a variável {y} não tem parâmetro in: path',
        'error: PUT /c/{y}: o parâmetro de caminho y precisa de required: true',
        'error: PUT /c/{y}: o parâmetro de caminho z não aparece no caminho'
      ])
    )
    // O parâmetro no caminho vale para a operação.
    expect(messages.some((m) => m.includes('/d/{w}'))).toBe(false)
    expect(found).toHaveLength(5)
  })

  it('acha parâmetro repetido na operação, com header sem caixa', async () => {
    const found = await run({
      '/e': { get: { parameters: [{ name: 'q', in: 'query' }, { name: 'q', in: 'query' }, { name: 'X-Id', in: 'header' }, { name: 'x-id', in: 'header' }, { name: 'q', in: 'header' }] } }
    })
    expect(found.map((f) => f.message)).toEqual([
      'o parâmetro q (in: query) aparece mais de uma vez na operação',
      'o parâmetro x-id (in: header) aparece mais de uma vez na operação'
    ])
  })

  it('a spec exportada do workspace aponta o caminho equivalente para o endpoint de origem', async () => {
    const dir = seeded({
      '.vvpost/ruleset.yaml': 'extends: [vvpost:recommended, spectral:oas]\n',
      'connectors/clientes.connector.vvpost.json': {
        id: 'clientes',
        name: 'Clientes',
        version: '1.0.0',
        config: { baseUrl: 'https://api.exemplo.com' },
        endpoints: [
          { id: 'ver', name: 'Ver', method: 'GET', path: '/clientes/{id}' },
          { id: 'apagar', name: 'Apagar', method: 'DELETE', path: '/clientes/{clienteId}' }
        ]
      }
    })
    const { findings } = await lintWorkspace(dir)
    const equivalent = findings.filter((f) => f.code === 'path-params')
    expect(equivalent).toHaveLength(1)
    expect(equivalent[0]).toMatchObject({ file: 'connectors/clientes.connector.vvpost.json', severity: 'error' })
  })
})

describe('connector-auth-consistent', () => {
  const connector = (id: string, config: object, endpoints: object[], extra: object = {}) => ({ id, name: id, version: '1.0.0', config: { baseUrl: 'https://api.exemplo.com', ...config }, endpoints, ...extra })
  const endpoint = (id: string, extra: object = {}) => ({ id, name: id, method: 'GET', path: `/${id}`, ...extra })
  const at = async (files: Record<string, unknown>) =>
    (await lintWorkspace(workspace(files))).findings.filter((f) => f.code === 'connector-auth-consistent').map((f) => `${f.label}: ${f.message}`)

  it('com auth no conector (ou herdada), acha o endpoint e o cenário que mandam credencial por fora', async () => {
    const found = await at({
      'connectors/base.connector.vvpost.json': connector('base', { auth: { type: 'apiKey', name: 'X-Chave', value: '{{CHAVE}}' } }, []),
      'connectors/loja.connector.vvpost.json': connector(
        'loja',
        {},
        [
          endpoint('ok'),
          endpoint('manual', { headers: { 'x-chave': '{{OUTRA}}' } }),
          endpoint('testa', { scenarios: [{ id: 'sem', name: 'Sem chave', overrides: { headers: { Authorization: 'Bearer x' } }, assertions: [{ target: 'status', operator: 'equals', expected: 401 }] }] })
        ],
        { extends: 'base' }
      )
    })
    expect(found).toEqual([
      'loja/manual: o endpoint manual manda x-chave por conta própria, além da auth apiKey do conector (herdada de base)',
      'loja/testa › cenário sem: o cenário testa/sem troca authorization da auth apiKey do conector (herdada de base)'
    ])
  })

  it('sem auth no conector, acha credencial em parte dos endpoints, em headers diferentes ou em todos à mão', async () => {
    const partial = await at({
      'connectors/a.connector.vvpost.json': connector('a', {}, [endpoint('um', { headers: { Authorization: 'Bearer {{T}}' } }), endpoint('dois')])
    })
    expect(partial).toEqual(['a: 1 de 2 endpoints mandam credencial no header (um) e 1 vão sem (dois)'])
    const mixed = await at({
      'connectors/b.connector.vvpost.json': connector('b', {}, [endpoint('um', { headers: { Authorization: '{{T}}' } }), endpoint('dois', { headers: { 'X-Api-Key': '{{K}}' } })])
    })
    expect(mixed).toEqual(['b: os endpoints do conector mandam credenciais em headers diferentes (authorization · x-api-key)'])
    const manual = await at({
      'connectors/c.connector.vvpost.json': connector('c', {}, [endpoint('um', { headers: { Authorization: '{{T}}' } })])
    })
    expect(manual).toEqual(['c: todos os endpoints mandam authorization à mão, sem auth no conector'])
    // Sem credencial em nenhum, ou com a auth e nada por fora: nada a dizer.
    expect(await at({ 'connectors/d.connector.vvpost.json': connector('d', { auth: { type: 'bearer', token: '{{T}}' } }, [endpoint('um'), endpoint('dois', { headers: { Accept: 'x' } })]) })).toEqual([])
  })
})

describe('Lint do workspace', () => {
  it('vvpost:recommended acha estilo e erros comuns, com a linha no arquivo', async () => {
    const dir = seeded()
    const { findings, ruleset, summary } = await lintWorkspace(dir)
    expect(ruleset).toBeUndefined()
    const at = (code: string) => findings.filter((f) => f.code === code).map((f) => `${f.label}@${f.file}:${f.line ?? ''}`)
    expect(at('connector-description')).toEqual(['pedidos@connectors/pedidos.connector.vvpost.json:1'])
    expect(at('endpoint-description')).toEqual(['pedidos/buscar@connectors/pedidos.connector.vvpost.json:43'])
    expect(at('path-kebab-case')).toHaveLength(1)
    expect(at('path-no-trailing-slash')).toHaveLength(1)
    expect(at('example-schema')).toEqual(['pedidos/buscar › exemplo Não encontrado (404)@connectors/pedidos.connector.vvpost.json:61'])
    expect(at('endpoint-success-example')).toHaveLength(1)
    expect(at('scenario-status-assertion')).toEqual(['pedidos/buscar › cenário ok@connectors/pedidos.connector.vvpost.json:54'])
    // Só o listar não diz se exige auth.
    expect(findings.filter((f) => f.code === 'endpoint-requires-auth').map((f) => [f.label, f.severity])).toEqual([['pedidos/listar', 'info']])
    // tokenUrl não tem nome de credencial; CLIENT_SECRET já é segredo.
    expect(at('secret-not-marked')).toEqual(['ambiente dev, variável API_TOKEN@environments/dev.env.json:9'])
    // A página de arquitetura não cita endpoint; a de busca cita pelo método e caminho.
    expect(at('doc-references-endpoint')).toEqual(['Arquitetura@docs/arquitetura.md:'])
    // Desligadas no recomendado.
    expect(at('path-params-camel-case')).toEqual([])
    expect(at('name-capitalized')).toEqual([])
    expect(summary.error).toBe(0)
    const endpoint = findings.find((f) => f.code === 'endpoint-description')!
    expect(endpoint.target).toEqual({ kind: 'endpoint', connectorId: 'pedidos', endpointId: 'buscar' })
    expect(endpoint.hint).toMatch(/description/)
  })

  it('ruleset do time em .vvpost/ruleset.yaml, com regra própria, override e regras de OpenAPI', async () => {
    const dir = seeded({
      '.vvpost/ruleset.yaml': [
        'extends:',
        '  - vvpost:recommended',
        '  - spectral:oas',
        'rules:',
        '  endpoint-description: error',
        '  info-contact: off',
        '  path-params-camel-case: warn',
        '  nome-do-cenario:',
        '    description: Cenário com nome de pelo menos 3 letras',
        '    message: "nome curto: {{value}}"',
        '    severity: error',
        '    given: $.connectors[*].endpoints[*].scenarios[*].name',
        '    then:',
        '      function: length',
        '      functionOptions: { min: 3 }',
        'overrides:',
        '  - files: ["docs/**"]',
        '    rules:',
        '      doc-references-endpoint: off'
      ].join('\n')
    })
    const { findings, ruleset, issues, summary } = await lintWorkspace(dir)
    expect(issues).toEqual([])
    expect(ruleset).toBe('.vvpost/ruleset.yaml')
    const codes = findings.map((f) => `${f.severity} ${f.code} ${f.label}`)
    expect(codes).toContain('error endpoint-description pedidos/buscar')
    expect(codes).toContain('warn path-params-camel-case pedidos/buscar')
    expect(codes).toContain('error nome-do-cenario pedidos/listar › cenário ok')
    expect(codes.some((c) => c.includes('doc-references-endpoint'))).toBe(false)
    expect(codes.some((c) => c.includes('info-contact'))).toBe(false)
    // OpenAPI: a operação sem descrição volta ao endpoint de origem, com o caminho do basePath.
    const op = findings.find((f) => f.code === 'operation-description')!
    expect(op).toMatchObject({ file: 'connectors/pedidos.connector.vvpost.json', format: 'oas3', target: { kind: 'endpoint', endpointId: 'buscar' } })
    expect(op.label).toBe('pedidos/buscar (OpenAPI GET /v1/Pedidos_Ativos/{pedido_id})')
    expect(op.line).toBe(43)
    expect(summary.error).toBe(3)
  })

  it('projeto sem ruleset usa o da raiz do workspace', async () => {
    const dir = workspace({
      '.vvpost/ruleset.yaml': 'extends: [vvpost:recommended]\nrules:\n  connector-description: error\n',
      'loja/vvpost.project.json': { id: 'loja', name: 'Loja' },
      'loja/connectors/pedidos.connector.vvpost.json': CONNECTOR
    })
    const { findings, ruleset } = await lintWorkspace(join(dir, 'loja'))
    expect(ruleset).toBe('../.vvpost/ruleset.yaml')
    expect(findings.find((f) => f.code === 'connector-description')!.severity).toBe('error')
  })
})

interface Captured {
  code: number
  stdout: string
  stderr: string
}

async function cli(dir: string, args: string[]): Promise<Captured> {
  let stdout = ''
  let stderr = ''
  const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd: dir, isTTY: false, appDir: dir }
  const code = await main(['--workspace', dir, ...args], io)
  return { code, stdout, stderr }
}

describe('vvpost lint', () => {
  it('texto, sai com 0 só com avisos e com 2 a partir do --fail-on', async () => {
    const dir = seeded()
    const ok = await cli(dir, ['lint'])
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('connectors/pedidos.connector.vvpost.json')
    expect(ok.stdout).toMatch(/43 {2}aviso {2}endpoint-description +pedidos\/buscar: endpoint sem descrição/)
    expect(ok.stdout).toContain('Ruleset: vvpost:recommended (padrão)')
    expect((await cli(dir, ['lint', '--fail-on', 'warn'])).code).toBe(2)
    expect((await cli(dir, ['lint', '--fail-on', 'grave'])).code).toBe(2)
    const quiet = await cli(dir, ['lint', '--quiet'])
    expect(quiet.stdout).not.toContain('doc-references-endpoint')
  })

  it('JSON, JUnit e SARIF; erro do ruleset sai com 2', async () => {
    const dir = seeded({ 'regras.yaml': 'extends: vvpost:recommended\nrules:\n  endpoint-example: off\n  example-schema: error\n' })
    const r = await cli(dir, ['lint', '--ruleset', 'regras.yaml', '--junit', 'out/lint.xml', '--sarif', 'out/lint.sarif', '--json', '-'])
    expect(r.code).toBe(2)
    const json = JSON.parse(r.stdout)
    expect(json).toMatchObject({ version: 1, ruleset: 'regras.yaml', summary: { error: 1 } })
    expect(json.findings[0].pointer).toBeUndefined()
    const junit = readFileSync(join(dir, 'out/lint.xml'), 'utf8')
    expect(junit).toContain('<testsuites name="vvpost lint" tests="1" failures="1">')
    expect(junit).toContain('type="error"')
    const sarif = JSON.parse(readFileSync(join(dir, 'out/lint.sarif'), 'utf8'))
    expect(sarif.version).toBe('2.1.0')
    const result = sarif.runs[0].results.find((x: { ruleId: string }) => x.ruleId === 'example-schema')
    expect(result).toMatchObject({ level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: 'connectors/pedidos.connector.vvpost.json' }, region: { startLine: 61 } } }] })
    expect(sarif.runs[0].tool.driver.rules.map((x: { id: string }) => x.id)).toContain('example-schema')

    writeFileSync(join(dir, 'ruim.yaml'), 'rules: [1, 2]\n')
    const bad = await cli(dir, ['lint', '--ruleset', 'ruim.yaml'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('rules precisa ser um objeto')
  })

  it('validate --lint: erro do lint reprova, aviso só aparece', async () => {
    const dir = seeded()
    const warned = await cli(dir, ['validate', '--lint'])
    expect(warned.code).toBe(0)
    expect(warned.stderr).toContain('aviso: connectors/pedidos.connector.vvpost.json:43: [endpoint-description] pedidos/buscar: endpoint sem descrição')
    mkdirSync(join(dir, '.vvpost'), { recursive: true })
    writeFileSync(join(dir, '.vvpost/ruleset.yaml'), 'extends: vvpost:recommended\nrules:\n  endpoint-description: error\n')
    const failed = await cli(dir, ['validate', '--lint'])
    expect(failed.code).toBe(2)
    expect(failed.stderr).toContain('[endpoint-description]')
    // Sem --lint, o validate não muda.
    expect((await cli(dir, ['validate'])).code).toBe(0)
  })
})

describe('MCP: lint', () => {
  const http = { cancel() {}, send: async () => ({ ok: false, error: { code: 'NETWORK', message: 'sem rede' } }) as never }
  async function call(dir: string, name: string, args: Record<string, unknown>) {
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
    const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
  }

  it('lint_project filtra por nível, arquivo e regra, com code e hint', async () => {
    const dir = seeded()
    const all = await call(dir, 'lint_project', {})
    expect(all.data.ruleset).toBe('vvpost:recommended')
    const warn = await call(dir, 'lint_project', { severity: 'warn', code: 'endpoint-description' })
    expect(warn.data.findings).toEqual([
      expect.objectContaining({ code: 'endpoint-description', severity: 'warn', file: 'connectors/pedidos.connector.vvpost.json', line: 43, where: 'pedidos/buscar', hint: expect.any(String) })
    ])
    expect((await call(dir, 'lint_project', { file: 'docs/' })).data.findings.every((f: { file: string }) => f.file.startsWith('docs/'))).toBe(true)
  })

  it('a escrita devolve só os achados novos do lint', async () => {
    const dir = seeded()
    await call(dir, 'lint_project', {})
    const res = await call(dir, 'edit_project', { ops: [{ op: 'upsertEndpoint', connectorId: 'pedidos', endpoint: { id: 'criar', name: 'Criar pedido', method: 'POST', path: '/pedidos' } }] })
    expect(res.data.ok).toBe(true)
    const fresh = res.data.lint.new.map((f: { code: string; where: string }) => `${f.code} ${f.where}`)
    expect(fresh).toEqual(expect.arrayContaining(['endpoint-description pedidos/criar', 'endpoint-example pedidos/criar', 'endpoint-scenario pedidos/criar']))
    expect(fresh.every((f: string) => f.endsWith('pedidos/criar'))).toBe(true)
    expect(res.data.lint.hint).toMatch(/lint_project/)
  })
})
