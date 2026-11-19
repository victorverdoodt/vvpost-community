import { listarProdutos } from './produtos.js'
import { criarPedidos } from './pedidos.js'
import { criarFrete } from './frete/index.js'
import { ErroApi, corpoDeErro } from './erros.js'

// Rotas da API. handle() recebe método, caminho e corpo já lido, e devolve { status, body }:
// o server.js só traduz isso para HTTP, e os testes chamam handle() direto.
export function criarApp({ frete = criarFrete(), agora } = {}) {
  const pedidos = criarPedidos({ frete, agora })

  const rotas = [
    ['GET', /^\/produtos$/, () => ({ status: 200, body: { produtos: listarProdutos() } })],
    ['GET', /^\/pedidos$/, (_m, _b, q) => ({ status: 200, body: { pedidos: pedidos.listar({ status: q.get('status') ?? undefined }) } })],
    ['POST', /^\/pedidos$/, async (_m, b) => ({ status: 201, body: await pedidos.criar(b) })],
    ['GET', /^\/pedidos\/([\w-]+)$/, (m) => ({ status: 200, body: pedidos.obter(m[1]) })],
    ['POST', /^\/pedidos\/([\w-]+)\/cancelamento$/, (m, b) => ({ status: 200, body: pedidos.cancelar(m[1], b?.motivo) })]
  ]

  return {
    async handle(method, url, body) {
      const { pathname, searchParams } = new URL(url, 'http://loja.local')
      for (const [verbo, padrao, fn] of rotas) {
        const m = pathname.match(padrao)
        if (m && verbo === method) {
          try {
            return await fn(m, body, searchParams)
          } catch (e) {
            if (e instanceof ErroApi) return { status: e.status, body: corpoDeErro(e) }
            throw e
          }
        }
      }
      return { status: 404, body: corpoDeErro(new ErroApi(404, 'ROTA_INEXISTENTE', `${method} ${pathname} não existe`)) }
    }
  }
}
