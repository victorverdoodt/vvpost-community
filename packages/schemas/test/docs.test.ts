import { test } from 'node:test'
import { SchemaId, schemaUrl, validateDocsConfig } from '../src/index.ts'
import { assertIssue, assertValid } from './helpers.ts'
import assert from 'node:assert/strict'

const config = (): any => ({
  $schema: SchemaId.Docs,
  source: 'docs/projeto.md',
  title: 'API de Pagamentos',
  subtitle: 'Guia de integração',
  version: '2.1',
  organization: 'Equipe de Pagamentos',
  logo: 'docs/assets/logo.svg',
  cover: true,
  toc: true,
  numberHeadings: true,
  theme: { primary: '#0B5FFF', heading: '#11141A', text: '#1D2230', font: 'serif', headingFont: 'sans' },
  page: { size: 'Letter', orientation: 'portrait', margins: 'wide' },
  header: { left: '{{title}}', right: '{{version}}', logo: 'right' },
  footer: { left: '{{organization}}', right: '{{page}} / {{pages}}' }
})

test('SchemaId.Docs é a URL canônica do schema da documentação', () => {
  assert.equal(SchemaId.Docs, schemaUrl('docs'))
})

test('aceita o modelo completo e o arquivo vazio', () => {
  assertValid(validateDocsConfig(config()))
  assertValid(validateDocsConfig({}))
})

test('recusa caminhos fora do workspace no logo e na fonte', () => {
  for (const logo of ['/etc/logo.png', '../logo.png', 'docs/../../logo.png', 'C:/logo.png', '\\\\srv\\logo.png']) {
    assertIssue(validateDocsConfig({ logo }), '/logo')
  }
  assertIssue(validateDocsConfig({ logo: 'docs/logo.bmp' }), '/logo')
  assertIssue(validateDocsConfig({ source: '../fora.md' }), '/source')
  assertIssue(validateDocsConfig({ source: 'docs/projeto.txt' }), '/source')
})

test('cores só em #RRGGBB e opções fechadas', () => {
  assertIssue(validateDocsConfig({ theme: { primary: 'red' } }), '/theme/primary')
  assertIssue(validateDocsConfig({ theme: { primary: '#fff;background:url(x)' } }), '/theme/primary')
  assertIssue(validateDocsConfig({ page: { size: 'A3' } }), '/page/size')
  assertIssue(validateDocsConfig({ header: { logo: 'center' } }), '/header/logo')
  assertIssue(validateDocsConfig({ css: 'body{}' }), '', /campo desconhecido "css"/)
})
