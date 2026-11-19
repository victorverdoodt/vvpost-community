#!/usr/bin/env node
// Teste ponta a ponta do módulo Secrets no app real (build de produção em out/): lista os
// segredos de cada ambiente com o estado (configurado, pendente, texto puro, sem isSecret),
// grava um pendente pelo SecretField só de escrita, substitui um configurado com confirmação,
// cria, edita e exclui variáveis e ambientes, e confere que nenhum valor de segredo chega à tela.
// Uso: npm run build && node scripts/e2e-secrets-module.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readVault } from './e2e-helpers.mjs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
const json = (v) => `${JSON.stringify(v, null, 2)}\n`

const STORED = 'postgres://e2e:guardado@localhost/app'
const PLAIN = 'sk_live_texto_puro'
const UNMARKED = 'ak_sem_marcacao'
const TYPED = 'cs_digitado_agora'
const REPLACED = 'postgres://e2e:novo@localhost/app'
const HOOK = 'whsec_criado_no_app'

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-secrets-ws-'))
mkdirSync(join(workspace, 'environments'))
mkdirSync(join(workspace, '.vvpost'))
writeFileSync(
  join(workspace, 'environments/dev.env.json'),
  json({
    id: 'env.dev',
    name: 'Development',
    variables: {
      BASE_URL: { type: 'string', value: 'http://localhost' },
      DATABASE_URL: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true, description: 'Banco local' },
      CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true, placeholder: 'cs_...' },
      STRIPE_KEY: { type: 'string', value: PLAIN, isSecret: true },
      API_KEY: { type: 'string', value: UNMARKED }
    }
  })
)
writeFileSync(
  join(workspace, 'environments/hml.env.json'),
  json({ id: 'env.hml', name: 'Homologação', variables: { BASE_URL: { type: 'string', value: 'http://hml.local' } } })
)
writeFileSync(join(workspace, '.vvpost/secrets.local.json'), json({ 'env.dev': { DATABASE_URL: STORED } }))

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), json({ dir: workspace }))

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  await win.getByRole('button', { name: 'Secrets', exact: true }).click()
  const panel = win.locator('main > div:not([hidden])')
  const rows = panel.getByRole('table', { name: 'Segredos de Development' })
  const state = async (name) =>
    rows
      .locator('tr', { has: win.getByRole('button', { name, exact: true }) })
      .locator('td')
      .nth(1)
      .textContent()
  await rows.waitFor()
  assert.equal(await state('DATABASE_URL'), 'Configurado')
  assert.equal(await state('CLIENT_SECRET'), 'Pendente')
  assert.equal(await state('STRIPE_KEY'), 'Texto puro')
  assert.equal(await state('API_KEY'), 'Sem isSecret')
  assert.equal(await rows.getByRole('button', { name: 'BASE_URL', exact: true }).count(), 0)

  // O pendente recebe valor pelo campo só de escrita, sem o valor voltar para a tela.
  await rows.getByRole('button', { name: 'CLIENT_SECRET', exact: true }).click()
  const inspector = panel.getByRole('complementary', { name: 'Inspector' })
  await inspector.getByText('{{CLIENT_SECRET}}').waitFor()
  await inspector.getByText('revelar indisponível').waitFor()
  await inspector.getByRole('button', { name: 'Definir valor' }).click()
  await inspector.getByLabel('Novo valor de CLIENT_SECRET').fill(TYPED)
  await inspector.getByRole('button', { name: 'Salvar no vault local' }).click()
  await win.getByText('CLIENT_SECRET gravado no vault local de Development.').waitFor()
  await rows
    .locator('tr', { has: win.getByRole('button', { name: 'CLIENT_SECRET', exact: true }) })
    .getByText('Configurado')
    .waitFor()

  // Alterar secret: substituir um valor configurado pede confirmação com escopo e impacto.
  const storeFile = () => readVault(workspace)
  await rows.getByRole('button', { name: 'DATABASE_URL', exact: true }).click()
  const replace = async () => {
    await inspector.getByRole('button', { name: 'Substituir valor' }).click()
    await inspector.getByLabel('Novo valor de DATABASE_URL').fill(REPLACED)
    await inspector.getByRole('button', { name: 'Salvar no vault local' }).click()
  }
  const confirmReplace = win.getByRole('dialog', { name: 'Substituir o valor de DATABASE_URL em Development?' })
  await replace()
  await confirmReplace.getByText(/passam a usar o novo, e os tokens em cache são descartados/).waitFor()
  await confirmReplace.getByRole('button', { name: 'Cancelar' }).click()
  assert.equal(storeFile()['env.dev'].DATABASE_URL, STORED)
  await replace()
  await confirmReplace.getByRole('button', { name: 'Substituir' }).click()
  await win.getByText('DATABASE_URL substituído no vault local de Development.').waitFor()
  assert.equal(storeFile()['env.dev'].DATABASE_URL, REPLACED)

  // Variáveis: valores à vista só para o que não é segredo nem tem nome de credencial.
  const devVars = panel.getByRole('table', { name: 'Variáveis de Development' })
  const devRow = (name) => devVars.locator('tr', { has: win.getByRole('cell', { name, exact: true }) })
  assert.equal(await devRow('BASE_URL').locator('td').nth(2).textContent(), 'http://localhost')
  for (const name of ['DATABASE_URL', 'STRIPE_KEY', 'API_KEY']) await devRow(name).getByLabel('valor oculto').waitFor()
  // Com um segredo em texto puro o arquivo não passa no schema: o app diz o que corrigir e não edita.
  await panel.getByRole('alert').getByText(/environments\/dev\.env\.json não passa no schema \(\/variables\/STRIPE_KEY\/value/).waitFor()
  await panel.getByRole('alert').getByText('SCHEMA_INVALID').waitFor()
  assert.ok(await panel.getByRole('button', { name: 'Nova variável' }).isDisabled())

  await panel.getByLabel('Ambiente dos segredos').selectOption('env.hml')
  const envFile = () => JSON.parse(readFileSync(join(workspace, 'environments/hml.env.json'), 'utf8'))
  const vars = panel.getByRole('table', { name: 'Variáveis de Homologação' })
  const row = (name) => vars.locator('tr', { has: win.getByRole('cell', { name, exact: true }) })
  await row('BASE_URL').waitFor()

  await panel.getByRole('button', { name: 'Nova variável' }).click()
  let form = inspector.getByRole('form', { name: 'Nova variável' })
  await form.getByLabel('Nome da variável').fill('TIMEOUT_MS')
  await form.getByLabel('Tipo da variável').selectOption('number')
  await form.getByLabel('Valor da variável').fill('abc')
  await form.getByText('Digite um número.').waitFor()
  await form.getByLabel('Valor da variável').fill('3000')
  await form.getByRole('button', { name: 'Criar variável' }).click()
  await row('TIMEOUT_MS').waitFor()
  assert.deepEqual(envFile().variables.TIMEOUT_MS, { type: 'number', value: 3000 })

  // Variável nova marcada como segredo: o valor vai para o vault, o arquivo fica com o marcador.
  await panel.getByRole('button', { name: 'Nova variável' }).click()
  form = inspector.getByRole('form', { name: 'Nova variável' })
  await form.getByLabel('Nome da variável').fill('WEBHOOK_SECRET')
  await form.getByLabel('Segredo (isSecret)').check()
  await form.getByLabel('Valor da variável').fill(HOOK)
  await form.getByRole('button', { name: 'Criar variável' }).click()
  await row('WEBHOOK_SECRET').waitFor()
  assert.deepEqual(envFile().variables.WEBHOOK_SECRET, { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true })
  assert.equal(storeFile()['env.hml'].WEBHOOK_SECRET, HOOK)
  const hmlSecrets = panel.getByRole('table', { name: 'Segredos de Homologação' })
  await hmlSecrets.locator('tr', { has: win.getByRole('button', { name: 'WEBHOOK_SECRET', exact: true }) }).getByText('Configurado').waitFor()

  await vars.getByRole('button', { name: 'Editar BASE_URL' }).click()
  form = inspector.getByRole('form', { name: 'Editar a variável BASE_URL' })
  await form.getByLabel('Valor da variável').fill('http://127.0.0.1:9')
  await form.getByLabel('Descrição da variável').fill('Origem da API')
  await form.getByRole('button', { name: 'Salvar variável' }).click()
  await row('BASE_URL').getByText('http://127.0.0.1:9').waitFor()
  assert.deepEqual(envFile().variables.BASE_URL, { type: 'string', value: 'http://127.0.0.1:9', description: 'Origem da API' })

  await vars.getByRole('button', { name: 'Excluir TIMEOUT_MS' }).click()
  await win.getByRole('dialog', { name: 'Excluir a variável TIMEOUT_MS?' }).getByRole('button', { name: 'Excluir' }).click()
  await win.getByText('TIMEOUT_MS excluída de Homologação.').waitFor()
  assert.equal(envFile().variables.TIMEOUT_MS, undefined)

  // Ambiente novo, renomeado e excluído pelo app.
  await panel.getByRole('button', { name: 'Novo ambiente' }).click()
  const named = win.getByRole('dialog', { name: 'Novo ambiente' })
  await named.getByRole('textbox').fill('Staging Europa')
  await named.getByRole('button', { name: 'Criar' }).click()
  await panel.getByRole('heading', { name: 'Variáveis de Staging Europa' }).waitFor()
  const newFile = join(workspace, 'environments/staging-europa.env.json')
  assert.deepEqual(JSON.parse(readFileSync(newFile, 'utf8')), {
    $schema: 'https://vvpost.dev/schemas/v1/environment.json',
    id: 'env.staging-europa',
    name: 'Staging Europa',
    variables: {}
  })
  await panel.getByText('Staging Europa não tem segredos.', { exact: false }).waitFor()
  await panel.getByRole('button', { name: 'Renomear' }).click()
  const rename = win.getByRole('dialog', { name: 'Renomear Staging Europa' })
  await rename.getByRole('textbox').fill('Staging EU')
  await rename.getByRole('button', { name: 'Salvar' }).click()
  // exact: o nome antigo "Staging Europa" começa com "Staging EU", e sem ele a espera passava antes
  // de renomear; no Windows o clique em Excluir chegava com o nome antigo.
  await panel.getByRole('heading', { name: 'Variáveis de Staging EU', exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Excluir ambiente' }).click()
  const confirmDelete = win.getByRole('dialog', { name: 'Excluir o ambiente Staging EU?' })
  await confirmDelete.waitFor({ timeout: 10_000 }).catch(async (err) => {
    // Se o diálogo não abrir, diz o que estava na tela.
    const dialogs = await win.getByRole('dialog').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    const heading = await panel.getByRole('heading', { name: /^Variáveis de / }).allTextContents()
    throw new Error(`${err.message}\ndiálogos abertos: ${JSON.stringify(dialogs)}; título: ${JSON.stringify(heading)}`)
  })
  await confirmDelete.getByRole('button', { name: 'Excluir' }).click()
  await win.getByText('Ambiente Staging EU excluído.').waitFor()
  assert.throws(() => readFileSync(newFile))

  const html = await win.content()
  for (const value of [STORED, TYPED, REPLACED, HOOK, PLAIN, UNMARKED]) assert.ok(!html.includes(value), `valor de segredo chegou à tela: ${value}`)
  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}

const store = readVault(workspace)
assert.deepEqual(store, { 'env.dev': { DATABASE_URL: REPLACED, CLIENT_SECRET: TYPED }, 'env.hml': { WEBHOOK_SECRET: HOOK } })
assert.ok(!existsSync(join(workspace, '.vvpost/secrets.local.json')), 'o arquivo antigo migrou para o cofre local')
rmSync(workspace, { recursive: true, force: true })
rmSync(userData, { recursive: true, force: true })
console.log('E2E do módulo Secrets: ok')
