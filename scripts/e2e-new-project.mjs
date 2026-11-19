#!/usr/bin/env node
// Teste ponta a ponta do projeto novo a partir de um modelo no app real (build de
// produção em out/): sem workspace, a paleta abre o diálogo; o modelo "API REST com token" mostra
// os arquivos antes da pasta; a pasta vazia recebe conector, ambientes, .gitignore e o repositório
// Git, o workspace abre com o segredo pendente e o Quick Request já tem o conector. Uma pasta com
// arquivos é recusada sem gravar nada.
// Uso: npm run build && node scripts/e2e-new-project.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')

const parent = mkdtempSync(join(tmpdir(), 'vvpost-new-project-'))
const empty = join(parent, 'minha-api')
const busy = join(parent, 'ocupada')
for (const d of [empty, busy]) rmSync(d, { recursive: true, force: true })
const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const pick = (dir) =>
    app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] })
    }, dir)
  await win.getByRole('navigation', { name: 'Módulos' }).waitFor()

  // Uma pasta com arquivos escritos à mão: recusada, e nada é gravado nela.
  mkdirSync(busy)
  writeFileSync(join(busy, 'notas.txt'), 'meu arquivo')
  await pick(busy)
  await win.keyboard.press('Control+k')
  await win.keyboard.type('novo projeto')
  await win.keyboard.press('Enter')
  const dialog = win.getByRole('dialog', { name: 'Novo projeto' })
  await dialog.waitFor()
  const templates = dialog.getByRole('radiogroup', { name: 'Modelo do projeto' })
  await templates.getByRole('radio', { name: /Projeto vazio/ }).waitFor()
  await templates.getByRole('radio', { name: /API REST com token/ }).check()
  const files = dialog.getByRole('list', { name: 'Arquivos do modelo' })
  await files.getByText('flows/api/api.flow.vvpost.json').waitFor()
  await files.getByText('environments/hml.env.json').waitFor()
  await dialog.getByRole('button', { name: 'Escolher a pasta e criar' }).click()
  const refused = dialog.getByRole('alert').filter({ hasText: 'O projeto não foi criado' })
  await refused.getByText(/já tem o arquivo notas\.txt/).waitFor()
  assert.deepEqual(readdirSync(busy), ['notas.txt'])

  // Pasta vazia: grava o modelo, inicia o Git e abre como workspace.
  await pick(empty)
  mkdirSync(empty)
  await dialog.getByRole('button', { name: 'Escolher a pasta e criar' }).click()
  await dialog.waitFor({ state: 'detached' })
  await win.getByText(/Projeto criado em .*minha-api\. Configure os 2 segredos pendentes em Secrets\./).waitFor()
  assert.ok(existsSync(join(empty, '.git')), 'o repositório Git não foi iniciado')
  assert.equal(readFileSync(join(empty, '.gitignore'), 'utf8'), '.vvpost/secrets.local.json\n')
  // O modelo nasce em fluxos: a base com a URL e a auth, e uma requisição por arquivo.
  const base = JSON.parse(readFileSync(join(empty, 'flows/api/api.flow.vvpost.json'), 'utf8'))
  assert.deepEqual(base.defaults.auth, { type: 'bearer', token: '{{API_TOKEN}}' })
  assert.equal(JSON.parse(readFileSync(join(empty, 'flows/api/list_items.flow.vvpost.json'), 'utf8')).extends, 'api')
  const dev = JSON.parse(readFileSync(join(empty, 'environments/dev.env.json'), 'utf8'))
  assert.equal(dev.variables.API_TOKEN.value, '__REQUIRED_SECRET__')

  // O Quick Request abre com o conector do modelo no contexto.
  const quick = win.locator('main > div:not([hidden])')
  await quick.getByLabel('Conector').locator('option', { hasText: 'Minha API' }).waitFor({ state: 'attached' })
  await win.locator('footer').getByText(/Git: /).waitFor()
  assert.deepEqual(errors, [])
  console.log('E2E do projeto novo a partir de um modelo: ok')
} finally {
  await app.close()
  for (const d of [userData, parent]) rmSync(d, { recursive: true, force: true })
}
