// Cliente da TransNorte (cotação de frete). Documentação da API em openapi/transnorte.yaml.
const BASE = process.env.TRANSNORTE_URL ?? 'https://api.transnorte.example/v2'

export function criarTransNorte({ fetch = globalThis.fetch, apiKey = process.env.TRANSNORTE_API_KEY } = {}) {
  return {
    nome: 'transnorte',
    async cotar({ cepDestino, pesoGramas }) {
      const res = await fetch(`${BASE}/cotacoes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey ?? '' },
        body: JSON.stringify({ cepDestino, pesoKg: pesoGramas / 1000 })
      })
      if (!res.ok) throw new Error(`TransNorte respondeu ${res.status}`)
      const data = await res.json()
      return { valorCentavos: Math.round(data.valor * 100), prazoDias: data.prazoDiasUteis, transportadora: 'transnorte' }
    }
  }
}
