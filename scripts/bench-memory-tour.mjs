#!/usr/bin/env node
// Memória depois de usar o app: abre o projeto de demonstração contra a
// API de mentira, passa por todos os módulos (com uma requisição enviada, o fluxo e os cenários
// rodados), volta ao Quick Request e devolve o foco à janela 20 vezes (o workspace é relido a cada
// foco: um módulo oculto que refaz trabalho pesado nessa hora vaza, como a Documentação fazia).
// Mede a memória somada dos processos (a mesma da status bar, src/main/memory.ts), o heap JS e os
// nós do DOM do renderer depois do GC, e grava bench-memory-tour.json. Só reporta, não falha.
// Uso: npm run build && node scripts/bench-memory-tour.mjs   (Linux sem display: xvfb-run -a)
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
const workspace = mkdtempSync(join(tmpdir(), 'vvpost-memtour-ws-'))
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
for (const env of ['dev', 'staging']) {
  const file = join(workspace, `environments/${env}.env.json`)
  writeFileSync(file, readFileSync(file, 'utf8').replace('http://127.0.0.1:4010', origin))
}
mkdirSync(join(workspace, '.vvpost'))
writeFileSync(join(workspace, '.vvpost/secrets.local.json'), JSON.stringify({ 'env.dev': { CLIENT_SECRET: 'demo-secret' } }))
const userData = mkdtempSync(join(tmpdir(), 'vvpost-memtour-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--js-flags=--expose-gc', '--enable-precise-memory-info', `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_MCP_PORT: '0' }
})
const samples = {}
const byModule = {}
try {
  const win = await app.firstWindow()
  const nav = win.getByRole('navigation', { name: 'Módulos', exact: true })
  await nav.waitFor()
  const panel = win.locator('main > div:not([hidden])')
  const labels = await nav.locator('button[data-panel]').evaluateAll((els) => els.map((b) => b.getAttribute('aria-label')))
  const [home] = labels

  const sample = async () => {
    await win.evaluate(() => globalThis.gc?.())
    await win.waitForTimeout(1500)
    const usage = await win.evaluate(() => window.vvpost.getResourceUsage())
    const heapMB = await win.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576))
    const nodes = await win.evaluate(() => document.getElementsByTagName('*').length)
    return { totalMB: usage.totalMemoryMB, byProcessType: usage.byProcessType, heapMB, nodes }
  }

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

  samples.boot = await sample()
  let before = samples.boot.totalMB
  for (const label of labels) {
    await nav.getByRole('button', { name: label, exact: true }).click()
    await win.waitForTimeout(500)
    await prepare[label]?.().catch((e) => console.warn(`${label}: ${e.message.split('\n')[0]}`))
    const s = await sample()
    byModule[label] = { totalMB: s.totalMB, deltaMB: Math.round((s.totalMB - before) * 10) / 10, heapMB: s.heapMB }
    before = s.totalMB
  }
  samples.tour = await sample()
  await nav.getByRole('button', { name: home, exact: true }).click()
  for (let i = 0; i < 20; i++) {
    await win.evaluate(() => window.dispatchEvent(new Event('focus')))
    await win.waitForTimeout(300)
  }
  samples.focus = await sample()
} finally {
  await app.close()
  server.close()
  for (const d of [userData, workspace]) rmSync(d, { recursive: true, force: true })
}

writeFileSync(join(root, 'bench-memory-tour.json'), JSON.stringify({ samples, byModule }, null, 2))
console.log('\nMemória ao abrir cada módulo (MB, depois do GC)')
console.table(byModule)
console.table(
  Object.fromEntries(
    Object.entries(samples).map(([k, s]) => [k, { totalMB: s.totalMB, heapMB: s.heapMB, nodes: s.nodes, ...s.byProcessType }])
  )
)
