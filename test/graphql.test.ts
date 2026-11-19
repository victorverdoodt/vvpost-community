import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fromGraphqlBody,
  graphqlBody,
  graphqlCompletionsAt,
  operationNames,
  parseIntrospection,
  userTypes
} from '../src/renderer/src/modules/quick-request/graphql'

const schema = parseIntrospection(JSON.parse(readFileSync(join(__dirname, 'fixtures/graphql/introspection.json'), 'utf8')))
const labels = (before: string) => graphqlCompletionsAt(before, schema).items.map((i) => i.label)

describe('schema da introspecção', () => {
  it('lê raízes, tipos, campos com argumentos e o tipo no formato do SDL', () => {
    expect([schema.query, schema.mutation, schema.subscription]).toEqual(['Query', 'Mutation', undefined])
    const users = schema.types.get('Query')!.fields.find((f) => f.name === 'users')!
    expect(users).toMatchObject({ type: '[User!]!', named: 'User', args: [{ name: 'first', type: 'Int', defaultValue: '10' }] })
    expect(schema.types.get('Query')!.fields.find((f) => f.name === 'legacy')!.deprecated).toBe('use users')
    expect(schema.types.get('NewUser')!.fields.map((f) => `${f.name}: ${f.type}`)).toEqual(['name: String!', 'role: Role'])
    expect(schema.types.get('Role')!.values).toEqual(['ADMIN', 'MEMBER'])
    expect(userTypes(schema).map((t) => t.name)).toEqual(['Mutation', 'NewUser', 'Node', 'Post', 'Query', 'Role', 'User'])
  })

  it('resposta sem __schema diz por quê', () => {
    expect(() => parseIntrospection({ errors: [{ message: 'introspection disabled' }] })).toThrow('o servidor recusou a introspecção: introspection disabled')
    expect(() => parseIntrospection({ data: {} })).toThrow('data.__schema')
  })
})

describe('autocomplete pelo cursor', () => {
  it('palavras-chave no topo; campos da raiz e dos tipos aninhados', () => {
    expect(labels('')).toEqual(['query', 'mutation', 'fragment'])
    expect(labels('{ ')).toEqual(['user', 'users', 'node', 'legacy', '__typename'])
    expect(labels('query Q($id: ID!) { user(id: $id) { ')).toEqual(['id', 'name', 'role', 'posts', '__typename'])
    expect(labels('{ users { posts(last: 2) { ti')).toEqual(['id', 'title', '__typename'])
    expect(graphqlCompletionsAt('{ users { posts(last: 2) { ti', schema).typed).toBe('ti')
    expect(labels('mutation { createUser(input: {name: "a"}) { ')).toContain('posts')
    // Saindo de uma seleção, volta ao tipo de fora.
    expect(labels('{ user(id: 1) { posts { id } ')).toEqual(['id', 'name', 'role', 'posts', '__typename'])
  })

  it('argumentos dentro de ( ), alias, fragmentos, comentários e strings', () => {
    expect(labels('{ users(')).toEqual(['first'])
    expect(labels('{ users(first: ')).toEqual([])
    expect(labels('{ eu: user(id: 1) { ')).toContain('posts')
    expect(labels('fragment F on ')).toContain('User')
    expect(labels('fragment F on Post { ')).toEqual(['id', 'title', '__typename'])
    expect(labels('{ node(id: 1) { ... on User { ')).toContain('role')
    expect(labels('{ node(id: 1) { ')).toEqual(['id', '__typename'])
    expect(labels('# { user {\n{ user(id: "{ x") { ')).toContain('posts')
    expect(labels('{ naoExiste { ')).toEqual([])
    const user = graphqlCompletionsAt('{ ', schema).items.find((i) => i.label === 'user')!
    expect(user).toMatchObject({ detail: '(id: ID!): User', selection: true, documentation: 'Um usuário pelo id.' })
  })
})

describe('corpo da requisição', () => {
  it('monta { query, variables, operationName } e lê de volta', () => {
    const body = graphqlBody('query A { users { id } }', '{ "first": 2 }', 'A')
    expect(JSON.parse(body)).toEqual({ query: 'query A { users { id } }', variables: { first: 2 }, operationName: 'A' })
    expect(JSON.parse(graphqlBody('{ a }', ''))).toEqual({ query: '{ a }' })
    expect(fromGraphqlBody(body)).toEqual({ query: 'query A { users { id } }', variables: '{\n  "first": 2\n}', operationName: 'A' })
    expect(fromGraphqlBody('{"x":1}')).toBeUndefined()
    expect(operationNames('query A { a } # query B\nmutation C { c }')).toEqual(['A', 'C'])
  })
})
