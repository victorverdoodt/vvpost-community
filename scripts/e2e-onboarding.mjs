#!/usr/bin/env node
// Teste ponta a ponta dos primeiros passos: sem projeto, a status bar
// mostra o progresso sem abrir nada sozinha; o painel leva a cada módulo, mostra os segredos
// pendentes por ambiente sem valores e marca as etapas pelo que foi feito (projeto aberto,
// primeira requisição). "Não mostrar mais" esconde e vale na próxima abertura; a paleta mostra de novo.
// Uso: npm run build && node scripts/e2e-onboarding.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { demoServer } from './demo-server.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')

const server = demoServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-demo-'))
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
for (const env of ['dev', 'staging']) {
  const file = join(workspace, `environments/${env}.env.json`)
  writeFileSync(file, readFileSync(file, 'utf8').replace('http://127.0.0.1:4010', origin))
}
// Development com o segredo configurado; Staging fica com os dois pendentes.
mkdirSync(join(workspace, '.vvpost'))
writeFileSync(
  join(workspace, '.vvpost/secrets.local.json'),
  JSON.stringify({ 'env.dev': { CLIENT_SECRET: 'demo-secret' } })
)
const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const launch = () =>
  _electron.launch({
    executablePath: electronBin,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
  })

let app = await launch()
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, workspace)

  // Ensina sem interromper: o progresso fica na status bar e o painel só abre quando pedido.
  const footer = win.locator('footer')
  const trigger = footer.getByRole('button', { name: /^Primeiros passos \d\/6$/ })
  await trigger.waitFor()
  const steps = win.getByRole('dialog', { name: 'Primeiros passos' })
  assert.equal(await steps.count(), 0)
  await trigger.click()
  await steps.waitFor()
  await steps.getByText('Criar, abrir ou importar um projeto (pendente)').waitFor()

  // Importar leva ao módulo de importação; Esc fecha e devolve o foco.
  await steps.getByRole('button', { name: 'Importar' }).click()
  await win
    .getByRole('navigation', { name: 'Módulos' })
    .locator('button[aria-label="Importar e exportar"][aria-current="page"]')
    .waitFor()
  await trigger.click()
  await win.keyboard.press('Escape')
  await steps.waitFor({ state: 'hidden' })
  assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-controls')), 'onboarding-panel')

  await trigger.click()
  await steps.getByRole('button', { name: 'Abrir pasta…' }).click()
  await footer.getByText(/Git: /).waitFor()
  await trigger.click()
  await steps.getByText('Criar, abrir ou importar um projeto (concluída)').waitFor()
  // Segredos pendentes por ambiente, só contagem: nenhum valor nem nome de variável.
  await steps.getByText('Faltam valores (2 em Staging)', { exact: false }).waitFor()
  assert.ok(!(await steps.textContent()).includes('CLIENT_SECRET'))

  // Primeira requisição: o progresso vem do histórico, não da tela visitada.
  await steps.getByRole('button', { name: 'Abrir Quick Request' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.locator('select[aria-label="Conector"]').selectOption('connector.customers.v2')
  await panel.locator('select[aria-label="Endpoint"]').selectOption('me')
  await panel.getByRole('button', { name: 'Enviar' }).click()
  await panel.getByText('200 OK').waitFor()
  await win.getByRole('navigation', { name: 'Módulos' }).getByRole('button', { name: 'Histórico', exact: true }).click()
  await trigger.click()
  await steps.getByText('Fazer a primeira requisição (concluída)').waitFor()

  await steps.getByRole('button', { name: 'Não mostrar mais' }).click()
  await trigger.waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}

app = await launch()
try {
  const win = await app.firstWindow()
  // O projeto lembrado aparece na status bar logo no boot, sem esperar o polling.
  await win.locator('footer').getByText('Git: fora de um repositório').waitFor({ timeout: 1000 })
  await win.waitForTimeout(1500)
  assert.equal(
    await win
      .locator('footer')
      .getByRole('button', { name: /Primeiros passos/ })
      .count(),
    0
  )
  // Retomar: a paleta mostra de novo.
  await win.keyboard.press('Control+k')
  await win.keyboard.type('primeiros passos')
  await win.keyboard.press('Enter')
  await win.getByRole('dialog', { name: 'Primeiros passos' }).waitFor()
  await win
    .locator('footer')
    .getByRole('button', { name: /^Primeiros passos \d\/6$/ })
    .waitFor()
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
console.log('E2E dos primeiros passos: ok')
