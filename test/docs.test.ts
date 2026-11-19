import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { DocsError, generateDocumentation, type DocScope } from '@vvpost/core/docs'
import type { FlowCatalog } from '@shared/ipc'

/** Valores que nunca podem aparecer no documento: o do vault e o de uma variável com nome de credencial. */
const VAULT_SECRET = 'vault-s3cr3t-Xq9!value'
const ENV_TOKEN = 'plain-token-Zt72kq'

describe('documentação rica por nível da hierarquia', () => {
  let dir: string
  let ws: LoadedWorkspace
  let flows: FlowCatalog
  const put = (path: string, data: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  const generate = (scope: DocScope) =>
    generateDocumentation(ws, flows, scope, { projectName: 'Pagamentos', now: new Date('2026-10-24T12:00:00Z') })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-docs-'))
    put('connectors/base.connector.vvpost.json', {
      id: 'connector.corporate.base',
      name: 'Corporate Base',
      version: '1.0.0',
      config: {
        baseUrl: '{{BASE_URL}}',
        headers: { 'X-Tenant': 'corp', 'X-Trace': 'on' },
        auth: {
          type: 'oauth2',
          grantType: 'client_credentials',
          tokenUrl: '/oauth/token',
          clientId: '{{CLIENT_ID}}',
          clientSecret: '{{CLIENT_SECRET}}',
          scope: 'billing'
        }
      }
    })
    put('connectors/billing.connector.vvpost.json', {
      id: 'connector.billing.v2',
      name: 'Billing Service v2',
      version: '2.0.0',
      description: 'Cobranças **PIX** e cartão.',
      extends: 'connector.corporate.base',
      config: { basePath: '/billing/v2', headers: { 'X-Tenant': 'billing' } },
      endpoints: [
        {
          id: 'charge_customer',
          name: 'Efetuar Cobrança',
          method: 'POST',
          path: '/customers/{customerId}/charges',
          headers: { 'X-Trace': 'off', 'Idempotency-Key': '{{IDEMPOTENCY}}' },
          bodySchema: {
            type: 'object',
            required: ['amount', 'method'],
            properties: {
              amount: { type: 'number', description: 'Valor em reais' },
              method: { type: 'string', enum: ['PIX', 'CREDIT_CARD'] }
            }
          },
          body: { amount: 10, method: 'PIX' },
          scenarios: [
            {
              id: 'ok',
              name: 'Cobrança PIX aprovada',
              overrides: { pathParams: { customerId: 'c-1' } },
              assertions: [
                { target: 'status', operator: 'equals', expected: 201 },
                { target: 'body.id', operator: 'exists' }
              ]
            },
            {
              id: 'invalid',
              name: 'Valor negativo',
              overrides: { body: { amount: -1, method: 'BOLETO' }, headers: { 'X-Trace': null } },
              assertions: [{ target: 'status', operator: 'equals', expected: 422 }]
            }
          ]
        },
        { id: 'list_charges', name: 'Listar cobranças', method: 'GET', path: '/charges', requiresAuth: false, query: { limit: '20', token: '{{ACCESS_TOKEN}}' } }
      ]
    })
    put(
      'connectors/billing.connector.vvpost.md',
      ['# Billing', 'Visão geral do serviço.', '```mermaid', 'graph LR; A-->B', '```', '## Cobrar {#charge_customer}', 'Cria a cobrança. Nunca cole o secret ' + VAULT_SECRET + ' aqui.'].join(
        '\n'
      )
    )
    put('environments/dev.env.json', {
      id: 'dev',
      name: 'Desenvolvimento',
      variables: {
        BASE_URL: { type: 'string', value: 'https://dev.api.empresa.com' },
        CLIENT_ID: { type: 'string', value: 'billing-client' },
        CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
        ACCESS_TOKEN: { type: 'string', value: ENV_TOKEN }
      }
    })
    put('.vvpost/secrets.local.json', { dev: { CLIENT_SECRET: VAULT_SECRET } })
    put('flows/checkout.flow.vvpost.json', {
      id: 'flow.checkout',
      name: 'Checkout',
      nodes: [
        { id: 'login', name: 'Login', type: 'request', request: { method: 'POST', url: '{{BASE_URL}}/login' } },
        {
          id: 'charge',
          name: 'Charge',
          type: 'request',
          request: { connector: 'connector.billing.v2', endpoint: 'charge_customer', body: { amount: 1 } }
        }
      ],
      edges: [{ from: 'login', to: 'charge' }]
    })
    ws = await loadWorkspace(dir)
    flows = await loadFlows(dir)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('documenta o projeto inteiro com mapa, ambientes, variáveis e fluxos', async () => {
    const { document, markdown } = await generate({ kind: 'project' })
    expect(document.title).toBe('Documentação de Pagamentos')
    expect(document.project).toMatchObject({ connectors: 2, endpoints: 2, scenarios: 2, flows: 1 })
    expect(document.project.map).toContain('-->|herda|')
    expect(document.project.map).toContain('-.->|usa|')
    expect(document.connectors.map((c) => c.id)).toEqual(['connector.billing.v2', 'connector.corporate.base'])
    expect(markdown).toContain('## Sumário')
    expect(markdown).toContain('- [Conector Billing Service v2](#conector-billing-service-v2)')
    expect(markdown).toContain('```mermaid\ngraph LR')
    expect(markdown).toContain('| Checkout |')
    expect(document.variables.find((v) => v.name === 'ACCESS_TOKEN')).toMatchObject({ secret: true, values: {} })
  })

  it('mostra a herança efetiva com a origem e a auth sem valores', async () => {
    const { document, markdown } = await generate({ kind: 'connector', connectorId: 'connector.billing.v2' })
    const billing = document.connectors[0]!
    expect(document.connectors).toHaveLength(1)
    expect(billing.chain.map((c) => c.name)).toEqual(['Corporate Base', 'Billing Service v2'])
    expect(billing.effective?.headers.find((h) => h.name === 'X-Tenant')).toMatchObject({
      value: 'billing',
      from: 'connector.billing.v2',
      overrides: ['connector.corporate.base']
    })
    expect(billing.effective?.auth?.from).toBe('connector.corporate.base')
    expect(billing.effective?.auth?.details).toContainEqual({ name: 'clientSecret', value: '{{CLIENT_SECRET}}' })
    expect(billing.overview).toContain('Visão geral do serviço.')
    expect(markdown).toContain('| Header `X-Tenant` | `billing` | local, substitui Corporate Base |')
    expect(markdown).toContain('herdada de Corporate Base')
    expect(markdown).toContain('sequenceDiagram')
  })

  it('documenta um endpoint com headers efetivos, schema, cenários, sequência e fluxos', async () => {
    const { document, markdown } = await generate({
      kind: 'endpoint',
      connectorId: 'connector.billing.v2',
      endpointId: 'charge_customer'
    })
    const c = document.connectors[0]!
    expect(c.omittedEndpoints).toBe(1)
    const e = c.endpoints[0]!
    expect(document.title).toBe('POST /customers/{customerId}/charges · Efetuar Cobrança')
    expect(e.url).toBe('{{BASE_URL}}/billing/v2/customers/{customerId}/charges')
    expect(e.pathParams).toEqual(['customerId'])
    expect(e.docs).toBe('Cria a cobrança. Nunca cole o secret [REDACTED_SECRET] aqui.')
    expect(e.headers.find((h) => h.name === 'X-Trace')).toMatchObject({
      value: 'off',
      from: '(endpoint)',
      overrides: ['connector.corporate.base']
    })
    expect(e.scenarios.map((s) => s.expectedStatus)).toEqual([201, 422])
    expect(e.scenarios[1]!.check?.issues.length).toBeGreaterThan(0)
    expect(e.flows).toEqual([expect.objectContaining({ id: 'flow.checkout', nodes: ['Charge'] })])
    expect(e.flows[0]!.diagram).toContain('class n1 current')
    expect(e.diagrams.sequence).toContain('participant T as Token endpoint')
    expect(e.diagrams.sequence).toContain('C->>API: POST /billing/v2/customers/{customerId}/charges')
    expect(e.diagrams.sequence).toContain('alt Cobrança PIX aprovada')
    expect(e.diagrams.sequence).toContain('API-->>C: HTTP 422')
    expect(document.variables.map((v) => v.name)).toEqual(['BASE_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'IDEMPOTENCY'])
    expect(document.variables.find((v) => v.name === 'BASE_URL')?.values).toEqual({ dev: 'https://dev.api.empresa.com' })
    expect(document.variables.find((v) => v.name === 'CLIENT_SECRET')).toMatchObject({ secret: true, values: {} })
    expect(document.variables.find((v) => v.name === 'IDEMPOTENCY')?.missingIn).toEqual(['dev'])
    expect(markdown).toContain('#### Fluxos que usam este endpoint')
    expect(markdown).toContain('| `amount` | `number` | sim | Valor em reais |')
    expect(markdown).toContain('| `status` | `equals` | `201` |')
    expect(markdown).toContain('Mais 1 endpoint(s) do conector fora deste documento')
    expect(markdown).not.toContain('**Público.**')

    const publico = await generate({ kind: 'endpoint', connectorId: 'connector.billing.v2', endpointId: 'list_charges' })
    expect(publico.document.connectors[0]!.endpoints[0]!.requiresAuth).toBe(false)
    expect(publico.markdown).toContain('**Público.** Funciona sem credencial.')
    expect(publico.markdown).not.toContain('entra em cada chamada')
  })

  it('documenta uma request (cenário) só com ela', async () => {
    const { document, markdown } = await generate({
      kind: 'request',
      connectorId: 'connector.billing.v2',
      endpointId: 'charge_customer',
      scenarioId: 'invalid'
    })
    const e = document.connectors[0]!.endpoints[0]!
    expect(document.title).toBe('Request Valor negativo · POST /customers/{customerId}/charges')
    expect(e.scenarios.map((s) => s.id)).toEqual(['invalid'])
    expect(e.checks.map((k) => k.source)).toEqual(['body', 'invalid'])
    expect(markdown).toContain('| Header `X-Trace` | removido |')
    expect(markdown).not.toContain('Cobrança PIX aprovada')
  })

  it('recusa escopo que não existe', async () => {
    await expect(generate({ kind: 'connector', connectorId: 'nope' })).rejects.toBeInstanceOf(DocsError)
    await expect(
      generate({ kind: 'endpoint', connectorId: 'connector.billing.v2', endpointId: 'nope' })
    ).rejects.toThrow(/endpoint "nope"/)
    await expect(
      generate({ kind: 'request', connectorId: 'connector.billing.v2', endpointId: 'charge_customer', scenarioId: 'x' })
    ).rejects.toThrow(/request "x"/)
  })

  it('nunca leva valor de segredo, nem do vault nem de variável com nome de credencial', async () => {
    for (const scope of [
      { kind: 'project' },
      { kind: 'connector', connectorId: 'connector.corporate.base' },
      { kind: 'endpoint', connectorId: 'connector.billing.v2', endpointId: 'charge_customer' }
    ] as DocScope[]) {
      const { document, markdown } = await generate(scope)
      const text = `${markdown}\n${JSON.stringify(document)}`
      expect(text).not.toContain(VAULT_SECRET)
      expect(text).not.toContain(ENV_TOKEN)
    }
  })
})
