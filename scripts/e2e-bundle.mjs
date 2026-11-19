#!/usr/bin/env node
// Teste ponta a ponta do pacote do VVPost no app real (build de produção em out/):
// 1. com um projeto aberto, exporta uma seleção pela aba Exportar e confere que o arquivo
//    gravado é um pacote válido, sem nenhum valor de segredo e sem o conector desmarcado;
// 2. importa o pacote pela aba Importar: no próprio projeto tudo já existe (mesclar não
//    muda nada); noutra pasta, deixa o fluxo de fora e confere os arquivos gravados.
// Os diálogos nativos de arquivo são trocados por respostas fixas no main process.
// Uso: npm run build && node scripts/e2e-bundle.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

// Montados aqui: nada com cara de credencial fica no repositório.
const VAULT_TOKEN = ['vault', 'token', 'e2e', '4b7d'].join('-')
const PLAIN_PASSWORD = ['senha', 'e2e', '8c2f1a'].join('-')

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const project = mkdtempSync(join(tmpdir(), 'vvpost-bundle-src-'))
const other = mkdtempSync(join(tmpdir(), 'vvpost-bundle-dst-'))
const out = mkdtempSync(join(tmpdir(), 'vvpost-bundle-out-'))
const bundlePath = join(out, 'projeto.vvpost.bundle.json')

const put = (path, data) => {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
}
put('connectors/base.connector.vvpost.json', {
  id: 'base',
  name: 'Base',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } }
})
put('connectors/billing.connector.vvpost.json', {
  id: 'billing',
  name: 'Cobrança',
  version: '1.0.0',
  extends: 'base',
  endpoints: [
    {
      id: 'list',
      name: 'Listar',
      method: 'GET',
      path: '/charges',
      scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
    }
  ]
})
put('connectors/billing.connector.vvpost.md', '# Cobrança\n')
put('connectors/other.connector.vvpost.json', {
  id: 'other',
  name: 'Outro',
  version: '1.0.0',
  config: { baseUrl: 'https://outro.exemplo.com' },
  endpoints: [{ id: 'ping', name: 'Ping', method: 'GET', path: '/ping' }]
})
put('environments/dev.env.json', {
  id: 'dev',
  name: 'Dev',
  variables: {
    BASE_URL: { type: 'string', value: 'https://api.exemplo.com' },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
    db_password: { type: 'string', value: PLAIN_PASSWORD }
  }
})
put('flows/cobranca.flow.vvpost.json', {
  id: 'cobranca',
  name: 'Fluxo de cobrança',
  nodes: [{ id: 'n1', name: 'Listar', type: 'request', request: { connector: 'billing', endpoint: 'list' } }],
  edges: []
})
put('.vvpost/secrets.local.json', { dev: { API_TOKEN: VAULT_TOKEN } })
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: project }))

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})

/** Próximas respostas dos diálogos de abrir e salvar, na ordem em que o app vai pedir. */
const queueDialogs = (open, save = []) =>
  app.evaluate(
    ({ dialog }, { open, save }) => {
      globalThis.__open = open
      globalThis.__save = save
      dialog.showOpenDialog = async () => globalThis.__open.shift() ?? { canceled: true, filePaths: [] }
      dialog.showSaveDialog = async () => globalThis.__save.shift() ?? { canceled: true }
    },
    { open, save }
  )

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  await win.getByRole('button', { name: 'Importar e exportar' }).click()
  await win.getByRole('tab', { name: 'Exportar', exact: true }).click()

  // 1. Exportar sem o conector "Outro".
  const summary = win.getByLabel('Resumo da exportação')
  const stats = () => summary.locator(':scope > span').allTextContents()
  await summary.getByText('conectores').waitFor()
  assert.deepEqual(await stats(), ['3 conectores', '2 endpoints', '1 cenários', '1 ambientes', '1 fluxos', '1 documentações'])
  await win.getByRole('checkbox', { name: 'Outro', exact: true }).uncheck()
  await win.getByText('2 conectores').waitFor()
  await win.getByText('Avisos (1)').waitFor()
  const html = await win.content()
  for (const secret of [VAULT_TOKEN, PLAIN_PASSWORD]) assert.ok(!html.includes(secret), `segredo "${secret}" chegou ao renderer`)
  if (screenshot) await win.screenshot({ path: screenshot })

  await queueDialogs([], [{ canceled: false, filePath: bundlePath }])
  await win.getByRole('button', { name: 'Exportar pacote…' }).click()
  await win.getByText('Pacote salvo em').waitFor()
  const text = readFileSync(bundlePath, 'utf8')
  for (const secret of [VAULT_TOKEN, PLAIN_PASSWORD]) assert.ok(!text.includes(secret), `segredo "${secret}" no pacote`)
  const bundle = JSON.parse(text)
  assert.equal(bundle.$schema, 'https://vvpost.dev/schemas/v1/bundle.json')
  assert.deepEqual(
    bundle.connectors.map((c) => c.id),
    ['base', 'billing']
  )
  assert.equal(bundle.environments[0].variables.db_password.value, '__REQUIRED_SECRET__')
  assert.deepEqual(Object.keys(bundle.docs), ['billing'])

  // 1b. A mesma seleção como coleção do Postman (com o ambiente ao lado) e como spec OpenAPI em YAML.
  // O aviso de sucesso fica por cima do botão de exportar; dispensa antes de clicar de novo.
  const dismissToasts = async () => {
    for (const b of await win.getByRole('button', { name: 'Dispensar aviso' }).all()) await b.click()
  }
  await dismissToasts()
  await win.getByRole('radio', { name: 'Postman' }).click()
  await win.getByRole('button', { name: 'Exportar coleção do Postman…' }).waitFor()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/\.png$/, '-postman.png') })
  const collectionPath = join(out, 'projeto.postman_collection.json')
  await queueDialogs([], [{ canceled: false, filePath: collectionPath }])
  await win.getByRole('button', { name: 'Exportar coleção do Postman…' }).click()
  await win.getByText('1 ambiente(s) do Postman ao lado', { exact: false }).waitFor()
  const collectionText = readFileSync(collectionPath, 'utf8')
  const envText = readFileSync(join(out, 'projeto.dev.postman_environment.json'), 'utf8')
  for (const secret of [VAULT_TOKEN, PLAIN_PASSWORD]) assert.ok(!(collectionText + envText).includes(secret), `segredo "${secret}" no Postman`)
  const collection = JSON.parse(collectionText)
  assert.equal(collection.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json')
  assert.ok(JSON.parse(envText).values.some((v) => v.type === 'secret' && v.value === ''))

  await dismissToasts()
  await win.getByRole('radio', { name: 'OpenAPI' }).click()
  const specPath = join(out, 'projeto.openapi.yaml')
  await queueDialogs([], [{ canceled: false, filePath: specPath }])
  await win.getByRole('button', { name: 'Exportar spec OpenAPI…' }).click()
  await win.getByText(`Salvo em ${specPath}`).waitFor()
  const specText = readFileSync(specPath, 'utf8')
  assert.ok(specText.startsWith('openapi: 3.1.0'), specText.slice(0, 40))
  for (const secret of [VAULT_TOKEN, PLAIN_PASSWORD]) assert.ok(!specText.includes(secret), `segredo "${secret}" na spec`)
  await win.getByRole('radio', { name: 'Pacote do VVPost' }).click()

  // 2. Importar: no projeto aberto tudo já existe; noutra pasta, sem o fluxo.
  await win.getByRole('tab', { name: 'Importar', exact: true }).click()
  await queueDialogs([{ canceled: false, filePaths: [bundlePath] }, { canceled: false, filePaths: [other] }])
  await win.getByRole('button', { name: 'Escolher arquivos…' }).click()
  await win.getByText('0 arquivo(s) novo(s), 0 alterado(s)', { exact: false }).waitFor()
  await win.getByRole('button', { name: 'Outra pasta…' }).click()
  // Na pasta vazia os conectores entram como fluxos: a base, a de cobrança com o endpoint e a doc.
  await win.getByText('6 arquivo(s) novo(s), 0 alterado(s)', { exact: false }).waitFor()
  const importSummary = await win.getByLabel('Resumo da importação').locator(':scope > span').allTextContents()
  assert.ok(importSummary.includes('1 fluxos') && importSummary.includes('1 documentações'), importSummary.join(', '))

  await win.getByRole('button', { name: /Fluxo de cobrança/ }).click()
  await win.getByRole('complementary', { name: 'Revisão' }).getByRole('button', { name: 'Não importar' }).click()
  await win.getByText('Não importar o fluxo Fluxo de cobrança').waitFor()
  await win.getByText('5 arquivo(s) novo(s), 0 alterado(s)', { exact: false }).waitFor()
  await win.getByRole('button', { name: 'Importar no projeto' }).click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()

  assert.deepEqual(readdirSync(join(other, 'flows'), { recursive: true }).map((f) => String(f).replaceAll('\\', '/')).sort(), [
    'base',
    'base/base.flow.vvpost.json',
    'billing',
    'billing/billing.flow.vvpost.json',
    'billing/billing.flow.vvpost.md',
    'billing/list.flow.vvpost.json'
  ])
  assert.ok(!existsSync(join(other, 'connectors')))
  assert.ok(!existsSync(join(other, 'flows/cobranca.flow.vvpost.json')))
  const env = JSON.parse(readFileSync(join(other, 'environments/dev.env.json'), 'utf8'))
  assert.equal(env.variables.API_TOKEN.value, '__REQUIRED_SECRET__')
  assert.ok(!existsSync(join(other, '.vvpost/secrets.local.json')))
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
for (const dir of [userData, project, other, out]) rmSync(dir, { recursive: true, force: true })
console.log('E2E do pacote do VVPost: ok')
