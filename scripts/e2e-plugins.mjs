#!/usr/bin/env node
// Teste ponta a ponta do Plugin SDK no app real (build de produção em out/): o
// Extensions Hub lista os plugins oficiais, instala um plugin de uma pasta com prévia, e
// o Flow Studio roda um fluxo com o nó JavaScript, o adapter GraphQL (auth herdada do
// conector, sem o token passar pelo plugin) e o nó do plugin instalado. Também instala um
// plugin assinado de um .zip (feito pelo `vvpost plugin pack`) e a versão nova dele de um
// registro local. O mesmo adapter roda fora do Flow Studio: no Quick Request, escolhido como
// protocolo da aba, e num cenário de endpoint com plugin. Desligar um plugin deixa os nós
// dele indisponíveis.
// Uso: npm run build && node scripts/e2e-plugins.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
const API_TOKEN = 'token-secreto-e2e-plugins'

const seen = []
/** Arquivos do registro local: caminho → conteúdo. */
const registryFiles = new Map()
const server = createServer((req, res) => {
  if (registryFiles.has(req.url)) return res.end(registryFiles.get(req.url))
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body })
    const reply = (status, data) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (url.pathname === '/session') return reply(200, { userId: 41 })
    if (url.pathname !== '/api/graphql') return reply(404, { error: 'NOT_FOUND' })
    if (req.headers.authorization !== `Bearer ${API_TOKEN}`) return reply(401, { errors: [{ message: 'unauthorized' }] })
    const { variables } = JSON.parse(body)
    reply(200, { data: { user: { id: variables.id, name: 'Ana' } } })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (base, path, data) => {
  mkdirSync(dirname(join(base, path)), { recursive: true })
  writeFileSync(join(base, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}
put(workspace, 'connectors/api.connector.vvpost.json', {
  id: 'connector.api',
  name: 'API',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', basePath: '/api', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
  // Endpoint de plugin: chamado pelo adapter GraphQL no Quick Request e nos cenários.
  endpoints: [
    {
      id: 'user',
      name: 'Usuário por GraphQL',
      method: 'POST',
      path: '/graphql',
      plugin: { adapter: 'graphql', config: { url: '/graphql', query: 'query ($id: Int!) { user(id: $id) { id name } }', variables: { id: 7 } } },
      scenarios: [
        {
          id: 'ana',
          name: 'Usuário 8 é a Ana',
          overrides: { config: { variables: { id: 8 } } },
          assertions: [
            { target: 'status', operator: 'equals', expected: 200 },
            { target: 'body.data.user.id', operator: 'equals', expected: 8 },
            { target: 'body.data.user.name', operator: 'equals', expected: 'Ana' }
          ]
        }
      ]
    }
  ]
})
put(workspace, 'environments/dev.env.json', {
  id: 'env.dev',
  name: 'Desenvolvimento',
  variables: {
    BASE_URL: { type: 'string', value: origin },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put(workspace, '.vvpost/secrets.local.json', { 'env.dev': { API_TOKEN } })
put(workspace, 'flows/users.flow.vvpost.json', {
  id: 'flow.users',
  name: 'Usuários',
  nodes: [
    { id: 'session', name: 'Session', type: 'request', request: { method: 'GET', url: '{{BASE_URL}}/session' } },
    {
      id: 'next',
      name: 'NextId',
      type: 'plugin',
      plugin: { node: 'javascript.script', config: { code: "console.log('sessão', nodes.Session.data.userId)\nreturn { id: nodes.Session.data.userId + 1 }" } }
    },
    {
      id: 'user',
      name: 'User',
      type: 'plugin',
      plugin: {
        adapter: 'graphql',
        connector: 'connector.api',
        config: { url: '/graphql', query: 'query ($id: Int!) { user(id: $id) { id name } }', variables: { id: '{{ $nodes.NextId.data.id }}' } }
      }
    }
  ],
  edges: [
    { from: 'session', to: 'next' },
    { from: 'next', to: 'user' }
  ]
})

// Plugin de terceiro, instalado pelo Extensions Hub a partir desta pasta.
const pluginSrc = mkdtempSync(join(tmpdir(), 'vvpost-plugin-src-'))
put(pluginSrc, 'vvpost-plugin.json', {
  id: 'acme-greeter',
  name: 'Acme Greeter',
  version: '1.0.0',
  author: 'Acme',
  main: 'index.js',
  apiVersion: 1,
  contributes: {
    nodes: [{ type: 'acme.greet', title: 'Greet', fields: [{ key: 'name', label: 'Nome', type: 'text', required: true }] }]
  }
})
put(pluginSrc, 'index.js', "module.exports = { nodes: { 'acme.greet': { run: (ctx) => 'Olá, ' + ctx.config.name + '!' } } }")

// Plugin assinado: chave e pacotes feitos pelo CLI do build (out/main/cli.js).
const signedDir = mkdtempSync(join(tmpdir(), 'vvpost-plugin-signed-'))
const signedManifest = (version) => ({
  id: 'acme-signed',
  name: 'Acme Signed',
  version,
  author: 'Acme Labs',
  main: 'index.js',
  apiVersion: 1,
  permissions: { network: ['api.acme.dev'] },
  contributes: { nodes: [{ type: 'acme.signed', title: 'Signed' }] }
})
const cli = (...args) => execFileSync(process.execPath, [join(root, 'out/main/cli.js'), 'plugin', ...args], { cwd: signedDir, encoding: 'utf8' })
cli('keygen', '--out', 'acme.key')
mkdirSync(join(signedDir, 'src'))
put(signedDir, 'src/index.js', "module.exports = { nodes: { 'acme.signed': { run: () => 'assinado' } } }")
put(signedDir, 'src/vvpost-plugin.json', signedManifest('1.0.0'))
const packed = cli('pack', 'src', '--key', 'acme.key', '--out', 'acme-signed-1.0.0.zip')
const fingerprint = /Assinatura: ([0-9a-f:]+)/.exec(packed)[1]
const publicKey = JSON.parse(packed.slice(packed.indexOf('{'))).publicKey
put(signedDir, 'src/vvpost-plugin.json', signedManifest('1.1.0'))
cli('pack', 'src', '--key', 'acme.key', '--out', 'acme-signed-1.1.0.zip')
const zip110 = readFileSync(join(signedDir, 'acme-signed-1.1.0.zip'))
registryFiles.set('/registry/acme-signed-1.1.0.zip', zip110)
registryFiles.set(
  '/registry/vvpost-registry.json',
  JSON.stringify({
    version: 1,
    name: 'Acme Registry',
    plugins: [
      {
        id: 'acme-signed',
        name: 'Acme Signed',
        author: 'Acme Labs',
        publicKey,
        versions: [{ version: '1.1.0', url: 'acme-signed-1.1.0.zip', sha256: createHash('sha256').update(zip110).digest('hex') }]
      }
    ]
  })
)

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
let runMs
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ dialog }, answers) => {
    globalThis.__dialogAnswers = answers
    dialog.showOpenDialog = async () => globalThis.__dialogAnswers.shift() ?? { canceled: true, filePaths: [] }
  }, [
    { canceled: false, filePaths: [pluginSrc] },
    { canceled: false, filePaths: [join(signedDir, 'acme-signed-1.0.0.zip')] },
    { canceled: false, filePaths: [workspace] }
  ])
  await win.getByRole('button', { name: 'Quick Request' }).waitFor()

  // Extensions Hub: os dois oficiais, ligados e com o processo parado.
  await win.getByRole('button', { name: 'Extensions Hub' }).click()
  const hub = win.locator('main > div:not([hidden])')
  const js = hub.getByRole('article', { name: 'Plugin JavaScript' })
  const gql = hub.getByRole('article', { name: 'Plugin GraphQL' })
  await js.waitFor()
  assert.equal(await js.getByLabel('Estado de JavaScript').textContent(), 'processo parado')
  assert.equal(await gql.getByLabel('Ligar GraphQL').isChecked(), true)
  await gql.getByText('graphql', { exact: true }).waitFor()
  // Sem permissions.network: o plugin só manda requisições pelo host.
  assert.equal(await gql.getByLabel('Permissões de rede').textContent(), 'Rede: nenhuma própria (só requisições pelo VVPost)')
  await hub.getByRole('complementary', { name: 'Modelo de confiança' }).getByText('Instale só plugins em que você confia').waitFor()

  // Instalar de pasta: prévia com o que o plugin contribui, depois a cópia.
  await hub.getByRole('button', { name: 'Instalar de pasta…' }).click()
  const dialog = hub.getByRole('dialog', { name: 'Instalar plugin' })
  await dialog.getByText('Instalar Acme Greeter 1.0.0').waitFor()
  await dialog.getByText('acme.greet').waitFor()
  await dialog.getByRole('button', { name: 'Instalar' }).click()
  await hub.getByText('Acme Greeter 1.0.0 instalado.').waitFor()
  const acme = hub.getByRole('region', { name: 'Instalados' }).getByRole('article', { name: 'Plugin Acme Greeter' })
  await acme.waitFor()
  assert.ok(readFileSync(join(userData, 'plugins/acme-greeter/index.js'), 'utf8').includes('acme.greet'))
  await acme.getByLabel('Assinatura').getByText('sem assinatura').waitFor()

  // Instalar de arquivo: .zip assinado, chave ainda não confiável; marcar "Confiar nesta chave".
  await hub.getByRole('button', { name: 'Instalar de arquivo…' }).click()
  await dialog.getByText('Instalar Acme Signed 1.0.0').waitFor()
  assert.match(await dialog.getByLabel('Assinatura').textContent(), new RegExp(`ainda não marcou como confiável \\(${fingerprint}\\)`))
  assert.equal(await dialog.getByLabel('Permissões de rede').textContent(), 'Rede: api.acme.dev')
  await dialog.getByLabel(/Confiar nesta chave/).check()
  await dialog.getByRole('button', { name: 'Instalar' }).click()
  await hub.getByText('Acme Signed 1.0.0 instalado.').waitFor()
  const signed = hub.getByRole('region', { name: 'Instalados' }).getByRole('article', { name: 'Plugin Acme Signed' })
  assert.equal(await signed.getByLabel('Assinatura').textContent(), `Assinatura: assinado por Acme Labs (${fingerprint})`)
  await hub.getByRole('region', { name: 'Chaves confiáveis' }).getByText(fingerprint).waitFor()

  // Registro local: a versão 1.1.0, com a chave fixada pelo registro.
  await hub.getByLabel('URL do registro').fill(`${origin}/registry/vvpost-registry.json`)
  await hub.getByRole('button', { name: 'Adicionar registro' }).click()
  const registry = hub.getByRole('article', { name: 'Registro Acme Registry' })
  await registry.getByRole('button', { name: 'Atualizar para 1.1.0: Acme Signed' }).click()
  await dialog.getByText('Instalar Acme Signed 1.1.0').waitFor()
  await dialog.getByText('(substitui a versão 1.0.0)').waitFor()
  await dialog.getByLabel('Assinatura').getByText(/assinado por registro Acme Registry/).waitFor()
  await dialog.getByRole('button', { name: 'Instalar' }).click()
  await hub.getByText('Acme Signed 1.1.0 instalado.').waitFor()
  await registry.getByRole('button', { name: 'Instalado: Acme Signed' }).waitFor()
  assert.equal(JSON.parse(readFileSync(join(userData, 'plugins/acme-signed/.vvpost-install.json'), 'utf8')).origin.kind, 'registry')

  // Flow Studio: sessão (requisição) → JavaScript → GraphQL pelo conector.
  await win.getByRole('button', { name: 'Flow Studio' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Abrir workspace…' }).click()
  await panel.getByTestId('flow-node-User').waitFor()
  await panel.getByTestId('flow-node-NextId').getByText('JavaScript', { exact: true }).waitFor()
  await panel.getByTestId('flow-node-User').getByText('GraphQL', { exact: true }).waitFor()
  await panel.locator('select[aria-label="Ambiente do fluxo"]').selectOption('env.dev')

  const start = performance.now()
  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  const summary = panel.getByRole('status', { name: 'Resumo da execução' })
  await summary.getByText('Fluxo ok: 3 ok, 0 com erro, 0 pulados').waitFor()
  runMs = Math.round(performance.now() - start)
  const call = seen.find((s) => s.path === '/api/graphql')
  assert.equal(call.auth, `Bearer ${API_TOKEN}`)
  assert.deepEqual(JSON.parse(call.body).variables, { id: 42 })

  await panel.getByTestId('flow-node-NextId').click()
  const result = panel.getByRole('region', { name: 'Resultado do nó' })
  await result.getByText('sessão 41').waitFor()
  await panel.getByTestId('flow-node-User').click()
  assert.match(await result.getByLabel('Saída do nó').textContent(), /"name": "Ana"/)

  // Nó do plugin instalado, com o campo do manifesto preenchido pelo Visual Data Picker.
  await panel.locator('select[aria-label="Adicionar nó de plugin"]').selectOption({ label: 'Greet (Acme Greeter)' })
  await panel.getByTestId('flow-node-Greet1').waitFor()
  const name = panel.getByLabel('Nome', { exact: true })
  await name.focus()
  const picker = panel.getByRole('region', { name: 'Visual Data Picker' })
  await name.fill('{{ $nodes.User.data.data.user.name }}')
  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  await summary.getByText('Fluxo ok: 4 ok, 0 com erro, 0 pulados').waitFor()
  await panel.getByTestId('flow-node-Greet1').click()
  assert.match(await result.getByLabel('Saída do nó').textContent(), /"data": "Olá, Ana!"/)
  if (process.env.E2E_SCREENSHOT_FLOW) await win.screenshot({ path: process.env.E2E_SCREENSHOT_FLOW })

  // Nó JavaScript novo: o picker escreve a referência em JavaScript (nodes.X), não {{ }}.
  await panel.locator('select[aria-label="Adicionar nó de plugin"]').selectOption({ label: 'JavaScript (JavaScript)' })
  await panel.getByTestId('flow-node-JavaScript1').waitFor()
  const code = panel.getByLabel('Script JavaScript')
  await code.fill('return ')
  await code.focus()
  await code.press('End')
  await picker.getByRole('button', { name: 'Inserir $nodes.Greet1.data' }).click()
  assert.equal(await code.inputValue(), 'return nodes.Greet1.data')

  await panel.getByRole('button', { name: 'Salvar' }).click()
  await panel.getByText('Salvo em flows/users.flow.vvpost.json').waitFor()
  const saved = JSON.parse(readFileSync(join(workspace, 'flows/users.flow.vvpost.json'), 'utf8'))
  assert.deepEqual(saved.nodes.find((n) => n.name === 'Greet1').plugin, {
    node: 'acme.greet',
    config: { name: '{{ $nodes.User.data.data.user.name }}' }
  })
  assert.deepEqual(saved.nodes.find((n) => n.name === 'JavaScript1').plugin, { node: 'javascript.script', config: { code: 'return nodes.Greet1.data' } })

  // Quick Request: o endpoint de plugin troca a aba para o protocolo GraphQL, com os campos do adapter.
  await win.getByRole('button', { name: 'Quick Request' }).click()
  const quick = win.locator('main > div:not([hidden])')
  await quick.locator('select[aria-label="Conector"]').selectOption('connector.api')
  await quick.locator('select[aria-label="Ambiente"]').selectOption('env.dev')
  await quick.locator('select[aria-label="Endpoint"]').selectOption('user')
  assert.equal(await quick.locator('select[aria-label="Protocolo"]:visible').inputValue(), 'graphql')
  const fields = quick.getByRole('group', { name: 'Campos de GraphQL' })
  await fields.waitFor()
  const variables = fields.getByLabel('Variáveis')
  assert.match(await variables.inputValue(), /"id": 7/)
  await variables.fill('{ "id": 9 }')
  seen.length = 0
  await quick.getByRole('button', { name: 'Enviar' }).click()
  await quick.getByText('pelo adapter graphql').waitFor()
  await quick.getByText('"Ana"').first().waitFor()
  if (process.env.E2E_SCREENSHOT_QUICK) await win.screenshot({ path: process.env.E2E_SCREENSHOT_QUICK })
  const qcall = seen.find((s) => s.path === '/api/graphql')
  assert.equal(qcall.auth, `Bearer ${API_TOKEN}`)
  assert.deepEqual(JSON.parse(qcall.body).variables, { id: 9 })
  // De volta ao HTTP: método e URL voltam a aparecer.
  await quick.locator('select[aria-label="Protocolo"]:visible').selectOption('')
  await quick.locator('input[aria-label="URL"]:visible').waitFor()

  // Cenários: o endpoint de plugin roda pelo adapter, com overrides.config, e as asserções leem o data.
  await win.getByRole('button', { name: 'Cenários de teste' }).click()
  const scenarios = win.locator('main > div:not([hidden])')
  await scenarios.locator('select[aria-label="Conector"]').selectOption('connector.api')
  await scenarios.getByText('Usuário 8 é a Ana').first().waitFor()
  const envs = scenarios.getByRole('group', { name: 'Ambientes da matriz' })
  await envs.getByLabel('Sem ambiente').uncheck()
  await envs.getByLabel('Desenvolvimento').check()
  seen.length = 0
  await scenarios.getByRole('button', { name: 'Rodar 1 cenário' }).click()
  await scenarios.getByText('1 passaram').waitFor()
  assert.deepEqual(JSON.parse(seen.find((s) => s.path === '/api/graphql').body).variables, { id: 8 })

  // Processos ativos depois da execução; desligar o JavaScript deixa o nó indisponível.
  await win.getByRole('button', { name: 'Extensions Hub' }).click()
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await js.getByText('processo ativo').waitFor()
  await js.getByLabel('Ligar JavaScript').click()
  await js.getByText('desligado').waitFor()
  await win.getByRole('button', { name: 'Flow Studio' }).click()
  await panel.getByRole('button', { name: 'Rodar fluxo' }).click()
  await summary.getByText('Fluxo com erro: 1 ok, 1 com erro, 3 pulados').waitFor()
  await panel.getByTestId('flow-node-NextId').getByText(/desligado no Extensions Hub/).waitFor()
  await panel.getByTestId('flow-node-NextId').getByText('Plugin indisponível').waitFor()

  const html = await win.content()
  assert.ok(!html.includes(API_TOKEN), 'o token do ambiente chegou ao renderer')
  if (screenshot) {
    await win.getByRole('button', { name: 'Extensions Hub' }).click()
    await js.getByLabel('Ligar JavaScript').click()
    await js.getByText('processo parado').waitFor()
    await win.screenshot({ path: screenshot })
  }
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  server.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
rmSync(pluginSrc, { recursive: true, force: true })
rmSync(signedDir, { recursive: true, force: true })
console.log(`E2E do Plugin SDK: ok (Extensions Hub, instalação de pasta, de .zip assinado e de registro, JavaScript + GraphQL + plugin instalado em ${runMs} ms, GraphQL no Quick Request e num cenário)`)
