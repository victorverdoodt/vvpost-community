import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Connector } from '@vvpost/schemas'
import { inferBodySchema, parseFieldPath, setBodyField } from '@vvpost/core/connectors/body-schema'
import { schemaFields } from '@vvpost/core/connectors/registry'
import { main, type Io } from '../src/main/cli'
import { applyProjectOps } from '../src/main/project'

describe('bodySchema sem JSON Schema à mão', () => {
  it('caminhos de campo', () => {
    expect(parseFieldPath('cliente.nome')).toEqual(['cliente', 'nome'])
    expect(parseFieldPath('itens[].sku')).toEqual(['itens', '[]', 'sku'])
    expect(() => parseFieldPath('a..b')).toThrow(/inválido/)
    expect(() => parseFieldPath('[]')).toThrow(/inválido/)
  })

  it('monta objetos e listas pelo caminho, com obrigatórios, enum e formato', () => {
    let s = setBodyField(undefined, 'valor', { type: 'integer', required: true, description: 'Em centavos', minimum: 1 })
    s = setBodyField(s, 'metodo', { type: 'string', required: true, enum: ['pix', 'boleto'] })
    s = setBodyField(s, 'cliente.nome', { type: 'string', required: true })
    s = setBodyField(s, 'cliente.nascimento', { type: 'string', format: 'date' })
    s = setBodyField(s, 'itens[].sku', { type: 'string', required: true })
    s = setBodyField(s, 'itens[].qtd', { type: 'integer', enum: ['1', 2] })
    expect(s).toEqual({
      type: 'object',
      properties: {
        valor: { type: 'integer', description: 'Em centavos', minimum: 1 },
        metodo: { type: 'string', enum: ['pix', 'boleto'] },
        cliente: { type: 'object', properties: { nome: { type: 'string' }, nascimento: { type: 'string', format: 'date' } }, required: ['nome'] },
        itens: {
          type: 'array',
          items: { type: 'object', properties: { sku: { type: 'string' }, qtd: { type: 'integer', enum: [1, 2] } }, required: ['sku'] }
        }
      },
      required: ['valor', 'metodo']
    })
    expect(schemaFields(s!).map((f) => `${f.path}${f.required ? '*' : ''}`)).toEqual([
      'valor*', 'metodo*', 'cliente', 'cliente.nome*', 'cliente.nascimento', 'itens', 'itens[].sku*', 'itens[].qtd'
    ])
  })

  it('trocar o tipo de um objeto mantém os campos dele; remover tira do required', () => {
    let s = setBodyField(undefined, 'cliente.nome', { type: 'string', required: true })
    s = setBodyField(s, 'cliente', { type: 'object', required: true, description: 'Quem paga' })
    expect(s!['properties']).toMatchObject({ cliente: { description: 'Quem paga', properties: { nome: { type: 'string' } }, required: ['nome'] } })
    s = setBodyField(s, 'cliente.nome', null)
    expect((s!['properties'] as Record<string, Record<string, unknown>>)['cliente']!['required']).toBeUndefined()
    expect(setBodyField(setBodyField(undefined, 'a', { type: 'string' }), 'a', null)).toBeUndefined()
  })

  it('erros claros: enum em booleano, filho de string, referência e campo inexistente', () => {
    expect(() => setBodyField(undefined, 'a', { type: 'boolean', enum: ['x'] })).toThrow(/enum só vale/)
    expect(() => setBodyField(undefined, 'a', { type: 'integer', enum: ['x'] })).toThrow(/não é integer/)
    const s = setBodyField(undefined, 'nome', { type: 'string' })
    expect(() => setBodyField(s, 'nome.x', { type: 'string' })).toThrow(/é string, não objeto/)
    const ref = { type: 'object', properties: { c: { $ref: '#/$defs/C' } }, $defs: { C: { type: 'object' } } }
    expect(() => setBodyField(ref, 'c.x', { type: 'string' })).toThrow(/referência/)
    expect(() => setBodyField(s, 'outro', null)).toThrow(/não existe/)
  })

  it('gera do corpo de exemplo, sem obrigatórios', () => {
    expect(
      inferBodySchema({ valor: 10, taxa: 1.5, ativo: true, quando: '2026-10-25T10:00:00Z', email: 'a@b.co', itens: [{ sku: 'x' }, { qtd: 2 }], tags: ['a'] })
    ).toEqual({
      type: 'object',
      properties: {
        valor: { type: 'integer' },
        taxa: { type: 'number' },
        ativo: { type: 'boolean' },
        quando: { type: 'string', format: 'date-time' },
        email: { type: 'string', format: 'email' },
        itens: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qtd: { type: 'integer' } } } },
        tags: { type: 'array', items: { type: 'string' } }
      }
    })
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const connector: Connector = {
  id: 'billing',
  name: 'Billing',
  version: '1.0.0',
  config: { baseUrl: 'https://api.exemplo.com' },
  endpoints: [{ id: 'cobrar', name: 'Cobrar', method: 'POST', path: '/charges', body: { valor: 100, metodo: 'pix' } }]
}
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-schema-'))
  dirs.push(dir)
  const file = join(dir, 'connectors/billing.connector.vvpost.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(connector, null, 2))
  return dir
}
const endpointOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'connectors/billing.connector.vvpost.json'), 'utf8')).endpoints[0]

describe('operações setBodySchema e setBodyField (app e MCP)', () => {
  it('gera do corpo e ajusta campo a campo, validando o conector', async () => {
    const dir = workspace()
    const at = { connectorId: 'billing', endpointId: 'cobrar' }
    const result = await applyProjectOps(dir, [
      { op: 'setBodySchema', ...at, fromBody: true },
      { op: 'setBodyField', ...at, path: 'valor', field: { type: 'integer', required: true, minimum: 1 } },
      { op: 'setBodyField', ...at, path: 'metodo', field: { type: 'string', required: true, enum: ['pix', 'boleto'] } }
    ], { actor: 'ai' })
    expect(result.errors).toEqual([])
    expect(endpointOf(dir).bodySchema).toEqual({
      type: 'object',
      properties: { valor: { type: 'integer', minimum: 1 }, metodo: { type: 'string', enum: ['pix', 'boleto'] } },
      required: ['valor', 'metodo']
    })
    const removed = await applyProjectOps(dir, [{ op: 'setBodySchema', ...at, schema: null }])
    expect(removed.ok).toBe(true)
    expect(endpointOf(dir).bodySchema).toBeUndefined()
  })

  it('erro do campo vira erro da operação e nada é gravado', async () => {
    const dir = workspace()
    const result = await applyProjectOps(dir, [
      { op: 'setBodyField', connectorId: 'billing', endpointId: 'cobrar', path: 'a', field: { type: 'string' } },
      { op: 'setBodyField', connectorId: 'billing', endpointId: 'cobrar', path: 'a.b', field: { type: 'string' } }
    ])
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatchObject({ op: 1, message: expect.stringMatching(/é string, não objeto/) })
    expect(endpointOf(dir).bodySchema).toBeUndefined()
  })
})

describe('vvpost schema', () => {
  const run = async (dir: string, args: string[]) => {
    let out = ''
    let err = ''
    const io: Io = { stdout: (t) => (out += t), stderr: (t) => (err += t), env: {}, cwd: dir, isTTY: false, appDir: dir }
    const code = await main(['schema', ...args, '--workspace', dir], io)
    return { code, out, err }
  }

  it('cria, lista, mostra em JSON e remove campos', async () => {
    const dir = workspace()
    expect((await run(dir, ['billing/cobrar'])).out).toMatch(/Sem schema do corpo/)
    expect((await run(dir, ['billing/cobrar', '--from-body'])).code).toBe(0)
    let r = await run(dir, ['billing/cobrar', '--set', 'metodo:string', '--required', '--enum', 'pix,boleto', '--description', 'Meio de pagamento'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/metodo \*\s+"pix" \| "boleto"\s+Meio de pagamento/)
    r = await run(dir, ['billing/cobrar', '--set', 'itens[].sku:string', '--required'])
    expect(r.out).toMatch(/itens\[\]\.sku \*/)
    r = await run(dir, ['billing/cobrar', '--remove', 'valor', '--json', '-'])
    expect(JSON.parse(r.out).properties).not.toHaveProperty('valor')
    expect(endpointOf(dir).bodySchema.required).toEqual(['metodo'])
    r = await run(dir, ['billing/cobrar', '--set', 'x:string', '--dry-run'])
    expect(r.out).toMatch(/^Mudaria/)
    expect(endpointOf(dir).bodySchema.properties).not.toHaveProperty('x')
  })

  it('erros de uso saem com 2', async () => {
    const dir = workspace()
    expect((await run(dir, [])).code).toBe(2)
    expect((await run(dir, ['billing/nao-existe'])).err).toMatch(/não tem o endpoint/)
    expect((await run(dir, ['billing/cobrar', '--set', 'a:texto'])).err).toMatch(/tipo "texto" inválido/)
    expect((await run(dir, ['billing/cobrar', '--required'])).err).toMatch(/só vale junto com --set/)
    expect((await run(dir, ['billing/cobrar', '--set', 'a:string', '--remove', 'b'])).err).toMatch(/não existe/)
  })
})
