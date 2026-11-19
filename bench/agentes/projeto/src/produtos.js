// Catálogo em memória. Em produção vem do serviço de catálogo; aqui basta para a API de pedidos.
const PRODUTOS = [
  { id: 'p-100', nome: 'Caneca esmaltada', precoCentavos: 4990, pesoGramas: 350 },
  { id: 'p-200', nome: 'Garrafa térmica 1 L', precoCentavos: 12990, pesoGramas: 600 },
  { id: 'p-300', nome: 'Kit de talheres', precoCentavos: 7990, pesoGramas: 420 },
  { id: 'p-400', nome: 'Toalha de mesa', precoCentavos: 8990, pesoGramas: 800 }
]

export function listarProdutos() {
  return PRODUTOS.map((p) => ({ ...p }))
}

export function obterProduto(id) {
  const p = PRODUTOS.find((x) => x.id === id)
  return p ? { ...p } : undefined
}
