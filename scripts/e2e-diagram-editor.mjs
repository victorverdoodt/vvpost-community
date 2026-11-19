#!/usr/bin/env node
// Teste ponta a ponta do editor de diagramas Mermaid no app real (build de produção em out/): o
// botão Editar de um diagrama da documentação abre a aba Diagramas com o código, a paleta e a
// prévia ao vivo; um bloco da paleta e um ícone de plugin entram no código e na prévia (o SVG do
// plugin chega sanitizado); clicar num nó acha o trecho; Salvar grava de volta no bloco do
// Markdown e no .mmd (recusando segredo e arquivo mudado por fora); um diagrama gerado vira um
// .mmd novo; e o botão Diagrama do editor do documento devolve o diagrama ao texto em edição.
// Uso: npm run build && node scripts/e2e-diagram-editor.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
const VAULT_SECRET = `vault-${Math.random().toString(36).slice(2)}-Dg9`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-diagram-editor-'))
const put = (base, path, data) => {
  mkdirSync(dirname(join(base, path)), { recursive: true })
  writeFileSync(join(base, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}
const read = (path) => readFileSync(join(workspace, path), 'utf8')
put(workspace, 'connectors/billing.connector.vvpost.json', {
  id: 'billing',
  name: 'Billing',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
  endpoints: [{ id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges' }]
})
put(workspace, 'environments/dev.env.json', {
  id: 'dev',
  name: 'Dev',
  variables: {
    BASE_URL: { type: 'string', value: 'https://dev.api.empresa.com' },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put(workspace, '.vvpost/secrets.local.json', { dev: { API_TOKEN: VAULT_SECRET } })
put(workspace, 'vvpost.docs.json', { title: 'Arquitetura da Plataforma', cover: false, toc: false })
const SOURCE = [
  '# Arquitetura',
  '',
  '```mermaid',
  'flowchart LR',
  '  api[API] --> banco[(Banco)]',
  '```',
  '',
  '## Mensageria',
  '',
  '{{> diagram docs/diagramas/fila.mmd}}',
  '',
  '{{> map}}',
  ''
].join('\n')
put(workspace, 'docs/projeto.md', SOURCE)
put(workspace, 'docs/diagramas/fila.mmd', 'sequenceDiagram\n  API->>Fila: evento\n')

// Um plugin só de diagramas: um pacote de ícones (com um SVG malicioso) e um bloco da paleta.
const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
const plugin = join(userData, 'plugins', 'acme-nuvem')
put(plugin, 'vvpost-plugin.json', {
  id: 'acme-nuvem',
  name: 'Acme Nuvem',
  version: '1.0.0',
  main: 'index.js',
  apiVersion: 1,
  contributes: {
    diagrams: {
      iconPacks: [{ prefix: 'acme', title: 'Acme Nuvem', file: 'icons/acme.json' }],
      blocks: [{ title: 'Foguete', category: 'Acme', code: '  foguete@{ icon: "acme:foguete", form: "square", label: "Foguete", pos: "b" }', icon: 'acme:foguete' }]
    }
  }
})
put(plugin, 'index.js', 'module.exports = {}')
put(plugin, 'icons/acme.json', {
  prefix: 'acme',
  width: 24,
  height: 24,
  icons: {
    foguete: { body: '<path d="M2 2h20v20H2z" fill="#ff00aa"/>' },
    mal: { body: '<g onload="window.__xss=1"><script>window.__xss=2</script><path d="M5 5h14v14H5z"/></g>' }
  }
})

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_MCP_PORT: '0' }
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))

  const nav = win.getByRole('navigation', { name: 'Módulos' })
  await nav.getByRole('button', { name: 'Documentação' }).click()
  const panel = win.locator('main > div:not([hidden])')
  const viewer = panel.getByRole('region', { name: 'Documentação gerada' })
  await viewer.locator('header h2').filter({ hasText: 'Arquitetura da Plataforma' }).waitFor()
  await viewer.locator('figure.mermaid-diagram svg').nth(1).waitFor({ timeout: 30_000 })

  // Editar o diagrama escrito no documento: abre a aba Diagramas com a origem.
  await viewer.getByRole('button', { name: 'Editar diagrama 1' }).click()
  const studio = panel.getByLabel('Editor de diagramas', { exact: true })
  await studio.getByText('docs/projeto.md, linha 3').waitFor()
  await studio.locator('[data-editor="monaco"]').waitFor()
  const preview = studio.getByTestId('diagram-preview')
  await preview.locator('svg').waitFor()
  await preview.getByText('API', { exact: true }).waitFor()

  // Um bloco da paleta entra no código e a prévia redesenha.
  const code = studio.locator('.monaco-editor').first()
  await code.click()
  await win.keyboard.press('Control+End')
  await studio.getByRole('region', { name: 'Blocos: Fluxograma' }).getByRole('button', { name: 'Decisão' }).click()
  await preview.getByText('Decisão?').waitFor()
  await studio.getByText('não salvo').waitFor()

  // Erro de sintaxe: a mensagem aparece e o último desenho fica (esmaecido).
  await win.keyboard.type('\n  --> -->')
  await studio.getByRole('alert').waitFor()
  assert.equal(await preview.count(), 1)
  for (let i = 0; i < 10 && (await studio.getByRole('alert').count()); i++) {
    await win.keyboard.press('Control+z')
    await win.waitForTimeout(300)
  }
  await studio.getByRole('alert').waitFor({ state: 'detached' })

  // Ícones do plugin: a busca acha o pacote, o ícone entra como nó com ícone e o SVG vem limpo.
  await studio.getByRole('radio', { name: 'Ícones' }).click()
  await studio.getByLabel('Buscar na paleta').fill('acme')
  await studio.getByRole('region', { name: 'Ícones: Acme Nuvem' }).waitFor()
  await code.click()
  await win.keyboard.press('Control+End')
  await studio.getByRole('button', { name: 'Ícone acme:foguete' }).click()
  await code.click()
  await win.keyboard.press('Control+End')
  await studio.getByRole('button', { name: 'Ícone acme:mal' }).click()
  await preview.locator('path[d="M2 2h20v20H2z"]').waitFor({ timeout: 15_000 })
  await preview.locator('path[d="M5 5h14v14H5z"]').waitFor()
  const svg = await preview.innerHTML()
  assert.ok(!/onload|<script/i.test(svg), 'o SVG do ícone do plugin passou sem sanitizar')
  assert.equal(await win.evaluate(() => window.__xss), undefined)
  // O bloco do plugin aparece na paleta com o grupo dele.
  await studio.getByRole('radio', { name: 'Blocos' }).click()
  await studio.getByLabel('Buscar na paleta').fill('')
  await studio.getByRole('region', { name: 'Blocos: Acme' }).getByRole('button', { name: 'Foguete' }).waitFor()

  // Clicar num nó da prévia seleciona o id dele no código.
  await preview.getByText('Banco', { exact: true }).click()
  await studio.locator('.monaco-editor .selected-text').first().waitFor()

  // Segredo no diagrama: recusado, nada muda no arquivo.
  await code.click()
  await win.keyboard.press('Control+End')
  await win.keyboard.type(`\n  segredo[${VAULT_SECRET}]`)
  await studio.getByRole('button', { name: 'Salvar', exact: true }).click()
  await win.getByText(/segredo do workspace; nada foi gravado/).waitFor()
  assert.equal(read('docs/projeto.md'), SOURCE)
  await win.keyboard.press('Control+z')
  await code.click()
  for (let i = 0; i < 3; i++) await win.keyboard.press('Control+z')
  await win.waitForFunction(() => !document.querySelector('[aria-label="Editor de diagramas"] .monaco-editor')?.textContent?.includes('segredo['))

  // Salvar grava de volta no bloco do Markdown, sem mexer no resto.
  await studio.getByRole('button', { name: 'Salvar', exact: true }).click()
  await win.getByText('Diagrama salvo em docs/projeto.md, linha 3').waitFor()
  const md = read('docs/projeto.md')
  assert.match(md, /```mermaid\nflowchart LR\n {2}api\[API\] --> banco\[\(Banco\)\]\n[\s\S]*decisao\{Decisão\?\}[\s\S]*acme:foguete[\s\S]*\n```\n\n## Mensageria\n\n\{\{> diagram docs\/diagramas\/fila\.mmd\}\}/)
  assert.ok(!md.includes(VAULT_SECRET))
  await studio.getByText('não salvo').waitFor({ state: 'detached' })
  if (screenshot) await win.screenshot({ path: screenshot })

  // Arquivo mudado por fora depois de aberto: não sobrescreve.
  await code.click()
  await win.keyboard.press('Control+End')
  await win.keyboard.type('\n  extra[Extra]')
  writeFileSync(join(workspace, 'docs/projeto.md'), md.replace('api[API]', 'api[API alterada]'))
  await studio.getByRole('button', { name: 'Salvar', exact: true }).click()
  await win.getByText(/mudou em "docs\/projeto\.md" desde que foi aberto/).waitFor()
  writeFileSync(join(workspace, 'docs/projeto.md'), md)

  // Voltar: a visualização já mostra o diagrama novo.
  await studio.getByRole('button', { name: 'Voltar' }).click()
  await panel.getByRole('button', { name: 'Sair sem salvar' }).click()
  await viewer.getByText('Decisão?').waitFor({ timeout: 30_000 })

  // O diagrama do .mmd ({{> diagram}}): grava no arquivo.
  await viewer.getByRole('button', { name: 'Editar diagrama 2' }).click()
  await studio.getByText('docs/diagramas/fila.mmd', { exact: true }).first().waitFor()
  await code.click()
  await win.keyboard.press('Control+End')
  await studio.getByRole('region', { name: 'Blocos: Sequência' }).getByRole('button', { name: 'Nota' }).click()
  await studio.getByRole('button', { name: 'Salvar', exact: true }).click()
  await win.getByText('Diagrama salvo em docs/diagramas/fila.mmd').waitFor()
  assert.match(read('docs/diagramas/fila.mmd'), /API->>Fila: evento\n {2}Note over Usuario,API: Observação\n$/)

  // Um diagrama gerado (o mapa do projeto): só "Salvar como .mmd", que cria o arquivo e copia a diretiva.
  await studio.getByRole('button', { name: 'Voltar' }).click()
  await viewer.getByRole('button', { name: 'Editar diagrama 3' }).click()
  await studio.getByText('(gerado do projeto)').waitFor()
  assert.equal(await studio.getByRole('button', { name: 'Salvar', exact: true }).count(), 0)
  await studio.getByRole('button', { name: 'Salvar como .mmd…' }).click()
  await win.getByLabel('Nome do diagrama').fill('Mapa editado')
  await win.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click()
  await win.getByText(/Salvo em docs\/diagramas\/mapa-editado\.mmd/).waitFor()
  assert.ok(existsSync(join(workspace, 'docs/diagramas/mapa-editado.mmd')))
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '{{> diagram docs/diagramas/mapa-editado.mmd}}')
  await studio.getByLabel('Abrir diagrama do projeto').locator('option', { hasText: 'docs/diagramas/mapa-editado.mmd' }).waitFor({ state: 'attached' })

  // No editor do documento: o botão Diagrama abre o bloco do cursor e devolve ao texto em edição.
  await panel.getByRole('radio', { name: 'Editor' }).click()
  const editor = panel.getByRole('region', { name: 'Editor da documentação do projeto' })
  await editor.locator('[data-editor="monaco"]').waitFor()
  await editor.locator('.monaco-editor').getByText('flowchart LR').click()
  await editor.getByRole('button', { name: 'Diagrama' }).click()
  await studio.getByText('no documento em edição').waitFor()
  await code.click()
  await win.keyboard.press('Control+End')
  await studio.getByRole('region', { name: 'Blocos: Fluxograma' }).getByRole('button', { name: 'Subprocesso' }).click()
  await studio.getByRole('button', { name: 'Aplicar no documento' }).click()
  await editor.getByText('não salvo').waitFor()
  await editor.getByRole('button', { name: 'Salvar' }).click()
  // Espera este salvamento terminar: o aviso "Salvo em" do .mmd de antes ainda está na tela numa
  // máquina lenta, e o teste lia o arquivo antes da gravação.
  await editor.getByText('não salvo').waitFor({ state: 'hidden' })
  assert.match(read('docs/projeto.md'), /decisao\{Decisão\?\}[\s\S]*sub\[\[Subprocesso\]\]\n```/)

  assert.deepEqual(errors, [])
  console.log('E2E do editor de diagramas: ok')
} finally {
  await app.close()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}
