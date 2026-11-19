#!/usr/bin/env node
// Teste ponta a ponta de mover painéis como no VS Code (build de produção em out/): arrastar o
// explorador pelo grip do cabeçalho para a direita e para baixo, o inspector para a esquerda e
// para baixo, e a edição do Quick Request para o lado da resposta; o overlay mostra onde o painel
// cai, Esc cancela, o menu "Mover..." faz o mesmo pelo teclado e o lado volta depois de reabrir.
// Uso: npm run build && node scripts/e2e-panel-dock.mjs   (Linux sem display: xvfb-run -a)
// E2E_SCREENSHOT=<pasta> grava capturas do resultado.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const shots = process.env.E2E_SCREENSHOT

const workspace = join(mkdtempSync(join(tmpdir(), 'vvpost-dock-')), 'acme-payments')
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
if (shots) mkdirSync(shots, { recursive: true })

const launch = () =>
  _electron.launch({
    executablePath: electronBin,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
    env: { ...process.env, VVPOST_MCP_PORT: '0' }
  })

/** Arrasta o grip até o ponto (fx, fy) da área `area` (frações da largura e da altura). */
async function dragTo(win, grip, area, fx, fy, { drop = true } = {}) {
  const g = await grip.boundingBox()
  const a = await area.boundingBox()
  assert.ok(g && a, 'grip e área visíveis')
  const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 }
  const to = { x: a.x + a.width * fx, y: a.y + a.height * fy }
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  for (let i = 1; i <= 10; i++) await win.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10)
  if (drop) await win.mouse.up()
}

let app = await launch()
try {
  let win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  const shot = async (name) => shots && (await win.waitForTimeout(300), await win.screenshot({ path: join(shots, `${name}.png`) }))

  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  await win.getByRole('tablist', { name: 'Abas do workspace' }).waitFor()
  await win.waitForTimeout(800)
  if (!(await tree.isVisible())) await win.keyboard.press('Control+Shift+E')
  await tree.waitFor()
  const main = win.locator('main')
  const explorer = win.locator('[data-explorer-side]')
  const explorerGrip = win.getByRole('img', { name: 'Arrastar para mover o explorador' })

  // Durante o arraste, o overlay pinta a metade onde o explorador cai; Esc cancela.
  await dragTo(win, explorerGrip, main, 0.9, 0.5, { drop: false })
  await win.locator('[data-dock-target="right"]').waitFor()
  await win.getByRole('status').filter({ hasText: 'Mover o explorador para a direita' }).waitFor()
  await shot('arrastando-explorador')
  await win.keyboard.press('Escape')
  await win.mouse.up()
  await win.locator('[data-dock-target]').waitFor({ state: 'detached' })
  assert.equal(await explorer.getAttribute('data-explorer-side'), 'left', 'Esc cancela o arraste')

  // Soltar na metade direita leva o explorador para a direita.
  await dragTo(win, explorerGrip, main, 0.9, 0.5)
  await win.locator('[data-explorer-side="right"]').waitFor()
  assert.ok((await explorer.boundingBox()).x > (await main.boundingBox()).x, 'o explorador ficou à direita')

  // No terço de baixo, ele vira o painel de baixo, abaixo das abas.
  await dragTo(win, explorerGrip, win.locator('main'), 0.5, 0.9)
  await win.locator('[data-explorer-side="bottom"]').waitFor()
  const eb = await explorer.boundingBox()
  const mb = await main.boundingBox()
  assert.ok(eb.y >= mb.y + mb.height - 2 && eb.width > 900, 'o explorador ficou embaixo, na largura da área de trabalho')

  // Inspector: para a esquerda pelo grip e para baixo pelo menu "Mover o inspector…".
  const inspector = win.locator('main > div:not([hidden]) aside[data-inspector-side]').first()
  const content = win.locator('main > div:not([hidden])').first()
  await dragTo(win, inspector.getByRole('img', { name: 'Arrastar para mover o inspector' }), content, 0.15, 0.5)
  await win.locator('main > div:not([hidden]) aside[data-inspector-side="left"]').waitFor()
  assert.ok((await inspector.boundingBox()).x < (await content.boundingBox()).x + 5, 'o inspector ficou à esquerda')
  await inspector.getByRole('button', { name: 'Mover o inspector…' }).click()
  await win.getByRole('menuitem', { name: 'Mover o inspector para baixo' }).click()
  await win.locator('main > div:not([hidden]) aside[data-inspector-side="bottom"]').waitFor()

  // Quick Request: a edição ao lado da resposta (como dividir um grupo de editores).
  const area = win.locator('main > div:not([hidden]) [data-edit-side]').first()
  await dragTo(win, area.getByRole('img', { name: 'Arrastar para mover a edição da requisição' }), area, 0.85, 0.6)
  await win.locator('main > div:not([hidden]) [data-edit-side="right"]').waitFor()
  const resp = await area.getByRole('region', { name: 'Resposta' }).or(area.getByText('Sem resposta ainda')).first().boundingBox()
  const edit = await area.getByRole('tablist', { name: 'Requisição' }).boundingBox()
  assert.ok(edit.x > resp.x, 'a edição ficou à direita da resposta')
  await shot('paineis-movidos')

  // Reabrir: cada painel volta onde ficou no workspace.
  await app.close()
  app = await launch()
  win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  await win.getByRole('tablist', { name: 'Abas do workspace' }).waitFor()
  await win.waitForTimeout(800)
  // Mostrar ou não o explorador depende da largura da janela até alguém escolher; o lado não.
  if (!(await win.getByRole('tree', { name: 'Arquivos do projeto' }).isVisible())) await win.keyboard.press('Control+Shift+E')
  await win.locator('[data-explorer-side="bottom"]').waitFor()
  await win.locator('main > div:not([hidden]) aside[data-inspector-side="bottom"]').waitFor()
  await win.locator('main > div:not([hidden]) [data-edit-side="right"]').waitFor()

  // A paleta devolve tudo ao lugar padrão.
  await win.keyboard.press('Control+K')
  await win.keyboard.type('Restaurar o layout dos painéis')
  await win.keyboard.press('Enter')
  await win.locator('[data-explorer-side="left"]').waitFor()
  await win.locator('main > div:not([hidden]) aside[data-inspector-side="right"]').waitFor()
  await win.locator('main > div:not([hidden]) [data-edit-side="top"]').waitFor()

  assert.deepEqual(errors, [], 'sem erros no renderer')
  console.log('e2e-panel-dock: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
