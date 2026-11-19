#!/usr/bin/env node
// Teste ponta a ponta das listas laterais que se movem e das abas (build de produção em out/): a
// hierarquia do Catálogo vai para a direita pelo menu "Mover…" e volta pelo grip; o inspector entra
// como aba na lista (pelo grip e pela paleta) e sai de novo; um layout com nome é salvo, o layout
// padrão é restaurado e o salvo volta pela paleta, também depois de reabrir o app.
// Uso: npm run build && node scripts/e2e-panel-tabs.mjs   (Linux sem display: xvfb-run -a)
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

const workspace = join(mkdtempSync(join(tmpdir(), 'vvpost-tabs-')), 'acme-payments')
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
  // Logo depois de um painel mudar de lado o layout ainda assenta: espera o grip parar.
  let g = await grip.boundingBox()
  for (let i = 0; i < 20; i++) {
    await win.waitForTimeout(50)
    const next = await grip.boundingBox()
    if (next && g && next.x === g.x && next.y === g.y) break
    g = next
  }
  const a = await area.boundingBox()
  assert.ok(g && a, 'grip e área visíveis')
  const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 }
  const to = { x: a.x + a.width * fx, y: a.y + a.height * fy }
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  for (let i = 1; i <= 10; i++) await win.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10)
  if (drop) await win.mouse.up()
}

async function palette(win, text) {
  await win.keyboard.press('Control+K')
  await win.keyboard.type(text)
  await win.keyboard.press('Enter')
}

async function openCatalog(win) {
  await win.getByRole('tablist', { name: 'Abas do workspace' }).waitFor()
  await win.waitForTimeout(800)
  await win.keyboard.press('Control+3')
  // A lista ou, juntado, a aba que ficou à mostra.
  await win.locator('[data-pane-id="catalog.tree"]').waitFor()
}

let app = await launch()
try {
  let win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  const shot = async (name) => shots && (await win.waitForTimeout(300), await win.screenshot({ path: join(shots, `${name}.png`) }))

  await openCatalog(win)
  const pane = win.locator('[data-pane-id="catalog.tree"]')
  const content = win.locator('main > div:not([hidden])').first()
  const inspector = win.locator('main > div:not([hidden]) aside[data-inspector-side]').first()
  const tabs = win.getByRole('tablist', { name: 'Abas de Conectores' })
  assert.equal(await pane.getAttribute('data-pane-side'), 'left')

  // Pelo teclado: o botão de mover da lista abre o menu com "Mover ... para a direita".
  await pane.getByRole('button', { name: 'Mover a hierarquia de conectores…' }).click()
  await win.getByRole('menuitem', { name: 'Mover a hierarquia de conectores para a direita' }).click()
  await win.locator('[data-pane-id="catalog.tree"][data-pane-side="right"]').waitFor()
  // À direita do conector aberto (o inspector, à direita, fica depois da lista).
  const connector = win.getByRole('region', { name: /^Conector / })
  const cb = await connector.boundingBox()
  let pb = await pane.boundingBox()
  assert.ok(pb.x >= cb.x + cb.width - 2, `a hierarquia ficou à direita do conector: ${JSON.stringify({ pb, cb })}`)
  await shot('lista-a-direita')

  // Pelo grip: de volta à esquerda (o overlay mostra a metade antes de soltar).
  await win.getByRole('menu').waitFor({ state: 'detached' })
  await dragTo(win, pane.getByRole('img', { name: 'Arrastar para mover a hierarquia de conectores' }), content, 0.1, 0.5, { drop: false })
  await win.locator('[data-dock-target="left"]').waitFor()
  await win.mouse.up()
  await win.locator('[data-pane-id="catalog.tree"][data-pane-side="left"]').waitFor()
  pb = await pane.boundingBox()
  assert.ok(pb.x + pb.width <= (await connector.boundingBox()).x + 2, 'a hierarquia voltou para a esquerda')

  // O inspector entra como aba arrastando o grip dele para cima da lista.
  await dragTo(win, inspector.getByRole('img', { name: 'Arrastar para mover o inspector' }), pane, 0.5, 0.5, { drop: false })
  await win.locator('[data-dock-target="join"]').waitFor()
  await win.getByRole('status').filter({ hasText: 'Juntar o inspector como aba em a hierarquia de conectores' }).waitFor()
  await win.mouse.up()
  await tabs.waitFor()
  await win.locator('main > div:not([hidden]) aside[data-inspector-side]').waitFor({ state: 'detached' })
  const inspectorTab = tabs.getByRole('tab', { name: 'Inspector' })
  assert.equal(await inspectorTab.getAttribute('aria-selected'), 'true', 'o inspector juntado fica à mostra')
  const slot = pane.getByRole('tabpanel', { name: 'Inspector' })
  assert.ok(await slot.isVisible(), 'o conteúdo do inspector aparece dentro da lista')
  assert.ok((await slot.innerText()).trim().length > 0, 'o inspector juntado tem conteúdo')
  await shot('inspector-como-aba')

  // As abas trocam a view: a lista volta, o inspector some, sem desmontar nada.
  await tabs.getByRole('tab', { name: 'Conectores' }).click()
  await win.getByRole('navigation', { name: 'Hierarquia de conectores' }).waitFor()
  assert.ok(!(await slot.isVisible()), 'a aba da lista esconde o inspector')
  await inspectorTab.click()
  await slot.waitFor()

  // Separar pelo menu da lista: o inspector volta para o lado direito.
  await pane.getByRole('button', { name: 'Mover a hierarquia de conectores…' }).click()
  await win.getByRole('menuitem', { name: 'Separar o inspector (à direita)' }).click()
  await win.locator('main > div:not([hidden]) aside[data-inspector-side="right"]').waitFor()
  await tabs.waitFor({ state: 'detached' })

  // Pela paleta: juntar de novo e mover a lista para a direita.
  await palette(win, 'Juntar o inspector à lista lateral')
  await tabs.waitFor()
  await palette(win, 'Mover a lista lateral para a direita')
  await win.locator('[data-pane-id="catalog.tree"][data-pane-side="right"]').waitFor()

  // Layout com nome: salvar, restaurar o padrão e usar o salvo.
  await palette(win, 'Salvar o layout como')
  const name = win.getByRole('textbox', { name: 'Nome do layout' })
  await name.waitFor()
  await name.fill('Revisão')
  await win.keyboard.press('Enter')
  await name.waitFor({ state: 'detached' })
  await palette(win, 'Restaurar o layout dos painéis')
  await win.locator('[data-pane-id="catalog.tree"][data-pane-side="left"]').waitFor()
  await tabs.waitFor({ state: 'detached' })
  await win.locator('main > div:not([hidden]) aside[data-inspector-side="right"]').waitFor()
  await palette(win, 'Usar o layout Revisão')
  await win.locator('[data-pane-id="catalog.tree"][data-pane-side="right"]').waitFor()
  await tabs.waitFor()
  await shot('layout-salvo')

  // Reabrir: o layout aplicado fica, e o salvo continua na paleta.
  await app.close()
  app = await launch()
  win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  await openCatalog(win)
  await win.locator('[data-pane-id="catalog.tree"][data-pane-side="right"]').waitFor()
  await win.getByRole('tablist', { name: 'Abas de Conectores' }).waitFor()
  await palette(win, 'Restaurar o layout dos painéis')
  await win.locator('[data-pane-id="catalog.tree"][data-pane-side="left"]').waitFor()
  await palette(win, 'Usar o layout Revisão')
  await win.locator('[data-pane-id="catalog.tree"][data-pane-side="right"]').waitFor()

  // Apagar tira o layout da paleta.
  await palette(win, 'Apagar o layout Revisão')
  await win.keyboard.press('Control+K')
  await win.keyboard.type('Usar o layout Revisão')
  await win.waitForTimeout(300)
  assert.equal(await win.getByRole('option', { name: /Usar o layout Revisão/ }).count(), 0, 'o layout apagado sai da paleta')
  await win.keyboard.press('Escape')

  assert.deepEqual(errors, [], 'sem erros no renderer')
  console.log('e2e-panel-tabs: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
