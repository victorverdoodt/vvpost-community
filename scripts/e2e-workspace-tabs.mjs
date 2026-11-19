#!/usr/bin/env node
// Teste ponta a ponta do workspace de abas (build de produção em out/): o explorador abre cada
// arquivo numa aba da barra única, com o editor do tipo dele (documento .md com prévia viva e raw,
// diagrama .mmd, conector, endpoint, fluxo), e o modal Novo cria um documento.
// Uso: npm run build && node scripts/e2e-workspace-tabs.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-tabs-'))
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
mkdirSync(join(workspace, 'docs/diagramas'), { recursive: true })
writeFileSync(
  join(workspace, 'docs/guia.md'),
  '# Guia de integração\n\nComo cobrar um cliente.\n\n{{> endpoint connector.payments.v1/create_charge}}\n'
)
writeFileSync(join(workspace, 'docs/diagramas/fila.mmd'), 'sequenceDiagram\n  A->>B: oi\n')

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

  // A requisição de partida já é uma aba da barra única; o explorador abre com Ctrl+Shift+E.
  await tab('Nova requisição').waitFor()
  await win.keyboard.press('Control+Shift+E')
  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  await tree.getByRole('button', { name: 'Payments Service v1' }).waitFor()

  // Documento .md: prévia viva com a diretiva montada; Raw e Lado a lado mostram o texto.
  await tree.getByRole('button', { name: 'guia.md' }).click()
  assert.equal(await tab('guia.md').getAttribute('aria-selected'), 'true')
  await panel.getByRole('heading', { name: /POST \/charges/ }).waitFor()
  await panel.getByText('Lado a lado').click()
  await panel.locator('.monaco-editor').waitFor()
  await panel.locator('.monaco-editor textarea').focus()
  await win.keyboard.press('Control+End')
  await win.keyboard.type('\nTexto novo.\n')
  await panel.getByText('não salvo').waitFor()
  await win.keyboard.press('Control+s')
  await panel.getByText('não salvo').waitFor({ state: 'detached' })
  assert.match(readFileSync(join(workspace, 'docs/guia.md'), 'utf8'), /Texto novo\./)

  // O mesmo arquivo volta à mesma aba; um conector, um endpoint e um diagrama abrem cada um a sua.
  await tree.getByRole('button', { name: 'guia.md' }).click()
  assert.equal(await bar.getByRole('tab', { name: 'guia.md' }).count(), 1)
  await tree.getByRole('button', { name: 'Payments Service v1' }).click()
  await panel.getByLabel('Nome *').or(panel.getByText('Herda de (extends)')).first().waitFor()
  await tree.getByRole('treeitem').filter({ hasText: 'Payments Service v1' }).getByRole('button', { name: 'Expandir' }).click()
  // O endpoint é um fluxo de requisição: abre na visão Simples, pronto para enviar.
  await tree.getByRole('button', { name: 'Criar cobrança' }).click()
  await tab('Criar cobrança').waitFor()
  await panel.getByRole('button', { name: /^Enviar/ }).first().waitFor()
  await tree.getByRole('button', { name: 'fila.mmd' }).click()
  await panel.getByText('Prévia ao vivo').waitFor()
  assert.equal(await tab('fila.mmd').getAttribute('aria-selected'), 'true')

  // Ctrl+W fecha a aba ativa e a vizinha fica ativa; Ctrl+PageUp volta uma aba.
  await win.keyboard.press('Control+w')
  await tab('fila.mmd').waitFor({ state: 'detached' })
  await win.keyboard.press('Control+PageUp')

  // Um fluxo do explorador abre no Flow Studio, na mesma barra.
  await tree.getByRole('button', { name: 'Checkout' }).click()
  await tab('Checkout').waitFor()
  await panel.locator('select[aria-label="Fluxo"]').waitFor()

  // Novo (Ctrl+Shift+N): um documento novo vira um .md em docs/ e abre na aba dele.
  await win.keyboard.press('Control+Shift+N')
  const dialog = win.getByRole('dialog', { name: 'Novo' })
  await dialog.getByRole('option', { name: /^Documento/ }).click()
  await dialog.getByLabel('Título do documento').fill('Notas de release')
  await dialog.getByRole('button', { name: 'Criar' }).click()
  await tab('notas-de-release.md').waitFor()
  assert.equal(readFileSync(join(workspace, 'docs/notas-de-release.md'), 'utf8'), '# Notas de release\n\n')
  await tree.getByRole('button', { name: 'notas-de-release.md' }).waitFor()

  // Uma ferramenta (Git) também abre como aba.
  await win.keyboard.press('Control+6')
  await tab('Git Workspace').waitFor()

  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
  console.log('E2E do workspace de abas: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
