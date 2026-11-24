import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { hasConflictMarkers } from '@shared/conflicts'
import type {
  ConflictFile,
  ConflictResolution,
  FileDiff,
  GitCommitOutcome,
  GitSyncAction,
  WorkspaceState
} from '@shared/ipc'
import { validateEnvironment, type Environment } from '@vvpost/schemas'
import { isSensitiveName, SECRET_PLACEHOLDER } from '@vvpost/core/secrets'
import * as gitOps from './git'
import { describeLeaks, findSecretLeaks } from './leak-guard'
import {
  SECRETS_FILE,
  ensureGitignored,
  findMissingSecrets,
  findUnredacted,
  isEnvironmentFile,
  listEnvironmentFiles,
  readEnvironment,
  mergeSecrets,
  redactFiles,
  redactedText,
  secretInventory,
  secretVaultDir,
  type SecretValue
} from './vault'

export { GitError, repoNameFromUrl } from './git'

/** Arquivos maiores que isso não são comparados no visualizador de diff. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

/** Pasta que vira o workspace: a raiz do repositório quando `dir` está dentro de um. */
export async function resolveWorkspaceDir(dir: string): Promise<string> {
  return (await gitOps.isRepository(dir)) ? gitOps.repositoryRoot(dir) : dir
}

/**
 * Num projeto do workspace (a pasta do conteúdo não é a do Git), os segredos pendentes e os
 * arquivos sem redação contam os do projeto; o resto do estado é o do repositório.
 */
export async function withContentSecrets<T>(state: T, content: string): Promise<T> {
  if (!state || typeof state !== 'object' || !('missingSecrets' in state) || (state as { dir?: unknown }).dir === content) return state
  const [missingSecrets, unredacted] = await Promise.all([findMissingSecrets(content), findUnredacted(content)])
  return { ...state, missingSecrets, unredacted }
}

export async function readState(dir: string): Promise<WorkspaceState> {
  const [isRepo, missingSecrets, unredacted] = await Promise.all([
    gitOps.isRepository(dir),
    findMissingSecrets(dir),
    findUnredacted(dir)
  ])
  const base: WorkspaceState = {
    dir,
    isRepo,
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    branches: [],
    remotes: [],
    missingSecrets,
    unredacted,
    secretsFileTracked: false,
    operation: null
  }
  if (!isRepo) return base
  const [summary, branches, remotes, secretsFileTracked, operation] = await Promise.all([
    gitOps.status(dir),
    gitOps.branches(dir),
    gitOps.remotes(dir),
    gitOps.isTracked(dir, SECRETS_FILE),
    gitOps.operation(dir)
  ])
  return { ...base, ...summary, branches, remotes, secretsFileTracked, operation }
}

export async function cloneInto(parent: string, url: string): Promise<string> {
  if (!url.trim()) throw new gitOps.GitError('Informe a URL do repositório.', 'FAILED')
  const name = gitOps.repoNameFromUrl(url)
  await gitOps.clone(parent, url.trim(), name)
  return join(parent, name)
}

export async function initRepository(dir: string): Promise<WorkspaceState> {
  await gitOps.init(dir)
  return readState(dir)
}

/**
 * Commita só os caminhos escolhidos, que precisam estar entre as mudanças do
 * status. Antes, ambientes com segredo em texto puro são redigidos no disco
 * (valores para .vvpost/secrets.local.json) e o arquivo de segredos entra no
 * .gitignore, que vai junto no commit quando muda. Por último, nenhum arquivo do
 * commit pode ter um valor do vault, credencial literal de conector ou chave
 * privada (leak-guard.ts): o commit é recusado com SECRET_LEAK.
 */
export async function commitPaths(dir: string, message: string, paths: string[]): Promise<GitCommitOutcome> {
  if (!message.trim()) throw new gitOps.GitError('Escreva a mensagem do commit.', 'FAILED')
  if (paths.length === 0) throw new gitOps.GitError('Escolha ao menos um arquivo para o commit.', 'FAILED')
  const { changes } = await gitOps.status(dir)
  const byPath = new Map(changes.map((c) => [c.path, c]))
  const selected = new Set<string>()
  for (const path of paths) {
    const c = byPath.get(path)
    if (!c) throw new gitOps.GitError(`${path} não tem mudanças para commitar.`, 'FAILED')
    if (path === SECRETS_FILE) {
      throw new gitOps.GitError(`${SECRETS_FILE} guarda valores reais de segredo e não pode ser commitado.`, 'FAILED')
    }
    selected.add(path)
    if (c.origPath) selected.add(c.origPath)
  }

  const { redacted, changed } = await redactFiles(dir, [...selected])
  let gitignoreChanged = changed.includes('.gitignore')
  if (!gitignoreChanged && (await exists(join(dir, SECRETS_FILE)))) {
    gitignoreChanged = await ensureGitignored(dir, SECRETS_FILE)
  }
  if (gitignoreChanged) selected.add('.gitignore')

  // Redigido, um ambiente pode voltar a ser igual ao HEAD: sai do commit (o valor já foi para o cofre).
  const pending = (await gitOps.status(dir)).changes
  const after = new Set(pending.flatMap((c) => (c.origPath ? [c.path, c.origPath] : [c.path])))
  const unchanged = await gitOps.sameAsHead(
    dir,
    pending.filter((c) => c.kind === 'modified' && selected.has(c.path)).map((c) => c.path)
  )
  const committed = [...selected].filter((p) => after.has(p) && !unchanged.has(p)).sort()
  if (!committed.length) return { state: await readState(dir), commit: null, redacted, committed }
  // Última barreira: o que vai para o Git é o arquivo no disco, já redigido.
  const leaks = await findSecretLeaks(
    dir,
    await Promise.all(committed.map(async (path) => ({ path, content: await readFile(join(dir, path), 'utf8').catch(() => null) })))
  )
  if (leaks.length) throw new gitOps.GitError(describeLeaks(leaks), 'SECRET_LEAK')
  const commit = await gitOps.commit(dir, message.trim(), committed)
  return { state: await readState(dir), commit, redacted, committed }
}

/**
 * Descarta as mudanças locais (menu do Git): arquivos versionados voltam ao HEAD, no
 * index e no disco; um arquivo novo é apagado. Arquivo em conflito fica de fora (use
 * a tela de conflitos ou aborte o merge).
 */
export async function discardPaths(dir: string, paths: string[]): Promise<WorkspaceState> {
  if (paths.length === 0) throw new gitOps.GitError('Escolha ao menos um arquivo.', 'FAILED')
  const { changes } = await gitOps.status(dir)
  const byPath = new Map(changes.map((c) => [c.path, c]))
  for (const path of paths) {
    const c = byPath.get(path)
    if (!c || !isSafeRelative(path)) throw new gitOps.GitError(`${path} não tem mudanças.`, 'FAILED')
    if (c.kind === 'conflicted') throw new gitOps.GitError(`${path} está em conflito: resolva ou aborte o merge.`, 'FAILED')
  }
  for (const path of paths) {
    const c = byPath.get(path)!
    if (c.kind === 'untracked') await rm(join(dir, path), { force: true })
    else if (c.kind === 'added') {
      await gitOps.git(dir, ['rm', '--cached', '--quiet', '--', path])
      await rm(join(dir, path), { force: true })
    } else {
      if (c.origPath) await gitOps.git(dir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', c.origPath])
      if (c.kind === 'renamed') {
        await gitOps.git(dir, ['rm', '--cached', '--quiet', '--', path])
        await rm(join(dir, path), { force: true })
      } else await gitOps.git(dir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path])
    }
  }
  return readState(dir)
}

/** Diff entre o HEAD e o que o commit levaria, com segredos de ambientes já redigidos. */
export async function diffFile(dir: string, path: string): Promise<FileDiff> {
  const { changes } = await gitOps.status(dir)
  const c = changes.find((ch) => ch.path === path)
  if (!c) throw new gitOps.GitError(`${path} não tem mudanças.`, 'FAILED')
  if (!isSafeRelative(path)) throw new gitOps.GitError('Caminho inválido.', 'FAILED')

  const before = c.kind === 'added' || c.kind === 'untracked' ? null : await gitOps.fileAtHead(dir, c.origPath ?? path)
  let after: string | null = null
  if (c.kind !== 'deleted') {
    const target = join(dir, path)
    if ((await stat(target)).size > MAX_DIFF_BYTES) return { path, before: null, after: null, tooLarge: true }
    after = await readFile(target, 'utf8')
    if (isEnvironmentFile(path)) after = redactedText(after)
  }
  if ((before?.length ?? 0) > MAX_DIFF_BYTES || [before, after].some((t) => t?.includes('\0'))) {
    return { path, before: null, after: null, tooLarge: true }
  }
  return { path, before, after }
}

/** Grava valores só para segredos que o workspace espera e ainda estão vazios (wizard de onboarding). */
export async function saveSecrets(dir: string, values: SecretValue[], root = dir): Promise<WorkspaceState> {
  const missing = new Set((await findMissingSecrets(dir)).map((m) => `${m.environmentId}\0${m.variable}`))
  const filled = values
    .map((v) => ({ environmentId: String(v?.environmentId), variable: String(v?.variable), value: String(v?.value ?? '') }))
    .filter((v) => v.value && missing.has(`${v.environmentId}\0${v.variable}`))
  // Num projeto, o segredo herdado do Compartilhado vai para o cofre da raiz, onde ele é declarado.
  const byVault = new Map<string, SecretValue[]>()
  for (const v of filled) {
    const target = (await secretVaultDir(dir, v.environmentId, v.variable)) ?? dir
    byVault.set(target, [...(byVault.get(target) ?? []), v])
  }
  for (const [target, list] of byVault) await mergeSecrets(target, list)
  return readState(root)
}

/**
 * Troca o valor de um segredo que já está no vault local (Secrets, "Alterar valor"). Só uma
 * variável declarada com isSecret no ambiente; o arquivo versionado continua com
 * __REQUIRED_SECRET__. O valor novo vai direto para o vault, sem voltar ao renderer. Num projeto,
 * o segredo herdado do Compartilhado troca no cofre onde o valor está.
 */
export async function replaceSecret(dir: string, input: SecretValue, root = dir): Promise<WorkspaceState> {
  const value = String(input?.value ?? '')
  if (!value) throw new Error('O novo valor está vazio.')
  const environmentId = String(input?.environmentId)
  const variable = String(input?.variable)
  const inventory = await secretInventory(dir)
  const declared = inventory.environments.find((e) => e.id === environmentId)
  if (!declared) throw new Error(`O ambiente "${environmentId}" não existe no workspace.`)
  if (!declared.variables.some((v) => v.name === variable && v.isSecret)) throw new Error(`${variable} não é um segredo de ${declared.name}.`)
  const target = (await secretVaultDir(dir, environmentId, variable)) ?? dir
  await mergeSecrets(target, [{ environmentId, variable, value }])
  return readState(root)
}

/**
 * "Use as variable" do DataPicker: grava o valor como variável do ambiente. Segredos (variável já
 * marcada isSecret ou nome sensível, como TOKEN ou PASSWORD) ficam só no vault local e o arquivo
 * versionado recebe __REQUIRED_SECRET__; o resto vai para o arquivo do ambiente.
 */
export async function setEnvironmentVariable(
  dir: string,
  input: { environmentId: string; name: string; value: string | number | boolean }
): Promise<{ file: string; secret: boolean }> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name)) {
    throw new Error('Nome de variável inválido: use letras, dígitos e _, sem começar por dígito.')
  }
  let file: string | undefined
  for (const path of await listEnvironmentFiles(dir)) {
    if ((await readEnvironment(dir, path))?.id === input.environmentId) {
      file = path
      break
    }
  }
  if (!file) throw new Error(`Ambiente "${input.environmentId}" não encontrado no workspace.`)
  const doc = JSON.parse(await readFile(join(dir, file), 'utf8')) as Environment
  const previous = doc.variables[input.name]
  const secret = previous?.isSecret === true || isSensitiveName(input.name)
  const keep = {
    ...(previous?.description !== undefined && { description: previous.description }),
    ...(previous?.placeholder !== undefined && { placeholder: previous.placeholder })
  }
  doc.variables[input.name] = secret
    ? { type: 'string', value: SECRET_PLACEHOLDER, isSecret: true, ...keep }
    : {
        type: typeof input.value === 'number' ? 'number' : typeof input.value === 'boolean' ? 'boolean' : 'string',
        value: input.value,
        ...keep
      }
  const valid = validateEnvironment(doc)
  if (!valid.ok) throw new Error(`${file}: ${valid.issues.map((i) => `${i.path || '/'}: ${i.message}`).join('; ')}`)
  await writeFile(join(dir, file), `${JSON.stringify(doc, null, 2)}\n`)
  if (secret) {
    await mergeSecrets(dir, [{ environmentId: input.environmentId, variable: input.name, value: String(input.value) }])
  }
  return { file, secret }
}

export async function checkout(dir: string, name: string): Promise<WorkspaceState> {
  const branch = (await gitOps.branches(dir)).find((b) => b.name === name)
  if (!branch) throw new gitOps.GitError(`Branch ${name} não encontrada.`, 'FAILED')
  if (!branch.current) await gitOps.checkout(dir, branch)
  return readState(dir)
}

export async function createBranch(dir: string, name: string): Promise<WorkspaceState> {
  await gitOps.createBranch(dir, name.trim())
  return readState(dir)
}

export async function sync(dir: string, action: GitSyncAction): Promise<WorkspaceState> {
  if (action === 'fetch') await gitOps.fetch(dir)
  else if (action === 'pull') await gitOps.pull(dir)
  else if (action === 'push') await gitOps.push(dir, (await gitOps.status(dir)).upstream)
  else throw new gitOps.GitError(`Ação desconhecida: ${String(action)}`, 'FAILED')
  return readState(dir)
}

async function conflicted(dir: string, path: string): Promise<void> {
  if (!isSafeRelative(path)) throw new gitOps.GitError('Caminho inválido.', 'FAILED')
  const { changes } = await gitOps.status(dir)
  if (!changes.some((c) => c.path === path && c.kind === 'conflicted')) {
    throw new gitOps.GitError(`${path} não está em conflito.`, 'FAILED')
  }
}

/** As três versões do arquivo em conflito e o arquivo no disco, com os marcadores. */
export async function readConflict(dir: string, path: string): Promise<ConflictFile> {
  await conflicted(dir, path)
  const [base, ours, theirs] = await Promise.all([1, 2, 3].map((n) => gitOps.stageContent(dir, path, n as 1 | 2 | 3)))
  let working: string | null = null
  try {
    if ((await stat(join(dir, path))).size > MAX_DIFF_BYTES) return { path, base: null, ours: null, theirs: null, working: null, tooLarge: true }
    working = await readFile(join(dir, path), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const texts = [base, ours, theirs, working]
  if (texts.some((t) => (t?.length ?? 0) > MAX_DIFF_BYTES || t?.includes('\0'))) {
    return { path, base: null, ours: null, theirs: null, working: null, tooLarge: true }
  }
  return { path, base: base ?? null, ours: ours ?? null, theirs: theirs ?? null, working }
}

/**
 * Resolve um arquivo em conflito: grava um dos lados (ou apaga, se aquele lado
 * apagou o arquivo) ou o texto final escolhido no app, e marca como resolvido.
 * Um ambiente resolvido com segredo em texto puro é redigido antes de entrar no
 * index, como no commit.
 */
export async function resolveConflict(dir: string, path: string, resolution: ConflictResolution): Promise<WorkspaceState> {
  await conflicted(dir, path)
  let content: string | null
  if (resolution && 'use' in resolution && (resolution.use === 'ours' || resolution.use === 'theirs')) {
    content = await gitOps.stageContent(dir, path, resolution.use === 'ours' ? 2 : 3)
  } else if (resolution && 'content' in resolution && typeof resolution.content === 'string') {
    content = resolution.content
    if (hasConflictMarkers(content)) {
      throw new gitOps.GitError(`${path} ainda tem marcadores de conflito. Escolha um lado em cada bloco.`, 'FAILED')
    }
  } else {
    throw new gitOps.GitError('Resolução inválida.', 'FAILED')
  }
  const target = join(dir, path)
  if (content !== null && !isEnvironmentFile(path)) {
    // Ambientes são redigidos logo abaixo; o resto entra no index como está, então é conferido antes.
    const leaks = await findSecretLeaks(dir, [{ path, content }])
    if (leaks.length) throw new gitOps.GitError(describeLeaks(leaks), 'SECRET_LEAK')
  }
  if (content === null) {
    await rm(target, { force: true })
  } else {
    await writeFile(target, content)
    await redactFiles(dir, [path])
    // A redação pode ter criado o arquivo local de segredos: ele precisa estar no .gitignore.
    if (await exists(join(dir, SECRETS_FILE))) await ensureGitignored(dir, SECRETS_FILE)
  }
  await gitOps.markResolved(dir, path, content === null)
  return readState(dir)
}

export async function finishMerge(dir: string): Promise<{ state: WorkspaceState; commit: string }> {
  if ((await gitOps.operation(dir)) !== 'merge') throw new gitOps.GitError('Não há merge em andamento.', 'FAILED')
  const { changes } = await gitOps.status(dir)
  const left = changes.filter((c) => c.kind === 'conflicted').length
  if (left) throw new gitOps.GitError(`Ainda há ${left} arquivo(s) em conflito.`, 'FAILED')
  const commit = await gitOps.commitMerge(dir)
  return { state: await readState(dir), commit }
}

export async function abortMerge(dir: string): Promise<WorkspaceState> {
  if ((await gitOps.operation(dir)) !== 'merge') throw new gitOps.GitError('Não há merge em andamento.', 'FAILED')
  await gitOps.abortMerge(dir)
  return readState(dir)
}

function isSafeRelative(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes('\0') && !path.split(/[\\/]/).includes('..')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
