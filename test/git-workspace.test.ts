import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readVault } from '@vvpost/core/vault'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseStatus } from '../src/main/workspace/git'
import * as ws from '../src/main/workspace'
import { SECRETS_FILE, findMissingSecrets, redactEnvironment } from '../src/main/workspace/vault'

const dirs: string[] = []
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const write = (dir: string, path: string, content: unknown) => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
}

const env = (secretValue: string) => ({
  id: 'env.dev',
  name: 'Dev',
  variables: {
    BASE_URL: { type: 'string', value: 'https://dev.api', isSecret: false },
    CLIENT_SECRET: {
      type: 'string',
      value: secretValue,
      isSecret: true,
      description: 'Secret do Keycloak',
      placeholder: 'cole aqui'
    }
  }
})

beforeAll(() => {
  // Identidade só para os commits do teste, sem depender do ~/.gitconfig da máquina.
  process.env['GIT_AUTHOR_NAME'] = process.env['GIT_COMMITTER_NAME'] = 'VVPost Teste'
  process.env['GIT_AUTHOR_EMAIL'] = process.env['GIT_COMMITTER_EMAIL'] = 'teste@vvpost.dev'
})

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Repositório "remoto" bare com um commit: ambiente redigido e um conector. */
function remoteWithWorkspace(): string {
  const seed = tmp('vvpost-seed-')
  sh(seed, 'init', '-b', 'main')
  write(seed, 'environments/dev.env.json', env('__REQUIRED_SECRET__'))
  write(seed, 'connectors/billing.connector.vvpost.json', { id: 'connector.billing', name: 'Billing' })
  sh(seed, 'add', '-A')
  sh(seed, 'commit', '-m', 'inicial')
  const bare = tmp('vvpost-remote-')
  sh(bare, 'clone', '--bare', seed, '.')
  return bare
}

describe('parseStatus', () => {
  it('lê branch, upstream, ahead/behind e cada tipo de mudança', () => {
    const out = [
      '# branch.oid 1234567890abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a b.json',
      '1 A. N... 000000 100644 100644 000 bbb novo.json',
      '1 .D N... 100644 100644 000000 aaa aaa apagado.json',
      '2 R. N... 100644 100644 100644 aaa aaa R100 depois.json',
      'antes.json',
      'u UU N... 100644 100644 100644 100644 a b c conflito.json',
      '? solto.txt',
      ''
    ].join('\0')
    const s = parseStatus(out)
    expect(s).toMatchObject({ branch: 'main', head: '1234567', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(s.changes).toEqual([
      { path: 'apagado.json', kind: 'deleted', staged: false, unstaged: true },
      { path: 'conflito.json', kind: 'conflicted', staged: false, unstaged: true },
      { path: 'depois.json', origPath: 'antes.json', kind: 'renamed', staged: true, unstaged: false },
      { path: 'novo.json', kind: 'added', staged: true, unstaged: false },
      { path: 'solto.txt', kind: 'untracked', staged: false, unstaged: true },
      { path: 'src/a b.json', kind: 'modified', staged: false, unstaged: true }
    ])
  })
})

describe('redação de segredos', () => {
  it('troca valores isSecret em texto puro por __REQUIRED_SECRET__', () => {
    const out = redactEnvironment(env('s3cr3t') as never)
    expect(out.secrets).toEqual([{ environmentId: 'env.dev', variable: 'CLIENT_SECRET', value: 's3cr3t' }])
    expect(out.env.variables['CLIENT_SECRET']!.value).toBe('__REQUIRED_SECRET__')
    expect(out.env.variables['BASE_URL']!.value).toBe('https://dev.api')
    expect(redactEnvironment(env('__REQUIRED_SECRET__') as never).secrets).toEqual([])
  })
})

// Cada teste roda dezenas de comandos git; no Windows o spawn é lento e passa dos 5 s padrão.
describe('Git Workspace', { timeout: 60_000 }, () => {
  it('clona, lista segredos pendentes e grava os valores fora do Git', async () => {
    const remote = remoteWithWorkspace()
    const dir = await ws.cloneInto(tmp('vvpost-clones-'), remote)
    let state = await ws.readState(dir)
    expect(state).toMatchObject({ isRepo: true, branch: 'main', upstream: 'origin/main', changes: [] })
    expect(state.missingSecrets).toEqual([
      {
        environmentId: 'env.dev',
        environmentName: 'Dev',
        file: 'environments/dev.env.json',
        variable: 'CLIENT_SECRET',
        description: 'Secret do Keycloak',
        placeholder: 'cole aqui'
      }
    ])

    // Só segredos pendentes do workspace são aceitos.
    state = await ws.saveSecrets(dir, [
      { environmentId: 'env.dev', variable: 'CLIENT_SECRET', value: 'valor-real' },
      { environmentId: 'env.dev', variable: 'BASE_URL', value: 'x' },
      { environmentId: '__proto__', variable: 'polui', value: 'x' }
    ])
    expect(state.missingSecrets).toEqual([])
    expect(await readVault(dir)).toEqual({
      'env.dev': { CLIENT_SECRET: 'valor-real' }
    })
    // O cofre fica fora da pasta: nada no workspace muda, nem o .gitignore.
    expect(existsSync(join(dir, SECRETS_FILE))).toBe(false)
    expect(state.changes).toEqual([])
  })

  it('com core.autocrlf, o ambiente redigido igual ao HEAD não vai para o commit', async () => {
    // Como no Windows: o checkout grava CRLF e o app regrava com LF; o status marca ` M` com o mesmo blob.
    const dir = join(tmp('vvpost-clones-'), 'crlf')
    sh(tmpdir(), '-c', 'core.autocrlf=true', 'clone', '-q', remoteWithWorkspace(), dir)
    sh(dir, 'config', 'core.autocrlf', 'true')
    expect(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8')).toContain('\r\n')
    write(dir, 'environments/dev.env.json', env('vazaria'))
    const same = await ws.commitPaths(dir, 'Só o segredo', ['environments/dev.env.json'])
    expect(same).toMatchObject({ commit: null, committed: [], redacted: [{ file: 'environments/dev.env.json', variables: ['CLIENT_SECRET'] }] })
    expect((await readVault(dir))['env.dev']!.CLIENT_SECRET).toBe('vazaria')
  })

  it('redige o ambiente no commit e mostra o diff já redigido', async () => {
    const dir = await ws.cloneInto(tmp('vvpost-clones-'), remoteWithWorkspace())
    write(dir, 'environments/dev.env.json', env('vazaria'))
    write(dir, 'connectors/billing.connector.vvpost.json', { id: 'connector.billing', name: 'Billing v2' })

    const state = await ws.readState(dir)
    expect(state.unredacted).toEqual([{ file: 'environments/dev.env.json', variables: ['CLIENT_SECRET'] }])

    const diff = await ws.diffFile(dir, 'environments/dev.env.json')
    expect(diff.after).not.toContain('vazaria')
    expect(diff.before).toBe(diff.after)
    const conn = await ws.diffFile(dir, 'connectors/billing.connector.vvpost.json')
    expect(conn.before).toContain('"Billing"')
    expect(conn.after).toContain('"Billing v2"')
    await expect(ws.diffFile(dir, '../fora.json')).rejects.toThrow()

    await expect(ws.commitPaths(dir, '  ', ['environments/dev.env.json'])).rejects.toThrow(/mensagem/)
    await expect(ws.commitPaths(dir, 'x', ['nao-mudou.json'])).rejects.toThrow(/não tem mudanças/)

    // Só o segredo mudou: redigido, o ambiente fica igual ao HEAD e não há o que commitar.
    const same = await ws.commitPaths(dir, 'Só o segredo', ['environments/dev.env.json'])
    expect(same).toMatchObject({ commit: null, committed: [], redacted: [{ file: 'environments/dev.env.json', variables: ['CLIENT_SECRET'] }] })
    expect((await readVault(dir))['env.dev']!.CLIENT_SECRET).toBe('vazaria')

    const changed = env('vazaria-2')
    changed.variables.BASE_URL.value = 'https://dev2.api'
    write(dir, 'environments/dev.env.json', changed)
    const out = await ws.commitPaths(dir, 'Atualiza ambiente', ['environments/dev.env.json'])
    expect(out.redacted).toEqual([{ file: 'environments/dev.env.json', variables: ['CLIENT_SECRET'] }])
    expect(out.committed).toEqual(['environments/dev.env.json'])
    expect(sh(dir, 'show', 'HEAD:environments/dev.env.json')).not.toContain('vazaria')
    expect(sh(dir, 'show', 'HEAD:environments/dev.env.json')).toContain('dev2.api')
    expect(sh(dir, 'log', '-1', '--format=%s').trim()).toBe('Atualiza ambiente')
    expect((await readVault(dir))['env.dev']!.CLIENT_SECRET).toBe('vazaria-2')
    expect(sh(dir, 'ls-files')).not.toContain('secrets.local.json')
    // O conector não escolhido continua pendente; o ambiente redigido no disco não tem mais mudança.
    expect(out.state.changes.map((c) => c.path)).toEqual(['connectors/billing.connector.vvpost.json'])
    expect(out.state).toMatchObject({ ahead: 1, unredacted: [] })
    expect(await findMissingSecrets(dir)).toEqual([])
  })

  it('cria branch, publica no remoto e faz pull fast-forward', async () => {
    const remote = remoteWithWorkspace()
    const a = await ws.cloneInto(tmp('vvpost-a-'), remote)
    const b = await ws.cloneInto(tmp('vvpost-b-'), remote)

    let state = await ws.createBranch(a, 'feature/novo-endpoint')
    expect(state.branch).toBe('feature/novo-endpoint')
    await expect(ws.createBranch(a, 'nome inválido')).rejects.toThrow()
    write(a, 'connectors/novo.connector.vvpost.json', { id: 'connector.novo', name: 'Novo' })
    await ws.commitPaths(a, 'Novo conector', ['connectors/novo.connector.vvpost.json'])
    state = await ws.sync(a, 'push')
    expect(state).toMatchObject({ upstream: 'origin/feature/novo-endpoint', ahead: 0 })
    expect(sh(remote, 'branch', '--list', 'feature/*')).toContain('feature/novo-endpoint')

    // Em b: busca, troca para a branch remota (cria a local rastreando) e depois faz pull.
    state = await ws.sync(b, 'fetch')
    expect(state.branches.map((br) => br.name)).toContain('origin/feature/novo-endpoint')
    state = await ws.checkout(b, 'origin/feature/novo-endpoint')
    expect(state).toMatchObject({ branch: 'feature/novo-endpoint', upstream: 'origin/feature/novo-endpoint' })

    write(a, 'connectors/novo.connector.vvpost.json', { id: 'connector.novo', name: 'Novo 2' })
    await ws.commitPaths(a, 'Renomeia', ['connectors/novo.connector.vvpost.json'])
    await ws.sync(a, 'push')
    state = await ws.sync(b, 'pull')
    expect(readFileSync(join(b, 'connectors/novo.connector.vvpost.json'), 'utf8')).toContain('Novo 2')
    expect(state.behind).toBe(0)
    await expect(ws.sync(b, 'reset' as never)).rejects.toThrow(/desconhecida/)
  })

  it('pull com branch divergente faz merge; conflitos se resolvem no app', async () => {
    const remote = remoteWithWorkspace()
    const a = await ws.cloneInto(tmp('vvpost-a-'), remote)
    const b = await ws.cloneInto(tmp('vvpost-b-'), remote)
    const connector = 'connectors/billing.connector.vvpost.json'

    // Arquivos diferentes: o pull faz o commit de merge sozinho.
    write(a, 'connectors/a.connector.vvpost.json', { id: 'a', name: 'A' })
    await ws.commitPaths(a, 'Conector A', ['connectors/a.connector.vvpost.json'])
    await ws.sync(a, 'push')
    write(b, 'connectors/b.connector.vvpost.json', { id: 'b', name: 'B' })
    await ws.commitPaths(b, 'Conector B', ['connectors/b.connector.vvpost.json'])
    let state = await ws.sync(b, 'pull')
    expect(state).toMatchObject({ operation: null, changes: [], ahead: 2, behind: 0 })
    await ws.sync(b, 'push')
    await ws.sync(a, 'pull')

    // Mesma linha nos dois lados: o pull para no merge com o conflito.
    write(a, connector, { id: 'connector.billing', name: 'Billing A' })
    await ws.commitPaths(a, 'Nome A', [connector])
    await ws.sync(a, 'push')
    write(b, connector, { id: 'connector.billing', name: 'Billing B' })
    await ws.commitPaths(b, 'Nome B', [connector])
    state = await ws.sync(b, 'pull')
    expect(state.operation).toBe('merge')
    expect(state.changes).toEqual([{ path: connector, kind: 'conflicted', staged: false, unstaged: true }])
    await expect(ws.finishMerge(b)).rejects.toThrow(/conflito/)

    const conflict = await ws.readConflict(b, connector)
    expect(conflict.ours).toContain('Billing B')
    expect(conflict.theirs).toContain('Billing A')
    expect(conflict.base).toContain('"Billing"')
    expect(conflict.working).toContain('<<<<<<<')
    await expect(ws.resolveConflict(b, connector, { content: conflict.working! })).rejects.toThrow(/marcadores/)
    await expect(ws.readConflict(b, 'connectors/b.connector.vvpost.json')).rejects.toThrow(/não está em conflito/)

    state = await ws.resolveConflict(b, connector, { use: 'theirs' })
    expect(state.changes).toEqual([{ path: connector, kind: 'modified', staged: true, unstaged: false }])
    const done = await ws.finishMerge(b)
    expect(done.state).toMatchObject({ operation: null, changes: [], behind: 0 })
    expect(sh(b, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
    expect(readFileSync(join(b, connector), 'utf8')).toContain('Billing A')
  })

  it('ambiente resolvido com segredo em texto puro é redigido; abortar desfaz o merge', async () => {
    const remote = remoteWithWorkspace()
    const a = await ws.cloneInto(tmp('vvpost-a-'), remote)
    const b = await ws.cloneInto(tmp('vvpost-b-'), remote)
    const envFile = 'environments/dev.env.json'
    const withUrl = (url: string) => ({ ...env('__REQUIRED_SECRET__'), variables: { ...env('__REQUIRED_SECRET__').variables, BASE_URL: { type: 'string', value: url, isSecret: false } } })

    write(a, envFile, withUrl('https://a.api'))
    await ws.commitPaths(a, 'URL A', [envFile])
    await ws.sync(a, 'push')
    write(b, envFile, withUrl('https://b.api'))
    await ws.commitPaths(b, 'URL B', [envFile])
    let state = await ws.sync(b, 'pull')
    expect(state.operation).toBe('merge')

    state = await ws.abortMerge(b)
    expect(state).toMatchObject({ operation: null, changes: [] })
    expect(readFileSync(join(b, envFile), 'utf8')).toContain('b.api')

    await ws.sync(b, 'pull')
    const resolved = { ...env('vazaria'), variables: { ...env('vazaria').variables, BASE_URL: { type: 'string', value: 'https://ab.api', isSecret: false } } }
    state = await ws.resolveConflict(b, envFile, { content: `${JSON.stringify(resolved, null, 2)}\n` })
    await ws.finishMerge(b)
    const committed = sh(b, 'show', `HEAD:${envFile}`)
    expect(committed).toContain('ab.api')
    expect(committed).not.toContain('vazaria')
    expect((await readVault(b))['env.dev']!.CLIENT_SECRET).toBe('vazaria')
    expect(existsSync(join(b, SECRETS_FILE))).toBe(false)
  })

  it('pasta sem Git: estado vazio, e git init cria o repositório', async () => {
    const dir = tmp('vvpost-plain-')
    write(dir, 'environments/x.env.json', env('__REQUIRED_SECRET__'))
    expect(await ws.readState(dir)).toMatchObject({ isRepo: false, changes: [] })
    const state = await ws.initRepository(dir)
    expect(state.isRepo).toBe(true)
    expect(state.head).toBeNull()
    const out = await ws.commitPaths(dir, 'Primeiro commit', ['environments/x.env.json'])
    expect(out.state.head).toBe(out.commit)
    await expect(ws.sync(dir, 'push')).rejects.toThrow(/remoto/)
  })
})
