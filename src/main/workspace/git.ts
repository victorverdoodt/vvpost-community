import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitBranch, GitChange, GitChangeKind, GitOperation } from '@shared/ipc'

/**
 * Git do workspace pelo executável `git` do sistema, como o VS Code faz: usa a
 * configuração, as credenciais e as chaves SSH que o usuário já tem, e não põe
 * uma implementação de Git no bundle.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_INSTALLED' | 'FAILED' | 'TIMEOUT' | 'SECRET_LEAK'
  ) {
    super(message)
  }
}

/** Operações locais. Clone, fetch, pull e push usam NETWORK_TIMEOUT_MS. */
const LOCAL_TIMEOUT_MS = 30_000
const NETWORK_TIMEOUT_MS = 5 * 60_000

export async function git(
  cwd: string,
  args: string[],
  { timeoutMs = LOCAL_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          // Sem terminal para perguntar usuário e senha: sem credencial salva, falha em vez de travar.
          GIT_TERMINAL_PROMPT: '0',
          // Leituras (status) não disputam o index.lock com o Git que o usuário roda no terminal.
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C'
        }
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout)
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        if (e.code === 'ENOENT') {
          return reject(new GitError('Git não encontrado no PATH. Instale o Git e reabra o VVPost.', 'NOT_INSTALLED'))
        }
        if (e.killed && e.signal) return reject(new GitError(`git ${args[0]} passou do tempo limite`, 'TIMEOUT'))
        // Avisos (ex.: "LF will be replaced by CRLF" no Windows) não escondem o erro de verdade.
        // Sem erro no stderr, a explicação está no stdout (ex.: "nothing to commit").
        const split = (text: string) => text.trim().split(/\r?\n/).filter(Boolean)
        const warnings = split(stderr)
        const errors = warnings.filter((l) => !/^warning: |^The file will have its original line endings/i.test(l))
        const detail = (errors.length ? errors : split(stdout).length ? split(stdout) : warnings).slice(-6).join('\n')
        reject(new GitError(detail || e.message, 'FAILED'))
      }
    )
    child.stdin?.end()
  })
}

/**
 * `git cat-file --batch`: o conteúdo de vários objetos (`<commit>:<caminho>`) num processo só. null para
 * o que não existe. No Windows cada processo do Git custa ~100 ms; um lint que lia 30 arquivos de um
 * commit passava 3 s esperando.
 */
export function catFiles(cwd: string, specs: readonly string[]): Promise<(string | null)[]> {
  if (!specs.length) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', 'cat-file', '--batch'],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        timeout: LOCAL_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
      },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException
          return reject(new GitError(e.code === 'ENOENT' ? 'Git não encontrado no PATH. Instale o Git e reabra o VVPost.' : e.message, e.code === 'ENOENT' ? 'NOT_INSTALLED' : 'FAILED'))
        }
        resolve(parseBatch(stdout as Buffer, specs.length))
      }
    )
    // Uma linha por objeto; uma quebra de linha no nome mudaria a contagem, então esse objeto sai como inexistente.
    child.stdin?.end(specs.map((s) => (/[\r\n]/.test(s) ? 'missing:' : s)).join('\n') + '\n')
  })
}

/** A saída do --batch: `<oid> <tipo> <tamanho>` e o conteúdo, ou `<nome> missing` (e afins) sem conteúdo. */
export function parseBatch(out: Buffer, count: number): (string | null)[] {
  const result: (string | null)[] = []
  let at = 0
  while (result.length < count && at < out.length) {
    const end = out.indexOf(0x0a, at)
    if (end < 0) break
    const header = out.subarray(at, end).toString('utf8')
    at = end + 1
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header)
    if (!m) {
      result.push(null)
      continue
    }
    const size = Number(m[2])
    result.push(m[1] === 'blob' ? out.subarray(at, at + size).toString('utf8') : null)
    at += size + 1
  }
  while (result.length < count) result.push(null)
  return result
}

export async function isRepository(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch (err) {
    if (err instanceof GitError && err.code === 'NOT_INSTALLED') throw err
    return false
  }
}

/** Raiz do repositório que contém `dir` (pode ser uma pasta acima). */
export async function repositoryRoot(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
}

export interface StatusSummary {
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  changes: GitChange[]
}

export async function status(dir: string): Promise<StatusSummary> {
  return parseStatus(await git(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']))
}

/** Interpreta `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): StatusSummary {
  const summary: StatusSummary = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, changes: [] }
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    if (!rec) continue
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') summary.head = value === '(initial)' ? null : value.slice(0, 7)
      else if (key === 'branch.head') summary.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') summary.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          summary.ahead = Number(m[1])
          summary.behind = Number(m[2])
        }
      }
      continue
    }
    const type = rec[0]
    if (type === '?') {
      summary.changes.push({ path: rec.slice(2), kind: 'untracked', staged: false, unstaged: true })
    } else if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = rec.split(' ')
      const xy = parts[1]!
      summary.changes.push(change(parts.slice(8).join(' '), xy))
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, seguido do caminho original no próximo registro
      const parts = rec.split(' ')
      const xy = parts[1]!
      const origPath = records[++i]
      summary.changes.push({ ...change(parts.slice(9).join(' '), xy), kind: 'renamed', origPath })
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = rec.split(' ')
      summary.changes.push({ path: parts.slice(10).join(' '), kind: 'conflicted', staged: false, unstaged: true })
    }
  }
  summary.changes.sort((a, b) => a.path.localeCompare(b.path))
  return summary
}

function change(path: string, xy: string): GitChange {
  const [x, y] = [xy[0]!, xy[1]!]
  const code = y !== '.' ? y : x
  const kinds: Record<string, GitChangeKind> = { A: 'added', D: 'deleted', R: 'renamed', C: 'added' }
  return { path, kind: kinds[code] ?? 'modified', staged: x !== '.', unstaged: y !== '.' }
}

export async function branches(dir: string): Promise<GitBranch[]> {
  const out = await git(dir, [
    'for-each-ref',
    '--format=%(HEAD)%00%(refname)%00%(refname:short)%00%(upstream:short)',
    'refs/heads',
    'refs/remotes'
  ])
  const list: GitBranch[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [head, ref, name, upstream] = line.split('\0') as [string, string, string, string]
    if (ref.endsWith('/HEAD')) continue
    const remote = ref.startsWith('refs/remotes/')
    list.push({ name, current: head === '*', remote, ...(upstream ? { upstream } : {}) })
  }
  return list
}

export async function remotes(dir: string): Promise<string[]> {
  return (await git(dir, ['remote'])).split('\n').filter(Boolean)
}

/** Conteúdo do arquivo no HEAD; null se ele não existe lá (arquivo novo ou repositório sem commits). */
export async function fileAtHead(dir: string, path: string): Promise<string | null> {
  try {
    return await git(dir, ['show', `HEAD:${path}`])
  } catch (err) {
    if (err instanceof GitError && err.code === 'FAILED') return null
    throw err
  }
}

/**
 * Dos arquivos alterados, os que no disco têm o mesmo conteúdo do HEAD (pelos filtros do Git,
 * como o core.autocrlf). Com autocrlf, um arquivo regravado com LF aparece como ` M` no status
 * mesmo sendo igual ao blob do HEAD, e o `commit --only` dele responderia "nada para commitar".
 */
export async function sameAsHead(dir: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set()
  let tree: string
  try {
    tree = await git(dir, ['ls-tree', '-z', 'HEAD', '--', ...paths])
  } catch (err) {
    if (err instanceof GitError && err.code === 'FAILED') return new Set()
    throw err
  }
  const head = new Map<string, string>()
  for (const rec of tree.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(rec)
    if (m) head.set(m[2]!, m[1]!)
  }
  const candidates = paths.filter((p) => head.has(p))
  if (!candidates.length) return new Set()
  const hashes = (await git(dir, ['hash-object', '--', ...candidates])).trim().split(/\r?\n/)
  return new Set(candidates.filter((p, i) => hashes[i] === head.get(p)))
}

export async function isTracked(dir: string, path: string): Promise<boolean> {
  return (await git(dir, ['ls-files', '--', path])).trim().length > 0
}

/** Commita exatamente estes caminhos (novos, alterados ou apagados); o que mais estiver no index fica lá. */
export async function commit(dir: string, message: string, paths: string[]): Promise<string> {
  await git(dir, ['add', '-A', '--', ...paths])
  await git(dir, ['commit', '-m', message, '--only', '--', ...paths])
  return (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim()
}

export async function init(dir: string): Promise<void> {
  await git(dir, ['init'])
}

export async function clone(parent: string, url: string, name: string): Promise<void> {
  await git(parent, ['clone', '--', url, name], { timeoutMs: NETWORK_TIMEOUT_MS })
}

export async function checkout(dir: string, branch: GitBranch): Promise<void> {
  if (!branch.remote) return void (await git(dir, ['switch', '--', branch.name]))
  // Branch remota (origin/x): cria a local x rastreando a remota, como o VS Code.
  const local = branch.name.slice(branch.name.indexOf('/') + 1)
  await git(dir, ['switch', '--track', '-c', local, branch.name])
}

export async function createBranch(dir: string, name: string): Promise<void> {
  await git(dir, ['check-ref-format', '--branch', name])
  await git(dir, ['switch', '-c', name])
}

export async function fetch(dir: string): Promise<void> {
  await git(dir, ['fetch', '--all', '--prune'], { timeoutMs: NETWORK_TIMEOUT_MS })
}

/**
 * Pull com merge (nunca rebase, mesmo com pull.rebase na configuração): fast-forward
 * quando dá, commit de merge quando a branch divergiu. Com conflito, o repositório
 * fica no meio do merge e o painel resolve arquivo por arquivo; não é erro.
 */
export async function pull(dir: string): Promise<void> {
  try {
    await git(dir, ['pull', '--no-rebase', '--no-edit'], { timeoutMs: NETWORK_TIMEOUT_MS })
  } catch (err) {
    if (err instanceof GitError && err.code === 'FAILED' && (await operation(dir)) === 'merge') return
    throw err
  }
}

/** Operação do Git parada no meio (merge, rebase...) esperando o usuário. */
export async function operation(dir: string): Promise<GitOperation | null> {
  const checks: [string, GitOperation][] = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert']
  ]
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
  for (const [file, op] of checks) {
    if (await exists(join(gitDir, file))) return op
  }
  return null
}

/** Versão do arquivo num estágio do index durante um conflito: 1 ancestral, 2 local, 3 remota. null se não existe nesse lado. */
export async function stageContent(dir: string, path: string, stageNumber: 1 | 2 | 3): Promise<string | null> {
  try {
    return await git(dir, ['show', `:${stageNumber}:${path}`])
  } catch (err) {
    if (err instanceof GitError && err.code === 'FAILED') return null
    throw err
  }
}

/** Marca o caminho como resolvido: adiciona o conteúdo atual, ou registra a remoção. */
export async function markResolved(dir: string, path: string, deleted: boolean): Promise<void> {
  if (deleted) await git(dir, ['rm', '--cached', '--ignore-unmatch', '--quiet', '--', path])
  else await git(dir, ['add', '--', path])
}

/** Commit de merge com a mensagem que o Git preparou. */
export async function commitMerge(dir: string): Promise<string> {
  await git(dir, ['commit', '--no-edit'])
  return (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim()
}

export async function abortMerge(dir: string): Promise<void> {
  await git(dir, ['merge', '--abort'])
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Sem upstream, publica a branch no remoto (origin, ou o único que houver) e passa a rastreá-la. */
export async function push(dir: string, upstream: string | null): Promise<void> {
  if (upstream) return void (await git(dir, ['push'], { timeoutMs: NETWORK_TIMEOUT_MS }))
  const all = await remotes(dir)
  const remote = all.includes('origin') ? 'origin' : all[0]
  if (!remote) throw new GitError('O repositório não tem remoto configurado para o push.', 'FAILED')
  await git(dir, ['push', '-u', remote, 'HEAD'], { timeoutMs: NETWORK_TIMEOUT_MS })
}

/** Nome da pasta que o `git clone` criaria para a URL. */
export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).at(-1) ?? ''
  return last.replace(/\.git$/, '') || 'repositorio'
}
