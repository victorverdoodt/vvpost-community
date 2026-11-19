#!/usr/bin/env node
// Teste ponta a ponta do Catálogo de conectores no app real (build de produção em
// out/): abre um workspace com uma base corporativa, dois filhos e um órfão, confere a
// árvore de herança, a origem de cada valor herdado, a documentação viva (Markdown
// sanitizado, Mermaid do arquivo e diagramas gerados) e a validação de corpos pelo bodySchema.
// Uso: npm run build && node scripts/e2e-catalog.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}
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
      clientSecret: '{{CLIENT_SECRET}}'
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
      path: '/charges',
      bodySchema: {
        type: 'object',
        required: ['amount', 'customerId', 'method'],
        properties: {
          amount: { type: 'number', description: 'Valor em reais' },
          customerId: { type: 'string' },
          method: { type: 'string', enum: ['PIX', 'CREDIT_CARD'] }
        }
      },
      body: { amount: 150, customerId: 'cust_valid_1', method: 'PIX' },
      scenarios: [
        {
          id: 'tc_boleto',
          name: 'Boleto recusado',
          overrides: { body: { amount: 10, customerId: 'c1', method: 'BOLETO' } },
          assertions: [{ target: 'status', operator: 'equals', expected: 400 }]
        }
      ]
    }
  ]
})
put(
  'connectors/billing.connector.vvpost.md',
  [
    '# Guia do Billing',
    '',
    'Fluxo de cobrança: <img src="x" onerror="window.__xss = 1"> <script>window.__xss = 2</script>',
    '',
    '```mermaid',
    'graph LR',
    '  Pedido --> Cobranca --> Recibo',
    '```',
    '',
    '## Efetuar cobrança {#charge_customer}',
    '',
    'Cobra o cliente e devolve o status **PENDING**.'
  ].join('\n')
)
put('connectors/public.connector.vvpost.json', {
  id: 'connector.public',
  name: 'Public API',
  version: '1.0.0',
  extends: 'connector.corporate.base',
  config: { auth: { type: 'none' } }
})
put('connectors/orphan.connector.vvpost.json', {
  id: 'connector.orphan',
  name: 'Legado',
  version: '0.1.0',
  extends: 'connector.removido'
})

// Alterações da IA pelo MCP esperando revisão (src/main/project/review.ts): o painel do Catálogo mostra e aprova.
put('.vvpost/mcp-review.local.json', {
  'connector.billing.v2': { at: '2026-10-24T12:00:00.000Z', reason: 'auth: OAuth2 client credentials em /oauth/token (de connector.corporate.base)' },
  'flow:flow.qualquer': { at: '2026-10-24T12:00:00.000Z', reason: 'nós de código: Calc' }
})

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, workspace)

  await win.getByRole('button', { name: 'Catálogo' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Abrir workspace…' }).click()

  // Árvore: os filhos ficam dentro da base; o órfão vai para a raiz com o erro marcado.
  const tree = panel.getByRole('navigation', { name: 'Hierarquia de conectores' })
  await tree.getByText('Corporate Base').waitFor()
  const baseItem = tree.locator('li', { has: win.getByRole('button', { name: /Corporate Base/ }) }).first()
  assert.equal(await baseItem.getByRole('button', { name: /Billing Service v2/ }).count(), 1)
  assert.equal(await baseItem.getByRole('button', { name: /Public API/ }).count(), 1)
  assert.equal(await baseItem.getByRole('button', { name: /Legado/ }).count(), 0)

  // Herança: origem de cada valor e o header que o filho substitui.
  await tree.getByRole('button', { name: /Billing Service v2/ }).click()
  const config = panel.getByRole('table', { name: 'Configuração efetiva' })
  await config.getByText('{{BASE_URL}}/billing/v2').waitFor()
  await config.getByText('X-Tenant: billing').waitFor()
  await config.getByText('sobrescreve Corporate Base').waitFor()
  await config.getByText('X-Trace: on').waitFor()
  assert.ok((await config.getByText('herdado de Corporate Base').count()) >= 3)
  await panel.getByRole('img', { name: 'Hierarquia de Billing Service v2' }).locator('svg').waitFor()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-heranca.png') })

  await tree.getByRole('button', { name: /Public API/ }).click()
  await config.getByText('Desligada').waitFor()

  await tree.getByRole('button', { name: /Legado/ }).click()
  await panel.getByText('Herança quebrada: "connector.orphan" herda de "connector.removido"').waitFor()

  // Documentação viva: Markdown sanitizado, Mermaid do arquivo, diagrama de auth gerado.
  await tree.getByRole('button', { name: /Billing Service v2/ }).click()
  await panel.getByRole('tab', { name: 'Documentação' }).click()
  const docs = panel.getByRole('article', { name: 'Documentação de Billing Service v2' })
  await docs.getByRole('heading', { name: 'Guia do Billing' }).waitFor()
  await docs.locator('strong', { hasText: 'PIX' }).waitFor()
  await docs.locator('figure.mermaid-diagram svg').first().waitFor()
  await docs.getByRole('img', { name: 'Fluxo de autenticação de Billing Service v2' }).locator('svg').waitFor()
  assert.ok((await docs.locator('figure.mermaid-diagram svg').count()) >= 2)
  await docs.getByText('Cobra o cliente e devolve o status').waitFor()
  assert.equal(await docs.locator('script, [onerror]').count(), 0)
  assert.equal(await win.evaluate(() => window.__xss), undefined)

  // JSON Schema: corpo padrão válido, cenário com enum fora, e o validador interativo.
  const endpoint = docs.getByRole('region', { name: 'Endpoint Efetuar Cobrança' })
  await endpoint.getByText('1 corpo fora do schema').waitFor()
  const checks = endpoint.getByRole('list', { name: 'Validação dos corpos de Efetuar Cobrança' })
  await checks.getByText('Cenário: Boleto recusado').waitFor()
  await checks.getByText('/method').waitFor()
  await endpoint.getByRole('table', { name: 'Campos do corpo de Efetuar Cobrança' }).getByText('Valor em reais').waitFor()

  await endpoint.getByText('Validar um corpo com o schema').click()
  const input = endpoint.getByLabel('Corpo para validar em Efetuar Cobrança')
  await input.fill('{"amount": "10", "customerId": "c1", "method": "PIX"}')
  await endpoint.getByRole('button', { name: 'Validar' }).click()
  await endpoint.getByRole('status').getByText('1 problema').waitFor()
  await endpoint.getByRole('status').getByText('/amount').waitFor()
  await input.fill('{"amount": "{{AMOUNT}}", "customerId": "c1", "method": "PIX"}')
  await endpoint.getByRole('button', { name: 'Validar' }).click()
  await endpoint.getByRole('status').getByText('Corpo válido para o schema.').waitFor()

  // Revisão das alterações da IA: o que se confirma aparece, e aprovar limpa a marca no disco.
  const review = panel.getByRole('region', { name: 'Alterações da IA para revisar' })
  await review.getByText('2 alterações feitas pela IA aguardam').waitFor()
  await review.getByRole('button', { name: /aguardam sua revisão/ }).click()
  await review.getByText('auth: OAuth2 client credentials em /oauth/token', { exact: false }).waitFor()
  await review.getByText('nós de código: Calc', { exact: false }).waitFor()
  await review.getByRole('button', { name: 'Aprovar', exact: true }).first().click()
  await review.getByText('1 alteração feita pela IA aguarda').waitFor()
  await review.getByRole('button', { name: 'Aprovar todas' }).click()
  await review.waitFor({ state: 'detached' })
  assert.deepEqual(JSON.parse(readFileSync(join(workspace, '.vvpost/mcp-review.local.json'), 'utf8')), {})

  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E do Catálogo de conectores: ok')
