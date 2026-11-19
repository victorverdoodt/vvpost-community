#!/usr/bin/env node
// Teste ponta a ponta do .zip do VVPost no app real (build de produção em out/):
// 1. num workspace com dois projetos, aberto no projeto estoque, exporta pela aba Exportar o
//    workspace inteiro e depois só o projeto, em .zip;
// 2. importa o zip do workspace pela aba Importar como workspace novo numa pasta vazia (o app
//    abre nele) e confere os projetos e que nenhum valor de segredo foi junto;
// 3. acrescenta o zip do projeto nesse workspace com outro id.
// Os diálogos nativos de arquivo são trocados por respostas fixas no main process.
// Uso: npm run build && node scripts/e2e-archive.mjs   (Linux sem display: xvfb-run -a)
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
const VAULT_TOKEN = ['vault', 'token', 'e2e', '9a1c'].join('-')
const PLAIN_PASSWORD = ['senha', 'e2e', '3f7b2d'].join('-')

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const source = mkdtempSync(join(tmpdir(), 'vvpost-archive-src-'))
const out = mkdtempSync(join(tmpdir(), 'vvpost-archive-out-'))
const copy = join(out, 'copia')
const workspaceZip = join(out, 'loja.vvpost.zip')
const projectZip = join(out, 'estoque.vvpost.zip')

const put = (path, data) => {
  mkdirSync(dirname(join(source, path)), { recursive: true })
  writeFileSync(join(source, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
}
const connector = (id, extra = {}) => ({
  id,
  name: id,
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
  endpoints: [{ id: 'ping', name: 'Ping', method: 'GET', path: '/ping' }],
  ...extra
})
put('connectors/auth.connector.vvpost.json', connector('auth'))
put('environments/dev.env.json', {
  id: 'dev',
  name: 'Dev',
  variables: {
    BASE_URL: { type: 'string', value: 'https://api.exemplo.com' },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
    db_password: { type: 'string', value: PLAIN_PASSWORD }
  }
})
put('docs/projeto.md', '# Loja\n')
put('estoque/vvpost.project.json', { id: 'estoque', name: 'Estoque' })
put('estoque/connectors/produtos.connector.vvpost.json', { ...connector('produtos'), config: { basePath: '/produtos' }, extends: 'auth' })
put('estoque/docs/guia.md', '# Guia do estoque\n')
put('cobranca/vvpost.project.json', { id: 'cobranca', name: 'Cobrança' })
put('cobranca/connectors/pix.connector.vvpost.json', connector('pix'))
put('.vvpost/secrets.local.json', { dev: { API_TOKEN: VAULT_TOKEN } })
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: source, content: join(source, 'estoque') }))

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

const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map((p) => String(p).split('\\').join('/'))

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const dismissToasts = async () => {
    for (const b of await win.getByRole('button', { name: 'Dispensar aviso' }).all()) await b.click()
  }

  await win.getByRole('button', { name: 'Importar e exportar' }).click()
  await win.getByRole('tab', { name: 'Exportar', exact: true }).click()
  await win.getByRole('radio', { name: '.zip' }).click()

  // 1. O workspace inteiro, depois só o projeto aberto.
  await win.getByRole('radio', { name: 'Workspace inteiro' }).click()
  const summary = win.getByLabel('Resumo do zip')
  await summary.getByText('projetos').waitFor()
  const stats = await summary.locator(':scope > span').allTextContents()
  assert.ok(stats.includes('2 projetos') && stats.includes('3 conectores'), stats.join(', '))
  await win.getByText('Avisos (1)').waitFor()
  const html = await win.content()
  for (const secret of [VAULT_TOKEN, PLAIN_PASSWORD]) assert.ok(!html.includes(secret), `segredo "${secret}" chegou ao renderer`)
  if (screenshot) await win.screenshot({ path: screenshot })
  await queueDialogs([], [{ canceled: false, filePath: workspaceZip }])
  await win.getByRole('button', { name: 'Exportar .zip…' }).click()
  await win.getByText(`Zip salvo em ${workspaceZip}`).waitFor()

  await dismissToasts()
  await win.getByRole('radio', { name: 'Este projeto' }).click()
  await win.getByText('Projeto Estoque').waitFor()
  await queueDialogs([], [{ canceled: false, filePath: projectZip }])
  await win.getByRole('button', { name: 'Exportar .zip…' }).click()
  await win.getByText(`Zip salvo em ${projectZip}`).waitFor()

  // 2. O zip do workspace como workspace novo: o app abre nele.
  await dismissToasts()
  await win.getByRole('tab', { name: 'Importar', exact: true }).click()
  await queueDialogs([{ canceled: false, filePaths: [workspaceZip] }, { canceled: false, filePaths: [copy] }])
  await win.getByRole('button', { name: 'Workspace ou projeto em .zip…' }).click()
  await win.getByText(/^Workspace vvpost-archive-src-/).waitFor()
  await win.getByText('com Cobrança, Estoque').waitFor()
  await win.getByRole('button', { name: 'Escolher pasta vazia…' }).click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()
  const copied = filesUnder(copy)
  for (const f of ['estoque/vvpost.project.json', 'estoque/docs/guia.md', 'cobranca/connectors/pix.connector.vvpost.json', 'docs/projeto.md']) {
    assert.ok(copied.includes(f), `${f} não veio do zip: ${copied.join(', ')}`)
  }
  assert.ok(!existsSync(join(copy, '.vvpost/secrets.local.json')))
  assert.ok(!existsSync(join(copy, 'vvpost.archive.json')))
  for (const f of copied.filter((p) => p.endsWith('.json') || p.endsWith('.md'))) {
    const text = readFileSync(join(copy, f), 'utf8')
    for (const secret of [VAULT_TOKEN, PLAIN_PASSWORD]) assert.ok(!text.includes(secret), `segredo "${secret}" em ${f}`)
  }
  const info = await win.evaluate(() => window.vvpost.getWorkspaceInfo())
  assert.equal(info.dir, copy)
  assert.deepEqual(info.projects.list.map((p) => p.id), ['cobranca', 'estoque'])

  // 3. O zip do projeto no workspace novo, com outro id (estoque já existe).
  await dismissToasts()
  await queueDialogs([{ canceled: false, filePaths: [projectZip] }])
  await win.getByRole('button', { name: 'Outro .zip…' }).click()
  await win.getByText('Projeto Estoque').waitFor()
  await win.getByText('o workspace já tem o projeto "Estoque"', { exact: false }).waitFor()
  const idField = win.getByLabel('Id do projeto (nome da pasta)')
  await idField.fill('estoque-copia')
  if (screenshot) await win.screenshot({ path: screenshot.replace(/\.png$/, '-importar.png') })
  await win.getByRole('button', { name: 'Acrescentar projeto' }).click()
  await win.getByText(/arquivo\(s\) gravado\(s\) em/).waitFor()
  assert.ok(existsSync(join(copy, 'estoque-copia/connectors/produtos.connector.vvpost.json')))
  const project = JSON.parse(readFileSync(join(copy, 'estoque-copia/vvpost.project.json'), 'utf8'))
  assert.equal(project.id, 'estoque-copia')
  const after = await win.evaluate(() => window.vvpost.getWorkspaceInfo())
  assert.equal(after.projects.current, 'estoque-copia')
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
for (const dir of [userData, source, out]) rmSync(dir, { recursive: true, force: true })
console.log('E2E do .zip do VVPost: ok')
