import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { readVault } from '@vvpost/core/vault'
import { replaceSecret } from '../src/main/workspace'
import { SECRETS_FILE, secretInventory } from '../src/main/workspace/vault'

const dirs: string[] = []
const write = (dir: string, path: string, content: unknown) => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('secretInventory', () => {
  it('classifica os segredos de cada ambiente sem devolver valores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-inventory-'))
    dirs.push(dir)
    write(dir, 'environments/dev.env.json', {
      id: 'env.dev',
      name: 'Dev',
      variables: {
        BASE_URL: { type: 'string', value: 'http://localhost' },
        DATABASE_URL: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true, description: 'Banco' },
        CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
        STRIPE_KEY: { type: 'string', value: 'sk_live_x', isSecret: true },
        API_KEY: { type: 'string', value: 'ak_x' }
      }
    })
    write(dir, SECRETS_FILE, { 'env.dev': { DATABASE_URL: 'postgres://guardado' } })

    const inventory = await secretInventory(dir)
    // O arquivo antigo migrou para o cofre local, fora da pasta.
    expect(inventory.storeFile).toBe('cofre local (chave: arquivo de chave da pasta do cofre)')
    expect(existsSync(join(dir, SECRETS_FILE))).toBe(false)
    expect(inventory.environments).toEqual([
      {
        id: 'env.dev',
        name: 'Dev',
        file: 'environments/dev.env.json',
        secrets: [
          { variable: 'DATABASE_URL', state: 'configured', description: 'Banco' },
          { variable: 'CLIENT_SECRET', state: 'missing' },
          { variable: 'STRIPE_KEY', state: 'plaintext' },
          { variable: 'API_KEY', state: 'unmarked' }
        ],
        problem: expect.stringContaining('/variables/STRIPE_KEY/value'),
        // Só o valor de quem não é segredo nem tem nome de credencial sai do main.
        variables: [
          { name: 'BASE_URL', type: 'string', isSecret: false, value: 'http://localhost' },
          { name: 'DATABASE_URL', type: 'string', isSecret: true, description: 'Banco' },
          { name: 'CLIENT_SECRET', type: 'string', isSecret: true },
          { name: 'STRIPE_KEY', type: 'string', isSecret: true },
          { name: 'API_KEY', type: 'string', isSecret: false }
        ]
      }
    ])
    const text = JSON.stringify(inventory)
    for (const value of ['postgres://guardado', 'sk_live_x', 'ak_x']) expect(text).not.toContain(value)
  })
})

describe('replaceSecret', () => {
  it('troca o valor de um segredo configurado e recusa o que não é segredo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-replace-'))
    dirs.push(dir)
    write(dir, 'environments/dev.env.json', {
      id: 'env.dev',
      name: 'Dev',
      variables: {
        BASE_URL: { type: 'string', value: 'http://localhost' },
        API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    })
    write(dir, SECRETS_FILE, { 'env.dev': { API_TOKEN: 'antigo' } })
    await replaceSecret(dir, { environmentId: 'env.dev', variable: 'API_TOKEN', value: 'novo' })
    expect(await readVault(dir)).toEqual({ 'env.dev': { API_TOKEN: 'novo' } })
    expect(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8')).not.toContain('novo')
    await expect(replaceSecret(dir, { environmentId: 'env.dev', variable: 'BASE_URL', value: 'x' })).rejects.toThrow(/não é um segredo/)
    await expect(replaceSecret(dir, { environmentId: 'env.dev', variable: 'API_TOKEN', value: '' })).rejects.toThrow(/vazio/)
    await expect(replaceSecret(dir, { environmentId: 'env.nada', variable: 'API_TOKEN', value: 'x' })).rejects.toThrow(/não existe/)
  })
})
