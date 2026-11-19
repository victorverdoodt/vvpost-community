#!/usr/bin/env node
// Teste ponta a ponta dos exemplos de resposta e do mock server (fase 15) no app real (build de
// produção em out/): envia uma requisição de um endpoint pelo Quick Request, salva a resposta
// como exemplo do endpoint pela Command Palette, liga o mock na barra de status e confere que o
// mock responde com o exemplo, trocando {{$path.id}}, no caminho basePath + path.
// Uso: npm run build && node scripts/e2e-mock.mjs   (Linux sem display: xvfb-run -a)
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
const mockPort = 4590 + Math.floor(Math.random() * 300)

const api = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.setHeader('set-cookie', 'sessao=nao-vai-para-o-exemplo')
  res.end(JSON.stringify({ id: req.url.split('/').pop(), nome: 'Ana', plano: 'pro' }))
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/users.connector.vvpost.json', {
  id: 'users',
  name: 'Usuários',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', basePath: '/api/v1' },
  endpoints: [{ id: 'get', name: 'Buscar usuário', method: 'GET', path: '/users/{id}' }]
})
put('environments/dev.env.json', { id: 'dev', name: 'Dev', variables: { BASE_URL: { type: 'string', value: `http://127.0.0.1:${api.address().port}` } } })

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_MOCK_PORT: String(mockPort) }
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  const quick = win.locator('main > div:not([hidden])')
  await quick.locator('select[aria-label="Conector"]').selectOption('users')
  await quick.locator('select[aria-label="Ambiente"]').selectOption('dev')
  await quick.locator('select[aria-label="Endpoint"]').selectOption('get')
  await win.fill('input[aria-label="URL"]:visible', '/users/u1')
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()

  // Command Palette: o item do menu da requisição.
  await win.keyboard.press('Control+K')
  await win.keyboard.type('Salvar a resposta como exemplo')
  await win.keyboard.press('Enter')
  await win.getByText('o mock server já responde com ele').waitFor()
  const saved = JSON.parse(readFileSync(join(workspace, 'connectors/users.connector.vvpost.json'), 'utf8'))
  assert.deepEqual(saved.endpoints[0].examples, [
    { id: 'ok-200', name: '200 OK', status: 200, headers: { 'Content-Type': 'application/json' }, body: { id: 'u1', nome: 'Ana', plano: 'pro' } }
  ])

  // O exemplo vira modelo: o id passa a vir do caminho pedido.
  saved.endpoints[0].examples[0].body.id = '{{$path.id}}'
  put('connectors/users.connector.vvpost.json', saved)

  const toggle = win.getByRole('button', { name: /^Mock:/ })
  await toggle.click()
  await win.getByRole('button', { name: `Mock: :${mockPort}` }).waitFor({ timeout: 15_000 })
  const res = await fetch(`http://127.0.0.1:${mockPort}/api/v1/users/u42`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('set-cookie'), null)
  assert.deepEqual(await res.json(), { id: 'u42', nome: 'Ana', plano: 'pro' })
  assert.equal((await fetch(`http://127.0.0.1:${mockPort}/api/v1/users/u42?__status=404`)).status, 404)
  await win.getByRole('button', { name: /^Mock: :\d+ · 2/ }).waitFor({ timeout: 5_000 })
  if (screenshot) await win.screenshot({ path: screenshot })

  await win.getByRole('button', { name: /^Mock: :/ }).click()
  await win.getByRole('button', { name: 'Mock: Off' }).waitFor({ timeout: 10_000 })
  await assert.rejects(fetch(`http://127.0.0.1:${mockPort}/api/v1/users/u1`))
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  api.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E do mock server: ok')
