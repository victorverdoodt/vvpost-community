#!/usr/bin/env node
// Teste ponta a ponta do servidor local de webhooks no app real (build de produção em out/):
// liga o servidor pelo toggle da barra de status, manda um evento assinado que dispara um
// fluxo com nó webhook, confere o evento e o disparo no painel Webhooks (Ctrl+0), reenvia
// o evento pelo inspector, confere a recusa de uma assinatura errada e desliga de novo.
// Uso: npm run build && node scripts/e2e-webhooks.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
const json = (v) => `${JSON.stringify(v, null, 2)}\n`

// Porta fora do padrão (4480) para não brigar com um VVPost aberto na máquina.
const port = 47480
const key = `whsec-${randomBytes(12).toString('hex')}`
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-webhooks-ws-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), json(data))
}
put('environments/dev.env.json', {
  id: 'dev',
  name: 'Dev',
  variables: { HOOK_KEY: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
})
put('.vvpost/secrets.local.json', { dev: { HOOK_KEY: key } })
put('flows/paid.flow.vvpost.json', {
  id: 'flow.paid',
  name: 'Pago',
  nodes: [
    { id: 'evt', name: 'Evento', type: 'webhook', webhook: { hook: 'payments' } },
    {
      id: 'check',
      name: 'Pago',
      type: 'condition',
      failWhenFalse: true,
      condition: { target: '$nodes.Evento.data.body.status', operator: 'equals', expected: 'paid' }
    }
  ],
  edges: [{ from: 'evt', to: 'check' }]
})
put('.vvpost/webhooks.json', {
  port,
  hooks: [
    {
      id: 'payments',
      path: '/payments',
      methods: ['POST'],
      signature: { header: 'X-Signature', secret: '{{HOOK_KEY}}', prefix: 'sha256=' },
      response: { status: 202, body: { ok: true } },
      trigger: { flow: 'flow.paid' }
    }
  ]
})

// O app reabre o último workspace lembrado em userData/workspace.json.
const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), json({ dir: workspace }))

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})

const base = `http://127.0.0.1:${port}`
const body = JSON.stringify({ status: 'paid', order: 'ord_1' })
const sign = (text, k = key) => `sha256=${createHmac('sha256', k).update(text).digest('hex')}`
const post = (headers, text = body) => fetch(`${base}/payments`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text })

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  const toggle = win.getByRole('button', { name: /^Webhooks:/ })
  await toggle.waitFor()
  await assert.rejects(fetch(`${base}/x`), 'o servidor não pode subir antes do toggle')
  await toggle.click()
  await win.getByRole('button', { name: new RegExp(`^Webhooks: :${port}`) }).waitFor({ timeout: 15_000 })

  const accepted = await post({ 'x-signature': sign(body) })
  assert.equal(accepted.status, 202)
  assert.deepEqual(await accepted.json(), { ok: true })
  const rejected = await post({ 'x-signature': sign(body, 'outra-chave') })
  assert.equal(rejected.status, 401)
  assert.ok(!(await rejected.text()).includes(key), 'a resposta não pode trazer a chave')

  await win.keyboard.press('Control+0')
  const events = win.getByRole('table', { name: 'Eventos recebidos' })
  await events.waitFor({ timeout: 10_000 })
  // O disparo roda o fluxo, e o nó webhook lê o evento que disparou.
  const first = events.getByRole('row').filter({ hasText: '/payments' }).filter({ hasText: 'passou' })
  await first.first().waitFor({ timeout: 15_000 })
  assert.equal(await events.getByRole('row').filter({ hasText: '401' }).count(), 1)

  await first.first().click()
  const inspector = win.getByRole('complementary').filter({ hasText: 'Evento #' })
  await inspector.getByText('assinatura ok').first().waitFor()
  await inspector.getByRole('button', { name: 'Reenviar' }).click()
  // O reenvio chega com os mesmos bytes e headers, então a assinatura confere de novo e dispara.
  await win.waitForFunction(
    () => document.querySelectorAll('table[aria-label="Eventos recebidos"] tbody tr').length === 3,
    undefined,
    { timeout: 10_000 }
  )
  await events.getByRole('row').filter({ hasText: 'passou' }).nth(1).waitFor({ timeout: 15_000 })

  if (screenshot) await win.screenshot({ path: screenshot })

  const page = await win.content()
  assert.ok(!page.includes(key), 'a chave da assinatura não pode chegar à interface')

  await toggle.click()
  await win.getByRole('button', { name: 'Webhooks: Off' }).waitFor({ timeout: 10_000 })
  await assert.rejects(fetch(`${base}/x`), 'o servidor deveria ter parado')

  assert.deepEqual(errors, [])
  console.log('E2E Webhooks: ok')
} finally {
  await app.close()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}
