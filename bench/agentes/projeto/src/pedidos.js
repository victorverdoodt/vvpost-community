import { obterProduto } from './produtos.js'
import { ErroApi } from './erros.js'

const CEP = /^\d{5}-?\d{3}$/

export function criarPedidos({ frete, agora = () => new Date() }) {
  const pedidos = new Map()
  let seq = 1000

  return {
    async criar(entrada) {
      if (!entrada || !Array.isArray(entrada.itens) || entrada.itens.length === 0) {
        throw new ErroApi(400, 'ITENS_OBRIGATORIOS', 'Informe ao menos um item')
      }
      if (typeof entrada.cep !== 'string' || !CEP.test(entrada.cep)) {
        throw new ErroApi(400, 'CEP_INVALIDO', 'CEP deve ter 8 dígitos')
      }
      let subtotal = 0
      let peso = 0
      const itens = entrada.itens.map((i) => {
        const produto = obterProduto(i.produtoId)
        if (!produto) throw new ErroApi(422, 'PRODUTO_INEXISTENTE', `Produto ${i.produtoId} não existe`)
        const quantidade = Number.isInteger(i.quantidade) && i.quantidade > 0 ? i.quantidade : 1
        subtotal += produto.precoCentavos * quantidade
        peso += produto.pesoGramas * quantidade
        return { produtoId: produto.id, quantidade, precoCentavos: produto.precoCentavos }
      })
      const cepDestino = entrada.cep.replace('-', '')
      let cotacao
      try {
        cotacao = await frete.cotar({ cepDestino, pesoGramas: peso })
      } catch (e) {
        throw new ErroApi(503, 'FRETE_INDISPONIVEL', e.message)
      }
      const id = `ped-${++seq}`
      const pedido = {
        id,
        status: 'aguardando_pagamento',
        itens,
        cep: cepDestino,
        subtotalCentavos: subtotal,
        freteCentavos: cotacao.valorCentavos,
        totalCentavos: subtotal + cotacao.valorCentavos,
        transportadora: cotacao.transportadora,
        criadoEm: agora().toISOString()
      }
      pedidos.set(id, pedido)
      return pedido
    },

    listar({ status } = {}) {
      return [...pedidos.values()].filter((p) => !status || p.status === status)
    },

    obter(id) {
      const p = pedidos.get(id)
      if (!p) throw new ErroApi(404, 'PEDIDO_NAO_ENCONTRADO', `Pedido ${id} não existe`)
      return p
    },

    cancelar(id, motivo) {
      const p = this.obter(id)
      if (p.status === 'enviado') throw new ErroApi(409, 'PEDIDO_JA_ENVIADO', 'Pedido já enviado não pode ser cancelado')
      p.status = 'cancelado'
      p.motivoCancelamento = motivo ?? null
      return p
    }
  }
}
