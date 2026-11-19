#!/usr/bin/env node
// Teste ponta a ponta do Git Workspace no app real (build de produção em out/):
// clona um repositório local com um ambiente que espera segredo, preenche o wizard,
// edita o ambiente com um segredo em texto puro, confere o diff lado a lado (já
// redigido), commita, cria branch e faz push para o remoto. Por fim, um pull com
// conflito: resolve o bloco pela tela de conflitos e conclui o merge.
// O diálogo nativo de pasta é trocado por respostas fixas no main process.
// Uso: npm run build && node scripts/e2e-git-workspace.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readVault } from './e2e-helpers.mjs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const identity = {
  GIT_AUTHOR_NAME: 'VVPost E2E',
  GIT_AUTHOR_EMAIL: 'e2e@vvpost.dev',
  GIT_COMMITTER_NAME: 'VVPost E2E',
  GIT_COMMITTER_EMAIL: 'e2e@vvpost.dev'
}
const sh = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity }, stdio: 'pipe' })
const json = (v) => `${JSON.stringify(v, null, 2)}\n`
const environment = (secret) => ({
  id: 'env.dev',
  name: 'Desenvolvimento',
  variables: {
    BASE_URL: { type: 'string', value: 'https://dev.api', isSecret: false },
    CLIENT_SECRET: {
      type: 'string',
      value: secret,
      isSecret: true,
      description: 'Secret do cliente no Keycloak',
      placeholder: 'Cole o secret do cliente'
    }
  }
})

// Remoto bare com o workspace já versionado, segredo como __REQUIRED_SECRET__.
const seed = mkdtempSync(join(tmpdir(), 'vvpost-seed-'))
sh(seed, 'init', '-b', 'main')
mkdirSync(join(seed, 'environments'))
writeFileSync(join(seed, 'environments/dev.env.json'), json(environment('__REQUIRED_SECRET__')))
sh(seed, 'add', '-A')
sh(seed, 'commit', '-m', 'Workspace inicial')
const remote = mkdtempSync(join(tmpdir(), 'vvpost-remote-'))
sh(remote, 'clone', '--bare', seed, '.')
const parent = mkdtempSync(join(tmpdir(), 'vvpost-clones-'))
const workspace = join(parent, remote.split(/[\\/]/).at(-1))

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, ...identity }
})

const queueDialogs = (...answers) =>
  app.evaluate(({ dialog }, answers) => {
    globalThis.__dialogAnswers = answers
    dialog.showOpenDialog = async () =>
      globalThis.__dialogAnswers.shift() ?? { canceled: true, filePaths: [] }
  }, answers)

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const status = win.getByRole('status')
  const alert = win.getByRole('alert')

  await win.getByRole('button', { name: 'Git Workspace' }).click()
  await queueDialogs({ canceled: false, filePaths: [parent] })
  await win.getByLabel('Clonar repositório').fill(remote)
  await win.getByRole('button', { name: 'Clonar…' }).click()

  // Wizard de onboarding: abre sozinho depois do clone.
  const wizard = win.getByRole('dialog', { name: 'Configurar segredos' })
  await wizard.waitFor()
  await wizard.getByText('Secret do cliente no Keycloak').waitFor()
  await wizard.getByPlaceholder('Cole o secret do cliente').fill('valor-do-wizard')
  await wizard.getByRole('button', { name: 'Concluir' }).click()
  await status.getByText(/Segredos salvos/).waitFor()
  const secretsFile = join(workspace, '.vvpost/secrets.local.json')
  assert.deepEqual(readVault(workspace), { 'env.dev': { CLIENT_SECRET: 'valor-do-wizard' } })
  assert.ok(!existsSync(secretsFile), 'o cofre fica fora da pasta do projeto')

  // Edição externa com segredo em texto puro: o diff já mostra o valor redigido.
  writeFileSync(
    join(workspace, 'environments/dev.env.json'),
    json({ ...environment('vazou-no-editor'), name: 'Desenvolvimento 2' })
  )
  // Um segundo arquivo mudado (o cofre fica fora da pasta: o wizard não mexe mais no .gitignore).
  writeFileSync(join(workspace, 'NOTAS.md'), 'Notas do time.\n')
  await win.getByRole('button', { name: 'Atualizar' }).click()
  const changes = win.getByLabel('Mudanças')
  await changes.getByText('redige 1').waitFor()
  await changes.getByRole('button', { name: /environments\/dev\.env\.json/ }).click()
  const diff = win.getByLabel('Diff de environments/dev.env.json')
  await diff.locator('tr[data-kind="changed"]').first().waitFor()
  const changed = await diff.locator('tr[data-kind="changed"]').allTextContents()
  assert.equal(changed.length, 1)
  assert.match(changed[0], /"Desenvolvimento".*"Desenvolvimento 2"/)
  assert.ok(!(await win.content()).includes('vazou-no-editor'), 'segredo em texto puro chegou ao renderer')
  if (screenshot) await win.screenshot({ path: screenshot })

  // Abas dos arquivos abertos: o outro arquivo abre numa aba nova, a primeira continua lá.
  const fileTabs = win.getByRole('tablist', { name: 'Arquivos abertos' })
  const otherFile = (await changes.locator('li button').allTextContents()).find((t) => !t.includes('dev.env.json'))
  assert.ok(otherFile, 'esperava um segundo arquivo alterado')
  await changes.getByRole('button', { name: otherFile, exact: true }).click()
  await fileTabs.getByRole('tab', { name: otherFile }).waitFor()
  assert.equal(await fileTabs.getByRole('tab').count(), 2)
  await diff.waitFor({ state: 'detached' })
  await fileTabs.getByRole('tab', { name: 'environments/dev.env.json' }).click()
  await diff.locator('tr[data-kind="changed"]').first().waitFor()
  assert.equal(await fileTabs.getByRole('tab', { name: 'environments/dev.env.json' }).getAttribute('aria-selected'), 'true')
  await fileTabs.getByRole('tab', { name: otherFile }).click({ button: 'middle' })
  assert.equal(await fileTabs.getByRole('tab').count(), 1)
  await diff.waitFor()

  await win.getByLabel('Mensagem do commit').fill('Renomeia o ambiente')
  await win.getByRole('button', { name: 'Commit (2)' }).click()
  await status.getByText(/Commit [0-9a-f]+ com 2 arquivo\(s\)\. Segredos redigidos/).waitFor()
  assert.equal(sh(workspace, 'log', '-1', '--format=%s').trim(), 'Renomeia o ambiente')
  const committed = sh(workspace, 'show', 'HEAD:environments/dev.env.json')
  assert.ok(committed.includes('__REQUIRED_SECRET__') && !committed.includes('vazou-no-editor'))
  assert.equal(readVault(workspace)['env.dev'].CLIENT_SECRET, 'vazou-no-editor')
  await changes.getByText('Nada para commitar.').waitFor()
  // Os arquivos commitados saem das abas.
  assert.equal(await fileTabs.count(), 0)

  // Erro do Git no padrão único (ErrorNotice): categoria Git, código, causa e a branch.
  await win.getByLabel('Branch').selectOption({ label: '+ Nova branch…' })
  await win.getByLabel('Nome da nova branch').fill('nome..invalido')
  await win.getByRole('button', { name: 'Criar' }).click()
  const gitError = alert.filter({ hasText: 'Falha no Git' })
  await gitError.getByText('GIT_ERROR').waitFor()
  await gitError.getByText('Git', { exact: true }).waitFor()
  await gitError.getByRole('button', { name: 'Dispensar' }).click()
  assert.equal(await alert.count(), 0)
  await win.getByRole('button', { name: 'Cancelar' }).click()

  // Nova branch e push: publica no remoto com upstream.
  await win.getByLabel('Branch').selectOption({ label: '+ Nova branch…' })
  await win.getByLabel('Nome da nova branch').fill('feature/ambiente')
  await win.getByRole('button', { name: 'Criar' }).click()
  await status.getByText('Branch feature/ambiente criada.').waitFor()
  await win.getByRole('button', { name: 'Push' }).click()
  await status.getByText('Push concluído.').waitFor()
  assert.match(sh(remote, 'branch', '--list', 'feature/ambiente'), /feature\/ambiente/)
  await win.getByText('↑0 ↓0').waitFor()

  // Pull: só fast-forward; sem novidades, termina sem erro.
  await win.getByRole('button', { name: 'Pull' }).click()
  await status.getByText('Pull concluído.').waitFor()
  assert.equal(await alert.count(), 0)

  // Pull com conflito: outra pessoa muda o nome do ambiente no remoto, e aqui também.
  const other = mkdtempSync(join(tmpdir(), 'vvpost-other-'))
  sh(other, 'clone', '-b', 'feature/ambiente', remote, '.')
  writeFileSync(join(other, 'environments/dev.env.json'), json({ ...environment('__REQUIRED_SECRET__'), name: 'Remoto' }))
  sh(other, 'commit', '-am', 'Nome remoto')
  sh(other, 'push')
  rmSync(other, { recursive: true, force: true })
  writeFileSync(join(workspace, 'environments/dev.env.json'), json({ ...environment('__REQUIRED_SECRET__'), name: 'Local' }))
  sh(workspace, 'commit', '-am', 'Nome local')
  await win.getByRole('button', { name: 'Pull' }).click()
  await status.getByText(/O pull trouxe conflitos em 1 arquivo/).waitFor()
  const merge = win.getByRole('region', { name: 'Merge em andamento' })
  await merge.getByText(/1 arquivo\(s\) em conflito/).waitFor()
  assert.ok(await merge.getByRole('button', { name: 'Concluir merge' }).isDisabled())
  await changes.getByRole('button', { name: /environments\/dev\.env\.json/ }).click()
  const conflict = win.getByLabel('Conflito em environments/dev.env.json')
  const block = conflict.getByLabel('Bloco 1')
  await block.getByText('"name": "Local"').waitFor()
  await block.getByText('"name": "Remoto"').waitFor()
  await block.getByRole('button', { name: 'Usar a remota' }).click()
  assert.match(await conflict.getByLabel('Resultado').inputValue(), /"name": "Remoto"/)
  if (process.env.E2E_CONFLICT_SCREENSHOT) await win.screenshot({ path: process.env.E2E_CONFLICT_SCREENSHOT })
  await conflict.getByRole('button', { name: 'Marcar como resolvido' }).click()
  await status.getByText('environments/dev.env.json resolvido.').waitFor()
  await merge.getByText(/todos os conflitos foram resolvidos/).waitFor()
  await merge.getByRole('button', { name: 'Concluir merge' }).click()
  await status.getByText(/Merge concluído no commit [0-9a-f]+/).waitFor()
  assert.equal(sh(workspace, 'log', '-1', '--format=%P').trim().split(' ').length, 2)
  assert.match(sh(workspace, 'show', 'HEAD:environments/dev.env.json'), /"name": "Remoto"/)
  assert.equal(await win.getByRole('region', { name: 'Merge em andamento' }).count(), 0)
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
for (const d of [userData, seed, remote, parent]) rmSync(d, { recursive: true, force: true })
console.log('E2E do Git Workspace: ok')
