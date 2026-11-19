#!/usr/bin/env node
// Teste ponta a ponta dos scripts por requisição (fase 13) no app real: o endpoint tem um script
// pre (do conector) e um post (do endpoint); a aba Scripts recebe um pre e um post da própria
// requisição. Confere que o pre mudou o que foi para a rede, a aba Testes da resposta, o console,
// as variáveis que valem na próxima requisição, "Ver como fluxo" no Flow Studio e o histórico.
// Uso: npm run build && node scripts/e2e-request-scripts.mjs   (Linux sem display: xvfb-run -a)
// VVPOST_E2E_SHOTS=<pasta> grava capturas das telas novas.
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
const shots = process.env.VVPOST_E2E_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
const SECRET = `chave-e2e-${Math.random().toString(36).slice(2)}`

const seen = []
const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    seen.push({ url: req.url, key: req.headers['x-api-key'] ?? null, tenant: req.headers['x-tenant'] ?? null })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 42, nome: 'Ana', tenant: req.headers['x-tenant'] ?? null }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('environments/dev.env.json', {
  id: 'env.dev',
  name: 'Desenvolvimento',
  variables: {
    BASE_URL: { type: 'string', value: origin },
    TENANT: { type: 'string', value: 'acme' },
    API_KEY: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put('.vvpost/secrets.local.json', { 'env.dev': { API_KEY: SECRET } })
put('connectors/api.connector.vvpost.json', {
  id: 'api',
  name: 'API',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', scripts: { pre: "vv.request.headers['X-Api-Key'] = vv.variables.get('API_KEY')" } },
  endpoints: [
    {
      id: 'perfil',
      name: 'Perfil',
      method: 'GET',
      path: '/perfil',
      scripts: { post: "vv.test('status 200', () => vv.expect(vv.response.status).to.equal(200))" }
    }
  ]
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
  await win.selectOption('select[aria-label="Conector"]', 'api')
  await win.selectOption('select[aria-label="Ambiente"]', 'env.dev')
  await win.selectOption('select[aria-label="Endpoint"]', 'perfil')

  // A aba conta os scripts herdados (pre do conector, post do endpoint) e os da requisição.
  await win.getByRole('tab', { name: 'Scripts (2)' }).click()
  await win.getByLabel('Script antes do envio').fill(
    "vv.request.headers['X-Tenant'] = vv.variables.get('TENANT')\nvv.request.query.pagina = 2\nconsole.log('chave vista: ' + vv.variables.get('API_KEY'))"
  )
  await win.getByRole('radio', { name: /Depois da resposta/ }).click()
  await win.getByLabel('Script depois da resposta').fill(
    [
      "vv.test('tem nome', () => vv.expect(vv.response.json()).to.have.property('nome', 'Ana'))",
      "vv.test('id é texto', () => vv.expect(vv.response.json().id).to.be.a('string'))",
      "vv.variables.set('usuarioId', String(vv.response.json().id))"
    ].join('\n')
  )
  await win.getByRole('tab', { name: 'Scripts (4)' }).waitFor()
  if (shots) await win.screenshot({ path: join(shots, 'scripts-tab.png') })

  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  assert.deepEqual(seen.at(-1), { url: '/perfil?pagina=2', key: SECRET, tenant: 'acme' })
  await win.getByRole('tab', { name: 'Testes (2/3)' }).click()
  const report = win.getByLabel('Resultado dos scripts')
  await report.getByText('status 200').waitFor()
  await report.getByText(/esperava .*string/).waitFor()
  await report.getByText('[pre:request] chave vista: {{API_KEY}}').waitFor()
  await report.getByText('usuarioId').waitFor()
  if (shots) await win.screenshot({ path: join(shots, 'scripts-tests.png') })

  // A variável do script vale na próxima requisição do mesmo ambiente.
  await win.fill('input[aria-label="URL"]', '/perfil/{{usuarioId}}')
  const before = seen.length
  await win.getByRole('button', { name: 'Enviar' }).click()
  for (let i = 0; seen.length === before && i < 100; i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(seen.at(-1)?.url, '/perfil/42?pagina=2')

  // Por trás, é um fluxo: script → requisição → script, aberto como rascunho no Flow Studio.
  await win.getByRole('tab', { name: /^Scripts/ }).click()
  await win.getByRole('button', { name: 'Ver como fluxo' }).click()
  await win.locator('[data-panel="flows"][aria-current="page"]').waitFor()
  for (const name of ['Pre_api', 'Pre_request', 'Requisicao', 'Post_endpoint', 'Post_request']) {
    await win.locator('.react-flow__node').filter({ hasText: name }).first().waitFor()
  }
  if (shots) await win.screenshot({ path: join(shots, 'scripts-flow.png') })

  const html = await win.content()
  assert.ok(!html.includes(SECRET), 'o segredo chegou ao renderer')
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  server.close()
}

const db = new DatabaseSync(join(userData, 'vvpost.db'))
const rows = db.prepare('SELECT url, detail FROM history_exchange ORDER BY id').all()
db.close()
assert.equal(rows.length, 2)
for (const row of rows) assert.ok(!row.detail.includes(SECRET), 'o segredo foi gravado no histórico')
const detail = JSON.parse(rows[0].detail)
assert.equal(detail.template.endpointId, 'perfil')
assert.match(detail.template.scripts.pre, /X-Tenant/)
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E dos scripts por requisição: ok')
