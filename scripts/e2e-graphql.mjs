#!/usr/bin/env node
// Teste ponta a ponta do corpo GraphQL do Quick Request (fase 15) no app real (build de
// produção em out/): busca o schema por introspecção, confere o explorer e o autocomplete do
// Monaco pelo schema, e envia a consulta com variáveis como { query, variables }.
// Uso: npm run build && node scripts/e2e-graphql.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
const introspection = readFileSync(join(root, 'test/fixtures/graphql/introspection.json'), 'utf8')

const received = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    const data = JSON.parse(body || '{}')
    received.push({ type: req.headers['content-type'], data })
    if (data.operationName === 'IntrospectionQuery') return res.end(introspection)
    res.end(JSON.stringify({ data: { user: { name: `Ana (${data.variables?.id})` } } }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/graphql`

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  await win.selectOption('select[aria-label="Método HTTP"]', 'POST')
  await win.fill('input[aria-label="URL"]', url)
  await win.getByRole('tab', { name: /^Body/ }).click()
  await win.getByRole('radio', { name: 'GraphQL' }).click()
  const body = win.getByRole('group', { name: 'Corpo GraphQL' })
  await body.locator('[data-editor="monaco"]').waitFor({ timeout: 20_000 })

  const schema = win.getByRole('complementary', { name: 'Schema GraphQL' })
  await schema.getByRole('button', { name: 'Buscar schema' }).click()
  await schema.getByText('7 tipos').waitFor({ timeout: 10_000 })
  assert.equal(received[0].data.operationName, 'IntrospectionQuery')
  assert.equal(received[0].type, 'application/json')
  // Explorer: abre Query e mostra os campos com o tipo do SDL.
  await schema.getByRole('button', { name: /^Query/ }).click()
  const fields = schema.getByRole('list', { name: 'Campos de Query' })
  await fields.getByText('[User!]!').waitFor()

  // Autocomplete do Monaco pelo schema: dentro da seleção de user, os campos de User.
  const editor = body.locator('.monaco-editor textarea').first()
  await editor.focus()
  await win.keyboard.insertText('query Q($id: ID!) { user(id: $id) { ')
  await win.keyboard.press('Control+Space')
  const suggest = win.locator('.suggest-widget')
  await suggest.getByText('posts', { exact: true }).waitFor({ timeout: 10_000 })
  await suggest.getByText('role', { exact: true }).waitFor()
  await win.keyboard.press('Escape')
  await win.keyboard.press('Control+A')
  await win.keyboard.insertText('query Q($id: ID!) { user(id: $id) { name } }')
  await win.fill('textarea[aria-label="Variáveis GraphQL"]', '{ "id": "7" }')

  await win.getByRole('button', { name: 'Enviar' }).click()
  await win.getByText('200 OK').waitFor()
  await win.getByText('Ana (7)').first().waitFor()
  const sent = received.at(-1).data
  assert.deepEqual(sent, { query: 'query Q($id: ID!) { user(id: $id) { name } }', variables: { id: '7' } })
  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  server.close()
}
rmSync(userData, { recursive: true, force: true })
console.log('E2E do GraphQL: ok')
