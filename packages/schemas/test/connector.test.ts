import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConnector } from '../src/index.ts'
import { assertIssue, assertValid, fixture } from './helpers.ts'

const billing = (): any => fixture('billing.connector.vvpost.json')
const scenario = (c: any): any => c.endpoints[0].scenarios[0]

test('aceita o exemplo da documentação', () => {
  assertValid(validateConnector(billing()))
})

test('aceita o conector base com baseUrl e headers por variável', () => {
  assertValid(validateConnector(fixture('corporate-base.connector.vvpost.json')))
})

test('exige id, name e version', () => {
  const c = billing()
  delete c.version
  assertIssue(validateConnector(c), '', /"version"/)
})

test('rejeita version fora de semver', () => {
  const c = billing()
  c.version = '2.0'
  assertIssue(validateConnector(c), '/version')
})

test('rejeita id com maiúsculas ou espaços', () => {
  const c = billing()
  c.id = 'Billing Service'
  assertIssue(validateConnector(c), '/id')
})

test('rejeita campo desconhecido, para pegar erro de digitação', () => {
  const c = billing()
  c.endpoints[0].metod = 'GET'
  assertIssue(validateConnector(c), '/endpoints/0', /"metod"/)
})

test('rejeita método HTTP inválido', () => {
  const c = billing()
  c.endpoints[0].method = 'post'
  assertIssue(validateConnector(c), '/endpoints/0/method')
})

test('exige path e basePath começando com /', () => {
  const c = billing()
  c.endpoints[0].path = 'charges'
  c.config.basePath = 'billing'
  const r = validateConnector(c)
  assertIssue(r, '/endpoints/0/path')
  assertIssue(r, '/config/basePath')
})

test('rejeita baseUrl sem esquema http(s) nem variável', () => {
  const c = fixture('corporate-base.connector.vvpost.json')
  c.config.baseUrl = 'api.empresa.com'
  assertIssue(validateConnector(c), '/config/baseUrl')
})

test('rejeita header com valor não string', () => {
  const c = billing()
  c.config.headers['X-Retries'] = 3
  assertIssue(validateConnector(c), '/config/headers/X-Retries')
})

test('rejeita nome de header com espaço', () => {
  const c = billing()
  c.config.headers['X Service'] = 'a'
  assertIssue(validateConnector(c), '/config/headers', /"X Service"/)
})

test('rejeita conector que herda de si mesmo', () => {
  const c = billing()
  c.extends = c.id
  assertIssue(validateConnector(c), '/extends', /si mesmo/)
})

test('rejeita ids de endpoint duplicados', () => {
  const c = billing()
  c.endpoints.push({ ...c.endpoints[0], scenarios: [] })
  assertIssue(validateConnector(c), '/endpoints/1/id', /duplicado/)
})

test('rejeita ids de cenário duplicados no mesmo endpoint', () => {
  const c = billing()
  c.endpoints[0].scenarios.push(structuredClone(scenario(c)))
  assertIssue(validateConnector(c), '/endpoints/0/scenarios/1/id', /duplicado/)
})

test('permite o mesmo id de cenário em endpoints diferentes', () => {
  const c = billing()
  c.endpoints.push({ ...structuredClone(c.endpoints[0]), id: 'get_charge', method: 'GET' })
  assertValid(validateConnector(c))
})

test('cenário com headers: null, para testar 401 sem auth', () => {
  const c = billing()
  c.endpoints[0].scenarios.push({
    id: 'tc_no_auth',
    name: 'Erro - Sem Auth',
    overrides: { headers: null },
    assertions: [{ target: 'status', operator: 'equals', expected: 401 }]
  })
  assertValid(validateConnector(c))
})

test('cenário pode remover um header herdado com valor null', () => {
  const c = billing()
  scenario(c).overrides.headers = { Authorization: null, 'X-Extra': 'sim' }
  assertValid(validateConnector(c))
})

test('cenário precisa de ao menos uma asserção', () => {
  const c = billing()
  scenario(c).assertions = []
  assertIssue(validateConnector(c), '/endpoints/0/scenarios/0/assertions')
})

test('aceita os operadores de asserção do roadmap (fase 4)', () => {
  const c = billing()
  scenario(c).assertions = [
    { target: 'status', operator: 'equals', expected: 200 },
    { target: 'responseTimeMs', operator: 'lessThan', expected: 800 },
    { target: 'body.id', operator: 'exists' },
    { target: 'headers.content-type', operator: 'contains', expected: 'json' },
    { target: 'body.items[0].sku', operator: 'matches', expected: '^SKU-' },
    { target: 'body', operator: 'matchesSchema', expected: { type: 'object' } }
  ]
  assertValid(validateConnector(c))
})

test('rejeita operador desconhecido', () => {
  const c = billing()
  scenario(c).assertions[0].operator = 'eq'
  assertIssue(validateConnector(c), '/endpoints/0/scenarios/0/assertions/0/operator')
})

test('rejeita alvo de asserção desconhecido', () => {
  const c = billing()
  scenario(c).assertions[0].target = 'statusCode'
  assertIssue(validateConnector(c), '/endpoints/0/scenarios/0/assertions/0/target')
})

test('exige expected, exceto em exists e notExists', () => {
  const c = billing()
  delete scenario(c).assertions[0].expected
  assertIssue(validateConnector(c), '/endpoints/0/scenarios/0/assertions/0', /"expected"/)
})

test('rejeita expected em exists', () => {
  const c = billing()
  scenario(c).assertions[0] = { target: 'body.id', operator: 'exists', expected: true }
  assertIssue(validateConnector(c), '/endpoints/0/scenarios/0/assertions/0')
})

test('comparações numéricas exigem expected numérico', () => {
  const c = billing()
  scenario(c).assertions[1].expected = '800'
  assertIssue(validateConnector(c), '/endpoints/0/scenarios/0/assertions/1/expected')
})

test('matchesSchema exige um schema (objeto) em expected', () => {
  const c = billing()
  scenario(c).assertions[0] = { target: 'body', operator: 'matchesSchema', expected: 'object' }
  assertIssue(validateConnector(c), '/endpoints/0/scenarios/0/assertions/0/expected')
})

test('status não aceita operadores de texto', () => {
  const c = billing()
  scenario(c).assertions[0] = { target: 'status', operator: 'contains', expected: '20' }
  assertIssue(validateConnector(c), '/endpoints/0/scenarios/0/assertions/0/operator')
})

const identity = (): any => fixture('identity-base.connector.vvpost.json')
const withAuth = (auth: unknown): any => {
  const c = identity()
  c.config.auth = auth
  return c
}

test('aceita auth OAuth2 client credentials e certificado mTLS', () => {
  assertValid(validateConnector(identity()))
})

test('aceita os outros tipos de auth', () => {
  for (const auth of [
    { type: 'none' },
    { type: 'bearer', token: '{{ACCESS_TOKEN}}' },
    { type: 'bearer', token: '{{TOKEN}}', header: 'X-Auth-Token', prefix: '' },
    { type: 'apiKey', name: 'api_key', value: '{{API_KEY}}', in: 'query' },
    { type: 'basic', username: '{{USER}}', password: '{{PASSWORD}}' },
    {
      type: 'oauth2',
      grantType: 'password',
      tokenUrl: 'https://login.empresa.com/oauth/token',
      clientId: 'app',
      username: '{{USER}}',
      password: '{{PASSWORD}}',
      clientAuthentication: 'body'
    },
    {
      type: 'login',
      request: { url: '/auth/login', json: { user: '{{USER}}', password: '{{PASSWORD}}', otp: '{{$totp:MFA_SEED}}' } },
      token: 'body.data.accessToken',
      expiresIn: 'body.data.expiresIn',
      inject: { name: 'X-Session', value: '{{$token}}' }
    }
  ]) {
    assertValid(validateConnector(withAuth(auth)))
  }
})

test('rejeita tipo de auth desconhecido com um erro só, no campo type', () => {
  const r = validateConnector(withAuth({ type: 'kerberos', token: 'x' }))
  assertIssue(r, '/config/auth/type')
  assert.equal(r.ok ? 0 : r.issues.length, 1)
})

test('erros de auth apontam só para o tipo escolhido', () => {
  const r = validateConnector(withAuth({ type: 'bearer' }))
  assertIssue(r, '/config/auth', /"token"/)
  assert.equal(r.ok ? 0 : r.issues.length, 1)
})

test('OAuth2 password exige usuário e senha', () => {
  const r = validateConnector(
    withAuth({ type: 'oauth2', grantType: 'password', tokenUrl: '/token', clientId: 'app' })
  )
  assertIssue(r, '/config/auth', /"username"/)
  assertIssue(r, '/config/auth', /"password"/)
})

test('login exige caminho de token em body.* ou headers.*', () => {
  assertIssue(
    validateConnector(withAuth({ type: 'login', request: { url: '/login' }, token: 'accessToken' })),
    '/config/auth/token'
  )
})

test('login aceita um corpo só (json, form ou body)', () => {
  const auth = { type: 'login', request: { url: '/login', json: {}, form: {} }, token: 'body.token' }
  assertIssue(validateConnector(withAuth(auth)), '/config/auth/request')
})

test('mTLS exige cert e key juntos e não mistura com pfx', () => {
  const c = identity()
  delete c.config.tls.key
  assertIssue(validateConnector(c), '/config/tls', /key/)
  const d = identity()
  d.config.tls.pfx = 'certs/client.p12'
  assertIssue(validateConnector(d), '/config/tls')
})

test('rejeita header repetido com maiúsculas diferentes no mesmo objeto', () => {
  const c = billing()
  c.config.headers = { 'X-Service-Client': 'a', 'x-service-client': 'b' }
  assertIssue(validateConnector(c), '/config/headers/x-service-client', /repetido/)
  const d = billing()
  d.endpoints[0].headers = { Accept: 'a', ACCEPT: 'b' }
  assertIssue(validateConnector(d), '/endpoints/0/headers/ACCEPT', /repetido/)
})
