import { describe, expect, it } from 'vitest'
import { byInheritance, unusedShared } from '../src/renderer/src/app/workspace/explorer-tree'

const c = (id: string, chain: string[], shared?: string) => ({ id, chain, ...(shared && { shared }) })

describe('explorador do projeto', () => {
  it('esconde do Compartilhado só as bases que nenhum conector do projeto herda', () => {
    const list = [
      c('auth.base', ['auth.base'], 'Compartilhado do workspace'),
      c('erp.base', ['auth.base', 'erp.base'], 'Compartilhado do workspace'),
      c('cnpj.base', ['cnpj.base'], 'Compartilhado do workspace'),
      c('org.catalogo', ['org.catalogo'], 'catálogo da organização'),
      c('estoque.api', ['auth.base', 'erp.base', 'estoque.api'])
    ]
    // auth.base é usada por estoque.api através de erp.base, outra compartilhada.
    expect([...unusedShared(list)]).toEqual(['cnpj.base', 'org.catalogo'])
    // No Compartilhado (sem projeto aberto), nada é compartilhado e nada some.
    expect(unusedShared([c('a', ['a']), c('b', ['a', 'b'])]).size).toBe(0)
  })

  it('monta a árvore pela herança', () => {
    const { roots, children } = byInheritance([
      { ...c('a', ['a']), name: 'A' },
      { ...c('b', ['a', 'b']), name: 'B' }
    ] as never)
    expect(roots.map((r) => r.id)).toEqual(['a'])
    expect(children.get('a')?.map((k) => k.id)).toEqual(['b'])
  })
})
