#!/usr/bin/env node
// Teste ponta a ponta da execução remota no app real (build de produção em out/):
// com um módulo Enterprise falso cujo "runner" roda o CLI de verdade (out/main/cli.js) sobre
// o workspace que o app enviou, dispara pelo botão "Rodar no runner" do módulo de testes,
// acompanha a saída e confere que o relatório preenche a matriz e que nenhum segredo saiu.
// Uso: npm run build && node scripts/e2e-remote-run.mjs   (Linux sem display: xvfb-run -a)
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

const API_TOKEN = 'token-do-runner-e2e'
const LOCAL_ONLY = 'segredo-que-fica-na-maquina'
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  const ok = req.headers.authorization === `Bearer ${API_TOKEN}`
  res.statusCode = ok ? 200 : 401
  res.end(JSON.stringify({ status: ok ? 'PENDING' : 'unauthorized' }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-remote-ws-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/billing.connector.vvpost.json', {
  id: 'billing',
  name: 'Billing',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
  endpoints: [
    {
      id: 'charge',
      name: 'Cobrar',
      method: 'GET',
      path: '/charges',
      scenarios: [
        { id: 'ok', name: 'Cobrança pendente', assertions: [{ target: 'body.status', operator: 'equals', expected: 'PENDING' }] },
        { id: 'wrong', name: 'Falha de propósito', assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }
      ]
    }
  ]
})
put('environments/dev.env.json', {
  id: 'env.dev',
  name: 'Desenvolvimento',
  variables: { BASE_URL: { type: 'string', value: origin }, API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
})
// O vault local tem outro valor: o runner não pode recebê-lo.
put('.vvpost/secrets.local.json', { 'env.dev': { API_TOKEN: LOCAL_ONLY } })

// Módulo Enterprise falso: a "fila" roda o CLI na hora, num diretório temporário, com o
// segredo vindo do ambiente do runner (VVPOST_SECRET_API_TOKEN).
const moduleDir = mkdtempSync(join(tmpdir(), 'vvpost-remote-mod-'))
const sentFile = join(moduleDir, 'sent.json')
writeFileSync(
  join(moduleDir, 'enterprise.mjs'),
  `import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
const CLI = ${JSON.stringify(join(root, 'out/main/cli.js'))}
const runs = new Map()
let next = 1
const view = (r) => ({ id: r.id, project: 'payments', status: r.status, requestedBy: 'ana@contoso.com', createdAt: '', finishedAt: null, cancelRequested: false, exitCode: r.exitCode ?? null, error: null })
export default {
  apiVersion: 1,
  audit: () => {},
  createBackend: async () => { throw new Error('não usado') },
  controlPlane: {
    activity: () => {},
    runs: {
      target: async () => ({ source: 'cp.contoso.com/payments', signedIn: true }),
      async start(req) {
        writeFileSync(${JSON.stringify(sentFile)}, JSON.stringify(req))
        const dir = mkdtempSync(join(${JSON.stringify(moduleDir)}, 'run-'))
        for (const [path, doc] of Object.entries(req.files)) {
          mkdirSync(dirname(join(dir, 'ws', path)), { recursive: true })
          writeFileSync(join(dir, 'ws', path), JSON.stringify(doc))
        }
        const r = { id: next++, status: 'queued', events: [], report: null }
        runs.set(r.id, r)
        const push = (kind, data) => r.events.push({ seq: r.events.length + 1, at: new Date().toISOString(), kind, data })
        push('status', { status: 'queued' })
        setTimeout(() => {
          r.status = 'running'
          push('status', { status: 'running', runner: 'e2e' })
          const args = [CLI, 'run', '--workspace', join(dir, 'ws'), '--json', join(dir, 'report.json'), '--no-color']
          for (const e of req.environments) args.push('--env', e)
          for (const c of req.connectors) args.push('--connector', c)
          for (const s of req.scenarios) args.push('--scenario', s)
          const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', VVPOST_SECRET_API_TOKEN: ${JSON.stringify(API_TOKEN)} } })
          createInterface({ input: child.stdout }).on('line', (line) => push('log', { stream: 'stdout', lines: [line] }))
          createInterface({ input: child.stderr }).on('line', (line) => push('log', { stream: 'stderr', lines: [line] }))
          child.on('close', (code) => {
            try { r.report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) } catch {}
            r.exitCode = code
            r.status = code === 0 ? 'passed' : code === 1 ? 'failed' : 'error'
            push('status', { status: r.status, exitCode: code })
          })
        }, 300)
        return view(r)
      },
      async get(id) { const r = runs.get(id); return { run: view(r), report: r.report } },
      async events(id, after) { return runs.get(id).events.filter((e) => e.seq > after) },
      async cancel(id) { return view(runs.get(id)) }
    }
  }
}
`
)

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_ENTERPRISE_MODULE: join(moduleDir, 'enterprise.mjs') }
})

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  await win.getByRole('button', { name: 'Cenários de teste' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.locator('select[aria-label="Conector"]').selectOption('billing')
  await panel.getByText('Cobrança pendente').waitFor()
  const envs = panel.getByRole('group', { name: 'Ambientes da matriz' })
  await envs.getByLabel('Sem ambiente').uncheck()
  await envs.getByLabel('Desenvolvimento').check()

  // Antes de sair da máquina: destino, projeto, ambiente e segredos, para confirmar.
  // Cancelar não envia nada.
  await panel.getByRole('button', { name: 'Rodar no runner' }).click()
  const confirm = win.getByRole('dialog', { name: 'Enviar ao runner de cp.contoso.com/payments?' })
  await confirm.getByText('Destino: Execution Runner de cp.contoso.com/payments.').waitFor()
  await confirm.getByText(/Projeto: vvpost-remote-ws-\w+, 2 arquivos \(\d+ (B|KB)\)\./).waitFor()
  await confirm.getByText('Ambientes: Desenvolvimento (segredos resolvidos no runner: API_TOKEN).').waitFor()
  await confirm.getByText(/Conectores: Billing\. Escopo: todos os cenários do conector\./).waitFor()
  assert.ok(!(await confirm.textContent()).includes(LOCAL_ONLY), 'o vault local apareceu na confirmação')
  await confirm.getByRole('button', { name: 'Cancelar' }).click()
  assert.ok(!existsSync(sentFile), 'cancelar a confirmação enviou o workspace')
  await panel.getByRole('button', { name: 'Rodar no runner' }).click()
  await confirm.getByRole('button', { name: 'Enviar ao runner' }).click()
  const strip = panel.getByRole('region', { name: 'Execução remota' })
  await strip.getByText('falhou', { exact: true }).waitFor({ timeout: 20_000 })
  await strip.getByText('cp.contoso.com/payments').waitFor()
  await strip.getByText('código 1').waitFor()
  const log = await strip.getByRole('log', { name: 'Saída do CLI no runner' }).textContent()
  assert.match(log ?? '', /charge\/ok/)

  // O relatório do runner preenche a matriz como uma execução local.
  const cell = (scenario) => panel.getByRole('button', { name: `${scenario} em Desenvolvimento` })
  assert.equal(await cell('Cobrança pendente').textContent(), '200')
  assert.equal(await cell('Falha de propósito').textContent(), '1/1')
  await panel.getByText('1 passaram').waitFor()

  // O que saiu da máquina: o workspace sem .vvpost/ e com o segredo como __REQUIRED_SECRET__.
  const sent = JSON.parse(readFileSync(sentFile, 'utf8'))
  assert.deepEqual(Object.keys(sent.files).sort(), ['connectors/billing.connector.vvpost.json', 'environments/dev.env.json'])
  assert.deepEqual({ environments: sent.environments, connectors: sent.connectors, scenarios: sent.scenarios, flows: sent.flows }, { environments: ['env.dev'], connectors: ['billing'], scenarios: [], flows: [] })
  assert.ok(!JSON.stringify(sent).includes(LOCAL_ONLY), 'o vault local saiu da máquina')
  assert.equal(sent.files['environments/dev.env.json'].variables.API_TOKEN.value, '__REQUIRED_SECRET__')

  const html = await win.content()
  assert.ok(!html.includes(API_TOKEN) && !html.includes(LOCAL_ONLY), 'segredo chegou ao renderer')
  if (screenshot) await win.screenshot({ path: screenshot })

  await strip.getByRole('button', { name: 'Fechar execução remota' }).click()
  await strip.waitFor({ state: 'detached' })

  // A execução remota fica no Histórico, marcada como remota e sem nada para reproduzir daqui.
  await win.keyboard.press('Control+9')
  const history = win.locator('main > div:not([hidden])')
  await history.getByRole('radio', { name: 'Remotas' }).click()
  const runs = history.locator('table[aria-label="Execuções"] tbody tr')
  await runs.filter({ hasText: 'Cenários de Billing no runner #1' }).waitFor()
  assert.equal(await runs.count(), 1)
  await runs.first().getByText('Remota', { exact: true }).waitFor()
  await runs.first().click()
  await history.getByText(/Execution Runner de cp\.contoso\.com\/payments, execução #1/).waitFor()
  await history.getByRole('radio', { name: 'Tudo' }).click()
  assert.ok(!(await win.content()).includes(LOCAL_ONLY), 'o vault local chegou ao histórico')
  assert.deepEqual(errors, [])
  console.log('E2E da execução remota: ok')
} finally {
  await app.close()
  server.close()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
  rmSync(moduleDir, { recursive: true, force: true })
}
