import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SchemaId, schemaUrl, validatePublishConfig } from '../src/index.ts'
import { assertIssue, assertValid } from './helpers.ts'

const config = (): any => ({
  $schema: SchemaId.Publish,
  targets: [
    {
      id: 'confluence-time',
      name: 'Confluence do time',
      provider: 'confluence-cloud',
      destination: 'catalog:pagamentos-docs',
      diagrams: 'png',
      structure: [
        {
          page: 'Plataforma de Pagamentos',
          source: 'document',
          children: [
            { folder: 'Guias', children: [{ pages: 'docs/guias/*.md', title: '{{heading}}' }] },
            { folder: 'Arquitetura', key: 'arquitetura', children: [{ page: 'Visão C4', source: 'docs/arquitetura.md#contexto' }] },
            { folder: 'Referência', children: [{ each: 'connector', title: '{{name}}', split: 'endpoints' }] }
          ]
        }
      ],
      published: { document: { id: '98765', kind: 'page', version: 3, hash: 'abc' } }
    }
  ]
})

test('SchemaId.Publish é a URL canônica do schema de publicação', () => {
  assert.equal(SchemaId.Publish, schemaUrl('publish'))
})

test('aceita destinos com pastas, páginas, globs e conectores', () => {
  assertValid(validatePublishConfig(config()))
  assertValid(validatePublishConfig({ targets: [] }))
})

test('recusa nó sem tipo, glob fora do workspace e campo desconhecido', () => {
  const c = config()
  c.targets[0].structure.push({ title: 'sem tipo' })
  assert.equal(validatePublishConfig(c).ok, false)
  const g = config()
  g.targets[0].structure = [{ pages: '../fora/*.md' }]
  assert.equal(validatePublishConfig(g).ok, false)
  const x = config()
  x.targets[0].token = 'abc'
  assertIssue(validatePublishConfig(x), '/targets/0', /token/)
})

test('recusa destino repetido, chave repetida e estrutura com mais de 8 níveis', () => {
  const c = config()
  c.targets.push({ ...c.targets[0] })
  assertIssue(validatePublishConfig(c), '/targets/1/id', /repetido/)
  const k = config()
  k.targets[0].structure.push({ folder: 'Outra', key: 'arquitetura' })
  assertIssue(validatePublishConfig(k), '/targets/0/structure/1/key', /repetida/)
  let deep: any = { folder: 'n9' }
  for (let i = 8; i >= 1; i--) deep = { folder: `n${i}`, children: [deep] }
  const d = config()
  d.targets[0].structure = [deep]
  const r = validatePublishConfig(d)
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.issues.some((i) => /8 níveis/.test(i.message)))
})

test('recusa versão mais nova do schema', () => {
  const c = config()
  c.$schema = schemaUrl('publish', 2)
  assert.equal(validatePublishConfig(c).ok, false)
})

test('site: opções dos exportadores (título, Mudanças, Backstage e baseUrl só https)', () => {
  const c = config()
  c.targets[0].provider = 'html'
  c.targets[0].destination = 'dist/site'
  c.targets[0].site = { title: 'Portal', changelog: false, backstage: true, baseUrl: 'https://docs.example.com/api' }
  assertValid(validatePublishConfig(c))
  c.targets[0].site.baseUrl = 'http://docs.example.com'
  assertIssue(validatePublishConfig(c), '/targets/0/site/baseUrl')
  c.targets[0].site = { tema: 'escuro' }
  assertIssue(validatePublishConfig(c), '/targets/0/site')
})
