import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { satisfiesVersion } from '@vvpost/core/plugins/requirements'
import { main, type Io } from '../src/main/cli'

const repo = join(__dirname, '..')
let root: string
let workspace: string

const put = (path: string, data: unknown) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

/** Um fluxo com o nó do plugin oficial de JavaScript e, se pedido, um nó do protocolo GraphQL. */
const flow = (graphql = false) => ({
  id: 'flow.calc',
  name: 'Cálculo',
  nodes: [
    { id: 'js', name: 'Soma', type: 'plugin', plugin: { node: 'javascript.script', config: { code: 'return { total: 1 + 1 }' } } },
    ...(graphql ? [{ id: 'gql', name: 'Consulta', type: 'plugin', plugin: { adapter: 'graphql', config: { url: 'http://127.0.0.1:9/graphql', query: '{ ok }' } } }] : [])
  ],
  edges: graphql ? [{ from: 'js', to: 'gql' }] : []
})

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env: { VVPOST_USER_DATA: join(root, 'user-data') },
    cwd: root,
    isTTY: false,
    // Os plugins oficiais do repositório: javascript 1.1.0, graphql 1.0.0...
    appDir: repo
  }
  return { code: await main(['--workspace', workspace, ...args], io), stdout, stderr }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vvpost-ws-plugins-'))
  workspace = join(root, 'ws')
  put('flows/calc.flow.vvpost.json', flow())
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('versão pedida de um plugin', () => {
  it('exata, ^, ~, >= e *', () => {
    expect(satisfiesVersion('1.1.0', '1.1.0')).toBe(true)
    expect(satisfiesVersion('1.1.1', '1.1.0')).toBe(false)
    expect(satisfiesVersion('1.4.0', '^1.1.0')).toBe(true)
    expect(satisfiesVersion('2.0.0', '^1.1.0')).toBe(false)
    expect(satisfiesVersion('1.0.9', '^1.1.0')).toBe(false)
    expect(satisfiesVersion('0.3.1', '^0.3.0')).toBe(true)
    expect(satisfiesVersion('0.4.0', '^0.3.0')).toBe(false)
    expect(satisfiesVersion('1.1.9', '~1.1.0')).toBe(true)
    expect(satisfiesVersion('1.2.0', '~1.1.0')).toBe(false)
    expect(satisfiesVersion('3.0.0', '>=1.1.0')).toBe(true)
    expect(satisfiesVersion('1.0.0', '>=1.1.0')).toBe(false)
    expect(satisfiesVersion('9.9.9', '*')).toBe(true)
  })
})

describe('vvpost.plugins.json', () => {
  it('sem o arquivo, só o nó que nenhum plugin fornece é problema', async () => {
    expect((await cli(['validate'])).code).toBe(0)
    put('flows/calc.flow.vvpost.json', { ...flow(), nodes: [{ id: 'x', name: 'Fila', type: 'plugin', plugin: { node: 'fila.enviar' } }] })
    const r = await cli(['validate'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('plugins: flows/calc.flow.vvpost.json, nó Fila usa o nó fila.enviar, que nenhum plugin ligado fornece')
  })

  it('versão instalada fora da pedida para o run antes de qualquer requisição, com o motivo', async () => {
    put('vvpost.plugins.json', { plugins: { 'vvpost-plugin-javascript': '^2.0.0' } })
    const v = await cli(['validate'])
    expect(v.code).toBe(2)
    expect(v.stderr).toMatch(/plugins: vvpost\.plugins\.json pede o plugin vvpost-plugin-javascript \^2\.0\.0; o instalado é o 1\.1\.0 \(/)
    const r = await cli(['run'])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/^vvpost: plugins do workspace:\n {2}vvpost\.plugins\.json pede o plugin vvpost-plugin-javascript \^2\.0\.0; o instalado é o 1\.1\.0/)
    expect(r.stdout).toBe('')

    put('vvpost.plugins.json', { plugins: { 'vvpost-plugin-javascript': '^1.0.0', 'vvpost-plugin-nada': '1.0.0' } })
    expect((await cli(['validate'])).stderr).toContain('vvpost.plugins.json pede o plugin vvpost-plugin-nada 1.0.0, que não está instalado')

    put('vvpost.plugins.json', { plugins: { 'vvpost-plugin-javascript': '^1.0.0' } })
    expect((await cli(['validate'])).code).toBe(0)
    const ok = await cli(['run', '--json', '-'])
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.stdout).flows[0].report.results.map((n: { status: string }) => n.status)).toEqual(['success'])
  })

  it('nó de um plugin instalado mas fora do arquivo: o erro diz o que declarar', async () => {
    put('vvpost.plugins.json', { plugins: { 'vvpost-plugin-javascript': '^1.1.0' } })
    put('flows/calc.flow.vvpost.json', flow(true))
    const r = await cli(['validate'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(
      'flows/calc.flow.vvpost.json, nó Consulta usa o protocolo graphql, do plugin vvpost-plugin-graphql, que não está em vvpost.plugins.json; declare "vvpost-plugin-graphql": "^1.0.0"'
    )
    // Uma execução filtrada confere só os declarados: o resto do workspace não a bloqueia.
    put('flows/outro.flow.vvpost.json', { ...flow(), id: 'flow.outro', name: 'Outro' })
    const filtered = await cli(['run', '--flow', 'flow.outro', '--json', '-'])
    expect(filtered.code).toBe(0)
  })

  it('arquivo inválido e o arquivo da raiz num projeto', async () => {
    put('vvpost.plugins.json', { plugins: { 'vvpost-plugin-javascript': 'latest' } })
    expect((await cli(['validate'])).stderr).toMatch(/plugins: vvpost\.plugins\.json: \/plugins\/vvpost-plugin-javascript: /)

    // Num projeto, vale o arquivo da raiz do workspace, citado pelo caminho relativo.
    put('vvpost.plugins.json', { plugins: { 'vvpost-plugin-javascript': '2.0.0' } })
    put('vendas/vvpost.project.json', { id: 'vendas', name: 'Vendas' })
    put('vendas/flows/calc.flow.vvpost.json', flow())
    let stderr = ''
    const code = await main(['validate', '--workspace', join(workspace, 'vendas')], {
      stdout: () => {},
      stderr: (t) => (stderr += t),
      env: { VVPOST_USER_DATA: join(root, 'user-data') },
      cwd: root,
      isTTY: false,
      appDir: repo
    })
    expect(code).toBe(2)
    expect(stderr).toContain('../vvpost.plugins.json pede o plugin vvpost-plugin-javascript 2.0.0; o instalado é o 1.1.0')
  })
})
