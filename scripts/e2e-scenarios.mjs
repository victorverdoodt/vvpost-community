#!/usr/bin/env node
// Teste ponta a ponta da Matriz de cenários no app real (build de produção em
// out/): abre um workspace com um conector de cobranças (auth bearer herdada do pai) e
// os cenários da spec, roda o lote em dois ambientes e confere a matriz, o detalhe de uma
// célula com falha, o filtro de falhas, que o lote não entrou no histórico e que a célula abre no
// Quick Request no mesmo contexto.
// Uso: npm run build && node scripts/e2e-scenarios.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
const API_TOKEN = 'token-secreto-e2e'

let requests = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requests++
    res.setHeader('content-type', 'application/json')
    const reply = (status, data) => {
      res.statusCode = status
      res.end(JSON.stringify(data))
    }
    if (req.headers.authorization !== `Bearer ${API_TOKEN}`) return reply(401, { error: 'unauthorized' })
    const data = JSON.parse(body || '{}')
    if (!(data.amount > 0)) return reply(400, { error: 'INVALID_AMOUNT' })
    // Em homologação o PIX ainda não está liberado: a matriz deve mostrar a falha só nessa coluna.
    if (req.headers['x-env'] === 'hml' && data.method === 'PIX') return reply(422, { error: 'PIX_DISABLED' })
    reply(200, { id: 'ch_1', status: 'PENDING' })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/base.connector.vvpost.json', {
  id: 'connector.corporate.base',
  name: 'Corporate Base',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', headers: { 'X-Env': '{{ENV}}' }, auth: { type: 'bearer', token: '{{API_TOKEN}}' } }
})
put('connectors/billing.connector.vvpost.json', {
  id: 'connector.billing.v2',
  name: 'Billing Service v2',
  version: '2.0.0',
  extends: 'connector.corporate.base',
  config: { basePath: '/billing/v2' },
  endpoints: [
    {
      id: 'charge_customer',
      name: 'Efetuar Cobrança',
      method: 'POST',
      path: '/charges',
      body: { amount: 150, customerId: 'cust_valid_1', method: 'CREDIT_CARD' },
      scenarios: [
        {
          id: 'tc_pix_success',
          name: 'Sucesso com PIX',
          overrides: { body: { amount: 150, customerId: 'cust_valid_1', method: 'PIX' } },
          assertions: [
            { target: 'status', operator: 'equals', expected: 200 },
            { target: 'responseTimeMs', operator: 'lessThan', expected: 5000 },
            { target: 'body.status', operator: 'equals', expected: 'PENDING' }
          ]
        },
        {
          id: 'tc_invalid_amount',
          name: 'Erro - Valor Inválido',
          overrides: { body: { amount: -10, customerId: 'cust_valid_1', method: 'PIX' } },
          assertions: [
            { target: 'status', operator: 'equals', expected: 400 },
            { target: 'body.error', operator: 'equals', expected: 'INVALID_AMOUNT' }
          ]
        },
        {
          id: 'tc_no_auth',
          name: 'Erro - Sem Auth',
          overrides: { headers: null },
          assertions: [{ target: 'status', operator: 'equals', expected: 401 }]
        }
      ]
    }
  ]
})
for (const [id, name, env] of [
  ['env.dev', 'Desenvolvimento', 'dev'],
  ['env.hml', 'Homologação', 'hml']
]) {
  put(`environments/${env}.env.json`, {
    id,
    name,
    variables: {
      BASE_URL: { type: 'string', value: origin },
      ENV: { type: 'string', value: env },
      API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    }
  })
}
// Para os tipos de falha: um ambiente com a API fora do ar e outro sem o segredo no vault.
for (const [id, name, file, base] of [
  ['env.down', 'Fora do ar', 'zz-down', 'http://127.0.0.1:1'],
  ['env.notoken', 'Sem token', 'zz-notoken', origin]
]) {
  put(`environments/${file}.env.json`, {
    id,
    name,
    variables: {
      BASE_URL: { type: 'string', value: base },
      ENV: { type: 'string', value: 'dev' },
      API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    }
  })
}
put('.vvpost/secrets.local.json', { 'env.dev': { API_TOKEN }, 'env.hml': { API_TOKEN }, 'env.down': { API_TOKEN } })

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
let runMs
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, workspace)

  await win.getByRole('button', { name: 'Cenários de teste' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Abrir workspace…' }).click()
  await panel.locator('select[aria-label="Conector"]').selectOption('connector.billing.v2')
  await panel.getByText('Sucesso com PIX').waitFor()
  const envs = panel.getByRole('group', { name: 'Ambientes da matriz' })
  await envs.getByLabel('Sem ambiente').uncheck()
  await envs.getByLabel('Desenvolvimento').check()
  await envs.getByLabel('Homologação').check()

  const start = performance.now()
  await panel.getByRole('button', { name: 'Rodar 6 cenários' }).click()
  await panel.getByText('5 passaram').waitFor()
  runMs = Math.round(performance.now() - start)
  await panel.getByText('1 falharam').waitFor()
  assert.equal(requests, 6)

  const cell = (scenario, env) => panel.getByRole('button', { name: `${scenario} em ${env}` })
  assert.equal(await cell('Sucesso com PIX', 'Desenvolvimento').textContent(), '200')
  assert.equal(await cell('Sucesso com PIX', 'Homologação').textContent(), '2/3')
  assert.equal(await cell('Erro - Sem Auth', 'Homologação').textContent(), '401')

  await cell('Sucesso com PIX', 'Homologação').click()
  const detail = panel.getByRole('region', { name: 'Detalhe do cenário' })
  // A primeira asserção que falhou em destaque, esperado e recebido lado a lado;
  // as outras ficam recolhidas.
  await detail.getByText('Falha de asserção').waitFor()
  await detail.getByText('2 de 3 asserções falharam').waitFor()
  const firstFailure = detail.getByRole('group', { name: 'Primeira asserção que falhou' })
  await firstFailure.getByText('status == 200').waitFor()
  assert.equal(await firstFailure.getByLabel('Esperado').textContent(), '200')
  assert.equal(await firstFailure.getByLabel('Recebido').textContent(), '422')
  await firstFailure.getByText('esperado 200, recebido 422').waitFor()
  assert.equal(await detail.getByText('body.status não existe na resposta').count(), 0)
  await detail.getByRole('button', { name: 'Ver todas as 3 asserções' }).click()
  await detail.getByText('body.status não existe na resposta').waitFor()
  await detail.getByText('/charges', { exact: true }).waitFor()

  // Só falhas: sobra a linha do PIX.
  await panel.getByLabel('Só falhas').check()
  assert.equal(await panel.getByRole('table', { name: 'Matriz de cenários' }).locator('tbody tr').count(), 2)

  // Rodar um cenário só refaz as células dele.
  await panel.getByLabel('Só falhas').uncheck()
  await panel.getByRole('button', { name: 'Rodar Erro - Valor Inválido' }).click()
  await panel.getByText('último disparo: 2 em').waitFor()
  await panel.getByText('5 passaram').waitFor()
  assert.equal(requests, 8)
  assert.equal(await cell('Sucesso com PIX', 'Homologação').textContent(), '2/3')

  // Tipos de falha: a API fora do ar (transporte) e o segredo sem valor (configuração) não se
  // confundem com a asserção que falhou, nem entre si.
  await envs.getByLabel('Fora do ar').check()
  await envs.getByLabel('Sem token').check()
  await panel.getByRole('button', { name: 'Rodar Erro - Valor Inválido' }).click()
  await panel.getByText('último disparo: 4 em').waitFor()
  assert.equal(await cell('Erro - Valor Inválido', 'Fora do ar').textContent(), 'rede')
  assert.equal(await cell('Erro - Valor Inválido', 'Sem token').textContent(), 'config')
  assert.match(await cell('Erro - Valor Inválido', 'Fora do ar').getAttribute('title'), /^Falha de transporte: CONNECTION_REFUSED/)
  await cell('Erro - Valor Inválido', 'Sem token').click()
  await detail.getByLabel('Tipo de falha').getByText('Erro de configuração').waitFor()
  await detail.getByRole('alert').getByText('CONFIG_ERROR').waitFor()
  await cell('Erro - Valor Inválido', 'Fora do ar').click()
  await detail.getByLabel('Tipo de falha').getByText('Falha de transporte').waitFor()
  await detail.getByRole('alert').getByText('CONNECTION_REFUSED').waitFor()
  await envs.getByLabel('Fora do ar').uncheck()
  await envs.getByLabel('Sem token').uncheck()
  await cell('Sucesso com PIX', 'Homologação').click()
  await detail.getByText('2 de 3 asserções falharam').waitFor()

  // Execução orientada a dados: a coluna ENV troca a variável do ambiente em cada linha, então o
  // PIX em Desenvolvimento passa na linha 1 (dev) e falha na 2 (hml). A célula conta as iterações.
  const dataFile = join(workspace, 'casos.csv')
  writeFileSync(dataFile, 'ENV,obs\ndev,"linha 1, dev"\nhml,linha 2\n')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, dataFile)
  await panel.getByRole('button', { name: 'Arquivo de dados…' }).click()
  await panel.getByLabel('Arquivo de dados').getByText('casos.csv · 2 iterações').waitFor()
  const before = requests
  await panel.getByRole('button', { name: 'Rodar 12 cenários' }).click()
  await panel.getByText('último disparo: 12 em').waitFor()
  assert.equal(requests - before, 12)
  assert.equal(await cell('Sucesso com PIX', 'Desenvolvimento').textContent(), '1/2')
  assert.equal(await cell('Erro - Sem Auth', 'Desenvolvimento').textContent(), '2/2')
  assert.match(await cell('Sucesso com PIX', 'Desenvolvimento').getAttribute('title'), /1 de 2 iterações não passaram: #2/)
  await cell('Sucesso com PIX', 'Desenvolvimento').click()
  const picker = win.getByRole('group', { name: 'Iterações do arquivo de dados' })
  assert.equal(await picker.getByRole('button', { name: '#2' }).getAttribute('aria-pressed'), 'true')
  await detail.getByText('Falha de asserção').waitFor()
  await picker.getByRole('button', { name: '#1' }).click()
  assert.equal(await detail.getByText('Falha de asserção').count(), 0)
  if (process.env.E2E_DATA_SCREENSHOT) await win.screenshot({ path: process.env.E2E_DATA_SCREENSHOT })
  await panel.getByRole('button', { name: 'Rodar sem o arquivo de dados' }).click()
  await panel.getByRole('button', { name: 'Rodar 6 cenários' }).waitFor()
  await cell('Sucesso com PIX', 'Homologação').click()
  await detail.getByText('2 de 3 asserções falharam').waitFor()

  const html = await win.content()
  assert.ok(!html.includes(API_TOKEN), 'o token do ambiente chegou ao renderer')
  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])

  // Cada lote vira uma execução no histórico, fora das recentes do Quick Request,
  // com as asserções e o que foi para a rede, sem o token do ambiente.
  assert.deepEqual(await win.evaluate(() => window.vvpost.listHistory({ source: 'request' })), [])
  const runs = await win.evaluate(() => window.vvpost.listHistory({ source: 'scenarios' }))
  assert.ok(runs.length >= 2, 'os lotes não entraram no histórico')
  const first = await win.evaluate((id) => window.vvpost.getHistoryRun(id), runs.at(-1).id)
  assert.equal(first.exchanges.length, first.exchangeCount)
  assert.ok(first.exchanges.every((x) => x.label && x.assertions?.length && x.sent && x.response))
  assert.ok(!JSON.stringify(first).includes(API_TOKEN), 'o token do ambiente foi para o histórico')

  // Continuidade: a célula abre no Quick Request com o corpo do cenário, no mesmo
  // conector e ambiente; trocar o ambiente lá vale para os outros módulos.
  if (!(await detail.isVisible())) await cell('Sucesso com PIX', 'Homologação').click()
  await detail.getByRole('button', { name: 'Abrir no Quick Request' }).click()
  const nav = win.getByRole('navigation', { name: 'Módulos' })
  await nav.locator('button[aria-label="Quick Request"][aria-current="page"]').waitFor()
  const quick = win.locator('main > div:not([hidden])')
  // Abre numa aba nova; as outras abas continuam montadas e ocultas.
  const url = quick.locator('input[aria-label="URL"]:visible')
  await url.waitFor()
  assert.equal(await url.inputValue(), '/charges')
  assert.equal(await quick.locator('select[aria-label="Conector"]').inputValue(), 'connector.billing.v2')
  assert.equal(await quick.locator('select[aria-label="Ambiente"]').inputValue(), 'env.hml')
  await quick.getByRole('tab', { name: 'Body' }).click()
  await quick.getByText(/"method": "PIX"/).first().waitFor()
  await quick.locator('select[aria-label="Ambiente"]').selectOption('env.dev')
  await nav.getByRole('button', { name: 'Flow Studio', exact: true }).click()
  // O Flow Studio lê o workspace depois do primeiro paint: espera as opções chegarem.
  await win.waitForFunction(
    () => document.querySelector('main > div:not([hidden]) select[aria-label="Ambiente do fluxo"]')?.value === 'env.dev'
  )
} finally {
  await app.close()
  server.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log(`E2E da Matriz de cenários: ok (6 cenários em 2 ambientes em ${runMs} ms)`)
