// Cliente da EntregaJá, usada quando a TransNorte não responde. Documentação em openapi/entregaja.yaml.
const BASE = process.env.ENTREGAJA_URL ?? 'https://frete.entregaja.example'

export function criarEntregaJa({ fetch = globalThis.fetch, token = process.env.ENTREGAJA_TOKEN } = {}) {
  return {
    nome: 'entregaja',
    async cotar({ cepDestino, pesoGramas }) {
      const url = `${BASE}/v1/frete?cep=${encodeURIComponent(cepDestino)}&peso=${pesoGramas}`
      const res = await fetch(url, { headers: { authorization: `Bearer ${token ?? ''}` } })
      if (!res.ok) throw new Error(`EntregaJá respondeu ${res.status}`)
      const data = await res.json()
      return { valorCentavos: data.precoCentavos, prazoDias: data.prazo, transportadora: 'entregaja' }
    }
  }
}
