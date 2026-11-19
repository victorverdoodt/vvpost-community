import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main, type Io } from '../src/main/cli'
import { HOOK_MARKER, guardRepository, hookScript } from '../src/main/workspace/commit-guard'

const SECRET = 'tok-guard-1234567890'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@exemplo.com', '-c', 'user.name=Teste', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' })

function write(dir: string, path: string, data: unknown) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
}

/** Repositório com o workspace em api/ (um projeto) e o vault local do projeto. */
function repo(): { root: string; ws: string } {
  const root = mkdtempSync(join(tmpdir(), 'vvpost-guard-'))
  dirs.push(root)
  sh(root, 'init', '-q')
  write(root, 'api/vvpost.project.json', { id: 'api', name: 'API' })
  write(root, 'api/environments/dev.env.json', { id: 'env.dev', name: 'Dev', variables: { TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } } })
  write(root, 'api/.vvpost/secrets.local.json', { 'env.dev': { TOKEN: SECRET } })
  write(root, '.gitignore', 'secrets.local.json\n')
  sh(root, 'add', '.gitignore', 'api/vvpost.project.json', 'api/environments')
  sh(root, 'commit', '-q', '-m', 'base')
  return { root, ws: join(root, 'api') }
}

async function cli(cwd: string, args: string[], self?: string[]) {
  let stdout = ''
  let stderr = ''
  const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd, isTTY: false, appDir: cwd, ...(self && { self }) }
  const code = await main(args, io)
  return { code, stdout, stderr }
}

describe('vvpost guard', () => {
  it('confere o index: valor do vault de um projeto, em qualquer forma, e o próprio vault', async () => {
    const { root, ws } = repo()
    write(root, 'notas.md', `token: ${Buffer.from(SECRET).toString('base64')}\n`)
    sh(root, 'add', 'notas.md')
    const leak = await cli(root, ['guard'])
    expect(leak.code).toBe(1)
    expect(leak.stderr).toContain('notas.md: o valor do segredo TOKEN do ambiente api:env.dev')
    expect(leak.stderr).not.toContain(SECRET)

    // O que vale é o index: corrigir só no disco não basta.
    write(root, 'notas.md', 'token: {{TOKEN}}\n')
    expect((await cli(root, ['guard'])).code).toBe(1)
    sh(root, 'add', 'notas.md')
    const clean = await cli(ws, ['guard', '--json', '-'])
    expect(clean.code).toBe(0)
    expect(JSON.parse(clean.stdout)).toEqual({ ok: true, checked: 1, leaks: [] })

    // O arquivo antigo, em texto puro, forçado no index: o guard recusa mesmo depois de migrado.
    write(root, 'api/.vvpost/secrets.local.json', { 'env.dev': { TOKEN: SECRET } })
    sh(root, 'add', '-f', 'api/.vvpost/secrets.local.json')
    const vault = await guardRepository(ws)
    expect(vault.leaks.map((l) => l.reason)).toContain('o arquivo de segredos locais do VVPost')
  })

  it('--all confere os arquivos versionados; credencial literal e chave PEM também contam', async () => {
    const { root } = repo()
    write(root, 'api/flows/loja.flow.vvpost.json', { id: 'loja', name: 'Loja', defaults: { baseUrl: 'https://loja.exemplo.com', auth: { type: 'bearer', token: 'literal-token-123' } }, nodes: [] })
    write(root, 'chave.pem', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n')
    sh(root, 'add', '.')
    sh(root, 'commit', '-q', '--no-verify', '-m', 'vazou')
    expect((await cli(root, ['guard'])).code).toBe(0)
    const all = await cli(root, ['guard', '--all'])
    expect(all.code).toBe(1)
    expect(all.stderr).toContain('api/flows/loja.flow.vvpost.json: credencial literal')
    expect(all.stderr).toContain('chave.pem: uma chave privada PEM')
  })

  it('fora de um repositório Git sai com 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-guard-nogit-'))
    dirs.push(dir)
    expect((await cli(dir, ['guard'])).code).toBe(2)
  })

  it('--install instala o hook, que recusa o commit com segredo', async () => {
    const { root, ws } = repo()
    // O "CLI" do fallback: registra os argumentos e recusa, como o guard faria ao achar segredo.
    const fake = join(root, 'fake-cli.mjs')
    writeFileSync(fake, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(root, 'called.txt'))}, process.argv.slice(2).join(' ') + ' ' + process.env.ELECTRON_RUN_AS_NODE)\nprocess.exit(1)\n`)
    const first = await cli(ws, ['guard', '--install'], [process.execPath, fake])
    expect(first.code).toBe(0)
    const hook = join(root, '.git/hooks/pre-commit')
    expect(readFileSync(hook, 'utf8')).toContain(HOOK_MARKER)
    // O Windows não tem bit de execução: o Git roda o hook pelo sh dele de qualquer jeito.
    if (process.platform !== 'win32') expect(statSync(hook).mode & 0o111).not.toBe(0)
    expect((await cli(ws, ['guard', '--install'], [process.execPath, fake])).stdout).toContain('já estava instalado')

    write(root, 'notas.md', 'x\n')
    sh(root, 'add', 'notas.md')
    // Sem vvpost no PATH, o hook roda o fallback (que recusa); o commit não acontece.
    const path = (process.env['PATH'] ?? '').split(delimiter).filter((p) => !['vvpost', 'vvpost.cmd', 'vvpost.exe'].some((b) => existsSync(join(p, b)))).join(delimiter)
    expect(() => execFileSync('git', ['-c', 'user.email=t@exemplo.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'x'], { cwd: root, stdio: 'pipe', env: { ...process.env, PATH: path } })).toThrow()
    expect(readFileSync(join(root, 'called.txt'), 'utf8')).toBe('guard --workspace api 1')
  })

  it('não sobrescreve um pre-commit que não é do VVPost', async () => {
    const { root, ws } = repo()
    write(root, '.git/hooks/pre-commit', '#!/bin/sh\necho outro\n')
    const r = await cli(ws, ['guard', '--install'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("vvpost guard --workspace 'api'")
    expect(readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8')).toBe('#!/bin/sh\necho outro\n')
  })

  it('o script usa o vvpost do PATH e aspas seguras', () => {
    const script = hookScript("pasta d'água", ['/opt/VVPost/vvpost', '/opt/VVPost/resources/app.asar/out/main/cli.js'])
    expect(script).toContain(`exec vvpost guard --workspace 'pasta d'\\''água'`)
    expect(script).toContain(`exec env ELECTRON_RUN_AS_NODE=1 '/opt/VVPost/vvpost' '/opt/VVPost/resources/app.asar/out/main/cli.js' guard`)
    expect(script.trimEnd().endsWith('exit 1')).toBe(true)
  })
})
