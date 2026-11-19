#!/usr/bin/env node
// Teste ponta a ponta dos projetos do workspace (build de produção em out/): abrir a pasta de um
// projeto já o seleciona; o explorador mostra a herança, com a auth do Compartilhado (só leitura)
// em cima das duas APIs do projeto, e a requisição de cada uma faz o login uma vez só; a barra
// superior troca de projeto, cria um novo e volta ao Compartilhado; um projeto com conector no
// formato antigo mostra o "Converter para fluxos", que grava os fluxos depois da confirmação.
// Uso: npm run build && node scripts/e2e-projects.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

let logins = 0
const seen = []
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/oauth/token') {
    logins++
    return res.end(JSON.stringify({ access_token: 'tok-compartilhado', expires_in: 3600 }))
  }
  seen.push({ path: req.url, auth: req.headers.authorization ?? null })
  res.end(JSON.stringify({ path: req.url }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-projects-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), `${JSON.stringify(data, null, 2)}\n`)
}
const request = (id, extendsId, name, url) => ({
  id,
  name,
  extends: extendsId,
  nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url } }]
})
// A auth no Compartilhado; o projeto Cadastro tem duas APIs que herdam dela.
put('flows/auth.flow.vvpost.json', {
  id: 'auth',
  name: 'Auth corporativa',
  defaults: { headers: { Authorization: 'Bearer {{ $nodes.Login.data.access_token }}' } },
  nodes: [
    { id: 'login', name: 'Login', type: 'request', cache: { expiresIn: 'data.expires_in' }, request: { method: 'POST', url: `${origin}/oauth/token` } }
  ]
})
// Outra base do Compartilhado, com o token por OAuth2 (o nó `oauth2`), para a visão Base do Flow Studio.
put('flows/sso.flow.vvpost.json', {
  id: 'sso',
  name: 'SSO',
  nodes: [{ id: 'oauth2', name: 'OAuth2', type: 'oauth2', oauth2: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: `${origin}/sso/token`, clientId: 'app', clientSecret: '{{SSO_SECRET}}' } }]
})
// Uma base do Compartilhado que nenhum projeto herda: o explorador do projeto a esconde.
put('flows/cnpj.flow.vvpost.json', { id: 'cnpj', name: 'Consulta CNPJ', defaults: { baseUrl: 'https://cnpj.example' }, nodes: [] })
put('environments/dev.env.json', { id: 'dev', name: 'Dev', variables: { API_URL: { type: 'string', value: origin } } })
// Nome longo: o seletor da barra o mostra inteiro.
put('cadastro/vvpost.project.json', { id: 'cadastro', name: 'Cadastro de empresas e estoques' })
put('cadastro/flows/empresas/empresas.flow.vvpost.json', { id: 'empresas', name: 'API de empresas', extends: 'auth', defaults: { baseUrl: '{{API_URL}}/empresas' }, nodes: [] })
put('cadastro/flows/empresas/consultar.flow.vvpost.json', request('empresas.consultar', 'empresas', 'Consultar empresa', '/1'))
put('cadastro/flows/estoques/estoques.flow.vvpost.json', { id: 'estoques', name: 'API de estoques', extends: 'auth', defaults: { baseUrl: '{{API_URL}}/estoques' }, nodes: [] })
put('cadastro/flows/estoques/consultar.flow.vvpost.json', request('estoques.consultar', 'estoques', 'Consultar estoque', '/2'))
// Outro projeto ainda no formato antigo.
put('legado/vvpost.project.json', { id: 'legado', name: 'Legado' })
put('legado/connectors/pedidos.connector.vvpost.json', {
  id: 'pedidos',
  name: 'Pedidos',
  version: '1.0.0',
  extends: 'auth',
  config: { baseUrl: '{{API_URL}}/pedidos' },
  endpoints: [{ id: 'listar', name: 'Listar pedidos', method: 'GET', path: '/' }]
})

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_MCP_PORT: '0' }
})

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const palette = async (text) => {
    await win.keyboard.press('Control+k')
    await win.keyboard.type(text)
    await win.keyboard.press('Enter')
  }
  const project = win.getByRole('button', { name: 'Trocar de projeto' })
  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  const menu = win.getByRole('menu', { name: 'Projetos do workspace' })
  const bar = win.getByRole('tablist', { name: 'Abas do workspace' })
  const panel = win.locator('main > div:not([hidden])')
  const req = panel.locator('[role=tabpanel]:not([hidden])')

  // Abrir a pasta do projeto: o workspace é a raiz e o projeto já vem escolhido.
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] })
  }, join(workspace, 'cadastro'))
  await win.getByRole('navigation', { name: 'Módulos' }).waitFor()
  await palette('Trocar a pasta do workspace')
  await project.getByText('Cadastro').waitFor()
  await win.getByRole('button', { name: 'Trocar de pasta' }).getByText(/vvpost-projects-/).waitFor()
  const cut = await project.locator('span.truncate').evaluate((el) => el.scrollWidth > el.clientWidth)
  assert.equal(cut, false, 'o nome do projeto saiu cortado no seletor')

  // O explorador pela herança: a auth do Compartilhado em cima das duas APIs, cada uma com a sua requisição.
  await win.keyboard.press('Control+Shift+E')
  const auth = tree.getByRole('treeitem').filter({ hasText: 'Auth corporativa' })
  await auth.getByText('compartilhado').waitFor()
  assert.equal(await auth.getAttribute('aria-level'), '1')
  for (const api of ['API de empresas', 'API de estoques']) {
    const row = tree.getByRole('treeitem').filter({ hasText: api })
    assert.equal(await row.getAttribute('aria-level'), '2', `${api} não está debaixo da auth`)
    await row.getByRole('button', { name: 'Expandir' }).click()
  }
  // A base Consulta CNPJ do Compartilhado não é herdada por nada do projeto: fica atrás de um clique.
  assert.equal(await tree.getByRole('button', { name: 'Consulta CNPJ' }).count(), 0)
  const unused = tree.getByRole('button', { name: 'Mostrar 1 do Compartilhado sem uso aqui' })
  await unused.click()
  await tree.getByRole('button', { name: 'Consulta CNPJ' }).waitFor()
  await tree.getByRole('button', { name: 'Esconder 1 do Compartilhado sem uso aqui' }).click()
  await tree.getByRole('button', { name: 'Consulta CNPJ' }).waitFor({ state: 'detached' })
  // Os arquivos de fluxo que viraram conectores não se repetem na seção Fluxos.
  assert.equal(await tree.getByRole('button', { name: 'Consultar empresa' }).count(), 1)
  assert.equal(await win.getByRole('group', { name: 'Fluxos' }).getByRole('treeitem').count(), 0)
  // Sem conector no formato antigo, nada a converter.
  assert.equal(await win.getByRole('button', { name: 'Converter para fluxos' }).count(), 0)

  // As duas requisições abrem na visão Simples e levam o token do mesmo login.
  for (const name of ['Consultar empresa', 'Consultar estoque']) {
    await tree.getByRole('button', { name }).click()
    await bar.getByRole('tab', { name, exact: true }).waitFor()
    await req.getByRole('button', { name: 'Enviar' }).click()
    await req.getByText('200 OK').waitFor()
  }
  assert.deepEqual(seen, [
    { path: '/empresas/1', auth: 'Bearer tok-compartilhado' },
    { path: '/estoques/2', auth: 'Bearer tok-compartilhado' }
  ])
  assert.equal(logins, 1, 'o login da auth compartilhada rodou mais de uma vez')
  if (screenshot) await win.screenshot({ path: screenshot })

  // A documentação aberta acompanha o projeto: aberta no Cadastro, mostra as APIs dele.
  const modules = win.getByRole('navigation', { name: 'Módulos' })
  const viewer = win.getByRole('region', { name: 'Documentação gerada' })
  await modules.getByRole('button', { name: 'Documentação' }).click()
  await viewer.getByText('API de empresas').first().waitFor()

  // Trocar de projeto pela barra: o Legado ainda tem conector no formato antigo.
  await project.click()
  await menu.getByRole('menuitem', { name: /Compartilhado \(raiz\)/ }).waitFor()
  await menu.getByRole('menuitem', { name: /^Legado/ }).click()
  await project.getByText('Legado').waitFor()
  await tree.getByRole('button', { name: 'Pedidos' }).waitFor()
  await win.getByText('1 conector(es) no formato antigo', { exact: false }).waitFor()
  // Trocou de projeto com a documentação aberta: ela já é a do Legado, sem fechar e abrir de novo.
  await viewer.getByText('Pedidos').first().waitFor()
  assert.equal(await viewer.getByText('API de empresas').count(), 0, 'a documentação ficou com o projeto anterior')

  // Converter: a prévia diz o que muda; confirmado, o conector vira a base e a requisição.
  await win.getByRole('button', { name: 'Converter para fluxos' }).click()
  const confirm = win.getByRole('dialog', { name: 'Converter para fluxos' })
  await confirm.getByText(/1 conector\(es\) viram fluxos-base.*pedidos/).waitFor()
  await confirm.getByRole('button', { name: 'Converter', exact: true }).click()
  await win.getByText('1 conector(es) convertido(s) em fluxos.').waitFor()
  await win.getByRole('button', { name: 'Converter para fluxos' }).waitFor({ state: 'detached' })
  assert.ok(!existsSync(join(workspace, 'legado/connectors/pedidos.connector.vvpost.json')))
  const base = JSON.parse(readFileSync(join(workspace, 'legado/flows/pedidos/pedidos.flow.vvpost.json'), 'utf8'))
  assert.equal(base.extends, 'auth')
  assert.equal(JSON.parse(readFileSync(join(workspace, 'legado/flows/pedidos/listar.flow.vvpost.json'), 'utf8')).extends, 'pedidos')
  const pedidos = tree.getByRole('treeitem').filter({ hasText: 'Pedidos' })
  assert.equal(await pedidos.getAttribute('aria-level'), '2')

  // A base convertida abre no editor de conector e grava de volta no fluxo, sem criar conector.
  await tree.getByRole('button', { name: 'Pedidos' }).click()
  await panel.getByLabel('Nome *').fill('Pedidos online')
  // Numa janela de 768 px de altura (o runner Windows), os avisos da conversão cobrem o botão.
  const dismiss = win.getByRole('button', { name: 'Dispensar aviso' })
  while (await dismiss.count()) await dismiss.first().click()
  await panel.getByRole('button', { name: 'Salvar conector' }).click()
  await tree.getByRole('button', { name: 'Pedidos online' }).waitFor()
  assert.equal(JSON.parse(readFileSync(join(workspace, 'legado/flows/pedidos/pedidos.flow.vvpost.json'), 'utf8')).name, 'Pedidos online')
  assert.ok(!existsSync(join(workspace, 'legado/connectors/pedidos.connector.vvpost.json')))

  // Novo projeto pela barra: a subpasta com o manifesto, já aberta e vendo o Compartilhado.
  await project.click()
  await menu.getByRole('menuitem', { name: 'Novo projeto…' }).click()
  const ask = win.getByRole('dialog', { name: 'Novo projeto no workspace' })
  await ask.getByLabel('Nome do projeto').fill('Faturamento')
  await ask.getByRole('button', { name: 'Criar' }).click()
  await project.getByText('Faturamento').waitFor()
  assert.deepEqual(JSON.parse(readFileSync(join(workspace, 'faturamento/vvpost.project.json'), 'utf8')), {
    $schema: JSON.parse(readFileSync(join(workspace, 'faturamento/vvpost.project.json'), 'utf8')).$schema,
    id: 'faturamento',
    name: 'Faturamento'
  })
  // Projeto vazio: o Compartilhado inteiro está sem uso, a um clique.
  await tree.getByRole('button', { name: 'Mostrar 2 do Compartilhado sem uso aqui' }).click()
  await tree.getByRole('treeitem').filter({ hasText: 'Auth corporativa' }).getByText('compartilhado').waitFor()

  // Uma base de outro projeto no nó de um fluxo: o conector do nó oferece as do Cadastro, num
  // grupo do projeto, e o fluxo roda antes de gravado, com a cadeia dela e a auth do Compartilhado.
  await win.getByRole('button', { name: 'Flow Studio' }).click()
  await panel.getByRole('button', { name: 'Novo fluxo' }).last().click()
  await panel.getByLabel('Nome do novo fluxo').fill('Conferência')
  await panel.getByRole('button', { name: 'Criar' }).click()
  await panel.getByRole('button', { name: '+ Requisição' }).click()
  await panel.getByTestId('flow-node-Request1').waitFor()
  const pick = panel.getByLabel('Conector do nó')
  await pick.locator('optgroup[label="Projeto Cadastro de empresas e estoques"] > option', { hasText: 'API de empresas' }).waitFor({ state: 'attached' })
  await pick.selectOption('cadastro:empresas')
  await panel.getByLabel('Endpoint do nó').selectOption('consultar')
  await panel.locator('select[aria-label="Ambiente do fluxo"]').selectOption('dev')
  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  await panel.getByRole('status', { name: 'Resumo da execução' }).getByText('Fluxo ok: 1 ok, 0 com erro, 0 pulados').waitFor()
  assert.deepEqual(seen.at(-1), { path: '/empresas/1', auth: 'Bearer tok-compartilhado' })
  await panel.getByRole('button', { name: 'Salvar' }).click()
  const savedAt = (await panel.getByText(/^Salvo em flows\//).textContent()).replace('Salvo em ', '').trim()
  const node = JSON.parse(readFileSync(join(workspace, 'faturamento', savedAt), 'utf8')).nodes[0]
  assert.deepEqual([node.request.connector, node.request.endpoint], ['cadastro:empresas', 'consultar'])

  // De volta ao Compartilhado; a escolha fica lembrada para a próxima abertura.
  await project.click()
  await menu.getByRole('menuitem', { name: /Compartilhado \(raiz\)/ }).click()
  await project.getByText('Compartilhado').waitFor()
  await tree.getByRole('button', { name: 'Auth corporativa', exact: true }).waitFor()
  // Visão Base no Flow Studio: sem nó selecionado, a URL base; o nó OAuth2 se edita pelo formulário.
  await win.getByRole('button', { name: 'Flow Studio' }).click()
  await panel.locator('select[aria-label="Fluxo"]').selectOption('sso')
  const baseView = panel.getByRole('region', { name: 'Base do fluxo' })
  await baseView.getByLabel('URL base').fill('{{SSO_URL}}')
  await panel.getByTestId('flow-node-OAuth2').click()
  await panel.getByLabel('Scope').fill('leitura')
  await panel.getByRole('button', { name: 'Salvar' }).click()
  await panel.getByText('Salvo em flows/sso.flow.vvpost.json').waitFor()
  const sso = JSON.parse(readFileSync(join(workspace, 'flows/sso.flow.vvpost.json'), 'utf8'))
  assert.equal(sso.defaults.baseUrl, '{{SSO_URL}}')
  assert.equal(sso.nodes[0].oauth2.scope, 'leitura')
  assert.equal(sso.nodes[0].oauth2.clientSecret, '{{SSO_SECRET}}')

  const saved = JSON.parse(readFileSync(join(userData, 'workspace.json'), 'utf8'))
  assert.equal(saved.dir, workspace)
  assert.deepEqual(errors, [])
  console.log('E2E dos projetos do workspace: ok')
} finally {
  await app.close()
  server.close()
  for (const d of [userData, workspace]) rmSync(d, { recursive: true, force: true })
}
