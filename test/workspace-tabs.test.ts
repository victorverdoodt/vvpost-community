import { describe, expect, it } from 'vitest'
import { mergeOrder, neighborOf, parseSourceKey, sourceKey } from '../src/renderer/src/app/workspace/order'
import { docKey, docTitle } from '../src/renderer/src/app/workspace/docs'

const q = (id: string) => sourceKey('quick-request', id)
const f = (id: string) => sourceKey('flows', id)

describe('abas únicas do workspace', () => {
  it('as abas de um módulo entram na ordem dele, depois da irmã anterior', () => {
    expect(mergeOrder([], new Map([['quick-request', ['a', 'b']]]))).toEqual([q('a'), q('b')])
    const order = [q('a'), 'tool:git', 'doc:markdown:docs/x.md']
    // Uma requisição nova entre a e a seguinte do módulo fica logo depois de a, não no fim.
    expect(mergeOrder(order, new Map([['quick-request', ['a', 'n']]]))).toEqual([q('a'), q('n'), 'tool:git', 'doc:markdown:docs/x.md'])
  })

  it('a primeira aba de um módulo entra depois da ativa; o que o módulo fechou some', () => {
    const order = ['tool:git', q('a'), 'doc:markdown:docs/x.md']
    expect(mergeOrder(order, new Map([['quick-request', ['a']], ['flows', ['flow.checkout']]]), 'tool:git')).toEqual([
      'tool:git',
      f('flow.checkout'),
      q('a'),
      'doc:markdown:docs/x.md'
    ])
    expect(mergeOrder(order, new Map([['quick-request', []]]))).toEqual(['tool:git', 'doc:markdown:docs/x.md'])
  })

  it('a chave da aba de módulo guarda o dono e o id (que pode ter dois-pontos)', () => {
    expect(parseSourceKey(q('a:b'))).toEqual({ owner: 'quick-request', id: 'a:b' })
    expect(parseSourceKey('tool:git')).toBeNull()
    expect(neighborOf(['a', 'b', 'c'], 'b')).toBe('c')
    expect(neighborOf(['a', 'b', 'c'], 'c')).toBe('b')
    expect(neighborOf(['a'], 'a')).toBeUndefined()
  })

  it('o mesmo arquivo abre sempre na mesma aba; um documento novo, numa aba nova', () => {
    expect(docKey({ kind: 'markdown', file: 'docs/a.md' })).toBe(docKey({ kind: 'markdown', file: 'docs/a.md' }))
    expect(docKey({ kind: 'connector', connectorId: null })).not.toBe(docKey({ kind: 'connector', connectorId: null }))
    expect(docKey({ kind: 'scenario', connectorId: 'c', endpointId: 'e' })).not.toBe(docKey({ kind: 'scenario', connectorId: 'c', endpointId: 'e' }))
    const names = { connector: () => 'Pagamentos', endpoint: () => 'Criar cobrança', scenario: () => undefined }
    expect(docTitle({ kind: 'endpoint', connectorId: 'c', endpointId: 'e' }, names)).toBe('Criar cobrança')
    expect(docTitle({ kind: 'diagram', file: 'docs/diagramas/fila.mmd' }, names)).toBe('fila.mmd')
    expect(docTitle({ kind: 'scenario', connectorId: 'c', endpointId: 'e', scenarioId: 's' }, names)).toBe('s')
  })
})
