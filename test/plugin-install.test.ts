import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ArchiveError, extractArchive, readArchive, writeZip } from '@vvpost/core/plugins/archive'
import { PluginManager } from '@vvpost/core/plugins/manager'
import { checkRegistryUrl, compareVersions, parseRegistryIndex, sha256Hex } from '@vvpost/core/plugins/registry'
import { generateSigningKey, signPluginDir, SIGNATURE_FILE, verifyPluginDir } from '@vvpost/core/plugins/signature'
import { main, type Io } from '../src/main/cli/index'

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')
const LIMITS = { maxFiles: 100, maxBytes: 1024 * 1024 }

/** .tar ustar à mão: [nome, conteúdo, tipo]. */
function makeTar(entries: [string, string, string?][]): Buffer {
  const blocks: Buffer[] = []
  for (const [name, content, type = '0'] of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${Buffer.byteLength(content).toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write(type, 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const b of header) sum += b
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    const data = Buffer.from(content)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

let tmp: string
let userData: string
let manager: PluginManager
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vvpost-pinst-'))
  userData = mkdtempSync(join(tmpdir(), 'vvpost-pinst-ud-'))
  manager = new PluginManager({ officialDir: OFFICIAL, userDir: join(userData, 'plugins'), stateFile: join(userData, 'plugins.json'), graceMs: 200 })
})
afterEach(async () => {
  await manager.shutdown()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

function write(root: string, path: string, data: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

/** Pasta de um plugin acme-hello na versão dada. */
function plugin(version = '1.0.0', name = `acme-${version}`): string {
  const dir = join(tmp, name)
  write(dir, 'vvpost-plugin.json', {
    id: 'acme-hello',
    name: 'Acme Hello',
    version,
    author: 'Acme',
    main: 'index.js',
    apiVersion: 1,
    permissions: { network: ['api.acme.dev'] },
    contributes: { nodes: [{ type: 'acme.hello', title: 'Hello' }] }
  })
  write(dir, 'index.js', `module.exports = { nodes: { 'acme.hello': { run: () => 'olá ${version}' } } }`)
  write(dir, 'lib/util.js', 'module.exports = 1')
  return dir
}

async function zipOf(dir: string, prefix = ''): Promise<Buffer> {
  const files = ['vvpost-plugin.json', 'index.js', 'lib/util.js', ...(existsSync(join(dir, SIGNATURE_FILE)) ? [SIGNATURE_FILE] : [])]
  return writeZip(files.map((f) => ({ path: prefix + f, data: readFileSync(join(dir, f)) })))
}

describe('pacotes de plugin', () => {
  it('zip vai e volta; tgz e tar com nomes longos do pax; a pasta única vira a raiz', async () => {
    const zip = writeZip([
      { path: 'a.txt', data: Buffer.from('a'.repeat(5000)) },
      { path: 'dir/b.json', data: Buffer.from('{}') }
    ])
    expect(readArchive(zip, LIMITS).map((e) => [e.path, e.data.length])).toEqual([['a.txt', 5000], ['dir/b.json', 2]])
    const longName = `${'x'.repeat(120)}.js`
    const tar = makeTar([
      ['package/', '', '5'],
      // O tamanho no início do registro pax não é conferido pelo leitor.
      ['PaxHeader', `999 path=package/${longName}\n`, 'x'],
      ['ignored-short-name', 'longo'],
      ['package/vvpost-plugin.json', '{}']
    ])
    const entries = readArchive(gzipSync(tar), LIMITS)
    expect(entries.map((e) => e.path)).toEqual([`package/${longName}`, 'package/vvpost-plugin.json'])
    const file = join(tmp, 'p.tgz')
    writeFileSync(file, gzipSync(tar))
    const root = await extractArchive(file, join(tmp, 'out'), LIMITS)
    expect(root).toBe(join(tmp, 'out', 'package'))
    expect(readFileSync(join(root, longName), 'utf8')).toBe('longo')
  })

  it('recusa caminhos que saem da pasta, links, nomes repetidos e pacotes grandes demais', () => {
    const bad = (path: string) => writeZip([{ path, data: Buffer.from('x') }])
    expect(() => readArchive(bad('../evil.js'), LIMITS)).toThrow('caminho com ".." no pacote: ../evil.js')
    expect(() => readArchive(bad('/etc/passwd'), LIMITS)).toThrow('caminho absoluto no pacote')
    expect(() => readArchive(bad('C:\\Windows\\x'), LIMITS)).toThrow('caminho absoluto no pacote')
    expect(() => readArchive(makeTar([['link', '', '2']]), LIMITS)).toThrow('links não são aceitos')
    expect(() => readArchive(makeTar([['a', '1'], ['A', '2']]), LIMITS)).toThrow('A aparece duas vezes')
    expect(() => readArchive(writeZip([{ path: 'big', data: Buffer.alloc(2 * 1024 * 1024) }]), LIMITS)).toThrow('passa de 1 MB')
    expect(() => readArchive(Buffer.from('não é pacote'), LIMITS)).toThrow(ArchiveError)
    // Um zip com o conteúdo trocado depois de feito: o CRC denuncia.
    const zip = writeZip([{ path: 'a.txt', data: Buffer.from('a'.repeat(10)) }])
    const tampered = Buffer.from(zip)
    tampered[30 + 'a.txt'.length]! ^= 1
    expect(() => readArchive(tampered, LIMITS)).toThrow(/CRC|deflate/)
  })
})

describe('assinatura de plugins', () => {
  it('confere a pasta inteira: arquivo mudado, acrescentado ou faltando invalida', async () => {
    const key = generateSigningKey()
    const dir = plugin()
    const manifest = { id: 'acme-hello', version: '1.0.0' }
    expect(await verifyPluginDir(dir, manifest)).toEqual({ status: 'unsigned' })
    write(dir, SIGNATURE_FILE, await signPluginDir(dir, key.privateKeyPem, manifest))
    expect(await verifyPluginDir(dir, manifest)).toEqual({ status: 'valid', publicKey: key.publicKey, fingerprint: key.fingerprint })
    expect(key.fingerprint).toMatch(/^([0-9a-f]{4}:){7}[0-9a-f]{4}$/)
    expect(await verifyPluginDir(dir, { id: 'acme-hello', version: '1.0.1' })).toMatchObject({ status: 'invalid', reason: 'a assinatura é de acme-hello@1.0.0, não de acme-hello@1.0.1' })

    write(dir, 'lib/util.js', 'module.exports = 2')
    expect(await verifyPluginDir(dir, manifest)).toMatchObject({ status: 'invalid', reason: 'lib/util.js mudou depois da assinatura' })
    write(dir, 'lib/util.js', 'module.exports = 1')
    write(dir, 'extra.js', '')
    expect(await verifyPluginDir(dir, manifest)).toMatchObject({ status: 'invalid', reason: 'extra.js não está na assinatura (arquivo acrescentado)' })
    rmSync(join(dir, 'extra.js'))
    rmSync(join(dir, 'lib/util.js'))
    expect(await verifyPluginDir(dir, manifest)).toMatchObject({ status: 'invalid', reason: 'lib/util.js está na assinatura mas falta no plugin' })

    // Trocar a chave pública no arquivo não ajuda: a assinatura é sobre ela também.
    write(dir, 'lib/util.js', 'module.exports = 1')
    const sig = JSON.parse(readFileSync(join(dir, SIGNATURE_FILE), 'utf8'))
    write(dir, SIGNATURE_FILE, { ...sig, publicKey: generateSigningKey().publicKey })
    expect(await verifyPluginDir(dir, manifest)).toMatchObject({ status: 'invalid', reason: 'a assinatura não confere com a chave' })
  })
})

describe('instalar de arquivo', () => {
  it('prévia com assinatura não confiável, instalação confiando na chave, e a atualização exige a mesma chave', async () => {
    const key = generateSigningKey()
    const v1 = plugin('1.0.0')
    write(v1, SIGNATURE_FILE, await signPluginDir(v1, key.privateKeyPem, { id: 'acme-hello', version: '1.0.0' }))
    const file = join(tmp, 'acme-1.0.0.zip')
    writeFileSync(file, await zipOf(v1, 'package/'))

    const preview = await manager.previewArchive(file)
    expect(preview).toMatchObject({
      canInstall: true,
      origin: { kind: 'archive', location: file },
      signature: { status: 'untrusted', fingerprint: key.fingerprint },
      plugin: { id: 'acme-hello', version: '1.0.0', permissions: { network: ['api.acme.dev'] } },
      files: 4
    })
    const catalog = await manager.install(preview.id, { trustKey: true })
    expect(catalog.trustedKeys).toMatchObject([{ publicKey: key.publicKey, fingerprint: key.fingerprint, name: 'Acme' }])
    expect(catalog.plugins.find((p) => p.id === 'acme-hello')).toMatchObject({
      version: '1.0.0',
      signature: { status: 'trusted', signer: 'Acme' },
      origin: { kind: 'archive', location: file }
    })
    // A pasta temporária some depois da instalação.
    expect(existsSync(`${join(userData, 'plugins')}.staging`)).toBe(false)

    // Versão nova sem assinatura: recusada, porque a instalada foi assinada.
    const v2 = plugin('1.1.0')
    writeFileSync(file, await zipOf(v2))
    const unsigned = await manager.previewArchive(file)
    expect(unsigned.canInstall).toBe(false)
    expect(unsigned.problems).toEqual([`a versão instalada (1.0.0) foi assinada por ${key.fingerprint}; esta não tem essa assinatura. Remova o plugin antes, se a troca for esperada`])

    // Assinada pela mesma chave: atualiza, já como confiável.
    write(v2, SIGNATURE_FILE, await signPluginDir(v2, key.privateKeyPem, { id: 'acme-hello', version: '1.1.0' }))
    writeFileSync(file, await zipOf(v2))
    const update = await manager.previewArchive(file)
    expect(update).toMatchObject({ canInstall: true, replaces: '1.0.0', signature: { status: 'trusted', signer: 'Acme' } })
    await manager.install(update.id)

    // Deixar de confiar na chave: o plugin segue instalado, agora com a chave não confiável.
    const after = await manager.untrustKey(key.publicKey)
    expect(after.plugins.find((p) => p.id === 'acme-hello')?.signature).toMatchObject({ status: 'untrusted' })
    expect(JSON.parse(readFileSync(join(userData, 'plugins.json'), 'utf8'))).toEqual({ disabled: [] })
  })

  it('assinatura que não confere e pacote inválido impedem a instalação', async () => {
    const key = generateSigningKey()
    const dir = plugin()
    write(dir, SIGNATURE_FILE, await signPluginDir(dir, key.privateKeyPem, { id: 'acme-hello', version: '1.0.0' }))
    write(dir, 'index.js', 'module.exports = { nodes: { "acme.hello": { run: () => "trocado" } } }')
    const file = join(tmp, 'p.zip')
    writeFileSync(file, await zipOf(dir))
    const preview = await manager.previewArchive(file)
    expect(preview.canInstall).toBe(false)
    expect(preview.problems).toEqual(['assinatura inválida: index.js mudou depois da assinatura'])

    writeFileSync(file, writeZip([{ path: '../x.js', data: Buffer.from('') }]))
    expect(await manager.previewArchive(file)).toMatchObject({ canInstall: false, problems: ['caminho com ".." no pacote: ../x.js'] })
  })
})

describe('registro de plugins', () => {
  let server: Server
  let base: string
  const files = new Map<string, Buffer>()
  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = files.get(req.url ?? '')
      res.statusCode = body ? 200 : 404
      res.end(body ?? 'not found')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  it('lista, baixa, confere o SHA-256 e a chave fixada pelo registro', async () => {
    const key = generateSigningKey()
    const dir = plugin('2.0.0')
    write(dir, SIGNATURE_FILE, await signPluginDir(dir, key.privateKeyPem, { id: 'acme-hello', version: '2.0.0' }))
    const zip = await zipOf(dir)
    files.set('/pkgs/acme-hello-2.0.0.zip', zip)
    const index = (sha256: string, publicKey = key.publicKey) => ({
      version: 1,
      name: 'Acme Plugins',
      plugins: [
        {
          id: 'acme-hello',
          name: 'Acme Hello',
          author: 'Acme',
          publicKey,
          versions: [
            { version: '1.0.0', url: 'pkgs/old.zip', sha256: '0'.repeat(64) },
            { version: '2.0.0', url: 'pkgs/acme-hello-2.0.0.zip', sha256 },
            { version: '3.0.0-beta.1', url: 'pkgs/beta.zip', sha256: '0'.repeat(64) }
          ]
        }
      ]
    })
    const url = `${base}/vvpost-registry.json`
    files.set('/vvpost-registry.json', Buffer.from(JSON.stringify(index(sha256Hex(zip)))))

    const catalog = await manager.addRegistry(url)
    expect(catalog.registries).toEqual([url])
    expect(await manager.browseRegistries()).toEqual([
      { url, name: 'Acme Plugins', plugins: [{ id: 'acme-hello', name: 'Acme Hello', author: 'Acme', latest: '2.0.0', versions: ['1.0.0', '2.0.0', '3.0.0-beta.1'], signed: true }] }
    ])
    const preview = await manager.previewRegistry(url, 'acme-hello')
    expect(preview).toMatchObject({
      canInstall: true,
      origin: { kind: 'registry', location: `${base}/pkgs/acme-hello-2.0.0.zip`, registry: url },
      signature: { status: 'trusted', signer: 'registro Acme Plugins' }
    })
    await manager.install(preview.id)
    expect((await manager.browseRegistries())[0]?.plugins[0]).toMatchObject({ installed: '2.0.0' })

    // Hash que não confere, chave fixada diferente, versão que não existe.
    files.set('/vvpost-registry.json', Buffer.from(JSON.stringify(index('1'.repeat(64)))))
    expect((await manager.previewRegistry(url, 'acme-hello')).problems).toEqual([`o pacote baixado não confere com o SHA-256 do registro (${base}/pkgs/acme-hello-2.0.0.zip)`])
    const other = generateSigningKey()
    files.set('/vvpost-registry.json', Buffer.from(JSON.stringify(index(sha256Hex(zip), other.publicKey))))
    expect((await manager.previewRegistry(url, 'acme-hello')).problems).toContain(
      `o pacote foi assinado por ${key.fingerprint}, não pela chave que o registro Acme Plugins fixa (${other.fingerprint})`
    )
    expect((await manager.previewRegistry(url, 'acme-hello', '9.9.9')).problems).toEqual(['o registro não tem acme-hello@9.9.9'])

    files.delete('/vvpost-registry.json')
    expect(await manager.browseRegistries()).toMatchObject([{ url, error: `${url} respondeu HTTP 404`, plugins: [] }])
    expect((await manager.removeRegistry(url)).registries).toEqual([])
  })

  it('índice inválido, URL sem HTTPS e ordem do semver', async () => {
    expect(() => checkRegistryUrl('http://plugins.example.com/r.json')).toThrow('o registro precisa de https://')
    expect(checkRegistryUrl('http://localhost:8080/r.json').host).toBe('localhost:8080')
    expect(() => checkRegistryUrl('https://user:pw@x.dev/r.json')).toThrow('usuário e senha')
    expect(() => parseRegistryIndex('{"version":2}', 'https://x.dev/r.json')).toThrow('formato 1')
    expect(() =>
      parseRegistryIndex(JSON.stringify({ version: 1, plugins: [{ id: 'a', name: 'A', versions: [{ version: '1', url: 'a.zip', sha256: 'x' }] }] }), 'https://x.dev/r.json')
    ).toThrow('plugins[0].versions[0]: version não é semver')
    expect(() =>
      parseRegistryIndex(
        JSON.stringify({ version: 1, plugins: [{ id: 'a', name: 'A', versions: [{ version: '1.0.0', url: 'http://evil.dev/a.zip', sha256: '0'.repeat(64) }] }] }),
        'https://x.dev/r.json'
      )
    ).toThrow('https://')
    await expect(manager.addRegistry('https://127.0.0.1:1/nada.json')).rejects.toThrow(/não foi possível baixar/)
    expect(['1.0.0', '1.0.0-beta.2', '1.0.0-beta.10', '0.9.0', '1.0.0-alpha'].sort(compareVersions)).toEqual(['0.9.0', '1.0.0-alpha', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0'])
  })
})

describe('vvpost plugin (CLI)', () => {
  const io = () => {
    const out: string[] = []
    const err: string[] = []
    const value: Io = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), env: {}, cwd: tmp, isTTY: false, appDir: join(OFFICIAL, '..') }
    return { value, out, err }
  }

  it('keygen, pack assinando, verify da pasta e do pacote', async () => {
    const dir = plugin('1.2.0', 'cli-plugin')
    const k = io()
    expect(await main(['plugin', 'keygen', '--out', 'acme.key'], k.value)).toBe(0)
    expect(k.out.join('')).toMatch(/Impressão digital: ([0-9a-f]{4}:){7}[0-9a-f]{4}/)
    const p = io()
    expect(await main(['plugin', 'pack', 'cli-plugin', '--key', 'acme.key', '--out', 'out.zip'], p.value)).toBe(0)
    const zip = readFileSync(join(tmp, 'out.zip'))
    expect(p.out.join('')).toContain(`SHA-256: ${sha256Hex(zip)}`)
    expect(readArchive(zip, LIMITS).map((e) => e.path).sort()).toEqual(['index.js', 'lib/util.js', SIGNATURE_FILE, 'vvpost-plugin.json'].sort())
    const v = io()
    expect(await main(['plugin', 'verify', 'out.zip'], v.value)).toBe(0)
    expect(v.out.join('')).toMatch(/^acme-hello@1\.2\.0: assinatura válida/)
    write(dir, 'index.js', '// mudou')
    const bad = io()
    expect(await main(['plugin', 'verify', 'cli-plugin'], bad.value)).toBe(1)
    expect(bad.out.join('')).toBe('acme-hello@1.2.0: assinatura inválida: index.js mudou depois da assinatura\n')
    const missing = io()
    expect(await main(['plugin', 'sign', 'cli-plugin'], missing.value)).toBe(2)
    expect(missing.err.join('')).toBe('vvpost plugin: sign: informe --key <arquivo.key>\n')
  })
})
