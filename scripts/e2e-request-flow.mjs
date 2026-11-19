#!/usr/bin/env node
// Teste ponta a ponta de requisição e fluxo como o mesmo documento (build de produção em out/): um
// fluxo que termina numa requisição abre no Quick Request (visão Simples), os nós de antes rodam em
// segundo plano no envio, Ctrl+S grava no mesmo arquivo, e Simples | Canvas troca de visão.
// Uso: npm run build && node scripts/e2e-request-flow.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url?.startsWith('/login')) return res.end(JSON.stringify({ token: 'tok-do-login' }))
  res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-request-flow-'))
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
const flowFile = join(workspace, 'flows/perfil.flow.vvpost.json')
writeFileSync(
  flowFile,
  JSON.stringify(
    {
      id: 'flow.perfil',
      name: 'Perfil',
      nodes: [
        { id: 'login', name: 'Login', type: 'request', position: { x: 0, y: 0 }, request: { method: 'POST', url: `${origin}/login` } },
        {
          id: 'perfil',
          name: 'Perfil',
          type: 'request',
          position: { x: 260, y: 0 },
          request: { method: 'GET', url: `${origin}/me`, headers: { Authorization: 'Bearer {{ $nodes.Login.data.token }}' } }
        }
      ],
      edges: [{ from: 'login', to: 'perfil' }]
    },
    null,
    2
  )
)

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
  // A aba ativa do Quick Request (as outras ficam montadas, escondidas).
  const req = panel.locator('[role=tabpanel]:not([hidden])')
  const url = () => req.locator('input[aria-label="URL"]')
  const view = () => panel.getByRole('radiogroup', { name: 'Visão do documento' })

  // O fluxo Login → Perfil termina numa requisição: o explorador abre na visão Simples.
  await tab('Nova requisição').waitFor()
  await win.keyboard.press('Control+Shift+E')
  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  await tree.getByRole('button', { name: 'Perfil' }).click()
  await tab('Perfil').waitFor()
  assert.equal(await tab('Perfil').getAttribute('aria-selected'), 'true')
  assert.equal(await url().inputValue(), `${origin}/me`)
  await panel.getByText('Antes: Login').waitFor()

  // O Login roda em segundo plano no envio, e a requisição lê o token dele.
  await req.getByRole('button', { name: 'Enviar' }).click()
  await req.getByText('200 OK').waitFor()
  assert.equal(JSON.parse(await req.locator('pre').first().textContent()).auth, 'Bearer tok-do-login')

  // Ctrl+S grava no mesmo arquivo: o grafo fica, a requisição muda.
  await url().fill(`${origin}/me?completo=1`)
  await win.keyboard.press('Control+s')
  await win.getByText('Salvo em flows/perfil.flow.vvpost.json').waitFor()
  const saved = JSON.parse(readFileSync(flowFile, 'utf8'))
  assert.deepEqual(saved.nodes.map((n) => n.id), ['login', 'perfil'])
  assert.deepEqual(saved.edges, [{ from: 'login', to: 'perfil' }])
  assert.equal(saved.nodes[1].request.url, `${origin}/me?completo=1`)

  // Canvas: a aba vira o fluxo no Flow Studio; Simples volta ao Quick Request.
  await view().getByRole('radio', { name: 'Canvas' }).click()
  await panel.locator('select[aria-label="Fluxo"]').waitFor()
  assert.equal(await tab('Perfil').getAttribute('aria-selected'), 'true')
  assert.equal(await bar.getByRole('tab', { name: 'Perfil', exact: true }).count(), 1)
  await view().getByRole('radio', { name: 'Simples' }).click()
  await url().waitFor()
  assert.equal(await url().inputValue(), `${origin}/me?completo=1`)

  // Uma requisição nova: Ctrl+S pergunta o nome e cria o fluxo em flows/.
  const before = new Set(readdirSync(join(workspace, 'flows')))
  await win.keyboard.press('Control+n')
  await bar.getByRole('tab', { name: 'Nova requisição', exact: true, selected: true }).waitFor()
  await url().fill(`${origin}/ping`)
  await win.keyboard.press('Control+s')
  const dialog = win.getByRole('dialog', { name: 'Salvar a requisição como fluxo' })
  await dialog.getByLabel('Nome do fluxo').fill('Ping')
  await dialog.getByRole('button', { name: 'Salvar' }).click()
  await tab('Ping').waitFor()
  const created = readdirSync(join(workspace, 'flows')).find((f) => !before.has(f))
  const ping = JSON.parse(readFileSync(join(workspace, 'flows', created), 'utf8'))
  assert.equal(ping.name, 'Ping')
  assert.equal(ping.nodes.length, 1)
  await tree.getByRole('button', { name: 'Ping' }).waitFor()

  // Uma credencial digitada no header não vai para o arquivo do fluxo.
  await req.locator('input[aria-label="Nome do cabeçalho"]').first().fill('Authorization')
  await req.locator('input[aria-label="Valor do cabeçalho"]').first().fill('Bearer abc123def456')
  await win.keyboard.press('Control+s')
  await win.getByText(/Gravação bloqueada/).first().waitFor()
  assert.ok(!readFileSync(join(workspace, 'flows', created), 'utf8').includes('abc123def456'))

  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
  console.log('E2E de requisição e fluxo: ok')
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
