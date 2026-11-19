import { describe, expect, it } from 'vitest'
import { isProtectedEnvironment, looksLikeProduction } from '@vvpost/core/policy/protected'

describe('ambiente protegido', () => {
  it('o nome de produção protege por padrão, em palavra inteira', () => {
    for (const [id, name] of <[string, string][]>[['env.prod', 'Prod'], ['producao', 'Produção'], ['production', 'API'], ['x', 'Live'], ['prd', 'PRD']])
      expect(looksLikeProduction({ id, name }), `${id} ${name}`).toBe(true)
    for (const [id, name] of <[string, string][]>[['env.dev', 'Dev'], ['hml', 'Homologação'], ['products', 'Produtos'], ['delivery', 'Delivery']])
      expect(looksLikeProduction({ id, name }), `${id} ${name}`).toBe(false)
  })

  it('o campo do arquivo decide nos dois sentidos', () => {
    expect(isProtectedEnvironment({ id: 'env.prod', name: 'Prod', protected: false })).toBe(false)
    expect(isProtectedEnvironment({ id: 'cliente', name: 'Cliente', protected: true })).toBe(true)
    expect(isProtectedEnvironment({ id: 'env.prod', name: 'Prod' })).toBe(true)
    expect(isProtectedEnvironment(undefined)).toBe(false)
  })
})
