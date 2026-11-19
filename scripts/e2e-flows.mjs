#!/usr/bin/env node
// Teste ponta a ponta do Flow Studio no app real (build de produção em out/):
// abre um workspace com um fluxo de checkout (login, cliente e carrinho em paralelo, total
// em Python, condição e cobrança pelo conector com auth herdada), roda pelo canvas, confere
// o estado de cada nó, monta um nó novo com o autocomplete de $nodes e o Visual Data Picker,
// roda de novo e salva o arquivo.
// Uso: npm run build && node scripts/e2e-flows.mjs   (Linux sem display: xvfb-run -a)
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
const API_TOKEN = 'token-secreto-e2e'

const seen = []
let active = 0
let maxActive = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x')
    seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.authorization, body })
    active++
    maxActive = Math.max(maxActive, active)
    const reply = (status, data) => {
      active--
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (url.searchParams.has('delay')) await new Promise((r) => setTimeout(r, Number(url.searchParams.get('delay'))))
    if (url.pathname === '/auth/login') return reply(200, { token: 'tok-1', cartId: 'cart_7' })
    if (url.pathname === '/echo') return reply(200, { auth: req.headers.authorization ?? null, query: Object.fromEntries(url.searchParams) })
    if (url.pathname === '/billing/v2/charges') {
      if (req.headers.authorization !== `Bearer ${API_TOKEN}`) return reply(401, { error: 'unauthorized' })
      return reply(200, { status: 'PENDING', received: JSON.parse(body) })
    }
    if (req.headers.authorization !== 'Bearer tok-1') return reply(401, { error: 'unauthorized' })
    if (url.pathname === '/customers/me') return reply(200, { id: 'cust_9' })
    if (url.pathname === '/carts/cart_7') return reply(200, { items: [{ price: 10 }, { price: 5.5 }] })
    reply(404, { error: 'NOT_FOUND' })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/billing.connector.vvpost.json', {
  id: 'connector.billing.v2',
  name: 'Billing Service v2',
  version: '2.0.0',
  config: { baseUrl: '{{BASE_URL}}', basePath: '/billing/v2', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
  endpoints: [{ id: 'charge_customer', name: 'Efetuar Cobrança', method: 'POST', path: '/charges', body: { amount: 1, method: 'CARD' } }]
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
const auth = { Authorization: 'Bearer {{ $nodes.Login.data.token }}' }
put('flows/checkout.flow.vvpost.json', {
  id: 'flow.checkout',
  name: 'Checkout',
  nodes: [
    { id: 'login', name: 'Login', type: 'request', request: { method: 'POST', url: '{{BASE_URL}}/auth/login', body: { user: 'ana' } } },
    { id: 'customer', name: 'Customer', type: 'request', request: { method: 'GET', url: '{{BASE_URL}}/customers/me?delay=150', headers: auth } },
    {
      id: 'cart',
      name: 'Cart',
      type: 'request',
      request: { method: 'GET', url: '{{BASE_URL}}/carts/{{ $nodes.Login.data.cartId }}?delay=150', headers: auth }
    },
    {
      id: 'total',
      name: 'Total',
      type: 'python',
      python: { code: "items = nodes['Cart']['data']['items']\nprint('itens', len(items))\noutput = {'count': len(items), 'amount': sum(i['price'] for i in items)}" }
    },
    { id: 'has_items', name: 'HasItems', type: 'condition', condition: { target: '$nodes.Total.data.count', operator: 'greaterThan', expected: 0 } },
    {
      id: 'charge',
      name: 'Charge',
      type: 'request',
      request: {
        connector: 'connector.billing.v2',
        endpoint: 'charge_customer',
        body: { amount: '{{ $nodes.Total.data.amount }}', customerId: '{{ $nodes.Customer.data.id }}', method: 'PIX' }
      }
    }
  ],
  edges: [
    { from: 'login', to: 'customer' },
    { from: 'login', to: 'cart' },
    { from: 'customer', to: 'total' },
    { from: 'cart', to: 'total' },
    { from: 'total', to: 'has_items' },
    { from: 'has_items', to: 'charge', branch: 'true' }
  ]
})

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
  await win.getByRole('button', { name: 'Quick Request' }).waitFor()
  // O canvas (React Flow) só carrega quando a aba abre: o CSS dele chega junto com o chunk.
  const loaded = () =>
    win.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href.includes('FlowStudioModule')))
  assert.equal(await loaded(), false, 'o Flow Studio carregou antes de a aba abrir')

  await win.getByRole('button', { name: 'Flow Studio' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Abrir workspace…' }).click()
  await panel.locator('select[aria-label="Fluxo"]').waitFor()
  assert.equal(await loaded(), true)
  await panel.getByTestId('flow-node-Charge').waitFor()
  assert.equal(await panel.locator('.react-flow__node').count(), 6)
  await panel.locator('select[aria-label="Ambiente do fluxo"]').selectOption('env.dev')

  const start = performance.now()
  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  const summary = panel.getByRole('status', { name: 'Resumo da execução' })
  await summary.getByText('Fluxo ok: 6 ok, 0 com erro, 0 pulados').waitFor()
  runMs = Math.round(performance.now() - start)
  assert.equal(maxActive, 2, 'cliente e carrinho deveriam rodar em paralelo')
  for (const name of ['Login', 'Customer', 'Cart', 'Total', 'HasItems', 'Charge']) {
    assert.match(await panel.getByLabel(`Status de ${name}`).textContent(), /^ok · \d+ ms$/)
  }
  const charge = seen.find((s) => s.path === '/billing/v2/charges')
  assert.equal(charge.auth, `Bearer ${API_TOKEN}`)
  assert.deepEqual(JSON.parse(charge.body), { amount: 15.5, customerId: 'cust_9', method: 'PIX' })

  // Inspetor do Python: logs e saída em $nodes. O Monaco só carrega quando um nó Python abre.
  const monacoLoaded = () =>
    // O CSS do Monaco é um chunk dividido com o editor de GraphQL do Quick Request (assets/editor-*.css).
    win.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => /\/assets\/(monaco-python|editor)-[^/]*\.css$/.test(l.href)))
  assert.equal(await monacoLoaded(), false, 'o Monaco carregou antes de abrir um nó Python')
  await panel.getByTestId('flow-node-Total').click()
  const editor = panel.locator('[aria-label="Editor do script Python"][data-editor="monaco"]')
  await editor.locator('.monaco-editor').waitFor()
  assert.equal(await monacoLoaded(), true)
  assert.match((await editor.locator('.view-lines').textContent()).replace(/\u00a0/g, ' '), /items = nodes\['Cart'\]/)
  // Autocomplete de nodes['Nome'] no Monaco, com os nós anteriores.
  await editor.locator('.view-lines').click()
  await win.keyboard.press('Control+End')
  await win.keyboard.press('Enter')
  await win.keyboard.type("x = nodes['Cu")
  await editor.locator('.suggest-widget').getByText('Customer').waitFor()
  await win.keyboard.press('Escape')
  // Desfaz a linha digitada (o Monaco fecha colchetes e aspas sozinho).
  await win.keyboard.press('Home')
  await win.keyboard.press('Shift+End')
  await win.keyboard.press('Backspace')
  await win.keyboard.press('Backspace')
  assert.ok(!(await editor.locator('.view-lines').textContent()).includes('x\u00a0='), 'a linha de teste ficou no script')
  const result = panel.getByRole('region', { name: 'Resultado do nó' })
  await result.getByText('itens 2').waitFor()
  assert.match(await result.getByLabel('Saída do nó').textContent(), /"amount": 15.5/)

  // Nó novo ligado ao Charge, montado com o Visual Data Picker e o autocomplete.
  await panel.getByTestId('flow-node-Charge').click()
  await panel.getByRole('button', { name: '+ Requisição' }).click()
  await panel.getByTestId('flow-node-Request1').waitFor()
  const url = panel.getByLabel('URL do nó')
  await url.fill('{{BASE_URL}}/echo?status=')
  await url.focus()
  await url.press('End')
  const picker = panel.getByRole('region', { name: 'Visual Data Picker' })
  await picker.getByText('Clique num campo para inserir em').waitFor()
  await picker.getByRole('button', { name: 'Inserir $nodes.Charge.data.status' }).click()
  assert.equal(await url.inputValue(), '{{BASE_URL}}/echo?status={{ $nodes.Charge.data.status }}')

  await panel.getByRole('button', { name: '+ header' }).click()
  await panel.getByLabel('Nome em Headers 1').fill('Authorization')
  const value = panel.getByLabel('Valor de Authorization')
  await value.click()
  await value.pressSequentially('Bearer {{ $nodes.Login.data.to')
  const suggestions = panel.getByRole('listbox', { name: 'Sugestões de $nodes' })
  await suggestions.getByRole('option', { name: /token/ }).waitFor()
  await value.press('Enter')
  // A sugestão aplicada move o cursor depois do render: digitar antes disso cai no lugar errado.
  for (let i = 0; i < 50 && (await value.inputValue()) !== 'Bearer {{ $nodes.Login.data.token'; i++) await win.waitForTimeout(20)
  await value.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length))
  await value.pressSequentially(' }}')
  assert.equal(await value.inputValue(), 'Bearer {{ $nodes.Login.data.token }}')

  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  await summary.getByText('Fluxo ok: 7 ok, 0 com erro, 0 pulados').waitFor()
  const echo = seen.findLast((s) => s.path.startsWith('/echo'))
  assert.equal(echo.path, '/echo?status=PENDING')
  assert.equal(echo.auth, 'Bearer tok-1')

  // Espera depois do Request1, e o polling aparece no inspetor da requisição.
  await panel.getByTestId('flow-node-Request1').click()
  await panel.getByRole('button', { name: '+ Espera' }).click()
  await panel.getByTestId('flow-node-Wait1').waitFor()
  await panel.getByLabel('Milissegundos de espera').fill('50')
  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  await summary.getByText('Fluxo ok: 8 ok, 0 com erro, 0 pulados').waitFor()
  await panel.getByTestId('flow-node-Request1').click()
  const polling = panel.getByLabel('Repetir até uma condição valer (polling)')
  await polling.check()
  await panel.getByLabel('Intervalo do polling').waitFor()
  assert.equal(await panel.getByLabel('Valor testado').first().inputValue(), '$nodes.Request1.status')
  await polling.uncheck()

  // Abrir o nó no Quick Request: os $nodes da última execução já preenchidos.
  await panel.getByRole('button', { name: 'Abrir no Quick Request' }).click()
  const quickUrl = win.locator('input[aria-label="URL"]:visible')
  await quickUrl.waitFor()
  assert.equal(await quickUrl.inputValue(), '{{BASE_URL}}/echo?status=PENDING')
  assert.equal(await win.locator('input[aria-label="Valor do cabeçalho"]:visible').first().inputValue(), 'Bearer tok-1')
  await win.getByRole('button', { name: 'Flow Studio' }).click()
  await panel.getByTestId('flow-node-Request1').waitFor()

  await panel.getByRole('button', { name: 'Salvar' }).click()
  await panel.getByText('Salvo em flows/checkout.flow.vvpost.json').waitFor()
  const saved = JSON.parse(readFileSync(join(workspace, 'flows/checkout.flow.vvpost.json'), 'utf8'))
  assert.equal(saved.$schema, 'https://vvpost.dev/schemas/v1/flow.json')
  const added = saved.nodes.find((n) => n.name === 'Request1')
  assert.equal(added.request.headers.Authorization, 'Bearer {{ $nodes.Login.data.token }}')
  assert.ok(saved.nodes.every((n) => n.position), 'posições do canvas não foram salvas')
  assert.ok(saved.edges.some((e) => e.from === 'charge' && e.to === added.id))

  // Abas dos fluxos abertos (na barra única do workspace): um fluxo novo ganha a dele, ao lado do Checkout.
  const flowTabs = win.getByRole('tablist', { name: 'Abas do workspace' }).locator('[role=tab][id^="ws-tab-src:flows:"]')
  assert.equal(await flowTabs.filter({ hasText: 'Checkout' }).getAttribute('aria-selected'), 'true')
  await panel.getByRole('button', { name: 'Novo fluxo' }).last().click()
  await panel.getByLabel('Nome do novo fluxo').fill('Limpeza')
  await panel.getByRole('button', { name: 'Criar' }).click()
  await flowTabs.filter({ hasText: 'Limpeza' }).waitFor()
  assert.equal(await flowTabs.count(), 2)
  await panel.getByRole('button', { name: '+ Requisição' }).click()
  await panel.getByTestId('flow-node-Request1').waitFor()
  await panel.getByLabel('Método do nó').selectOption('DELETE')
  await panel.getByLabel('URL do nó').fill('{{BASE_URL}}/echo?carrinho={{ $nodes.Ghost.data.id }}')

  // DELETE pede confirmação antes de rodar; cancelar não envia nada.
  const before = seen.length
  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  const confirm = win.getByRole('dialog', { name: /impacto elevado/ })
  await confirm.getByText(/Request1: DELETE apaga um recurso/).waitFor()
  await confirm.getByRole('button', { name: 'Cancelar' }).click()
  await panel.getByText('Execução cancelada antes de começar.').waitFor()
  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  await confirm.getByRole('button', { name: 'Rodar mesmo assim' }).click()
  await summary.getByText('Fluxo com erro: 0 ok, 1 com erro, 0 pulados').waitFor()
  assert.equal(seen.length, before, 'a referência inválida não deveria enviar a requisição')

  // O erro aponta a propriedade que o causou e leva até ela.
  await panel.getByTestId('flow-node-Request1').click()
  const invalid = panel.locator('[data-property="request.url"][aria-invalid="true"]')
  await invalid.getByText('O erro da última execução vem de URL').waitFor()
  await panel.getByRole('button', { name: 'Ir para a propriedade' }).click()
  assert.equal(await panel.getByLabel('URL do nó').evaluate((el) => el === document.activeElement), true)

  // Fechar a aba volta para o Checkout.
  await flowTabs.filter({ hasText: 'Limpeza' }).click({ button: 'middle' })
  await flowTabs.filter({ hasText: 'Checkout' }).waitFor()
  assert.equal(await flowTabs.count(), 1)
  assert.equal(await panel.locator('select[aria-label="Fluxo"]').inputValue(), 'flow.checkout')

  const html = await win.content()
  assert.ok(!html.includes(API_TOKEN), 'o token do ambiente chegou ao renderer')
  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
  // O fluxo vira uma execução no histórico, com os nós e as requisições, fora das
  // recentes do Quick Request e sem o token do ambiente.
  assert.deepEqual(await win.evaluate(() => window.vvpost.listHistory({ source: 'request' })), [])
  const runs = await win.evaluate(() => window.vvpost.listHistory({ source: 'flow' }))
  assert.ok(runs.length >= 1, 'o fluxo não entrou no histórico')
  const run = await win.evaluate((id) => window.vvpost.getHistoryRun(id), runs.at(-1).id)
  assert.ok(run.exchanges.length > 0 && run.exchanges.every((x) => x.ref?.nodeId && x.sent))
  assert.ok(Array.isArray(run.report.nodes) && run.report.nodes.length > 0)
  assert.ok(!JSON.stringify(run).includes(API_TOKEN), 'o token do ambiente foi para o histórico')

  // Pessoa e agente no mesmo arquivo: o Flow Studio e o editor de conector salvam com a versão de
  // quando abriram; se a IA (ou outra pessoa) gravou no meio, a gravação é recusada, sem sobrescrever.
  const listed = await win.evaluate(() => window.vvpost.listFlows())
  const entry = listed.value.flows.find((f) => f.flow.id === 'flow.checkout')
  assert.ok(entry.version, 'listFlows não devolveu a versão do arquivo')
  const flowPath = join(workspace, entry.file)
  const byAgent = `${JSON.stringify({ ...JSON.parse(readFileSync(flowPath, 'utf8')), description: 'Ajustado pelo agente' }, null, 2)}\n`
  writeFileSync(flowPath, byAgent)
  const stale = await win.evaluate(([f, file, v]) => window.vvpost.saveFlow(f, file, v), [entry.flow, entry.file, entry.version])
  assert.equal(stale.ok, false, 'o Flow Studio sobrescreveu a gravação do agente')
  assert.match(stale.message, /mudou fora do app/)
  assert.equal(readFileSync(flowPath, 'utf8'), byAgent)
  const fresh = (await win.evaluate(() => window.vvpost.listFlows())).value.flows.find((f) => f.flow.id === 'flow.checkout')
  const resaved = await win.evaluate(([f, file, v]) => window.vvpost.saveFlow(f, file, v), [fresh.flow, fresh.file, fresh.version])
  assert.ok(resaved.ok && resaved.value.version, 'salvar com a versão atual falhou')

  const source = await win.evaluate(() => window.vvpost.readConnector('connector.billing.v2'))
  assert.ok(source.ok && source.value.version)
  const connectorPath = join(workspace, source.value.file)
  writeFileSync(connectorPath, readFileSync(connectorPath, 'utf8').replace('Billing Service v2', 'Billing (agente)'))
  const staleConnector = await win.evaluate(([c, file, v]) => window.vvpost.saveConnector(c, file, v), [source.value.connector, source.value.file, source.value.version])
  assert.equal(staleConnector.ok, false, 'o editor de conector sobrescreveu a gravação do agente')
  assert.match(readFileSync(connectorPath, 'utf8'), /Billing \(agente\)/)
} finally {
  await app.close()
  server.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log(`E2E do Flow Studio: ok (6 nós, 2 em paralelo, em ${runMs} ms)`)
