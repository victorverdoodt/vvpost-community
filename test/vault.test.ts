import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { clearVaultKeyCache } from '@vvpost/core/keychain'
import { LEGACY_SECRETS_FILE, readVault, updateVault, vaultDir, vaultFile } from '@vvpost/core/vault'

const SECRET = 'tok-cofre-0123456789'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
const put = (dir: string, path: string, data: unknown) => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data))
}
/** Tudo o que existe numa pasta, como texto. */
const allText = (dir: string): string =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))
    .join('\n')

describe('cofre local', () => {
  it('grava cifrado fora da pasta do projeto, só para o dono, e lê de volta', async () => {
    const ws = tmp('vvpost-cofre-ws-')
    await updateVault(ws, (s) => (s['env.dev'] = { TOKEN: SECRET }))
    expect(await readVault(ws)).toEqual({ 'env.dev': { TOKEN: SECRET } })

    const file = await vaultFile(ws)
    expect(file.startsWith(vaultDir())).toBe(true)
    expect(file.startsWith(ws)).toBe(false)
    expect(allText(ws)).toBe('')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain(Buffer.from(SECRET).toString('base64'))
    expect(JSON.parse(raw)).toMatchObject({ vault: 1, keyStore: 'file' })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)

    // Cada pasta tem o seu cofre.
    const other = tmp('vvpost-cofre-outro-')
    expect(await readVault(other)).toEqual({})
  })

  it('o .vvpost/secrets.local.json antigo migra sozinho, vencendo o que já estava, e some', async () => {
    const ws = tmp('vvpost-cofre-mig-')
    await updateVault(ws, (s) => (s['env.dev'] = { A: 'cofre', B: 'cofre' }))
    put(ws, LEGACY_SECRETS_FILE, { 'env.dev': { B: 'antigo' }, 'env.hml': { C: SECRET }, __proto__: { x: 'y' } })
    // O loader do workspace lê pelo cofre e migra no caminho.
    const loaded = await loadWorkspace(ws)
    expect(loaded.secrets).toEqual({ 'env.dev': { A: 'cofre', B: 'antigo' }, 'env.hml': { C: SECRET } })
    expect(loaded.issues).toEqual([])
    expect(allText(ws)).not.toContain(SECRET)
    expect(await readVault(ws)).toEqual({ 'env.dev': { A: 'cofre', B: 'antigo' }, 'env.hml': { C: SECRET } })
  })

  it('arquivo antigo quebrado fica onde está, com o erro', async () => {
    const ws = tmp('vvpost-cofre-quebrado-')
    put(ws, LEGACY_SECRETS_FILE, '{')
    await expect(readVault(ws)).rejects.toThrow(/secrets\.local\.json não é um JSON válido/)
    expect((await loadWorkspace(ws)).issues).toMatchObject([{ file: LEGACY_SECRETS_FILE }])
    expect(readFileSync(join(ws, LEGACY_SECRETS_FILE), 'utf8')).toBe('{')
  })

  it('com outra chave, o cofre não vira vazio: dá erro e não é sobrescrito', async () => {
    const ws = tmp('vvpost-cofre-chave-')
    await updateVault(ws, (s) => (s['env.dev'] = { TOKEN: SECRET }))
    const file = await vaultFile(ws)
    const before = readFileSync(file, 'utf8')
    const original = process.env['VVPOST_VAULT_KEY']
    process.env['VVPOST_VAULT_KEY'] = Buffer.alloc(32, 7).toString('base64')
    try {
      await expect(readVault(ws)).rejects.toThrow(/arquivo de chave da pasta do cofre, que não está disponível/)
      await expect(updateVault(ws, (s) => (s['env.dev'] = {}))).rejects.toThrow(/não está disponível/)
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect((await loadWorkspace(ws)).issues).toMatchObject([{ file: 'cofre local' }])
    } finally {
      if (original === undefined) delete process.env['VVPOST_VAULT_KEY']
      else process.env['VVPOST_VAULT_KEY'] = original
      clearVaultKeyCache()
    }
    expect(await readVault(ws)).toEqual({ 'env.dev': { TOKEN: SECRET } })
  })

  it('arquivo adulterado não abre', async () => {
    const ws = tmp('vvpost-cofre-adulterado-')
    await updateVault(ws, (s) => (s['env.dev'] = { TOKEN: SECRET }))
    const file = await vaultFile(ws)
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const data = Buffer.from(doc.data, 'base64')
    data[0] = data[0]! ^ 1
    writeFileSync(file, JSON.stringify({ ...doc, data: data.toString('base64') }))
    await expect(readVault(ws)).rejects.toThrow(/alterado ou está corrompido/)
  })

  it('gravações seguidas no mesmo processo não se perdem', async () => {
    const ws = tmp('vvpost-cofre-fila-')
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateVault(ws, (s) => ((s['env.dev'] ??= {})[`V${i}`] = String(i)))))
    expect(Object.keys((await readVault(ws))['env.dev']!)).toHaveLength(20)
  })
})
