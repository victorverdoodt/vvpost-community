#!/usr/bin/env node
// Teste ponta a ponta da edição de conectores e cenários pela interface, no app real
// (build de produção em out/): cria um conector filho no Catálogo (o app recusa uma
// credencial literal), acrescenta um endpoint pela aba Editar, cria dois cenários no
// painel Cenários de teste e roda a matriz contra uma API local.
// Uso: npm run build && node scripts/e2e-editors.mjs   (Linux sem display: xvfb-run -a)
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
const catalogScreenshot = process.env.E2E_CATALOG_SCREENSHOT
const API_TOKEN = 'token-do-editor-e2e'

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    res.statusCode = req.headers.authorization === `Bearer ${API_TOKEN}` ? 200 : 401
    res.end(JSON.stringify({ path: req.url, body: JSON.parse(body || 'null') }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-editors-ws-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/base.connector.vvpost.json', {
  id: 'corp.base',
  name: 'Corp Base',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } }
})
put('environments/dev.env.json', {
  id: 'env.dev',
  name: 'Dev',
  variables: {
    BASE_URL: { type: 'string', value: `http://127.0.0.1:${server.address().port}` },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put('environments/hml.env.json', { id: 'env.hml', name: 'Hml', variables: {} })
put('.vvpost/secrets.local.json', { 'env.dev': { API_TOKEN } })
const connectorFile = join(workspace, 'connectors/billing.connector.vvpost.json')
const readConnector = () => JSON.parse(readFileSync(connectorFile, 'utf8'))

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

  // Catálogo: conector novo, filho do base.
  await win.getByRole('button', { name: 'Catálogo' }).click()
  const catalog = win.locator('main > div:not([hidden])')
  await catalog.getByRole('button', { name: 'Abrir workspace…' }).click()
  await catalog.getByRole('button', { name: 'Novo conector' }).click()
  const create = catalog.getByRole('form', { name: 'Novo conector' })
  await create.getByLabel('Id *').fill('billing')
  await create.getByLabel('Nome *').fill('Billing')
  await create.getByLabel('Herda de (extends)').selectOption('corp.base')
  await create.getByLabel('basePath').fill('/billing')
  await create.getByRole('button', { name: '+ Header' }).click()
  await create.getByLabel('Header: nome 1').fill('Authorization')
  await create.getByLabel('Header: valor 1').fill('Bearer literal')
  await create.getByRole('button', { name: 'Criar conector' }).click()
  await create.getByRole('alert').getByText(/credencial escrita direto no conector \(headers\.Authorization\)/).waitFor()
  await create.getByRole('button', { name: 'Apagar linha 1 de Header' }).click()
  await create.getByRole('button', { name: 'Criar conector' }).click()
  await catalog.getByRole('region', { name: 'Conector Billing' }).waitFor()
  assert.deepEqual(readConnector(), {
    $schema: 'https://vvpost.dev/schemas/v1/connector.json',
    id: 'billing',
    name: 'Billing',
    version: '1.0.0',
    extends: 'corp.base',
    config: { basePath: '/billing' },
    endpoints: []
  })

  // Aba Editar: um endpoint com corpo padrão.
  await catalog.getByRole('tab', { name: 'Editar' }).click()
  const edit = catalog.getByRole('form', { name: 'Editar billing' })
  await edit.getByRole('button', { name: '+ Endpoint' }).click()
  const endpoint = edit.getByLabel('Endpoint 1', { exact: true })
  await endpoint.getByLabel('Id *').fill('charge')
  await endpoint.getByLabel('Nome *').fill('Cobrar')
  await endpoint.getByLabel('Método').selectOption('POST')
  await endpoint.getByLabel('Caminho *').fill('/charges')
  await endpoint.getByLabel('Corpo padrão (JSON)').fill('{ "amount": 10, "meta": {} ')
  await endpoint.getByText(/JSON inválido/).waitFor()
  assert.ok(await edit.getByRole('button', { name: 'Salvar conector' }).isDisabled())
  await endpoint.getByLabel('Corpo padrão (JSON)').fill('{ "amount": 10, "meta": {} }')
  if (catalogScreenshot) await win.screenshot({ path: catalogScreenshot })
  await edit.getByRole('button', { name: 'Salvar conector' }).click()
  await catalog.getByRole('tab', { name: 'Herança', selected: true }).waitFor()
  assert.deepEqual(readConnector().endpoints, [
    { id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges', body: { amount: 10, meta: {} } }
  ])

  // Ir à definição original de um valor herdado: abre o editor do Corp Base no campo.
  await catalog.getByRole('button', { name: 'Ir à definição de Auth em Corp Base' }).waitFor()
  await catalog.getByRole('button', { name: 'Ir à definição de URL base em Corp Base' }).click()
  const parent = catalog.getByRole('form', { name: 'Editar corp.base' })
  await parent.getByLabel('URL base').waitFor()
  for (let i = 0; i < 50 && !(await parent.getByLabel('URL base').evaluate((el) => el === document.activeElement)); i++)
    await win.waitForTimeout(20)
  assert.equal(await parent.getByLabel('URL base').evaluate((el) => el === document.activeElement), true)
  // Antes de salvar uma mudança herdada, quantos conectores e endpoints ela atinge.
  const impact = parent.getByRole('note', { name: 'Impacto nos filhos' })
  assert.match(await impact.textContent(), /Herdada por 1 conector \(\s*Billing\) e 1 endpoint\.$/)
  await parent.getByRole('button', { name: '+ Header' }).click()
  await parent.getByLabel('Header: nome 1').fill('X-Corp')
  await parent.getByLabel('Header: valor 1').fill('e2e')
  assert.match(await impact.textContent(), /a mudança vale para todos eles/)
  await parent.getByRole('button', { name: 'Salvar conector' }).click()
  const impactDialog = win.getByRole('dialog', { name: 'Salvar uma mudança herdada por 1 conector?' })
  await impactDialog.getByText('Billing herda a configuração de Corp Base: 1 endpoint muda junto.').waitFor()
  await impactDialog.getByRole('button', { name: 'Cancelar' }).click()
  assert.equal(JSON.parse(readFileSync(join(workspace, 'connectors/base.connector.vvpost.json'), 'utf8')).config.headers, undefined)
  await parent.getByRole('button', { name: 'Salvar conector' }).click()
  await impactDialog.getByRole('button', { name: 'Salvar' }).click()
  await catalog.getByRole('tab', { name: 'Herança', selected: true }).waitFor()
  assert.deepEqual(JSON.parse(readFileSync(join(workspace, 'connectors/base.connector.vvpost.json'), 'utf8')).config.headers, { 'X-Corp': 'e2e' })

  // Cenários de teste: dois cenários criados pela interface.
  await win.getByRole('button', { name: 'Cenários de teste' }).click()
  const scenarios = win.locator('main > div:not([hidden])')
  await scenarios.locator('select[aria-label="Conector"]').selectOption('billing')
  await scenarios.getByRole('button', { name: 'Criar cenário' }).click()
  const editor = scenarios.getByRole('form', { name: 'Editar cenários de Billing' })
  // Salvar fecha o editor; até lá, os nomes dos cenários também aparecem nele.
  const save = async () => {
    await editor.getByRole('button', { name: 'Salvar cenários' }).click()
    await editor.waitFor({ state: 'detached' }).catch(async (err) => {
      throw new Error(`o editor não salvou: ${await editor.getByRole('alert').allTextContents()} ${err.message}`)
    })
  }
  await editor.getByLabel('Id *').fill('ok')
  await editor.getByLabel('Nome *').fill('Cobra com token')
  await editor.getByLabel('Corpo (substitui o padrão do endpoint)').fill('{ "amount": 25 }')
  await editor.getByRole('button', { name: '+ Asserção' }).click()
  await editor.getByLabel('Alvo da asserção 2').fill('body.body.amount')
  await editor.getByLabel('Operador da asserção 2').selectOption('equals')
  await editor.getByLabel('Esperado da asserção 2').fill('25')
  await editor.getByRole('button', { name: '+ Novo cenário' }).click()
  await editor.getByLabel('Id *').fill('sem-auth')
  await editor.getByLabel('Nome *').fill('Sem auth')
  await editor.getByLabel('Sem headers nem auth herdados').check()
  await editor.getByLabel('Esperado da asserção 1').fill('401')
  await save()
  await scenarios.getByText('Cobra com token').waitFor()
  assert.deepEqual(readConnector().endpoints[0].scenarios, [
    {
      id: 'ok',
      name: 'Cobra com token',
      overrides: { body: { amount: 25 } },
      assertions: [
        { target: 'status', operator: 'equals', expected: 200 },
        { target: 'body.body.amount', operator: 'equals', expected: 25 }
      ]
    },
    { id: 'sem-auth', name: 'Sem auth', overrides: { headers: null }, assertions: [{ target: 'status', operator: 'equals', expected: 401 }] }
  ])

  const envs = scenarios.getByRole('group', { name: 'Ambientes da matriz' })
  await envs.getByLabel('Sem ambiente').uncheck()
  await envs.getByLabel('Dev').check()
  await scenarios.getByRole('button', { name: 'Rodar 2 cenários' }).click()
  await scenarios.getByText('2 passaram').waitFor()

  // Editar um cenário existente pelo lápis da linha.
  await scenarios.getByRole('button', { name: 'Editar Sem auth' }).click()
  await editor.getByLabel('Nome *').fill('Sem auth (401)')
  if (screenshot) await win.screenshot({ path: screenshot })
  await save()
  await scenarios.getByText('Sem auth (401)').waitFor()

  // Encadeamento pela interface: captura num cenário, dependsOn e $capture no seguinte, e uma
  // asserção que só vale num ambiente. Trocar o id de um cenário leva junto o dependsOn.
  await scenarios.getByRole('button', { name: 'Editar Cobra com token' }).click()
  await editor.getByRole('button', { name: '+ Captura' }).click()
  await editor.getByLabel('Captura: nome 1').fill('amount')
  await editor.getByLabel('Captura: valor 1').fill('corpo.amount')
  await editor.getByText('a origem é status, body').waitFor()
  assert.ok(await editor.getByRole('button', { name: 'Salvar cenários' }).isDisabled(), 'captura inválida não pode salvar')
  await editor.getByLabel('Captura: valor 1').fill('body.body.amount')
  await editor.getByRole('button', { name: '+ Novo cenário' }).click()
  await editor.getByLabel('Id *').fill('encadeado')
  await editor.getByLabel('Nome *').fill('Encadeado')
  await editor.getByRole('group', { name: 'Depende de' }).getByLabel('Cobra com token').check()
  await editor.getByRole('button', { name: '+ Query' }).click()
  await editor.getByLabel('Query: nome 1').fill('valor')
  await editor.getByLabel('Query: valor 1').fill('{{$capture.amount}}')
  await editor.getByRole('button', { name: '+ Asserção' }).click()
  await editor.getByLabel('Alvo da asserção 2').fill('body.path')
  await editor.getByLabel('Operador da asserção 2').selectOption('contains')
  await editor.getByLabel('Esperado da asserção 2').fill('valor=25')
  await editor.getByRole('group', { name: 'Ambientes da asserção 2' }).getByRole('button', { name: 'Dev' }).click()
  await editor.getByRole('button', { name: 'Cobra com token', exact: true }).click()
  await editor.getByLabel('Id *').fill('cobra')
  await save()
  await scenarios.getByText('Encadeado').waitFor()
  const [first, , chained] = readConnector().endpoints[0].scenarios
  assert.deepEqual(first.capture, { amount: 'body.body.amount' })
  assert.equal(first.id, 'cobra')
  assert.deepEqual(chained, {
    id: 'encadeado',
    name: 'Encadeado',
    dependsOn: ['charge/cobra'],
    overrides: { query: { valor: '{{$capture.amount}}' } },
    assertions: [
      { target: 'status', operator: 'equals', expected: 200 },
      { target: 'body.path', operator: 'contains', expected: 'valor=25', environments: ['env.dev'] }
    ]
  })
  await scenarios.getByRole('button', { name: 'Rodar 3 cenários' }).click()
  await scenarios.getByText('3 passaram').waitFor()

  assert.ok(!(await win.content()).includes(API_TOKEN), 'o token do ambiente chegou ao renderer')
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  server.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E da edição de conectores e cenários: ok')
