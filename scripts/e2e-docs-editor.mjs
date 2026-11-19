#!/usr/bin/env node
// Teste ponta a ponta do editor da documentação do projeto (estilo Overleaf) no app real (build de
// produção em out/): a aba Editor do módulo Documentação abre o documento de partida, compila o
// PDF da prévia, aponta a diretiva com erro no log, insere um endpoint e um trecho de outra doc
// pelo menu Inserir, aplica o modelo (título, organização, logo, cabeçalho), salva os dois
// arquivos sem segredo, exporta o PDF com capa, logo, cabeçalho e os trechos, e a visualização
// do projeto passa a mostrar o documento no padrão do modelo.
// Uso: npm run build && node scripts/e2e-docs-editor.mjs   (Linux sem display: xvfb-run -a)
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
const VAULT_SECRET = `vault-${Math.random().toString(36).slice(2)}-Ed7`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-docs-editor-'))
const out = mkdtempSync(join(tmpdir(), 'vvpost-docs-editor-out-'))
const put = (path, data) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}
put('connectors/billing.connector.vvpost.json', {
  id: 'connector.billing.v2',
  name: 'Billing Service v2',
  version: '2.0.0',
  config: { baseUrl: '{{BASE_URL}}', basePath: '/billing/v2', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
  endpoints: [
    {
      id: 'charge_customer',
      name: 'Efetuar Cobrança',
      method: 'POST',
      path: '/customers/{customerId}/charges',
      body: { amount: 150, method: 'PIX' },
      scenarios: [{ id: 'ok', name: 'Cobrança aprovada', assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }]
    }
  ]
})
put(
  'connectors/billing.connector.vvpost.md',
  ['# Guia do Billing', '', 'Visão geral.', '', '## Cobrar {#charge_customer}', '', 'Cobra e devolve PENDENTE-XYZ.'].join('\n')
)
put('docs/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#0B5FFF"/></svg>')
put('environments/dev.env.json', {
  id: 'dev',
  name: 'Desenvolvimento',
  variables: {
    BASE_URL: { type: 'string', value: 'https://dev.api.empresa.com' },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
})
put('.vvpost/secrets.local.json', { dev: { API_TOKEN: VAULT_SECRET } })

/** Texto de um PDF pelo pdf.js (o mesmo da prévia), para conferir o que foi impresso. */
async function pdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
  const pages = []
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent()
    pages.push(content.items.map((i) => i.str).join(' '))
  }
  return { pages: doc.numPages, text: pages.join('\n') }
}

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_MCP_PORT: '0' }
})
try {
  const win = await app.firstWindow()
  // O tamanho padrão do app (1280x800) mesmo numa tela de 1024x768, a do runner Windows: lá o editor
  // estreito quebrava a diretiva em duas linhas na tela e o teste não achava a linha inteira.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ dialog }) => {
    globalThis.__save = []
    dialog.showSaveDialog = async () => globalThis.__save.shift() ?? { canceled: true }
  })
  const saveTo = (path) => app.evaluate((_e, p) => globalThis.__save.push({ canceled: false, filePath: p }), path)

  const nav = win.getByRole('navigation', { name: 'Módulos' })
  await nav.getByRole('button', { name: 'Documentação' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('radio', { name: 'Editor' }).click()
  const editor = panel.getByRole('region', { name: 'Editor da documentação do projeto' })
  await editor.locator('[data-editor="monaco"]').waitFor()
  await editor.getByText('novo, não salvo').waitFor()
  // O documento de partida compila sozinho: a prévia é o PDF de verdade, com capa.
  const pages = editor.locator('[data-testid="pdf-pages"] canvas')
  // Capa e conteúdo.
  await pages.nth(1).waitFor({ timeout: 60_000 })
  const log = editor.getByRole('log', { name: 'Log da compilação' })
  await log.getByText('sem problemas').waitFor()

  // Prévia | Raw | Lado a lado, como no VS Code: Raw esconde o PDF, Prévia esconde o texto.
  const views = editor.getByRole('radiogroup', { name: 'Visualização do documento' })
  const pdfRegion = editor.getByRole('region', { name: 'Prévia em PDF' })
  await views.getByRole('radio', { name: 'Raw' }).click()
  await pdfRegion.waitFor({ state: 'hidden' })
  await views.getByRole('radio', { name: 'Prévia' }).click()
  await pdfRegion.waitFor()
  assert.equal(await editor.locator('.monaco-editor').isVisible(), false)
  await views.getByRole('radio', { name: 'Lado a lado' }).click()
  await editor.locator('.monaco-editor').waitFor()

  // Editor de Markdown simplificado: a barra formata a seleção, sem lembrar a sintaxe.
  const toolbar = editor.getByRole('toolbar', { name: 'Formatação do Markdown' })
  // O Monaco redesenha as linhas no quadro seguinte: espera o texto aparecer.
  const lines = async (re) => {
    let text = ''
    for (let i = 0; i < 50 && !re.test(text); i++) {
      if (i) await win.waitForTimeout(100)
      text = (await editor.locator('.monaco-editor .view-lines').innerText()).replace(/\u00a0/g, ' ')
    }
    return text
  }
  await editor.locator('.monaco-editor').click()
  await win.keyboard.press('Control+End')
  await win.keyboard.type('\n\nSeção da barra')
  await win.keyboard.press('Shift+Home')
  await toolbar.getByRole('button', { name: 'Negrito (Ctrl+B)' }).click()
  assert.match(await lines(/\*\*Seção da barra\*\*/), /\*\*Seção da barra\*\*/)
  await toolbar.getByRole('button', { name: 'Título 2' }).click()
  assert.match(await lines(/## \*\*Seção da barra\*\*/), /## \*\*Seção da barra\*\*/)
  await win.keyboard.press('End')
  await win.keyboard.press('Enter')
  await win.keyboard.press('Enter')
  await toolbar.getByRole('button', { name: 'Lista', exact: true }).click()
  await win.keyboard.type('primeiro item')
  assert.match(await lines(/- primeiro item/), /- primeiro item/)

  // A prévia alterna entre a página (como em Visualizar) e o PDF; duplo clique num título leva ao texto.
  const formats = editor.getByRole('radiogroup', { name: 'Formato da prévia' })
  await formats.getByRole('radio', { name: 'Página' }).click()
  const page = editor.getByRole('region', { name: 'Prévia do documento' })
  await page.getByRole('heading', { name: /Seção da barra/ }).waitFor({ timeout: 30_000 })
  await pdfRegion.waitFor({ state: 'detached' })
  await views.getByRole('radio', { name: 'Prévia' }).click()
  assert.equal(await editor.locator('.monaco-editor').isVisible(), false)
  await page.getByRole('heading', { name: /Seção da barra/ }).dblclick()
  await editor.locator('.monaco-editor').waitFor()
  assert.equal(await views.getByRole('radio', { name: 'Lado a lado' }).getAttribute('aria-checked'), 'true')
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-pagina.png') })
  await formats.getByRole('radio', { name: 'PDF' }).click()
  await pages.first().waitFor({ timeout: 60_000 })

  // Uma diretiva com erro: o log aponta o arquivo e a linha.
  await editor.locator('.monaco-editor').click()
  await win.keyboard.press('Control+End')
  await win.keyboard.type('\n\n{{> endpoint connector.billing.v2/nada')
  await win.keyboard.press('Escape')
  await win.keyboard.type('}}\n')
  await win.keyboard.press('Control+Enter')
  await log.getByText(/endpoint "connector\.billing\.v2\/nada" não existe/).waitFor({ timeout: 30_000 })
  await log.getByText(/docs\/projeto\.md:\d+/).waitFor()

  // Inserir: um endpoint e um trecho da doc do conector, pelo menu.
  const insert = async (...path) => {
    await editor.getByRole('button', { name: 'Inserir' }).click()
    for (const [i, name] of path.entries()) {
      const item = win.getByRole('menuitem', { name }).first()
      await item.waitFor()
      if (i < path.length - 1) await item.press('ArrowRight')
      else await item.click()
    }
  }
  await editor.locator('.monaco-editor').click()
  await win.keyboard.press('Control+End')
  await insert('Endpoint', /Billing Service v2/, /POST Efetuar Cobrança/)
  await insert('Trecho de outra doc', /connectors\/billing\.connector\.vvpost\.md/, /Cobrar/)
  const included = /\{\{> include connectors\/billing\.connector\.vvpost\.md#charge_customer\}\}/
  const text = await lines(included)
  assert.match(text, /\{\{> endpoint connector\.billing\.v2\/charge_customer\}\}/)
  assert.match(text, included)

  // O mouse sobre a diretiva mostra o trecho que ela monta; Ctrl+clique abre o arquivo dele na seção.
  // Linhas em branco embaixo: a diretiva fica inteira à vista (um clique na linha cortada rola o editor e cancela o gesto).
  await win.keyboard.press('Control+End')
  await win.keyboard.type('\n\n\n\n')
  const includeLine = editor.locator('.view-line', { hasText: 'billing.connector.vvpost.md#charge_customer' })
  await includeLine.hover({ position: { x: 40, y: 6 } })
  const hover = win.locator('.monaco-hover').filter({ hasText: 'Cobra e devolve PENDENTE-XYZ' })
  await hover.waitFor({ timeout: 30_000 })
  assert.match(await hover.innerText(), /Ctrl\+clique abre connectors\/billing\.connector\.vvpost\.md, na seção charge_customer/)
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-heranca-previa.png') })
  await win.keyboard.press('Escape')
  // O Monaco acha os links um pouco depois da última tecla: espera o sublinhado da diretiva.
  await includeLine.locator('.detected-link').first().waitFor()
  const box = await includeLine.boundingBox()
  await win.keyboard.down('Control')
  await win.mouse.click(box.x + 40, box.y + 6)
  await win.keyboard.up('Control')
  const guide = win.getByRole('region', { name: 'Documento connectors/billing.connector.vvpost.md' })
  await guide.locator('.monaco-editor').waitFor()
  await guide.locator('.line-numbers.active-line-number', { hasText: /^5$/ }).waitFor()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-heranca-aberta.png') })
  // De volta ao editor do documento: o texto não salvo continua lá.
  await nav.getByRole('button', { name: 'Documentação' }).click()
  assert.match(await lines(included), included)

  // A prévia ligada ao texto, como a prévia de Markdown do VS Code: embaixo de cada diretiva, o texto
  // mostra o trecho que ela monta; um clique num trecho da prévia mostra e destaca as linhas de onde
  // ele veio (a diretiva, para um trecho incluído), e o duplo clique põe o cursor lá.
  const inlineCard = editor.locator('.doc-inline-card', { hasText: 'trecho de outra doc' })
  await inlineCard.waitFor({ timeout: 30_000 })
  assert.match(await inlineCard.innerText(), /Cobra e devolve PENDENTE-XYZ/)
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-previa-inline.png') })
  await formats.getByRole('radio', { name: 'Página' }).click()
  const fromInclude = page.locator('[data-line]', { hasText: 'Cobra e devolve PENDENTE-XYZ' }).last()
  await fromInclude.waitFor({ timeout: 30_000 })
  await fromInclude.click()
  const flash = editor.locator('.view-overlays .doc-source-flash')
  await flash.waitFor()
  const top = (l) => l.evaluate((e) => e.getBoundingClientRect().top)
  assert.ok(Math.abs((await top(flash)) - (await top(includeLine))) < 2, 'o clique na prévia destaca a linha da diretiva')
  await fromInclude.dblclick()
  await editor.locator('.line-numbers.active-line-number', { hasText: /^27$/ }).waitFor()
  // O bloco da linha do cursor fica marcado na prévia.
  await page.locator('.doc-active-block').first().waitFor()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-previa-clique.png') })
  // Rolagem junto: a prévia no começo leva o texto ao começo, e no fim, ao fim.
  const firstLine = () =>
    editor.locator('.line-numbers').evaluateAll((els) => {
      const top = els[0]?.closest('.monaco-editor')?.getBoundingClientRect().top ?? 0
      return Math.min(...els.filter((e) => e.getBoundingClientRect().top >= top && Number(e.textContent) > 0).map((e) => Number(e.textContent)))
    })
  await page.evaluate((e) => (e.scrollTop = 0))
  for (let i = 0; i < 30 && (await firstLine()) > 2; i++) await win.waitForTimeout(100)
  assert.ok((await firstLine()) <= 2, 'a prévia no começo leva o texto ao começo')
  await page.evaluate((e) => (e.scrollTop = e.scrollHeight))
  for (let i = 0; i < 30 && (await firstLine()) < 15; i++) await win.waitForTimeout(100)
  assert.ok((await firstLine()) >= 15, 'a prévia no fim leva o texto ao fim')
  // O olho da barra tira e devolve as prévias do texto.
  await toolbar.getByRole('button', { name: /Esconder as prévias/ }).click()
  await inlineCard.waitFor({ state: 'detached' })
  await toolbar.getByRole('button', { name: /Mostrar no texto/ }).click()
  await inlineCard.waitFor()
  await formats.getByRole('radio', { name: 'PDF' }).click()
  await pages.first().waitFor({ timeout: 60_000 })

  // Estilo: título, organização, logo e cabeçalho.
  await editor.getByRole('radio', { name: 'Estilo' }).click()
  const form = editor.getByRole('form', { name: 'Estilo da documentação' })
  await form.getByText('nenhuma escolhida (texto livre)').waitFor()
  await form.getByLabel('Título', { exact: true }).fill('API de Cobranças')
  await form.getByLabel('Organização', { exact: true }).fill('Equipe Pagamentos')
  await form.getByLabel('Versão', { exact: true }).fill('3.1')
  await form.getByRole('group', { name: 'Documento' }).getByLabel('Logo', { exact: true }).selectOption('docs/logo.svg')
  const header = form.getByRole('group', { name: 'Cabeçalho' })
  await header.getByLabel('Direita', { exact: true }).fill('{{organization}} · v{{version}}')
  await header.getByLabel('Logo', { exact: true }).selectOption('left')
  await form.getByLabel('Numerar as seções', { exact: true }).check()
  await editor.getByText('não salvo').waitFor()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-modelo.png') })

  // Ctrl+S grava o modelo e o documento-fonte, sem segredo.
  await win.keyboard.press('Control+s')
  await win.getByText('Salvo em vvpost.docs.json e docs/projeto.md').waitFor()
  const config = JSON.parse(readFileSync(join(workspace, 'vvpost.docs.json'), 'utf8'))
  assert.equal(config.$schema, 'https://vvpost.dev/schemas/v1/docs.json')
  assert.deepEqual(
    { title: config.title, organization: config.organization, logo: config.logo, header: config.header, numberHeadings: config.numberHeadings },
    { title: 'API de Cobranças', organization: 'Equipe Pagamentos', logo: 'docs/logo.svg', header: { right: '{{organization}} · v{{version}}', logo: 'left' }, numberHeadings: true }
  )
  const source = readFileSync(join(workspace, 'docs/projeto.md'), 'utf8')
  assert.match(source, /\{\{> include connectors\/billing\.connector\.vvpost\.md#charge_customer\}\}/)
  assert.ok(!source.includes(VAULT_SECRET))

  await editor.getByRole('radio', { name: 'Documento' }).click()
  await pages.first().waitFor()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-editor.png') })

  // Exportar PDF: capa, logo, cabeçalho, numeração, o endpoint e o trecho incluído; nenhum segredo.
  const pdf = join(out, 'projeto.pdf')
  await saveTo(pdf)
  await editor.getByRole('button', { name: 'Exportar PDF' }).click()
  await win.getByText(`Documentação em PDF salva em ${pdf}`).waitFor({ timeout: 60_000 })
  const bytes = readFileSync(pdf)
  assert.ok(!bytes.includes(Buffer.from(VAULT_SECRET)))
  const printed = await pdfText(bytes)
  for (const expected of ['API de Cobranças', 'Equipe Pagamentos · v3.1', 'Efetuar Cobrança', 'Cobra e devolve PENDENTE', '1. Visão geral', 'Sumário']) {
    assert.ok(printed.text.includes(expected), `PDF sem "${expected}"`)
  }
  assert.ok(!printed.text.includes(VAULT_SECRET))
  assert.ok(printed.pages >= 3)
  if (screenshot) writeFileSync(screenshot.replace(/(\.png)?$/, '-projeto.pdf'), bytes)

  // .md exportado: o mesmo documento montado.
  const md = join(out, 'projeto.md')
  await saveTo(md)
  await editor.getByRole('button', { name: 'Exportar .md' }).click()
  await win.getByText(`Documentação em Markdown salva em ${md}`).waitFor()
  const exported = readFileSync(md, 'utf8')
  assert.match(exported, /^# API de Cobranças/)
  assert.match(exported, /PENDENTE-XYZ/)
  assert.ok(!/^\s*\{\{>.*\}\}\s*$/m.test(exported), 'diretiva sem montar no .md')

  // Visualizar: a documentação do projeto é o documento, no padrão do modelo; a referência fica a um clique.
  await panel.getByRole('radio', { name: 'Visualizar' }).click()
  const viewer = panel.getByRole('region', { name: 'Documentação gerada' })
  await viewer.locator('header h2').filter({ hasText: 'API de Cobranças' }).waitFor()
  const masthead = viewer.getByRole('banner', { name: 'Cabeçalho do modelo da documentação' }).or(viewer.getByLabel('Cabeçalho do modelo da documentação', { exact: true }))
  await masthead.getByRole('img', { name: 'Logo' }).waitFor()
  await viewer.getByText('PENDENTE-XYZ').first().waitFor()
  // Sumário fixo: aparece quando o sumário do texto sai da tela e some quando ele volta.
  const scroll = viewer.locator('#doc-scroll')
  const outline = viewer.getByRole('navigation', { name: 'Sumário fixo do documento' })
  assert.equal(await outline.count(), 0)
  await scroll.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await outline.waitFor()
  await outline.getByRole('button', { name: /Visão geral/ }).click()
  await outline.locator('[aria-current="location"]', { hasText: 'Visão geral' }).waitFor()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-sumario-fixo.png') })
  await viewer.getByRole('button', { name: 'Ir para o sumário do texto' }).click()
  await outline.waitFor({ state: 'detached' })
  await viewer.getByRole('radio', { name: 'Referência gerada' }).click()
  await viewer.locator('header h2').filter({ hasText: /^Documentação de / }).waitFor()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-visualizar.png') })

  // Testar: na referência, o endpoint abre no Quick Request; no documento do projeto também.
  await viewer.getByRole('button', { name: 'Testar Efetuar Cobrança no Quick Request' }).click()
  await win.waitForFunction(() =>
    [...document.querySelectorAll('input[aria-label="URL"]')].some((i) => i.offsetParent && i.value === '/customers/{customerId}/charges')
  )
  await nav.getByRole('button', { name: 'Documentação' }).click()
  await panel.getByRole('radio', { name: 'Documento do projeto' }).click()
  await panel.getByRole('button', { name: 'Testar Efetuar Cobrança no Quick Request' }).first().waitFor()

  // Modelos: uma metodologia pronta (C4) troca o texto e o formato e mantém título e organização.
  await panel.getByRole('radio', { name: 'Editor' }).click()
  await editor.getByRole('button', { name: 'Modelos' }).click()
  await win.getByRole('menuitem', { name: /^C4/ }).click()
  await win.getByRole('dialog').getByRole('button', { name: 'Usar o modelo' }).click()
  await win.getByText(/Modelo "C4.*" aplicado/).waitFor()
  // O texto do modelo entra com a rolagem de antes: volta ao começo para ver o primeiro diagrama.
  await editor.locator('.monaco-editor').click()
  await win.keyboard.press('Control+Home')
  await editor.locator('.monaco-editor .view-lines').getByText('C4Context').waitFor()
  await log.getByText('sem problemas').waitFor({ timeout: 30_000 })
  await editor.getByRole('button', { name: 'Salvar', exact: true }).click()
  const readConfig = () => JSON.parse(readFileSync(join(workspace, 'vvpost.docs.json'), 'utf8'))
  for (let i = 0; i < 100 && readConfig().subtitle === undefined; i++) await win.waitForTimeout(100)
  const c4 = readConfig()
  assert.equal(c4.title, 'API de Cobranças')
  assert.equal(c4.subtitle, 'Arquitetura no modelo C4')
  assert.equal(c4.methodology, 'C4 (contexto, contêineres, componentes)')
  // O botão Estilo da documentação, da visualização, abre o estilo com a metodologia em uso.
  await panel.getByRole('radio', { name: 'Visualizar' }).click()
  await panel.getByRole('button', { name: 'Estilo da documentação' }).click()
  await form.getByText('C4 (contexto, contêineres, componentes)', { exact: true }).waitFor()
  await editor.getByRole('radio', { name: 'Documento' }).click()
  // Os diagramas C4 do modelo (Mermaid) saem desenhados no PDF.
  const c4Pdf = join(out, 'c4.pdf')
  await saveTo(c4Pdf)
  await editor.getByRole('button', { name: 'Exportar PDF' }).click()
  await win.getByText(`Documentação em PDF salva em ${c4Pdf}`).waitFor({ timeout: 60_000 })
  // O pdf.js quebra o texto dos SVGs em pedaços: compara sem espaços.
  const c4Text = (await pdfText(readFileSync(c4Pdf))).text.replace(/\s+/g, '')
  for (const expected of ['Arquitetura no modelo C4', 'Nossa API', 'API Gateway', 'Banco de dados']) {
    assert.ok(c4Text.includes(expected.replace(/\s+/g, '')), `PDF do C4 sem "${expected}"`)
  }
  assert.ok(!c4Text.includes('Diagrama Mermaid inválido'))
  if (screenshot) {
    writeFileSync(screenshot.replace(/(\.png)?$/, '-c4.pdf'), readFileSync(c4Pdf))
    await win.screenshot({ path: screenshot.replace(/(\.png)?$/, '-c4.png') })
  }

  // O próprio padrão: salvo no projeto, volta na lista de modelos.
  await editor.getByRole('button', { name: 'Modelos' }).click()
  await win.getByRole('menuitem', { name: 'Salvar como modelo do projeto…' }).click()
  const ask = win.getByRole('dialog')
  await ask.getByRole('textbox').fill('Padrão do Time')
  await ask.getByRole('button', { name: 'Salvar' }).click()
  await win.getByText('Modelo "Padrão do Time" salvo em docs/templates/padrao-do-time.doc-template.vvpost.json').waitFor()
  const own = JSON.parse(readFileSync(join(workspace, 'docs/templates/padrao-do-time.doc-template.vvpost.json'), 'utf8'))
  assert.equal(own.name, 'Padrão do Time')
  assert.match(own.source, /C4Context/)
  await editor.getByRole('button', { name: 'Modelos' }).click()
  await win.getByRole('menuitem', { name: 'Padrão do Time' }).waitFor()
  await win.keyboard.press('Escape')
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
rmSync(userData, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
rmSync(out, { recursive: true, force: true })
console.log('E2E do editor de documentação: ok')
