// Frete falso para os testes: cota sempre o mesmo valor, sem rede.
export function freteFixo({ valorCentavos = 2500, prazoDias = 4, transportadora = 'transnorte' } = {}) {
  const chamadas = []
  return {
    chamadas,
    async cotar(pedido) {
      chamadas.push(pedido)
      return { valorCentavos, prazoDias, transportadora }
    }
  }
}

export function fetchFalso(resposta, { status = 200 } = {}) {
  const chamadas = []
  const fn = async (url, init = {}) => {
    chamadas.push({ url, init })
    return { ok: status < 400, status, json: async () => resposta }
  }
  fn.chamadas = chamadas
  return fn
}

export const agoraFixo = () => new Date('2026-03-01T12:00:00Z')
