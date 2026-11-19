#!/usr/bin/env node
// Teste ponta a ponta de um publicador remoto vindo de plugin (contributes.publishers) no app real
// (build de produção em out/): o plugin fica na pasta de plugins do usuário, a pessoa cola o
// token no "Enviar para…", vê o plano e publica num servidor local que faz o papel da wiki. Confere
// que o token não chega ao renderer nem ao arquivo do projeto, e que o servidor recebeu a auth.
// Uso: npm run build && node scripts/e2e-docs-publish-plugin.mjs   (Linux sem display: xvfb-run -a)
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
const TOKEN = ['wiki', 'e2e', 'token', 'Hq72'].join('-')

const pages = []
const auths = new Set()
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    auths.add(req.headers.authorization ?? '')
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401
      return res.end('{"error":"unauthorized"}')
    }
    if (req.url === '/me') return res.end(JSON.stringify({ name: 'Dana Wiki' }))
    if (req.method === 'GET' && req.url === '/pages') return res.end(JSON.stringify(pages))
    if (req.method === 'POST' && req.url === '/pages') {
      const page = JSON.parse(body)
      pages.push({ id: String(pages.length + 1), ...page })
      return res.end(JSON.stringify({ id: String(pages.length), version: 1 }))
    }
    res.statusCode = 404
    res.end('{}')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-publish-plugin-ws-'))
const put = (dir, path, data) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}
put(workspace, 'docs/projeto.md', '## Visão geral\n\nO portal de pagamentos.\n')
put(workspace, 'docs/guias/inicio.md', '# Primeiros passos\n\nTexto.\n')
put(workspace, 'vvpost.publish.json', {
  targets: [{ id: 'wiki', provider: 'wiki', destination: 'space:DOC', diagrams: 'code', structure: [{ page: 'Documentação', source: 'document', children: [{ pages: 'docs/**/*.md' }] }] }]
})

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
put(userData, 'plugins/acme-wiki/vvpost-plugin.json', {
  id: 'acme-wiki',
  name: 'Wiki de exemplo',
  version: '1.0.0',
  main: 'index.js',
  apiVersion: 1,
  contributes: { publishers: [{ id: 'wiki', title: 'Wiki', hosts: [`127.0.0.1:${port}`], auth: { type: 'bearer', label: 'Token de integração' } }] }
})
put(
  userData,
  'plugins/acme-wiki/index.js',
  `const base = ${JSON.stringify(base)}
const walk = (nodes, out = []) => { for (const n of nodes) { if (n.page) out.push(n); walk(n.children, out) } return out }
module.exports = {
  publishers: {
    wiki: {
      async session(ctx) {
        const r = await ctx.http.send({ method: 'GET', url: base + '/me' })
        if (r.status !== 200) throw new Error('HTTP ' + r.status)
        return { account: r.json().name, destination: ctx.target.destination }
      },
      async plan(ctx) {
        const remote = (await ctx.http.send({ method: 'GET', url: base + '/pages' })).json()
        const items = walk(ctx.bundle.nodes).map((n) => ({ key: n.key, kind: 'page', title: n.title, path: [], action: remote.some((p) => p.title === n.title) ? 'same' : 'create' }))
        return { destination: { label: 'Wiki ' + ctx.target.destination }, items }
      },
      async publish(ctx) {
        const items = []
        for (const item of ctx.plan.items) {
          if (item.action !== 'create') { items.push({ key: item.key, outcome: 'unchanged' }); continue }
          const node = walk(ctx.bundle.nodes).find((n) => n.key === item.key)
          const r = (await ctx.http.send({ method: 'POST', url: base + '/pages', body: { title: node.title, body: node.page.markdown } })).json()
          items.push({ key: item.key, outcome: 'created', id: r.id, version: r.version })
        }
        return { items }
      }
    }
  }
}
`
)

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await win.getByRole('navigation', { name: 'Módulos' }).getByRole('button', { name: 'Documentação' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Enviar para…' }).click()
  const dialog = win.getByRole('dialog', { name: 'Enviar documentação' })

  // Sem credencial: o campo do token e o Entrar desligado até colar.
  const field = dialog.getByLabel('Token de integração')
  await field.waitFor()
  assert.ok(await dialog.getByRole('button', { name: 'Entrar' }).isDisabled())
  assert.ok(await dialog.getByRole('button', { name: 'Ver o que vai mudar' }).isDisabled())
  await field.fill('token-errado')
  await dialog.getByRole('button', { name: 'Entrar' }).click()
  await dialog.getByText(/Wiki recusou a credencial/).waitFor()
  await field.fill(TOKEN)
  await dialog.getByRole('button', { name: 'Entrar' }).click()
  await dialog.getByText('Dana Wiki').waitFor()
  assert.ok(!(await win.content()).includes(TOKEN), 'o token chegou ao renderer')

  await dialog.getByRole('button', { name: 'Ver o que vai mudar' }).click()
  await dialog.getByText(/item\(ns\) em Wiki space:DOC/).waitFor({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Publicar' }).click()
  await dialog.getByText('Os ids das páginas foram gravados', { exact: false }).waitFor({ timeout: 30_000 })
  assert.ok(pages.length >= 2, `o servidor recebeu ${pages.length} página(s)`)
  assert.ok(pages.some((p) => p.title === 'Primeiros passos'))
  const config = readFileSync(join(workspace, 'vvpost.publish.json'), 'utf8')
  assert.ok(!config.includes(TOKEN), 'o token foi para o vvpost.publish.json')
  assert.equal(Object.keys(JSON.parse(config).targets[0].published).length, pages.length)
  assert.ok(auths.has(`Bearer ${TOKEN}`) && auths.has('Bearer token-errado'))

  // Sair apaga a credencial: o campo volta.
  await dialog.getByRole('button', { name: 'Fechar' }).last().click()
  await panel.getByRole('button', { name: 'Enviar para…' }).click()
  await dialog.getByRole('button', { name: 'Sair' }).click()
  await dialog.getByLabel('Token de integração').waitFor()
  assert.deepEqual(errors, [])
  console.log(`e2e docs-publish-plugin: ok (${pages.length} páginas publicadas pelo plugin)`)
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
