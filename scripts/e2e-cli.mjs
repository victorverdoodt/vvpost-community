#!/usr/bin/env node
// Teste ponta a ponta do CLI para CI/CD no build de produção (out/main/cli.js): roda um
// workspace com cenários (auth bearer herdada) e um fluxo com nó do plugin oficial de
// JavaScript, em Node puro e no Electron com ELECTRON_RUN_AS_NODE=1, e confere os exit
// codes, o JUnit, o JSON e que o token não aparece em nenhuma saída.
// Com --npm, roda também o pacote npm (npm run build:cli): empacota com `npm pack`, instala o
// .tgz numa pasta temporária e usa o `vvpost` instalado. Com --installer <comando>, roda o
// comando `vvpost` que vai no instalador do app (resources/bin/vvpost do build desempacotado).
// Uso: npm run build && node scripts/e2e-cli.mjs [--npm] [--installer <caminho>]
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cliJs = join(root, 'out/main/cli.js')
const electronBin = createRequire(import.meta.url)('electron')
const API_TOKEN = `e2e-${randomBytes(8).toString('hex')}`

const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
    res.statusCode = 401
    return res.end(JSON.stringify({ error: 'unauthorized' }))
  }
  // Eco do header: a credencial volta no corpo e precisa sair mascarada nos relatórios.
  res.end(JSON.stringify({ status: 'PENDING', items: [{ price: 10 }, { price: 5 }], echo: req.headers.authorization }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const tmp = mkdtempSync(join(tmpdir(), 'vvpost-e2e-cli-'))
const workspace = join(tmp, 'ws')
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/orders.connector.vvpost.json', {
  id: 'orders',
  name: 'Orders',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
  endpoints: [
    {
      id: 'get_cart',
      name: 'Carrinho',
      method: 'GET',
      path: '/cart',
      scenarios: [
        { id: 'ok', name: 'Ok', assertions: [{ target: 'body.status', operator: 'equals', expected: 'PENDING' }] },
        { id: 'expects_paid', name: 'Pago', assertions: [{ target: 'body.status', operator: 'equals', expected: 'PAID' }] }
      ]
    }
  ]
})
put('environments/ci.env.json', {
  id: 'ci',
  name: 'CI',
  variables: {
    BASE_URL: { type: 'string', value: origin },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put('flows/total.flow.vvpost.json', {
  id: 'flow.total',
  name: 'Total',
  nodes: [
    { id: 'cart', name: 'Cart', type: 'request', request: { connector: 'orders', endpoint: 'get_cart' } },
    {
      id: 'sum',
      name: 'Sum',
      type: 'plugin',
      plugin: { node: 'javascript.script', config: { code: 'return { total: nodes.Cart.data.items.reduce((s, i) => s + i.price, 0) }' } }
    },
    { id: 'check', name: 'Check', type: 'condition', condition: { target: '$nodes.Sum.data.total', operator: 'equals', expected: 15 } }
  ],
  edges: [
    { from: 'cart', to: 'sum' },
    { from: 'sum', to: 'check' }
  ]
})

function vvpost([command, ...prefix], args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      cwd: tmp,
      // O vvpost.cmd do instalador no Windows só roda por um shell.
      shell: /\.cmd$/i.test(command),
      env: { ...process.env, VVPOST_USER_DATA: join(tmp, 'user-data'), NO_COLOR: '1', ...env }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const { values: targets } = parseArgs({ options: { npm: { type: 'boolean' }, installer: { type: 'string' } } })
const runtimes = [
  ['node', [process.execPath, cliJs], {}],
  ['electron (ELECTRON_RUN_AS_NODE)', [electronBin, cliJs], { ELECTRON_RUN_AS_NODE: '1' }]
]
if (targets.npm) {
  // O mesmo caminho do `npx vvpost`: o .tgz que iria para o registro, instalado sem rede.
  const pkgDir = join(root, 'packages/cli')
  const prefix = join(tmp, 'npm-prefix')
  mkdirSync(prefix)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const opts = { encoding: 'utf8', shell: process.platform === 'win32' }
  const [{ filename }] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', tmp], { ...opts, cwd: pkgDir }))
  execFileSync(npm, ['install', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', join(tmp, filename)], opts)
  const installed = join(prefix, 'node_modules/vvpost')
  assert.ok(existsSync(join(prefix, 'node_modules/.bin', process.platform === 'win32' ? 'vvpost.cmd' : 'vvpost')), 'o pacote npm não instalou o bin vvpost')
  assert.ok(!existsSync(join(installed, 'node_modules')), 'o pacote npm não deveria ter dependências em runtime')
  runtimes.push(['pacote npm', [process.execPath, join(installed, 'bin/vvpost.js')], {}])
}
if (targets.installer) runtimes.push(['instalador do app', [resolve(targets.installer)], {}])

try {
  for (const [label, command, extraEnv] of runtimes) {
    const env = { ...extraEnv, VVPOST_SECRET_API_TOKEN: API_TOKEN }
    const start = performance.now()

    const passing = await vvpost(command, ['run', '--workspace', 'ws', '--env', 'ci', '--scenario', 'get_cart/ok', '--flow', 'flow.total', '--connector', 'orders'], env)
    assert.equal(passing.code, 0, `${label}: ${passing.stdout}${passing.stderr}`)
    assert.match(passing.stdout, /PASSOU · 1 cenários passaram · 1 fluxos ok/)
    assert.match(passing.stdout, /✓ Sum/)

    const failing = await vvpost(command, ['run', '--workspace', 'ws', '--env', 'ci', '--junit', 'out/junit.xml', '--json', 'out/report.json'], env)
    assert.equal(failing.code, 1, `${label}: ${failing.stdout}${failing.stderr}`)
    if (process.env.E2E_VERBOSE) console.log(failing.stdout)
    const junit = readFileSync(join(tmp, 'out/junit.xml'), 'utf8')
    assert.match(junit, /<testsuites name="vvpost" tests="5" failures="1" errors="0" skipped="0"/)
    assert.match(junit, /<testcase classname="orders.get_cart" name="expects_paid \[ci\]"/)
    const report = JSON.parse(readFileSync(join(tmp, 'out/report.json'), 'utf8'))
    assert.equal(report.outcome, 'failed')
    assert.equal(report.flows[0].report.results.find((n) => n.name === 'Sum').output.data.total, 15)

    for (const text of [passing.stdout, passing.stderr, failing.stdout, failing.stderr, junit, JSON.stringify(report)]) {
      assert.ok(!text.includes(API_TOKEN), `${label}: o token apareceu numa saída do CLI`)
    }

    const noSecret = await vvpost(command, ['run', '--workspace', 'ws', '--env', 'ci', '--connector', 'orders'], extraEnv)
    assert.equal(noSecret.code, 1)
    assert.match(noSecret.stdout, /CONFIG_ERROR/)

    const usage = await vvpost(command, ['run', '--workspace', 'ws', '--env', 'prod'], extraEnv)
    assert.equal(usage.code, 2)
    assert.match(usage.stderr, /ambiente "prod" não existe/)

    console.log(`ok: ${label} (${Math.round(performance.now() - start)} ms para 4 execuções)`)
  }
  console.log('E2E do CLI passou.')
} finally {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}
