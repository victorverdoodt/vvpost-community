#!/usr/bin/env node
// Teste ponta a ponta da exportação da documentação como site HTML no app real (build de produção
// em out/), sem módulo Enterprise: o "Enviar para…" cria o vvpost.publish.json com o Site HTML,
// exporta para dist/site com os diagramas desenhados pelo Mermaid, e na segunda vez mostra o diff
// da página que mudou, pede confirmação e registra a mudança na página Mudanças. Confere que o
// site não leva segredo e que o vvpost.publish.json não ganha ids.
// Uso: npm run build && node scripts/e2e-docs-export.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const VAULT_SECRET = 'segredo-do-cofre-export-e2e'
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-export-ws-'))
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
put('docs/projeto.md', ['## Visão geral', '', 'Leia o [guia](guias/inicio.md).', '', '```mermaid', 'flowchart LR', '  App -->|"chama<br>a API"| API', '```', ''].join('\n'))
put('docs/guias/inicio.md', ['# Primeiros passos', '', `Nunca cole ${VAULT_SECRET} aqui.`, ''].join('\n'))

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
const env = { ...process.env }
delete env.VVPOST_ENTERPRISE_MODULE
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env
})

const site = join(workspace, 'dist/site')
const read = (file) => readFileSync(join(site, file), 'utf8')

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const nav = win.getByRole('navigation', { name: 'Módulos' })
  await nav.getByRole('button', { name: 'Documentação' }).click()
  const panel = win.locator('main > div:not([hidden])')
  // Sem módulo Enterprise, o botão aparece pelo exportador html do core.
  await panel.getByRole('button', { name: 'Enviar para…' }).click()
  const dialog = win.getByRole('dialog', { name: 'Enviar documentação' })

  await dialog.getByText('Este projeto ainda não tem destinos.', { exact: false }).waitFor()
  assert.equal(await dialog.getByLabel('Publicador').inputValue(), 'html')
  assert.equal(await dialog.getByLabel(/Pasta de saída/).inputValue(), 'dist/site')
  await dialog.getByRole('button', { name: 'Criar vvpost.publish.json' }).click()
  await dialog.getByText('Exporta para a pasta', { exact: false }).waitFor()
  const configText = () => readFileSync(join(workspace, 'vvpost.publish.json'), 'utf8')
  assert.equal(JSON.parse(configText()).targets[0].provider, 'html')

  // Primeira exportação: tudo novo, sem confirmação.
  await dialog.getByRole('button', { name: 'Ver o que vai mudar' }).click()
  await dialog.getByText(/item\(ns\) em dist\/site/).waitFor({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Exportar' }).click()
  await dialog.getByRole('button', { name: 'Abrir a pasta' }).waitFor()
  assert.ok((await dialog.getByText('criada', { exact: true }).count()) >= 4)
  const before = configText()
  assert.ok(!before.includes('"published"'), 'o exportador gravou ids no vvpost.publish.json')

  for (const f of ['index.html', 'guias-inicio.html', 'connector-billing.html', 'mudancas.html', 'vvpost-site.json']) assert.ok(existsSync(join(site, f)), f)
  const index = read('index.html')
  assert.match(index, /<a href="guias-inicio\.html">guia<\/a>/)
  // O diagrama virou um SVG válido como arquivo (o <br> do rótulo fechado).
  const svgName = /assets\/(vv-diagrama-[0-9a-f]{12}\.svg)/.exec(index)?.[1]
  assert.ok(svgName, 'o diagrama não virou imagem')
  const svg = read(`assets/${svgName}`)
  assert.ok(svg.startsWith('<svg') && svg.includes('<br/>') && !/<br>/.test(svg), 'SVG do diagrama não é XML válido')
  await dialog.getByRole('button', { name: 'Fechar' }).last().click()

  // Segunda: o guia muda; a mudança vem marcada, com diff, e pede confirmação.
  put('docs/guias/inicio.md', ['# Primeiros passos', '', 'Agora com o passo 2.', ''].join('\n'))
  await panel.getByRole('button', { name: 'Enviar para…' }).click()
  await dialog.getByRole('button', { name: 'Ver o que vai mudar' }).click()
  await dialog.getByText('muda', { exact: true }).waitFor({ timeout: 30_000 })
  assert.equal(await dialog.getByRole('checkbox', { name: 'Atualizar' }).isChecked(), true)
  await dialog.getByRole('button', { name: 'Ver diferenças' }).first().click()
  await dialog.getByText('Agora com o passo 2.', { exact: false }).first().waitFor()
  await dialog.getByRole('button', { name: 'Exportar' }).click()
  await dialog.getByText(/já existem em dist\/site e vão mudar/).waitFor()
  if (screenshot) await win.screenshot({ path: screenshot })
  await dialog.getByRole('button', { name: 'Confirmar e exportar' }).click()
  await dialog.getByText('atualizada', { exact: true }).waitFor()
  assert.match(read('guias-inicio.html'), /Agora com o passo 2\./)
  assert.match(read('mudancas.html'), /<h3 class="vv-changed">Páginas alteradas<\/h3><ul><li><a href="guias-inicio\.html">Primeiros passos<\/a><\/li><\/ul>/)
  assert.equal(configText(), before)

  for (const f of readdirSync(site)) if (f.endsWith('.html')) assert.ok(!read(f).includes(VAULT_SECRET), `segredo em ${f}`)
  assert.ok(!read('assets/vvpost-search.js').includes(VAULT_SECRET))
  assert.ok(!(await win.content()).includes(VAULT_SECRET), 'o segredo do cofre chegou ao renderer')
  assert.deepEqual(errors, [])
  console.log('E2E da exportação em HTML: ok')
} finally {
  await app.close()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}
