#!/usr/bin/env node
// Teste ponta a ponta das abas abertas quando um arquivo muda fora do app (build de produção em
// out/): um agente grava pelo MCP (aqui, a gravação direta no disco, que é o que o MCP faz). Sem
// mudanças na aba, o documento .md, o diagrama, o conector e o fluxo releem sozinhos, sem a janela
// perder o foco; com mudanças, a aba avisa e deixa escolher. O explorador vê o arquivo novo, e a
// própria gravação do app não vira aviso.
// Uso: npm run build && node scripts/e2e-disk-changes.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-disk-changes-'))
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
const file = (rel) => join(workspace, rel)
writeFileSync(file('docs/notas.md'), '# Notas\n\nPrimeira versão.\n')
const editJson = (rel, change) => {
  const data = JSON.parse(readFileSync(file(rel), 'utf8'))
  change(data)
  writeFileSync(file(rel), `${JSON.stringify(data, null, 2)}\n`)
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
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const bar = win.getByRole('tablist', { name: 'Abas do workspace' })
  const panel = win.locator('main > div:not([hidden])')
  await bar.getByRole('tab', { name: 'Nova requisição', exact: true }).waitFor()
  await win.keyboard.press('Control+Shift+E')
  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  await tree.getByRole('button', { name: 'notas.md' }).waitFor()

  // Documento sem mudanças na aba: a prévia segue o disco.
  await tree.getByRole('button', { name: 'notas.md' }).click()
  await panel.getByText('Primeira versão.').waitFor()
  writeFileSync(file('docs/notas.md'), '# Notas\n\nEscrito pelo agente.\n')
  await panel.getByText('Escrito pelo agente.').waitFor()

  // A própria gravação do app não vira aviso.
  await panel.getByText('Raw', { exact: true }).click()
  await panel.locator('.monaco-editor').waitFor()
  await panel.locator('.monaco-editor textarea').focus()
  await win.keyboard.press('Control+End')
  await win.keyboard.type('Linha minha.')
  await panel.getByText('não salvo').waitFor()
  await win.keyboard.press('Control+s')
  await panel.getByText('não salvo').waitFor({ state: 'detached' })
  await win.waitForTimeout(600)
  assert.equal(await panel.getByRole('alert').count(), 0, 'a gravação do app virou aviso de mudança externa')

  // Com mudanças na aba, o disco não passa por cima: a aba avisa, e "Recarregar do disco" traz a versão do agente.
  await panel.locator('.monaco-editor textarea').focus()
  await win.keyboard.type(' Mais uma.')
  await panel.getByText('não salvo').waitFor()
  writeFileSync(file('docs/notas.md'), '# Notas\n\nSegunda versão do agente.\n')
  const alert = panel.getByRole('alert').filter({ hasText: 'mudou fora do app' })
  await alert.waitFor()
  await alert.getByRole('button', { name: 'Recarregar do disco' }).click()
  await alert.waitFor({ state: 'detached' })
  await panel.getByText('não salvo').waitFor({ state: 'detached' })
  await panel.locator('.monaco-editor').getByText('Segunda versão do agente.').waitFor()

  // O explorador vê um documento novo sem a janela perder o foco.
  writeFileSync(file('docs/novo.md'), '# Novo\n')
  await tree.getByRole('button', { name: 'novo.md' }).waitFor()

  // Diagrama .mmd sem mudanças: relê.
  await tree.getByRole('button', { name: 'cobranca.mmd' }).click()
  await panel.getByText('Prévia ao vivo').waitFor()
  writeFileSync(file('docs/diagramas/cobranca.mmd'), 'sequenceDiagram\n  Agente->>Disco: gravou\n')
  await win.waitForFunction(() => [...document.querySelectorAll('main .monaco-editor .view-lines')].some((v) => v.textContent.includes('gravou')))

  // Conector sem mudanças no formulário: relê o nome gravado pelo agente.
  await tree.getByRole('button', { name: 'Payments Service v1' }).click()
  const name = panel.getByLabel('Nome *')
  await name.waitFor()
  editJson('flows/connector.payments.v1/connector.payments.v1.flow.vvpost.json', (c) => (c.name = 'Payments do agente'))
  await win.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === 'Payments do agente'))
  // Com mudanças, avisa.
  await name.fill('Payments meu')
  editJson('flows/connector.payments.v1/connector.payments.v1.flow.vvpost.json', (c) => (c.description = 'Descrição do agente.'))
  await panel.getByRole('alert').filter({ hasText: 'mudou fora do app' }).waitFor()
  assert.equal(await name.inputValue(), 'Payments meu')

  // Fluxo aberto no Flow Studio, sem mudanças: o nome novo chega à aba.
  await tree.getByRole('button', { name: 'Checkout' }).click()
  await bar.getByRole('tab', { name: 'Checkout' }).waitFor()
  editJson('flows/checkout.flow.vvpost.json', (f) => (f.name = 'Checkout do agente'))
  await bar.getByRole('tab', { name: 'Checkout do agente' }).waitFor()

  // Reler o workspace não grava nada: parado, nenhum aviso novo chega (sem ciclo de releituras).
  await win.waitForTimeout(800)
  const idle = await win.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0
        const count = () => n++
        window.addEventListener('vvpost:disk-changed', count)
        setTimeout(() => {
          window.removeEventListener('vvpost:disk-changed', count)
          resolve(n)
        }, 1500)
      })
  )
  assert.equal(idle, 0, 'o workspace parado continuou mandando avisos de mudança')

  if (screenshot) await win.screenshot({ path: screenshot })
  assert.deepEqual(errors, [])
  console.log('E2E das abas com arquivo mudado fora do app: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
