# Guia de integração

Este guia mostra como um canal de venda cria e acompanha um pedido.

## Criar um pedido

Mande os itens e o `cep` de entrega (com ou sem hífen). A API soma os itens, cota o frete e
devolve o pedido com o total.

```http
POST /pedidos
Content-Type: application/json

{
  "itens": [{ "produtoId": "p-100", "quantidade": 2 }],
  "cep": "01310-100"
}
```

```json
{
  "id": "ped-1001",
  "status": "aguardando_pagamento",
  "itens": [{ "produtoId": "p-100", "quantidade": 2, "precoCentavos": 4990 }],
  "cep": "01310100",
  "subtotalCentavos": 9980,
  "freteCentavos": 1990,
  "totalCentavos": 11970,
  "transportadora": "transnorte",
  "criadoEm": "2026-03-01T12:00:00.000Z"
}
```

Erros: `400 ITENS_OBRIGATORIOS` ou `400 CEP_INVALIDO`, `422 PRODUTO_INEXISTENTE` e
`503 FRETE_INDISPONIVEL` quando nenhuma transportadora cota.

## Acompanhar e cancelar

`GET /pedidos/{id}` devolve o pedido. `GET /pedidos?status=cancelado` filtra a lista.
`POST /pedidos/{id}/cancelamento` cancela um pedido que ainda não foi enviado (`409
PEDIDO_JA_ENVIADO` se já foi), com um `motivo` opcional.

## Endpoints

| Método | Caminho | O que faz |
| --- | --- | --- |
| GET | `/produtos` | Lista os produtos |
| GET | `/pedidos` | Lista os pedidos, com filtro `status` |
| POST | `/pedidos` | Cria um pedido e cota o frete |
| GET | `/pedidos/{id}` | Um pedido |
| POST | `/pedidos/{id}/cancelamento` | Cancela um pedido |
