No POST /pedidos, o campo `cep` do corpo passa a se chamar `cepEntrega`, com as mesmas regras e
ainda obrigatório. O pedido devolvido também troca `cep` por `cepEntrega` e passa a trazer
`prazoEntregaDias`, o prazo em dias informado pela transportadora que cotou o frete. Atualize o
código, os testes e a documentação da API.
