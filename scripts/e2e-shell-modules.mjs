#!/usr/bin/env node
// Teste ponta a ponta dos módulos Documentação, MCP & IA e Configurações no app real
// (build de produção em out/): a navegação por intenção tem os três; a Documentação gera o
// projeto, um conector e um endpoint sem o menu de contexto; o MCP & IA liga o servidor e monta a
// configuração de cada cliente com o endereço real; as Configurações renomeiam o perfil local,
// expandem a sidebar e mostram os serviços locais.
// Uso: npm run build && node scripts/e2e-shell-modules.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-shell-ws-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/billing.connector.vvpost.json', {
  id: 'connector.billing',
  name: 'Billing',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}' },
  endpoints: [{ id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges' }]
})
put('environments/dev.env.json', { id: 'env.dev', name: 'Dev', variables: { BASE_URL: { type: 'string', value: 'http://localhost' } } })

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
  const nav = win.getByRole('navigation', { name: 'Módulos' })
  await nav.waitFor()
  // Navegação por intenção: Documentação em Projeto; MCP & IA e Configurações em Integrações.
  await nav.getByRole('group', { name: 'Projeto' }).getByRole('button', { name: 'Documentação' }).waitFor()
  await nav.getByRole('group', { name: 'Integrações' }).getByRole('button', { name: 'MCP & IA' }).waitFor()
  await nav.getByRole('group', { name: 'Integrações' }).getByRole('button', { name: 'Configurações' }).waitFor()
  const panel = win.locator('main > div:not([hidden])')

  // Documentação: projeto, conector e endpoint pelo seletor de escopo.
  await nav.getByRole('button', { name: 'Documentação' }).click()
  const doc = panel.getByRole('region', { name: 'Documentação gerada' })
  const title = doc.locator('header h2')
  await title.filter({ hasText: /vvpost-shell-ws/ }).waitFor()
  assert.equal(await doc.getByRole('button', { name: 'Fechar a documentação' }).count(), 0)
  await panel.getByLabel('Conector da documentação').selectOption('connector.billing')
  await title.filter({ hasText: /Billing/ }).waitFor()
  await panel.getByLabel('Endpoint da documentação').selectOption('charge')
  await title.filter({ hasText: /Cobrar/ }).waitFor()

  // MCP & IA: liga o servidor, e a configuração de cada cliente usa o endereço dele.
  await nav.getByRole('button', { name: 'MCP & IA' }).click()
  const server = panel.getByRole('region', { name: 'Servidor MCP' })
  await server.getByRole('button', { name: 'Ligar o servidor' }).click()
  await server.getByText('Ligado', { exact: true }).waitFor()
  const state = await win.evaluate(() => window.vvpost.getMcpServer())
  assert.equal(state.status, 'running')
  const config = panel.getByLabel('Configuração do Claude Code')
  assert.equal(await config.textContent(), `claude mcp add --transport http vvpost ${state.url}/mcp`)
  await panel.getByRole('tab', { name: 'Cursor' }).click()
  assert.deepEqual(JSON.parse(await panel.getByLabel('Configuração do Cursor').textContent()), {
    mcpServers: { vvpost: { url: `${state.url}/mcp` } }
  })
  await panel.getByRole('tab', { name: 'GitHub Copilot (VS Code)' }).click()
  assert.equal(JSON.parse(await panel.getByLabel('Configuração do GitHub Copilot (VS Code)').textContent()).servers.vvpost.type, 'http')
  // Ligar um repositório de código: o servidor do app no Cursor e a regra no AGENTS.md, num clique.
  const codeRepo = mkdtempSync(join(tmpdir(), 'vvpost-shell-repo-'))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, codeRepo)
  const connect = panel.getByRole('region', { name: 'Ligar um repositório de código' })
  await connect.getByLabel('Claude Code').uncheck()
  await connect.getByLabel('Cursor').check()
  await connect.getByRole('button', { name: 'Escolher repositório e ligar' }).click()
  await connect.getByRole('list', { name: 'Repositório ligado' }).getByText('ligado ao VVPost', { exact: false }).waitFor()
  assert.deepEqual(JSON.parse(readFileSync(join(codeRepo, '.cursor/mcp.json'), 'utf8')).mcpServers.vvpost, { url: `${state.url}/mcp` })
  assert.match(readFileSync(join(codeRepo, 'AGENTS.md'), 'utf8'), /<!-- vvpost:docs -->/)
  rmSync(codeRepo, { recursive: true, force: true })
  await panel.getByText('Nenhuma alteração da IA esperando revisão.', { exact: false }).waitFor()
  await panel.getByRole('table', { name: 'Ferramentas do servidor MCP' }).getByText('execute_flow').waitFor()
  await server.getByRole('button', { name: 'Desligar' }).click()
  await server.getByText('Desligado', { exact: true }).waitFor()

  // Configurações: perfil local, sidebar expandida e serviços locais.
  await nav.getByRole('button', { name: 'Configurações' }).click()
  const profile = panel.getByRole('region', { name: 'Conta e perfil' })
  await profile.getByLabel('Nome de exibição').fill('Ana Testadora')
  await profile.getByRole('button', { name: 'Salvar' }).click()
  for (let i = 0; i < 50 && (await win.evaluate(() => window.vvpost.getIdentity())).profile.displayName !== 'Ana Testadora'; i++)
    await win.waitForTimeout(20)
  assert.equal((await win.evaluate(() => window.vvpost.getIdentity())).profile.displayName, 'Ana Testadora')
  assert.equal(await nav.getByText('Integrações', { exact: true }).count(), 0, 'a sidebar começa recolhida')
  await panel.getByRole('region', { name: 'Interface' }).getByLabel('Expandida, com os rótulos dos módulos').check()
  await nav.getByText('Integrações', { exact: true }).waitFor()
  const services = panel.getByRole('region', { name: 'Serviços locais' })
  await services.getByText('Servidor MCP').waitFor()
  await services.getByRole('button', { name: 'Abrir MCP & IA' }).click()
  await panel.getByRole('region', { name: 'Servidor MCP' }).waitFor()
  // A paleta abre os módulos sem atalho de dígito.
  await win.keyboard.press('Control+K')
  await win.keyboard.type('Abrir Configurações')
  await win.keyboard.press('Enter')
  await panel.getByRole('region', { name: 'Atalhos dos módulos' }).waitFor()

  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E dos módulos Documentação, MCP & IA e Configurações: ok')
