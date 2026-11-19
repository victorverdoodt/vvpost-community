#!/usr/bin/env node
// Teste ponta a ponta do "Enviar para…" da Documentação no app real (build de produção em out/):
// com um módulo Enterprise falso cujo publicador guarda o que recebeu, cria o vvpost.publish.json
// pelo diálogo, entra com a conta, publica a primeira vez (só páginas novas, sem confirmação),
// e na segunda vê o diff, confirma a página que muda e deixa de fora a editada no destino.
// Confere que os diagramas chegaram como PNG e que nenhum segredo saiu.
// Uso: npm run build && node scripts/e2e-docs-publish.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const VAULT_SECRET = 'segredo-do-cofre-publish-e2e'
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-publish-ws-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}
put('connectors/billing.connector.vvpost.json', {
  id: 'billing',
  name: 'Billing',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
  endpoints: [{ id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges' }]
})
put('environments/dev.env.json', {
  id: 'env.dev',
  name: 'Dev',
  variables: { BASE_URL: { type: 'string', value: 'https://api.dev' }, API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
})
put('.vvpost/secrets.local.json', { 'env.dev': { API_TOKEN: VAULT_SECRET } })
put('docs/projeto.md', ['## Visão geral', '', 'Leia o [guia](guias/inicio.md).', '', '```mermaid', 'flowchart LR', '  App --> API', '```', ''].join('\n'))
put('docs/guias/inicio.md', ['# Primeiros passos', '', `Nunca cole ${VAULT_SECRET} aqui.`, ''].join('\n'))

// Publicador falso: guarda cada pacote e aprovação; na segunda rodada, a página do documento
// muda e a do guia foi editada no destino por outra pessoa.
const moduleDir = mkdtempSync(join(tmpdir(), 'vvpost-publish-mod-'))
const log = join(moduleDir, 'log.json')
writeFileSync(
  join(moduleDir, 'enterprise.mjs'),
  `import { writeFileSync } from 'node:fs'
const LOG = ${JSON.stringify(log)}
const entries = []
const record = (e) => { entries.push(e); writeFileSync(LOG, JSON.stringify(entries)) }
let signedIn = false
const flat = (nodes, path = []) => nodes.flatMap((n) => [{ n, path }, ...flat(n.children, [...path, n.title])])
const show = (bundle) => JSON.parse(JSON.stringify(bundle, (_k, v) => (v instanceof Uint8Array ? { bytes: Buffer.from(v).toString('base64') } : v)))
const publisher = {
  id: 'confluence-cloud',
  title: 'Confluence Cloud',
  session: async () => (signedIn ? { status: 'signedIn', account: 'ana@contoso.com', destination: 'Espaço PAG', token: 'nao-pode-sair' } : { status: 'signedOut' }),
  async signIn() { signedIn = true; return publisher.session() },
  async signOut() { signedIn = false },
  async plan(bundle) {
    record({ kind: 'plan', bundle: show(bundle) })
    const items = flat(bundle.nodes).map(({ n, path }) => {
      const known = bundle.published[n.key]
      const item = { key: n.key, kind: n.kind, title: n.title, path, action: known ? 'same' : 'create' }
      if (known && n.key === 'document') Object.assign(item, { action: 'update', remote: { id: known.id, version: 2 }, before: 'Texto antigo', after: n.page?.markdown ?? '' })
      if (known && n.key === 'file:docs/guias/inicio.md') Object.assign(item, { action: 'conflict', remote: { id: known.id, version: 5, editedBy: 'Bruno', editedAt: '2026-10-20T10:00:00Z' }, before: 'editado lá', after: 'daqui' })
      return item
    })
    return { destination: { label: 'Espaço PAG / Pagamentos' }, warnings: [], items }
  },
  async publish(bundle, plan, approval) {
    record({ kind: 'publish', approval })
    let id = 100
    const items = plan.items.map((i) => {
      const go = i.action === 'create' || (i.action === 'update' && approval.update.includes(i.key)) || (i.action === 'conflict' && approval.conflicts.includes(i.key))
      const prev = bundle.published[i.key]
      return { key: i.key, kind: i.kind, title: i.title, outcome: !go ? (i.action === 'same' ? 'unchanged' : 'skipped') : i.action === 'create' ? 'created' : 'updated', id: prev?.id ?? String(id++), version: (prev?.version ?? 0) + (go ? 1 : 0), url: 'https://contoso.atlassian.net/wiki/x' }
    })
    return { destination: plan.destination, items }
  }
}
export default {
  apiVersion: 1,
  audit: () => {},
  createBackend: async () => { throw new Error('não usado') },
  controlPlane: { activity: () => {}, publishers: [publisher] }
}
`
)
const entries = () => JSON.parse(readFileSync(log, 'utf8'))

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_ENTERPRISE_MODULE: join(moduleDir, 'enterprise.mjs') }
})

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const nav = win.getByRole('navigation', { name: 'Módulos' })
  await nav.getByRole('button', { name: 'Documentação' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Enviar para…' }).click()
  const dialog = win.getByRole('dialog', { name: 'Enviar documentação' })

  // Sem vvpost.publish.json: o diálogo cria o de partida.
  await dialog.getByText('Este projeto ainda não tem destinos.', { exact: false }).waitFor()
  await dialog.getByLabel(/Destino \(do catálogo/).fill('catalog:pagamentos')
  await dialog.getByRole('button', { name: 'Criar vvpost.publish.json' }).click()
  const config = () => JSON.parse(readFileSync(join(workspace, 'vvpost.publish.json'), 'utf8'))
  await dialog.getByRole('button', { name: 'Entrar' }).waitFor()
  assert.equal(config().targets[0].destination, 'catalog:pagamentos')

  // Sem entrar, não monta o plano; depois de entrar, mostra a conta.
  assert.ok(await dialog.getByRole('button', { name: 'Ver o que vai mudar' }).isDisabled())
  await dialog.getByRole('button', { name: 'Entrar' }).click()
  await dialog.getByText('ana@contoso.com').waitFor()
  assert.ok(!(await win.content()).includes('nao-pode-sair'), 'o token da sessão chegou ao renderer')

  // Primeira publicação: tudo novo, sem confirmação.
  await dialog.getByRole('button', { name: 'Ver o que vai mudar' }).click()
  await dialog.getByText(/item\(ns\) em Espaço PAG \/ Pagamentos/).waitFor({ timeout: 30_000 })
  await dialog.getByText(/Guias \/ Primeiros passos$/).waitFor()
  await dialog.getByRole('button', { name: 'Publicar' }).click()
  await dialog.getByText('Os ids das páginas foram gravados', { exact: false }).waitFor()
  assert.ok((await dialog.getByText('criada', { exact: true }).count()) > 3)
  const published = config().targets[0].published
  assert.ok(published.document && published['file:docs/guias/inicio.md'] && published['connector:billing'], JSON.stringify(published))

  // O diagrama chegou como PNG desenhado pelo Mermaid; a página do guia, sem o segredo.
  const first = entries()[0].bundle
  const diagrams = first.assets.filter((a) => a.diagram)
  const ours = diagrams.find((a) => a.diagram.includes('App --> API'))
  assert.ok(ours?.data?.bytes, 'o diagrama do documento não virou imagem')
  assert.equal(Buffer.from(ours.data.bytes, 'base64').subarray(1, 4).toString('latin1'), 'PNG')
  assert.equal(entries()[1].kind, 'publish')
  assert.deepEqual(entries()[1].approval, { update: [], conflicts: [], archive: [] })
  await dialog.getByRole('button', { name: 'Fechar' }).last().click()

  // Segunda: o documento muda (vem marcado, com diff) e o guia foi editado lá (fica de fora).
  await panel.getByRole('button', { name: 'Enviar para…' }).click()
  await dialog.getByRole('button', { name: 'Ver o que vai mudar' }).click()
  await dialog.getByText('editada no destino', { exact: true }).waitFor({ timeout: 30_000 })
  await dialog.getByText(/por Bruno/).waitFor()
  assert.equal(await dialog.getByRole('checkbox', { name: 'Atualizar' }).isChecked(), true)
  assert.equal(await dialog.getByRole('checkbox', { name: 'Sobrescrever' }).isChecked(), false)
  await dialog.getByRole('button', { name: 'Ver diferenças' }).first().click()
  await dialog.getByText('No destino', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Publicar' }).click()
  await dialog.getByText(/já existem em Espaço PAG \/ Pagamentos e vão mudar/).waitFor()
  if (screenshot) await win.screenshot({ path: screenshot })
  await dialog.getByRole('button', { name: 'Confirmar e publicar' }).click()
  await dialog.getByText('atualizada', { exact: true }).waitFor()
  await dialog.getByText('mantida', { exact: true }).waitFor()
  assert.deepEqual(entries().at(-1).approval, { update: ['document'], conflicts: [], archive: [] })
  assert.equal(config().targets[0].published.document.version, 2)

  assert.ok(!readFileSync(log, 'utf8').includes(VAULT_SECRET), 'o segredo do cofre foi para o publicador')
  assert.ok(!(await win.content()).includes(VAULT_SECRET), 'o segredo do cofre chegou ao renderer')
  assert.deepEqual(errors, [])
  console.log('E2E do Enviar para: ok')
} finally {
  await app.close()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
  rmSync(moduleDir, { recursive: true, force: true })
}
