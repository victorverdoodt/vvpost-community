#!/usr/bin/env node
// Teste ponta a ponta do fluxo de preparação no Quick Request, no app real
// (build de produção em out/): escolhe um fluxo de login no contexto, sem abrir o canvas, e a
// requisição usa o token do fluxo em {{ $nodes.Login.data.token }}. Confere a resposta, o resumo
// da preparação, o erro quando um nó do fluxo falha e que o token não ficou no histórico.
// Uso: npm run build && node scripts/e2e-prepare-flow.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
const TOKEN = 'tok-preparacao-e2e-7781'

let loginCalls = 0
let loginFails = false
const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/login') {
      loginCalls++
      if (loginFails) {
        res.statusCode = 503
        return res.end(JSON.stringify({ error: 'login fora do ar' }))
      }
      return res.end(JSON.stringify({ token: TOKEN, tenant: 'acme' }))
    }
    const ok = req.headers.authorization === `Bearer ${TOKEN}`
    res.statusCode = ok ? 200 : 401
    res.end(JSON.stringify({ path: req.url, authorized: ok }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('environments/dev.env.json', { id: 'env.dev', name: 'Desenvolvimento', variables: { BASE_URL: { type: 'string', value: origin } } })
put('flows/login.flow.vvpost.json', {
  id: 'flow.login',
  name: 'Login',
  nodes: [{ id: 'login', name: 'Login', type: 'request', request: { method: 'POST', url: '{{BASE_URL}}/login' } }],
  edges: []
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
  }, workspace)
  await win.getByRole('button', { name: 'Abrir workspace…' }).click()
  await win.selectOption('select[aria-label="Ambiente"]', 'env.dev')
  await win.locator('select[aria-label="Fluxo de preparação"] option[value="flow.login"]').waitFor({ state: 'attached' })
  await win.selectOption('select[aria-label="Fluxo de preparação"]', 'flow.login')

  await win.fill('input[aria-label="URL"]', '{{BASE_URL}}/orders?tenant={{ $nodes.Login.data.tenant }}')
  await win.locator('input[aria-label="Nome do cabeçalho"]').first().fill('Authorization')
  await win.locator('input[aria-label="Valor do cabeçalho"]').first().fill('Bearer {{ $nodes.Login.data.token }}')
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  assert.deepEqual(JSON.parse(await win.locator('pre').textContent()), { path: '/orders?tenant=acme', authorized: true })
  await win.getByLabel('Preparação', { exact: true }).getByText(/Preparação Login · 1 nó em/).waitFor()
  assert.equal(loginCalls, 1)

  // O fluxo roda a cada envio: um nó que falha para a requisição antes da rede, com o padrão de erro.
  loginFails = true
  await win.getByRole('button', { name: 'Enviar' }).click()
  const alert = win.getByRole('alert')
  await alert.getByText('PREPARE_FAILED').waitFor()
  await alert.getByText('Preparação', { exact: true }).waitFor()
  await alert.getByText(/o nó Login falhou/).waitFor()
  await alert.getByText('Login · nó Login').waitFor()
  assert.equal(loginCalls, 2)
  if (screenshot) await win.screenshot({ path: screenshot })
  await alert.getByRole('button', { name: 'Abrir o fluxo no Flow Studio' }).click()
  await win.locator('[data-panel="flows"][aria-current="page"]').waitFor()

  const html = await win.content()
  assert.ok(!html.includes(TOKEN), 'o token da preparação chegou ao renderer')
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  server.close()
}

const db = new DatabaseSync(join(userData, 'vvpost.db'))
const rows = db.prepare('SELECT url, detail, error_code FROM history_exchange ORDER BY id').all()
db.close()
// Só as requisições do Quick Request entram: o fluxo de preparação não vira execução à parte.
assert.equal(rows.length, 2)
assert.equal(rows[1].error_code, 'PREPARE_FAILED')
for (const row of rows) {
  assert.equal(row.url, '{{BASE_URL}}/orders?tenant={{ $nodes.Login.data.tenant }}')
  assert.ok(!row.detail.includes(TOKEN), 'o token da preparação foi gravado no histórico')
  // O modelo guarda o fluxo, não os valores dele: reproduzir roda a preparação de novo.
  const detail = JSON.parse(row.detail)
  assert.equal(detail.template.prepareFlowId, 'flow.login')
  assert.equal(detail.template.extra, undefined)
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E do fluxo de preparação no Quick Request: ok')
