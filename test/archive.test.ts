import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { updateVault } from '@vvpost/core/vault'
import { readArchive, writeZip } from '@vvpost/core/plugins/archive'
import { projectLayout } from '@vvpost/core/projects'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import {
  ArchiveExportError,
  exportArchive,
  importArchiveAsProject,
  importArchiveAsWorkspace,
  MANIFEST_FILE,
  readWorkspaceArchive
} from '../src/main/bundle/archive'
import { main, type Io } from '../src/main/cli'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createMcpServer, type McpServer } from '../src/main/mcp/server'
import { readReviewMarks } from '../src/main/project/review'

// Valores montados em tempo de execução: nada com cara de credencial fica no repositório.
const VAULT_TOKEN = ['vault', 'token', '7f3e9a1c5b'].join('-')
const PLAIN_PASSWORD = ['senha', 'solta', '1a2b3c4d'].join('-')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function folder(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-archive-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const connector = (id: string, extra: object = {}) => ({
  id,
  name: id,
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
  endpoints: [{ id: 'ping', name: 'Ping', method: 'GET', path: '/ping' }],
  ...extra
})

const environment = {
  id: 'dev',
  name: 'Dev',
  variables: {
    BASE_URL: { type: 'string', value: 'https://api.exemplo.com' },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
    // Valor de credencial sem isSecret: vai no zip como pendente.
    db_password: { type: 'string', value: PLAIN_PASSWORD }
  }
}

/** Workspace com o Compartilhado (auth e dev) e dois projetos, docs, diagrama e estado local. */
async function multiProject(): Promise<string> {
  const root = folder({
    'connectors/auth.connector.vvpost.json': connector('auth'),
    'environments/dev.env.json': environment,
    'docs/projeto.md': '# Workspace\n',
    'vvpost.docs.json': { title: 'Docs' },
    '.vvpost/webhooks.json': { hooks: [] },
    '.vvpost/mcp-review.local.json': { pending: [] },
    '.git-not-a-repo/x.txt': 'oculto',
    'node_modules/pkg/index.js': 'module.exports = 1',
    'estoque/vvpost.project.json': { id: 'estoque', name: 'Estoque' },
    'estoque/connectors/produtos.connector.vvpost.json': { ...connector('produtos'), config: { basePath: '/produtos' }, extends: 'auth' },
    'estoque/docs/diagramas/fluxo.mmd': 'flowchart LR\n  a --> b\n',
    'cobranca/vvpost.project.json': { id: 'cobranca', name: 'Cobrança', description: 'Pix e boletos' },
    'cobranca/connectors/pix.connector.vvpost.json': connector('pix')
  })
  await updateVault(root, (s) => {
    s['dev'] = { API_TOKEN: VAULT_TOKEN }
  })
  return root
}

const entriesOf = (data: Buffer) => readArchive(data, { maxFiles: 1000, maxBytes: 10 * 1024 * 1024 })
const text = (data: Buffer) => entriesOf(data).map((e) => e.data.toString('utf8')).join('\n')

describe('zip do VVPost', () => {
  it('exporta o workspace inteiro com os projetos, sem segredo nem arquivo local', async () => {
    const root = await multiProject()
    const result = await exportArchive(join(root, 'estoque'), 'workspace')
    expect(result.manifest.kind).toBe('workspace')
    expect(result.manifest.projects?.map((p) => p.id)).toEqual(['cobranca', 'estoque'])
    const paths = entriesOf(result.data).map((e) => e.path)
    expect(paths).toContain(MANIFEST_FILE)
    expect(paths).toContain('estoque/docs/diagramas/fluxo.mmd')
    expect(paths).toContain('cobranca/vvpost.project.json')
    expect(paths).toContain('.vvpost/webhooks.json')
    expect(paths).not.toContain('.vvpost/mcp-review.local.json')
    expect(paths.some((p) => p.startsWith('node_modules/') || p.startsWith('.git-not-a-repo/'))).toBe(false)
    expect(result.summary).toMatchObject({ projects: 2, connectors: 3, environments: 1, pendingSecrets: 2 })
    const all = text(result.data)
    expect(all).not.toContain(VAULT_TOKEN)
    expect(all).not.toContain(PLAIN_PASSWORD)
    expect(result.warnings.join('\n')).toContain('db_password parece credencial')
  })

  it('num repositório Git, deixa de fora o que o .gitignore ignora', async () => {
    const root = await multiProject()
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), 'rascunho.txt\n')
    writeFileSync(join(root, 'rascunho.txt'), 'não vai')
    const paths = entriesOf((await exportArchive(root, 'workspace')).data).map((e) => e.path)
    expect(paths).toContain('.gitignore')
    expect(paths).toContain('estoque/vvpost.project.json')
    expect(paths).not.toContain('rascunho.txt')
    expect(paths).not.toContain('node_modules/pkg/index.js')
  })

  it('exporta só um projeto e avisa do que ele herda do Compartilhado', async () => {
    const root = await multiProject()
    const result = await exportArchive(join(root, 'estoque'), 'project')
    expect(result.manifest).toMatchObject({ kind: 'project', name: 'Estoque', project: { id: 'estoque' } })
    const paths = entriesOf(result.data).map((e) => e.path)
    expect(paths).toContain('vvpost.project.json')
    expect(paths).toContain('connectors/produtos.connector.vvpost.json')
    expect(paths.some((p) => p.startsWith('cobranca/') || p.startsWith('estoque/'))).toBe(false)
    expect(result.warnings.join('\n')).toContain('herda de auth, do Compartilhado')
  })

  it('recusa o zip com um valor do vault num arquivo', async () => {
    const root = await multiProject()
    writeFileSync(join(root, 'cobranca', 'notas.md'), `token: ${VAULT_TOKEN}\n`)
    const err = await exportArchive(root, 'workspace').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ArchiveExportError)
    expect((err as ArchiveExportError).leak).toBe(true)
    expect((err as Error).message).toContain('cobranca/notas.md')
    expect((err as Error).message).not.toContain(VAULT_TOKEN)
  })

  it('abre o zip do workspace numa pasta vazia, com os mesmos projetos', async () => {
    const root = await multiProject()
    const { data } = await exportArchive(root, 'workspace')
    const dest = join(folder(), 'novo')
    const read = readWorkspaceArchive(data, 'loja.vvpost.zip')
    const result = await importArchiveAsWorkspace(read, dest)
    expect(result.pendingSecrets).toBe(2)
    expect(projectLayout(dest).projects.map((p) => p.id)).toEqual(['cobranca', 'estoque'])
    expect(existsSync(join(dest, MANIFEST_FILE))).toBe(false)
    const ws = await loadWorkspace(join(dest, 'estoque'))
    expect(ws.connectors.get('produtos')?.extends).toBe('auth')
    expect(ws.issues).toEqual([])
    // Pasta com algo dentro: nada é gravado.
    await expect(importArchiveAsWorkspace(read, dest)).rejects.toThrow('não está vazia')
  })

  it('acrescenta o zip de um projeto em outro workspace, com outro id se pedir', async () => {
    const root = await multiProject()
    const { data } = await exportArchive(join(root, 'cobranca'), 'project')
    const read = readWorkspaceArchive(data)
    const other = folder({ 'cobranca/vvpost.project.json': { id: 'cobranca', name: 'Antiga' } })
    await expect(importArchiveAsProject(read, other)).rejects.toThrow('já tem o projeto')
    const result = await importArchiveAsProject(read, other, { id: 'cobranca-2' })
    expect(result.written).toContain('cobranca-2/connectors/pix.connector.vvpost.json')
    const project = JSON.parse(readFileSync(join(other, 'cobranca-2', 'vvpost.project.json'), 'utf8'))
    expect(project).toMatchObject({ id: 'cobranca-2', name: 'Cobrança', description: 'Pix e boletos' })
    expect(projectLayout(other).projects.map((p) => p.id).sort()).toEqual(['cobranca', 'cobranca-2'])
  })

  it('um zip de workspace com projetos não entra como projeto', async () => {
    const root = await multiProject()
    const read = readWorkspaceArchive((await exportArchive(root, 'workspace')).data)
    await expect(importArchiveAsProject(read, folder())).rejects.toThrow('abra-o como workspace novo')
  })

  it('lê a pasta zipada à mão: sem manifesto, numa pasta só, sem os segredos locais', () => {
    const zip = writeZip([
      { path: 'api/connectors/x.connector.vvpost.json', data: Buffer.from(JSON.stringify(connector('x'))) },
      { path: 'api/.vvpost/secrets.local.json', data: Buffer.from('{}') },
      { path: 'api/vvpost.project.json', data: Buffer.from(JSON.stringify({ id: 'api', name: 'API' })) }
    ])
    const read = readWorkspaceArchive(zip, 'api.zip')
    expect(read.manifest).toMatchObject({ kind: 'project', name: 'API', project: { id: 'api' } })
    expect(read.entries.map((e) => e.path).sort()).toEqual(['connectors/x.connector.vvpost.json', 'vvpost.project.json'])
    expect(read.warnings.join('\n')).toContain('arquivo local de segredos')
  })
})

describe('vvpost export --format zip e vvpost import <zip>', () => {
  async function cli(args: string[], cwd: string) {
    let stdout = ''
    let stderr = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd, isTTY: false, appDir: cwd }
    const code = await main(args, io)
    return { code, stdout, stderr }
  }

  it('exporta o workspace na raiz e o projeto com --project, e importa nos dois modos', async () => {
    const root = await multiProject()
    const out = folder()
    const whole = await cli(['export', '--workspace', root, '--format', 'zip', '--out', 'tudo.vvpost.zip'], out)
    expect(whole.code).toBe(0)
    expect(whole.stdout).toContain('Zip do workspace')
    expect(whole.stdout).toContain('2 projeto(s)')
    const one = await cli(['export', '--workspace', root, '--project', 'estoque', '--format', 'zip'], out)
    expect(one.code).toBe(0)
    expect(one.stdout).toContain('Zip do projeto estoque')
    expect(readdirSync(out).sort()).toEqual(['estoque.vvpost.zip', 'tudo.vvpost.zip'])

    // Pasta que não existe: abre como workspace.
    const opened = await cli(['import', join(out, 'tudo.vvpost.zip'), '--workspace', 'novo'], out)
    expect(opened.code).toBe(0)
    expect(opened.stdout).toContain('Workspace aberto do zip')
    expect(opened.stdout).toContain('2 segredo(s) sem valor')
    expect(projectLayout(join(out, 'novo')).projects).toHaveLength(2)

    // Workspace com o mesmo projeto: pede outro id, e --as resolve.
    const clash = await cli(['import', join(out, 'estoque.vvpost.zip'), '--workspace', 'novo'], out)
    expect(clash.code).toBe(2)
    expect(clash.stderr).toContain('--as')
    const dry = await cli(['import', join(out, 'estoque.vvpost.zip'), '--workspace', 'novo', '--as', 'estoque-b', '--dry-run'], out)
    expect(dry.stdout).toContain('Mudaria: projeto novo')
    expect(existsSync(join(out, 'novo', 'estoque-b'))).toBe(false)
    const added = await cli(['import', join(out, 'estoque.vvpost.zip'), '--workspace', 'novo', '--as', 'estoque-b'], out)
    expect(added.code).toBe(0)
    expect(projectLayout(join(out, 'novo')).projects.map((p) => p.id)).toContain('estoque-b')
  })

  it('recusa filtros com --format zip e sai com 1 quando há segredo', async () => {
    const root = await multiProject()
    expect((await cli(['export', '--workspace', root, '--format', 'zip', '--connector', 'auth'], root)).code).toBe(2)
    writeFileSync(join(root, 'notas.md'), VAULT_TOKEN)
    const leaked = await cli(['export', '--workspace', root, '--format', 'zip', '--out', join(folder(), 'x.zip')], root)
    expect(leaked.code).toBe(1)
    expect(leaked.stderr).not.toContain(VAULT_TOKEN)
  })
})

describe('export_project { format: "zip" } e import_bundle { archive } no MCP', () => {
  const http = { cancel() {}, send: async () => ({ ok: false as const, error: { code: 'X', message: 'sem rede' } }) }
  const server = (dir: string, extra: object = {}) => createMcpServer({ workspaceDir: dir, http: http as never, auth: createAuthEngine(), ...extra })
  async function call(s: McpServer, name: string, args: Record<string, unknown>) {
    const res = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    const text = res.result.content[0]!.text
    return { isError: res.result.isError, text, data: JSON.parse(text) }
  }

  it('grava o zip do projeto dentro dele, sem segredo, e recusa filtro e caminho de fora', async () => {
    const root = await multiProject()
    const s = server(root)
    const zip = await call(s, 'export_project', { project: 'estoque', format: 'zip' })
    expect(zip.data).toMatchObject({ ok: true, format: 'zip', file: 'dist/estoque.vvpost.zip', kind: 'project' })
    const data = readFileSync(join(root, 'estoque', zip.data.file))
    expect(data.length).toBe(zip.data.bytes)
    expect(text(data)).not.toContain(VAULT_TOKEN)
    // O workspace inteiro, e um segundo zip não leva o primeiro.
    const all = await call(s, 'export_project', { format: 'zip', scope: 'workspace', out: 'dist/tudo.vvpost.zip' })
    expect(all.data).toMatchObject({ kind: 'workspace', summary: expect.objectContaining({ projects: 2 }) })
    expect(entriesOf(readFileSync(join(root, 'dist/tudo.vvpost.zip'))).map((e) => e.path)).not.toContain('estoque/dist/estoque.vvpost.zip')
    expect((await call(s, 'export_project', { format: 'zip', connectors: ['auth'] })).data.code).toBe('INVALID_ARGS')
    expect((await call(s, 'export_project', { format: 'zip', out: '../fora.vvpost.zip' })).data.code).toBe('INVALID_ARGS')
    expect((await call(s, 'export_project', { format: 'zip', out: 'dist/x.zip' })).data.code).toBe('INVALID_ARGS')
    expect((await call(server(root, { noWrite: true }), 'export_project', { format: 'zip' })).data.code).toBe('BLOCKED')
    writeFileSync(join(root, 'notas.md'), VAULT_TOKEN)
    const leaked = await call(s, 'export_project', { format: 'zip', scope: 'workspace' })
    expect(leaked.data.code).toBe('BLOCKED')
    expect(leaked.text).not.toContain(VAULT_TOKEN)
  })

  it('o zip entra como projeto novo só com apply, e o que tem credencial ou código fica para revisão', async () => {
    const source = await multiProject()
    mkdirSync(join(source, 'cobranca/flows'), { recursive: true })
    writeFileSync(
      join(source, 'cobranca/flows/calc.flow.vvpost.json'),
      JSON.stringify({ id: 'calc', name: 'Cálculo', nodes: [{ id: 'py', type: 'python', name: 'Soma', python: { code: 'print(1)' } }], edges: [] })
    )
    const exported = await exportArchive(join(source, 'cobranca'), 'project')
    const dest = folder({ 'billing/vvpost.project.json': { id: 'billing', name: 'Billing' }, 'billing/connectors/x.connector.vvpost.json': connector('x') })
    writeFileSync(join(dest, 'billing/cobranca.vvpost.zip'), exported.data)
    const s = server(join(dest, 'billing'))

    const planned = await call(s, 'import_bundle', { archive: 'cobranca.vvpost.zip' })
    expect(planned.data).toMatchObject({ applied: false, kind: 'project', project: { id: 'cobranca', name: 'Cobrança' } })
    expect(existsSync(join(dest, 'cobranca'))).toBe(false)

    const applied = await call(s, 'import_bundle', { archive: 'cobranca.vvpost.zip', apply: true })
    expect(applied.data).toMatchObject({ ok: true, project: { id: 'cobranca' } })
    expect(applied.data.review).toEqual(expect.arrayContaining(['pix', 'flow:calc']))
    expect(projectLayout(dest).projects.map((p) => p.id).sort()).toEqual(['billing', 'cobranca'])
    const marks = await readReviewMarks(join(dest, 'cobranca'))
    expect(Object.keys(marks).sort()).toEqual(['flow:calc', 'pix'])
    // Com a marca, o conector importado só monta o plano.
    const run = await call(s, 'execute_dry_run', { project: 'cobranca', connectorId: 'pix', request: { endpointId: 'ping' } })
    expect(run.text).toMatch(/revis/)

    // O mesmo id de novo: conflito, e as resolve.
    expect((await call(s, 'import_bundle', { archive: 'cobranca.vvpost.zip' })).data.code).toBe('CONFLICT')
    expect((await call(s, 'import_bundle', { archive: 'cobranca.vvpost.zip', as: 'cobranca-b', apply: true })).data.ok).toBe(true)
    expect((await call(s, 'import_bundle', { archive: '../fora.vvpost.zip' })).data.code).toBe('INVALID_ARGS')
    expect((await call(s, 'import_bundle', { archive: 'nada.vvpost.zip' })).data.code).toBe('NOT_FOUND')
    expect((await call(s, 'import_bundle', {})).data.code).toBe('INVALID_ARGS')
  })

  it('um zip de workspace com projetos não entra pelo MCP', async () => {
    const root = await multiProject()
    const whole = await exportArchive(root, 'workspace')
    const dest = folder({ 'vvpost.project.json': { id: 'a', name: 'A' } })
    writeFileSync(join(dest, 'tudo.vvpost.zip'), whole.data)
    const blocked = await call(server(dest), 'import_bundle', { archive: 'tudo.vvpost.zip', apply: true })
    expect(blocked.data.code).toBe('VALIDATION')
    expect(blocked.data.hint).toContain('workspace novo')
  })
})
