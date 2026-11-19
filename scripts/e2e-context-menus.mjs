#!/usr/bin/env node
// Menus de contexto no app real (build de produção em out/): o componente compartilhado
// (botão direito, Shift+F10, atalhos, submenu), a Command Palette com as ações do módulo
// ativo e os menus de cada área (Quick Request, Params, resposta, Catálogo, Tests, Flow
// Studio, Secrets, Git, Extensions e campos de texto).
// Uso: npm run build && node scripts/e2e-context-menus.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const json = (v) => `${JSON.stringify(v, null, 2)}\n`

let hits = 0
const server = createServer((req, res) => {
  // Lenta de propósito: o Esc cancela antes da resposta.
  if (req.url === '/slow') return void setTimeout(() => res.end('{}'), 10_000)
  hits++
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ method: req.method, url: req.url, hit: hits }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// Workspace com dois conectores (pai e filho), um endpoint com cenário, um ambiente com
// segredo no vault local e um fluxo, num repositório Git com uma mudança pendente.
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-menus-ws-'))
const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' })
mkdirSync(join(workspace, 'connectors'))
mkdirSync(join(workspace, 'environments'))
mkdirSync(join(workspace, 'flows'))
mkdirSync(join(workspace, '.vvpost'))
writeFileSync(
  join(workspace, 'connectors/base.connector.vvpost.json'),
  json({ id: 'connector.base', name: 'Base', version: '1.0.0', config: { baseUrl: base }, endpoints: [] })
)
writeFileSync(
  join(workspace, 'connectors/users.connector.vvpost.json'),
  json({
    id: 'connector.users',
    name: 'Users',
    version: '1.0.0',
    extends: 'connector.base',
    endpoints: [
      {
        id: 'list',
        name: 'Listar usuários',
        method: 'GET',
        path: '/users',
        scenarios: [{ id: 'ok', name: 'Lista', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
      }
    ]
  })
)
writeFileSync(
  join(workspace, 'environments/dev.env.json'),
  json({
    id: 'env.dev',
    name: 'Development',
    variables: { API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
  })
)
writeFileSync(join(workspace, '.vvpost/secrets.local.json'), json({ 'env.dev': { API_TOKEN: 'tok-123' } }))
writeFileSync(join(workspace, '.gitignore'), '.vvpost/secrets.local.json\n')
writeFileSync(
  join(workspace, 'flows/demo.flow.vvpost.json'),
  json({
    id: 'flow.demo',
    name: 'Demo',
    nodes: [
      { id: 'a', type: 'request', name: 'primeiro', position: { x: 0, y: 0 }, request: { method: 'GET', url: `${base}/a` } },
      { id: 'b', type: 'request', name: 'segundo', position: { x: 300, y: 0 }, request: { method: 'GET', url: `${base}/b` } }
    ],
    edges: [{ from: 'a', to: 'b' }]
  })
)
mkdirSync(join(workspace, 'docs'))
writeFileSync(join(workspace, 'docs/guia.md'), '# Guia\n')
git('init', '-q', '-b', 'main')
git('-c', 'user.email=e2e@vvpost.dev', '-c', 'user.name=e2e', 'add', '.')
git('-c', 'user.email=e2e@vvpost.dev', '-c', 'user.name=e2e', 'commit', '-qm', 'inicial')
git('branch', 'feature/x')
writeFileSync(join(workspace, 'notas.txt'), 'rascunho\n')

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), json({ dir: workspace }))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
const clipboard = {
  read: () => app.evaluate(({ clipboard }) => clipboard.readText()),
  write: (text) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text),
  /** A cópia chega assíncrona: espera o texto passar no teste (até 3 s) e devolve o que houver. */
  async until(ok) {
    for (let i = 0; i < 30; i++) {
      const text = await clipboard.read()
      if (ok(text)) return text
      await new Promise((r) => setTimeout(r, 100))
    }
    return clipboard.read()
  }
}

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const panel = win.locator('main > div:not([hidden])')
  const visible = (selector) => panel.locator(`[role=tabpanel]:not([hidden]) ${selector}`)
  const menu = (name) => win.getByRole('menu', { name })
  const items = (name) => menu(name).getByRole('menuitem').allInnerTexts()
  /** Espera a contagem (as ações de menu terminam depois do clique: área de transferência, IPC). */
  const count = async (locator, n) => {
    for (let i = 0; i < 50 && (await locator.count()) !== n; i++) await win.waitForTimeout(100)
    assert.equal(await locator.count(), n)
  }
  const pick = async (menuName, item) => {
    await menu(menuName).getByRole('menuitem', { name: item, exact: typeof item === 'string' }).click()
    await menu(menuName).waitFor({ state: 'detached' })
  }

  // --- Quick Request: Params, abas, cURL, campo de texto e paleta --------------------------
  await visible('input[aria-label="URL"]').fill(`${base}/users?page=2&q=ana`)
  await panel.getByRole('tab', { name: /^Params/ }).click()
  await count(visible('input[aria-label="Nome do parâmetro"]'), 3)
  await visible('input[aria-label="Valor do parâmetro"]').first().fill('3')
  assert.equal(await visible('input[aria-label="URL"]').inputValue(), `${base}/users?page=3&q=ana`)

  // Botão direito num parâmetro (fora dos campos) e "Remover".
  const paramRow = visible('[aria-label="Parâmetros da query"] > div').nth(1)
  await paramRow.click({ button: 'right', position: { x: 2, y: 2 } })
  await pick('Parâmetro q', 'Remover')
  assert.equal(await visible('input[aria-label="URL"]').inputValue(), `${base}/users?page=3`)

  // Campo de texto: o menu de edição (o Electron não mostra o nativo) e, embaixo, as ações da requisição.
  await visible('input[aria-label="URL"]').click({ button: 'right' })
  const urlItems = await items('URL')
  for (const label of ['Desfazer', 'Recortar', 'Copiar', 'Colar', 'Selecionar tudo', 'Copiar como cURL']) {
    assert.ok(urlItems.some((t) => t.startsWith(label)), `menu da URL sem ${label}: ${urlItems}`)
  }
  await pick('URL', /^Selecionar tudo/)
  await win.keyboard.press('Control+c')
  assert.equal(await clipboard.until((t) => t === `${base}/users?page=3`), `${base}/users?page=3`)

  // Aba: duplicar, fechar as outras e reabrir com Ctrl+Shift+T. As requisições são abas da barra única do workspace.
  const tabs = win.getByRole('tablist', { name: 'Abas do workspace' }).locator('[role=tab][id^="ws-tab-src:quick-request:"]')
  await tabs.first().click({ button: 'right' })
  const tabItems = await items('Aba GET /users?page=3')
  assert.ok(tabItems.some((t) => t.startsWith('Fechar as outras')), tabItems.join(' | '))
  await pick('Aba GET /users?page=3', /^Duplicar em nova aba/)
  await count(tabs, 2)
  await tabs.first().click({ button: 'right' })
  await pick('Aba GET /users?page=3', /^Fechar as outras/)
  await count(tabs, 1)
  await win.keyboard.press('Control+Shift+t')
  await count(tabs, 2)

  // Ctrl+Shift+C na aba focada: cURL; "Copiar como código" é um submenu.
  await tabs.first().focus()
  await win.keyboard.press('Control+Shift+c')
  await win.waitForFunction(() => true)
  assert.equal(await clipboard.until((t) => t.startsWith('curl')), `curl '${base}/users?page=3'`)
  await win.keyboard.press('Shift+F10')
  await menu('Aba GET /users?page=3').getByRole('menuitem', { name: /^Copiar como código/ }).hover()
  await pick('Copiar como código', 'Python (requests)')
  assert.match(
    await clipboard.until((t) => t.includes('requests.request')),
    /requests\.request\("GET", "http:\/\/127\.0\.0\.1:\d+\/users\?page=3"\)/
  )

  // Colar cURL: método, header e corpo numa aba.
  await clipboard.write(`curl -X POST '${base}/users' -H 'X-Trace: 1' --data-raw '{"nome":"VV"}'`)
  await tabs.first().click({ button: 'right' })
  await pick('Aba GET /users?page=3', /^Colar cURL/)
  await count(tabs, 3)
  assert.equal(await visible('select[aria-label="Método HTTP"]').inputValue(), 'POST')

  // Command Palette: as ações da aba ativa entram com o grupo do módulo.
  await win.keyboard.press('Control+k')
  await win.getByRole('combobox', { name: 'Buscar comando' }).fill('fechar as outras')
  const option = win.getByRole('option', { name: /Fechar as outras.*Quick Request/ })
  await option.waitFor()
  await option.click()
  await count(tabs, 1)

  // Resposta: enviar duas vezes e comparar com a anterior.
  await visible('input[aria-label="URL"]').fill(`${base}/users`)
  await win.getByRole('button', { name: 'Enviar' }).click()
  await visible('section[aria-label="Resposta"]').getByText('200 OK').waitFor()
  await win.getByRole('button', { name: 'Enviar' }).click()
  await visible('section[aria-label="Resposta"]').getByText('"hit"').first().waitFor()
  await visible('section[aria-label="Resposta"] [role=tablist]').click({ button: 'right' })
  assert.ok((await items('Resposta')).some((t) => t.startsWith('Copiar os headers')))
  await pick('Resposta', /^Comparar com a resposta anterior/)
  const compare = win.getByRole('dialog', { name: 'Comparar respostas' })
  await compare.waitFor()
  await compare.getByText(/Anterior · 200/).waitFor()
  await win.keyboard.press('Escape')
  await compare.waitFor({ state: 'detached' })

  console.log('menus de contexto: Quick Request ok')

  // --- Flow Studio: nó, ligação, canvas e "Executar até aqui" ------------------------------
  await win.keyboard.press('Control+2')
  const node = (id) => panel.locator(`.react-flow__node[data-id="${id}"]`)
  await node('a').waitFor()
  const before = hits
  await node('a').click({ button: 'right' })
  assert.ok((await items('Nó primeiro')).some((t) => t.startsWith('Copiar referência $nodes.primeiro')))
  await pick('Nó primeiro', 'Executar até aqui')
  await panel.getByText('Executado até primeiro: 1 de 2 nós.').waitFor()
  assert.equal(hits - before, 1)

  await node('a').click({ button: 'right' })
  await pick('Nó primeiro', 'Duplicar')
  await count(panel.locator('.react-flow__node'), 3)

  // Ligação: excluir pelo menu.
  // As ligações só aparecem depois que o React Flow mede os nós (lento com a máquina carregada).
  await panel.locator('.react-flow__edge').first().waitFor({ state: 'attached', timeout: 90_000 })
  await panel.locator('.react-flow__edge').first().click({ button: 'right', force: true })
  await pick('Ligação', 'Excluir a ligação')
  await count(panel.locator('.react-flow__edge'), 0)

  // Canvas: "Adicionar nó aqui" é um submenu; depois salvar pelo mesmo menu.
  const pane = panel.locator('.react-flow__pane')
  await pane.click({ button: 'right', position: { x: 40, y: 40 } })
  await menu('Canvas do fluxo').getByRole('menuitem', { name: 'Adicionar nó aqui' }).hover()
  await pick('Adicionar nó aqui', 'Python')
  await count(panel.locator('.react-flow__node'), 4)
  // (o nó novo ficou no ponto do primeiro clique)
  await pane.click({ button: 'right', position: { x: 40, y: 260 } })
  await pick('Canvas do fluxo', 'Salvar')
  await panel.getByText(/Salvo em /).waitFor()
  const saved = JSON.parse(readFileSync(join(workspace, 'flows/demo.flow.vvpost.json'), 'utf8'))
  assert.equal(saved.nodes.length, 4)
  assert.equal(saved.edges?.length ?? 0, 0)
  console.log('menus de contexto: Flow Studio ok')

  // --- Catálogo: duplicar o conector e abrir os cenários em Tests ---------------------------
  await win.keyboard.press('Control+3')
  const tree = panel.getByRole('navigation', { name: 'Hierarquia de conectores' })
  // O filho aparece com o traço da hierarquia e a contagem de endpoints: "└ Users 1".
  const users = tree.getByRole('button', { name: /(^|\s)Users \d+$/ })
  await users.waitFor()
  await users.click({ button: 'right' })
  const connectorItems = await items('Conector Users')
  for (const label of ['Editar', 'Abrir no Quick Request', 'Abrir os cenários em Tests', 'Duplicar', 'Renomear…', 'Excluir…']) {
    assert.ok(connectorItems.some((t) => t.startsWith(label)), `menu do conector sem ${label}: ${connectorItems}`)
  }
  await pick('Conector Users', /^Duplicar/)
  await tree.getByRole('button', { name: /Users \(cópia\)/ }).waitFor()
  assert.ok(existsSync(join(workspace, 'connectors')))
  await users.click({ button: 'right' })
  await pick('Conector Users', /^Abrir os cenários em Tests/)
  console.log('menus de contexto: Catálogo ok')

  // --- Tests: executar o cenário pelo menu e copiar o corpo da célula -----------------------
  const matrix = panel.getByRole('table', { name: 'Matriz de cenários' })
  const scenarioRow = matrix.locator('tr', { hasText: 'Lista' }).last()
  await scenarioRow.waitFor()
  await scenarioRow.locator('td').first().click({ button: 'right' })
  await pick('Cenário Lista', /^Executar/)
  const cell = scenarioRow.getByRole('button', { name: /^Lista em / })
  await cell.getByText('200').waitFor()
  await cell.click({ button: 'right' })
  const cellMenu = win.getByRole('menu', { name: /^Lista em / })
  await cellMenu.getByRole('menuitem', { name: /^Copiar o corpo da resposta/ }).click()
  await cellMenu.waitFor({ state: 'detached' })
  // O curl copiado antes também tem /users: espera o corpo, não só o caminho.
  for (let i = 0; i < 30 && !(await clipboard.read()).includes('"url":"/users"'); i++) await win.waitForTimeout(100)
  assert.match(await clipboard.read(), /"url":"\/users"/)
  console.log('menus de contexto: Tests ok')

  // --- Secrets: referência, copiar e revelar com confirmação --------------------------------
  await win.keyboard.press('Control+4')
  const secretRow = panel.getByRole('table', { name: 'Segredos de Development' }).locator('tr', { hasText: 'API_TOKEN' })
  await secretRow.waitFor()
  await secretRow.click({ button: 'right' })
  await pick('Segredo API_TOKEN', 'Copiar a referência {{API_TOKEN}}')
  for (let i = 0; i < 30 && (await clipboard.read()) !== '{{API_TOKEN}}'; i++) await win.waitForTimeout(100)
  assert.equal(await clipboard.read(), '{{API_TOKEN}}')
  await secretRow.click({ button: 'right' })
  await pick('Segredo API_TOKEN', 'Copiar valor…')
  const confirmCopy = win.getByRole('dialog', { name: 'Copiar o valor de API_TOKEN?' })
  await confirmCopy.getByRole('button', { name: 'Copiar' }).click()
  await win.getByText('API_TOKEN copiado; a área de transferência é limpa em 30 s.').waitFor()
  assert.equal(await clipboard.until((t) => t === 'tok-123'), 'tok-123')
  // Copiar não passa o valor pela tela.
  assert.ok(!(await win.content()).includes('tok-123'))
  await secretRow.click({ button: 'right' })
  await pick('Segredo API_TOKEN', 'Revelar valor…')
  await win.getByRole('dialog', { name: 'Revelar API_TOKEN?' }).getByRole('button', { name: 'Revelar' }).click()
  const shown = panel.getByLabel('Valor de API_TOKEN')
  assert.equal(await shown.innerText(), 'tok-123')
  await panel.getByRole('button', { name: 'Ocultar agora' }).click()
  await shown.waitFor({ state: 'detached' })
  assert.ok(!(await win.content()).includes('tok-123'))
  console.log('menus de contexto: Secrets ok')

  // --- Git: descartar um arquivo novo e copiar o nome de uma branch -------------------------
  await win.keyboard.press('Control+6')
  const changes = panel.getByRole('list', { name: 'Mudanças' })
  const notes = changes.locator('li', { hasText: 'notas.txt' })
  await notes.waitFor()
  await notes.click({ button: 'right' })
  const fileItems = await items('Arquivo notas.txt')
  for (const label of ['Ver o diff', 'Tirar do commit', 'Copiar o caminho', 'Revelar no explorador', 'Descartar as mudanças…']) {
    assert.ok(fileItems.some((t) => t.startsWith(label)), `menu do arquivo sem ${label}: ${fileItems}`)
  }
  await pick('Arquivo notas.txt', /^Descartar as mudanças/)
  await win.getByRole('dialog', { name: 'Descartar as mudanças em notas.txt?' }).getByRole('button', { name: 'Descartar' }).click()
  await notes.waitFor({ state: 'detached' })
  assert.ok(!existsSync(join(workspace, 'notas.txt')))
  // O fluxo salvo continua lá: Abrir no Flow Studio está no menu dele.
  await changes.locator('li', { hasText: 'demo.flow.vvpost.json' }).click({ button: 'right' })
  assert.ok((await items('Arquivo flows/demo.flow.vvpost.json')).some((t) => t.startsWith('Abrir no Flow Studio')))
  await win.keyboard.press('Escape')
  await panel.getByText(/^Branches \(/).click()
  await panel.getByRole('list', { name: 'Ramificações do repositório' }).getByRole('button', { name: /feature\/x/ }).click({ button: 'right' })
  await pick('Branch feature/x', /^Copiar o nome/)
  for (let i = 0; i < 30 && (await clipboard.read()) !== 'feature/x'; i++) await win.waitForTimeout(100)
  assert.equal(await clipboard.read(), 'feature/x')
  console.log('menus de contexto: Git ok')

  // --- Extensions: menu do plugin -----------------------------------------------------------
  await win.keyboard.press('Control+7')
  const plugin = panel.getByRole('article').first()
  await plugin.waitFor()
  const pluginName = await plugin.getAttribute('aria-label')
  await plugin.locator('h3').click({ button: 'right' })
  const pluginItems = await items(pluginName)
  assert.ok(pluginItems.some((t) => t.startsWith('Revelar a pasta')), pluginItems.join(' | '))
  await pick(pluginName, /^Copiar o id/)
  await panel.getByText('Id copiado na área de transferência.').waitFor()
  console.log('menus de contexto: Extensions ok')

  // --- Histórico: copiar uma execução como cURL ---------------------------------------------
  await win.keyboard.press('Control+9')
  const run = panel.getByRole('table', { name: 'Execuções' }).locator('tbody tr').first()
  await run.waitFor()
  await run.click({ button: 'right' })
  const runMenu = win.getByRole('menu', { name: /^Execução / })
  await runMenu.getByRole('menuitem', { name: /^Copiar como cURL/ }).click()
  for (let i = 0; i < 30 && !(await clipboard.read()).startsWith('curl'); i++) await win.waitForTimeout(100)
  assert.match(await clipboard.read(), /^curl /)
  console.log('menus de contexto: Histórico ok')

  // --- Explorador: botão direito nas linhas (documento, conector, ambiente) --------------------
  const explorer = win.getByRole('tree', { name: 'Arquivos do projeto' })
  if (!(await explorer.isVisible())) await win.keyboard.press('Control+Shift+E')
  const doc = explorer.getByRole('treeitem').filter({ hasText: 'guia.md' })
  await doc.waitFor()
  await doc.click({ button: 'right' })
  assert.deepEqual(
    (await items('Documento docs/guia.md')).map((t) => t.split('\n')[0]),
    ['Abrir', 'Renomear…', 'Copiar o caminho', 'Revelar o arquivo', 'Excluir…']
  )
  await pick('Documento docs/guia.md', /^Copiar o caminho/)
  assert.equal(await clipboard.until((t) => t === 'docs/guia.md'), 'docs/guia.md')
  const usersRow = explorer.getByRole('treeitem').filter({ hasText: /^Users/ }).first()
  await usersRow.click({ button: 'right' })
  const usersItems = await items('Conector Users')
  for (const label of ['Abrir no Catálogo', 'Copiar o id', 'Revelar o arquivo', 'Excluir…']) {
    assert.ok(usersItems.some((t) => t.startsWith(label)), `menu do conector sem ${label}: ${usersItems}`)
  }
  await win.keyboard.press('Escape')
  await menu('Conector Users').waitFor({ state: 'detached' })
  // Pelo teclado: Shift+F10 na linha focada.
  const envRow = explorer.getByRole('treeitem').filter({ hasText: 'Development' })
  await envRow.getByRole('button').last().focus()
  await win.keyboard.press('Shift+F10')
  await pick('Ambiente Development', /^Copiar o id/)
  assert.equal(await clipboard.until((t) => t === 'env.dev'), 'env.dev')
  // Cabeçalho da seção: Novo documento, depois renomear e excluir pelo menu da linha.
  const waitFile = async (rel, exists) => {
    for (let i = 0; i < 50 && existsSync(join(workspace, rel)) !== exists; i++) await win.waitForTimeout(100)
    assert.equal(existsSync(join(workspace, rel)), exists, `${rel} ${exists ? 'não foi criado' : 'continua lá'}`)
  }
  await win.getByRole('group', { name: 'Documentos' }).getByRole('button', { name: /^Documentos/ }).click({ button: 'right' })
  const headerItems = await items('Documentos')
  for (const label of ['Novo documento', 'Revelar a pasta docs/', 'Recolher a seção', 'Recarregar']) {
    assert.ok(headerItems.some((t) => t.startsWith(label)), `menu da seção Documentos sem ${label}: ${headerItems}`)
  }
  await pick('Documentos', /^Novo documento/)
  const newDoc = win.getByRole('dialog', { name: 'Novo' })
  await newDoc.getByRole('textbox').fill('Notas E2E')
  await newDoc.getByRole('textbox').press('Enter')
  await waitFile('docs/notas-e2e.md', true)
  const notesRow = explorer.getByRole('treeitem').filter({ hasText: 'notas-e2e.md' })
  await notesRow.waitFor()
  await notesRow.click({ button: 'right' })
  await pick('Documento docs/notas-e2e.md', /^Renomear/)
  const renameDialog = win.getByRole('dialog', { name: 'Renomear' })
  await renameDialog.getByRole('textbox').fill('docs/notas-renomeadas.md')
  await renameDialog.getByRole('textbox').press('Enter')
  await waitFile('docs/notas-renomeadas.md', true)
  await waitFile('docs/notas-e2e.md', false)
  const renamedRow = explorer.getByRole('treeitem').filter({ hasText: 'notas-renomeadas.md' })
  await renamedRow.waitFor()
  await renamedRow.click({ button: 'right' })
  await pick('Documento docs/notas-renomeadas.md', /^Excluir/)
  await win.getByRole('dialog', { name: 'Excluir notas-renomeadas.md?' }).getByRole('button', { name: 'Excluir' }).click()
  await waitFile('docs/notas-renomeadas.md', false)
  await renamedRow.waitFor({ state: 'detached' })
  // Os outros cabeçalhos também têm menu.
  await win.getByRole('group', { name: 'Conectores' }).getByRole('button', { name: /^Conectores/ }).click({ button: 'right' })
  const connectorsHeader = await items('Conectores')
  for (const label of ['Novo fluxo-base (conector)', 'Expandir tudo', 'Recolher tudo']) {
    assert.ok(connectorsHeader.some((t) => t.startsWith(label)), `menu da seção Conectores sem ${label}: ${connectorsHeader}`)
  }
  await win.keyboard.press('Escape')
  await menu('Conectores').waitFor({ state: 'detached' })
  console.log('menus de contexto: Explorador ok')

  // --- Atalhos globais: Ctrl+Shift+F, Ctrl+N, Ctrl+L, sinônimos e Esc ------------------------
  await win.keyboard.press('Control+Shift+F')
  const search = win.getByRole('dialog', { name: 'Procurar no projeto' })
  await search.getByRole('combobox').fill('listar usuarios')
  await search.getByRole('option', { name: /Listar usuários · Users/ }).first().waitFor()
  await win.keyboard.press('Enter')
  await search.waitFor({ state: 'detached' })
  await tree.waitFor()

  await win.keyboard.press('Control+n')
  const quickTabs = win.getByRole('tablist', { name: 'Abas do workspace' }).locator('[role=tab][id^="ws-tab-src:quick-request:"]')
  await quickTabs.first().waitFor()
  await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'URL')
  await win.keyboard.type(`${base}/slow`)

  await win.keyboard.press('Control+k')
  await win.getByRole('combobox', { name: 'Buscar comando' }).fill('testar endpoint')
  await win.getByRole('option', { name: /^Enviar.*Quick Request/ }).waitFor()
  await win.keyboard.press('Escape')

  await win.keyboard.press('Control+l')
  await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'URL')
  await win.keyboard.press('Control+Enter')
  await panel.getByRole('button', { name: 'Cancelar' }).waitFor()
  await win.keyboard.press('Escape')
  await panel.getByRole('button', { name: 'Cancelar' }).waitFor({ state: 'detached', timeout: 4000 })
  console.log('menus de contexto: atalhos globais ok')
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
}
