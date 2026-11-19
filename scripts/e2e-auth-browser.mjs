#!/usr/bin/env node
// Teste ponta a ponta das auths da fase 15 no app real: um conector OAuth2 authorization code
// com PKCE (o app abre o login no navegador do sistema e recebe o code no loopback) e um
// conector Digest (o 401 com o desafio é respondido em segundo plano). O "navegador" é o
// shell.openExternal trocado por um fetch que segue o redirect do provedor de mentira.
// Uso: npm run build && node scripts/e2e-auth-browser.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const shots = process.env.VVPOST_E2E_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
const PASSWORD = `senha-${Math.random().toString(36).slice(2)}`
const md5 = (text) => createHash('md5').update(text).digest('hex')

const provider = { challenge: '', redirect: '', opened: 0 }
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/authorize') {
      provider.challenge = url.searchParams.get('code_challenge')
      provider.redirect = url.searchParams.get('redirect_uri')
      const back = new URL(provider.redirect)
      back.searchParams.set('code', 'code-e2e')
      back.searchParams.set('state', url.searchParams.get('state'))
      return res.writeHead(302, { location: back.toString() }).end()
    }
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body)
      const ok =
        form.get('code') === 'code-e2e' &&
        createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === provider.challenge
      res.statusCode = ok ? 200 : 400
      return res.end(JSON.stringify(ok ? { access_token: 'at-e2e', expires_in: 3600 } : { error: 'invalid_grant' }))
    }
    if (url.pathname.startsWith('/oauth-api')) {
      return res.end(JSON.stringify({ auth: req.headers.authorization ?? null }))
    }
    // Digest: desafio, e a resposta conferida do lado do servidor.
    const header = req.headers.authorization ?? ''
    const p = Object.fromEntries([...header.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]))
    const expected = md5(`${md5(`ana:api:${PASSWORD}`)}:n0nce:${p.nc}:${p.cnonce}:auth:${md5(`${req.method}:${p.uri}`)}`)
    if (!header.startsWith('Digest ') || p.response !== expected) {
      res.writeHead(401, { 'www-authenticate': 'Digest realm="api", nonce="n0nce", qop="auth"' })
      return res.end(JSON.stringify({ error: 'unauthorized' }))
    }
    res.end(JSON.stringify({ digest: 'ok', uri: p.uri }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/oauth.connector.vvpost.json', {
  $schema: 'https://vvpost.dev/schemas/v1/connector.json',
  id: 'connector.oauth',
  name: 'API com login',
  version: '1.0.0',
  config: {
    baseUrl: '{{BASE_URL}}/oauth-api',
    auth: { type: 'oauth2', grantType: 'authorization_code', authUrl: '{{BASE_URL}}/authorize', tokenUrl: '{{BASE_URL}}/token', clientId: 'app' }
  }
})
put('connectors/digest.connector.vvpost.json', {
  $schema: 'https://vvpost.dev/schemas/v1/connector.json',
  id: 'connector.digest',
  name: 'API Digest',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'digest', username: 'ana', password: '{{PASSWORD}}' } }
})
put('environments/dev.env.json', {
  id: 'env.dev',
  name: 'Desenvolvimento',
  variables: {
    BASE_URL: { type: 'string', value: origin },
    PASSWORD: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put('.vvpost/secrets.local.json', { 'env.dev': { PASSWORD } })

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ dialog, shell }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
    globalThis.__opened = []
    shell.openExternal = async (url) => {
      globalThis.__opened.push(url)
      void fetch(url).then((r) => r.text())
    }
  }, workspace)
  await win.getByRole('button', { name: 'Abrir workspace…' }).click()
  await win.selectOption('select[aria-label="Ambiente"]', 'env.dev')

  // OAuth2 authorization code: o app abre o login e usa o token trocado com o code_verifier.
  await win.selectOption('select[aria-label="Conector"]', 'connector.oauth')
  await win.getByText(/OAuth2 authorization code com PKCE/).waitFor()
  await win.fill('input[aria-label="URL"]', '/perfil')
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  assert.deepEqual(JSON.parse(await win.locator('pre').last().textContent()), { auth: 'Bearer at-e2e' })
  const opened = await app.evaluate(() => globalThis.__opened)
  assert.equal(opened.length, 1)
  assert.equal(new URL(opened[0]).searchParams.get('code_challenge_method'), 'S256')
  // Segundo envio: token em memória, sem abrir o navegador de novo.
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('OAuth2 · token em cache').waitFor()
  assert.equal((await app.evaluate(() => globalThis.__opened)).length, 1)
  if (shots) await win.screenshot({ path: join(shots, 'oauth2-authorization-code.png') })

  // Digest: o desafio é respondido em segundo plano.
  await win.selectOption('select[aria-label="Conector"]', 'connector.digest')
  await win.fill('input[aria-label="URL"]', '/protegido?x=1')
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('"digest": "ok"').waitFor()
  await win.getByText(/Digest \(usuário e senha/).waitFor()
  if (shots) await win.screenshot({ path: join(shots, 'digest.png') })

  assert.ok(!(await win.content()).includes(PASSWORD), 'senha chegou ao renderer')
  assert.deepEqual(errors, [])
  console.log('Auths da fase 15: OAuth2 authorization code com PKCE pelo navegador e Digest OK')
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
