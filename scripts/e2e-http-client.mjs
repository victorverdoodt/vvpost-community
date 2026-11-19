#!/usr/bin/env node
// Teste ponta a ponta do cliente HTTP completo (fase 12) no app real: corpo form-data com
// arquivo, x-www-form-urlencoded e binário pela aba Body, cookie jar (o Set-Cookie volta na
// próxima requisição e aparece em Configurações, onde é apagado) e proxy manual.
// Uso: npm run build && node scripts/e2e-http-client.mjs (Linux sem display: xvfb-run -a ...)
// VVPOST_E2E_SHOTS=<pasta> grava capturas das telas novas.
import assert from 'node:assert/strict'
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

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (req.url === '/login') res.setHeader('set-cookie', 'sessao=e2e-123; Path=/; Max-Age=3600')
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        method: req.method,
        type: req.headers['content-type'] ?? null,
        cookie: req.headers.cookie ?? null,
        body: Buffer.concat(chunks).toString('latin1')
      })
    )
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// Proxy de mentira: responde ele mesmo, para provar que a requisição passou por ele.
let proxied = null
const proxy = createServer((req, res) => {
  proxied = { url: req.url, auth: req.headers['proxy-authorization'] ?? null }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ viaProxy: true }))
})
await new Promise((r) => proxy.listen(0, '127.0.0.1', r))

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const files = mkdtempSync(join(tmpdir(), 'vvpost-e2e-files-'))
const photo = join(files, 'foto.png')
writeFileSync(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
// O diálogo nativo de arquivo não é automatizável: devolve sempre a foto.
await app.evaluate(({ dialog }, path) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
}, photo)

const last = async (win) => JSON.parse(await win.locator('pre').last().textContent())

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  // form-data com um campo de texto e um arquivo.
  await win.selectOption('select[aria-label="Método HTTP"]', 'POST')
  await win.fill('input[aria-label="URL"]', `${base}/upload`)
  await win.getByRole('tab', { name: 'Body', exact: true }).click()
  await win.getByRole('radio', { name: 'form-data' }).click()
  await win.locator('input[aria-label="Nome do campo"]').first().fill('descricao')
  await win.locator('input[aria-label="Valor do campo"]').first().fill('foto de perfil')
  await win.locator('input[aria-label="Nome do campo"]').nth(1).fill('arquivo')
  await win.locator('select[aria-label="Tipo do campo"]').nth(1).selectOption('file')
  await win.getByRole('button', { name: 'Escolher arquivo' }).click()
  await win.getByText('foto.png').waitFor()
  if (shots) await win.screenshot({ path: join(shots, 'body-form-data.png') })
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  let echoed = await last(win)
  assert.match(echoed.type, /^multipart\/form-data; boundary=/)
  assert.match(echoed.body, /name="descricao"\r\n\r\nfoto de perfil\r\n/)
  assert.match(echoed.body, /name="arquivo"; filename="foto.png"\r\nContent-Type: image\/png\r\n\r\n\x89PNG/)

  // x-www-form-urlencoded reaproveita os campos de texto.
  await win.getByRole('radio', { name: 'x-www-form-urlencoded' }).click()
  await win.locator('input[aria-label="Valor do campo"]').first().fill('a&b')
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('"descricao=a%26b"').waitFor()
  echoed = await last(win)
  assert.equal(echoed.type, 'application/x-www-form-urlencoded')

  // Binário: o arquivo inteiro como corpo.
  await win.getByRole('radio', { name: 'Binário' }).click()
  await win.getByRole('button', { name: 'Escolher arquivo' }).click()
  await win.getByText(photo).waitFor()
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('"image/png"').waitFor()
  echoed = await last(win)
  assert.equal(echoed.body, '\x89PNG\r\n')

  // Cookie jar: o Set-Cookie do /login volta no /perfil.
  await win.getByRole('radio', { name: 'Texto/JSON' }).click()
  await win.selectOption('select[aria-label="Método HTTP"]', 'GET')
  await win.fill('input[aria-label="URL"]', `${base}/login`)
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('"/login"').waitFor({ state: 'detached' }).catch(() => {})
  await win.getByText('"cookie": null').waitFor()
  await win.fill('input[aria-label="URL"]', `${base}/perfil`)
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('"sessao=e2e-123"').waitFor()

  // Configurações: o cookie aparece e é apagado; o proxy manual passa a valer.
  await win.keyboard.press('Control+k')
  await win.keyboard.type('Configurações')
  await win.keyboard.press('Enter')
  const cookies = win.getByRole('table', { name: 'Cookies' })
  await cookies.getByText('sessao').waitFor()
  await win.selectOption('select[aria-label="Modo do proxy"]', 'manual')
  await win.fill('input[aria-label="Endereço do proxy"]', `http://127.0.0.1:${proxy.address().port}`)
  await win.fill('input[aria-label="Usuário do proxy"]', 'eu')
  await win.fill('input[aria-label="Senha do proxy"]', 'senha-do-proxy')
  if (shots) await win.screenshot({ path: join(shots, 'configuracoes-rede.png'), fullPage: true })
  await win.getByRole('button', { name: 'Salvar rede e cookies' }).click()
  await win.getByText('Configurações de rede salvas').waitFor()
  await win.getByRole('button', { name: 'Apagar o cookie sessao' }).click()
  await cookies.waitFor({ state: 'detached' })

  await win.keyboard.press('Control+1')
  await win.fill('input[aria-label="URL"]', 'http://api.exemplo.test/via-proxy')
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('"viaProxy": true').waitFor()
  assert.deepEqual(proxied, { url: 'http://api.exemplo.test/via-proxy', auth: `Basic ${Buffer.from('eu:senha-do-proxy').toString('base64')}` })
  // Loopback nunca vai pelo proxy, e o cookie apagado não volta.
  await win.fill('input[aria-label="URL"]', `${base}/perfil`)
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('"/perfil"').waitFor({ state: 'detached' }).catch(() => {})
  await win.getByText('"cookie": null').waitFor()
  assert.deepEqual(errors, [])
  console.log('Cliente HTTP: form-data, urlencoded, binário, cookie jar e proxy manual OK')
} finally {
  await app.close()
  server.close()
  proxy.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(files, { recursive: true, force: true })
}
