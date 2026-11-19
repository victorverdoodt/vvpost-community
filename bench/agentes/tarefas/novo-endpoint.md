Adicione o endpoint GET /pedidos/{id}/rastreio, que devolve os eventos de rastreio do pedido
consultando a TransNorte (GET /rastreamentos/{codigo} da API dela), com o id do pedido como
código. A resposta tem a forma que a TransNorte devolve: `{ codigo, eventos: [{ quando, descricao,
cidade }] }`. Pedido que não existe devolve 404 PEDIDO_NAO_ENCONTRADO; código que a TransNorte não
conhece (404 dela) devolve 404 RASTREIO_NAO_ENCONTRADO. Atualize o código, os testes e a
documentação da API.
