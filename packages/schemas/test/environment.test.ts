import { test } from 'node:test'
import { REQUIRED_SECRET, validateEnvironment } from '../src/index.ts'
import { assertIssue, assertValid, fixture } from './helpers.ts'

const dev = (): any => fixture('dev.env.json')

test('aceita o exemplo da documentação', () => {
  assertValid(validateEnvironment(dev()))
})

test('isSecret é opcional e por padrão falso', () => {
  const e = dev()
  delete e.variables.BASE_URL.isSecret
  assertValid(validateEnvironment(e))
})

test('segredo commitado com valor real é rejeitado (redação Git)', () => {
  const e = dev()
  e.variables.CLIENT_SECRET.value = 'valor-real' // ggignore: valor fictício de teste
  assertIssue(validateEnvironment(e), '/variables/CLIENT_SECRET/value', /__REQUIRED_SECRET__/)
})

test('o template só vale para variáveis marcadas como segredo', () => {
  const e = dev()
  e.variables.BASE_URL.value = REQUIRED_SECRET
  assertIssue(validateEnvironment(e), '/variables/BASE_URL/value')
})

test('segredo precisa ser do tipo string', () => {
  const e = dev()
  e.variables.CLIENT_SECRET.type = 'number'
  assertIssue(validateEnvironment(e), '/variables/CLIENT_SECRET/type')
})

test('valor precisa bater com o type declarado', () => {
  const e = dev()
  e.variables.TIMEOUT_MS = { type: 'number', value: '3000' }
  e.variables.FEATURE_X = { type: 'boolean', value: 'true' }
  const r = validateEnvironment(e)
  assertIssue(r, '/variables/TIMEOUT_MS/value')
  assertIssue(r, '/variables/FEATURE_X/value')
})

test('aceita number e boolean com valores do tipo certo', () => {
  const e = dev()
  e.variables.TIMEOUT_MS = { type: 'number', value: 3000 }
  e.variables.FEATURE_X = { type: 'boolean', value: false }
  assertValid(validateEnvironment(e))
})

test('rejeita nome de variável que não é identificador', () => {
  const e = dev()
  e.variables['base-url'] = { type: 'string', value: 'x' }
  assertIssue(validateEnvironment(e), '/variables', /"base-url"/)
})

test('rejeita tipo de variável desconhecido', () => {
  const e = dev()
  e.variables.BASE_URL.type = 'url'
  assertIssue(validateEnvironment(e), '/variables/BASE_URL/type')
})

test('exige variables', () => {
  const e = dev()
  delete e.variables
  assertIssue(validateEnvironment(e), '', /"variables"/)
})
