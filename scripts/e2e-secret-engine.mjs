#!/usr/bin/env node
// Teste ponta a ponta do mock de Secret Managers no app real (build de produção em out/):
// abre um workspace com segredos locais, liga o mock pelo toggle da barra de status,
// lê o mesmo segredo pelas APIs do Azure Key Vault, AWS Secrets Manager e HashiCorp
// Vault, troca para o Cloud Proxy (com um módulo Enterprise falso) e de volta pelo toggle
// Mock/Proxy, e desliga de novo.
// Uso: npm run build && node scripts/e2e-secret-engine.mjs   (Linux sem display: xvfb-run -a)
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
const json = (v) => `${JSON.stringify(v, null, 2)}\n`

// Porta fora do padrão (4460) para não brigar com um VVPost aberto na máquina.
const port = 47460
const secret = 'postgres://e2e:pw@localhost/app'
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-engine-ws-'))
mkdirSync(join(workspace, 'environments'))
mkdirSync(join(workspace, '.vvpost'))
writeFileSync(join(workspace, 'environments/dev.env.json'), json({ id: 'env.dev', name: 'Dev', variables: {} }))
writeFileSync(
  join(workspace, '.vvpost/secrets-engine.json'),
  json({
    port,
    mode: 'localMock',
    localMock: { activeEnvironment: 'env.dev' },
    enterpriseProxy: { provider: 'awsSecretsManager', upstreamVaultUrl: 'https://secretsmanager.sa-east-1.amazonaws.com' }
  })
)
const engineConfig = join(workspace, '.vvpost/secrets-engine.json')
const configBefore = readFileSync(engineConfig, 'utf8')

// Módulo Enterprise falso (o real fica no repositório privado): um cofre em memória.
const cloudSecret = 'postgres://cloud-e2e'
const moduleDir = mkdtempSync(join(tmpdir(), 'vvpost-engine-mod-'))
const fakeModule = join(moduleDir, 'enterprise.mjs')
writeFileSync(
  fakeModule,
  `const values = new Map([['DATABASE_URL', ${JSON.stringify(cloudSecret)}]])
const record = (name, value) => ({ name, value, version: 'v1', updatedAt: 1 })
export default {
  apiVersion: 1,
  audit: () => {},
  async createBackend() {
    return {
      environment: 'cloud:e2e',
      list: async () => [...values].map(([n, v]) => record(n, v)),
      get: async (name) => (values.has(name) ? record(name, values.get(name)) : undefined),
      set: async () => { throw new Error('somente leitura') },
      delete: async () => { throw new Error('somente leitura') }
    }
  }
}
`
)
writeFileSync(join(workspace, '.vvpost/secrets.local.json'), json({ 'env.dev': { DATABASE_URL: secret } }))

// O app reabre o último workspace lembrado em userData/workspace.json.
const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), json({ dir: workspace }))

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_ENTERPRISE_MODULE: fakeModule }
})

const base = `http://localhost:${port}`

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  const toggle = win.getByRole('button', { name: /^Secrets:/ })
  await toggle.waitFor()
  assert.equal((await toggle.textContent())?.trim(), 'Secrets: Off')
  await assert.rejects(fetch(`${base}/v1/sys/health`), 'o engine não pode subir antes do toggle')

  await toggle.click()
  await win.getByRole('button', { name: `Secrets: Local Mock :${port}` }).waitFor({ timeout: 10_000 })
  assert.match((await toggle.getAttribute('title')) ?? '', /env\.dev/)

  const azure = await fetch(`${base}/secrets/database-url?api-version=7.4`, { headers: { authorization: 'Bearer e2e' } })
  assert.equal((await azure.json()).value, secret)

  const aws = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'x-amz-target': 'secretsmanager.GetSecretValue', 'content-type': 'application/x-amz-json-1.1' },
    body: JSON.stringify({ SecretId: 'DATABASE_URL' })
  })
  assert.equal((await aws.json()).SecretString, secret)

  const vault = await fetch(`${base}/v1/secret/data/DATABASE_URL`, { headers: { 'x-vault-token': 'e2e' } })
  assert.deepEqual((await vault.json()).data.data, { value: secret })

  // Toggle Mock/Proxy: aparece porque o workspace configura o enterpriseProxy.
  const modes = win.getByRole('radiogroup', { name: 'Modo do Secret Engine' })
  const mock = modes.getByRole('radio', { name: 'Mock' })
  const proxy = modes.getByRole('radio', { name: 'Proxy' })
  assert.equal(await mock.getAttribute('aria-checked'), 'true')
  await proxy.click()
  await win.getByRole('button', { name: `Secrets: Cloud Proxy :${port}` }).waitFor({ timeout: 10_000 })
  assert.equal(await proxy.getAttribute('aria-checked'), 'true')
  const viaProxy = await fetch(`${base}/v1/secret/data/DATABASE_URL`, { headers: { 'x-vault-token': 'e2e' } })
  assert.deepEqual((await viaProxy.json()).data.data, { value: cloudSecret })

  if (screenshot) await win.screenshot({ path: screenshot })

  // De volta ao Mock pelo teclado (radiogroup: setas trocam).
  await proxy.focus()
  await win.keyboard.press('ArrowLeft')
  await win.getByRole('button', { name: `Secrets: Local Mock :${port}` }).waitFor({ timeout: 10_000 })
  const back = await fetch(`${base}/v1/secret/data/DATABASE_URL`, { headers: { 'x-vault-token': 'e2e' } })
  assert.deepEqual((await back.json()).data.data, { value: secret })
  // A escolha é da sessão do app: o arquivo versionado do workspace não muda.
  assert.equal(readFileSync(engineConfig, 'utf8'), configBefore)

  await toggle.click()
  await win.getByRole('button', { name: 'Secrets: Off' }).waitFor({ timeout: 10_000 })
  await assert.rejects(fetch(`${base}/v1/sys/health`), 'o engine deveria ter parado')

  assert.deepEqual(errors, [])
  console.log('E2E Secret Engine: ok')
} finally {
  await app.close()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
  rmSync(moduleDir, { recursive: true, force: true })
}
