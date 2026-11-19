import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SchemaId, validateBundle } from '../src/index.ts'
import { assertIssue, assertValid } from './helpers.ts'

const bundle = {
  $schema: SchemaId.Bundle,
  name: 'Cobrança',
  exportedAt: '2026-10-24T21:00:00.000Z',
  generator: 'vvpost 0.1.0',
  connectors: [{ id: 'connector.billing', name: 'Billing', version: '1.0.0' }],
  environments: [],
  flows: [],
  docs: { 'connector.billing': '# Billing' }
}

test('pacote válido', () => {
  assertValid(validateBundle(bundle))
  assertValid(validateBundle({ $schema: SchemaId.Bundle, exportedAt: bundle.exportedAt }))
})

test('o $schema é obrigatório e precisa ser o do pacote', () => {
  const { $schema: _, ...rest } = bundle
  assertIssue(validateBundle(rest), '', /\$schema/)
  assert.equal(validateBundle({ ...bundle, $schema: SchemaId.Connector }).ok, false)
})

test('campos desconhecidos e docs que não são texto são recusados', () => {
  assertIssue(validateBundle({ ...bundle, extra: 1 }), '', /campo desconhecido "extra"/)
  assertIssue(validateBundle({ ...bundle, docs: { x: 1 } }), '/docs/x')
  assertIssue(validateBundle({ ...bundle, connectors: ['x'] }), '/connectors/0')
})

test('versão mais nova do pacote é recusada com mensagem clara', () => {
  const result = validateBundle({ ...bundle, $schema: 'https://vvpost.dev/schemas/v9/bundle.json' })
  assert.equal(result.ok, false)
})
