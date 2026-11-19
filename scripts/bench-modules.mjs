#!/usr/bin/env node
// Mede o que a pessoa sente depois do boot: quanto cada módulo leva
// para aparecer na primeira vez (com o chunk carregado) e na volta, e quanto dura a primeira
// execução no Quick Request. O app registra as medidas no Performance Timeline (src/renderer/
// src/lib/perf.ts); este script abre cada módulo pela sidebar, volta a ele, envia uma requisição
// em loopback e lê as medidas. Compara com perf-budgets.json (moduleFirstOpenMs, moduleReturnMs,
// firstRunMs) e grava bench-modules.json.
// Uso: npm run build && node scripts/bench-modules.mjs [-- --app dist/linux-unpacked/vvpost-desktop]
// (Linux sem display: xvfb-run -a). O npm run bench roda este script depois do de startup.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const args = process.argv.slice(2)
const appExe = args.includes('--app') ? args[args.indexOf('--app') + 1] : null
const budgets = JSON.parse(readFileSync(join(root, 'perf-budgets.json'), 'utf8'))

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-bench-modules-ws-'))
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
put('environments/dev.env.json', {
  id: 'env.dev',
  name: 'Dev',
  variables: { BASE_URL: { type: 'string', value: 'http://localhost' } }
})

const server = createServer((_, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const target = `http://127.0.0.1:${server.address().port}/`

const userData = mkdtempSync(join(tmpdir(), 'vvpost-bench-modules-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
const sandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : []
const app = await _electron.launch({
  executablePath: appExe ?? electronBin,
  args: [...sandbox, `--user-data-dir=${userData}`, ...(appExe ? [] : [root])],
  env: { ...process.env, VVPOST_MCP_PORT: '0' }
})
let measures
try {
  const win = await app.firstWindow()
  const nav = win.getByRole('navigation', { name: 'Módulos' })
  await nav.waitFor()
  const labels = await nav.locator('[data-panel]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  const [home, ...others] = labels
  const settle = async (name) => {
    await win.waitForFunction((n) => performance.getEntriesByName(n).length > 0, name, { timeout: 10_000 })
  }
  const idOf = (label) => nav.getByRole('button', { name: label, exact: true }).getAttribute('data-panel')

  // Primeira abertura de cada módulo e a volta a ele, sempre partindo do Quick Request.
  for (const label of others) {
    const id = await idOf(label)
    await nav.getByRole('button', { name: label, exact: true }).click()
    await settle(`vvpost:module:${id}:first`)
    await nav.getByRole('button', { name: home, exact: true }).click()
    await nav.getByRole('button', { name: label, exact: true }).click()
    await settle(`vvpost:module:${id}:return`)
    await nav.getByRole('button', { name: home, exact: true }).click()
  }

  // Primeira execução: uma requisição em loopback pelo Quick Request.
  const quick = win.locator('main > div:not([hidden])')
  await quick.locator('input[aria-label="URL"]').fill(target)
  await quick.getByRole('button', { name: 'Enviar' }).click()
  await settle('vvpost:run:quick:first')

  measures = await win.evaluate(() =>
    performance
      .getEntriesByType('measure')
      .filter((m) => m.name.startsWith('vvpost:'))
      .map((m) => ({ name: m.name, ms: Math.round(m.duration * 10) / 10 }))
  )
} finally {
  await app.close()
  server.close()
  for (const d of [userData, workspace]) rmSync(d, { recursive: true, force: true })
}

const byModule = {}
for (const { name, ms } of measures) {
  const [, kind, id, phase] = name.split(':')
  if (kind === 'module') (byModule[id] ??= {})[phase] = ms
}
const firstRun = measures.find((m) => m.name === 'vvpost:run:quick:first')?.ms ?? Infinity
// O módulo da abertura do app só tem volta: o cold start mede a primeira vez dele.
const worst = (phase) => {
  const values = Object.values(byModule).flatMap((m) => (m[phase] === undefined ? [] : [m[phase]]))
  return values.length ? Math.max(...values) : Infinity
}
const result = { moduleFirstOpenMs: worst('first'), moduleReturnMs: worst('return'), firstRunMs: firstRun }
writeFileSync(join(root, 'bench-modules.json'), JSON.stringify({ result, byModule, measures }, null, 2))

console.log('\nMódulos (ms): primeira abertura e volta')
console.table(byModule)
const rows = [
  ['Pior primeira abertura de módulo', 'moduleFirstOpenMs'],
  ['Pior volta a um módulo', 'moduleReturnMs'],
  ['Primeira execução (Quick Request)', 'firstRunMs']
].map(([name, key]) => {
  const { max, enforce } = budgets[key]
  const ok = result[key] < max
  return [
    name,
    { valor: `${result[key]} ms`, meta: `< ${max} ms`, status: ok ? '✅' : enforce ? '❌' : '⚠️ só reportado' },
    ok || !enforce
  ]
})
console.table(Object.fromEntries(rows.map(([name, row]) => [name, row])))

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    '### Módulos: abertura, volta e primeira execução',
    '',
    '| Métrica | Valor | Meta | |',
    '| --- | --- | --- | --- |',
    ...rows.map(([name, r]) => `| ${name} | ${r.valor} | ${r.meta} | ${r.status} |`),
    ''
  ].join('\n')
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' })
}
if (!args.includes('--report-only') && rows.some(([, , ok]) => !ok)) process.exitCode = 1
