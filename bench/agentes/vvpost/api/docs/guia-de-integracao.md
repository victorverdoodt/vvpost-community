# Guia de integração

Este guia mostra como um canal de venda cria e acompanha um pedido.

## Criar um pedido

Mande os itens e o `cep` de entrega (com ou sem hífen). A API soma os itens, cota o frete e
devolve o pedido com o total.

{{> endpoint loja-api/criarPedido}}

Erros: `400 ITENS_OBRIGATORIOS` ou `400 CEP_INVALIDO`, `422 PRODUTO_INEXISTENTE` e
`503 FRETE_INDISPONIVEL` quando nenhuma transportadora cota.

## Acompanhar e cancelar

`GET /pedidos/{id}` devolve o pedido. `GET /pedidos?status=cancelado` filtra a lista.
`POST /pedidos/{id}/cancelamento` cancela um pedido que ainda não foi enviado (`409
PEDIDO_JA_ENVIADO` se já foi), com um `motivo` opcional.
