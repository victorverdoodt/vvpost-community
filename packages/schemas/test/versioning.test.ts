import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  SchemaId,
  checkSchemaVersion,
  schemaUrl,
  validateConnector,
  validateEnvironment
} from '../src/index.ts'
import { assertIssue, assertValid, fixture } from './helpers.ts'

test('SchemaId é a URL canônica da versão atual de cada schema', () => {
  assert.equal(SchemaId.Connector, schemaUrl('connector'))
  assert.equal(SchemaId.Environment, schemaUrl('environment'))
  assert.equal(SchemaId.SecretsEngine, schemaUrl('secrets-engine'))
  assert.equal(SchemaId.Flow, schemaUrl('flow'))
  assert.equal(SchemaId.Plugin, schemaUrl('plugin'))
})

test('toda versão acima da v1 tem a migração que leva até ela', () => {
  for (const [kind, version] of Object.entries(CURRENT_SCHEMA_VERSION)) {
    assert.equal(MIGRATIONS[kind as keyof typeof MIGRATIONS].length, version - 1, kind)
  }
})

test('sem $schema o arquivo é lido na versão atual', () => {
  const c = fixture('billing.connector.vvpost.json')
  delete c.$schema
  assertValid(validateConnector(c))
})

test('aceita cópia local do schema no $schema, para o editor', () => {
  const env = fixture('dev.env.json')
  env.$schema = './node_modules/@vvpost/schemas/schemas/environment.json'
  assertValid(validateEnvironment(env))
})

test('recusa schema mais novo que o do app com mensagem de atualizar', () => {
  const c = fixture('billing.connector.vvpost.json')
  c.$schema = 'https://vvpost.dev/schemas/v2/connector.json'
  c.campoDaV2 = true
  const result = validateConnector(c)
  assertIssue(result, '/$schema', /mais novo.*atualize o app/)
  // O erro de versão vem sozinho: não adianta listar os campos que a v1 não conhece.
  assert.ok(!result.ok && result.issues.length === 1)
})

test('recusa arquivo de outro tipo', () => {
  const env = fixture('dev.env.json')
  assertIssue(validateConnector(env), '/$schema', /tipo "environment"/)
})

test('recusa $schema desconhecido', () => {
  const c = fixture('billing.connector.vvpost.json')
  c.$schema = 'https://example.com/outro.json'
  assertIssue(validateConnector(c), '/$schema', /desconhecido/)
})

test('migra versões antigas em ordem, sem mudar o original', () => {
  const v1 = { $schema: schemaUrl('environment', 1), id: 'env.a', name: 'A', vars: {} }
  const migrations = [
    (d: Record<string, unknown>) => {
      const { vars, ...rest } = d
      return { ...rest, variables: vars }
    },
    (d: Record<string, unknown>) => ({ ...d, description: 'v3' })
  ]
  const result = checkSchemaVersion(v1, 'environment', { current: 3, migrations })
  assert.ok(result.ok)
  assert.equal(result.version, 1)
  assert.equal(result.migrated, true)
  assert.deepEqual(result.doc, {
    $schema: schemaUrl('environment', 3),
    id: 'env.a',
    name: 'A',
    variables: {},
    description: 'v3'
  })
  assert.ok('vars' in v1)
})

test('falta de migração é erro, não leitura parcial', () => {
  const result = checkSchemaVersion({ $schema: schemaUrl('flow', 1) }, 'flow', { current: 2, migrations: [] })
  assert.ok(!result.ok)
  assert.match(result.issues[0]!.message, /sem migração de flow v1 para v2/)
})
