import { describe, expect, it } from 'vitest'
import type { FlowNode } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { locateProperty } from '@vvpost/core/flows/locate'
import { runFlow } from '@vvpost/core/flows/run'
import { emptyWorkspace } from '@vvpost/core/run'

// Erro ligado à propriedade do nó que o causou.
const request = (r: Record<string, unknown>): FlowNode => ({ id: 'n', name: 'Cobrar', type: 'request', request: { method: 'POST', url: '/x', ...r } }) as FlowNode

describe('locateProperty', () => {
  it('acha o campo com a referência $nodes, a variável ou o endpoint citado', () => {
    const node = request({
      url: '/charges/{{ $nodes.Login.data.id }}',
      headers: { Authorization: 'Bearer {{ $nodes.Login.data.token }}', 'X-Tenant': '{{TENANT}}' },
      body: { amount: '{{ $nodes.Carrinho.data.total }}' }
    })
    expect(locateProperty(node, 'EXPRESSION_ERROR', '{{ $nodes.Login.data.token }} não existe na saída de Login')).toBe('request.headers.Authorization')
    expect(locateProperty(node, 'EXPRESSION_ERROR', '$nodes.Carrinho: o nó Carrinho não existe no fluxo ou não rodou')).toBe('request.body')
    expect(locateProperty(node, 'CONFIG_ERROR', 'variável {{TENANT}} não definida no ambiente')).toBe('request.headers.X-Tenant')
    expect(locateProperty(request({ connector: 'c', endpoint: 'e' }), 'CONFIG_ERROR', 'o conector "c" não tem o endpoint "e"')).toBe('request.endpoint')
    expect(locateProperty(request({ connector: 'c' }), 'CONFIG_ERROR', 'segredo {{API_KEY}} sem valor no cofre local')).toBe('request.connector')
    expect(locateProperty(request({}), 'INVALID_URL', 'URL inválida')).toBe('request.url')
    expect(locateProperty({ id: 'p', name: 'P', type: 'python', python: { code: 'x' } } as FlowNode, 'PYTHON_ERROR', 'NameError (linha 3)')).toBe('python.code')
    expect(locateProperty(request({}), 'HTTP_STATUS', 'HTTP 500')).toBeUndefined()
  })

  it('vem no resultado do nó que falhou', async () => {
    const http = { send: async () => { throw new Error('não deveria enviar') }, cancel: () => {} }
    const report = await runFlow(
      {
        runId: 'r',
        flow: { id: 'f', name: 'F', nodes: [request({ query: { cart: '{{ $nodes.Nada.data.id }}' } })], edges: [] }
      },
      { workspace: emptyWorkspace(), auth: createAuthEngine(), http }
    )
    expect(report.results[0]!.error).toMatchObject({ code: 'EXPRESSION_ERROR', property: 'request.query.cart' })
  })
})
