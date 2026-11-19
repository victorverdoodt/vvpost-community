#!/usr/bin/env node
// Auditoria visual e de contratos: abre o projeto de demonstração
// (examples/demo-workspace) contra a API de mentira, passa por todos os módulos em 100%, 125% e
// 150% de zoom, salva uma captura de cada um e um inventário do que diverge entre módulos:
// estilos de botão e de aba, texto cortado ou fora da janela, rótulos em inglês e controles sem
// nome acessível. O relatório fica em report.json e report.md.
// Uso: npm run build && node scripts/ux-audit.mjs [pasta de saída]   (Linux sem display: xvfb-run -a)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { demoServer } from './demo-server.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const out = resolve(process.argv[2] ?? join(root, 'out/ux-audit'))
mkdirSync(out, { recursive: true })

const server = demoServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-demo-'))
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
for (const env of ['dev', 'staging']) {
  const file = join(workspace, `environments/${env}.env.json`)
  writeFileSync(file, readFileSync(file, 'utf8').replace('http://127.0.0.1:4010', origin))
}
mkdirSync(join(workspace, '.vvpost'))
writeFileSync(join(workspace, '.vvpost/secrets.local.json'), JSON.stringify({ 'env.dev': { CLIENT_SECRET: 'demo-secret' } }))
const userData = mkdtempSync(join(tmpdir(), 'vvpost-audit-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))

/** Inventário da tela visível, rodado na página. */
function inventory() {
  const panel = document.querySelector('main > div:not([hidden])') ?? document.body
  const visible = (el) => el.checkVisibility?.() && el.getBoundingClientRect().width > 0
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
  const style = (el) => {
    const s = getComputedStyle(el)
    return [
      `h${Math.round(el.getBoundingClientRect().height)}`,
      `${parseFloat(s.fontSize)}px/${s.fontWeight}`,
      `r${s.borderTopLeftRadius}`,
      s.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'bg-none' : `bg ${s.backgroundColor}`,
      s.borderTopWidth === '0px' ? 'sem borda' : `borda ${s.borderTopColor}`
    ].join(' · ')
  }
  const group = (els) => {
    const map = {}
    for (const el of els) (map[style(el)] ??= []).push(name(el))
    return Object.entries(map)
      .map(([k, v]) => ({ style: k, count: v.length, examples: [...new Set(v)].slice(0, 4) }))
      .sort((a, b) => b.count - a.count)
  }
  const buttons = [...panel.querySelectorAll('button')].filter(visible).filter((b) => b.textContent.trim())
  const tabs = [...panel.querySelectorAll('[role="tab"]')].filter(visible)
  const clipped = [...panel.querySelectorAll('*')]
    .filter(visible)
    .filter((el) => {
      const s = getComputedStyle(el)
      return el.children.length === 0 && el.textContent.trim() && s.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis'
    })
    .map(name)
  const outside = [...document.querySelectorAll('button, input, select, textarea, a')]
    .filter(visible)
    .filter((el) => {
      const r = el.getBoundingClientRect()
      return r.right > innerWidth + 1 || r.bottom > innerHeight + 1
    })
    .map(name)
  const english = /^(send|run|save|cancel|delete|remove|add|new|open|close|search|settings|headers|body|params|response|loading|error|success|failed|none|edit|copy|export|import)\b/i
  const englishLabels = [...panel.querySelectorAll('button, [role="tab"], label, th, h1, h2, h3')]
    .filter(visible)
    .map(name)
    .filter((t) => english.test(t))
  const unnamed = [...panel.querySelectorAll('button, input, select, textarea')]
    .filter(visible)
    .filter((el) => !el.getAttribute('aria-label') && !el.labels?.length && !el.textContent.trim() && !el.getAttribute('title') && el.type !== 'hidden')
    .map((el) => el.outerHTML.slice(0, 80))
  return {
    buttons: group(buttons),
    tabs: group(tabs),
    clipped: [...new Set(clipped)],
    outside: [...new Set(outside)],
    englishLabels: [...new Set(englishLabels)],
    unnamed,
    alerts: [...panel.querySelectorAll('[role="alert"]')].filter(visible).map(name),
    empty: [...panel.querySelectorAll('p, span')].filter(visible).map(name).filter((t) => /^(nenhum|nenhuma|sem |vazio)/i.test(t))
  }
}

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
const report = { modules: {} }
try {
  const win = await app.firstWindow()
  const nav = win.getByRole('navigation', { name: 'Módulos', exact: true })
  await nav.waitFor()
  const modules = await nav
    .locator('button[data-panel]')
    .evaluateAll((els) => els.map((b) => b.getAttribute('aria-label')))
  const panel = win.locator('main > div:not([hidden])')
  const slug = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase()

  // Estados com conteúdo, não só as telas vazias: uma requisição enviada, um fluxo e cenários rodados.
  const prepare = {
    'Quick Request': async () => {
      await panel.locator('select[aria-label="Conector"]').selectOption('connector.payments.v1')
      await panel.locator('select[aria-label="Endpoint"]').selectOption('create_charge').catch(() => {})
      await panel.getByRole('button', { name: /Enviar/ }).first().click()
      await win.waitForTimeout(800)
    },
    'Flow Studio': async () => {
      await panel.getByRole('button', { name: /Rodar fluxo/ }).click()
      await win.waitForTimeout(1200)
      await panel.getByTestId('flow-node-Charge').click().catch(() => {})
    },
    'Cenários de teste': async () => {
      await panel.locator('select[aria-label="Conector"]').selectOption('connector.payments.v1')
      await panel.getByRole('button', { name: /^Rodar \d+ cenários/ }).click()
      await win.waitForTimeout(1500)
    },
    Catálogo: async () => {
      await panel.getByRole('button', { name: /Payments Service v1/ }).first().click()
      await win.waitForTimeout(300)
    }
  }
  const prepared = new Set()

  for (const zoom of [1, 1.25, 1.5]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    for (const label of modules) {
      await nav.getByRole('button', { name: label, exact: true }).click()
      await win.waitForTimeout(400)
      if (!prepared.has(label) && prepare[label]) {
        prepared.add(label)
        await prepare[label]().catch((e) => (report.modules[label] = { ...report.modules[label], prepareError: e.message.split('\n')[0] }))
      }
      const file = `${slug(label)}-${Math.round(zoom * 100)}.png`
      // A captura vem do Electron: a do Playwright corta a janela quando há zoom.
      const png = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')
      )
      writeFileSync(join(out, file), Buffer.from(png, 'base64'))
      const inv = await win.evaluate(inventory)
      const entry = (report.modules[label] ??= {})
      if (zoom === 1) Object.assign(entry, inv)
      ;(entry.zoom ??= {})[zoom] = { screenshot: file, clipped: inv.clipped, outside: inv.outside }
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))

  // Estilos de botão e de aba que aparecem em só um módulo: candidatos a divergência.
  const where = (key) => {
    const map = {}
    for (const [m, inv] of Object.entries(report.modules)) for (const g of inv[key] ?? []) (map[g.style] ??= new Set()).add(m)
    return map
  }
  report.buttonStyles = Object.entries(where('buttons')).map(([style, ms]) => ({ style, modules: [...ms] }))
  report.tabStyles = Object.entries(where('tabs')).map(([style, ms]) => ({ style, modules: [...ms] }))
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}

writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
const lines = ['# Inventário automático da auditoria', '']
for (const [m, inv] of Object.entries(report.modules)) {
  lines.push(`## ${m}`, '')
  if (inv.prepareError) lines.push(`- Preparação falhou: ${inv.prepareError}`)
  lines.push(`- Estilos de botão: ${inv.buttons?.length ?? 0}; de aba: ${inv.tabs?.length ?? 0}`)
  for (const [z, v] of Object.entries(inv.zoom ?? {})) {
    if (v.clipped.length || v.outside.length) lines.push(`- Zoom ${z}: cortados ${JSON.stringify(v.clipped)}; fora da janela ${JSON.stringify(v.outside)}`)
  }
  if (inv.englishLabels?.length) lines.push(`- Rótulos em inglês: ${inv.englishLabels.join(', ')}`)
  if (inv.unnamed?.length) lines.push(`- Controles sem nome acessível: ${inv.unnamed.length}`)
  if (inv.alerts?.length) lines.push(`- Alertas: ${inv.alerts.join(' | ')}`)
  lines.push('')
}
lines.push('## Estilos de botão', '', ...report.buttonStyles.map((b) => `- ${b.style}: ${b.modules.join(', ')}`), '')
lines.push('## Estilos de aba', '', ...report.tabStyles.map((b) => `- ${b.style}: ${b.modules.join(', ')}`), '')
writeFileSync(join(out, 'report.md'), `${lines.join('\n')}\n`)
console.log(`Auditoria em ${out}`)
