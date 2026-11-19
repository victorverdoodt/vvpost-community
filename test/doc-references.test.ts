import { describe, expect, it } from 'vitest'
import { directiveAt, directiveTarget, sectionLine, targetLabel } from '../src/renderer/src/modules/docs/references'

const ctx = {
  connectors: [
    { id: 'http-client', name: 'HttpClient', endpoints: [] },
    { id: 'cotacao', name: 'Cotação', endpoints: [{ id: 'criar', name: 'Criar cotação', method: 'POST' }] },
    { id: 'base-flow', name: 'Base do fluxo', endpoints: [], asFlow: true as const, file: 'docs/flows.md' }
  ]
}

describe('diretiva na linha', () => {
  it('acha a diretiva sozinha na linha, com as colunas do Monaco', () => {
    expect(directiveAt('  {{> include docs/guia.md#auth}}  ')).toEqual({
      kind: 'include',
      arg: 'docs/guia.md#auth',
      text: '{{> include docs/guia.md#auth}}',
      startColumn: 3,
      endColumn: 34
    })
    expect(directiveAt('{{> map}}')).toMatchObject({ kind: 'map', arg: '' })
  })

  it('ignora diretiva no meio do texto, como o compose', () => {
    expect(directiveAt('veja {{> include a.md}} aqui')).toBeNull()
    expect(directiveAt('    {{> include a.md}}')).toBeNull()
  })
})

describe('arquivo de onde vem o trecho', () => {
  it('include abre o Markdown, na seção quando tem #', () => {
    expect(directiveTarget({ kind: 'include', arg: 'docs/guia.md#auth' }, ctx)).toEqual({ kind: 'markdown', file: 'docs/guia.md', section: 'auth' })
    expect(directiveTarget({ kind: 'include', arg: 'docs/guia.md' }, ctx)).toEqual({ kind: 'markdown', file: 'docs/guia.md' })
  })

  it('conector, endpoint, request e diagrama abrem o editor de cada um', () => {
    expect(directiveTarget({ kind: 'connector', arg: 'http-client' }, ctx)).toEqual({ kind: 'connector', connectorId: 'http-client' })
    expect(directiveTarget({ kind: 'endpoint', arg: 'cotacao/criar' }, ctx)).toEqual({ kind: 'endpoint', connectorId: 'cotacao', endpointId: 'criar' })
    expect(directiveTarget({ kind: 'request', arg: 'cotacao/criar/ok' }, ctx)).toEqual({
      kind: 'scenario',
      connectorId: 'cotacao',
      endpointId: 'criar',
      scenarioId: 'ok'
    })
    expect(directiveTarget({ kind: 'diagram', arg: 'docs/fluxo.mmd' }, ctx)).toEqual({ kind: 'diagram', file: 'docs/fluxo.mmd' })
  })

  it('conector escrito num fluxo-base abre o Markdown que o define', () => {
    expect(directiveTarget({ kind: 'connector', arg: 'base-flow' }, ctx)).toEqual({ kind: 'markdown', file: 'docs/flows.md' })
  })

  it('diretivas do projeto inteiro e argumentos incompletos não abrem nada', () => {
    expect(directiveTarget({ kind: 'map', arg: '' }, ctx)).toBeNull()
    expect(directiveTarget({ kind: 'endpoint', arg: 'cotacao' }, ctx)).toBeNull()
    expect(directiveTarget({ kind: 'request', arg: 'cotacao/criar' }, ctx)).toBeNull()
  })

  it('o rótulo usa os nomes do catálogo', () => {
    expect(targetLabel({ kind: 'connector', connectorId: 'http-client' }, ctx)).toBe('o conector HttpClient')
    expect(targetLabel({ kind: 'endpoint', connectorId: 'cotacao', endpointId: 'criar' }, ctx)).toBe('o endpoint POST Criar cotação')
    expect(targetLabel({ kind: 'markdown', file: 'docs/guia.md', section: 'auth' }, ctx)).toBe('docs/guia.md, na seção auth')
  })
})

describe('linha da seção', () => {
  const text = ['# Guia', '', '## Autenticação {#auth}', '', 'texto', '', '## Erros comuns', ''].join('\n')
  it('pelo {#id}, pelo id que o projeto conhece e pelo título', () => {
    expect(sectionLine(text, 'auth')).toBe(3)
    expect(sectionLine(text, 'erros-comuns', [{ id: 'erros-comuns', title: 'Erros comuns' }])).toBe(7)
    expect(sectionLine(text, 'Erros comuns')).toBe(7)
    expect(sectionLine(text, 'nada')).toBeNull()
  })
})
