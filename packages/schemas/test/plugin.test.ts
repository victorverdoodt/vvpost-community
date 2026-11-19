import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateFlow, validatePluginManifest } from '../src/index.ts'
import { assertIssue, assertValid, fixture } from './helpers.ts'

const manifest = (): any => ({
  id: 'vvpost-plugin-graphql',
  name: 'GraphQL',
  version: '1.0.0',
  main: 'index.js',
  apiVersion: 1,
  contributes: {
    adapters: [
      {
        protocol: 'graphql',
        title: 'GraphQL',
        fields: [
          { key: 'query', label: 'Query', type: 'code', language: 'graphql', required: true },
          { key: 'mode', label: 'Modo', type: 'select', options: [{ value: 'post', label: 'POST' }], default: 'post' }
        ]
      }
    ],
    nodes: [{ type: 'graphql.introspect', title: 'Introspecção' }]
  }
})

test('aceita um manifesto com nó e adapter', () => {
  assertValid(validatePluginManifest(manifest()))
})

test('apiVersion desconhecida é recusada', () => {
  const m = manifest()
  m.apiVersion = 2
  assertIssue(validatePluginManifest(m), '/apiVersion', /deve ser 1/)
})

test('main precisa ficar dentro da pasta do plugin', () => {
  for (const main of ['../fora.js', '/abs/index.js', 'lib/../../x.js', 'C:\\plugins\\x.js']) {
    const m = manifest()
    m.main = main
    assertIssue(validatePluginManifest(m), '/main')
  }
  const m = manifest()
  m.main = 'index.ts'
  assertIssue(validatePluginManifest(m), '/main')
})

test('sem contribuições, ou com tipos e campos duplicados, é recusado', () => {
  const empty = manifest()
  empty.contributes = {}
  assertIssue(validatePluginManifest(empty), '/contributes', /nenhum nó, adapter, exportador, publicador, pacote de ícones nem bloco/)

  const dup = manifest()
  dup.contributes.adapters.push({ ...dup.contributes.adapters[0] })
  assertIssue(validatePluginManifest(dup), '/contributes/adapters/1/protocol', /duplicado/)

  const field = manifest()
  field.contributes.adapters[0].fields.push({ key: 'query', label: 'Outra', type: 'text' })
  assertIssue(validatePluginManifest(field), '/contributes/adapters/0/fields/2/key', /duplicado/)
})

test('plugin só de exportadores: id único, sem os do VVPost', () => {
  const exporters = manifest()
  exporters.contributes = { exporters: [{ id: 'docusaurus', title: 'Docusaurus' }] }
  assert.equal(validatePluginManifest(exporters).ok, true)
  const dup = structuredClone(exporters)
  dup.contributes.exporters.push({ id: 'docusaurus', title: 'De novo' })
  assertIssue(validatePluginManifest(dup), '/contributes/exporters/1/id', /duplicado/)
  for (const id of ['html', 'confluence-cloud', 'Com Espaço']) {
    const bad = structuredClone(exporters)
    bad.contributes.exporters[0].id = id
    assertIssue(validatePluginManifest(bad), '/contributes/exporters/0/id')
  }
})

test('plugin só de diagramas: pacotes de ícones e blocos, prefixo único, arquivo dentro da pasta', () => {
  const diagrams = manifest()
  diagrams.contributes = {
    diagrams: {
      iconPacks: [{ prefix: 'aws', title: 'AWS', file: 'icons/aws.json' }],
      blocks: [{ title: 'Lambda', category: 'AWS', code: 'service f(aws:lambda)[Lambda]', icon: 'aws:lambda' }]
    }
  }
  assert.equal(validatePluginManifest(diagrams).ok, true)
  const dup = structuredClone(diagrams)
  dup.contributes.diagrams.iconPacks.push({ prefix: 'aws', title: 'De novo', file: 'b.json' })
  assertIssue(validatePluginManifest(dup), '/contributes/diagrams/iconPacks/1/prefix', /duplicado/)
  const outside = structuredClone(diagrams)
  outside.contributes.diagrams.iconPacks[0].file = '../fora.json'
  assertIssue(validatePluginManifest(outside), '/contributes/diagrams/iconPacks/0/file')
  const reserved = structuredClone(diagrams)
  reserved.contributes.diagrams.iconPacks[0].prefix = 'vv'
  assertIssue(validatePluginManifest(reserved), '/contributes/diagrams/iconPacks/0/prefix')
})

test('tipo de nó precisa de namespace; adapter não pode ser http', () => {
  const node = manifest()
  node.contributes.nodes[0].type = 'introspect'
  assertIssue(validatePluginManifest(node), '/contributes/nodes/0/type')
  const http = manifest()
  http.contributes.adapters[0].protocol = 'http'
  assertIssue(validatePluginManifest(http), '/contributes/adapters/0/protocol')
})

test('select exige opções e um default entre elas', () => {
  const noOptions = manifest()
  delete noOptions.contributes.adapters[0].fields[1].options
  assertIssue(validatePluginManifest(noOptions), '/contributes/adapters/0/fields/1', /options/)
  const badDefault = manifest()
  badDefault.contributes.adapters[0].fields[1].default = 'get'
  assertIssue(validatePluginManifest(badDefault), '/contributes/adapters/0/fields/1/default')
})

test('nó de plugin no fluxo: node ou adapter, connector só com adapter', () => {
  const f = fixture('checkout.flow.vvpost.json')
  f.nodes.push(
    { id: 'js', name: 'Js', type: 'plugin', plugin: { node: 'javascript.script', config: { code: 'return 1' } } },
    { id: 'gql', name: 'Gql', type: 'plugin', plugin: { adapter: 'graphql', connector: 'connector.x', config: { query: '{ me { id } }' } } }
  )
  assertValid(validateFlow(f))

  const neither = fixture('checkout.flow.vvpost.json')
  neither.nodes.push({ id: 'p', name: 'P', type: 'plugin', plugin: { config: {} } })
  assertIssue(validateFlow(neither), '/nodes/6/plugin', /adapter/)

  const both = fixture('checkout.flow.vvpost.json')
  both.nodes.push({ id: 'p', name: 'P', type: 'plugin', plugin: { node: 'javascript.script', connector: 'c' } })
  assertIssue(validateFlow(both), '/nodes/6/plugin')
})
