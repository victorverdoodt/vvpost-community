#!/usr/bin/env node
// Teste ponta a ponta do aviso depois de uma gravação do app (build de produção em out/): excluir
// um conector citado pelo documento do projeto deixa uma diretiva quebrada, e o app avisa o que o
// vvpost validate do CI reprovaria, como o MCP avisa o agente. Uma gravação que não quebra nada
// não avisa.
// Uso: npm run build && node scripts/e2e-write-problems.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-write-problems-'))
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
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
  const panel = win.locator('main > div:not([hidden])')
  const warning = win.getByText(/Esta mudança deixou um problema que o vvpost validate reprova/)
  const menuItem = async (title, name) => {
    const menu = win.getByRole('menu', { name: title })
    await menu.getByRole('menuitem', { name }).click()
  }

  await win.getByRole('button', { name: 'Catálogo' }).click()
  const tree = panel.getByRole('navigation', { name: 'Hierarquia de conectores' })

  // Duplicar não quebra nada: sem aviso.
  await tree.getByRole('button', { name: /(^|\s)Payments Service v1 \d+$/ }).click({ button: 'right' })
  await menuItem('Conector Payments Service v1', /^Duplicar/)
  await tree.getByRole('button', { name: /Payments Service v1 \(cópia\)/ }).waitFor()
  await win.waitForTimeout(1000)
  assert.equal(await warning.count(), 0, 'avisou sem a gravação quebrar nada')

  // Excluir o conector que o documento do projeto cita: o aviso aponta a diretiva.
  await tree.getByRole('button', { name: /(^|\s)Customers v2 \d+$/ }).click({ button: 'right' })
  await menuItem('Conector Customers v2', /^Excluir/)
  await win.getByRole('dialog', { name: /Excluir o conector Customers v2/ }).getByRole('button', { name: 'Excluir' }).click()
  await warning.waitFor()
  assert.match(await warning.textContent(), /docs\/projeto\.md: .*connector\.customers\.v2/)

  assert.deepEqual(errors, [])
  console.log('E2E do aviso depois de gravar no app: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
