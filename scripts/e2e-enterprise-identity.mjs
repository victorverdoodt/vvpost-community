#!/usr/bin/env node
// Teste ponta a ponta do login corporativo opcional no
// app real: com um módulo Enterprise falso que expõe `identity`, o menu da conta oferece o login,
// o login abre o navegador do sistema (aqui, um shell.openExternal trocado), a organização e os
// papéis vindos do "Control Plane" aparecem só com a sessão aberta, a troca de organização vale e
// "Sair da conta" volta ao perfil local, e a barra de contexto Enterprise acompanha. Nenhum token
// chega ao renderer.
// Uso: npm run build && node scripts/e2e-enterprise-identity.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const TOKEN = 'eyJ-token-que-nunca-sai-do-modulo'

const moduleDir = mkdtempSync(join(tmpdir(), 'vvpost-identity-mod-'))
writeFileSync(
  join(moduleDir, 'enterprise.mjs'),
  `const orgs = [{ id: 'contoso', name: 'Contoso' }, { id: 'fabrikam', name: 'Fabrikam' }]
let state = { available: true, session: { status: 'signedOut' } }
const listeners = new Set()
const emit = () => listeners.forEach((l) => l())
export default {
  apiVersion: 1,
  audit: () => {},
  createBackend: async () => { throw new Error('não usado') },
  identity: {
    // O módulo guarda o token; o core tem que descartar campos que não conhece.
    state: () => ({ ...state, accessToken: ${JSON.stringify(TOKEN)} }),
    async signIn(openExternal) {
      state = { available: true, session: { status: 'signingIn' } }
      emit()
      await openExternal('https://login.microsoftonline.com/contoso/oauth2/v2.0/authorize?code_challenge=abc&code_challenge_method=S256')
      state = {
        available: true,
        session: { status: 'signedIn', user: { name: 'Ana Souza', email: 'ana@contoso.com' }, provider: 'azureAd', expiresAt: '2030-01-01T00:00:00Z' },
        organization: orgs[0],
        organizations: orgs,
        permissions: [{ project: 'payments', roles: ['Developer'] }, { project: 'billing', roles: ['Auditor'] }],
        policy: { project: 'payments', secretsProxyEnabled: true, secretsBroker: true, allowWrites: false, allowedSecretProviders: ['azureKeyVault'], allowedUpstreamHosts: [], maxCacheTtlSeconds: 120, fetchedAt: new Date().toISOString() }
      }
    },
    async signOut() { state = { available: true, session: { status: 'signedOut' } } },
    async switchOrganization(id) {
      const org = orgs.find((o) => o.id === id)
      if (!org) throw new Error('Organização não autorizada.')
      // Na outra organização a política é outra: o Cloud Proxy está bloqueado.
      state = { ...state, organization: org, permissions: [{ project: '*', roles: ['Admin'] }], policy: { secretsProxyEnabled: false, secretsBroker: false, allowWrites: false, allowedSecretProviders: [], allowedUpstreamHosts: [], fetchedAt: new Date().toISOString() } }
    },
    onChange(l) { listeners.add(l); return () => listeners.delete(l) }
  }
}
`
)

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_ENTERPRISE_MODULE: join(moduleDir, 'enterprise.mjs') }
})

try {
  // O navegador do sistema não abre no teste: o endereço fica guardado no processo principal.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => void globalThis.__opened.push(url)
  })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))

  const avatar = win.getByRole('button', { name: /^Conta: / })
  const menu = win.getByRole('menu', { name: 'Conta' })
  const openMenu = async () => {
    if (!(await menu.isVisible())) await avatar.click()
    await menu.waitFor()
  }

  // Barra de contexto: com o módulo, mostra sessão, segredos e execução.
  const bar = win.getByRole('region', { name: 'Contexto Enterprise' })
  await bar.getByText('desconectado').waitFor()
  await bar.getByText('vault local').waitFor()
  await bar.getByRole('button', { name: 'Entrar' }).waitFor()

  // Antes do login: perfil local, "Desconectado" e nada de organização nem papéis.
  await openMenu()
  await menu.getByText('Desconectado', { exact: true }).waitFor()
  await menu.getByText('Usuário local · Sem sessão autenticada').waitFor()
  assert.equal(await menu.getByRole('list', { name: 'Permissões' }).count(), 0)
  await menu.getByRole('menuitem', { name: 'Conectar conta Enterprise' }).click()

  await avatar.and(win.getByRole('button', { name: 'Conta: Ana Souza' })).waitFor()
  const opened = await app.evaluate(() => globalThis.__opened)
  assert.equal(opened.length, 1)
  assert.match(opened[0], /^https:\/\/login\.microsoftonline\.com\/.*code_challenge_method=S256/)

  await openMenu()
  await menu.getByText('Conectado', { exact: true }).waitFor()
  await menu.getByText('Contoso · Conta autenticada').waitFor()
  const perms = menu.getByRole('list', { name: 'Permissões' })
  await perms.getByText('payments').waitFor()
  await perms.getByText('Developer').waitFor()
  await perms.getByText('Auditor').waitFor()
  await bar.getByText('Contoso', { exact: true }).waitFor()
  await bar.getByText(/Ana Souza \(Microsoft Entra ID\)/).waitFor()
  await bar.getByText('nenhum projeto aberto').waitFor()
  // Política do projeto vinda do Control Plane: resumo na barra, detalhes no title.
  const policy = bar.getByText('segredos pelo broker')
  await policy.waitFor()
  await bar.getByText('· somente leitura').waitFor()
  const details = await policy.locator('xpath=..').getAttribute('title')
  assert.match(details, /Política do projeto payments no Control Plane/)
  assert.match(details, /Cofres aceitos: Azure Key Vault/)
  assert.match(details, /Cache em memória de até 2 min/)

  const org = menu.getByRole('combobox', { name: 'Organização' })
  await org.selectOption('fabrikam')
  await menu.getByText('Fabrikam · Conta autenticada').waitFor()
  await perms.getByText('organização').waitFor()
  await perms.getByText('Admin').waitFor()
  await bar.getByText('Fabrikam', { exact: true }).waitFor()
  await bar.getByText('Cloud Proxy bloqueado').waitFor()

  const state = await win.evaluate(() => window.vvpost.getIdentity())
  assert.equal(JSON.stringify(state).includes(TOKEN), false, 'token chegou ao renderer')
  assert.equal(await win.evaluate((t) => document.documentElement.outerHTML.includes(t), TOKEN), false)

  await menu.getByRole('menuitem', { name: 'Sair da conta' }).click()
  await openMenu()
  await menu.getByText('Usuário local · Sem sessão autenticada').waitFor()
  await menu.getByRole('menuitem', { name: 'Conectar conta Enterprise' }).waitFor()
  assert.equal(await menu.getByRole('list', { name: 'Permissões' }).count(), 0)
  assert.equal(await menu.getByRole('combobox', { name: 'Organização' }).count(), 0)
  await bar.getByText('desconectado').waitFor()
  assert.equal(await bar.getByText(/Cloud Proxy|broker/).count(), 0)
  assert.deepEqual(errors, [])
  console.log('E2E do login corporativo: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(moduleDir, { recursive: true, force: true })
}
