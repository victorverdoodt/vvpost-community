#!/usr/bin/env node
// Teste ponta a ponta do servidor MCP no build de produção (out/main/mcp.js), como
// um cliente de IA o usaria: inicia o processo por stdio (em Node e no próprio
// Electron com ELECTRON_RUN_AS_NODE=1), conversa em JSON-RPC, roda os cenários de
// um conector contra uma API que devolve tudo o que recebe e confere que nenhuma
// credencial sai no stdout. Depois sobe o transporte HTTP e repete por /mcp, e por
// fim liga o servidor pelo toggle da barra de status do app e repete por ele.
// Uso: npm run build && node scripts/e2e-mcp.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const mcpJs = join(root, 'out/main/mcp.js')
const json = (v) => `${JSON.stringify(v, null, 2)}\n`

// Gerados a cada execução: nenhum valor com cara de credencial fica commitado.
const fake = (prefix) => `${prefix}${randomBytes(6).toString('hex')}`
const API_TOKEN = fake('e2e-tok-')
const CLIENT_SECRET = fake('e2e-cs-')
const ACCESS_TOKEN = fake('e2e-at-')
const BEARER = fake('b-')
const SECRETS = [API_TOKEN, CLIENT_SECRET, ACCESS_TOKEN, Buffer.from(`app:${CLIENT_SECRET}`).toString('base64')]

// API que reflete headers, query e corpo, e emite tokens OAuth2.
const api = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  res.setHeader('content-type', 'application/json')
  if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 600 }))
  res.end(JSON.stringify({ url: req.url, headers: req.headers, body }))
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${api.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-mcp-ws-'))
const write = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), json(data))
}
write('connectors/base.connector.vvpost.json', {
  id: 'corp.base',
  name: 'Base',
  version: '1.0.0',
  config: {
    baseUrl: '{{BASE_URL}}',
    headers: { 'X-Api-Token': '{{API_TOKEN}}' },
    auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: '/oauth/token', clientId: 'app', clientSecret: '{{CLIENT_SECRET}}' }
  }
})
write('connectors/billing.connector.vvpost.json', {
  id: 'billing',
  name: 'Billing',
  version: '2.0.0',
  extends: 'corp.base',
  config: { basePath: '/billing' },
  endpoints: [
    {
      id: 'charge',
      name: 'Cobrar',
      method: 'POST',
      path: '/charges',
      body: { amount: 10 },
      scenarios: [
        { id: 'ok', name: 'Sucesso', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] },
        { id: 'echo', name: 'Eco do token', assertions: [{ target: 'body.headers.authorization', operator: 'exists' }] }
      ]
    }
  ]
})
write('environments/dev.env.json', {
  id: 'dev',
  name: 'Dev',
  variables: {
    BASE_URL: { type: 'string', value: origin },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
    CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
write('.vvpost/secrets.local.json', { dev: { API_TOKEN, CLIENT_SECRET } })

function assertNoLeak(text, where) {
  for (const s of SECRETS) {
    for (const form of [s, encodeURIComponent(s), Buffer.from(s).toString('base64').replace(/=+$/, '')]) {
      assert.ok(!text.includes(form), `${where}: vazou ${s}`)
    }
  }
}

/** Cliente stdio mínimo: uma linha por mensagem, respostas casadas pelo id. */
function stdioClient(command, args, env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  const waiting = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    out += chunk
    let i
    while ((i = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, i)
      out = out.slice(i + 1)
      assertNoLeak(line, 'stdout')
      const msg = JSON.parse(line)
      waiting.get(msg.id)?.(msg)
      waiting.delete(msg.id)
    }
  })
  child.stderr.on('data', (c) => (err += c))
  let id = 0
  return {
    request(method, params) {
      const msgId = ++id
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msgId, method, ...(params && { params }) })}\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`sem resposta para ${method}; stderr: ${err}`)), 15_000)
        waiting.set(msgId, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
      })
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
    },
    close() {
      child.stdin.end()
      return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr: err })))
    }
  }
}

async function conversation(request, label) {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  assert.equal(init.result.serverInfo.name, 'vvpost', label)
  const tools = await request('tools/list')
  assert.deepEqual(
    tools.result.tools.map((t) => t.name),
    ['list_projects', 'create_project', 'get_api_catalog', 'execute_dry_run', 'execute_flow', 'validate_body', 'install_agent_rules', 'check_readiness', 'get_schema', 'get_source', 'edit_project', 'import_postman', 'export_project', 'import_bundle', 'import_openapi',
    'sync_openapi', 'import_collection', 'generate_docs', 'get_docs_project', 'save_docs_project', 'write_docs_page', 'fix_diagrams', 'save_docs_template', 'find_references', 'replace_references', 'export_docs', 'lint_project', 'get_brand', 'list_webhook_events', 'get_webhook_event'],
    label
  )
  const catalog = await request('tools/call', { name: 'get_api_catalog', arguments: { connectorId: 'billing' } })
  assert.equal(catalog.result.isError, false, label)
  const detail = JSON.parse(catalog.result.content[0].text)
  assert.deepEqual(detail.chain, ['corp.base', 'billing'], label)
  const run = await request('tools/call', { name: 'execute_dry_run', arguments: { connectorId: 'billing', environmentIds: ['dev'] } })
  const report = JSON.parse(run.result.content[0].text)
  assert.deepEqual(report.totals, { passed: 2, failed: 0, error: 0 }, `${label}: ${run.result.content[0].text}`)
  const echoed = JSON.parse(report.results.find((r) => r.scenarioId === 'echo').body)
  assert.equal(echoed.headers.authorization, '[REDACTED_SECRET]', label)
  assert.equal(echoed.headers['x-api-token'], '[REDACTED_SECRET]', label)
  // Edição do projeto pelo binário: o schema vem do bundle e o lote só é conferido (dryRun).
  const schema = await request('tools/call', { name: 'get_schema', arguments: { name: 'connector', full: true } })
  assert.equal(JSON.parse(schema.result.content[0].text).title, 'Connector', label)
  const source = await request('tools/call', { name: 'get_source', arguments: { kind: 'connector', id: 'billing' } })
  assert.equal(source.result.isError, false, label)
  const edit = await request('tools/call', {
    name: 'edit_project',
    arguments: {
      dryRun: true,
      ops: [
        { op: 'upsertEndpoint', connectorId: 'billing', endpoint: { id: 'health', name: 'Saúde', method: 'GET', path: '/health' } },
        { op: 'writeDoc', connectorId: 'billing', markdown: '# Billing\n' }
      ]
    }
  })
  const plan = JSON.parse(edit.result.content[0].text)
  assert.equal(plan.ok, true, `${label}: ${edit.result.content[0].text}`)
  assert.equal(plan.changes.length, 2, label)
  assertNoLeak(JSON.stringify([catalog, run, source, edit]), label)
}

/** Cliente do Streamable HTTP: uma requisição POST por mensagem. */
function httpClient(url, headers = {}) {
  let id = 0
  return async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params && { params }) })
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assertNoLeak(text, 'http')
    return JSON.parse(text)
  }
}

/** Liga o servidor pelo toggle "MCP" da barra de status do app e conversa com ele. */
async function appToggle() {
  // Porta fora do padrão (4470) para não brigar com um VVPost aberto na máquina.
  const port = 47470
  const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
  writeFileSync(join(userData, 'workspace.json'), json({ dir: workspace }))
  const app = await _electron.launch({
    executablePath: electronBin,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
    env: { ...process.env, VVPOST_MCP_PORT: String(port) }
  })
  const base = `http://127.0.0.1:${port}`
  try {
    const win = await app.firstWindow()
    const errors = []
    win.on('pageerror', (e) => errors.push(e.message))
    const toggle = win.getByRole('button', { name: /^MCP:/ })
    await toggle.waitFor()
    assert.equal((await toggle.textContent())?.trim(), 'MCP: Off')
    await assert.rejects(fetch(base), 'o servidor MCP não pode subir antes do toggle')

    await toggle.click()
    await win.getByRole('button', { name: `MCP: :${port}` }).waitFor({ timeout: 10_000 })
    assert.match((await toggle.getAttribute('title')) ?? '', new RegExp(`${base}/mcp`))
    await conversation(httpClient(`${base}/mcp`), 'app')

    await toggle.click()
    await win.getByRole('button', { name: 'MCP: Off' }).waitFor({ timeout: 10_000 })
    await assert.rejects(fetch(base), 'o servidor MCP deveria ter parado')
    assert.deepEqual(errors, [])
    console.log('ok: toggle MCP na barra de status do app')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
}

/**
 * Workspace por serviço: só o conector do serviço, com a base corporativa vinda de fora. Primeiro
 * por --catalog (o snapshot do CI), depois pelo catálogo central do módulo Enterprise, que o
 * mcp.js carrega sozinho. Nos dois casos a herança resolve e a base fica somente leitura.
 */
async function sharedCatalog() {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-mcp-shared-'))
  try {
    const service = join(dir, 'ws')
    mkdirSync(join(service, 'connectors'), { recursive: true })
    writeFileSync(join(service, 'connectors/svc.connector.vvpost.json'), json({ id: 'svc', name: 'Serviço', version: '1.0.0', extends: 'corp.base', config: { basePath: '/svc' }, endpoints: [{ id: 'ping', name: 'Ping', method: 'GET', path: '/ping' }] }))
    const base = { id: 'corp.base', name: 'Base corporativa', version: '1.0.0', config: { baseUrl: 'https://api.contoso.com', headers: { 'X-Org': 'contoso' } } }
    const snapshot = { source: 'cp.contoso.com/payments', etag: '"1"', syncedAt: '', connectors: [{ scope: 'org', version: 3, doc: base }] }
    writeFileSync(join(dir, 'catalog.json'), json(snapshot))
    writeFileSync(join(dir, 'enterprise.mjs'), `export default { apiVersion: 1, audit: () => {}, createBackend: async () => { throw new Error('não usado') }, controlPlane: { activity() {}, catalog: async () => (${JSON.stringify(snapshot)}) } }\n`)
    const check = async (args, env, label) => {
      const client = stdioClient(process.execPath, [mcpJs, '--workspace', service, ...args], env)
      await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
      const res = await client.request('tools/call', { name: 'get_api_catalog', arguments: { connectorId: 'svc' } })
      assert.equal(res.result.isError, false, `${label}: ${res.result.content[0].text}`)
      const detail = JSON.parse(res.result.content[0].text)
      assert.deepEqual(detail.chain, ['corp.base', 'svc'], label)
      const list = JSON.parse((await client.request('tools/call', { name: 'get_api_catalog', arguments: {} })).result.content[0].text)
      assert.ok(list.connectors.find((c) => c.id === 'corp.base')?.readOnly, `${label}: a base corporativa não veio somente leitura`)
      const { code, stderr } = await client.close()
      assert.equal(code, 0, `${label} saiu com ${code}: ${stderr}`)
      console.log(`ok: base herdada pelo ${label}`)
    }
    await check(['--catalog', join(dir, 'catalog.json')], {}, '--catalog')
    await check([], { VVPOST_ENTERPRISE_MODULE: join(dir, 'enterprise.mjs') }, 'catálogo central do módulo Enterprise')

    // O workspace declara a organização: sem o módulo Enterprise (build Community), o MCP fica no
    // modo mais restrito em vez de rodar sem a política.
    mkdirSync(join(service, '.vvpost'), { recursive: true })
    writeFileSync(join(service, '.vvpost/organization.json'), json({ controlPlane: 'https://cp.contoso.com', project: 'payments' }))
    const client = stdioClient(process.execPath, [mcpJs, '--workspace', service], { VVPOST_ENTERPRISE_MODULE: '' })
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
    const edit = await client.request('tools/call', { name: 'edit_project', arguments: { ops: [{ op: 'upsertEndpoint', connectorId: 'svc', endpoint: { id: 'x', name: 'X', method: 'GET', path: '/x' } }] } })
    assert.equal(edit.result.isError, true, JSON.stringify(edit.result))
    assert.match(edit.result.content[0].text, /cp\.contoso\.com/)
    const { stderr } = await client.close()
    assert.match(stderr, /política do agente indisponível: .*cp\.contoso\.com/)
    console.log('ok: workspace com organization.json sem o módulo Enterprise fica restrito')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

try {
  for (const [label, command, env] of [
    ['node', process.execPath, {}],
    ['electron (ELECTRON_RUN_AS_NODE)', electronBin, { ELECTRON_RUN_AS_NODE: '1' }]
  ]) {
    const client = stdioClient(command, [mcpJs, '--workspace', workspace], env)
    await conversation(client.request, `stdio ${label}`)
    client.notify('notifications/initialized')
    const { code, stderr } = await client.close()
    assert.equal(code, 0, `stdio ${label} saiu com ${code}: ${stderr}`)
    assertNoLeak(stderr, `stderr ${label}`)
    console.log(`ok: stdio em ${label}`)
  }

  await sharedCatalog()

  const http = spawn(process.execPath, [mcpJs, '--workspace', workspace, '--transport', 'http', '--port', '0', '--token', BEARER], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const url = await new Promise((resolve, reject) => {
    let err = ''
    const timer = setTimeout(() => reject(new Error(`servidor HTTP não subiu: ${err}`)), 15_000)
    http.stderr.on('data', (c) => {
      err += c
      const m = /Streamable HTTP em (\S+)/.exec(err)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    })
  })
  try {
    await conversation(httpClient(url, { authorization: `Bearer ${BEARER}` }), 'http')
    const denied = await fetch(url, { method: 'POST', body: '{}' })
    assert.equal(denied.status, 401)
    console.log('ok: Streamable HTTP com token')
  } finally {
    http.kill('SIGTERM')
  }

  await appToggle()
  console.log('E2E MCP: ok')
} finally {
  api.close()
  rmSync(workspace, { recursive: true, force: true })
}
