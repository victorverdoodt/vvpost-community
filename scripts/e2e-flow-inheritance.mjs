#!/usr/bin/env node
// Teste ponta a ponta da herança entre fluxos (build de produção em out/): um fluxo-base com o
// login como nó e um fluxo de requisição que herda dele. O explorador abre a requisição na visão
// Simples pela base, o envio faz o login uma vez e leva o token e o basePath, e Ctrl+S grava sem
// perder a herança nem os cenários.
// Uso: npm run build && node scripts/e2e-flow-inheritance.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

let logins = 0
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/api/auth/login') {
    logins++
    return res.end(JSON.stringify({ token: 'tok-da-base', expires_in: 3600 }))
  }
  res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-flow-inheritance-'))
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
const put = (path, data) => writeFileSync(join(workspace, path), `${JSON.stringify(data, null, 2)}\n`)
put('flows/loja.flow.vvpost.json', {
  id: 'loja',
  name: 'Loja',
  version: '1.0.0',
  defaults: { baseUrl: origin, basePath: '/api', headers: { Authorization: 'Bearer {{ $nodes.Login.data.token }}' } },
  nodes: [{ id: 'login', name: 'Login', type: 'request', cache: { expiresIn: 'data.expires_in' }, request: { method: 'POST', url: '/auth/login' } }]
})
const requestFile = join(workspace, 'flows/loja.pedidos.flow.vvpost.json')
put('flows/loja.pedidos.flow.vvpost.json', {
  id: 'loja.pedidos',
  name: 'Listar pedidos',
  extends: 'loja',
  nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url: '/pedidos' } }],
  scenarios: [{ id: 'ok', name: 'Lista', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
})

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_MCP_PORT: '0' }
})

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const bar = win.getByRole('tablist', { name: 'Abas do workspace' })
  const tab = (name) => bar.getByRole('tab', { name, exact: true })
  const panel = win.locator('main > div:not([hidden])')
  const req = panel.locator('[role=tabpanel]:not([hidden])')
  const url = () => req.locator('input[aria-label="URL"]')

  // O fluxo de requisição abre na visão Simples, com a URL relativa à base.
  await tab('Nova requisição').waitFor()
  await win.keyboard.press('Control+Shift+E')
  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  // A requisição fica debaixo da base, na árvore dos conectores.
  await tree.getByRole('treeitem').filter({ hasText: 'Loja' }).getByRole('button', { name: 'Expandir' }).click()
  await tree.getByRole('button', { name: 'Listar pedidos' }).click()
  await tab('Listar pedidos').waitFor()
  assert.equal(await url().inputValue(), '/pedidos')

  // Dois envios: o login da base roda uma vez, e o token e o basePath vão em cada requisição.
  for (let i = 0; i < 2; i++) {
    await req.getByRole('button', { name: 'Enviar' }).click()
    await req.getByText('200 OK').waitFor()
  }
  const body = JSON.parse(await req.locator('pre').first().textContent())
  assert.deepEqual(body, { path: '/api/pedidos', auth: 'Bearer tok-da-base' })
  assert.equal(logins, 1)

  // Ctrl+S grava a mudança no mesmo arquivo, com a herança e os cenários.
  await url().fill('/pedidos?status=aberto')
  await win.keyboard.press('Control+s')
  await win.getByText('Salvo em flows/loja.pedidos.flow.vvpost.json').waitFor()
  const saved = JSON.parse(readFileSync(requestFile, 'utf8'))
  assert.equal(saved.extends, 'loja')
  assert.equal(saved.scenarios[0].id, 'ok')
  assert.equal(saved.nodes[0].request.connector, undefined)
  assert.equal(saved.nodes[0].request.url, '/pedidos?status=aberto')

  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
  console.log('E2E de herança entre fluxos: ok')
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
