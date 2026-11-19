#!/usr/bin/env node
// Teste ponta a ponta do importador do Postman no app real (build de produção em out/):
// 1. importa a coleção e o ambiente de test/fixtures/postman numa pasta escolhida e confere
//    a prévia, os arquivos e o vault;
// 2. importa de novo na mesma pasta: tudo já existe (mesclar não muda nada) e "substituir"
//    regrava o conector;
// 3. importa outra coleção no mesmo projeto, mescla as variações em cenários, move um
//    endpoint para um conector que já estava no projeto e confere o que foi gravado.
// Os diálogos nativos de arquivo são trocados por respostas fixas no main process.
// Uso: npm run build && node scripts/e2e-postman-import.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { connectorOf, readVault } from './e2e-helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const fixtures = join(root, 'test/fixtures/postman')
const screenshot = process.env.E2E_SCREENSHOT

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})

/** Próximas respostas do showOpenDialog, na ordem em que o app vai pedir. */
const queueDialogs = (...answers) =>
  app.evaluate(({ dialog }, answers) => {
    globalThis.__dialogAnswers = answers
    dialog.showOpenDialog = async () =>
      globalThis.__dialogAnswers.shift() ?? { canceled: true, filePaths: [] }
  }, answers)

const readJson = (path) => JSON.parse(readFileSync(join(workspace, path), 'utf8'))
/** Num workspace vazio o import grava fluxos: cada conector é uma pasta em flows/. */
const baseFile = (id) => `flows/${id}/${id}.flow.vvpost.json`
const filesUnder = (dir) =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)]))

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const summary = win.getByLabel('Resumo da importação')
  const stats = () => summary.locator(':scope > span').allTextContents()
  const importButton = win.getByRole('button', { name: 'Importar no projeto' })
  const tree = win.getByRole('tree', { name: 'Conectores do import' })
  const inspector = win.getByRole('complementary', { name: 'Revisão' })
  // O primeiro botão do item é a linha do conector; os seguintes são os endpoints.
  const connectorRow = (name) => tree.getByRole('treeitem', { name, exact: true }).getByRole('button').first()

  await win.getByRole('button', { name: 'Importar e exportar' }).click()

  // 1. Coleção + ambiente numa pasta escolhida (sem workspace aberto).
  await queueDialogs(
    {
      canceled: false,
      filePaths: [join(fixtures, 'billing.postman_collection.json'), join(fixtures, 'dev.postman_environment.json')]
    },
    { canceled: false, filePaths: [workspace] }
  )
  await win.getByRole('button', { name: 'Escolher arquivos…' }).click()
  await summary.waitFor()
  assert.deepEqual(await stats(), [
    '6 conectores novos',
    '8 endpoints',
    '1 cenários',
    '2 ambientes',
    '8 segredos fora do Git'
  ])
  await win.getByText('Nenhum projeto aberto: escolha a pasta de destino.').waitFor()
  assert.equal(await importButton.isDisabled(), true)
  await tree.getByText('connector.servico-de-cobranca.cobrancas.webhooks-legados', { exact: true }).waitFor()
  await tree.getByText('/charges/{chargeId}', { exact: true }).waitFor()
  assert.ok((await win.locator('body').textContent()).includes('Avisos (6)'))
  // A prévia não carrega nenhum valor de segredo para o renderer.
  const html = await win.content()
  for (const secret of ['token-dev', 'senha-do-banco', 'chave-fixa-123', 'segredo-literal']) {
    assert.ok(!html.includes(secret), `segredo "${secret}" chegou ao renderer`)
  }

  await win.getByRole('button', { name: 'Escolher pasta de destino…' }).click()
  await win.getByText('16 arquivo(s) novo(s), 0 alterado(s)', { exact: false }).waitFor()
  await importButton.click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()

  const folders = readdirSync(join(workspace, 'flows')).sort()
  assert.equal(folders.length, 6)
  assert.ok(folders.includes('connector.servico-de-cobranca'))
  assert.equal(connectorOf(workspace, 'connector.servico-de-cobranca').name, 'Serviço de Cobrança')
  assert.deepEqual(readdirSync(join(workspace, 'environments')).sort(), [
    'cobranca-dev.env.json',
    'servico-de-cobranca.env.json'
  ])
  const committed = [
    ...filesUnder(join(workspace, 'flows')).map((f) => readFileSync(f, 'utf8')),
    readFileSync(join(workspace, 'environments/cobranca-dev.env.json'), 'utf8'),
    readFileSync(join(workspace, 'environments/servico-de-cobranca.env.json'), 'utf8')
  ].join('\n')
  assert.ok(!committed.includes('token-dev') && !committed.includes('chave-fixa-123'), 'segredo em arquivo versionável')
  const secrets = readVault(workspace)
  assert.equal(secrets['env.cobranca-dev'].db_password, 'senha-do-banco')
  assert.ok(!existsSync(join(workspace, '.vvpost/secrets.local.json')), 'segredo em texto puro na pasta do projeto')

  // 2. De novo na mesma pasta, depois de uma edição no projeto: o padrão é mesclar, que
  //    mantém a edição e não muda nada; "substituir" volta o conector ao do Postman.
  const rootFile = baseFile('connector.servico-de-cobranca')
  writeFileSync(join(workspace, rootFile), JSON.stringify({ ...readJson(rootFile), name: 'Cobrança (editado)' }, null, 2))
  await queueDialogs(
    {
      canceled: false,
      filePaths: [join(fixtures, 'billing.postman_collection.json'), join(fixtures, 'dev.postman_environment.json')]
    },
    { canceled: false, filePaths: [workspace] }
  )
  await win.getByRole('button', { name: 'Escolher arquivos…' }).click()
  await win.getByRole('button', { name: 'Escolher pasta de destino…' }).click()
  await win.getByText('0 arquivo(s) novo(s), 0 alterado(s)', { exact: false }).waitFor()
  assert.equal(await importButton.isDisabled(), true)
  await connectorRow('Cobrança (editado)').click()
  await inspector.getByLabel('Quando o id já existe').selectOption('replace')
  await win.getByText('0 arquivo(s) novo(s), 1 alterado(s)', { exact: false }).waitFor()
  await importButton.click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()
  assert.equal(readJson(rootFile).name, 'Serviço de Cobrança')

  // 3. Outra coleção no mesmo projeto: variações viram cenários e um endpoint vai para
  //    um conector que já estava no projeto.
  await queueDialogs(
    { canceled: false, filePaths: [join(fixtures, 'users.postman_collection.json')] },
    { canceled: false, filePaths: [workspace] }
  )
  await win.getByRole('button', { name: 'Escolher arquivos…' }).click()
  await win.getByRole('button', { name: 'Escolher pasta de destino…' }).click()
  await win.getByText(/4 requisição\(ões\) parecem variações/).waitFor()
  await win.getByRole('button', { name: 'Mesclar em cenários' }).click()
  await win.getByText(/parecem variações/).waitFor({ state: 'detached' })
  assert.deepEqual(await stats(), [
    '3 conectores novos',
    '5 endpoints',
    '6 cenários',
    '1 ambientes',
    '0 segredos fora do Git'
  ])

  await tree.getByRole('treeitem', { name: 'Auditoria' }).getByRole('button').click()
  await inspector.getByLabel('Mover para').selectOption({ label: 'Serviço de Cobrança (connector.servico-de-cobranca)' })
  await tree.getByText('no projeto · recebe itens').waitFor()

  await connectorRow('Admin').click()
  await inspector.getByLabel('Nome', { exact: true }).fill('Administração')
  await inspector.getByLabel('Nome', { exact: true }).press('Enter')
  await connectorRow('Administração').waitFor()
  await inspector.getByText('Renomear conector para "Administração"').waitFor()
  if (screenshot) await win.screenshot({ path: screenshot })

  // O endpoint movido entra como arquivo novo ao lado da base que já estava no projeto.
  await win.getByText('9 arquivo(s) novo(s), 0 alterado(s)', { exact: false }).waitFor()
  await importButton.click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()

  const cad = connectorOf(workspace, 'connector.usuarios.cadastro')
  assert.deepEqual(
    cad.endpoints.map((e) => e.id),
    ['buscar_usuario', 'criar_usuario', 'listar_usuarios']
  )
  const notFound = cad.endpoints[0].scenarios.find((s) => s.id === 'nao_encontrado')
  assert.deepEqual(notFound.overrides, { pathParams: { id: '999' } })
  assert.deepEqual(notFound.assertions, [{ target: 'status', operator: 'equals', expected: 404 }])
  assert.equal(connectorOf(workspace, 'connector.usuarios.admin').name, 'Administração')
  const billing = connectorOf(workspace, 'connector.servico-de-cobranca')
  assert.ok(billing.endpoints.some((e) => e.id === 'auditoria' && e.path === '/audit'))
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E do importador do Postman: ok')
