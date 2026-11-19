#!/usr/bin/env node
// Capturas da documentação a partir do app real (build de produção em out/): abre o projeto de
// demonstração (examples/demo-workspace) contra a API de mentira, passa pelas telas que as docs
// mostram e grava cada uma em docs/assets/screenshots, em 1280x800. Só dados fictícios do projeto
// de demonstração; o único segredo é o demo-secret de Development, que nunca aparece na tela.
// Uso: npm run build && node scripts/docs-screenshots.mjs [nome...]   (Linux sem display: xvfb-run -a)
// Com nomes, grava só essas capturas (ex.: workspace novo). VVPOST_SHOTS_DIR troca a pasta de saída,
// VVPOST_SHOTS_SIZE o tamanho lógico (padrão 1280x800) e VVPOST_SHOTS_SCALE a densidade (padrão 1);
// o site usa 1440x900 em 2x.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { demoServer } from './demo-server.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const out = process.env.VVPOST_SHOTS_DIR ?? join(root, 'docs/assets/screenshots')
const [width, height] = (process.env.VVPOST_SHOTS_SIZE ?? '1280x800').split('x').map(Number)
const scale = process.env.VVPOST_SHOTS_SCALE ?? '1'
mkdirSync(out, { recursive: true })
const only = new Set(process.argv.slice(2))

const server = demoServer()
// Na porta de sempre do projeto de demonstração (4010), para as URLs saírem como no guia.
await new Promise((r) => server.once('error', () => server.listen(0, '127.0.0.1', r)).listen(4010, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = join(mkdtempSync(join(tmpdir(), 'vvpost-shots-')), 'acme-payments')
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
for (const env of ['dev', 'staging']) {
  const file = join(workspace, `environments/${env}.env.json`)
  writeFileSync(file, readFileSync(file, 'utf8').replace('http://127.0.0.1:4010', origin))
}
mkdirSync(join(workspace, '.vvpost'))
writeFileSync(join(workspace, '.vvpost/secrets.local.json'), JSON.stringify({ 'env.dev': { CLIENT_SECRET: 'demo-secret' } }))
const userData = mkdtempSync(join(tmpdir(), 'vvpost-shots-data-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--force-device-scale-factor=${scale}`, `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_MCP_PORT: '0' }
})
try {
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height])
  const nav = win.getByRole('navigation', { name: 'Módulos', exact: true })
  await nav.waitFor()
  const panel = win.locator('main > div:not([hidden])')
  const bar = win.getByRole('tablist', { name: 'Abas do workspace' })
  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  const module = (name) => nav.getByRole('button', { name, exact: true }).click()
  const settle = (ms = 600) => win.waitForTimeout(ms)
  const shot = async (name, fn) => {
    if (only.size && !only.has(name)) return
    await fn()
    await settle()
    // A captura vem do Electron, com a janela inteira (barra de título incluída).
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')
    )
    writeFileSync(join(out, `${name}.png`), Buffer.from(png, 'base64'))
    console.log(join(out, `${name}.png`))
  }
  const noExplorer = async () => {
    if (await tree.isVisible()) await win.keyboard.press('Control+Shift+E')
    await tree.waitFor({ state: 'hidden' })
  }
  const explorer = async () => {
    if (!(await tree.isVisible())) await win.keyboard.press('Control+Shift+E')
    await tree.waitFor()
  }
  const openFile = async (name) => {
    await explorer()
    await tree.getByRole('button', { name, exact: true }).click()
    await bar.getByRole('tab', { name, exact: true }).waitFor()
  }
  const expand = async (name) => {
    const item = tree.getByRole('treeitem').filter({ hasText: name })
    if (await item.getByRole('button', { name: 'Expandir' }).count()) await item.getByRole('button', { name: 'Expandir' }).click()
  }

  // Workspace: explorador, abas por tipo e um .md como documentação viva, lado a lado.
  await shot('workspace', async () => {
    await openFile('guia-de-integracao.md')
    await panel.getByText('Lado a lado').click()
    await panel.locator('.monaco-editor').waitFor()
    await panel.getByRole('heading', { name: /POST \/charges/ }).first().waitFor()
  })

  await shot('documento-md', async () => {
    await openFile('projeto.md')
    await panel.getByText('Prévia viva').click()
    await panel.locator('svg[id^="mermaid"], .mermaid svg, svg[aria-roledescription]').first().waitFor({ timeout: 30_000 })
  })

  await shot('novo', async () => {
    await win.keyboard.press('Control+Shift+N')
    await win.getByRole('dialog', { name: 'Novo' }).waitFor()
  })
  await win.keyboard.press('Escape')

  await shot('diagrama', async () => {
    await openFile('cobranca.mmd')
    await panel.getByText('Prévia ao vivo').waitFor()
    await panel.locator('svg').first().waitFor()
  })

  await shot('endpoint', async () => {
    await explorer()
    await expand('Payments Service v1')
    await tree.getByRole('button', { name: /Criar cobrança/ }).click()
    await bar.getByRole('tab', { name: 'Criar cobrança', exact: true }).waitFor()
    await panel.getByRole('button', { name: /^Enviar/ }).first().click()
    await panel.locator('text=201 Created >> visible=true').first().waitFor()
  })

  await shot('documentacao-editor', async () => {
    await module('Documentação')
    await panel.getByRole('radio', { name: 'Editor' }).click()
    const editor = panel.getByRole('region', { name: 'Editor da documentação do projeto' })
    await editor.getByText('Lado a lado', { exact: true }).click()
    await editor.locator('[data-testid="pdf-pages"] canvas').nth(1).waitFor({ timeout: 60_000 })
  })

  await shot('documentacao', async () => {
    await module('Documentação')
    await panel.getByRole('radio', { name: 'Visualizar' }).click()
    await panel.getByRole('region', { name: 'Documentação gerada' }).waitFor()
  })

  await shot('catalogo', async () => {
    await noExplorer()
    await module('Catálogo')
    await panel.getByRole('button', { name: /Payments Service v1/ }).first().click()
  })

  // Requisição: o cliente HTTP com a herança do conector, o corpo pelo formulário do schema e a
  // mesma requisição como fluxo (Simples | Canvas).
  await shot('quick-request', async () => {
    await module('Quick Request')
    await bar.getByRole('tab', { name: 'Nova requisição', exact: true }).click()
    await panel.locator('select[aria-label="Conector"]').selectOption('connector.payments.v1')
    await panel.locator('select[aria-label="Endpoint"]').selectOption('create_charge')
    await panel.getByRole('button', { name: 'Enviar' }).first().click()
    await panel.getByText('201').first().waitFor()
  })

  await shot('formulario', async () => {
    await panel.getByRole('tab', { name: /^Body/ }).first().click()
    await panel.getByRole('radiogroup', { name: 'Edição do corpo' }).getByRole('radio', { name: 'Formulário' }).click()
    await panel.getByLabel('Formulário do corpo').waitFor()
  })

  await shot('requisicao-fluxo', async () => {
    await explorer()
    await tree.getByRole('button', { name: 'Cobrança PIX' }).click()
    await panel.getByText(/Antes: Cliente/).first().waitFor()
    await noExplorer()
    await panel.getByRole('button', { name: 'Enviar' }).first().click()
    // A aba da requisição anterior continua montada (escondida): espera o 201 visível.
    await panel.locator('text=201 Created >> visible=true').first().waitFor()
  })

  await shot('requisicao-canvas', async () => {
    await panel.getByRole('radiogroup', { name: 'Visão do documento' }).getByRole('radio', { name: 'Canvas' }).click()
    await panel.getByTestId('flow-node-Cobranca').waitFor()
  })

  await shot('cenarios', async () => {
    await module('Cenários de teste')
    await panel.locator('select[aria-label="Conector"]').selectOption('connector.payments.v1')
    await panel.getByRole('button', { name: /^Rodar \d+ cenários/ }).click()
    await settle(1500)
    await panel.getByText('Cartão recusado (falha de propósito)').first().click()
  })

  await shot('flow-studio', async () => {
    await module('Flow Studio')
    await panel.getByRole('button', { name: 'Esconder os endpoints do catálogo' }).click().catch(() => {})
    await settle(300)
    await panel.locator('.react-flow__controls-fitview').click().catch(() => {})
    await panel.getByRole('button', { name: /Rodar fluxo/ }).click()
    await settle(1500)
    await panel.getByTestId('flow-node-Charge').click().catch(() => {})
  })

  // Importar: a revisão de uma spec OpenAPI antes de gravar (nada é gravado aqui).
  await shot('importar', async () => {
    const spec = join(root, 'test/fixtures/openapi/petstore.openapi.yaml')
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, spec)
    await module('Importar e exportar')
    await win.getByRole('button', { name: 'Escolher arquivos…' }).click()
    await win.getByLabel('Resumo da importação').waitFor()
    await win.getByRole('tree', { name: 'Conectores do import' }).getByText('/pets/{petId}/photo', { exact: true }).click().catch(() => {})
  })

  await shot('mcp', async () => {
    await module('MCP & IA')
  })

  await shot('historico', async () => {
    await module('Histórico')
    await panel.getByText('Cenários de Payments Service v1').first().click()
  })
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(dirname(workspace), { recursive: true, force: true })
}
