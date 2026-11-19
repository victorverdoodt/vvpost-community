import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connector } from '@vvpost/schemas'
import type { ConnectorRegistry } from '@shared/ipc'
import { buildRegistry, checkBody, schemaFields, splitDocs, validateEndpointBody } from '@vvpost/core/connectors/registry'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'

describe('documentação do conector em Markdown', () => {
  it('separa as seções {#endpoint} da visão geral', () => {
    const { overview, sections } = splitDocs(
      [
        '# Billing',
        'Visão geral.',
        '## Cobrar {#charge}',
        'Cria a cobrança.',
        '### Erros',
        '422 quando o PIX está desligado.',
        '## Glossário',
        'Termos.',
        '## Estornar {#refund}',
        '```md',
        '## Não é título {#charge}',
        '```'
      ].join('\n')
    )
    expect(overview).toBe('# Billing\nVisão geral.\n## Glossário\nTermos.')
    expect(sections.get('charge')).toBe('Cria a cobrança.\n### Erros\n422 quando o PIX está desligado.')
    expect(sections.get('refund')).toBe('```md\n## Não é título {#charge}\n```')
  })
})

describe('campos do bodySchema', () => {
  it('achata objetos, arrays e $ref locais', () => {
    const fields = schemaFields({
      type: 'object',
      required: ['amount', 'items'],
      properties: {
        amount: { type: 'number', description: 'Valor em reais' },
        method: { type: 'string', enum: ['PIX', 'CREDIT_CARD'] },
        items: { type: 'array', items: { $ref: '#/$defs/item' } }
      },
      $defs: { item: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } } }
    })
    expect(fields).toEqual([
      { path: 'amount', type: 'number', required: true, description: 'Valor em reais' },
      { path: 'method', type: 'string', required: false, values: ['"PIX"', '"CREDIT_CARD"'] },
      { path: 'items', type: 'array', required: true },
      { path: 'items[].sku', type: 'string', required: true }
    ])
  })
})

describe('Connector Registry', () => {
  let dir: string
  let ws: LoadedWorkspace
  let registry: ConnectorRegistry
  const put = (path: string, data: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data))
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-registry-'))
    const base: Connector = {
      id: 'corp.base',
      name: 'Corporate Base',
      version: '1.0.0',
      config: {
        baseUrl: 'https://{{HOST}}',
        headers: { 'X-Tenant': 'corp', 'X-Trace': 'on' },
        auth: {
          type: 'oauth2',
          grantType: 'client_credentials',
          tokenUrl: '/oauth/token',
          clientId: '{{CLIENT_ID}}',
          clientSecret: '{{CLIENT_SECRET}}'
        },
        tls: { pfx: 'certs/corp.p12' }
      }
    }
    const billing: Connector = {
      id: 'corp.billing',
      name: 'Billing',
      version: '2.0.0',
      description: 'Cobranças **PIX** e cartão.',
      extends: 'corp.base',
      config: { basePath: '/billing/v2', headers: { 'x-tenant': 'billing' } },
      endpoints: [
        {
          id: 'charge',
          name: 'Cobrar',
          method: 'POST',
          path: '/charges',
          bodySchema: {
            type: 'object',
            required: ['amount', 'customerId'],
            properties: { amount: { type: 'number' }, customerId: { type: 'string' } }
          },
          body: { amount: '{{AMOUNT}}', customerId: 'c1' },
          scenarios: [
            {
              id: 'negativo',
              name: 'Sem cliente',
              overrides: { body: { amount: 10 } },
              assertions: [{ target: 'status', operator: 'equals', expected: 400 }]
            },
            {
              id: 'ok',
              name: 'Válido',
              overrides: { body: { amount: 10, customerId: 'c1' } },
              assertions: [{ target: 'status', operator: 'equals', expected: 200 }]
            }
          ]
        },
        { id: 'list', name: 'Listar', method: 'GET', path: '/charges' }
      ]
    }
    const publicApi: Connector = {
      id: 'corp.public',
      name: 'Public',
      version: '1.0.0',
      extends: 'corp.base',
      config: { auth: { type: 'none' } }
    }
    put('connectors/base.connector.vvpost.json', base)
    put('connectors/billing.connector.vvpost.json', billing)
    put('connectors/public.connector.vvpost.json', publicApi)
    put('connectors/orphan.connector.vvpost.json', { id: 'corp.orphan', name: 'Órfão', version: '1.0.0', extends: 'corp.gone' })
    put('connectors/loop-a.connector.vvpost.json', { id: 'loop.a', name: 'Loop A', version: '1.0.0', extends: 'loop.b' })
    put('connectors/loop-b.connector.vvpost.json', { id: 'loop.b', name: 'Loop B', version: '1.0.0', extends: 'loop.a' })
    put(
      'connectors/billing.connector.vvpost.md',
      '# Billing\n\n```mermaid\ngraph LR; A-->B\n```\n\n## Cobrar {#charge}\nCria uma cobrança.\n\n## Antigo {#removido}\nx\n'
    )
    ws = await loadWorkspace(dir)
    registry = await buildRegistry(ws)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const get = (id: string) => registry.connectors.find((c) => c.id === id)!

  it('mostra a camada de cada arquivo e a origem de cada valor herdado', () => {
    const billing = get('corp.billing')
    expect(billing.chain).toEqual(['corp.base', 'corp.billing'])
    expect(billing.own).toEqual({ basePath: '/billing/v2', headers: [{ name: 'x-tenant', value: 'billing' }], tls: false })
    expect(billing.resolved).toMatchObject({
      baseUrl: { value: 'https://{{HOST}}/billing/v2', from: 'corp.base' },
      basePath: '/billing/v2',
      headers: [
        { name: 'x-tenant', value: 'billing', from: 'corp.billing', overrides: ['corp.base'] },
        { name: 'X-Trace', value: 'on', from: 'corp.base', overrides: [] }
      ],
      auth: { type: 'oauth2', from: 'corp.base' },
      tlsFrom: 'corp.base'
    })
    expect(get('corp.base').children).toEqual(['Billing', 'Public'])
    expect(billing.endpoints[0]!.url).toBe('https://{{HOST}}/billing/v2/charges')
  })

  it('aponta quem desliga a auth herdada', () => {
    const pub = get('corp.public')
    expect(pub.resolved?.auth).toBeUndefined()
    expect(pub.resolved?.authDisabledBy).toBe('corp.public')
    expect(pub.own.auth).toEqual({ type: 'none', summary: 'Sem auth (desliga a herdada)' })
    expect(pub.diagrams.auth).toBeUndefined()
  })

  it('marca herança quebrada sem derrubar o catálogo', () => {
    expect(get('corp.orphan').error).toContain('"corp.gone", que não existe')
    expect(get('corp.orphan').resolved).toBeUndefined()
    expect(get('corp.orphan').diagrams.hierarchy).toContain('não existe no workspace')
    expect(get('loop.a').error).toContain('herança circular')
    expect(get('loop.b').error).toContain('herança circular')
  })

  it('lê a documentação viva ao lado do conector', () => {
    const billing = get('corp.billing')
    expect(billing.docs).toEqual({
      file: 'connectors/billing.connector.vvpost.md',
      overview: '# Billing\n\n```mermaid\ngraph LR; A-->B\n```'
    })
    expect(billing.endpoints[0]!.docs).toBe('Cria uma cobrança.')
    expect(registry.issues).toContainEqual({
      file: 'connectors/billing.connector.vvpost.md',
      message: 'seção {#removido} não corresponde a nenhum endpoint de "corp.billing"'
    })
    expect(get('corp.base').docs).toBeUndefined()
  })

  it('gera os diagramas de herança e de auth', () => {
    const billing = get('corp.billing')
    expect(billing.diagrams.hierarchy).toContain('n0 --> n1')
    expect(billing.diagrams.hierarchy).toContain('class n1 current')
    expect(get('corp.base').diagrams.hierarchy).toMatch(/n0 --> n1[\s\S]*n0 --> n2/)
    expect(billing.diagrams.auth).toContain('V->>T: POST /oauth/token (grant_type=client_credentials)')
    expect(billing.diagrams.auth).toContain('auth herdada de Corporate Base')
  })

  it('confere corpos com o bodySchema, aceitando variáveis inteiras', () => {
    const charge = get('corp.billing').endpoints[0]!
    expect(charge.fields.map((f) => f.path)).toEqual(['amount', 'customerId'])
    expect(charge.checks).toEqual([
      { source: 'body', label: 'Corpo padrão', issues: [] },
      {
        source: 'negativo',
        label: 'Cenário: Sem cliente',
        issues: [{ path: '', message: expect.stringContaining('customerId') }]
      },
      { source: 'ok', label: 'Cenário: Válido', issues: [] }
    ])
    expect(get('corp.billing').endpoints[1]!.checks).toEqual([])
  })

  it('valida um corpo digitado', () => {
    expect(validateEndpointBody(ws, 'corp.billing', 'charge', '{"amount":1,"customerId":"x"}')).toEqual({ ok: true })
    expect(validateEndpointBody(ws, 'corp.billing', 'charge', '{"amount":"1","customerId":"x"}')).toEqual({
      ok: false,
      issues: [{ path: '/amount', message: expect.any(String) }]
    })
    expect(validateEndpointBody(ws, 'corp.billing', 'charge', '{')).toMatchObject({ ok: false, message: /JSON inválido/ })
    expect(validateEndpointBody(ws, 'corp.billing', 'list', '{}')).toEqual({
      ok: false,
      message: 'o endpoint não tem bodySchema'
    })
  })
})

describe('checkBody com variáveis no texto', () => {
  const schema = {
    type: 'object',
    properties: {
      codigo: { type: 'string', pattern: '^\d+-\d+-\d+$', maxLength: 12 },
      marca: { type: 'string', enum: ['porto', 'azul'] },
      valor: { type: 'number' }
    }
  }

  it('não conta padrão, tamanho e enum de um texto com variável dentro', () => {
    expect(checkBody(schema, { codigo: '{{$timestamp}}-1-1', marca: '{{MARCA}}x' })).toEqual([])
  })

  it('continua acusando o texto sem variável e o erro de tipo', () => {
    expect(checkBody(schema, { codigo: 'abc-1-1' }).map((i) => i.path)).toEqual(['/codigo'])
    expect(checkBody(schema, { valor: '{{V}} reais' })).toEqual([{ path: '/valor', message: expect.any(String) }])
  })
})
