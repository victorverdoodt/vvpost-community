#!/usr/bin/env node
// Teste ponta a ponta dos dados pessoais mascarados para pessoas no app real (build de produção em
// out/): um workspace com `people.mask` no .vvpost/privacy.json e um schema com campos x-sensitive.
// O cenário e o Quick Request mostram a resposta mascarada, o histórico grava mascarado, e o
// servidor recebe o valor real.
// Uso: npm run build && node scripts/e2e-pii-people.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const CPF = '529.982.247-25'
const NAME = 'Ana Souza'
const PLACEHOLDER = '[REDACTED_PII:cpf]'

const received = []
const server = createServer((req, res) => {
  received.push(req.url)
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ id: 7, nome: NAME, cpf: CPF, cidade: 'São Paulo' }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('.vvpost/privacy.json', { people: { mask: true } })
put('schemas/Cliente.schema.json', {
  type: 'object',
  properties: { id: { type: 'integer' }, nome: { type: 'string', 'x-sensitive': 'name' }, cpf: { type: 'string', 'x-sensitive': 'cpf' } }
})
put('connectors/crm.connector.vvpost.json', {
  id: 'crm',
  name: 'CRM',
  version: '1.0.0',
  config: { baseUrl: origin },
  endpoints: [
    {
      id: 'cliente',
      name: 'Buscar cliente',
      method: 'GET',
      path: '/clientes/7',
      query: { cpf: CPF },
      scenarios: [
        {
          id: 'ok',
          name: 'Cliente existe',
          assertions: [
            { target: 'status', operator: 'equals', expected: 200 },
            { target: 'body.cpf', operator: 'equals', expected: '000.000.000-00' }
          ]
        }
      ]
    }
  ]
})

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, workspace)

  // Cenário: a asserção que falhou mostra o recebido mascarado, também na mensagem.
  await win.getByRole('button', { name: 'Cenários de teste' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Abrir workspace…' }).click()
  await panel.locator('select[aria-label="Conector"]').selectOption('crm')
  await panel.getByText('Cliente existe').waitFor()
  await panel.getByRole('button', { name: /^Rodar 1 cenário/ }).click()
  await panel.getByText('1 falharam').waitFor()
  await panel.getByRole('button', { name: /^Cliente existe em / }).click()
  const detail = panel.getByRole('region', { name: 'Detalhe do cenário' })
  const failure = detail.getByRole('group', { name: 'Primeira asserção que falhou' })
  await failure.getByLabel('Recebido').waitFor()
  assert.equal(await failure.getByLabel('Recebido').textContent(), `"${PLACEHOLDER}"`)
  assert.ok(!(await panel.textContent()).includes(CPF), 'CPF à vista no detalhe do cenário')

  // Quick Request contra a mesma API: a resposta na tela sai mascarada.
  await win.getByRole('navigation', { name: 'Módulos' }).getByRole('button', { name: 'Quick Request' }).click()
  await win.fill('input[aria-label="URL"]', `${origin}/clientes/7?cpf=${CPF}`)
  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  // O <pre> da resposta no módulo à vista: o do cenário (oculto, montado antes) também é um <pre>.
  const body = panel.locator('pre').first()
  await body.waitFor()
  const shown = JSON.parse(await body.textContent())
  assert.deepEqual(shown, { id: 7, nome: '[REDACTED_PII:name]', cpf: PLACEHOLDER, cidade: 'São Paulo' })

  // A rede recebeu o valor real; o histórico guardou mascarado.
  assert.ok(received.some((u) => decodeURIComponent(u).includes(CPF)), 'o valor real não foi para a rede')
  const runs = await win.evaluate(() => window.vvpost.listHistory({}))
  assert.ok(runs.length >= 2, 'as execuções não entraram no histórico')
  for (const run of runs) {
    const full = await win.evaluate((id) => window.vvpost.getHistoryRun(id), run.id)
    assert.ok(!JSON.stringify(full).includes(CPF), `CPF no histórico (${run.source})`)
    assert.ok(!JSON.stringify(full).includes(NAME), `nome no histórico (${run.source})`)
  }
  assert.ok(!(await win.content()).includes(NAME), 'nome à vista na tela')
  assert.deepEqual(errors, [])
  console.log(`e2e pii-people: ok (${runs.length} execuções no histórico, ${received.length} requisições)`)
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
