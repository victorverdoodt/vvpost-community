#!/usr/bin/env node
// Teste ponta a ponta das exportações pelo MCP no build de produção (out/main/mcp.js), como um
// agente as usaria: export_docs { format: "site" } grava o site HTML com o diagrama desenhado
// em SVG pelo executável do VVPost (o Electron do node_modules com o out/), a página Mudanças e nenhum
// segredo; export_project { format: "zip" } grava o .vvpost.zip; e import_bundle { archive }
// acrescenta esse zip a outro workspace como projeto, com o conector que leva credencial
// aguardando revisão (execute_dry_run só com plan).
// Uso: npm run build && node scripts/e2e-mcp-export.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mcpJs = join(root, 'out/main/mcp.js')
const SECRET = `e2e-export-${randomBytes(6).toString('hex')}`

function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-mcp-export-'))
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  return dir
}

const source = folder({
  'connectors/billing.connector.vvpost.json': {
    id: 'billing',
    name: 'Billing',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
    endpoints: [{ id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges' }]
  },
  'environments/dev.env.json': {
    id: 'dev',
    name: 'Dev',
    variables: { BASE_URL: { type: 'string', value: 'https://api.dev' }, API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
  },
  '.vvpost/secrets.local.json': { dev: { API_TOKEN: SECRET } },
  'docs/projeto.md': ['## Visão geral', '', '```mermaid', 'flowchart LR', '  App --> API', '```', ''].join('\n')
})
const dest = folder({ 'loja/vvpost.project.json': { id: 'loja', name: 'Loja' } })

function client(workspace) {
  const child = spawn(process.execPath, [mcpJs, '--workspace', workspace], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VVPOST_ENTERPRISE_MODULE: '' } })
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
      assert.ok(!line.includes(SECRET), 'o segredo saiu no stdout do MCP')
      const msg = JSON.parse(line)
      waiting.get(msg.id)?.(msg)
      waiting.delete(msg.id)
    }
  })
  child.stderr.on('data', (c) => (err += c))
  let id = 0
  const request = (method, params) => {
    const msgId = ++id
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msgId, method, ...(params && { params }) })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sem resposta para ${method}; stderr: ${err}`)), 120_000)
      waiting.set(msgId, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }
  return {
    async call(name, args) {
      const res = await request('tools/call', { name, arguments: args })
      return { isError: res.result.isError, data: JSON.parse(res.result.content[0].text) }
    },
    init: () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }),
    close() {
      child.stdin.end()
      return new Promise((resolve) => child.on('exit', resolve))
    }
  }
}

const a = client(source)
const b = client(dest)
try {
  await a.init()
  await b.init()

  // Site HTML com o diagrama desenhado e a versão na página Mudanças.
  const site = await a.call('export_docs', { format: 'site', label: 'v1.0.0' })
  assert.equal(site.isError, false, JSON.stringify(site.data))
  assert.equal(site.data.dir, 'dist/site')
  assert.ok(!site.data.warnings?.some((w) => /Mermaid|imagem/.test(w)), `os diagramas não viraram imagem: ${JSON.stringify(site.data.warnings)}`)
  const siteDir = join(source, 'dist/site')
  const index = readFileSync(join(siteDir, 'index.html'), 'utf8')
  const image = /assets\/(vv-diagrama-[0-9a-f]{12}\.svg)/.exec(index)?.[1]
  assert.ok(image && readFileSync(join(siteDir, 'assets', image), 'utf8').startsWith('<svg'), `o diagrama não virou imagem: ${JSON.stringify(site.data.warnings)}`)
  assert.match(readFileSync(join(siteDir, 'mudancas.html'), 'utf8'), /v1\.0\.0/)
  for (const f of readdirSync(siteDir)) if (f.endsWith('.html')) assert.ok(!readFileSync(join(siteDir, f), 'utf8').includes(SECRET), `segredo em ${f}`)
  writeFileSync(join(siteDir, 'index.html'), '<html>editado à mão</html>')
  assert.equal((await a.call('export_docs', { format: 'site' })).data.code, 'CONFLICT')

  // Zip do projeto, sem o segredo nem o site exportado.
  const zip = await a.call('export_project', { format: 'zip', out: 'dist/billing.vvpost.zip', name: 'Billing' })
  assert.equal(zip.isError, false, JSON.stringify(zip.data))
  const data = readFileSync(join(source, zip.data.file))
  assert.ok(!data.includes(SECRET), 'o segredo foi no zip')

  // O zip entra no outro workspace como projeto, com o conector aguardando revisão.
  writeFileSync(join(dest, 'billing.vvpost.zip'), data)
  const plan = await b.call('import_bundle', { archive: 'billing.vvpost.zip', as: 'billing' })
  assert.equal(plan.data.applied, false, JSON.stringify(plan.data))
  const applied = await b.call('import_bundle', { archive: 'billing.vvpost.zip', as: 'billing', apply: true })
  assert.equal(applied.isError, false, JSON.stringify(applied.data))
  assert.deepEqual(applied.data.review, ['billing'])
  assert.ok(existsSync(join(dest, 'billing/vvpost.project.json')))
  const blocked = await b.call('execute_dry_run', { project: 'billing', connectorId: 'billing', environmentIds: ['dev'], request: { endpointId: 'charge' } })
  assert.equal(blocked.isError, true)
  assert.match(blocked.data.error, /revisado/)
  const planned = await b.call('execute_dry_run', { project: 'billing', connectorId: 'billing', environmentIds: ['dev'], plan: true, request: { endpointId: 'charge' } })
  assert.equal(planned.isError, false, JSON.stringify(planned.data))
  console.log('E2E das exportações pelo MCP: ok')
} finally {
  await a.close()
  await b.close()
  rmSync(source, { recursive: true, force: true })
  rmSync(dest, { recursive: true, force: true })
}
