#!/usr/bin/env node
// Teste ponta a ponta do import de OpenAPI no app real (build de produção em out/):
// 1. abre um projeto com a spec YAML dentro, importa pela revisão e confere os conectores
//    (raiz com servidor e auth, tags como filhos) e o caminho relativo da spec;
// 2. muda a spec no disco, edita um endpoint no projeto e usa "Reimportar a spec" no
//    Catálogo: a revisão marca o que mudou na spec, o conflito e o que saiu da spec,
//    mostra as diferenças, e a escolha "Apagar o endpoint" vale na gravação; o cenário
//    do endpoint atualizado continua.
// Os diálogos nativos de arquivo são trocados por respostas fixas no main process.
// Uso: npm run build && node scripts/e2e-openapi-import.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { connectorOf } from './e2e-helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const specPath = join(workspace, 'petstore.openapi.yaml')
copyFileSync(join(root, 'test/fixtures/openapi/petstore.openapi.yaml'), specPath)
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})

/** Próximas respostas do showOpenDialog, na ordem em que o app vai pedir. */
const queueDialogs = (...answers) =>
  app.evaluate(({ dialog }, answers) => {
    globalThis.__dialogAnswers = answers
    dialog.showOpenDialog = async () => globalThis.__dialogAnswers.shift() ?? { canceled: true, filePaths: [] }
  }, answers)

// Num workspace vazio o import grava fluxos: um fluxo-base por conector e um arquivo por endpoint.
const readConnector = (id) => connectorOf(workspace, id)
const endpointFile = (connectorId, endpointId) => join(workspace, `flows/${connectorId}/${endpointId}.flow.vvpost.json`)
const editFlow = (file, edit) => writeFileSync(file, `${JSON.stringify(edit(JSON.parse(readFileSync(file, 'utf8'))), null, 2)}\n`)

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const panel = win.locator('main > div:not([hidden])')
  const summary = win.getByLabel('Resumo da importação')
  const stats = () => summary.locator(':scope > span').allTextContents()
  const importButton = win.getByRole('button', { name: 'Importar no projeto' })
  const tree = win.getByRole('tree', { name: 'Conectores do import' })
  const inspector = win.getByRole('complementary', { name: 'Revisão' })

  // Projeto aberto (vazio, só com a spec).
  await queueDialogs({ canceled: false, filePaths: [workspace] })
  await win.getByRole('button', { name: 'Catálogo' }).click()
  await panel.getByRole('button', { name: 'Abrir workspace…' }).click()
  await panel.getByText(/0 conectores/).waitFor()

  // 1. Import da spec pela revisão.
  await win.getByRole('button', { name: 'Importar e exportar' }).click()
  await win.getByRole('form', { name: 'Importar de uma URL' }).waitFor()
  await queueDialogs({ canceled: false, filePaths: [specPath] })
  await win.getByRole('button', { name: 'Escolher arquivos…' }).click()
  await summary.waitFor()
  assert.deepEqual(await stats(), ['3 conectores novos', '7 endpoints', '0 cenários', '0 ambientes', '0 segredos fora do Git'])
  await win.getByText('Loja de Pets (OpenAPI 3.0.3)').waitFor()
  await tree.getByText('loja-de-pets.tutores', { exact: true }).waitFor()
  await tree.getByText('/pets/{petId}/photo', { exact: true }).waitFor()
  // 3 fluxos-base, 7 endpoints e um schema compartilhado por componente (NewPet e Owner).
  await win.getByText('12 arquivo(s) novo(s), 0 alterado(s)', { exact: false }).waitFor()
  await importButton.click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()

  const rootConnector = readConnector('loja-de-pets')
  assert.deepEqual(rootConnector.source, { type: 'openapi', location: 'petstore.openapi.yaml', version: '1.2' })
  assert.equal(rootConnector.config.baseUrl, 'https://sa.pets.example.com/v1')
  assert.deepEqual(rootConnector.config.auth, { type: 'bearer', token: '{{LOJA_DE_PETS_TOKEN}}' })
  const pets = readConnector('loja-de-pets.pets')
  assert.deepEqual(pets.endpoints.map((e) => e.id), ['listPets', 'createPet', 'getPet', 'deletePet', 'uploadPhoto'])
  // O componente fica uma vez em schemas/, citado pelo arquivo do endpoint; o pacote exportado leva o schema resolvido.
  assert.deepEqual(JSON.parse(readFileSync(endpointFile('loja-de-pets.pets', 'createPet'), 'utf8')).nodes[0].request.bodySchema, { $ref: 'schema:NewPet' })
  assert.equal(pets.endpoints.find((e) => e.id === 'createPet').bodySchema.$ref, '#/$defs/NewPet')
  assert.equal(JSON.parse(readFileSync(join(workspace, 'schemas/NewPet.schema.json'), 'utf8')).type, 'object')

  // 2. A spec muda; no projeto, createPet ganha um cenário e getPet um nome próprio.
  const create = { scenarios: [{ id: 'ok', name: 'Cria', assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }] }
  editFlow(endpointFile('loja-de-pets.pets', 'createPet'), (flow) => ({ ...flow, ...create }))
  editFlow(endpointFile('loja-de-pets.pets', 'getPet'), (flow) => ({ ...flow, name: 'Buscar pet pelo id' }))
  writeFileSync(
    specPath,
    readFileSync(specPath, 'utf8')
      .replace('summary: Cadastrar pet', 'summary: Cadastrar um pet')
      .replace('summary: Buscar pet', 'summary: Obter pet')
      .replace(/ {4}delete:\n(?: {6}.*\n)+/, '')
  )

  await win.getByRole('button', { name: 'Catálogo' }).click()
  const catalogTree = panel.getByRole('navigation', { name: 'Hierarquia de conectores' })
  await catalogTree.getByRole('button').filter({ hasText: /^└?Pets\d+$/ }).click()
  await panel.getByRole('button', { name: 'Reimportar a spec' }).click()

  // A revisão anterior continua na tela até a reimportação chegar.
  await tree.getByText('mudou na spec · aplicar').waitFor()
  assert.deepEqual(await stats(), [
    '0 conectores novos',
    '0 endpoints',
    '0 cenários',
    '1 atualizados pela spec',
    '1 em conflito',
    '1 fora da spec',
    '0 ambientes',
    '0 segredos fora do Git'
  ])
  await tree.getByText('conflito · manter').waitFor()
  await tree.getByText('saiu da spec · manter').click()
  await inspector.getByText('A operação não está mais na spec.', { exact: false }).waitFor()
  await inspector.getByLabel('Apagar o endpoint').click()
  await tree.getByText('saiu da spec · apagar').waitFor()
  await tree.getByText('conflito · manter').click()
  await inspector.getByText('Buscar pet pelo id', { exact: true }).waitFor()
  await inspector.getByText('Obter pet', { exact: true }).waitFor()
  if (screenshot) await win.screenshot({ path: screenshot })

  // createPet muda e o arquivo de deletePet sai.
  await win.getByText('0 arquivo(s) novo(s), 2 alterado(s)', { exact: false }).waitFor()
  await importButton.click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()

  const after = readConnector('loja-de-pets.pets')
  assert.deepEqual(after.endpoints.map((e) => e.id), ['listPets', 'createPet', 'getPet', 'uploadPhoto'])
  const created = after.endpoints.find((e) => e.id === 'createPet')
  assert.equal(created.name, 'Cadastrar um pet')
  assert.deepEqual(created.scenarios, create.scenarios)
  assert.equal(after.endpoints.find((e) => e.id === 'getPet').name, 'Buscar pet pelo id')
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E do import de OpenAPI: ok')
