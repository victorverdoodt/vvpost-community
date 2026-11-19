import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readVault, updateVault } from '@vvpost/core/vault'
import { setEnvironmentVariable } from '../src/main/workspace'

let dir: string
const env = () => JSON.parse(readFileSync(join(dir, 'environments/dev.env.json'), 'utf8'))

function workspace() {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-envvar-'))
  mkdirSync(join(dir, 'environments'))
  writeFileSync(
    join(dir, 'environments/dev.env.json'),
    JSON.stringify({
      id: 'env.dev',
      name: 'Dev',
      variables: {
        BASE: { type: 'string', value: 'x', description: 'base' },
        SEGREDO: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    })
  )
}

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('"Usar como variável" do menu de valores', () => {
  it('grava no arquivo do ambiente, com o tipo do valor e mantendo a descrição', async () => {
    workspace()
    expect(await setEnvironmentVariable(dir, { environmentId: 'env.dev', name: 'USER_ID', value: 42 })).toEqual({
      file: 'environments/dev.env.json',
      secret: false
    })
    await setEnvironmentVariable(dir, { environmentId: 'env.dev', name: 'BASE', value: 'y' })
    expect(env().variables.USER_ID).toEqual({ type: 'number', value: 42 })
    expect(env().variables.BASE).toEqual({ type: 'string', value: 'y', description: 'base' })
  })

  it('nomes sensíveis e variáveis secretas vão para o vault local, fora do Git', async () => {
    workspace()
    expect((await setEnvironmentVariable(dir, { environmentId: 'env.dev', name: 'ACCESS_TOKEN', value: 'abc' })).secret).toBe(true)
    await setEnvironmentVariable(dir, { environmentId: 'env.dev', name: 'SEGREDO', value: 's3' })
    expect(env().variables.ACCESS_TOKEN).toEqual({ type: 'string', value: '__REQUIRED_SECRET__', isSecret: true })
    expect(JSON.stringify(env())).not.toContain('abc')
    const store = (await readVault(dir))
    expect(store['env.dev']).toEqual({ ACCESS_TOKEN: 'abc', SEGREDO: 's3' })
  })

  it('recusa nome inválido e ambiente inexistente', async () => {
    workspace()
    await expect(setEnvironmentVariable(dir, { environmentId: 'env.dev', name: '1x', value: 'a' })).rejects.toThrow(/inválido/)
    await expect(setEnvironmentVariable(dir, { environmentId: 'env.prod', name: 'X', value: 'a' })).rejects.toThrow(/não encontrado/)
  })
})
