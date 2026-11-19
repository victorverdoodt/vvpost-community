import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { projectLayout } from '@vvpost/core/projects'
import { SECRETS_FILE } from '@vvpost/core/secrets'
import * as gitOps from './git'
import { findSecretLeaks, type SecretLeak } from './leak-guard'
import { readSecretsStore, type SecretsStore } from './vault'

/** Marca do hook instalado pelo VVPost: reinstalar troca só o que tem a marca. */
export const HOOK_MARKER = '# vvpost-guard'

export interface GuardResult {
  /** Raiz do repositório Git. */
  root: string
  /** Arquivos conferidos, relativos à raiz do repositório. */
  checked: string[]
  leaks: SecretLeak[]
}

/**
 * Os valores de todos os vaults do workspace: o da raiz (Compartilhado) e o de cada projeto. Um
 * commit pode levar arquivos de qualquer projeto, e o valor de um projeto não pode ir no outro.
 */
export async function workspaceSecrets(dir: string): Promise<SecretsStore> {
  const layout = projectLayout(dir)
  const dirs = [layout.root, ...layout.projects.map((p) => join(layout.root, p.folder))]
  const merged: SecretsStore = {}
  for (const d of dirs) {
    const store = await readSecretsStore(d).catch((): SecretsStore => ({}))
    const label = d === layout.root ? '' : `${relative(layout.root, d)}:`
    for (const [env, vars] of Object.entries(store)) merged[`${label}${env}`] = vars
  }
  return merged
}

/**
 * Leak guard fora do app (vvpost guard, hook de pre-commit): confere o que está no index do Git
 * (o que o commit vai levar) com as mesmas regras do commit pelo app, leak-guard.ts. Com `all`,
 * confere todos os arquivos versionados, como estão no disco (para CI ou para a primeira vez).
 */
export async function guardRepository(dir: string, options: { all?: boolean } = {}): Promise<GuardResult> {
  const root = (await gitOps.repositoryRoot(dir)).trim()
  const list = options.all
    ? await gitOps.git(root, ['ls-files', '-z'])
    : await gitOps.git(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'])
  const paths = list.split('\0').filter(Boolean)
  const leaks: SecretLeak[] = []
  // O próprio vault nunca vai para o Git, em nenhuma pasta.
  for (const path of paths) {
    if (path === SECRETS_FILE || path.endsWith(`/${SECRETS_FILE}`)) {
      leaks.push({ file: path, reason: 'o arquivo de segredos locais do VVPost' })
    }
  }
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      content: options.all
        ? await readFile(join(root, path), 'utf8').catch(() => null)
        : await gitOps.git(root, ['show', `:${path}`]).catch(() => null)
    }))
  )
  leaks.push(...(await findSecretLeaks(root, files, await workspaceSecrets(dir))))
  return { root, checked: paths, leaks }
}

/** Aspas simples do sh, com barras normais (o Git no Windows roda o hook no sh dele). */
const shQuote = (value: string) => `'${value.split(sep).join('/').replace(/'/g, `'\\''`)}'`

/**
 * O script do hook. Usa o `vvpost` do PATH; sem ele, o comando de quem instalou (o Electron do
 * app com ELECTRON_RUN_AS_NODE, ou o Node com o cli.js). Sem nenhum dos dois, recusa o commit:
 * um guard que não roda não pode passar em silêncio.
 */
export function hookScript(workspace: string, fallback: string[] | null): string {
  const ws = shQuote(workspace)
  const lines = [
    '#!/bin/sh',
    `${HOOK_MARKER}: confere os arquivos do commit contra os segredos do VVPost (vvpost guard --install).`,
    'if command -v vvpost >/dev/null 2>&1; then',
    `  exec vvpost guard --workspace ${ws}`,
    'fi'
  ]
  if (fallback?.length) {
    lines.push(`if [ -e ${shQuote(fallback[0]!)} ]; then`, `  exec env ELECTRON_RUN_AS_NODE=1 ${fallback.map(shQuote).join(' ')} guard --workspace ${ws}`, 'fi')
  }
  lines.push(
    'echo "vvpost guard: o comando vvpost não foi encontrado; o commit foi recusado sem conferir os segredos." >&2',
    'echo "Instale o CLI (npm i -g vvpost) ou reinstale o hook pelo app. git commit --no-verify pula a conferência." >&2',
    'exit 1',
    ''
  )
  return lines.join('\n')
}

export type HookInstall = { file: string; status: 'installed' | 'updated' | 'unchanged' }

/**
 * Instala o hook de pre-commit no repositório de `dir`, na pasta de hooks que o Git usa
 * (core.hooksPath ou .git/hooks). Um pre-commit que não é do VVPost não é sobrescrito.
 */
export async function installPreCommitHook(dir: string, fallback: string[] | null): Promise<HookInstall> {
  const root = (await gitOps.repositoryRoot(dir)).trim()
  const hooksPath = (await gitOps.git(root, ['rev-parse', '--git-path', 'hooks'])).trim()
  const hooks = isAbsolute(hooksPath) ? hooksPath : resolve(root, hooksPath)
  const file = join(hooks, 'pre-commit')
  // O Git devolve o caminho longo; a pasta pode vir curta (8.3 no Windows, RUNNER~1) ou por link.
  const workspace = relative(await realpath(root), await realpath(resolve(dir))) || '.'
  const script = hookScript(workspace, fallback)
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current === script) return { file, status: 'unchanged' }
  if (current !== null && !current.includes(HOOK_MARKER)) {
    throw new gitOps.GitError(
      `Já existe um pre-commit que não é do VVPost (${file}). Acrescente a ele a linha: vvpost guard --workspace ${shQuote(workspace)}`,
      'FAILED'
    )
  }
  await mkdir(hooks, { recursive: true })
  await writeFile(file, script)
  await chmod(file, 0o755)
  return { file, status: current === null ? 'installed' : 'updated' }
}
