#!/usr/bin/env node
// Teste ponta a ponta da instrumentação do teste com usuários: com
// --ux-study=<pasta> a status bar avisa que está gravando e cada ação vira uma linha em
// session-*.jsonl (troca de módulo, envio, erro visto), sem URL, header ou corpo; o relatório
// resume a sessão. Sem a flag, nada é gravado (o E2E de acessibilidade confere o aviso ausente).
// Uso: npm run build && node scripts/e2e-ux-study.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { summarize } from './ux-study-report.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const studyDir = mkdtempSync(join(tmpdir(), 'vvpost-study-'))
const SECRET_PATH = '/segredo-no-caminho'

const server = createServer((_req, res) => res.end('{"ok":true}'))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const app = await _electron.launch({
  executablePath: electronBin,
  args: [
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    `--user-data-dir=${userData}`,
    root,
    `--ux-study=${studyDir}`
  ]
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await win.locator('footer').getByText('Estudo de UX gravando').waitFor()

  const nav = win.getByRole('navigation', { name: 'Módulos' })
  await nav.getByRole('button', { name: 'Catálogo', exact: true }).click()
  await nav.getByRole('button', { name: 'Quick Request', exact: true }).click()
  const panel = win.locator('main > div:not([hidden])')
  const url = panel.locator('input[aria-label="URL"]:visible')

  // Uma falha (porta fechada) e depois um envio que dá certo.
  await url.fill('http://127.0.0.1:9/fechada')
  await panel.getByRole('button', { name: 'Enviar' }).click()
  await panel.getByRole('alert').getByText('Rede').waitFor()
  await url.fill(`${origin}${SECRET_PATH}`)
  await panel.getByRole('button', { name: 'Enviar' }).click()
  await panel.getByText('200 OK').waitFor()
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  server.close()
}

const [file] = readdirSync(studyDir).filter((f) => f.startsWith('session-'))
assert.ok(file, 'a sessão não foi gravada')
const raw = readFileSync(join(studyDir, file), 'utf8')
assert.ok(!raw.includes(SECRET_PATH) && !raw.includes('127.0.0.1'), 'URL foi para o log do estudo')
const events = raw
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
assert.equal(events[0].type, 'session')
const s = summarize(events)
assert.deepEqual(s.modules, { catalog: 1, 'quick-request': 1 })
assert.equal(s.requests, 2)
assert.equal(s.requestsBeforeFirstSuccess, 1)
assert.deepEqual(s.requestErrors, { CONNECTION_REFUSED: 1 })
assert.equal(s.errorsShown['Rede'], 1)
assert.ok(s.moduleReadyMs.p50 !== null)
rmSync(userData, { recursive: true, force: true })
rmSync(studyDir, { recursive: true, force: true })
console.log(`E2E do estudo de UX: ok (${events.length} eventos, troca de módulo p50 ${s.moduleReadyMs.p50} ms)`)
