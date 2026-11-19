A TransNorte publicou a v3 da API: a base passa a ser `https://api.transnorte.example/v3` e toda
chamada passa a exigir o header `X-Cliente-Id`, com o id do cliente da Loja, que vem em
`TRANSNORTE_CLIENTE_ID`. O resto da API não muda. Atualize o cliente da TransNorte, os testes e a
documentação.
