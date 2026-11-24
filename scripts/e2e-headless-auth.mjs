#!/usr/bin/env node
// Teste ponta a ponta do Headless Auth Binding no app real (build de produção
// em out/): abre um workspace com um conector base OAuth2 (client credentials) e um filho,
// escolhe conector e ambiente no Quick Request e dispara com URL relativa. Confere que o
// token foi buscado em segundo plano e reaproveitado, que os headers herdados chegaram,
// que nenhum segredo chegou ao renderer e o que ficou no histórico.
// Uso: npm run build && node scripts/e2e-headless-auth.mjs   (Linux sem display: xvfb-run -a)
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
const CLIENT_SECRET = 'segredo-do-cliente-e2e'

let tokenCalls = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/oauth/token') {
      const ok =
        req.headers.authorization === `Basic ${Buffer.from(`vvpost-e2e:${CLIENT_SECRET}`).toString('base64')}` &&
        new URLSearchParams(body).get('grant_type') === 'client_credentials'
      if (!ok) {
        res.statusCode = 401
        return res.end(JSON.stringify({ error: 'invalid_client' }))
      }
      tokenCalls++
      return res.end(JSON.stringify({ access_token: `tok-${tokenCalls}`, token_type: 'Bearer', expires_in: 3600 }))
    }
    // Endpoint público: responde a qualquer um e devolve a auth que chegou (ou nenhuma).
    if (req.url === '/billing/v2/status') return res.end(JSON.stringify({ auth: req.headers.authorization ?? null, tenant: req.headers['x-tenant'] }))
    if (req.headers.authorization !== `Bearer tok-${tokenCalls}`) {
      res.statusCode = 401
      return res.end(JSON.stringify({ error: 'unauthorized' }))
    }
    res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization, tenant: req.headers['x-tenant'] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/corporate-base.connector.vvpost.json', {
  $schema: 'https://vvpost.dev/schemas/v1/connector.json',
  id: 'connector.corporate.base',
  name: 'Corporate Base',
  version: '1.0.0',
  config: {
    baseUrl: '{{BASE_URL}}',
    headers: { 'X-Tenant': '{{TENANT}}' },
    auth: {
      type: 'oauth2',
      grantType: 'client_credentials',
      tokenUrl: '/oauth/token',
      clientId: '{{CLIENT_ID}}',
      clientSecret: '{{CLIENT_SECRET}}'
    }
  }
})
put('connectors/billing.connector.vvpost.json', {
  $schema: 'https://vvpost.dev/schemas/v1/connector.json',
  id: 'connector.billing.v2',
  name: 'Billing Service v2',
  version: '2.0.0',
  extends: 'connector.corporate.base',
  config: { basePath: '/billing/v2' },
  endpoints: [
    { id: 'list_charges', name: 'Listar cobranças', method: 'GET', path: '/charges' },
    { id: 'status', name: 'Status', method: 'GET', path: '/status', requiresAuth: false }
  ]
})
put('environments/dev.env.json', {
  id: 'env.dev',
  name: 'Desenvolvimento',
  variables: {
    BASE_URL: { type: 'string', value: origin },
    TENANT: { type: 'string', value: 'acme' },
    CLIENT_ID: { type: 'string', value: 'vvpost-e2e' },
    CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put('.vvpost/secrets.local.json', { 'env.dev': { CLIENT_SECRET } })

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const launch = () =>
  _electron.launch({
    executablePath: electronBin,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
  })

let app = await launch()
let firstMs
let secondMs
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, workspace)
  await win.getByRole('button', { name: 'Abrir workspace…' }).click()
  await win.selectOption('select[aria-label="Conector"]', 'connector.billing.v2')
  await win.selectOption('select[aria-label="Ambiente"]', 'env.dev')
  await win.selectOption('select[aria-label="Endpoint"]', 'list_charges')
  assert.equal(await win.inputValue('input[aria-label="URL"]'), '/charges')
  await win.getByText('OAuth2 client credentials em /oauth/token · de connector.corporate.base').waitFor()

  let start = performance.now()
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  firstMs = Math.round(performance.now() - start)
  await win.getByText(/OAuth2 · token obtido em/).waitFor()
  assert.deepEqual(JSON.parse(await win.locator('pre').textContent()), {
    path: '/billing/v2/charges',
    auth: 'Bearer tok-1',
    tenant: 'acme'
  })

  start = performance.now()
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('OAuth2 · token em cache').waitFor()
  secondMs = Math.round(performance.now() - start)
  assert.equal(tokenCalls, 1)

  // "Renovar token" descarta o token em memória: o próximo envio roda o fluxo de novo.
  await win.getByRole('button', { name: 'Renovar token' }).click()
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText(/OAuth2 · token obtido em/).waitFor()
  assert.equal(tokenCalls, 2)

  const html = await win.content()
  assert.ok(!html.includes(CLIENT_SECRET), 'segredo do cliente chegou ao renderer')
  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}

// Reabrindo o app, workspace, conector e ambiente voltam escolhidos.
app = await launch()
try {
  const win = await app.firstWindow()
  await win.locator('select[aria-label="Conector"] option[value="connector.billing.v2"]').waitFor({ state: 'attached' })
  assert.equal(await win.inputValue('select[aria-label="Conector"]'), 'connector.billing.v2')
  assert.equal(await win.inputValue('select[aria-label="Ambiente"]'), 'env.dev')
  await win.locator('aside li').first().click()
  // O detalhe da execução vem do histórico de forma assíncrona: espera a URL preencher.
  await win.waitForFunction(() => document.querySelector('input[aria-label="URL"]')?.value === '/charges')

  // Endpoint público (requiresAuth: false): vai sem a auth do conector, como no vvpost run; a aba pode pedir a auth.
  await win.selectOption('select[aria-label="Endpoint"]', 'status')
  await win.getByText(/Endpoint público \(requiresAuth: false\): vai sem a auth do conector/).waitFor()
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  assert.deepEqual(JSON.parse(await win.locator('pre').textContent()), { auth: null, tenant: 'acme' })
  assert.equal(tokenCalls, 2, 'o público não pode rodar o fluxo de token')
  await win.getByRole('checkbox', { name: 'Enviar a auth mesmo assim' }).check()
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.waitForFunction(() => document.querySelector('pre')?.textContent?.includes('Bearer'))
  assert.equal(JSON.parse(await win.locator('pre').textContent()).auth, 'Bearer tok-3')
} finally {
  await app.close()
  server.close()
}

const db = new DatabaseSync(join(userData, 'vvpost.db'))
const rows = db.prepare('SELECT url, detail, connector_id, environment_id FROM history_exchange').all()
db.close()
assert.equal(rows.length, 5)
const status = rows.filter((r) => r.url === '/status').map((r) => JSON.parse(r.detail))
// O envio sem credencial fica marcado no histórico (Reproduzir repete sem a auth); o com auth, não.
assert.deepEqual(status.map((d) => !!d.template.anonymous), [true, false])
assert.ok(!status[0].sent.headers.some((h) => /^authorization$/i.test(h.name)))
for (const { detail, ...row } of rows.filter((r) => r.url !== '/status')) {
  // O histórico guarda a requisição como digitada (repetível), nunca o token nem o segredo.
  assert.deepEqual({ ...row }, {
    url: '/charges',
    connector_id: 'connector.billing.v2',
    environment_id: 'env.dev'
  })
  const d = JSON.parse(detail)
  assert.deepEqual(d.template.headers, [])
  // O que foi para a rede: URL resolvida e o header da auth mascarado.
  assert.match(d.sent.url, /^http:\/\/127\.0\.0\.1:\d+\/.*charges$/)
  assert.ok(d.sent.headers.some((h) => /^authorization$/i.test(h.name) && h.value === '[REDACTED_SECRET]'))
  assert.ok(!detail.includes(CLIENT_SECRET) && !/tok-\d/.test(detail), 'token ou segredo no histórico')
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log(`E2E do Headless Auth Binding: ok (1º envio com OAuth2 ${firstMs} ms, 2º com token em cache ${secondMs} ms)`)
