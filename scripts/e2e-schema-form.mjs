#!/usr/bin/env node
// Teste ponta a ponta do formulário tipado do corpo e do arraste de endpoints para o Flow Studio
// no app real (build de produção em out/): um endpoint com bodySchema (enum, objeto aninhado,
// lista e obrigatórios) abre no Quick Request como formulário, o JSON raw mostra o que o form
// montou e o envio sai com a herança do conector. No Flow Studio, o mesmo endpoint arrastado do
// catálogo para o canvas vira um nó que referencia conector e endpoint, mostra o que herda,
// edita o corpo pelo formulário e roda com a auth e os headers da base.
// Uso: npm run build && node scripts/e2e-schema-form.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
const API_TOKEN = 'token-e2e-form'

const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, tenant: req.headers['x-tenant'], body })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'ch_1', status: 'PENDING' }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
// Base com auth e header; o filho só tem o endpoint: tudo da base precisa chegar ao envio.
put('connectors/base.connector.vvpost.json', {
  id: 'connector.base',
  name: 'Base corporativa',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', headers: { 'X-Tenant': 'acme' }, auth: { type: 'bearer', token: '{{API_TOKEN}}' } }
})
put('connectors/billing.connector.vvpost.json', {
  id: 'connector.billing',
  name: 'Billing',
  version: '1.0.0',
  extends: 'connector.base',
  config: { basePath: '/billing' },
  endpoints: [
    {
      id: 'create_charge',
      name: 'Criar cobrança',
      method: 'POST',
      path: '/charges',
      body: { amount: 100, method: 'pix' },
      bodySchema: {
        type: 'object',
        required: ['amount', 'method'],
        properties: {
          amount: { type: 'integer', minimum: 1, description: 'Valor em centavos' },
          method: { $ref: '#/$defs/Method' },
          customer: { $ref: '#/$defs/Customer' },
          tags: { type: 'array', items: { type: 'string' } },
          capture: { type: 'boolean' }
        },
        $defs: {
          Method: { type: 'string', enum: ['pix', 'boleto', 'card'] },
          Customer: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } } }
        }
      }
    }
  ]
})
put('environments/dev.env.json', {
  id: 'env.dev',
  name: 'Desenvolvimento',
  variables: {
    BASE_URL: { type: 'string', value: origin },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put('.vvpost/secrets.local.json', { 'env.dev': { API_TOKEN } })
put('flows/vazio.flow.vvpost.json', { id: 'flow.vazio', name: 'Vazio', nodes: [], edges: [] })

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

  // Quick Request: o endpoint com bodySchema abre o corpo como formulário.
  await win.getByRole('button', { name: 'Abrir workspace…' }).click()
  await win.selectOption('select[aria-label="Conector"]', 'connector.billing')
  await win.selectOption('select[aria-label="Ambiente"]', 'env.dev')
  await win.selectOption('select[aria-label="Endpoint"]', 'create_charge')
  await win.getByRole('tab', { name: /^Body/ }).click()
  const form = win.getByRole('group', { name: 'Formulário do corpo' })
  await form.waitFor()
  assert.equal(await win.getByRole('radio', { name: 'Formulário' }).getAttribute('aria-checked'), 'true')
  // O corpo padrão do endpoint preenche o form; enum vira seletor com as opções do schema.
  assert.equal(await form.getByLabel('amount', { exact: true }).inputValue(), '100')
  const method = form.getByLabel('method', { exact: true })
  assert.deepEqual(await method.locator('option').allTextContents(), ['pix', 'boleto', 'card'])
  await form.getByText('Valor em centavos').waitFor()
  await form.getByLabel('amount', { exact: true }).fill('2590')
  await method.selectOption('boleto')
  await form.getByRole('button', { name: 'Adicionar customer' }).click()
  await form.getByLabel('customer.name').fill('Ana')
  await form.getByRole('button', { name: 'Adicionar item em tags' }).click()
  await form.getByLabel('tags[0]').fill('vip')
  await form.getByLabel('capture').selectOption('true')
  if (screenshot) {
    await form.getByLabel('amount', { exact: true }).scrollIntoViewIfNeeded()
    await win.screenshot({ path: screenshot.replace(/\.png$/, '-quick-request.png') })
  }

  // O JSON raw mostra o que o formulário montou, e continua editável.
  await win.getByRole('radio', { name: 'JSON raw' }).click()
  const raw = win.locator('textarea[aria-label="Corpo da requisição"]')
  assert.deepEqual(JSON.parse(await raw.inputValue()), {
    amount: 2590,
    method: 'boleto',
    customer: { name: 'Ana' },
    tags: ['vip'],
    capture: true
  })
  await win.getByRole('radio', { name: 'Formulário' }).click()
  assert.equal(await form.getByLabel('customer.name').inputValue(), 'Ana')

  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  const sent = seen.at(-1)
  assert.equal(sent.path, '/billing/charges')
  assert.equal(sent.auth, `Bearer ${API_TOKEN}`)
  assert.equal(sent.tenant, 'acme')
  assert.deepEqual(JSON.parse(sent.body), { amount: 2590, method: 'boleto', customer: { name: 'Ana' }, tags: ['vip'], capture: true })

  // Flow Studio: arrastar o endpoint do catálogo para o canvas cria o nó dele.
  await win.getByRole('button', { name: 'Flow Studio' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.locator('select[aria-label="Fluxo"]').waitFor()
  const palette = panel.getByRole('complementary', { name: 'Endpoints do catálogo' })
  const item = palette.getByRole('button', { name: /Criar cobrança/ })
  await item.waitFor()
  const canvas = panel.locator('.react-flow__pane')
  await item.dragTo(canvas, { targetPosition: { x: 300, y: 200 } })
  await panel.getByTestId('flow-node-CriarCobranca').waitFor()
  await panel.getByTestId('flow-node-CriarCobranca').click()
  assert.equal(await panel.getByLabel('Conector do nó').inputValue(), 'connector.billing')
  assert.equal(await panel.getByLabel('Endpoint do nó').inputValue(), 'create_charge')
  // A herança vem junto: o nó mostra base, auth e headers de connector.base.
  const inherited = panel.getByRole('group', { name: 'Herdado pelo nó' })
  await inherited.getByText(/connector\.base → connector\.billing/).waitFor()
  await inherited.getByText(/Auth: Token fixo em Authorization \(de connector\.base\)/).waitFor()
  await inherited.getByText('Headers: X-Tenant').waitFor()

  // Corpo do nó pelo formulário, a partir do corpo do endpoint.
  const nodeForm = panel.getByRole('group', { name: 'Formulário do corpo do nó' })
  assert.equal(await nodeForm.getByLabel('amount', { exact: true }).inputValue(), '100')
  await nodeForm.getByLabel('method', { exact: true }).selectOption('card')
  await panel.getByTestId('flow-node-CriarCobranca').getByText('POST Criar cobrança').waitFor()
  if (screenshot) await win.screenshot({ path: screenshot })

  // Enter num endpoint da lista também adiciona, ligado ao nó selecionado.
  await item.focus()
  await win.keyboard.press('Enter')
  await panel.getByTestId('flow-node-CriarCobranca1').waitFor()
  await panel.getByTestId('flow-node-CriarCobranca1').click()
  await panel.getByRole('button', { name: 'Excluir nó' }).click()
  await panel.getByTestId('flow-node-CriarCobranca1').waitFor({ state: 'detached' })

  await panel.locator('select[aria-label="Ambiente do fluxo"]').selectOption('env.dev')
  const before = seen.length
  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  await panel.getByRole('status', { name: 'Resumo da execução' }).getByText(/Fluxo ok: 1 ok/).waitFor()
  assert.equal(seen.length, before + 1)
  const run = seen.at(-1)
  assert.equal(run.path, '/billing/charges')
  assert.equal(run.auth, `Bearer ${API_TOKEN}`)
  assert.equal(run.tenant, 'acme')
  assert.deepEqual(JSON.parse(run.body), { amount: 100, method: 'card' })

  await panel.getByRole('button', { name: 'Salvar' }).click()
  await panel.getByRole('button', { name: 'Salvo' }).waitFor()
  const saved = JSON.parse(readFileSync(join(workspace, 'flows/vazio.flow.vvpost.json'), 'utf8'))
  const node = saved.nodes.find((n) => n.name === 'CriarCobranca')
  assert.deepEqual(node.request, { connector: 'connector.billing', endpoint: 'create_charge', body: { amount: 100, method: 'card' } })

  assert.deepEqual(errors, [])
  console.log('e2e-schema-form: ok')
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
