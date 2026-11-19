import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createPiiMasker, loadPrivacyDetect, piiPlaceholder, sensitiveFields } from '@vvpost/core/pii'
import { validateJsonSchema } from '@vvpost/schemas'
import type { HttpRequestInput, HttpResult } from '@shared/ipc'
import { createMcpServer } from '../src/main/mcp/server'
import { convertOpenApi } from '../src/main/importers/openapi'
import { sanitizeIdentity } from '../src/main/enterprise/identity'
import { startWebhookServer } from '../src/main/webhooks/server'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'

// Dados pessoais no que vai ao agente: campos com x-sensitive sempre, e o resto pelo formato
// quando a detecção está ligada. O humano segue vendo os valores na interface.

const CPF = '529.982.247-25'
const CPF_RAW = '52998224725'
const CNPJ = '11.222.333/0001-81'
const EMAIL = 'ana.souza@exemplo.com.br'
const CARD = '4111 1111 1111 1111'
const PHONE = '(11) 98765-4321'
const NAME = 'Ana Souza'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'vvpost-pii-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const write = (dir: string, path: string, data: unknown) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
}

describe('marcação x-sensitive', () => {
  it('junta os campos marcados em qualquer profundidade, com o tipo', () => {
    const fields = sensitiveFields({
      type: 'object',
      properties: {
        cliente: {
          type: 'object',
          properties: {
            cpf: { type: 'string', 'x-sensitive': 'cpf' },
            nome_completo: { type: 'string', 'x-sensitive': true },
            apelido: { type: 'string', 'x-sensitive': false },
            emails: { type: 'array', items: { type: 'string', 'x-sensitive': 'email' } },
            outro: { type: 'string', 'x-sensitive': 'CPF' }
          }
        }
      },
      $defs: { Cartao: { properties: { numero: { 'x-sensitive': 'card' } } } }
    })
    expect(Object.fromEntries(fields)).toEqual({ cpf: 'cpf', nomecompleto: 'pii', emails: 'email', outro: 'cpf', numero: 'card' })
  })

  it('o validador de schemas do usuário aceita x-sensitive', () => {
    const schema = { type: 'object', properties: { cpf: { type: 'string', 'x-sensitive': 'cpf' } } }
    expect(validateJsonSchema(schema, { cpf: CPF }).ok).toBe(true)
  })
})

describe('createPiiMasker', () => {
  const marked = () => {
    const pii = createPiiMasker()
    pii.addSchema({ properties: { cpf: { 'x-sensitive': 'cpf' }, email: { 'x-sensitive': 'email' }, endereco: { 'x-sensitive': 'address' }, nome: { 'x-sensitive': true } } })
    return pii
  }

  it('sem marca nem detecção, nada muda', () => {
    const pii = createPiiMasker()
    const body = JSON.stringify({ cpf: CPF, email: EMAIL })
    expect(pii.text(body)).toBe(body)
  })

  it('mascara campos marcados em JSON, também dentro de texto JSON e em objetos e números', () => {
    const pii = marked()
    const out = pii.sanitize({
      clientes: [{ id: 1, cpf: CPF, Email: EMAIL, endereco: { rua: 'X', numero: 10 }, nome: NAME, cidade: 'SP' }],
      raw: JSON.stringify({ CPF: Number(CPF_RAW), email: null })
    })
    expect(out.clientes[0]).toEqual({
      id: 1,
      cpf: '[REDACTED_PII:cpf]',
      Email: '[REDACTED_PII:email]',
      endereco: '[REDACTED_PII:address]',
      nome: '[REDACTED_PII:pii]',
      cidade: 'SP'
    })
    expect(JSON.parse(out.raw)).toEqual({ CPF: '[REDACTED_PII:cpf]', email: null })
  })

  it('JSON cortado no meio, query e form também', () => {
    const pii = marked()
    const cut = `{"itens":[{"cpf":"${CPF}","nome":"${NAME}"},{"cpf":"${CPF.slice(0, 5)}`
    const out = pii.text(cut)
    expect(out).not.toContain(CPF)
    expect(out).not.toContain(NAME)
    expect(out).not.toContain(CPF.slice(0, 5))
    expect(pii.text(`https://api.exemplo.com/clientes?cpf=${CPF_RAW}&page=2`)).toBe('https://api.exemplo.com/clientes?cpf=[REDACTED_PII:cpf]&page=2')
    expect(pii.text(`email=${encodeURIComponent(EMAIL)}&x=1`)).toBe('email=[REDACTED_PII:email]&x=1')
  })

  it('header {name, value} com nome marcado', () => {
    const pii = marked()
    expect(pii.sanitize([{ name: 'Email', value: EMAIL }, { name: 'Accept', value: 'json' }])).toEqual([
      { name: 'Email', value: '[REDACTED_PII:email]' },
      { name: 'Accept', value: 'json' }
    ])
  })

  it('at: o valor de um caminho cujo último campo é marcado', () => {
    const pii = marked()
    expect(pii.at('body.clientes[0].cpf', CPF)).toBe('[REDACTED_PII:cpf]')
    expect(pii.at('body.clientes[0]', { cpf: CPF, id: 1 })).toEqual({ cpf: '[REDACTED_PII:cpf]', id: 1 })
    expect(pii.at('status', 200)).toBe(200)
  })

  it('detecção por padrão: CPF, CNPJ e cartão válidos, e-mail e telefone', () => {
    const pii = createPiiMasker({ detect: true })
    const text = `cliente ${NAME}, CPF ${CPF} (${CPF_RAW}), empresa ${CNPJ}, cartão ${CARD}, ${EMAIL}, tel ${PHONE} ou +5511987654321`
    const out = pii.text(text)
    for (const v of [CPF, CPF_RAW, CNPJ, CARD, EMAIL, PHONE, '+5511987654321']) expect(out).not.toContain(v)
    expect(out).toContain('[REDACTED_PII:cpf]')
    expect(out).toContain('[REDACTED_PII:cnpj]')
    expect(out).toContain('[REDACTED_PII:card]')
    expect(out).toContain('[REDACTED_PII:email]')
    expect(out).toContain('[REDACTED_PII:phone]')
  })

  it('detecção não pega número que só parece: dígito errado, timestamp, data, id, versão', () => {
    const pii = createPiiMasker({ detect: true })
    const keep = [
      'cpf 529.982.247-24',
      'ts 1730000000000',
      'em 2026-10-26T17:36:55Z',
      'pedido 12345678901234567',
      'versão 1.2.3',
      'ip 192.168.10.20',
      'uuid 123e4567-e89b-12d3-a456-426614174000',
      'R$ 1.234.567,89',
      'total: 4111'
    ]
    for (const t of keep) expect(pii.text(t), t).toBe(t)
  })

  it('detecção só dos tipos pedidos', () => {
    const pii = createPiiMasker({ detect: ['email'] })
    expect(pii.text(`${EMAIL} ${CPF}`)).toBe(`[REDACTED_PII:email] ${CPF}`)
    pii.addDetect(['cpf'])
    expect(pii.text(`${EMAIL} ${CPF}`)).toBe('[REDACTED_PII:email] [REDACTED_PII:cpf]')
    pii.addDetect(false)
    expect(pii.detecting.size).toBe(2)
  })

  it('placeholder não é mascarado de novo', () => {
    const pii = marked()
    const once = pii.text(JSON.stringify({ cpf: CPF }))
    expect(pii.text(once)).toBe(once)
    expect(piiPlaceholder('cpf')).toBe('[REDACTED_PII:cpf]')
  })
})

describe('.vvpost/privacy.json', () => {
  it('ausente é desligado; lista e true somam entre pastas', async () => {
    const root = tmp()
    const project = join(root, 'pagamentos')
    expect(await loadPrivacyDetect([root])).toEqual([])
    write(root, '.vvpost/privacy.json', { agent: { detect: ['email'] } })
    write(project, '.vvpost/privacy.json', { agent: { detect: ['cpf'] } })
    expect((await loadPrivacyDetect([project, root])).sort()).toEqual(['cpf', 'email'])
    write(root, '.vvpost/privacy.json', { $schema: 'https://vvpost.dev/schemas/v1/privacy.json', agent: { detect: true } })
    expect((await loadPrivacyDetect([root])).sort()).toEqual(['card', 'cnpj', 'cpf', 'email', 'phone'])
  })

  it('inválido é erro, não detecção desligada em silêncio', async () => {
    const root = tmp()
    write(root, '.vvpost/privacy.json', { agent: { detect: ['nome'] } })
    await expect(loadPrivacyDetect([root])).rejects.toThrow(/privacy.json inválido/)
    write(root, '.vvpost/privacy.json', '{ nao é json')
    await expect(loadPrivacyDetect([root])).rejects.toThrow(/não é JSON/)
  })
})

/** API que devolve dados de clientes, com o corpo maior que o preview de 4000 caracteres. */
function customersApi() {
  const customers = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, nome: NAME, cpf: CPF, contato: { email: EMAIL }, cidade: 'São Paulo' }))
  return {
    cancel() {},
    async send(input: HttpRequestInput): Promise<HttpResult> {
      const body = JSON.stringify({ observacao: `ligar em ${PHONE}`, total: customers.length, clientes: customers, url: input.url })
      return {
        ok: true,
        response: {
          status: 200,
          statusText: 'OK',
          headers: [{ name: 'content-type', value: 'application/json' }],
          body,
          sizeBytes: body.length,
          truncated: false,
          timings: { ttfbMs: 1, downloadMs: 0, totalMs: 1 }
        }
      }
    }
  }
}

function seed(dir: string): void {
  write(dir, 'schemas/Cliente.schema.json', {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      nome: { type: 'string', 'x-sensitive': 'name' },
      cpf: { type: 'string', 'x-sensitive': 'cpf' },
      contato: { type: 'object', properties: { email: { type: 'string', 'x-sensitive': 'email' } } }
    }
  })
  write(dir, 'connectors/crm.connector.vvpost.json', {
    $schema: 'https://vvpost.dev/schemas/v1/connector.json',
    id: 'crm',
    name: 'CRM',
    version: '1.0.0',
    config: { baseUrl: 'https://crm.exemplo.com' },
    endpoints: [
      {
        id: 'clientes',
        name: 'Clientes',
        method: 'GET',
        path: '/clientes',
        query: { cpf: CPF_RAW },
        examples: [{ id: 'ok', name: 'ok', status: 200, schema: { type: 'object', properties: { clientes: { type: 'array', items: { $ref: 'schema:Cliente' } } } } }],
        scenarios: [
          {
            id: 'ok',
            name: 'OK',
            capture: { primeiro: 'body.clientes[0].cpf' },
            assertions: [
              { target: 'status', operator: 'equals', expected: 200 },
              { target: 'body.clientes[0].cpf', operator: 'equals', expected: 'outro' },
              { target: 'body.clientes[0]', operator: 'notExists' }
            ]
          }
        ]
      }
    ]
  })
  write(dir, 'flows/clientes.flow.vvpost.json', {
    id: 'flow.clientes',
    name: 'Clientes',
    nodes: [{ id: 'lista', name: 'Lista', type: 'request', request: { connector: 'crm', endpoint: 'clientes' } }]
  })
}

describe('MCP', () => {
  const run = async (dir: string, options: Partial<Parameters<typeof createMcpServer>[0]> = {}) => {
    const server = createMcpServer({ workspaceDir: dir, http: customersApi(), auth: createAuthEngine(), ...options })
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
        result: { content: { text: string }[]; isError: boolean }
      }
      return res.result
    }
    return {
      call,
      outputs: [
        await call('execute_dry_run', { connectorId: 'crm', plan: true }),
        await call('execute_dry_run', { connectorId: 'crm' }),
        await call('execute_dry_run', { connectorId: 'crm', request: { endpointId: 'clientes' } }),
        await call('execute_dry_run', { connectorId: 'crm', request: { endpointId: 'clientes', select: ['clientes[].cpf', 'clientes[].id'] } }),
        await call('execute_dry_run', {
          connectorId: 'crm',
          request: { endpointId: 'clientes', assertions: [{ target: 'body.clientes[0].cpf', operator: 'equals', expected: CPF }] }
        }),
        await call('execute_flow', { flowId: 'flow.clientes' })
      ]
    }
  }

  it('campos x-sensitive (de um schema compartilhado) não chegam ao agente em nenhuma saída de execução', async () => {
    const dir = tmp()
    seed(dir)
    const { outputs } = await run(dir)
    const text = JSON.stringify(outputs)
    for (const o of outputs) expect(o.isError, o.content[0]!.text).toBe(false)
    for (const v of [CPF, CPF_RAW, EMAIL, NAME]) expect(text, v).not.toContain(v)
    expect(text).toContain('[REDACTED_PII:cpf]')
    expect(text).toContain('[REDACTED_PII:email]')
    expect(text).toContain('[REDACTED_PII:name]')
    // O que não é marcado segue: o agente ainda trabalha com a resposta.
    expect(text).toContain('São Paulo')
    // Sem detecção, o telefone em texto livre passa.
    expect(text).toContain('98765-4321')
    // A asserção da IA com o CPF verdadeiro falha: o passou/falhou não revela o valor.
    expect(outputs[4]!.content[0]!.text).toContain('"outcome":"failed"')
  })

  it('a IA não tira x-sensitive pelo edit_project; acrescentar pode', async () => {
    const dir = tmp()
    seed(dir)
    const { call } = await run(dir)
    const unmarked = {
      type: 'object',
      properties: { id: { type: 'integer' }, nome: { type: 'string', 'x-sensitive': 'name' }, cpf: { type: 'string' }, contato: { type: 'object' } }
    }
    const refused = await call('edit_project', { ops: [{ op: 'upsertSchema', name: 'Cliente', schema: unmarked }] })
    expect(refused.content[0]!.text).toContain('não tira a marca x-sensitive')
    expect(refused.content[0]!.text).toContain('cpf, email')
    const more = { ...unmarked, properties: { ...unmarked.properties, cpf: { type: 'string', 'x-sensitive': 'cpf' }, contato: { type: 'object', properties: { email: { type: 'string', 'x-sensitive': 'email' } } }, rg: { type: 'string', 'x-sensitive': 'rg' } } }
    const added = await call('edit_project', { ops: [{ op: 'upsertSchema', name: 'Cliente', schema: more }] })
    expect(added.isError, added.content[0]!.text).toBe(false)
    expect(added.content[0]!.text).toContain('"ok":true')
  })

  it('o que a IA lê do próprio projeto não muda', async () => {
    const dir = tmp()
    seed(dir)
    const { call } = await run(dir)
    const source = await call('get_source', { kind: 'connector', id: 'crm' })
    expect(source.content[0]!.text).toContain(CPF_RAW)
  })

  it('detecção pelo .vvpost/privacy.json, pelo servidor e pela política', async () => {
    const dir = tmp()
    seed(dir)
    const phone = (outputs: { content: { text: string }[] }[]) => JSON.stringify(outputs).includes('98765-4321')
    expect(phone((await run(dir)).outputs)).toBe(true)
    expect(phone((await run(dir, { piiDetect: ['phone'] })).outputs)).toBe(false)
    expect(phone((await run(dir, { piiPolicy: () => true })).outputs)).toBe(false)
    write(dir, '.vvpost/privacy.json', { agent: { detect: ['phone'] } })
    expect(phone((await run(dir)).outputs)).toBe(false)
    write(dir, '.vvpost/privacy.json', { agent: { detect: 'sim' } })
    const broken = (await run(dir)).outputs[0]!
    expect(broken.isError).toBe(true)
    expect(broken.content[0]!.text).toContain('INVALID_CONFIG')
  })
})

describe('webhooks pelo MCP', () => {
  it('evento com dado pessoal na query, no header e no corpo', async () => {
    const dir = tmp()
    seed(dir)
    const server = await startWebhookServer(dir, { port: 0, workspace: () => loadWorkspace(dir) })
    try {
      await fetch(`${server.url}/pagamento?cpf=${CPF_RAW}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', email: EMAIL },
        body: JSON.stringify({ pagador: { nome: NAME, cpf: CPF }, valor: 10 })
      })
      const mcp = createMcpServer({ workspaceDir: dir, http: customersApi(), auth: createAuthEngine(), webhooks: () => ({ url: server.url, inbox: server.inbox }) })
      const call = (name: string, args: Record<string, unknown>) => mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      const id = server.inbox.list()[0]!.id
      const text = JSON.stringify([await call('list_webhook_events', {}), await call('get_webhook_event', { id })])
      for (const v of [CPF, CPF_RAW, EMAIL, NAME]) expect(text, v).not.toContain(v)
      expect(text).toContain('\\"valor\\":10')
    } finally {
      await server.close()
    }
  })
})

describe('importador de OpenAPI', () => {
  it('mantém x-sensitive dos schemas da spec', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'CRM', version: '1' },
      servers: [{ url: 'https://crm.exemplo.com' }],
      paths: {
        '/clientes': {
          post: {
            operationId: 'criar',
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Cliente' } } } },
            responses: { '201': { description: 'ok' } }
          }
        }
      },
      components: {
        schemas: {
          Cliente: {
            type: 'object',
            properties: { cpf: { type: 'string', 'x-sensitive': 'cpf' }, nome: { type: 'string', 'x-internal': true } }
          }
        }
      }
    }
    const r = convertOpenApi('crm.json', spec, '/specs/crm.json')
    const text = JSON.stringify(r)
    expect(text).toContain('"x-sensitive":"cpf"')
    expect(text).not.toContain('x-internal')
  })
})

describe('política Enterprise', () => {
  it('agentPiiDetection chega ao core só quando é true', () => {
    const base = { available: true, session: { status: 'signedIn' as const, user: { name: 'Ana' } } }
    const policy = { secretsProxyEnabled: true, secretsBroker: false, allowWrites: false, allowedSecretProviders: [], allowedUpstreamHosts: [], fetchedAt: 'x' }
    expect(sanitizeIdentity({ ...base, policy: { ...policy, agentPiiDetection: true } }).policy?.agentPiiDetection).toBe(true)
    expect(sanitizeIdentity({ ...base, policy: { ...policy, agentPiiDetection: 'sim' as unknown as boolean } }).policy).not.toHaveProperty('agentPiiDetection')
  })
})
