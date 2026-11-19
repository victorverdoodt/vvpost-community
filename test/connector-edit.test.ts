import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Connector } from '@vvpost/schemas'
import { literalSecrets, readConnectorSource, saveConnector } from '@vvpost/core/connectors/edit'

const dirs: string[] = []
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), 'vvpost-edit-'))
  dirs.push(d)
  mkdirSync(join(d, 'connectors'))
  return d
}
const write = (dir: string, path: string, data: unknown) => writeFileSync(join(dir, path), `${JSON.stringify(data, null, 2)}\n`)

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const base: Connector = {
  id: 'corp.base',
  name: 'Base',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } }
}
const billing: Connector = {
  id: 'billing',
  name: 'Billing',
  version: '1.0.0',
  extends: 'corp.base',
  endpoints: [
    {
      id: 'charge',
      name: 'Cobrar',
      method: 'POST',
      path: '/charges',
      body: { amount: 10, meta: {} },
      scenarios: [{ id: 'ok', name: 'Sucesso', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
    }
  ]
}

describe('edição de conectores', () => {
  it('cria um conector novo em connectors/<id> e relê como está no arquivo', async () => {
    const dir = workspace()
    expect(await saveConnector(dir, base)).toEqual({ file: 'connectors/corp.base.connector.vvpost.json' })
    const text = readFileSync(join(dir, 'connectors/corp.base.connector.vvpost.json'), 'utf8')
    expect(Object.keys(JSON.parse(text))[0]).toBe('$schema')
    await expect(saveConnector(dir, base)).rejects.toThrow(/já existe|já é do conector/)
    const source = await readConnectorSource(dir, 'corp.base')
    expect(source.connector).toMatchObject(base)
  })

  it('regrava o arquivo existente preservando cenários e corpos', async () => {
    const dir = workspace()
    write(dir, 'connectors/base.connector.vvpost.json', base)
    write(dir, 'connectors/sub/billing.connector.vvpost.json', (mkdirSync(join(dir, 'connectors/sub')), billing))
    const { file, connector } = await readConnectorSource(dir, 'billing')
    expect(file).toBe('connectors/sub/billing.connector.vvpost.json')
    const edited = { ...connector, name: 'Cobrança', endpoints: [{ ...connector.endpoints![0]!, path: '/v2/charges' }] }
    await saveConnector(dir, edited, file)
    const saved = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    expect(saved.name).toBe('Cobrança')
    expect(saved.endpoints[0]).toMatchObject({ path: '/v2/charges', body: { amount: 10, meta: {} } })
    expect(saved.endpoints[0].scenarios).toHaveLength(1)
  })

  it('recusa id repetido, schema inválido e trocar o id de um conector com filhos', async () => {
    const dir = workspace()
    write(dir, 'connectors/base.connector.vvpost.json', base)
    write(dir, 'connectors/billing.connector.vvpost.json', billing)
    await expect(saveConnector(dir, { ...billing, extends: undefined, id: 'corp.base' }, 'connectors/billing.connector.vvpost.json')).rejects.toThrow(
      /já é do conector em connectors\/base/
    )
    await expect(saveConnector(dir, { ...base, version: 'um' }, 'connectors/base.connector.vvpost.json')).rejects.toThrow(/inválido/)
    await expect(saveConnector(dir, { ...base, id: 'corp.root' }, 'connectors/base.connector.vvpost.json')).rejects.toThrow(
      /billing herda/
    )
    await expect(saveConnector(dir, base, '../fora.connector.vvpost.json')).rejects.toThrow(/caminho/)
    // Sem filhos, trocar o id pode.
    await saveConnector(dir, { ...billing, id: 'billing.v2' }, 'connectors/billing.connector.vvpost.json')
    expect((await readConnectorSource(dir, 'billing.v2')).file).toBe('connectors/billing.connector.vvpost.json')
  })

  it('recusa credencial literal e aceita {{VAR}}', async () => {
    const dir = workspace()
    const leaky: Connector = {
      ...billing,
      extends: undefined,
      config: { auth: { type: 'basic', username: 'app', password: 'hunter2' }, headers: { 'X-Api-Key': 'abc', Accept: 'json' } }
    }
    expect(literalSecrets(leaky)).toEqual(['auth.password', 'headers.X-Api-Key'])
    await expect(saveConnector(dir, leaky)).rejects.toThrow(/auth\.password, headers\.X-Api-Key/)
    const scenarioLeak: Connector = {
      ...billing,
      endpoints: [
        {
          ...billing.endpoints![0]!,
          scenarios: [
            {
              id: 'outro',
              name: 'Outro token',
              overrides: { headers: { Authorization: 'Bearer abc', Cookie: null } },
              assertions: [{ target: 'status', operator: 'equals', expected: 401 }]
            }
          ]
        }
      ]
    }
    expect(literalSecrets(scenarioLeak)).toEqual(['charge/outro.headers.Authorization'])
    expect(literalSecrets({ ...leaky, config: { auth: { type: 'basic', username: 'app', password: '{{PW}}' }, headers: { 'X-Api-Key': 'k-{{KEY}}' } } })).toEqual([])
  })
})
