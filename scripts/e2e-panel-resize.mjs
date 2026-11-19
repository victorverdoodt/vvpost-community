#!/usr/bin/env node
// Teste ponta a ponta do layout dos painéis (build de produção em out/): arrastar a borda do
// explorador, do inspector e da divisão entre a edição e a resposta do Quick Request muda o
// tamanho; o tamanho volta depois de reabrir o app; duplo clique volta ao padrão; arrastar até o
// fim recolhe; o explorador passa para a direita pela paleta de comandos.
// Uso: npm run build && node scripts/e2e-panel-resize.mjs   (Linux sem display: xvfb-run -a)
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

const workspace = join(mkdtempSync(join(tmpdir(), 'vvpost-panels-')), 'acme-payments')
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

/** Arrasta a borda `handle` por `dx`, `dy` px, em passos, como a mão faria. */
async function drag(win, handle, dx, dy = 0) {
  const box = await handle.boundingBox()
  assert.ok(box, 'a borda arrastável está visível')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await win.mouse.move(x, y)
  await win.mouse.down()
  for (let i = 1; i <= 8; i++) await win.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8)
  await win.mouse.up()
}
/**
 * Garante o explorador aberto. Ele abre sozinho em janela larga, num momento que depende da máquina:
 * o Ctrl+Shift+E alterna, então se ele abriu logo depois do atalho (e o atalho fechou), tenta de novo.
 */
async function showExplorer(win, tree) {
  for (let i = 0; i < 4; i++) {
    if (await tree.waitFor({ timeout: 1500 }).then(() => true, () => false)) return
    await win.keyboard.press('Control+Shift+E')
  }
  await tree.waitFor()
}
const widthOf = async (loc) => Math.round((await loc.boundingBox()).width)
const heightOf = async (loc) => Math.round((await loc.boundingBox()).height)

let app = await launch()
try {
  let win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  const shot = async (name) => {
    if (!shots) return
    await win.waitForTimeout(300)
    await win.screenshot({ path: join(shots, `${name}.png`) })
  }

  // Explorador: a borda direita ajusta a largura.
  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  await win.getByRole('tablist', { name: 'Abas do workspace' }).waitFor()
  // Sem escolha lembrada, o explorador abre sozinho em janela larga: espera ele decidir.
  await showExplorer(win, tree)
  // O invólucro leva a largura (com a borda); o explorador fica dentro dele.
  const explorer = win.locator('[data-explorer-side]')
  const explorerHandle = win.getByRole('separator', { name: 'Largura do explorador' })
  const before = await widthOf(explorer)
  await drag(win, explorerHandle, 140)
  const wider = await widthOf(explorer)
  assert.ok(wider >= before + 120, `o explorador alargou (${before} → ${wider})`)

  // Quick Request: a divisão entre a edição e a resposta ajusta a altura da edição.
  const splitHandle = win.getByRole('separator', { name: 'Altura da edição da requisição' })
  const editing = win.locator('main > div:not([hidden]) section').filter({ has: win.getByRole('tablist', { name: 'Requisição' }) }).first()
  const editBefore = await heightOf(editing)
  await drag(win, splitHandle, 0, 120)
  const editAfter = await heightOf(editing)
  assert.ok(editAfter >= editBefore + 100, `a edição cresceu (${editBefore} → ${editAfter})`)

  // Inspector: a borda esquerda ajusta a largura (agora até 720 px, não mais 440).
  const inspector = win.locator('main > div:not([hidden]) aside[data-inspector-mode="inline"]').first()
  await inspector.waitFor()
  const inspectorHandle = inspector.getByRole('separator', { name: 'Largura do inspector' })
  const inspBefore = await widthOf(inspector)
  await drag(win, inspectorHandle, -200)
  const inspAfter = await widthOf(inspector)
  assert.ok(inspAfter >= inspBefore + 120 && inspAfter > 440, `o inspector alargou além do antigo limite (${inspBefore} → ${inspAfter})`)
  await shot('paineis-redimensionados')

  // Reabrir o app: os tamanhos voltam como ficaram no workspace.
  await app.close()
  app = await launch()
  win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  const explorer2 = win.locator('[data-explorer-side]')
  // Como na primeira abertura: numa tela pequena (1024x768, a do runner Windows) o app abre estreito
  // e o explorador não abre sozinho antes do setContentSize.
  await showExplorer(win, win.getByRole('tree', { name: 'Arquivos do projeto' }))
  assert.equal(await widthOf(explorer2), wider, 'a largura do explorador ficou lembrada')
  const inspector2 = win.locator('main > div:not([hidden]) aside[data-inspector-mode="inline"]').first()
  assert.ok(Math.abs((await widthOf(inspector2)) - inspAfter) <= 1, 'a largura do inspector ficou lembrada')

  // Duplo clique na borda volta ao padrão (240 px).
  await win.getByRole('separator', { name: 'Largura do explorador' }).dblclick()
  assert.equal(await widthOf(explorer2), 240, 'duplo clique volta à largura padrão')

  // A paleta de comandos passa o explorador para a direita; a borda passa para o lado esquerdo dele.
  await win.keyboard.press('Control+K')
  await win.keyboard.type('Mover o explorador para a direita')
  await win.keyboard.press('Enter')
  await win.locator('[data-explorer-side="right"]').waitFor()
  const exBox = await explorer2.boundingBox()
  const mainBox = await win.locator('main').boundingBox()
  assert.ok(exBox.x > mainBox.x + mainBox.width - 2, 'o explorador ficou à direita da área de trabalho')
  await drag(win, win.getByRole('separator', { name: 'Largura do explorador' }), -100)
  assert.ok((await widthOf(explorer2)) >= 320, 'à direita, arrastar para a esquerda alarga')
  await shot('explorador-a-direita')

  // Arrastar a borda até quase zero recolhe o explorador, como no VS Code.
  await drag(win, win.getByRole('separator', { name: 'Largura do explorador' }), 400)
  await win.getByRole('tree', { name: 'Arquivos do projeto' }).waitFor({ state: 'hidden' })

  assert.deepEqual(errors, [], 'sem erros no renderer')
  console.log('e2e-panel-resize: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
