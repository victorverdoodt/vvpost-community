// A API de homologação da Loja que a tarefa consultar-api consulta: o código do projeto de exemplo,
// com pedidos de mentira e uma chave exigida em X-Api-Key. Uma por rodada, numa porta livre.
import { createServer } from 'node:http'
import { criarApp } from './projeto/src/app.js'

const MOTIVOS = ['endereço errado', 'desistiu', 'endereço errado', 'pagamento recusado', 'endereço errado', 'endereço errado']

export async function iniciarHomolog(chave) {
  const frete = { async cotar({ pesoGramas }) { return { valorCentavos: 990 + Math.round(pesoGramas / 10), prazoDias: 3, transportadora: 'transnorte' } } }
  const app = criarApp({ frete, agora: () => new Date('2026-03-01T12:00:00Z') })
  const produtos = ['p-100', 'p-200', 'p-300', 'p-400']
  const criados = []
  for (let i = 0; i < 14; i++) {
    const r = await app.handle('POST', '/pedidos', { itens: [{ produtoId: produtos[i % 4], quantidade: 1 + (i % 3) }], cep: '01310-100' })
    criados.push(r.body)
  }
  // Pedidos 2, 4, 6, 9, 11 e 13 cancelados, com motivos variados.
  const cancelados = [2, 4, 6, 9, 11, 13]
  cancelados.forEach((i, k) => app.handle('POST', `/pedidos/${criados[i].id}/cancelamento`, { motivo: MOTIVOS[k] }))
  const alvo = cancelados.filter((_, k) => MOTIVOS[k] === 'endereço errado').map((i) => criados[i])
  const esperado = { quantidade: alvo.length, totalCentavos: alvo.reduce((a, p) => a + p.totalCentavos, 0) }

  const server = createServer(async (req, res) => {
    let texto = ''
    for await (const parte of req) texto += parte
    res.setHeader('content-type', 'application/json')
    if (req.headers['x-api-key'] !== chave) {
      res.writeHead(401)
      return res.end(JSON.stringify({ erro: { codigo: 'NAO_AUTORIZADO', mensagem: 'X-Api-Key ausente ou inválida' } }))
    }
    const { status, body } = await app.handle(req.method, req.url, texto ? JSON.parse(texto) : undefined)
    res.writeHead(status)
    res.end(JSON.stringify(body))
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return { porta: server.address().port, esperado, fechar: () => new Promise((ok) => server.close(ok)) }
}
