#!/usr/bin/env node
// Teste ponta a ponta do Quick Request no app real (build de produção em out/):
// dispara pelo painel contra um servidor local, confere a resposta na tela, o
// histórico (reproduzir e reabrir) e o arquivo SQLite (WAL, cabeçalho sensível mascarado).
// Uso: npm run build && npm run test:e2e   (Linux sem display: xvfb-run -a npm run test:e2e)
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, body }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const target = `http://127.0.0.1:${server.address().port}/users`

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  // Electron recusa rodar como root sem --no-sandbox (containers de CI).
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  await win.selectOption('select[aria-label="Método HTTP"]', 'POST')
  await win.fill('input[aria-label="URL"]', target)
  await win.locator('input[aria-label="Nome do cabeçalho"]').first().fill('Authorization')
  await win.locator('input[aria-label="Valor do cabeçalho"]').first().fill('Bearer segredo')
  await win.getByRole('tab', { name: 'Body', exact: true }).click()
  await win.fill('textarea[aria-label="Corpo da requisição"]', '{"nome":"VVPost"}')

  let start = performance.now()
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  const firstMs = Math.round(performance.now() - start)
  // Três níveis de abas com cara própria: conteúdo sublinhado, resposta segmentada.
  assert.equal(await win.getByRole('tablist', { name: 'Requisição' }).getAttribute('data-variant'), 'line')
  assert.equal(await win.getByRole('tablist', { name: 'Resposta' }).getAttribute('data-variant'), 'segmented')

  // Ctrl+Enter executa a operação ativa.
  start = performance.now()
  await win.locator('input[aria-label="URL"]').focus()
  await win.keyboard.press('Control+Enter')
  await win.locator('aside li').nth(1).waitFor()
  const secondMs = Math.round(performance.now() - start)

  const echoed = JSON.parse(await win.locator('pre').textContent())
  assert.deepEqual(echoed, { method: 'POST', auth: 'Bearer segredo', body: '{"nome":"VVPost"}' })

  // Configuração x execução: a requisição enviada aparece ao lado da resposta,
  // com a credencial mascarada.
  const sent = win.getByRole('region', { name: 'Requisição enviada' })
  await sent.getByText(target, { exact: true }).waitFor()
  await sent.getByRole('button').click()
  await sent.getByText('Authorization', { exact: true }).waitFor()
  assert.ok(!(await sent.textContent()).includes('segredo'), 'credencial sem máscara na requisição enviada')

  // Params: desativar tira da URL sem perder a linha; ativar devolve.
  await win.fill('input[aria-label="URL"]', `${target}?a=1&b=2`)
  await win.getByRole('tab', { name: /^Params/ }).click()
  // A linha desativada vai para o fim da lista: clique, não uncheck (o elemento muda de lugar).
  await win.getByRole('checkbox', { name: 'Ativar parâmetro a' }).click()
  assert.equal(await win.inputValue('input[aria-label="URL"]'), `${target}?b=2`)
  assert.equal(await win.getByRole('checkbox', { name: 'Ativar parâmetro a' }).isChecked(), false)
  await win.getByRole('checkbox', { name: 'Ativar parâmetro a' }).click()
  assert.equal(await win.inputValue('input[aria-label="URL"]'), `${target}?b=2&a=1`)
  // Recolher a edição dá o espaço à resposta; clicar numa aba abre de novo.
  await win.getByRole('button', { name: 'Recolher a edição e dar espaço à resposta' }).click()
  await win.locator('input[aria-label="Nome do parâmetro"]').first().waitFor({ state: 'detached' })
  await win.getByRole('tablist', { name: 'Requisição' }).getByRole('tab', { name: /^Headers/ }).click()
  await win.locator('input[aria-label="Nome do cabeçalho"]').first().waitFor()
  await win.fill('input[aria-label="URL"]', target)

  await win.fill('input[aria-label="URL"]', 'http://127.0.0.1:1/')
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('CONNECTION_REFUSED').first().waitFor()
  assert.equal(await win.locator('aside li').count(), 3)

  // Ctrl+B recolhe o inspector sem perder o conteúdo; de novo, ele volta igual.
  await win.keyboard.press('Control+b')
  await win.locator('aside li').first().waitFor({ state: 'hidden' })
  await win.keyboard.press('Control+b')
  await win.locator('aside li').first().waitFor()
  assert.equal(await win.locator('aside li').count(), 3)
  assert.deepEqual(errors, [])

  // Histórico rico: uma requisição sem segredo digitado reproduz; a com
  // "Bearer segredo" foi mascarada, então só reabre no Quick Request (com o marcador).
  const visible = (selector) => win.locator(`[role=tabpanel]:not([hidden]) ${selector}`)
  await win.keyboard.press('Control+n')
  // A requisição nova vira a aba ativa da barra do workspace.
  await win.getByRole('tab', { name: 'Nova requisição', selected: true }).waitFor()
  await visible('input[aria-label="URL"]').fill(target)
  await visible('input[aria-label="URL"]').press('Control+Enter')
  await win.locator('aside li').nth(3).waitFor()

  await win.keyboard.press('Control+9')
  const runs = win.locator('table[aria-label="Execuções"] tbody tr')
  await runs.nth(3).waitFor()
  assert.equal(await runs.count(), 4)
  await runs.first().click()
  const replay = win.getByRole('button', { name: 'Reproduzir' })
  await replay.waitFor()
  assert.equal(await replay.isEnabled(), true)
  await win.getByRole('tab', { name: 'Requisição' }).click()
  await win.getByRole('region', { name: 'Requisição enviada' }).getByText(target).waitFor()
  await replay.click()
  await win.getByText(/Reproduzida: HTTP 200/).waitFor()
  await runs.nth(4).waitFor()
  await win.getByText('reproduzida', { exact: true }).first().waitFor()

  await runs.nth(3).click()
  await win.getByText('Reproduzir indisponível: há valores mascarados').waitFor()
  assert.equal(await replay.isEnabled(), false)
  await win.getByRole('button', { name: 'Reabrir no Quick Request' }).click()
  await visible('input[aria-label="URL"]').waitFor()
  assert.equal(await visible('input[aria-label="URL"]').inputValue(), target)
  assert.equal(await visible('input[aria-label="Valor do cabeçalho"]').first().inputValue(), '__REQUIRED_SECRET__')
  assert.deepEqual(errors, [])

  console.log(
    `Clique até a resposta na tela: 1º envio ${firstMs} ms (carrega o undici), 2º envio ${secondMs} ms`
  )
} finally {
  await app.close()
  server.close()
}

const db = new DatabaseSync(join(userData, 'vvpost.db'))
assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
const rows = db.prepare('SELECT detail, status, error_code FROM history_exchange ORDER BY id').all()
const replays = db.prepare('SELECT count(*) AS n FROM history_run WHERE replay_of IS NOT NULL').get().n
db.close()
assert.equal(rows.length, 5)
assert.equal(replays, 1)
assert.equal(rows[0].status, 200)
assert.equal(rows[2].error_code, 'CONNECTION_REFUSED')
const detail = JSON.parse(rows[0].detail)
// Nível completo (padrão do Quick Request): modelo, o que foi enviado e a resposta.
assert.equal(detail.template.body, '{"nome":"VVPost"}')
assert.equal(detail.sent.url, target)
assert.equal(JSON.parse(detail.response.body).method, 'POST')
for (const row of rows) assert.ok(!row.detail.includes('segredo'), 'o segredo foi gravado no histórico')
rmSync(userData, { recursive: true, force: true })
console.log('E2E do Quick Request: ok')
