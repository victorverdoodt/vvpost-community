#!/usr/bin/env node
// Teste ponta a ponta das conexões realtime (fase 15) no app real (build de produção em out/):
// abre um WebSocket pelo conector (caminho relativo, auth herdada), troca mensagens na tela de
// mensagens com {{VAR}} resolvida, conecta num namespace do Socket.IO e manda um evento, e recebe
// um stream SSE. O token do conector chega ao servidor e não aparece em nenhuma mensagem da tela.
// Uso: npm run build && node scripts/e2e-realtime.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { startRealtimeServer } from '../test/helpers/realtime-server.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT
const TOKEN = `tok-e2e-${Math.random().toString(16).slice(2)}`

const server = await startRealtimeServer()
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}
put('connectors/live.connector.vvpost.json', {
  id: 'live',
  name: 'Live',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{TOKEN}}' } },
  endpoints: []
})
put('environments/dev.env.json', {
  id: 'dev',
  name: 'Dev',
  variables: { BASE_URL: { type: 'string', value: server.url }, TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }, NOME: { type: 'string', value: 'Ana' } }
})
put('.vvpost/secrets.local.json', { dev: { TOKEN } })

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const quick = win.locator('main > div:not([hidden])')
  await quick.locator('select[aria-label="Conector"]').selectOption('live')
  await quick.locator('select[aria-label="Ambiente"]').selectOption('dev')
  const panel = () => win.locator('[role="tabpanel"]:not([hidden])')
  const messages = () => panel().getByRole('list', { name: 'Mensagens' })

  // WebSocket pelo conector: a baseUrl http vira ws, e o Bearer vai no handshake.
  await panel().locator('select[aria-label="Protocolo"]').selectOption('rt:websocket')
  await panel().locator('input[aria-label="URL"]').fill('/ws')
  await panel().getByRole('button', { name: 'Conectar' }).click()
  await panel().getByText('Conectado', { exact: true }).waitFor({ timeout: 10_000 })
  await messages().getByText('"hello":true').waitFor()
  await panel().locator('textarea[aria-label="Mensagem a enviar"]').fill('oi {{NOME}}')
  await panel().locator('textarea[aria-label="Mensagem a enviar"]').press('Control+Enter')
  await messages().getByText('echo:oi Ana').waitFor()
  assert.equal(await messages().getByRole('listitem').count(), 3)
  assert.equal(server.state.headers.at(-1).authorization, `Bearer ${TOKEN}`)
  const text = await messages().innerText()
  assert.ok(!text.includes(TOKEN), 'o token do conector apareceu numa mensagem')
  assert.match(text, /\[REDACTED_SECRET\]/)
  // A mensagem abre com o JSON formatado.
  await messages().getByRole('button', { name: /"hello":true/ }).click()
  await messages().locator('pre').getByText('"protocol": null').waitFor()
  if (screenshot) await win.screenshot({ path: screenshot })
  await panel().getByRole('button', { name: 'Desconectar' }).click()
  await panel().getByText('Fechado', { exact: true }).waitFor()

  // Socket.IO numa aba nova: o namespace no caminho e um evento com argumento JSON.
  await win.keyboard.press('Control+T')
  await panel().locator('select[aria-label="Protocolo"]').selectOption('rt:socketio')
  await panel().locator('input[aria-label="URL"]').fill('/admin')
  await panel().getByRole('button', { name: 'Conectar' }).click()
  await panel().getByText('namespace /admin · sid s-/admin').waitFor({ timeout: 10_000 })
  await panel().locator('input[aria-label="Nome do evento"]').fill('pedido')
  await panel().locator('textarea[aria-label="Mensagem a enviar"]').fill('{"id": 7}')
  await panel().getByRole('button', { name: 'Enviar mensagem' }).click()
  await messages().getByText('{"name":"pedido","args":[{"id":7}]}').waitFor()
  assert.ok(server.state.received.includes('42/admin,["pedido",{"id":7}]'))

  // SSE: os eventos chegam com o nome e o fim do stream fecha a conexão.
  await win.keyboard.press('Control+T')
  await panel().locator('select[aria-label="Protocolo"]').selectOption('rt:sse')
  await panel().locator('input[aria-label="URL"]').fill('/sse')
  await panel().getByRole('button', { name: 'Conectar' }).click()
  await messages().getByText('linha1').waitFor({ timeout: 10_000 })
  await panel().getByText('o servidor encerrou o stream').waitFor()
  assert.equal(await panel().getByLabel('Contagem de mensagens').innerText(), '3 recebidas')
  assert.equal(await panel().locator('textarea[aria-label="Mensagem a enviar"]').count(), 0)

  // Um upgrade recusado vira o aviso de erro da conexão.
  await win.keyboard.press('Control+T')
  await panel().locator('select[aria-label="Protocolo"]').selectOption('rt:websocket')
  await panel().locator('input[aria-label="URL"]').fill('/ws-401')
  await panel().getByRole('button', { name: 'Conectar' }).click()
  await panel().getByText('A conexão falhou').waitFor({ timeout: 10_000 })
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  await server.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
console.log('E2E das conexões realtime: ok')
