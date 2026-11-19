#!/usr/bin/env node
// Teste ponta a ponta dos importadores de Insomnia, Bruno, HAR e WSDL no app real (build de
// produção em out/):
// 1. "Pasta do Bruno…" lê a coleção de test/fixtures/bruno/loja, mostra a revisão (com o conector
//    filho da auth AWS da requisição) e grava numa pasta escolhida, com o .env só no vault;
// 2. "Escolher arquivos…" importa no mesmo projeto uma exportação do Insomnia, um HAR e um WSDL de
//    uma vez, e confere os conectores, o envelope SOAP e os exemplos de resposta do HAR.
// Os diálogos nativos são trocados por respostas fixas no main process.
// Uso: npm run build && node scripts/e2e-foreign-import.mjs   (Linux sem display: xvfb-run -a)
// E2E_SCREENSHOT_DIR=<pasta> guarda as capturas da revisão (bruno.png e varios.png).
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { connectorOf, connectorsOf, readVault } from './e2e-helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const fixtures = join(root, 'test/fixtures')
const shots = process.env.E2E_SCREENSHOT_DIR

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})

/** Próximas respostas do showOpenDialog, na ordem em que o app vai pedir; guarda as opções pedidas. */
const queueDialogs = (...answers) =>
  app.evaluate(({ dialog }, answers) => {
    globalThis.__dialogAnswers = answers
    globalThis.__dialogOptions = []
    dialog.showOpenDialog = async (...args) => {
      globalThis.__dialogOptions.push(args.at(-1))
      return globalThis.__dialogAnswers.shift() ?? { canceled: true, filePaths: [] }
    }
  }, answers)
const dialogOptions = () => app.evaluate(() => globalThis.__dialogOptions)

const readJson = (path) => JSON.parse(readFileSync(join(workspace, path), 'utf8'))

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const summary = win.getByLabel('Resumo da importação')
  const stats = () => summary.locator(':scope > span').allTextContents()
  const importButton = win.getByRole('button', { name: 'Importar no projeto' })
  const tree = win.getByRole('tree', { name: 'Conectores do import' })

  await win.getByRole('button', { name: 'Importar e exportar' }).click()

  // 1. A pasta de uma coleção do Bruno.
  await queueDialogs({ canceled: false, filePaths: [join(fixtures, 'bruno/loja')] }, { canceled: false, filePaths: [workspace] })
  await win.getByRole('button', { name: 'Pasta do Bruno…' }).click()
  await summary.waitFor()
  assert.deepEqual((await dialogOptions())[0].properties, ['openDirectory'])
  assert.deepEqual(await stats(), ['3 conectores novos', '4 endpoints', '1 cenários', '3 ambientes', '3 segredos fora do Git'])
  await tree.getByText('connector.loja-bruno.pedidos.upload', { exact: true }).waitFor()
  await win.getByText('Loja Bruno', { exact: true }).first().waitFor()
  const html = await win.content()
  for (const secret of ['tok_live_abcdef123456', 'segredo-aws', 'AKIAABCDEFGHIJKLMNOP']) {
    assert.ok(!html.includes(secret), `segredo "${secret}" chegou ao renderer`)
  }
  await win.getByRole('button', { name: 'Escolher pasta de destino…' }).click()
  await win.getByText(/arquivo\(s\) novo\(s\)/).waitFor()
  if (shots) await win.screenshot({ path: join(shots, 'bruno.png') })
  await importButton.click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()
  // Num workspace vazio o import grava fluxos; o conector é o que eles dão.
  const upload = connectorOf(workspace, 'connector.loja-bruno.pedidos.upload')
  assert.equal(upload.config.auth.type, 'awsSigV4')
  assert.equal(upload.config.auth.secretAccessKey, '{{AWS_SECRET_ACCESS_KEY}}')
  assert.equal(readVault(workspace)['env.loja-bruno-env'].LOJA_TOKEN, 'tok_live_abcdef123456')

  // 2. Insomnia, HAR e WSDL de uma vez, no mesmo projeto.
  await queueDialogs(
    {
      canceled: false,
      filePaths: [join(fixtures, 'insomnia/loja.insomnia.json'), join(fixtures, 'har/loja.har'), join(fixtures, 'wsdl/calculadora.wsdl')]
    },
    { canceled: false, filePaths: [workspace] }
  )
  await win.getByRole('button', { name: 'Escolher arquivos…' }).first().click()
  await win.getByText('Loja, loja, CalculadoraService, LegadoService', { exact: false }).waitFor()
  const extensions = (await dialogOptions())[0].filters[0].extensions
  for (const ext of ['bru', 'har', 'wsdl']) assert.ok(extensions.includes(ext), `filtro sem .${ext}`)
  await win.getByRole('button', { name: 'Escolher pasta de destino…' }).click()
  await tree.getByText('connector.calculadoraservice', { exact: true }).waitFor()
  assert.equal(await win.getByText(/parecem variações/).count(), 0, 'operações SOAP sugeridas como variações')
  await tree.getByText('connector.loja-2.api-loja-dev', { exact: true }).waitFor()
  if (shots) await win.screenshot({ path: join(shots, 'varios.png') })
  await importButton.click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()

  const connectors = connectorsOf(workspace)
  for (const id of ['connector.calculadoraservice', 'connector.legadoservice', 'connector.loja.pedidos', 'connector.loja-2.api-loja-dev']) {
    assert.ok(connectors[id], `${id} não foi gravado: ${Object.keys(connectors).join(', ')}`)
  }
  const soap = connectors['connector.calculadoraservice'].endpoints.find((e) => e.id === 'somar')
  assert.equal(soap.headers.SOAPAction, '"http://exemplo.dev/calculadora/Somar"')
  assert.ok(soap.body.includes('<tns:Somar>'))
  const har = connectors['connector.loja-2.api-loja-dev']
  assert.deepEqual(har.endpoints[0].examples.map((x) => x.status), [200, 404])
  const filesUnder = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]))
  const committed = filesUnder(join(workspace, 'flows')).map((f) => readFileSync(f, 'utf8')).join('\n')
  for (const secret of ['chave-da-api-123', 's3nh4-fixa', 'cs-123456', 'nao-deveria-ir']) {
    assert.ok(!committed.includes(secret), `segredo "${secret}" em arquivo versionável`)
  }
  assert.deepEqual(errors, [])
  console.log('e2e de Insomnia, Bruno, HAR e WSDL: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
