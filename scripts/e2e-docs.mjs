#!/usr/bin/env node
// Teste ponta a ponta da documentação rica no app real (build de produção em out/): o botão
// direito (e Shift+F10) no projeto, no conector, no endpoint e na request abre "Gerar
// documentação" daquele nível; a visualização traz os diagramas (hierarquia, auth,
// sequência, fluxos, mapa do projeto), a herança com a origem, schemas, cenários e
// asserções; e o .md e o PDF são gravados sem nenhum valor de segredo.
// Uso: npm run build && node scripts/e2e-docs.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
/** Gerado a cada execução: o valor do vault que nunca pode aparecer na documentação. */
const VAULT_SECRET = `vault-${Math.random().toString(36).slice(2)}-Zq9`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-docs-'))
const out = mkdtempSync(join(tmpdir(), 'vvpost-docs-out-'))
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
      path: '/customers/{customerId}/charges',
      bodySchema: {
        type: 'object',
        required: ['amount', 'method'],
        properties: {
          amount: { type: 'number', description: 'Valor em reais' },
          method: { type: 'string', enum: ['PIX', 'CREDIT_CARD'] }
        }
      },
      body: { amount: 150, method: 'PIX' },
      scenarios: [
        {
          id: 'ok',
          name: 'Cobrança aprovada',
          overrides: { pathParams: { customerId: 'c-1' } },
          assertions: [{ target: 'status', operator: 'equals', expected: 201 }]
        },
        {
          id: 'boleto',
          name: 'Boleto recusado',
          overrides: { body: { amount: 10, method: 'BOLETO' } },
          assertions: [{ target: 'status', operator: 'equals', expected: 400 }]
        }
      ]
    },
    { id: 'list_charges', name: 'Listar cobranças', method: 'GET', path: '/charges' }
  ]
})
put(
  'connectors/billing.connector.vvpost.md',
  ['# Guia do Billing', '', 'Visão geral do serviço.', '', '## Efetuar cobrança {#charge_customer}', '', 'Cobra e devolve **PENDING**.'].join('\n')
)
put('environments/dev.env.json', {
  id: 'dev',
  name: 'Desenvolvimento',
  variables: {
    BASE_URL: { type: 'string', value: 'https://dev.api.empresa.com' },
    CLIENT_ID: { type: 'string', value: 'billing-client' },
    CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put('.vvpost/secrets.local.json', { dev: { CLIENT_SECRET: VAULT_SECRET } })
put('flows/checkout.flow.vvpost.json', {
  id: 'flow.checkout',
  name: 'Checkout',
  nodes: [
    { id: 'login', name: 'Login', type: 'request', request: { method: 'POST', url: '{{BASE_URL}}/login' } },
    { id: 'charge', name: 'Charge', type: 'request', request: { connector: 'connector.billing.v2', endpoint: 'charge_customer' } }
  ],
  edges: [{ from: 'login', to: 'charge' }]
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
    globalThis.__save = []
    dialog.showSaveDialog = async () => globalThis.__save.shift() ?? { canceled: true }
  }, workspace)
  const saveTo = (path) => app.evaluate((_e, p) => globalThis.__save.push({ canceled: false, filePath: p }), path)

  await win.getByRole('button', { name: 'Catálogo' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Abrir workspace…' }).click()
  const tree = panel.getByRole('navigation', { name: 'Hierarquia de conectores' })
  await tree.getByText('Billing Service v2').waitFor()

  // Botão direito no conector: o menu diz o nível e oferece os níveis acima.
  const billing = tree.getByRole('button', { name: /Billing Service v2/ })
  await billing.click({ button: 'right' })
  const menu = win.getByRole('menu', { name: 'Conector Billing Service v2' })
  await menu.waitFor()
  // As ações do conector (menus de contexto) vêm antes; a documentação fica no fim.
  const docsItems = (await menu.getByRole('menuitem').allInnerTexts()).filter((t) => t.startsWith('Gerar documentação'))
  assert.deepEqual(docsItems, ['Gerar documentação do conector\nPDF · .md', 'Gerar documentação do projeto'])
  await win.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })

  // Pelo teclado: → abre os endpoints, Shift+F10 abre o menu do endpoint focado.
  await billing.focus()
  await win.keyboard.press('ArrowRight')
  const endpointRow = tree.getByRole('button', { name: /Efetuar Cobrança/ })
  await endpointRow.waitFor()
  assert.equal(await billing.getAttribute('aria-expanded'), 'true')
  await endpointRow.focus()
  await win.keyboard.press('Shift+F10')
  const endpointMenu = win.getByRole('menu', { name: 'Endpoint Efetuar Cobrança' })
  await endpointMenu.waitFor()
  // O menu foca o primeiro item depois de aparecer: a tecla antes disso se perdia e o foco ficava no primeiro.
  await endpointMenu.locator('[role=menuitem]:focus').waitFor()
  // Typeahead: "G" vai para "Gerar documentação do endpoint" (o primeiro com G).
  await win.keyboard.press('g')
  assert.match(await endpointMenu.locator('[role=menuitem]:focus').innerText(), /^Gerar documentação do endpoint/)
  await win.keyboard.press('Enter')

  const viewer = win.getByRole('region', { name: 'Documentação gerada' })
  await viewer.getByRole('heading', { name: 'POST /customers/{customerId}/charges · Efetuar Cobrança', level: 2 }).waitFor()
  const article = viewer.getByRole('article')
  // Diagramas: hierarquia, auth, sequência e o fluxo que usa o endpoint.
  for (const name of [
    'Hierarquia de Billing Service v2',
    'Fluxo de autenticação de Billing Service v2',
    'Sequência de Efetuar Cobrança',
    'Fluxo Checkout'
  ]) {
    await article.getByRole('img', { name }).locator('svg').waitFor()
  }
  // Herança com a origem, schema, cenários e asserções, a documentação escrita.
  const effective = article.getByRole('table', { name: 'Configuração efetiva de Billing Service v2' })
  await effective.getByText('{{BASE_URL}}/billing/v2').waitFor()
  assert.ok((await effective.getByText('herdado de Corporate Base').count()) >= 2)
  await article.getByRole('table', { name: 'Headers efetivos de Efetuar Cobrança' }).getByText('X-Tenant').waitFor()
  await article.getByRole('table', { name: 'Campos do corpo de Efetuar Cobrança' }).getByText('Valor em reais').waitFor()
  await article.getByRole('table', { name: 'Asserções de Boleto recusado' }).getByText('400').waitFor()
  await article.getByText('Cobra e devolve').waitFor()
  await article.getByRole('table', { name: 'Variáveis usadas' }).getByText('Segredo').waitFor()
  assert.equal(await article.getByText('Mais 1 endpoint(s) do conector fora deste documento.').count(), 1)
  assert.ok(!(await viewer.innerText()).includes(VAULT_SECRET))
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-endpoint.png') })

  // Ctrl+F na documentação: procura no texto do documento, com contador e próxima/anterior.
  await win.keyboard.press('Control+f')
  const find = win.locator('input[aria-label="Buscar na tela"]')
  await find.fill('x-tenant')
  const counter = win.getByRole('search').getByText(/^\d+ de \d+$/)
  await counter.waitFor()
  const total = Number((await counter.textContent()).split(' de ')[1])
  assert.ok(total >= 2, `esperava X-Tenant mais de uma vez, achou ${total}`)
  await win.keyboard.press('Enter')
  await win.getByRole('search').getByText(`2 de ${total}`).waitFor()
  await win.waitForFunction(() => CSS.highlights.get('vv-find-current')?.size === 1)
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-busca.png') })
  await win.keyboard.press('Escape')
  await find.waitFor({ state: 'detached' })
  await viewer.waitFor()

  // .md: gerado de novo no main, com os blocos mermaid e sem segredo.
  const md = join(out, 'endpoint.md')
  await saveTo(md)
  await viewer.getByRole('button', { name: 'Salvar .md' }).click()
  await win.getByText(`Documentação em Markdown salva em ${md}`).waitFor()
  const text = readFileSync(md, 'utf8')
  assert.match(text, /^# POST \/customers\/\{customerId\}\/charges · Efetuar Cobrança/)
  assert.ok((text.match(/```mermaid/g) ?? []).length >= 4)
  assert.ok(!text.includes(VAULT_SECRET))

  // PDF: impresso numa janela oculta, a partir do mesmo Markdown, com os diagramas em SVG.
  const pdf = join(out, 'endpoint.pdf')
  await saveTo(pdf)
  await viewer.getByRole('button', { name: 'Salvar PDF' }).click()
  await win.getByText(`Documentação em PDF salva em ${pdf}`).waitFor({ timeout: 60_000 })
  const bytes = readFileSync(pdf)
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
  assert.ok(bytes.length > 20_000, `PDF pequeno demais: ${bytes.length} bytes`)
  assert.ok(!bytes.includes(Buffer.from(VAULT_SECRET)))
  if (screenshot) writeFileSync(screenshot.replace(/(\.png)?$/, '-endpoint.pdf'), bytes)

  await viewer.getByRole('button', { name: 'Fechar a documentação' }).click()
  await viewer.waitFor({ state: 'detached' })

  // Request: o nível mais baixo, aberto pelo botão direito no cenário.
  await endpointRow.focus()
  await win.keyboard.press('ArrowRight')
  await tree.getByRole('button', { name: /Boleto recusado/ }).click({ button: 'right' })
  await win.getByRole('menu', { name: 'Request Boleto recusado' }).getByRole('menuitem', { name: /da request/ }).click()
  await viewer.getByRole('heading', { name: 'Request Boleto recusado · POST /customers/{customerId}/charges', level: 2 }).waitFor()
  assert.equal(await viewer.getByRole('group', { name: 'Request Cobrança aprovada' }).count(), 0)
  await win.keyboard.press('Escape')
  await viewer.waitFor({ state: 'detached' })

  // Projeto: pela raiz da árvore e pela paleta de comandos, com o mapa do projeto.
  await tree.getByRole('button', { name: basename(workspace) }).click({ button: 'right' })
  await win.getByRole('menu', { name: `Projeto ${basename(workspace)}` }).getByRole('menuitem', { name: /^Gerar documentação do projeto/ }).click()
  await viewer.getByRole('heading', { name: `Documentação de ${basename(workspace)}`, level: 2 }).waitFor()
  await viewer.getByRole('img', { name: `Mapa do projeto ${basename(workspace)}` }).locator('svg').waitFor()
  await viewer.getByRole('navigation', { name: 'Sumário da documentação' }).getByText('Corporate Base').waitFor()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-projeto.png') })
  await viewer.getByRole('button', { name: 'Fechar a documentação' }).click()

  await win.keyboard.press('Control+K')
  await win.getByRole('dialog').getByRole('combobox').fill('documentação do projeto')
  await win.keyboard.press('Enter')
  await viewer.getByRole('heading', { name: `Documentação de ${basename(workspace)}`, level: 2 }).waitFor()

  // Trocar de módulo fecha a documentação.
  await win.getByRole('button', { name: 'Quick Request', exact: true }).click()
  await viewer.waitFor({ state: 'detached' })
  assert.ok(existsSync(md))
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
rmSync(out, { recursive: true, force: true })
console.log('E2E da documentação rica: ok')
