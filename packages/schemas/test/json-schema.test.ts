import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchema } from '../src/index.ts'

const charge = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://exemplo.com/charge.json',
  type: 'object',
  required: ['id', 'status'],
  properties: { id: { type: 'string' }, status: { enum: ['PENDING', 'PAID'] } },
  'x-ferramenta': 'palavra-chave de outra ferramenta'
}

test('valida dados contra um schema do usuário, ignorando $schema, $id e palavras-chave desconhecidas', () => {
  assert.deepEqual(validateJsonSchema(charge, { id: 'c1', status: 'PAID' }), { ok: true, value: { id: 'c1', status: 'PAID' } })
  const result = validateJsonSchema(charge, { id: 1 })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.deepEqual(result.issues.map((i) => i.path).sort(), ['', '/id'])
  }
})

test('schemas diferentes com o mesmo $id convivem', () => {
  assert.equal(validateJsonSchema({ ...charge, required: ['id'] }, { id: 'c1' }).ok, true)
  assert.equal(validateJsonSchema(charge, { id: 'c1' }).ok, false)
})

test('schema inválido vira problema na raiz, sem exceção', () => {
  const result = validateJsonSchema({ type: 'objeto' }, {})
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.issues[0]!.message, /^schema inválido/)
})

test('as mensagens saem em português, também nas regras sem tradução própria', () => {
  const schema = {
    type: 'object',
    properties: {
      amount: { type: 'number', minimum: 1 },
      code: { type: 'string', minLength: 3, pattern: '^[A-Z]+$' },
      tags: { type: 'array', maxItems: 1, uniqueItems: true },
      kind: { oneOf: [{ const: 'a' }, { const: 'b' }] },
      id: { type: ['string', 'integer'] },
      odd: { multipleOf: 2 }
    }
  }
  const result = validateJsonSchema(schema, { amount: 0, code: 'ab', tags: ['x', 'x'], kind: 'c', id: true, odd: 3 })
  assert.equal(result.ok, false)
  if (result.ok) return
  const byPath = (path: string) => result.issues.filter((i) => i.path === path).map((i) => i.message)
  assert.deepEqual(byPath('/amount'), ['deve ser >= 1'])
  assert.deepEqual(byPath('/code').sort(), ['deve seguir o padrão ^[A-Z]+$', 'deve ter ao menos 3 caracteres'])
  assert.deepEqual(byPath('/tags').sort(), ['deve ter no máximo 1 item', 'não pode ter itens repetidos (os itens 0 e 1 são iguais)'])
  assert.ok(byPath('/kind').includes('não combina com nenhuma das opções'))
  assert.deepEqual(byPath('/id'), ['deve ser texto ou número inteiro'])
  assert.deepEqual(byPath('/odd'), ['deve ser múltiplo de 2'])
  assert.ok(result.issues.every((i) => !/\bmust\b/.test(i.message)), JSON.stringify(result.issues))
})
