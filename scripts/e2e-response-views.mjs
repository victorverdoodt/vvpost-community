#!/usr/bin/env node
// E2E dos modos de visualização da resposta (ResponseViewer) no app real (build de produção em out/):
// Pretty com DataPicker, filtro JSONPath, busca, Raw, Hex, Cookies; Preview de HTML isolado (sem
// scripts nem rede), de imagem e de PDF; Visualize isolado; salvar a resposta em arquivo.
// Uso: npm run build && node scripts/e2e-response-views.mjs   (Linux sem display: xvfb-run -a ...)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')

const PNG = png(3, 2)
const PDF = pdf('Ola VVPost')
const beacons = []

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  if (path.startsWith('/beacon')) {
    beacons.push(path)
    res.end()
    return
  }
  const send = (type, body, headers = {}) => {
    res.writeHead(200, { 'content-type': type, ...headers })
    res.end(body)
  }
  switch (path) {
    case '/json':
      return send(
        'application/json',
        JSON.stringify({ name: 'VVPost', items: [{ id: 1, tag: 'alfa' }, { id: 2, tag: 'beta' }] }),
        { 'set-cookie': ['sid=abc123; Path=/; HttpOnly; SameSite=Lax'] }
      )
    case '/html':
      return send(
        'text/html; charset=utf-8',
        `<!doctype html><html><body><h1 id="t">Prévia HTML</h1>
         <img src="${origin}/beacon-img">
         <script>document.body.dataset.ran = '1'; fetch('${origin}/beacon-fetch')</script></body></html>`
      )
    case '/png':
      return send('image/png', PNG)
    case '/pdf':
      return send('application/pdf', PDF)
    case '/bin':
      return send('application/octet-stream', Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x41]))
    default:
      res.writeHead(404).end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const savedFile = join(userData, 'salvo.png')
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const body = win.getByRole('radiogroup', { name: 'Modo de visualização do corpo' })
  const mode = (name) => body.getByRole('radio', { name, exact: true }).click()
  const send = async (path) => {
    await win.fill('input[aria-label="URL"]', origin + path)
    await win.getByRole('button', { name: 'Enviar' }).click()
    await win.getByText('200 OK').waitFor()
  }

  // Pretty de JSON: o pre tem o JSON formatado; o seletor mostra a detecção automática.
  await send('/json')
  const pre = win.locator('pre[aria-label="Corpo da resposta"]')
  assert.deepEqual(JSON.parse(await pre.textContent()).items[1], { id: 2, tag: 'beta' })
  assert.equal(await win.locator('select[aria-label="Linguagem do Pretty"] option:checked').textContent(), 'Auto (JSON)')

  // Menu de valores do JSON: clicar num valor abre as ações; copiar path e filtrar por ele.
  const value = (text) => pre.locator('[data-pick]', { hasText: text })
  await value('"beta"').click()
  const menu = win.getByRole('menu')
  await menu.getByText('$.items[1].tag').waitFor()
  await menu.getByText('Navegação no JSON').waitFor()
  await menu.getByRole('menuitem', { name: /Copiar path/ }).click()
  await win.getByText('Path copiado').waitFor()
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '$.items[1].tag')

  // Atalhos com o valor selecionado (menu fechado): Ctrl+C copia o valor.
  await value('"alfa"').click({ button: 'right' })
  await menu.waitFor()
  await win.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  await win.keyboard.press('Control+c')
  // A cópia é assíncrona (navigator.clipboard): espera o aviso, como no Copiar path acima.
  await win.getByText('Valor copiado').waitFor()
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'alfa')

  // Recolher tudo, expandir um nó com clique, expandir tudo.
  await value('"VVPost"').click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Recolher tudo' }).click()
  assert.match(await pre.textContent(), /"items": \[… 2\]/)
  await pre.locator('[data-folded]').click()
  assert.match(await pre.textContent(), /\{… 2\}/)
  await value('"VVPost"').click()
  await win.getByRole('menuitem', { name: 'Expandir tudo' }).click()
  assert.deepEqual(JSON.parse(await pre.textContent()).items[0], { id: 1, tag: 'alfa' })

  await value('"beta"').click()
  await win.getByRole('menuitem', { name: 'Filtrar por este path' }).click()
  assert.equal(await win.locator('input[aria-label="Filtro JSONPath"]').inputValue(), '$.items[1].tag')
  assert.deepEqual(JSON.parse(await pre.textContent()), ['beta'])
  await win.fill('input[aria-label="Filtro JSONPath"]', '$.items[*].id')
  assert.deepEqual(JSON.parse(await pre.textContent()), [1, 2])
  await win.getByRole('button', { name: 'Limpar filtro' }).click()

  // Inserir na próxima requisição: aba nova com o valor no body; lá, o botão direito no body
  // abre o mesmo menu sobre o valor sob o cursor.
  await value('{').first().click()
  await win.getByRole('menuitem', { name: /Inserir na próxima requisição/ }).click()
  await win.getByRole('tab', { name: 'Body', exact: true }).click()
  const reqBody = win.locator('textarea[aria-label="Corpo da requisição"]')
  assert.deepEqual(JSON.parse(await reqBody.inputValue()).items[1], { id: 2, tag: 'beta' })
  const text = await reqBody.inputValue()
  await reqBody.focus()
  await reqBody.evaluate((el, at) => el.setSelectionRange(at, at), text.indexOf('"beta"') + 2)
  await reqBody.dispatchEvent('contextmenu', { clientX: 0, clientY: 0 })
  await win.getByRole('menu').getByText('$.items[1].tag').waitFor()
  assert.equal(await win.getByRole('menuitem', { name: /Usar como variável/ }).isDisabled(), true)
  await win.keyboard.press('Escape')

  // Ctrl+F no editor do body: as ocorrências pintadas atrás do texto, contador e navegação;
  // Esc volta ao editor com a ocorrência atual selecionada.
  await reqBody.focus()
  await win.keyboard.press('Control+f')
  const editorFind = win.locator('input[aria-label="Buscar em Corpo da requisição"]')
  await editorFind.fill('tag')
  await win.getByText('1 de 2').waitFor()
  await win.keyboard.press('Enter')
  await win.getByText('2 de 2').waitFor()
  await win.keyboard.press('Shift+Enter')
  await win.getByText('1 de 2').waitFor()
  assert.equal(await win.locator('[data-find-skip] mark').count(), 2)
  if (process.env.E2E_SCREENSHOT) await win.screenshot({ path: process.env.E2E_SCREENSHOT.replace(/(\.png)?$/, '-editor.png') })
  await win.keyboard.press('Escape')
  await editorFind.waitFor({ state: 'detached' })
  assert.equal(
    await reqBody.evaluate((el) => (document.activeElement === el ? el.value.slice(el.selectionStart, el.selectionEnd) : null)),
    'tag'
  )
  await win.getByRole('tab', { name: /^GET/ }).first().click()

  // Busca com Ctrl+F, contador e navegação.
  await pre.click()
  await win.keyboard.press('Control+f')
  await win.locator('input[aria-label="Buscar na resposta"]').fill('id')
  await win.getByText('1 de 2').waitFor()
  await win.keyboard.press('Enter')
  await win.getByText('2 de 2').waitFor()
  assert.equal(await pre.locator('mark').count(), 2)
  await win.keyboard.press('Escape')

  // Ctrl+F fora de um editor: a busca da tela, sobre o texto do módulo ativo (CSS Custom Highlight).
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await win.keyboard.press('Control+f')
  const pageFind = win.locator('input[aria-label="Buscar na tela"]')
  await pageFind.fill('VVPost')
  await win.getByRole('search').getByText(/^1 de \d+$/).waitFor()
  const total = Number((await win.getByRole('search').getByText(/^1 de \d+$/).textContent()).split(' de ')[1])
  // Os realces entram depois do paint do contador.
  await win.waitForFunction((n) => CSS.highlights.get('vv-find-current')?.size === 1 && CSS.highlights.get('vv-find')?.size === n - 1, total)
  if (process.env.E2E_SCREENSHOT) await win.screenshot({ path: process.env.E2E_SCREENSHOT.replace(/(\.png)?$/, '-tela.png') })
  await pageFind.fill('nada-com-isso')
  await win.getByRole('search').getByText('Nenhum').waitFor()
  await win.keyboard.press('Escape')
  await pageFind.waitFor({ state: 'detached' })
  await win.waitForFunction(() => !CSS.highlights.has('vv-find') && !CSS.highlights.has('vv-find-current'))

  // Raw, Hex e Cookies.
  await mode('Raw')
  assert.equal(await pre.textContent(), JSON.stringify({ name: 'VVPost', items: [{ id: 1, tag: 'alfa' }, { id: 2, tag: 'beta' }] }))
  await mode('Hex')
  assert.match(await pre.textContent(), /^00000000  7b 22 6e 61 6d 65 22 3a/)
  await win.getByRole('tab', { name: /Cookies \(1\)/ }).click()
  await win.getByRole('cell', { name: 'abc123' }).waitFor()
  await win.getByRole('tab', { name: 'Resposta', exact: true }).click()

  // Preview de HTML: renderiza, mas sem rodar scripts e sem tocar a rede.
  await mode('Pretty')
  await send('/html')
  await mode('Preview')
  const htmlFrame = win.frameLocator('iframe[title="Prévia do HTML"]')
  await htmlFrame.locator('#t').waitFor()
  assert.equal(await htmlFrame.locator('#t').textContent(), 'Prévia HTML')
  assert.equal(await htmlFrame.locator('body').getAttribute('data-ran'), null)
  assert.equal(await win.locator('iframe[title="Prévia do HTML"]').getAttribute('sandbox'), '')

  // Visualize: o template roda isolado, lê a resposta e não alcança a rede nem o app.
  await send('/json')
  await mode('Visualize')
  await win.getByRole('button', { name: 'Criar template' }).click()
  await win.locator('textarea[aria-label="Template do Visualize"]').fill(
    `<p id="n">{{name}} {{#each items}}[{{tag}}]{{/each}}</p><p id="s"></p><p id="iso"></p>
<script>
  document.getElementById('s').textContent = vv.response.status + ' ' + pm.response.json().items.length
  try { window.parent.document.title; document.getElementById('iso').textContent = 'vazou' }
  catch { document.getElementById('iso').textContent = 'isolado' }
  try { fetch('${origin}/beacon-visualize').catch(() => {}) } catch {}
  new Image().src = '${origin}/beacon-visualize-img'
</script>`
  )
  const vis = win.frameLocator('iframe[title="Visualização da resposta"]')
  await vis.locator('#iso').filter({ hasText: /\w/ }).waitFor()
  assert.equal(await vis.locator('#n').textContent(), 'VVPost [alfa][beta]')
  assert.equal(await vis.locator('#s').textContent(), '200 2')
  assert.equal(await vis.locator('#iso').textContent(), 'isolado')
  assert.equal(await win.locator('iframe[title="Visualização da resposta"]').getAttribute('sandbox'), 'allow-scripts')

  // Imagem: abre direto no Preview, com as dimensões.
  await send('/png')
  await win.getByRole('img', { name: 'Imagem da resposta' }).waitFor()
  await win.getByText('image/png · 3 × 2', { exact: false }).waitFor()

  // Salvar em arquivo grava os bytes originais.
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, savedFile)
  await win.getByRole('button', { name: 'Salvar resposta em arquivo' }).click()
  await win.getByText(`Resposta salva em ${savedFile}`).waitFor()
  assert.deepEqual(readFileSync(savedFile), PNG)

  // PDF: o pdf.js desenha a página em canvas.
  await send('/pdf')
  await win.getByText('PDF com 1 página').waitFor({ timeout: 15_000 })
  await win.locator('[data-testid="pdf-pages"] canvas').waitFor()

  // Binário sem prévia: o modo automático é o Hex.
  await send('/bin')
  assert.match(await pre.textContent(), /^00000000  de ad be ef 00 41/)

  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(beacons, [], `a prévia ou o Visualize acessaram a rede: ${beacons.join(', ')}`)
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  server.close()
}
rmSync(userData, { recursive: true, force: true })
console.log('E2E dos modos de visualização da resposta: ok')

/** PNG RGBA de w×h gerado na hora. */
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([139, 124, 255, 255], y * (w * 4 + 1) + 1 + x * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** PDF mínimo de uma página com texto, com a tabela xref certa. */
function pdf(text) {
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((obj, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
