#!/usr/bin/env node
// Teste ponta a ponta da identidade local: o avatar da barra
// superior abre o menu da conta com o perfil local, sem sessão autenticada e sem login quando o
// módulo Enterprise não está ativo; o nome de exibição muda pelo menu, fica em profile.json e
// volta igual ao reabrir o app.
// Uso: npm run build && node scripts/e2e-identity.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const launch = () =>
  _electron.launch({
    executablePath: electronBin,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
  })

try {
  let app = await launch()
  let win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  const avatar = win.getByRole('button', { name: /^Conta: / })
  await avatar.click()
  const menu = win.getByRole('menu', { name: 'Conta' })
  await menu.waitFor()
  await menu.getByText('Usuário local · Sem sessão autenticada').waitFor()
  await menu.getByText('Local', { exact: true }).waitFor()
  assert.equal(await menu.getByRole('menuitem', { name: /Conectar conta|Sair/ }).count(), 0)
  // Sem módulo Enterprise, nada de barra de contexto corporativa.
  assert.equal(await win.getByRole('region', { name: 'Contexto Enterprise' }).count(), 0)

  // Teclado: o foco entra no menu, Esc fecha e devolve o foco ao avatar.
  assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem')
  await win.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  assert.equal(
    await win.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Conta: ')),
    true
  )

  await win.keyboard.press('Enter')
  await menu.getByRole('menuitem', { name: 'Editar perfil local' }).click()
  await menu.getByLabel('Nome de exibição').fill('Victor Verdoodt')
  await menu.getByRole('button', { name: 'Salvar' }).click()
  await menu.getByText('Victor Verdoodt', { exact: true }).waitFor()
  await win.keyboard.press('Escape')
  assert.equal(await avatar.getAttribute('aria-label'), 'Conta: Victor Verdoodt')
  assert.equal((await avatar.textContent()).trim(), 'VV')
  assert.deepEqual(JSON.parse(readFileSync(join(userData, 'profile.json'), 'utf8')), { displayName: 'Victor Verdoodt' })
  assert.deepEqual(errors, [])
  await app.close()

  app = await launch()
  win = await app.firstWindow()
  await win.getByRole('button', { name: 'Conta: Victor Verdoodt' }).waitFor()
  await app.close()
  console.log('E2E da identidade local: ok')
} finally {
  rmSync(userData, { recursive: true, force: true })
}
