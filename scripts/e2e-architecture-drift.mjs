#!/usr/bin/env node
// Teste ponta a ponta do C4 que envelhece (docs/documentation.md#diagramas-c4-que-não-envelhecem) no
// app real (build de produção em out/): um C4 escrito à mão liga um elemento a um conector removido
// e não mostra um conector novo; o painel Lint do Catálogo acusa os dois, abre a página no achado e
// corrige o diagrama com confirmação, e o achado abre a página.
// Uso: npm run build && node scripts/e2e-architecture-drift.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}
const connector = (id, name) => ({
  id,
  name,
  version: '1.0.0',
  description: `API de ${name}.`,
  config: { baseUrl: 'https://api.exemplo.com' },
  endpoints: [{ id: 'listar', name: `Listar ${name}`, description: 'Lista.', method: 'GET', path: `/${id.split('.').at(-1)}` }]
})
put('connectors/pedidos.connector.vvpost.json', connector('svc.pedidos', 'Pedidos'))
put('connectors/frete.connector.vvpost.json', connector('svc.frete', 'Frete'))
put(
  'docs/arquitetura.md',
  [
    '# Arquitetura',
    '',
    '```mermaid',
    'C4Container',
    '  title Contêineres',
    '  Person(cliente, "Cliente")',
    '  Container(pedidos, "Pedidos", "Node")',
    '  Container(estoque, "Estoque", "Node")',
    '  Rel(cliente, pedidos, "Compra")',
    '  Rel(pedidos, estoque, "Reserva")',
    '  %% vvpost:bind estoque connector:svc.estoque',
    '```',
    ''
  ].join('\n')
)

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

  await win.getByRole('button', { name: 'Catálogo' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Abrir workspace…' }).click()

  // O painel Lint abre sozinho (há erro) e mostra os dois achados com a linha do diagrama.
  const stale = win.getByRole('button', { name: /c4-binding-unknown.*svc\.estoque.*docs\/arquitetura\.md:11/s })
  await stale.waitFor()
  await win.getByRole('button', { name: /c4-connector-missing.*svc\.frete.*docs\/arquitetura\.md:3/s }).waitFor()

  // Corrigir: o diálogo mostra as linhas que saem e entram; confirmar grava.
  await win.getByRole('button', { name: 'Corrigir os diagramas (2)' }).click()
  const dialog = win.getByRole('dialog')
  await dialog.getByText('Corrigir 2 divergência(s) nos diagramas?').waitFor()
  await dialog.getByText('- Container(estoque, "Estoque", "Node")', { exact: false }).waitFor()
  await dialog.getByText('+ System_Ext(svc_frete, "Frete", "API de Frete.")', { exact: false }).waitFor()
  await dialog.getByRole('button', { name: 'Corrigir' }).click()
  await stale.waitFor({ state: 'detached' })
  await win.getByRole('button', { name: /Corrigir os diagramas/ }).waitFor({ state: 'detached' })

  // Um achado de página abre a página numa aba.
  await win.getByRole('button', { name: /doc-references-endpoint.*docs\/arquitetura\.md/s }).click()
  await win.getByRole('tab', { name: /arquitetura/ }).waitFor()

  const text = readFileSync(join(workspace, 'docs/arquitetura.md'), 'utf8')
  assert.ok(!text.includes('estoque'), text)
  assert.ok(text.includes('  System_Ext(svc_frete, "Frete", "API de Frete.")\n  %% vvpost:bind svc_frete connector:svc.frete\n```'), text)
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E do C4 que envelhece: ok')
