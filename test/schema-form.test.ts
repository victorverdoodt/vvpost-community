import { describe, expect, it } from 'vitest'
import {
  enumValues,
  extraKeys,
  fieldKind,
  hasFormFields,
  initialValue,
  isNullable,
  parseFormBody,
  parseNumberInput,
  pickVariant,
  resolveSchema,
  setIn,
  typeLabel,
  variantsOf,
  type Schema
} from '../src/renderer/src/design-system/editors/schema-form'

// Como o import do OpenAPI grava: componentes em $defs, nullable vira type com "null".
const schema: Schema = {
  type: 'object',
  required: ['amount', 'method'],
  properties: {
    amount: { type: 'integer', minimum: 1, description: 'Em centavos' },
    method: { $ref: '#/$defs/Method' },
    customer: { $ref: '#/$defs/Customer' },
    tags: { type: 'array', items: { type: 'string' } },
    note: { type: ['string', 'null'] },
    payer: { oneOf: [{ $ref: '#/$defs/Person' }, { $ref: '#/$defs/Company' }] }
  },
  $defs: {
    Method: { type: 'string', enum: ['pix', 'boleto', 'card'], default: 'pix' },
    Customer: {
      allOf: [
        { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        { properties: { email: { type: 'string', format: 'email' } } }
      ]
    },
    Person: { type: 'object', required: ['cpf'], properties: { cpf: { type: 'string' } } },
    Company: { type: 'object', required: ['cnpj'], properties: { cnpj: { type: 'string' }, name: { type: 'string' } } }
  }
}
const prop = (name: string) => resolveSchema(schema, (schema['properties'] as Schema)[name])

describe('formulário do bodySchema', () => {
  it('segue $ref e junta allOf', () => {
    expect(fieldKind(prop('method'))).toBe('enum')
    expect(enumValues(prop('method'))).toEqual(['pix', 'boleto', 'card'])
    const customer = prop('customer')
    expect(fieldKind(customer)).toBe('object')
    expect(Object.keys(customer['properties'] as Schema)).toEqual(['name', 'email'])
    expect(customer['required']).toEqual(['name'])
  })

  it('não gira em $ref circular', () => {
    const loop: Schema = { $ref: '#/$defs/A', $defs: { A: { $ref: '#/$defs/A' } } }
    expect(fieldKind(resolveSchema(loop, loop))).toBe('any')
  })

  it('rótulos de tipo com formato, faixa e lista', () => {
    expect(typeLabel(schema, prop('amount'))).toBe('integer ≥ 1')
    expect(typeLabel(schema, prop('tags'))).toBe('string[]')
    expect(typeLabel(schema, resolveSchema(schema, (prop('customer')['properties'] as Schema)['email']))).toBe('string · email')
    expect(isNullable(prop('note'))).toBe(true)
    expect(fieldKind(prop('note'))).toBe('string')
  })

  it('valor inicial: default, enum e os obrigatórios do objeto', () => {
    expect(initialValue(schema, schema)).toEqual({ amount: 0, method: 'pix' })
    expect(initialValue(schema, (schema['properties'] as Schema)['customer'])).toEqual({ name: '' })
  })

  it('oneOf: escolhe o ramo pelo valor', () => {
    const variants = variantsOf(schema, prop('payer'))!
    expect(variants).toHaveLength(2)
    expect(pickVariant(variants, { cnpj: '1' })).toBe(1)
    expect(pickVariant(variants, { cpf: '1' })).toBe(0)
    expect(pickVariant(variants, undefined)).toBe(0)
  })

  it('setIn muda só o caminho e preserva o que o schema não descreve', () => {
    const body = { amount: 10, extra: { keep: true }, tags: ['a', 'b'] }
    expect(setIn(body, ['customer', 'name'], 'Ana')).toEqual({ ...body, customer: { name: 'Ana' } })
    expect(setIn(body, ['tags', 0], undefined)).toEqual({ ...body, tags: ['b'] })
    expect(setIn(body, ['amount'], undefined)).toEqual({ extra: { keep: true }, tags: ['a', 'b'] })
    expect(body.amount).toBe(10)
    expect(extraKeys(schema, body)).toEqual(['extra'])
  })

  it('número digitado: número, {{VAR}} e texto em edição', () => {
    expect(parseNumberInput('42', true)).toBe(42)
    expect(parseNumberInput('1,5', false)).toBe(1.5)
    expect(parseNumberInput('1.5', true)).toBe('1.5')
    expect(parseNumberInput('{{AMOUNT}}', true)).toBe('{{AMOUNT}}')
    expect(parseNumberInput('  ', true)).toBeUndefined()
  })

  it('corpo do texto: vazio, JSON e inválido', () => {
    expect(parseFormBody('')).toEqual({ ok: true, value: undefined })
    expect(parseFormBody('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseFormBody('{ "a": {{X}} }').ok).toBe(false)
  })

  it('só oferece formulário quando o schema tem campos', () => {
    expect(hasFormFields(schema)).toBe(true)
    expect(hasFormFields({})).toBe(false)
    expect(hasFormFields({ type: 'object' })).toBe(false)
    expect(hasFormFields({ type: 'array', items: { $ref: '#/$defs/P' }, $defs: { P: { type: 'object', properties: { a: {} } } } })).toBe(true)
  })
})
