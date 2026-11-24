#!/usr/bin/env node
// Teste ponta a ponta da aba dos tokens da marca (build de produção em out/): o explorador lista
// brand/*.tokens.json na seção Marca, a aba mostra os tokens com a amostra, o modo, o contraste e,
// sob pedido, o código conferido; a visão JSON edita e salva o arquivo.
// Uso: npm run build && node scripts/e2e-brand-tab.mjs   (Linux sem display: xvfb-run -a)
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

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-brand-tab-'))
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
const tokens = {
  color: {
    $type: 'color',
    primary: { $value: '#bd948a', $description: 'Rosé da clínica' },
    'on-primary': { $value: '#ffffff' },
    text: { $value: '#262626' },
    bg: { $value: '#ffffff' }
  },
  space: { 1: { $type: 'dimension', $value: '4px' }, 2: { $type: 'dimension', $value: '8px' } },
  $extensions: {
    vvpost: {
      modes: { dark: { 'color.bg': '#111111', 'color.text': '#f2f2f2' } },
      contrast: [
        { fg: 'color.on-primary', bg: 'color.primary' },
        { fg: 'color.text', bg: 'color.bg' }
      ],
      sources: ['web/**/*.css']
    }
  }
}
mkdirSync(join(workspace, 'brand'), { recursive: true })
mkdirSync(join(workspace, 'web'), { recursive: true })
writeFileSync(join(workspace, 'brand/clinica.tokens.json'), `${JSON.stringify(tokens, null, 2)}\n`)
writeFileSync(join(workspace, 'web/ui.css'), '.a { color: #bd948a; padding: 13px; }\n')

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
  const panel = win.locator('main > div:not([hidden])')

  await bar.getByRole('tab', { name: 'Nova requisição', exact: true }).waitFor()
  await win.keyboard.press('Control+Shift+E')
  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  await tree.getByRole('group', { name: 'Marca' }).waitFor()
  await tree.getByRole('button', { name: 'clinica.tokens.json' }).click()
  await bar.getByRole('tab', { name: 'clinica.tokens.json', exact: true }).waitFor()

  // Tokens por grupo, com o valor, a descrição e o contraste (branco sobre o rosé não passa).
  const view = panel.getByLabel('Tokens da marca brand/clinica.tokens.json')
  await view.getByRole('region', { name: 'Grupo color' }).getByText('Rosé da clínica').waitFor()
  await view.getByRole('region', { name: 'Grupo space' }).getByText('8px').waitFor()
  const contrast = view.getByRole('region', { name: 'Contraste' })
  await contrast.getByText('não passa').waitFor()
  assert.equal(await contrast.getByText('passa', { exact: true }).count(), 1)

  // O modo escuro troca os valores.
  await view.getByRole('radio', { name: 'dark' }).click()
  await view.getByRole('region', { name: 'Grupo color' }).getByText('#111111').waitFor()
  await view.getByRole('region', { name: 'Contraste' }).getByText('Contraste (dark)').waitFor()

  // O código do frontend conferido sob pedido: a cor solta e o espaçamento fora da escala.
  await view.getByRole('button', { name: 'Conferir o código' }).click()
  const code = view.getByRole('region', { name: 'Código do frontend' })
  await code.getByText('1 arquivo(s) lido(s), 2 achado(s).').waitFor()
  await code.getByText('brand-hardcoded-color').waitFor()
  await code.getByText('brand-spacing').waitFor()

  // JSON: edita e salva; a visão relê o arquivo gravado.
  await view.getByRole('radio', { name: 'JSON' }).click()
  const editor = view.getByLabel('JSON de brand/clinica.tokens.json')
  await editor.waitFor()
  const text = readFileSync(join(workspace, 'brand/clinica.tokens.json'), 'utf8').replace('#bd948a', '#a87b70')
  await editor.fill(text)
  await view.getByRole('button', { name: 'Salvar' }).click()
  await win.getByText('Salvo em brand/clinica.tokens.json').waitFor()
  assert.match(readFileSync(join(workspace, 'brand/clinica.tokens.json'), 'utf8'), /#a87b70/)
  await view.getByRole('radio', { name: 'Tokens' }).click()
  await view.getByRole('radio', { name: 'padrão' }).click()
  await view.getByRole('region', { name: 'Grupo color' }).getByText('#a87b70').waitFor()

  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
  console.log('E2E da aba dos tokens da marca: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
