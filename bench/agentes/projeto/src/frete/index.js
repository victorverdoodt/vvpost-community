import { criarTransNorte } from './transnorte.js'
import { criarEntregaJa } from './entregaja.js'

// Cota com a TransNorte e, se ela falhar, com a EntregaJá.
export function criarFrete({ provedores } = {}) {
  const lista = provedores ?? [criarTransNorte(), criarEntregaJa()]
  return {
    async cotar(pedido) {
      const falhas = []
      for (const p of lista) {
        try {
          return await p.cotar(pedido)
        } catch (e) {
          falhas.push(`${p.nome}: ${e.message}`)
        }
      }
      throw new Error(`Nenhuma transportadora cotou o frete (${falhas.join('; ')})`)
    }
  }
}
