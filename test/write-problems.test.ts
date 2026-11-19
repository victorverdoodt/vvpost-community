import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { writeProblems } from '@vvpost/core/docs/write-check'
import { loadFlows } from '@vvpost/core/flows'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-write-problems-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const problems = async (dir: string) => writeProblems(await loadWorkspace(dir), await loadFlows(dir))

describe('problemas que uma gravação deixa para trás', () => {
  it('diretiva quebrada no documento do projeto, corpo padrão e exemplo fora do schema, um por linha', async () => {
    const connector = {
      id: 'billing',
      name: 'Billing',
      version: '1.0.0',
      config: { baseUrl: 'https://billing.example' },
      endpoints: [
        { id: 'list', name: 'Listar', method: 'GET', path: '/charges', examples: [{ id: 'ok', name: 'Lista', status: 200, body: [], schema: { type: 'object' } }] },
        { id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges', bodySchema: { type: 'object', properties: { amount: { type: 'number' } } }, body: { amount: 'dez' } }
      ]
    }
    const dir = workspace({
      'connectors/billing.connector.vvpost.json': connector,
      'vvpost.docs.json': { source: 'docs/projeto.md' },
      'docs/projeto.md': '# Projeto\n\n{{> endpoint billing/list}}\n\n{{> endpoint billing/sumiu}}\n'
    })
    const found = await problems(dir)
    expect(found).toHaveLength(3)
    expect(found[0]).toMatch(/^endpoint billing\/list: exemplo de resposta "Lista" \(200\) fora do schema dele \(\/: /)
    expect(found[1]).toMatch(/^endpoint billing\/charge: corpo padrão fora do bodySchema \(\/amount: /)
    expect(found[2]).toMatch(/^docs\/projeto\.md: .*sumiu/)
  })

  it('sem documento e com corpos válidos, nada', async () => {
    const dir = workspace({
      'connectors/a.connector.vvpost.json': { id: 'a', name: 'A', version: '1.0.0', config: { baseUrl: 'https://a.example' }, endpoints: [] }
    })
    expect(await problems(dir)).toEqual([])
  })
})
